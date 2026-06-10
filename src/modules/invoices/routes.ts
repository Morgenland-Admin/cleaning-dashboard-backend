import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { notFound, parseIntId } from '../../lib/http-errors.js';
import { formatEurFromCents } from '../../lib/pricing.js';
import { renderInvoicePdf } from '../../lib/invoice-pdf.js';
import { brandInfoFromCompany, brandSender, sendEmail } from '../../email/service.js';
import { invoiceEmail } from '../../email/templates.js';

const lineItemSchema = z.object({
  label: z.string().min(1).max(200),
  quantity: z.number().min(0).max(100000),
  unitPriceCents: z.number().int().min(0).max(100_000_000),
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
  paymentTermsDays: z.number().int().min(0).max(120).default(14),
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

function invoiceNumber(id: number): string {
  const year = new Date().getUTCFullYear();
  return `INV-${year}-${String(id).padStart(6, '0')}`;
}

function computeTaxCents(subtotalCents: number, taxRatePercent: number): number {
  return Math.round((subtotalCents * taxRatePercent) / 100);
}

export const invoicesAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', app.requireAccess('super_admin', 'admin', 'manager'));

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

  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { invoices, invoiceStatusLog } = request.company!.tables;
    const adminId = request.authUser!.id;
    const subtotalCents = body.lineItems.reduce(
      (a, l) => a + Math.round(l.quantity * l.unitPriceCents),
      0,
    );
    const taxCents = computeTaxCents(subtotalCents, body.taxRatePercent);
    const totalCents = subtotalCents + taxCents;
    const invoice = await db.transaction(async (tx) => {
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
          paymentTermsDays: body.paymentTermsDays,
          notes: body.notes,
          status: 'draft',
        })
        .returning();
      const [withNumber] = await tx
        .update(invoices)
        .set({ number: invoiceNumber(row!.id) })
        .where(eq(invoices.id, row!.id))
        .returning();
      await tx.insert(invoiceStatusLog).values({
        invoiceId: row!.id,
        fromStatus: null,
        toStatus: 'draft',
        changedByUserId: adminId,
        reason: 'Rechnung erstellt',
      });
      return withNumber!;
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
      // §14 UStG: mandatory before issue.
      const missing: string[] = [];
      if (!current.recipientAddressLine1) missing.push('Empfänger-Straße');
      if (!current.recipientPostalCode) missing.push('Empfänger-PLZ');
      if (!current.recipientCity) missing.push('Empfänger-Ort');
      if (!current.serviceDate) missing.push('Leistungsdatum');
      if (missing.length > 0) {
        reply.code(400).send({
          error: `Pflichtangaben fehlen (§14 UStG): ${missing.join(', ')}`,
          missing,
        });
        return;
      }
      // dueAt is set once at first issue; re-sends never move it.
      const dueAt = new Date(now.getTime() + current.paymentTermsDays * 24 * 60 * 60 * 1000);
      const [issued] = await db
        .update(invoices)
        .set({ status: 'sent', sentAt: now, dueAt, updatedAt: now })
        .where(and(eq(invoices.id, id), eq(invoices.status, 'draft')))
        .returning();
      if (!issued) {
        reply.code(409).send({ error: 'Rechnung wurde zwischenzeitlich geändert.' });
        return;
      }
      await db.insert(invoiceStatusLog).values({
        invoiceId: id,
        fromStatus: 'draft',
        toStatus: 'sent',
        changedByUserId: adminId,
        reason: 'Rechnung ausgestellt & versendet',
      });
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
    const dueAt = row.dueAt ?? now;

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
          const fmtDate = (d: Date) =>
            d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
          const fmtDateStr = (s: string) => {
            const [y, m, d] = s.split('-');
            return y && m && d ? `${d}.${m}.${y}` : s;
          };
          const taxRate = row.taxCents > 0 ? row.taxRatePercent : 0;
          const addressLines = [
            companyRow.addressLine1,
            companyRow.addressLine2,
            [companyRow.postalCode, companyRow.city].filter(Boolean).join(' ') || null,
          ].filter((x): x is string => Boolean(x));

          // Shared, pre-formatted values — used by both the HTML email and the PDF.
          const invoiceNumber = row.number ?? `#${row.id}`;
          const invoiceDate = fmtDate(row.sentAt ?? now);
          const dueDate = fmtDate(dueAt);
          const serviceDateLabel = row.serviceDate
            ? row.serviceDateEnd
              ? `${fmtDateStr(row.serviceDate)} – ${fmtDateStr(row.serviceDateEnd)}`
              : fmtDateStr(row.serviceDate)
            : null;
          const recipientAddressLines = [
            row.recipientAddressLine1,
            row.recipientAddressLine2,
            [row.recipientPostalCode, row.recipientCity].filter(Boolean).join(' ') || null,
          ].filter((x): x is string => Boolean(x));
          const taxFormatted = row.taxCents > 0 ? formatEurFromCents(row.taxCents) : null;
          const taxRateLabel = taxRate > 0 ? `${taxRate} %` : null;
          const subtotalFormatted = formatEurFromCents(row.subtotalCents);
          const totalFormatted = formatEurFromCents(row.totalCents);
          const lineItems = row.lineItems.map((li) => ({
            label: li.label,
            quantity: li.quantity.toLocaleString('de-DE'),
            unitPrice: formatEurFromCents(li.unitPriceCents),
            lineTotal: formatEurFromCents(Math.round(li.quantity * li.unitPriceCents)),
          }));
          const seller = {
            name: companyRow.legalName ?? companyRow.name,
            addressLines,
            vatId: companyRow.vatId,
            registrationNumber: companyRow.registrationNumber,
            email: companyRow.email,
            phone: companyRow.phone,
          };

          // Render the PDF attachment (best-effort — fall back to HTML-only).
          let attachments: Array<{ filename: string; content: Buffer }> | undefined;
          try {
            const pdf = await renderInvoicePdf({
              brandName: companyRow.name,
              invoiceNumber,
              invoiceDate,
              dueDate,
              paymentTermsDays: row.paymentTermsDays,
              recipientName: row.recipientName,
              recipientEmail: row.recipientEmail,
              recipientAddressLines,
              serviceDateLabel,
              lineItems,
              subtotal: subtotalFormatted,
              tax: taxFormatted,
              taxRateLabel,
              total: totalFormatted,
              notes: row.notes,
              accentColor: companyRow.primaryColor ?? '#bd5b3e',
              seller,
            });
            attachments = [{ filename: `Rechnung-${invoiceNumber}.pdf`, content: pdf }];
          } catch (err) {
            request.log.error({ err, invoiceId: id }, 'Failed to render invoice PDF');
          }

          const result = await sendEmail({
            to: row.recipientEmail,
            from: brandSender(companyRow),
            apiKey: companyRow.resendApiKey ?? undefined,
            replyTo: companyRow.email ?? undefined,
            attachments,
            email: invoiceEmail({
              brand: brandInfoFromCompany(companyRow),
              recipientName: row.recipientName,
              invoiceNumber,
              invoiceDateFormatted: invoiceDate,
              dueDateFormatted: dueDate,
              paymentTermsDays: row.paymentTermsDays,
              lineItems: lineItems.map((li) => ({
                label: li.label,
                quantityLabel: li.quantity,
                unitPriceFormatted: li.unitPrice,
                lineTotalFormatted: li.lineTotal,
              })),
              subtotalFormatted,
              taxFormatted,
              taxRateLabel,
              totalFormatted,
              notes: row.notes,
              seller,
            }),
          });
          emailSent = result.ok && !result.skipped;
          emailSkipped = result.skipped ?? false;
        }
      } catch (err) {
        request.log.error({ err, invoiceId: id }, 'Failed to send invoice email');
      }
    }

    return { invoice: row, emailSent, emailSkipped };
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
    return { invoice: row };
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
