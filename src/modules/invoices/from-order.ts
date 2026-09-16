import { eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import type { TenantTables } from '../../db/schema/tenant.js';

/**
 * Turning an order into a draft invoice.
 *
 * This lived inside `auto-invoice.ts` and ran only on the payment webhook. It is
 * its own module now because there are two callers with the same arithmetic and
 * different endings: the automatic one (which may issue + email straight away)
 * and the manual "Rechnung erstellen" button on an order (which never does, so
 * the positions can still be edited). Two copies of VAT back-calculation would
 * have drifted the moment one of them was fixed.
 */

/** Default VAT rate for cleaning services (Germany). */
export const VAT_RATE = 19;

/** Net cents backed out of a gross (VAT-inclusive) amount. */
export function netFromGross(grossCents: number, ratePercent: number): number {
  return Math.round(grossCents / (1 + ratePercent / 100));
}

/** Calendar date in Europe/Berlin (the Leistungsdatum is tax-relevant). */
export function berlinDate(d: Date): string {
  // en-CA yields YYYY-MM-DD; the timeZone pins it to the German business day.
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
}

/** Postgres unique-violation SQLSTATE. */
export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export interface InvoiceSourceOrder {
  id: number;
  orderNumber: string | null;
  /** Set on orders created after the customer-360 link landed. */
  customerId?: number | null;
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

export interface InvoiceLineItem {
  label: string;
  quantity: number;
  unitPriceCents: number;
}

/**
 * The order's money, restated as net invoice lines.
 *
 * An order is priced gross (what the customer paid), an invoice is written net
 * plus VAT. Each line is backed out of its gross individually and the tax is
 * then the remainder against the order total — never a recomputed percentage —
 * so the invoice total always matches the amount taken to the cent, whatever the
 * rounding did to the individual lines.
 */
export function buildLineItemsFromOrder(
  order: InvoiceSourceOrder,
  items: Array<{ label: string; quantityLabel: string | null; subtotalCents: number }>,
): { lineItems: InvoiceLineItem[]; subtotalCents: number; taxCents: number } {
  const lineItems: InvoiceLineItem[] = [];

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
    lineItems.push({
      label: orderRef,
      quantity: 1,
      unitPriceCents: netFromGross(order.totalCents, VAT_RATE),
    });
  }

  const subtotalCents = lineItems.reduce(
    (a, l) => a + Math.round(l.quantity * l.unitPriceCents),
    0,
  );
  const taxCents = order.totalCents - subtotalCents;
  return { lineItems, subtotalCents, taxCents };
}

export interface CreateDraftResult {
  created: boolean;
  invoiceId?: number;
  invoice?: Record<string, unknown> & { id: number; status: string; number: string | null };
}

/**
 * Insert the draft for an order, or report the one already there.
 *
 * Idempotent by the partial unique index on `invoices.order_id`: a concurrent
 * caller (a webhook retry, or an operator hitting the button while the webhook
 * lands) loses the insert with 23505 and gets the winner's row back, so an order
 * can never end up with two invoices.
 */
export async function createInvoiceDraftForOrder(
  tables: TenantTables,
  order: InvoiceSourceOrder,
  opts: { reason: string; changedByUserId?: string | null },
): Promise<CreateDraftResult> {
  const { invoices, invoiceStatusLog, orderItems, customers } = tables;

  const [existing] = await db
    .select()
    .from(invoices)
    .where(eq(invoices.orderId, order.id))
    .limit(1);
  if (existing) return { created: false, invoiceId: existing.id, invoice: existing };

  const items = await db
    .select({
      label: orderItems.label,
      quantityLabel: orderItems.quantityLabel,
      subtotalCents: orderItems.subtotalCents,
    })
    .from(orderItems)
    .where(eq(orderItems.orderId, order.id));

  const { lineItems, subtotalCents, taxCents } = buildLineItemsFromOrder(order, items);
  const serviceDate = berlinDate(order.paidAt ?? new Date());

  // Inherit the customer's preferred payment term (e.g. a B2B firm on net-14),
  // falling back to the 7-day column default when they have none. The company /
  // USt-IdNr. of a business customer rides along so the invoice is addressed to
  // the firm, not just the person who booked.
  const [cust] = await db
    .select({
      id: customers.id,
      d: customers.defaultPaymentTermsDays,
      customerType: customers.customerType,
      companyName: customers.companyName,
      vatId: customers.vatId,
    })
    .from(customers)
    .where(eq(customers.email, order.customerEmail.toLowerCase()))
    .limit(1);
  const paymentTermsDays = cust?.d ?? 7;
  const isBusiness = cust?.customerType === 'business';

  try {
    const invoice = await db.transaction(async (tx) => {
      // Draft carries no number — assigned from the gapless sequence at issue.
      const [row] = await tx
        .insert(invoices)
        .values({
          orderId: order.id,
          customerId: cust?.id ?? order.customerId ?? null,
          customerType: isBusiness ? 'b2b' : 'b2c',
          recipientName: order.customerName,
          recipientCompany: isBusiness ? cust?.companyName : null,
          recipientVatId: isBusiness ? cust?.vatId : null,
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
          totalCents: order.totalCents,
          paymentTermsDays,
          status: 'draft',
        })
        .returning();
      await tx.insert(invoiceStatusLog).values({
        invoiceId: row!.id,
        fromStatus: null,
        toStatus: 'draft',
        changedByUserId: opts.changedByUserId ?? null,
        reason: opts.reason,
      });
      return row!;
    });
    return { created: true, invoiceId: invoice.id, invoice };
  } catch (err) {
    if (!isUniqueViolation(err)) throw err;
    const [dup] = await db.select().from(invoices).where(eq(invoices.orderId, order.id)).limit(1);
    return { created: false, invoiceId: dup?.id, invoice: dup };
  }
}
