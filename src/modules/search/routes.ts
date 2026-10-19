import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, ilike, or } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { company, membership } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';
import { accessLevelOf } from '../../lib/access.js';
import { isImportedSource, senderLabel } from '../../lib/inbox.js';
import { isNonContactableEmail } from '../../email/service.js';

// Cross-brand lookup for the ⌘K palette: read-only and shallow (enough to render a row and route to it).
// Scope is the caller's own brands (all active for a super_admin), so it cannot read across a tenant boundary.

const querySchema = z.object({
  q: z.string().trim().min(2).max(120),
  limit: z.coerce.number().int().min(1).max(10).default(5),
});

export type SearchKind = 'order' | 'customer' | 'inquiry' | 'contact' | 'invoice' | 'partner';

interface SearchHit {
  kind: SearchKind;
  companySlug: string;
  companyName: string;
  id: number;
  /** May be '' when a row has no usable name; the client shows its own label then. */
  title: string;
  subtitle: string | null;
  meta: string | null;
  href: string;
  /** Raw status slug; the client translates it. */
  status: string | null;
  /** Order kind slug (service-catalog slugs on imported orders). */
  orderKind?: string | null;
  /** Written by a data import (old system history). */
  imported: boolean;
}

/** Real e-mail address, or null for the import placeholders. */
function contactable(email: string | null | undefined): string | null {
  const e = email?.trim();
  return e && !isNonContactableEmail(e) ? e : null;
}

function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

const MAX_INT4 = 2147483647;

function asId(q: string): number | null {
  const m = /^#?(\d{1,10})$/.exec(q);
  if (!m) return null;
  const n = Number(m[1]);
  return n <= MAX_INT4 ? n : null;
}

// Orders without a stored order_number display a number (YYYY/NNNNNN) derived from the id, so LIKE can't match it:
// parse it back to the id.
function orderNumberToId(q: string): number | null {
  const m = /^(\d{4})\s*\/\s*(\d{1,6})$/.exec(q.trim());
  if (!m) return null;
  const n = Number(m[2]);
  return n > 0 && n <= MAX_INT4 ? n : null;
}

// "ANF-2026-000123" (the inquiry number on screen) addresses the row id.
function inquiryNumberToId(q: string): number | null {
  const m = /^ANF-\d{4}-0*(\d{1,10})$/i.exec(q.trim());
  if (!m) return null;
  const n = Number(m[1]);
  return n > 0 && n <= MAX_INT4 ? n : null;
}

function formatInquiryNumber(id: number, createdAt: Date): string {
  return `ANF-${createdAt.getUTCFullYear()}-${String(id).padStart(6, '0')}`;
}

// Same display format the orders module uses for rows with no stored number.
function displayOrderNumber(row: { id: number; orderNumber: string | null; createdAt: Date }) {
  return row.orderNumber ?? `${row.createdAt.getUTCFullYear()}/${String(row.id).padStart(6, '0')}`;
}

function centsToEuro(cents: number | null | undefined): string | null {
  if (cents == null) return null;
  return `${(cents / 100).toFixed(2).replace('.', ',')} €`;
}

const searchRoutes: FastifyPluginAsync = async (app) => {
  app.get(
    '/',
    // Bounded: one call fans out across every accessible brand.
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request) => {
      const { q, limit } = querySchema.parse(request.query);
      const userId = request.authUser!.id;
      const level = accessLevelOf(request);

      const brands =
        level === 'super_admin'
          ? await db
              .select({ slug: company.slug, name: company.name, schemaName: company.schemaName })
              .from(company)
              .where(eq(company.isActive, true))
          : await db
              .select({ slug: company.slug, name: company.name, schemaName: company.schemaName })
              .from(membership)
              .innerJoin(company, eq(membership.companySlug, company.slug))
              .where(and(eq(membership.userId, userId), eq(company.isActive, true)));

      if (brands.length === 0) return { hits: [], query: q };

      const like = likeTerm(q);
      const id = asId(q);
      const derivedOrderId = orderNumberToId(q);
      const inquiryId = inquiryNumberToId(q);

      // Five small indexed lookups per brand, each capped at `limit`: work is bounded by brands × 5 × limit.
      const perBrand = await Promise.all(
        brands.map(async (brand): Promise<SearchHit[]> => {
          const t = getTenantTables(brand.schemaName);
          const base = { companySlug: brand.slug, companyName: brand.name };

          const [orders, customers, inquiries, contacts, invoices, partners] = await Promise.all([
            db
              .select({
                id: t.orders.id,
                orderNumber: t.orders.orderNumber,
                customerName: t.orders.customerName,
                customerEmail: t.orders.customerEmail,
                customerPhone: t.orders.customerPhone,
                kind: t.orders.kind,
                status: t.orders.status,
                totalCents: t.orders.totalCents,
                source: t.orders.source,
                createdAt: t.orders.createdAt,
              })
              .from(t.orders)
              .where(
                or(
                  ilike(t.orders.orderNumber, like),
                  ilike(t.orders.customerName, like),
                  ilike(t.orders.customerEmail, like),
                  ilike(t.orders.customerPhone, like),
                  ...(id ? [eq(t.orders.id, id)] : []),
                  ...(derivedOrderId ? [eq(t.orders.id, derivedOrderId)] : []),
                ),
              )
              .orderBy(desc(t.orders.createdAt))
              .limit(limit),
            db
              .select({
                id: t.customers.id,
                name: t.customers.name,
                email: t.customers.email,
                companyName: t.customers.companyName,
                customerNumber: t.customers.customerNumber,
                phone: t.customers.phone,
                tags: t.customers.tags,
              })
              .from(t.customers)
              .where(
                or(
                  ilike(t.customers.name, like),
                  ilike(t.customers.email, like),
                  ilike(t.customers.companyName, like),
                  ilike(t.customers.customerNumber, like),
                  ilike(t.customers.phone, like),
                  ...(id ? [eq(t.customers.id, id)] : []),
                ),
              )
              .orderBy(desc(t.customers.createdAt))
              .limit(limit),
            db
              .select({
                id: t.serviceInquiries.id,
                name: t.serviceInquiries.name,
                email: t.serviceInquiries.email,
                phone: t.serviceInquiries.phone,
                service: t.serviceInquiries.service,
                callReason: t.serviceInquiries.callReason,
                status: t.serviceInquiries.status,
                source: t.serviceInquiries.source,
                createdAt: t.serviceInquiries.createdAt,
              })
              .from(t.serviceInquiries)
              .where(
                or(
                  ilike(t.serviceInquiries.name, like),
                  ilike(t.serviceInquiries.email, like),
                  ilike(t.serviceInquiries.phone, like),
                  ilike(t.serviceInquiries.service, like),
                  ...(id ? [eq(t.serviceInquiries.id, id)] : []),
                  ...(inquiryId ? [eq(t.serviceInquiries.id, inquiryId)] : []),
                ),
              )
              .orderBy(desc(t.serviceInquiries.createdAt))
              .limit(limit),
            db
              .select({
                id: t.contactMessages.id,
                name: t.contactMessages.name,
                email: t.contactMessages.email,
                phone: t.contactMessages.phone,
                subject: t.contactMessages.subject,
                status: t.contactMessages.status,
                source: t.contactMessages.source,
              })
              .from(t.contactMessages)
              .where(
                or(
                  ilike(t.contactMessages.name, like),
                  ilike(t.contactMessages.email, like),
                  ilike(t.contactMessages.subject, like),
                  ilike(t.contactMessages.phone, like),
                  ...(id ? [eq(t.contactMessages.id, id)] : []),
                ),
              )
              .orderBy(desc(t.contactMessages.createdAt))
              .limit(limit),
            db
              .select({
                id: t.invoices.id,
                number: t.invoices.number,
                recipientName: t.invoices.recipientName,
                status: t.invoices.status,
                totalCents: t.invoices.totalCents,
              })
              .from(t.invoices)
              .where(
                or(
                  ilike(t.invoices.number, like),
                  ilike(t.invoices.recipientName, like),
                  ilike(t.invoices.recipientCompany, like),
                  ...(id ? [eq(t.invoices.id, id)] : []),
                ),
              )
              .orderBy(desc(t.invoices.createdAt))
              .limit(limit),
            // Only identity columns — payout details never travel through search.
            db
              .select({
                id: t.partners.id,
                companyName: t.partners.companyName,
                contactEmail: t.partners.contactEmail,
                city: t.partners.city,
                status: t.partners.status,
              })
              .from(t.partners)
              .where(
                or(
                  ilike(t.partners.companyName, like),
                  ilike(t.partners.legalName, like),
                  ilike(t.partners.contactEmail, like),
                  ilike(t.partners.city, like),
                  ...(id ? [eq(t.partners.id, id)] : []),
                ),
              )
              .orderBy(desc(t.partners.createdAt))
              .limit(limit),
          ]);

          return [
            ...orders.map(
              (o): SearchHit => ({
                ...base,
                kind: 'order',
                id: o.id,
                title: displayOrderNumber(o),
                subtitle: senderLabel(o.customerName, o.customerPhone, o.customerEmail) || null,
                meta: centsToEuro(o.totalCents),
                href: `/auftraege/${o.id}`,
                status: o.status,
                orderKind: o.kind,
                imported: isImportedSource(o.source),
              }),
            ),
            ...customers.map(
              (c): SearchHit => ({
                ...base,
                kind: 'customer',
                id: c.id,
                title:
                  c.name?.trim() ||
                  c.companyName?.trim() ||
                  c.phone?.trim() ||
                  contactable(c.email) ||
                  '',
                subtitle: contactable(c.email) ?? c.phone,
                meta: c.customerNumber,
                href: `/customers/${c.id}`,
                status: null,
                imported: (c.tags ?? []).includes('altsystem'),
              }),
            ),
            ...inquiries.map(
              (i): SearchHit => ({
                ...base,
                kind: 'inquiry',
                id: i.id,
                title: senderLabel(i.name, i.phone, i.email),
                subtitle: i.service?.trim() || i.callReason?.trim() || contactable(i.email),
                meta: formatInquiryNumber(i.id, i.createdAt),
                href: `/inquiries/${brand.slug}/${i.id}`,
                status: i.status,
                imported: isImportedSource(i.source),
              }),
            ),
            ...contacts.map(
              (c): SearchHit => ({
                ...base,
                kind: 'contact',
                id: c.id,
                title: senderLabel(c.name, c.phone, c.email),
                subtitle: c.subject?.trim() || contactable(c.email),
                meta: null,
                href: `/contacts/${brand.slug}/${c.id}`,
                status: c.status,
                imported: isImportedSource(c.source),
              }),
            ),
            ...invoices.map(
              (inv): SearchHit => ({
                ...base,
                kind: 'invoice',
                id: inv.id,
                title: inv.number ?? '',
                subtitle: inv.recipientName,
                meta: centsToEuro(inv.totalCents),
                href: `/rechnungen/${inv.id}`,
                status: inv.status,
                imported: false,
              }),
            ),
            ...partners.map(
              (pt): SearchHit => ({
                ...base,
                kind: 'partner',
                id: pt.id,
                title: pt.companyName ?? '',
                subtitle: contactable(pt.contactEmail) ?? pt.city,
                meta: pt.city && contactable(pt.contactEmail) ? pt.city : null,
                href: `/partner/${pt.id}?brand=${brand.slug}`,
                status: pt.status,
                imported: false,
              }),
            ),
          ];
        }),
      );

      // Exact title, then prefix match, then live records before imported history.
      const needle = q.toLowerCase();
      const rank = (h: SearchHit) => {
        const title = h.title.toLowerCase();
        const match = title === needle ? 0 : title.startsWith(needle) ? 1 : 2;
        return match * 2 + (h.imported ? 1 : 0);
      };
      const hits = perBrand.flat().sort((a, b) => rank(a) - rank(b));

      return { hits, query: q };
    },
  );
};

export default searchRoutes;
