import type { FastifyBaseLogger } from 'fastify';
import { and, asc, desc, eq, isNull, notInArray, or, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { partnerAssignedEmail } from '../../email/templates.js';
import {
  computeCommission,
  parseCommissionRate,
  type CommissionSplit,
} from '../../lib/commission.js';
import { partnerPortalBase } from '../../lib/company-loader.js';
import { formatEurFromCents } from '../../lib/pricing.js';
import { brandForMail, loadCompanyFull, mailPartner, type PartnerRow } from '../partners/lib.js';
import { KIND_LABEL, orderNumberOf } from './lib.js';

type OrderRow = TenantTables['orders']['$inferSelect'];

const CLOSED_STATUSES = ['cancelled', 'refunded'];

/**
 * Partner override, else the catalog default for the order's kind, else the platform default.
 * `kind` is a fixed-price kind or (imported/inquiry orders) a catalog slug: the service whose slug
 * is the kind wins, then the first service mapped to it via order_kind.
 */
export async function resolveCommissionRate(
  tables: TenantTables,
  partner: Pick<PartnerRow, 'commissionRate'>,
  kind: string,
): Promise<number | null> {
  const own = parseCommissionRate(partner.commissionRate);
  if (own != null) return own;
  const c = tables.serviceCatalog;
  const [svc] = await db
    .select({ rate: c.commissionRate })
    .from(c)
    .where(or(eq(c.slug, kind), eq(c.orderKind, kind)))
    .orderBy(desc(sql`${c.slug} = ${kind}`), asc(c.sortOrder), asc(c.id))
    .limit(1);
  return parseCommissionRate(svc?.rate);
}

/**
 * Sets partner + commission split. `onlyIfUnassigned` makes it a CAS so two accepted offers can't
 * both win; returns null when the order is gone, closed or (with CAS) already taken.
 */
export async function assignOrderToPartner(
  tables: TenantTables,
  order: OrderRow,
  partner: PartnerRow,
  opts: { onlyIfUnassigned?: boolean } = {},
): Promise<{ order: OrderRow; split: CommissionSplit } | null> {
  const { orders } = tables;
  const rate = await resolveCommissionRate(tables, partner, order.kind);
  const split = computeCommission(order.totalCents, rate);
  const now = new Date();
  const conds = [eq(orders.id, order.id), notInArray(orders.status, CLOSED_STATUSES)];
  if (opts.onlyIfUnassigned) conds.push(isNull(orders.assignedPartnerId));
  const [updated] = await db
    .update(orders)
    .set({
      assignedPartnerId: partner.id,
      assignedAt: now,
      commissionCents: split.commissionCents,
      partnerPayoutCents: split.partnerPayoutCents,
      payoutStatus: order.payoutStatus === 'paid' ? 'paid' : 'pending',
      updatedAt: now,
    })
    .where(and(...conds))
    .returning();
  return updated ? { order: updated, split } : null;
}

/** Push + branded mail to the partner; best-effort. */
export async function notifyPartnerOfAssignment(opts: {
  companySlug: string;
  companyName: string;
  order: OrderRow;
  partner: PartnerRow;
  split: CommissionSplit;
  log: FastifyBaseLogger;
}): Promise<void> {
  const { order, partner, split } = opts;
  const number = orderNumberOf(order);
  const jobLabel = KIND_LABEL[order.kind] ?? order.kind;
  try {
    const { sendPushToUser } = await import('../../lib/push.js');
    await sendPushToUser(partner.userId, {
      title: `${opts.companyName} · Neuer Auftrag zugewiesen`,
      body: `${number} · ${jobLabel} · Auszahlung ${formatEurFromCents(split.partnerPayoutCents)}`,
      url: `/auftraege/${order.id}`,
      tag: `assign:${order.id}`,
      brandSlug: opts.companySlug,
    });
  } catch (err) {
    opts.log.warn({ err, orderId: order.id }, 'assignment push dispatch failed');
  }
  const companyRow = await loadCompanyFull(opts.companySlug);
  if (!companyRow) return;
  const location = [order.addressPostalCode ?? order.pickupPlz, order.addressCity]
    .filter(Boolean)
    .join(' ');
  await mailPartner({
    companyRow,
    partner,
    kind: 'partner_assigned',
    refType: 'order',
    refId: order.id,
    email: partnerAssignedEmail({
      brand: brandForMail(companyRow),
      partnerName: partner.companyName,
      orderNumber: number,
      jobLabel,
      location: location || null,
      payoutLine: formatEurFromCents(split.partnerPayoutCents),
      orderUrl: `${partnerPortalBase(companyRow) ?? ''}/auftraege/${order.id}`,
    }),
  });
}
