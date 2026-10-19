import { and, count, eq, ne, or, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { geocodePlz, type Coords } from '../../lib/geo.js';
import { rankPartners, type MatchResult } from '../../lib/partner-matching.js';
import { verifiedPartnerIds } from '../partners/lib.js';
import { KIND_LABEL } from '../orders/lib.js';

export type OrderRow = TenantTables['orders']['$inferSelect'];
export type InquiryRow = TenantTables['serviceInquiries']['$inferSelect'];
export type OfferRow = TenantTables['partnerOffers']['$inferSelect'];

export interface DispatchTarget {
  plz: string | null;
  coords: Coords | null;
  serviceSlugs: string[] | null;
}

export function orderPlz(order: OrderRow): string | null {
  return order.addressPostalCode ?? order.pickupPlz ?? null;
}

/** Catalog slugs for the order's kind: mapped via order_kind (several can share one) or the slug itself. */
export async function orderTarget(tables: TenantTables, order: OrderRow): Promise<DispatchTarget> {
  const c = tables.serviceCatalog;
  const rows = await db
    .select({ slug: c.slug })
    .from(c)
    .where(or(eq(c.orderKind, order.kind), eq(c.slug, order.kind)));
  const plz = orderPlz(order);
  return {
    plz,
    coords: geocodePlz(plz),
    serviceSlugs: rows.length > 0 ? rows.map((r) => r.slug) : null,
  };
}

/** Inquiry service is free text from forms: matched to a catalog slug or name, else no service filter. */
export async function inquiryTarget(
  tables: TenantTables,
  inquiry: InquiryRow,
): Promise<DispatchTarget> {
  const raw = (inquiry.metadata?.serviceSlug as string | undefined) ?? inquiry.service ?? '';
  const needle = raw.trim().toLowerCase();
  let slug: string | null = null;
  if (needle) {
    const [hit] = await db
      .select({ slug: tables.serviceCatalog.slug })
      .from(tables.serviceCatalog)
      .where(
        sql`lower(${tables.serviceCatalog.slug}) = ${needle} OR lower(${tables.serviceCatalog.name}) = ${needle}`,
      )
      .limit(1);
    slug = hit?.slug ?? null;
  }
  return { plz: inquiry.plz, coords: geocodePlz(inquiry.plz), serviceSlugs: slug ? [slug] : null };
}

export async function matchPartners(
  tables: TenantTables,
  target: DispatchTarget,
  contractVersion: string | null,
): Promise<Array<MatchResult & { partnerStatus: string }>> {
  const partners = await db
    .select()
    .from(tables.partners)
    .where(ne(tables.partners.status, 'rejected'))
    .limit(500);
  const [verified, open] = await Promise.all([
    verifiedPartnerIds(tables, partners, contractVersion),
    db
      .select({ partnerId: tables.partnerOffers.partnerId, n: count() })
      .from(tables.partnerOffers)
      .where(eq(tables.partnerOffers.status, 'offered'))
      .groupBy(tables.partnerOffers.partnerId),
  ]);
  const openBy = new Map(open.map((o) => [o.partnerId, o.n]));
  const statusOf = new Map(partners.map((p) => [p.id, p.status]));
  const ranked = rankPartners(
    partners.map((p) => ({
      id: p.id,
      companyName: p.companyName,
      status: p.status,
      lat: p.lat,
      lng: p.lng,
      serviceRadiusKm: p.serviceRadiusKm,
      services: p.services,
      rating: p.rating == null ? null : Number(p.rating),
      verified: verified.has(p.id),
      openOffers: openBy.get(p.id) ?? 0,
    })),
    target.coords,
    target.serviceSlugs,
  );
  // The admin UI names the status behind `not_active` (pending vs suspended).
  return ranked.map((m) => ({ ...m, partnerStatus: statusOf.get(m.partnerId) ?? 'pending' }));
}

/** What a partner may see before accepting: the job, never the customer's identity or address. */
export function orderJobView(
  order: OrderRow,
  items: Array<{ label: string; quantityLabel: string }>,
) {
  const meta = order.metadata ?? {};
  return {
    type: 'order' as const,
    kind: order.kind,
    label: KIND_LABEL[order.kind] ?? order.kind,
    plz: orderPlz(order),
    city: order.addressCity,
    pickupMode: order.pickupMode,
    preferredDate: order.preferredDate,
    preferredSlots: (meta.preferredSlots as string[] | undefined) ?? [],
    customerNotes: order.customerNotes,
    items,
    totalCents: order.totalCents,
  };
}

export function inquiryJobView(inquiry: InquiryRow) {
  return {
    type: 'inquiry' as const,
    service: inquiry.service,
    plz: inquiry.plz,
    propertyDetails: inquiry.propertyDetails,
    preferredDate: inquiry.preferredDate,
    budget: inquiry.budget,
    message: inquiry.message,
    attachmentCount: inquiry.attachments.length,
    quotedAmount: inquiry.quotedAmount,
  };
}

/** Closes the other open offers once one partner has the job. */
export async function withdrawSiblingOffers(
  tables: TenantTables,
  target: { orderId?: number; inquiryId?: number },
  keepOfferId: number,
): Promise<void> {
  const o = tables.partnerOffers;
  const now = new Date();
  await db
    .update(o)
    .set({ status: 'withdrawn', declineReason: 'Vergeben', respondedAt: now, updatedAt: now })
    .where(
      and(
        eq(o.status, 'offered'),
        ne(o.id, keepOfferId),
        target.orderId != null ? eq(o.orderId, target.orderId) : eq(o.inquiryId, target.inquiryId!),
      ),
    );
}
