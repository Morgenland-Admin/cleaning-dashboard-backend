import { and, eq, isNull, or, sql } from 'drizzle-orm';

import { db } from '../db/index.js';
import type { TenantTables } from '../db/schema/tenant.js';
import { computeLoyaltyTier } from './loyalty.js';

/**
 * Customer money/volume stats.
 *
 * A customer's turnover comes from two places: paid orders (webshop / booking)
 * and paid invoices written by hand in the dashboard. Standalone invoices — the
 * ones with no `order_id` — are the only invoices counted, because an invoice
 * created for a paid order bills money the order already accounts for. Voided
 * and unpaid invoices never count as turnover; they show up as "invoiced" and
 * "open" figures instead.
 */

interface Totals {
  totalOrders: number;
  totalSpentCents: number;
  firstAt: Date | null;
  lastAt: Date | null;
}

/** Live turnover of one customer: paid orders + paid standalone invoices. */
export async function computeCustomerTotals(
  tables: TenantTables,
  customerId: number,
  email: string,
): Promise<Totals> {
  const { orders, invoices } = tables;
  const lower = email.trim().toLowerCase();

  const [orderAgg] = await db
    .select({
      count: sql<number>`count(*)::int`,
      // Refunds come back off the turnover; a per-row greatest() keeps an
      // over-refunded row from eating another order's money.
      sum: sql<number>`coalesce(sum(greatest(${orders.totalCents} - ${orders.refundedAmountCents}, 0)), 0)::int`,
      first: sql<Date | null>`min(${orders.paidAt})`,
      last: sql<Date | null>`max(${orders.paidAt})`,
    })
    .from(orders)
    .where(
      and(
        or(eq(orders.customerId, customerId), sql`lower(${orders.customerEmail}) = ${lower}`),
        sql`${orders.paidAt} IS NOT NULL`,
      ),
    );

  const [invoiceAgg] = await db
    .select({
      count: sql<number>`count(*)::int`,
      sum: sql<number>`coalesce(sum(${invoices.totalCents}), 0)::int`,
      first: sql<Date | null>`min(${invoices.paidAt})`,
      last: sql<Date | null>`max(${invoices.paidAt})`,
    })
    .from(invoices)
    .where(
      and(
        or(eq(invoices.customerId, customerId), sql`lower(${invoices.recipientEmail}) = ${lower}`),
        isNull(invoices.orderId),
        eq(invoices.status, 'paid'),
      ),
    );

  // Aggregates selected through raw `sql` come back as Date or as the ISO
  // string the driver read — accept both rather than silently dropping stamps.
  const dates = [orderAgg?.first, orderAgg?.last, invoiceAgg?.first, invoiceAgg?.last]
    .map((d) => (d == null ? NaN : new Date(d as string | Date).getTime()))
    .filter((ms) => Number.isFinite(ms));

  return {
    totalOrders: (orderAgg?.count ?? 0) + (invoiceAgg?.count ?? 0),
    totalSpentCents: (orderAgg?.sum ?? 0) + (invoiceAgg?.sum ?? 0),
    firstAt: dates.length ? new Date(Math.min(...dates)) : null,
    lastAt: dates.length ? new Date(Math.max(...dates)) : null,
  };
}

/**
 * Recompute the stored aggregates (`total_orders`, `total_spent_cents`,
 * first/last order stamps) and the loyalty tier from live data. Used by the
 * "Recompute tier" action and whenever an invoice is settled, so the customer
 * record can never drift from the orders and invoices behind it.
 */
export async function recomputeCustomerAggregates(
  tables: TenantTables,
  customerId: number,
): Promise<typeof tables.customers.$inferSelect | null> {
  const { customers } = tables;
  const [row] = await db
    .select({ id: customers.id, email: customers.email })
    .from(customers)
    .where(eq(customers.id, customerId))
    .limit(1);
  if (!row) return null;

  const totals = await computeCustomerTotals(tables, customerId, row.email);
  const [updated] = await db
    .update(customers)
    .set({
      totalOrders: totals.totalOrders,
      totalSpentCents: totals.totalSpentCents,
      loyaltyTier: computeLoyaltyTier(totals.totalOrders, totals.totalSpentCents),
      firstOrderAt: totals.firstAt,
      lastOrderAt: totals.lastAt,
      updatedAt: new Date(),
    })
    .where(eq(customers.id, customerId))
    .returning();
  return updated ?? null;
}

/**
 * Called after an invoice is settled. Resolves the customer from the invoice
 * (`customer_id`, else the recipient email) and recomputes their aggregates.
 * Best-effort: never let a bookkeeping stat break the payment flow.
 */
export async function recomputeCustomerForInvoice(
  tables: TenantTables,
  invoice: { customerId: number | null; recipientEmail: string | null },
  log?: { warn(obj: unknown, msg?: string): void },
): Promise<void> {
  try {
    const { customers } = tables;
    let customerId = invoice.customerId;
    if (customerId == null && invoice.recipientEmail) {
      const [cust] = await db
        .select({ id: customers.id })
        .from(customers)
        .where(sql`lower(${customers.email}) = ${invoice.recipientEmail.trim().toLowerCase()}`)
        .limit(1);
      customerId = cust?.id ?? null;
    }
    if (customerId == null) return;
    await recomputeCustomerAggregates(tables, customerId);
  } catch (err) {
    log?.warn({ err }, 'customer aggregate update after invoice payment failed');
  }
}
