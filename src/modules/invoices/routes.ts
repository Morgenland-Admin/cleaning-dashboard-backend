import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { and, desc, eq, ilike, inArray, lte, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { encodeCursor, keysetAfter } from '../../lib/cursor.js';
import { badRequest, notFound, parseIntId } from '../../lib/http-errors.js';
import { linkCustomerByEmail } from '../../lib/customers.js';
import { recomputeCustomerForInvoice } from '../../lib/customer-stats.js';
import { sendDunningEmail } from '../../lib/dunning.js';
import { fetchInvoiceLogo, renderInvoicePdf } from '../../lib/invoice-pdf.js';
import {
  CRAFTSMAN_DEFAULT_VAT_RATE,
  craftsmanNoteText,
  craftsmanVatFromGross,
} from '../../lib/invoice-text.js';
import { formatEurFromCents } from '../../lib/pricing.js';
import { buildInvoicePdfData, invoicePdfFilename, sendInvoiceEmail } from './send-invoice.js';
import { likePattern } from '../orders/lib.js';
import { nextInvoiceNumber } from './number.js';

const lineItemSchema = z.object({
  label: z.string().min(1).max(200),
  note: z.string().max(200).nullable().optional(),
  quantity: z.number().min(0).max(100000),
  // Negative = discount / credit line.
  unitPriceCents: z.number().int().min(-100_000_000).max(100_000_000),
  isPackage: z.boolean().optional(),
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

/** §35a EStG Handwerkerleistung: gross labour share + the VAT inside it (defaults to the invoice rate); cents. */
const craftsmanFields = {
  craftsmanService: z.boolean().optional(),
  laborGrossCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  /** Omit/null = derive from the gross share. */
  laborVatCents: z.number().int().min(0).max(100_000_000).nullable().optional(),
  /** Hand-edited wording; omit = compose, null = reset to composed. */
  craftsmanNote: z.string().max(1000).nullable().optional(),
};

/**
 * Paketrechnung: no per-line prices; the agreed net package price lands in `subtotal_cents`.
 * `packageNetCents` is required when the mode is on (0 parks an undecided draft; issuing 0,00 € is refused).
 */
const packageFields = {
  packageMode: z.boolean().optional(),
  packageNetCents: z.number().int().min(0).max(100_000_000).optional(),
};

const recipientAddressFields = {
  recipientCompany: z.string().max(200).nullable().optional(),
  recipientVatId: z.string().max(32).nullable().optional(),
  recipientAddressLine1: z.string().max(200).nullable().optional(),
  recipientAddressLine2: z.string().max(200).nullable().optional(),
  recipientPostalCode: z.string().max(16).nullable().optional(),
  recipientCity: z.string().max(120).nullable().optional(),
  recipientCountry: z.string().length(2).optional(),
};

const createSchema = z.object({
  orderId: z.number().int().positive().optional(),
  partnerId: z.number().int().positive().optional(),
  /** Started from a customer record: links even when the recipient has no (or another) email. */
  customerId: z.number().int().positive().optional(),
  customerType: z.enum(['b2c', 'b2b']).default('b2c'),
  recipientName: z.string().min(1).max(200),
  recipientEmail: z.string().email().optional(),
  ...recipientAddressFields,
  subject: z.string().max(200).nullable().optional(),
  serviceDate: dateStr.nullable().optional(),
  serviceDateEnd: dateStr.nullable().optional(),
  lineItems: z.array(lineItemSchema).min(1).max(100),
  ...packageFields,
  /** taxCents is computed server-side. */
  taxRatePercent: z.union([z.literal(0), z.literal(7), z.literal(19)]).default(19),
  /** Omit = recipient customer's default, else 7. */
  paymentTermsDays: z.number().int().min(0).max(120).optional(),
  paymentMethod: z.enum(['transfer', 'card', 'cash']).default('transfer'),
  notes: z.string().max(2000).optional(),
  ...craftsmanFields,
});

const draftUpdateSchema = z.object({
  recipientName: z.string().min(1).max(200).optional(),
  recipientEmail: z.string().email().nullable().optional(),
  ...recipientAddressFields,
  subject: z.string().max(200).nullable().optional(),
  serviceDate: dateStr.nullable().optional(),
  serviceDateEnd: dateStr.nullable().optional(),
  lineItems: z.array(lineItemSchema).min(1).max(100).optional(),
  ...packageFields,
  taxRatePercent: z.union([z.literal(0), z.literal(7), z.literal(19)]).optional(),
  paymentTermsDays: z.number().int().min(0).max(120).optional(),
  paymentMethod: z.enum(['transfer', 'card', 'cash']).optional(),
  notes: z.string().max(2000).nullable().optional(),
  ...craftsmanFields,
  status: z.enum(['void']).optional(),
  odooInvoiceId: z.string().max(255).nullable().optional(),
});

/** GoBD: after issue only status + external reference may change. */
const issuedUpdateSchema = z.object({
  status: z.enum(['paid', 'overdue', 'void']).optional(),
  odooInvoiceId: z.string().max(255).nullable().optional(),
});

const INVOICE_VIEW_STATUSES = {
  open: ['draft', 'sent', 'overdue'],
  closed: ['paid', 'void'],
} as const satisfies Record<string, readonly string[]>;

/** Allowed status transitions (GoBD). */
const STATUS_TRANSITIONS: Record<string, string[]> = {
  draft: ['sent', 'void'],
  sent: ['paid', 'overdue', 'void'],
  overdue: ['paid', 'void'],
  paid: [],
  void: [],
};

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
  status: z.enum(['draft', 'sent', 'paid', 'overdue', 'void']).optional(),
  /** `open` = draft / sent / overdue; `closed` = paid / void. A `status` wins over it. */
  view: z.enum(['open', 'closed']).optional(),
  q: z.string().trim().min(1).max(100).optional(),
  customerType: z.enum(['b2c', 'b2b']).optional(),
  overdue: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

/** Search and side filters shared by the list and its tab counts (status tabs excluded). */
function invoiceFilterConditions(
  invoices: TenantTables['invoices'],
  {
    q,
    customerType,
    overdue,
  }: Pick<z.infer<typeof listQuerySchema>, 'q' | 'customerType' | 'overdue'>,
): SQL[] {
  const conds: SQL[] = [];
  if (q) {
    const like = likePattern(q);
    const match = or(
      ilike(invoices.number, like),
      ilike(invoices.recipientName, like),
      ilike(invoices.recipientCompany, like),
      ilike(invoices.recipientEmail, like),
    );
    if (match) conds.push(match);
  }
  if (customerType) conds.push(eq(invoices.customerType, customerType));
  if (overdue) {
    conds.push(inArray(invoices.status, ['sent', 'overdue']));
    conds.push(lte(invoices.dueAt, sql`now()`));
  }
  return conds;
}

function computeTaxCents(subtotalCents: number, taxRatePercent: number): number {
  return Math.round((subtotalCents * taxRatePercent) / 100);
}

/** Paketrechnung: the subtotal is the agreed net package price, line prices are ignored. */
function computeMoney(
  lineItems: Array<{ quantity: number; unitPriceCents: number }>,
  taxRatePercent: number,
  packageMode: boolean,
  packageNetCents: number,
): { subtotalCents: number; taxCents: number; totalCents: number } {
  const subtotalCents = packageMode
    ? packageNetCents
    : lineItems.reduce((a, l) => a + Math.round(l.quantity * l.unitPriceCents), 0);
  const taxCents = computeTaxCents(subtotalCents, taxRatePercent);
  return { subtotalCents, taxCents, totalCents: subtotalCents + taxCents };
}

/** Paketrechnung positions are stored without prices so no later render (PDF, email, dashboard) can show one. */
function normalizeLineItems<T extends { unitPriceCents: number }>(
  lineItems: T[],
  packageMode: boolean,
): T[] {
  return packageMode ? lineItems.map((l) => ({ ...l, unitPriceCents: 0 })) : lineItems;
}

/** Refuses a 0,00 € invoice (easy to miss on a Paketrechnung); credit notes (negative) stay allowed. */
function zeroTotalError(totalCents: number): string | null {
  return totalCents === 0
    ? 'Der Rechnungsbetrag ist 0,00 €. Bitte tragen Sie den Preis ein, bevor die Rechnung ausgestellt wird.'
    : null;
}

interface CraftsmanInput {
  craftsmanService?: boolean | undefined;
  laborGrossCents?: number | null | undefined;
  laborVatCents?: number | null | undefined;
  craftsmanNote?: string | null | undefined;
}

interface CraftsmanState {
  craftsmanService: boolean;
  laborGrossCents: number | null;
  laborVatCents: number | null;
  craftsmanNote: string | null;
}

/**
 * §35a EStG columns + printed sentence (stored, so a reissue matches what was sent). The VAT share defaults to the
 * portion inside the gross labour amount; custom `craftsmanNote` is regenerated when amounts change, null resets it.
 */
function resolveCraftsman(
  body: CraftsmanInput,
  current: CraftsmanState | null,
  totalCents: number,
  taxRatePercent: number,
): {
  craftsmanService: boolean;
  laborGrossCents: number | null;
  laborVatCents: number | null;
  craftsmanNote: string | null;
} {
  const enabled = body.craftsmanService ?? current?.craftsmanService ?? false;
  if (!enabled) {
    return {
      craftsmanService: false,
      laborGrossCents: null,
      laborVatCents: null,
      craftsmanNote: null,
    };
  }

  const gross = body.laborGrossCents ?? current?.laborGrossCents ?? null;
  if (gross == null || gross <= 0) {
    throw badRequest(
      'Handwerkerleistung (§35a EStG): Bitte den Brutto-Arbeitskostenanteil angeben.',
    );
  }
  if (gross > totalCents) {
    throw badRequest(
      `Handwerkerleistung (§35a EStG): Der Arbeitskostenanteil (${formatEurFromCents(gross)}) ` +
        `darf den Rechnungsbetrag (${formatEurFromCents(totalCents)}) nicht übersteigen.`,
    );
  }

  // Explicit override wins; else recompute when the gross share changed (no stale VAT).
  const autoVat = craftsmanVatFromGross(
    gross,
    taxRatePercent > 0 ? taxRatePercent : CRAFTSMAN_DEFAULT_VAT_RATE,
  );
  const vat =
    body.laborVatCents ??
    (body.laborGrossCents !== undefined ? autoVat : (current?.laborVatCents ?? autoVat));
  if (vat > gross) {
    throw badRequest(
      'Handwerkerleistung (§35a EStG): Die enthaltene MwSt. kann nicht größer sein als der Arbeitskostenanteil.',
    );
  }

  const custom = typeof body.craftsmanNote === 'string' ? body.craftsmanNote.trim() : '';
  const amountsChanged = body.laborGrossCents !== undefined || body.laborVatCents !== undefined;
  const keepStored =
    body.craftsmanNote === undefined && !amountsChanged ? (current?.craftsmanNote ?? null) : null;

  return {
    craftsmanService: true,
    laborGrossCents: gross,
    laborVatCents: vat,
    craftsmanNote: custom || keepStored || craftsmanNoteText(gross, vat),
  };
}

/** §14 UStG mandatory recipient address fields, checked before a draft is issued. */
function missingIssueFields(current: {
  recipientAddressLine1: string | null;
  recipientPostalCode: string | null;
  recipientCity: string | null;
}): string[] {
  const missing: string[] = [];
  if (!current.recipientAddressLine1) missing.push('Empfänger-Straße');
  if (!current.recipientPostalCode) missing.push('Empfänger-PLZ');
  if (!current.recipientCity) missing.push('Empfänger-Ort');
  return missing;
}

export const invoicesAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  // Writes need manager+; reads stay open to any member (viewer included).
  app.addHook('preHandler', app.requireWriteAccess);

  /**
   * Draft → sent with gapless number + dueAt in one transaction (GoBD); null if changed concurrently.
   * Caller validates the §14 fields.
   */
  async function issueDraftTx(
    request: FastifyRequest,
    id: number,
    current: { number: string | null; paymentTermsDays: number },
    now: Date,
    reason: string,
  ) {
    const { invoices, invoiceStatusLog } = request.company!.tables;
    const adminId = request.authUser!.id;
    const dueAt = new Date(now.getTime() + current.paymentTermsDays * 24 * 60 * 60 * 1000);
    return db.transaction(async (tx) => {
      const number = current.number ?? (await nextInvoiceNumber(tx, request.company!.slug));
      const [r] = await tx
        .update(invoices)
        .set({ status: 'sent', number, sentAt: now, dueAt, updatedAt: now })
        .where(and(eq(invoices.id, id), eq(invoices.status, 'draft')))
        .returning();
      if (!r) return null;
      await tx.insert(invoiceStatusLog).values({
        invoiceId: id,
        fromStatus: 'draft',
        toStatus: 'sent',
        changedByUserId: adminId,
        reason,
      });
      return r;
    });
  }

  app.get('/', async (request) => {
    const { limit, cursor, status, view, q, customerType, overdue } = listQuerySchema.parse(
      request.query,
    );
    const { invoices } = request.company!.tables;
    const conds = invoiceFilterConditions(invoices, { q, customerType, overdue });
    if (status) conds.push(eq(invoices.status, status));
    else if (view) conds.push(inArray(invoices.status, INVOICE_VIEW_STATUSES[view]));
    const after = keysetAfter(invoices, invoices.createdAt, invoices.id, cursor);
    if (after) conds.push(after);
    const rows = await db
      .select()
      .from(invoices)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(invoices.createdAt), desc(invoices.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    return { invoices: page, nextCursor };
  });

  app.get('/counts', async (request) => {
    const filters = listQuerySchema
      .pick({ q: true, customerType: true, overdue: true })
      .parse(request.query);
    const { invoices } = request.company!.tables;
    const conds = invoiceFilterConditions(invoices, filters);
    const rows = await db
      .select({ status: invoices.status, n: sql<number>`count(*)::int` })
      .from(invoices)
      .where(conds.length ? and(...conds) : undefined)
      .groupBy(invoices.status);
    return { counts: Object.fromEntries(rows.map((r) => [r.status, r.n])) };
  });

  app.get('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices } = request.company!.tables;
    const [row] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!row) throw notFound('Invoice not found');
    return { invoice: row };
  });

  // Same document as the emailed PDF; drafts included so operators can proof before issuing.
  app.get('/:id/pdf', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices } = request.company!.tables;
    const [row] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!row) throw notFound('Invoice not found');
    const [companyRow] = await db
      .select()
      .from(company)
      .where(eq(company.slug, request.company!.slug))
      .limit(1);
    if (!companyRow) throw notFound('Company not found');

    const pdfData = buildInvoicePdfData(companyRow, row);
    pdfData.logo = await fetchInvoiceLogo(companyRow.invoiceLogoUrl ?? companyRow.logoUrl);
    const pdf = await renderInvoicePdf(pdfData);
    const filename = invoicePdfFilename(row.number ?? `Entwurf-${row.id}`, row.recipientName);
    const download = (request.query as { download?: string }).download === '1';
    reply
      .header('Content-Type', 'application/pdf')
      .header(
        'Content-Disposition',
        `${download ? 'attachment' : 'inline'}; filename="${filename}"`,
      )
      .header('Cache-Control', 'no-store');
    return reply.send(pdf);
  });

  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { invoices, invoiceStatusLog, customers } = request.company!.tables;
    const adminId = request.authUser!.id;
    const packageMode = body.packageMode ?? false;
    if (packageMode && body.packageNetCents == null) {
      throw badRequest('Paketrechnung: Bitte den Paketpreis (netto) angeben.');
    }
    const lineItems = normalizeLineItems(body.lineItems, packageMode);
    const { subtotalCents, taxCents, totalCents } = computeMoney(
      lineItems,
      body.taxRatePercent,
      packageMode,
      body.packageNetCents ?? 0,
    );
    // Payment term: explicit > customer default > 7. The lookup also fills B2B company / USt-IdNr. and the customer link.
    let paymentTermsDays = body.paymentTermsDays;
    let recipientCompany = body.recipientCompany;
    let recipientVatId = body.recipientVatId;
    let customerId: number | null = null;
    const customerFields = {
      id: customers.id,
      d: customers.defaultPaymentTermsDays,
      customerType: customers.customerType,
      companyName: customers.companyName,
      vatId: customers.vatId,
    };
    // Customer: the one the invoice was started from > email match > (below) the order's customer.
    const [cust] = body.customerId
      ? await db
          .select(customerFields)
          .from(customers)
          .where(eq(customers.id, body.customerId))
          .limit(1)
      : body.recipientEmail
        ? await db
            .select(customerFields)
            .from(customers)
            .where(eq(customers.email, body.recipientEmail.toLowerCase()))
            .limit(1)
        : [];
    if (body.customerId && !cust) throw badRequest('Kunde nicht gefunden.');
    if (cust) {
      if (paymentTermsDays == null && cust.d != null) paymentTermsDays = cust.d;
      if (cust.customerType === 'business') {
        recipientCompany ??= cust.companyName;
        recipientVatId ??= cust.vatId;
      }
      customerId = cust.id;
    }
    if (body.recipientEmail) {
      // Unknown recipient: create the customer (not for partner invoices).
      if (customerId == null && body.partnerId == null) {
        customerId = await linkCustomerByEmail(db, customers, {
          email: body.recipientEmail,
          name: body.recipientName,
        });
      }
    }
    paymentTermsDays ??= 7;
    // No usable email: inherit the order's customer.
    if (customerId == null && body.orderId != null) {
      const { orders } = request.company!.tables;
      const [ord] = await db
        .select({ customerId: orders.customerId })
        .from(orders)
        .where(eq(orders.id, body.orderId))
        .limit(1);
      customerId = ord?.customerId ?? null;
    }
    const craftsman = resolveCraftsman(body, null, totalCents, body.taxRatePercent);
    const invoice = await db.transaction(async (tx) => {
      // No number on drafts; assigned at issue (gapless).
      const [row] = await tx
        .insert(invoices)
        .values({
          orderId: body.orderId,
          partnerId: body.partnerId,
          customerId,
          customerType: body.customerType,
          recipientName: body.recipientName,
          recipientCompany,
          recipientVatId,
          recipientEmail: body.recipientEmail,
          recipientAddressLine1: body.recipientAddressLine1,
          recipientAddressLine2: body.recipientAddressLine2,
          recipientPostalCode: body.recipientPostalCode,
          recipientCity: body.recipientCity,
          recipientCountry: body.recipientCountry ?? 'DE',
          subject: body.subject ?? null,
          serviceDate: body.serviceDate ?? null,
          serviceDateEnd: body.serviceDateEnd ?? null,
          lineItems,
          packageMode,
          subtotalCents,
          taxRatePercent: body.taxRatePercent,
          taxCents,
          totalCents,
          paymentTermsDays,
          paymentMethod: body.paymentMethod,
          notes: body.notes,
          ...craftsman,
          status: 'draft',
        })
        .returning();
      await tx.insert(invoiceStatusLog).values({
        invoiceId: row!.id,
        fromStatus: null,
        toStatus: 'draft',
        changedByUserId: adminId,
        reason: 'Rechnung erstellt',
      });
      return row!;
    });
    reply.code(201).send({ invoice });
  });

  app.patch('/:id', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices, invoiceStatusLog, customers } = request.company!.tables;
    const adminId = request.authUser!.id;
    const now = new Date();

    const [current] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!current) throw notFound('Invoice not found');

    // GoBD: issued invoices are content-frozen.
    const isDraft = current.status === 'draft';
    const body = (isDraft ? draftUpdateSchema : issuedUpdateSchema).parse(request.body);

    if (body.status && !STATUS_TRANSITIONS[current.status]?.includes(body.status)) {
      reply.code(409).send({
        error: `Statuswechsel ${current.status} → ${body.status} ist nicht zulässig.`,
        allowed: STATUS_TRANSITIONS[current.status] ?? [],
      });
      return;
    }

    const set: Record<string, unknown> = { ...body, updatedAt: now };
    // Input-only, not a column.
    delete set.packageNetCents;
    if (body.status === 'paid') set.paidAt = now;
    // Re-point the customer link when a draft's recipient is retyped.
    if (isDraft && 'recipientEmail' in body && current.partnerId == null) {
      const draftBody = body as z.infer<typeof draftUpdateSchema>;
      set.customerId = draftBody.recipientEmail
        ? await linkCustomerByEmail(db, customers, {
            email: draftBody.recipientEmail,
            name: draftBody.recipientName ?? current.recipientName,
          })
        : null;
    }
    if (
      isDraft &&
      ('lineItems' in body ||
        'taxRatePercent' in body ||
        'packageMode' in body ||
        'packageNetCents' in body)
    ) {
      const draftBody = body as z.infer<typeof draftUpdateSchema>;
      const packageMode = draftBody.packageMode ?? current.packageMode;
      const lineItems = normalizeLineItems(draftBody.lineItems ?? current.lineItems, packageMode);
      const taxRatePercent = draftBody.taxRatePercent ?? current.taxRatePercent;
      // Reordering alone must not drop the package price (it lives in subtotalCents); leaving package mode resets it.
      const packageNetCents =
        draftBody.packageNetCents ?? (current.packageMode ? current.subtotalCents : 0);
      set.lineItems = lineItems;
      set.packageMode = packageMode;
      Object.assign(set, computeMoney(lineItems, taxRatePercent, packageMode, packageNetCents));
    }
    if (isDraft) {
      // Every draft write: totals feed the labour-share check and the stored sentence must follow its amounts.
      const draftBody = body as z.infer<typeof draftUpdateSchema>;
      Object.assign(
        set,
        resolveCraftsman(
          draftBody,
          current,
          (set.totalCents as number | undefined) ?? current.totalCents,
          draftBody.taxRatePercent ?? current.taxRatePercent,
        ),
      );
    }

    const [row] = await db
      .update(invoices)
      .set(set)
      .where(and(eq(invoices.id, id), eq(invoices.status, current.status)))
      .returning();
    if (!row) throw notFound('Invoice not found');
    if (body.status && body.status !== current.status) {
      await db.insert(invoiceStatusLog).values({
        invoiceId: id,
        fromStatus: current.status,
        toStatus: body.status,
        changedByUserId: adminId,
        reason: 'Status geändert (PATCH)',
      });
      // paid/void changes turnover: refresh customer totals and loyalty tier.
      if (body.status === 'paid' || body.status === 'void') {
        await recomputeCustomerForInvoice(request.company!.tables, row, request.log);
      }
    }
    return { invoice: row };
  });

  app.post('/:id/send', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices, invoiceStatusLog } = request.company!.tables;
    const adminId = request.authUser!.id;
    const [current] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!current) throw notFound('Invoice not found');
    if (current.status === 'paid' || current.status === 'void') {
      reply.code(409).send({
        error: `Eine Rechnung im Status "${current.status}" kann nicht versendet werden.`,
      });
      return;
    }

    const now = new Date();
    let row = current;
    if (current.status === 'draft') {
      // §14 UStG: recipient address is mandatory before issue; Leistungsdatum is optional here.
      const missing = missingIssueFields(current);
      if (missing.length > 0) {
        reply.code(400).send({
          error: `Pflichtangaben fehlen (§14 UStG): ${missing.join(', ')}`,
          missing,
        });
        return;
      }
      const zeroTotal = zeroTotalError(current.totalCents);
      if (zeroTotal) {
        reply.code(400).send({ error: zeroTotal });
        return;
      }
      // dueAt is set once at first issue (re-sends never move it); the gapless number is assigned here.
      const issued = await issueDraftTx(
        request,
        id,
        current,
        now,
        'Rechnung ausgestellt & versendet',
      );
      if (!issued) {
        reply.code(409).send({ error: 'Rechnung wurde zwischenzeitlich geändert.' });
        return;
      }
      row = issued;
    } else {
      await db.insert(invoiceStatusLog).values({
        invoiceId: id,
        fromStatus: current.status,
        toStatus: current.status,
        changedByUserId: adminId,
        reason: 'Rechnung erneut versendet',
      });
    }
    // Best-effort: a mail failure must not undo the "sent" transition.
    let emailSent = false;
    let emailSkipped = false;
    if (row?.recipientEmail) {
      try {
        const [companyRow] = await db
          .select()
          .from(company)
          .where(eq(company.slug, request.company!.slug))
          .limit(1);
        if (companyRow) {
          const res = await sendInvoiceEmail(companyRow, row, request.log);
          emailSent = res.ok;
          emailSkipped = res.skipped;
        }
      } catch (err) {
        request.log.error({ err, invoiceId: id }, 'Failed to send invoice email');
      }
    }

    return { invoice: row, emailSent, emailSkipped };
  });

  // Issue without emailing (print/offline): same numbering and freeze as /send, never touches Resend.
  app.post('/:id/issue', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices } = request.company!.tables;
    const [current] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!current) throw notFound('Invoice not found');
    if (current.status !== 'draft') {
      reply.code(409).send({
        error: `Nur Entwürfe können ausgestellt werden (Status: "${current.status}").`,
      });
      return;
    }
    const missing = missingIssueFields(current);
    if (missing.length > 0) {
      reply.code(400).send({
        error: `Pflichtangaben fehlen (§14 UStG): ${missing.join(', ')}`,
        missing,
      });
      return;
    }
    const zeroTotal = zeroTotalError(current.totalCents);
    if (zeroTotal) {
      reply.code(400).send({ error: zeroTotal });
      return;
    }
    const issued = await issueDraftTx(
      request,
      id,
      current,
      new Date(),
      'Rechnung ausgestellt (ohne E-Mail)',
    );
    if (!issued) {
      reply.code(409).send({ error: 'Rechnung wurde zwischenzeitlich geändert.' });
      return;
    }
    return { invoice: issued };
  });

  app.post('/:id/mark-paid', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices, invoiceStatusLog } = request.company!.tables;
    const now = new Date();
    const [current] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!current) throw notFound('Invoice not found');
    if (current.status !== 'sent' && current.status !== 'overdue') {
      reply.code(409).send({
        error: `Rechnung im Status "${current.status}" kann nicht als bezahlt markiert werden.`,
      });
      return;
    }
    const [row] = await db
      .update(invoices)
      .set({ status: 'paid', paidAt: now, updatedAt: now })
      .where(and(eq(invoices.id, id), eq(invoices.status, current.status)))
      .returning();
    if (!row) {
      reply.code(409).send({ error: 'Rechnung wurde zwischenzeitlich geändert.' });
      return;
    }
    await db.insert(invoiceStatusLog).values({
      invoiceId: id,
      fromStatus: current.status,
      toStatus: 'paid',
      changedByUserId: request.authUser!.id,
      reason: 'Als bezahlt markiert',
    });
    await recomputeCustomerForInvoice(request.company!.tables, row, request.log);
    return { invoice: row };
  });

  app.post('/:id/dunning', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices, invoiceStatusLog } = request.company!.tables;
    const now = new Date();
    const [current] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!current) throw notFound('Invoice not found');
    if (current.status !== 'sent' && current.status !== 'overdue') {
      reply.code(409).send({
        error: `Mahnung ist für Rechnungen im Status "${current.status}" nicht möglich.`,
      });
      return;
    }
    const [row] = await db
      .update(invoices)
      .set({
        dunningLevel: sql`${invoices.dunningLevel} + 1`,
        lastDunningAt: now,
        status: 'overdue',
        updatedAt: now,
      })
      .where(and(eq(invoices.id, id), eq(invoices.status, current.status)))
      .returning();
    if (!row) {
      reply.code(409).send({ error: 'Rechnung wurde zwischenzeitlich geändert.' });
      return;
    }
    await db.insert(invoiceStatusLog).values({
      invoiceId: id,
      fromStatus: current.status,
      toStatus: 'overdue',
      changedByUserId: request.authUser!.id,
      reason: `Mahnstufe ${row.dunningLevel}`,
    });

    let emailSent = false;
    let emailSkipped = false;
    try {
      const [companyRow] = await db
        .select()
        .from(company)
        .where(eq(company.slug, request.company!.slug))
        .limit(1);
      if (companyRow) {
        const res = await sendDunningEmail(companyRow, row);
        emailSent = res.ok;
        emailSkipped = res.skipped;
      }
    } catch (err) {
      request.log.error({ err, invoiceId: id }, 'Failed to send dunning email');
    }
    return { invoice: row, emailSent, emailSkipped };
  });

  /** GoBD audit trail for one invoice. */
  app.get('/:id/log', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoiceStatusLog } = request.company!.tables;
    const log = await db
      .select()
      .from(invoiceStatusLog)
      .where(eq(invoiceStatusLog.invoiceId, id))
      .orderBy(desc(invoiceStatusLog.createdAt));
    return { log };
  });
};

export default invoicesAdminRoutes;
