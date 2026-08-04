import { and, eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { sendInvoiceEmail } from './send-invoice.js';
import { nextInvoiceNumber } from './number.js';

interface MinimalLogger {
  error(obj: unknown, msg?: string): void;
}

/** Default VAT rate for cleaning services (Germany). */
const VAT_RATE = 19;

/** Net cents backed out of a gross (VAT-inclusive) amount. */
function netFromGross(grossCents: number, ratePercent: number): number {
  return Math.round(grossCents / (1 + ratePercent / 100));
}

/** Calendar date in Europe/Berlin (the Leistungsdatum is tax-relevant). */
function berlinDate(d: Date): string {
  // en-CA yields YYYY-MM-DD; the timeZone pins it to the German business day.
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
}

/** Postgres unique-violation SQLSTATE. */
function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

interface PaidOrderRow {
  id: number;
  orderNumber: string | null;
  customerName: string;
  customerEmail: string;
  addressLine1: string | null;
  addressLine2: string | null;
  addressPostalCode: string | null;
  addressCity: string | null;
  addressCountry: string | null;
  currency: string;
  pickupFeeCents: number;
  minOrderTopUpCents: number;
  discountCents: number;
  voucherCode: string | null;
  totalCents: number;
  paidAt: Date | null;
}

/**
 * Create an invoice for a just-paid order. Idempotent (safe on webhook retries):
 * net/USt are backed out of the paid gross so the total matches to the cent.
 * When the §14-UStG fields are present (address + Leistungsdatum) it also issues
 * + emails immediately (replacing n8n ALL_12); otherwise it stays a draft.
 */
export async function autoCreateInvoiceForPaidOrder(
  tables: TenantTables,
  order: PaidOrderRow,
  companySlug: string,
  log?: MinimalLogger,
): Promise<{
  created: boolean;
  issued?: boolean;
  emailed?: boolean;
  invoiceId?: number;
  number?: string | null;
}> {
  const { invoices, invoiceStatusLog, orderItems, customers } = tables;

  // Idempotency — never create a second invoice for the same order.
  const [existing] = await db
    .select({ id: invoices.id })
    .from(invoices)
    .where(eq(invoices.orderId, order.id))
    .limit(1);
  if (existing) return { created: false, invoiceId: existing.id };

  const items = await db
    .select({
      label: orderItems.label,
      quantityLabel: orderItems.quantityLabel,
      subtotalCents: orderItems.subtotalCents,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  const gross = order.totalCents;
  const lineItems: Array<{ label: string; quantity: number; unitPriceCents: number }> = [];
  for (const it of items) {
    lineItems.push({
      label: it.quantityLabel ? `${it.label} (${it.quantityLabel})` : it.label,
      quantity: 1,
      unitPriceCents: netFromGross(it.subtotalCents, VAT_RATE),
    });
  }
  if (order.pickupFeeCents > 0) {
    lineItems.push({
      label: 'Abholung / Lieferung',
      quantity: 1,
      unitPriceCents: netFromGross(order.pickupFeeCents, VAT_RATE),
    });
  }
  if (order.minOrderTopUpCents > 0) {
    lineItems.push({
      label: 'Mindestbestellwert-Aufschlag',
      quantity: 1,
      unitPriceCents: netFromGross(order.minOrderTopUpCents, VAT_RATE),
    });
  }
  if (order.discountCents > 0) {
    lineItems.push({
      label: order.voucherCode ? `Rabatt (${order.voucherCode})` : 'Rabatt',
      quantity: 1,
      unitPriceCents: -netFromGross(order.discountCents, VAT_RATE),
    });
  }
  // Fallback so the invoice is never empty (e.g. order with no line items).
  if (lineItems.length === 0) {
    const orderRef = order.orderNumber ? `Auftrag ${order.orderNumber}` : `Auftrag #${order.id}`;
    lineItems.push({ label: orderRef, quantity: 1, unitPriceCents: netFromGross(gross, VAT_RATE) });
  }

  // Subtotal = sum of net lines; tax = remainder so total == paid gross exactly.
  const subtotalCents = lineItems.reduce(
    (a, l) => a + Math.round(l.quantity * l.unitPriceCents),
    0,
  );
  const taxCents = gross - subtotalCents;
  const serviceDate = berlinDate(order.paidAt ?? new Date());

  // Inherit the customer's preferred payment term (e.g. a B2B firm on net-14),
  // falling back to the 7-day column default when they have none.
  const [cust] = await db
    .select({ d: customers.defaultPaymentTermsDays })
    .from(customers)
    .where(eq(customers.email, order.customerEmail.toLowerCase()))
    .limit(1);
  const paymentTermsDays = cust?.d ?? 7;

  // Draft carries no number — assigned from the gapless sequence at issue.
  // The partial unique index on order_id is the real idempotency guard: if a
  // concurrent webhook already inserted, the insert throws 23505 → no-op.
  let invoice!: typeof invoices.$inferSelect;
  try {
    invoice = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(invoices)
        .values({
          orderId: order.id,
          customerType: 'b2c',
          recipientName: order.customerName,
          recipientEmail: order.customerEmail,
          recipientAddressLine1: order.addressLine1,
          recipientAddressLine2: order.addressLine2,
          recipientPostalCode: order.addressPostalCode,
          recipientCity: order.addressCity,
          recipientCountry: order.addressCountry ?? 'DE',
          // Betreff on the printed invoice — points the customer at their order.
          subject: order.orderNumber ? `Auftrag ${order.orderNumber}` : null,
          serviceDate,
          currency: order.currency,
          lineItems,
          subtotalCents,
          taxRatePercent: VAT_RATE,
          taxCents,
          totalCents: gross,
          paymentTermsDays,
          status: 'draft',
        })
        .returning();
      await tx.insert(invoiceStatusLog).values({
        invoiceId: row!.id,
        fromStatus: null,
        toStatus: 'draft',
        changedByUserId: null,
        reason: 'Automatisch erstellt (Zahlung eingegangen)',
      });
      return row!;
    });
  } catch (err) {
    if (isUniqueViolation(err)) {
      const [dup] = await db
        .select({ id: invoices.id })
        .from(invoices)
        .where(eq(invoices.orderId, order.id))
        .limit(1);
      return { created: false, invoiceId: dup?.id };
    }
    throw err;
  }

  // §14 UStG mandatory fields for issuing. Missing any → leave as draft.
  const canIssue =
    Boolean(invoice.recipientAddressLine1) &&
    Boolean(invoice.recipientPostalCode) &&
    Boolean(invoice.recipientCity) &&
    Boolean(invoice.serviceDate);
  if (!canIssue) {
    return { created: true, issued: false, invoiceId: invoice.id, number: invoice.number };
  }

  // Issue: draft → sent, assign the gapless number + stamp dueAt — atomically.
  const now = new Date();
  const dueAt = new Date(now.getTime() + invoice.paymentTermsDays * 24 * 60 * 60 * 1000);
  const issued = await db.transaction(async (tx) => {
    const number = await nextInvoiceNumber(tx, companySlug);
    const [r] = await tx
      .update(invoices)
      .set({ status: 'sent', number, sentAt: now, dueAt, updatedAt: now })
      .where(and(eq(invoices.id, invoice.id), eq(invoices.status, 'draft')))
      .returning();
    if (!r) return null;
    await tx.insert(invoiceStatusLog).values({
      invoiceId: r.id,
      fromStatus: 'draft',
      toStatus: 'sent',
      changedByUserId: null,
      reason: 'Rechnung ausgestellt & versendet (automatisch)',
    });
    return r;
  });
  if (!issued) {
    // Someone issued/voided it between create and issue — leave as is.
    return { created: true, issued: false, invoiceId: invoice.id, number: invoice.number };
  }

  // Email from the brand's sender. Best-effort — issue stands even if mail fails.
  let emailed = false;
  try {
    const [companyRow] = await db
      .select()
      .from(company)
      .where(eq(company.slug, companySlug))
      .limit(1);
    if (companyRow) {
      const res = await sendInvoiceEmail(companyRow, issued, log);
      emailed = res.ok;
    }
  } catch (err) {
    log?.error({ err, invoiceId: issued.id }, 'Failed to send auto-issued invoice email');
  }

  return { created: true, issued: true, emailed, invoiceId: issued.id, number: issued.number };
}
