import { eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import type { TenantTables } from '../../db/schema/tenant.js';

export const VAT_RATE = 19;

export function netFromGross(grossCents: number, ratePercent: number): number {
  return Math.round(grossCents / (1 + ratePercent / 100));
}

/** Calendar date in Europe/Berlin; the Leistungsdatum is tax-relevant. */
export function berlinDate(d: Date): string {
  // en-CA yields YYYY-MM-DD.
  return d.toLocaleDateString('en-CA', { timeZone: 'Europe/Berlin' });
}

export function isUniqueViolation(err: unknown): boolean {
  return typeof err === 'object' && err !== null && (err as { code?: string }).code === '23505';
}

export interface InvoiceSourceOrder {
  id: number;
  orderNumber: string | null;
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
 * Orders are gross, invoices net + VAT. Lines are backed out individually and tax is the remainder
 * against the order total (never a recomputed %), so the invoice total matches the amount paid to the cent.
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
  // Never an empty invoice.
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
 * Insert the draft for an order, or return the existing one. The partial unique index on `invoices.order_id`
 * makes a concurrent caller lose with 23505 and get the winner's row, so an order never has two invoices.
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

  // Customer's payment term (default 7 days); a business customer's company / USt-IdNr. is addressed on the invoice.
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
      // Drafts have no number; it is assigned at issue.
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
