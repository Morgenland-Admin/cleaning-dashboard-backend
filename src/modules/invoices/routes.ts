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

const createSchema = z.object({
  orderId: z.number().int().positive().optional(),
  partnerId: z.number().int().positive().optional(),
  customerType: z.enum(['b2c', 'b2b']).default('b2c'),
  recipientName: z.string().min(1).max(200),
  recipientEmail: z.string().email().optional(),
  lineItems: z.array(lineItemSchema).min(1).max(100),
  taxCents: z.number().int().min(0).max(100_000_000).default(0),
  paymentTermsDays: z.number().int().min(0).max(120).default(14),
  notes: z.string().max(2000).optional(),
});

const updateSchema = z.object({
  status: z.enum(['draft', 'sent', 'paid', 'overdue', 'void']).optional(),
  odooInvoiceId: z.string().max(255).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  recipientEmail: z.string().email().nullable().optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
  status: z.enum(['draft', 'sent', 'paid', 'overdue', 'void']).optional(),
  customerType: z.enum(['b2c', 'b2b']).optional(),
  overdue: z.coerce.boolean().optional(),
});

function invoiceNumber(id: number): string {
  const year = new Date().getUTCFullYear();
  return `INV-${year}-${String(id).padStart(6, '0')}`;
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
    const { invoices } = request.company!.tables;
    const subtotalCents = body.lineItems.reduce(
      (a, l) => a + Math.round(l.quantity * l.unitPriceCents),
      0,
    );
    const totalCents = subtotalCents + body.taxCents;
    const invoice = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(invoices)
        .values({
          orderId: body.orderId,
          partnerId: body.partnerId,
          customerType: body.customerType,
          recipientName: body.recipientName,
          recipientEmail: body.recipientEmail,
          lineItems: body.lineItems,
          subtotalCents,
          taxCents: body.taxCents,
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
      return withNumber!;
    });
    reply.code(201).send({ invoice });
  });

  app.patch('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = updateSchema.parse(request.body);
    const { invoices } = request.company!.tables;
    const set: Record<string, unknown> = { ...body, updatedAt: new Date() };
    if (body.status === 'paid') set.paidAt = new Date();
    const [row] = await db.update(invoices).set(set).where(eq(invoices.id, id)).returning();
    if (!row) throw notFound('Invoice not found');
    return { invoice: row };
  });

  app.post('/:id/send', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices } = request.company!.tables;
    const [current] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!current) throw notFound('Invoice not found');
    const now = new Date();
    const dueAt = new Date(now.getTime() + current.paymentTermsDays * 24 * 60 * 60 * 1000);
    const [row] = await db
      .update(invoices)
      .set({ status: 'sent', sentAt: now, dueAt, updatedAt: now })
      .where(eq(invoices.id, id))
      .returning();

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
          const taxRate =
            row.subtotalCents > 0 && row.taxCents > 0
              ? Math.round((row.taxCents / row.subtotalCents) * 100)
              : 0;
          const addressLines = [
            companyRow.addressLine1,
            companyRow.addressLine2,
            [companyRow.postalCode, companyRow.city].filter(Boolean).join(' ') || null,
          ].filter((x): x is string => Boolean(x));

          // Shared, pre-formatted values — used by both the HTML email and the PDF.
          const invoiceNumber = row.number ?? `#${row.id}`;
          const invoiceDate = fmtDate(now);
          const dueDate = fmtDate(dueAt);
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

  app.post('/:id/mark-paid', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices } = request.company!.tables;
    const now = new Date();
    const [row] = await db
      .update(invoices)
      .set({ status: 'paid', paidAt: now, updatedAt: now })
      .where(eq(invoices.id, id))
      .returning();
    if (!row) throw notFound('Invoice not found');
    return { invoice: row };
  });

  app.post('/:id/dunning', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices } = request.company!.tables;
    const now = new Date();
    const [row] = await db
      .update(invoices)
      .set({
        dunningLevel: sql`${invoices.dunningLevel} + 1`,
        lastDunningAt: now,
        status: 'overdue',
        updatedAt: now,
      })
      .where(eq(invoices.id, id))
      .returning();
    if (!row) throw notFound('Invoice not found');
    return { invoice: row };
  });
};

export default invoicesAdminRoutes;
