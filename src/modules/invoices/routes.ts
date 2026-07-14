import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { notFound, parseIntId } from '../../lib/http-errors.js';
import { sendDunningEmail } from '../../lib/dunning.js';
import { fetchInvoiceLogo, renderInvoicePdf } from '../../lib/invoice-pdf.js';
import { buildInvoicePdfData, invoicePdfFilename, sendInvoiceEmail } from './send-invoice.js';
import { nextInvoiceNumber } from './number.js';

const lineItemSchema = z.object({
  label: z.string().min(1).max(200),
  quantity: z.number().min(0).max(100000),
  // Allow negative unit prices for discount / credit lines.
  unitPriceCents: z.number().int().min(-100_000_000).max(100_000_000),
  isPackage: z.boolean().optional(),
});

const dateStr = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const recipientAddressFields = {
  recipientAddressLine1: z.string().max(200).nullable().optional(),
  recipientAddressLine2: z.string().max(200).nullable().optional(),
  recipientPostalCode: z.string().max(16).nullable().optional(),
  recipientCity: z.string().max(120).nullable().optional(),
  recipientCountry: z.string().length(2).optional(),
};

const createSchema = z.object({
  orderId: z.number().int().positive().optional(),
  partnerId: z.number().int().positive().optional(),
  customerType: z.enum(['b2c', 'b2b']).default('b2c'),
  recipientName: z.string().min(1).max(200),
  recipientEmail: z.string().email().optional(),
  ...recipientAddressFields,
  serviceDate: dateStr.nullable().optional(),
  serviceDateEnd: dateStr.nullable().optional(),
  lineItems: z.array(lineItemSchema).min(1).max(100),
  /** VAT rate; taxCents is computed server-side. */
  taxRatePercent: z.union([z.literal(0), z.literal(7), z.literal(19)]).default(19),
  /** Omit to inherit the recipient customer's default term (falls back to 7). */
  paymentTermsDays: z.number().int().min(0).max(120).optional(),
  /** How the invoice is settled — drives the payment text + bank block. */
  paymentMethod: z.enum(['transfer', 'card', 'cash']).default('transfer'),
  notes: z.string().max(2000).optional(),
});

const draftUpdateSchema = z.object({
  recipientName: z.string().min(1).max(200).optional(),
  recipientEmail: z.string().email().nullable().optional(),
  ...recipientAddressFields,
  serviceDate: dateStr.nullable().optional(),
  serviceDateEnd: dateStr.nullable().optional(),
  lineItems: z.array(lineItemSchema).min(1).max(100).optional(),
  taxRatePercent: z.union([z.literal(0), z.literal(7), z.literal(19)]).optional(),
  paymentTermsDays: z.number().int().min(0).max(120).optional(),
  paymentMethod: z.enum(['transfer', 'card', 'cash']).optional(),
  notes: z.string().max(2000).nullable().optional(),
  status: z.enum(['void']).optional(),
  odooInvoiceId: z.string().max(255).nullable().optional(),
});

/** After issue, only status + external reference may change. */
const issuedUpdateSchema = z.object({
  status: z.enum(['paid', 'overdue', 'void']).optional(),
  odooInvoiceId: z.string().max(255).nullable().optional(),
});

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
  customerType: z.enum(['b2c', 'b2b']).optional(),
  overdue: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

function computeTaxCents(subtotalCents: number, taxRatePercent: number): number {
  return Math.round((subtotalCents * taxRatePercent) / 100);
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
  app.addHook('preHandler', app.requireAccess('super_admin', 'admin', 'manager'));

  /**
   * Shared draft → issued transition (GoBD): assigns the gapless per-brand
   * number + dueAt in one transaction. Used by both `/send` (issue + email) and
   * `/issue` (issue + print, no email). Returns the issued row, or null if the
   * draft was changed/issued concurrently. Assumes §14 fields already validated.
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
    const { limit, cursor, status, customerType, overdue } = listQuerySchema.parse(request.query);
    const { invoices } = request.company!.tables;
    const decoded = cursor ? decodeCursor(cursor) : null;
    const conds = [];
    if (status) conds.push(eq(invoices.status, status));
    if (customerType) conds.push(eq(invoices.customerType, customerType));
    if (overdue) {
      conds.push(inArray(invoices.status, ['sent', 'overdue']));
      conds.push(lte(invoices.dueAt, sql`now()`));
    }
    if (decoded) {
      const cw = or(
        lt(invoices.createdAt, sql`${decoded.createdAt}::timestamptz`),
        and(
          sql`${invoices.createdAt} = ${decoded.createdAt}::timestamptz`,
          lt(invoices.id, decoded.id),
        ),
      );
      if (cw) conds.push(cw);
    }
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

  app.get('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices } = request.company!.tables;
    const [row] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!row) throw notFound('Invoice not found');
    return { invoice: row };
  });

  // Render the invoice as a PDF for on-screen preview / download. Same document
  // that gets attached to the email (shared buildInvoicePdfData). Works for
  // drafts too, so operators can proof a Rechnung before issuing it.
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
    const subtotalCents = body.lineItems.reduce(
      (a, l) => a + Math.round(l.quantity * l.unitPriceCents),
      0,
    );
    const taxCents = computeTaxCents(subtotalCents, body.taxRatePercent);
    const totalCents = subtotalCents + taxCents;
    // Payment term: explicit value wins; else the recipient customer's default; else 7.
    let paymentTermsDays = body.paymentTermsDays;
    if (paymentTermsDays == null && body.recipientEmail) {
      const [cust] = await db
        .select({ d: customers.defaultPaymentTermsDays })
        .from(customers)
        .where(eq(customers.email, body.recipientEmail.toLowerCase()))
        .limit(1);
      if (cust?.d != null) paymentTermsDays = cust.d;
    }
    paymentTermsDays ??= 7;
    const invoice = await db.transaction(async (tx) => {
      // Drafts carry no number — it's assigned from the gapless sequence at issue.
      const [row] = await tx
        .insert(invoices)
        .values({
          orderId: body.orderId,
          partnerId: body.partnerId,
          customerType: body.customerType,
          recipientName: body.recipientName,
          recipientEmail: body.recipientEmail,
          recipientAddressLine1: body.recipientAddressLine1,
          recipientAddressLine2: body.recipientAddressLine2,
          recipientPostalCode: body.recipientPostalCode,
          recipientCity: body.recipientCity,
          recipientCountry: body.recipientCountry ?? 'DE',
          serviceDate: body.serviceDate ?? null,
          serviceDateEnd: body.serviceDateEnd ?? null,
          lineItems: body.lineItems,
          subtotalCents,
          taxRatePercent: body.taxRatePercent,
          taxCents,
          totalCents,
          paymentTermsDays,
          paymentMethod: body.paymentMethod,
          notes: body.notes,
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
    const { invoices, invoiceStatusLog } = request.company!.tables;
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
    if (body.status === 'paid') set.paidAt = now;
    if (isDraft && ('lineItems' in body || 'taxRatePercent' in body)) {
      const draftBody = body as z.infer<typeof draftUpdateSchema>;
      const lineItems = draftBody.lineItems ?? current.lineItems;
      const taxRatePercent = draftBody.taxRatePercent ?? current.taxRatePercent;
      const subtotalCents = lineItems.reduce(
        (a, l) => a + Math.round(l.quantity * l.unitPriceCents),
        0,
      );
      const taxCents = computeTaxCents(subtotalCents, taxRatePercent);
      set.subtotalCents = subtotalCents;
      set.taxCents = taxCents;
      set.totalCents = subtotalCents + taxCents;
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
      // §14 UStG: mandatory before issue. Leistungsdatum is optional — the
      // recipient postal address stays required.
      const missing = missingIssueFields(current);
      if (missing.length > 0) {
        reply.code(400).send({
          error: `Pflichtangaben fehlen (§14 UStG): ${missing.join(', ')}`,
          missing,
        });
        return;
      }
      // dueAt is set once at first issue; re-sends never move it. The gapless
      // invoice number is assigned here (issue time), in the same transaction.
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
      // sent/overdue: re-send the unchanged document.
      await db.insert(invoiceStatusLog).values({
        invoiceId: id,
        fromStatus: current.status,
        toStatus: current.status,
        changedByUserId: adminId,
        reason: 'Rechnung erneut versendet',
      });
    }
    // Email the invoice to the recipient via the brand's Resend account.
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

  // Issue a draft WITHOUT emailing it (offline / print flow). Assigns the
  // gapless number and freezes the invoice exactly like `/send`, but never
  // touches Resend — the operator prints or downloads the PDF instead.
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
    // Only issued invoices can be paid.
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
    return { invoice: row };
  });

  app.post('/:id/dunning', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices, invoiceStatusLog } = request.company!.tables;
    const now = new Date();
    const [current] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!current) throw notFound('Invoice not found');
    // Only issued, unpaid invoices can be dunned.
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
