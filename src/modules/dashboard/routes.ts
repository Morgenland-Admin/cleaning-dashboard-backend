import type { FastifyPluginAsync } from 'fastify';
import { and, count, desc, eq, gte, inArray, isNotNull, isNull } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { company, membership } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';

/**
 * Per-brand stat block returned for every brand the requesting admin can see.
 * Same shape as GET /admin/companies/:slug/stats but batched here so the
 * dashboard doesn't fan out one fetch per brand from the client.
 */
type BrandStats = {
  slug: string;
  name: string;
  newsletter: { confirmed: number; pending: number; unsubscribed: number };
  contact: { total: number; new: number; last7Days: number };
  inquiry: { total: number; openCount: number; last7Days: number };
};

type ActivityKind = 'contact' | 'inquiry' | 'newsletter';
type ActivityItem = {
  id: string;
  kind: ActivityKind;
  companySlug: string;
  companyName: string;
  rowId: number;
  title: string;
  subtitle: string | null;
  createdAt: string;
};

const dashboardRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Single fetch powering the dashboard page. Returns:
   *   - One stats block per brand the user has access to
   *   - A merged "recent activity" feed (10 most-recent rows across all
   *     accessible brands, mixing contact / inquiry / newsletter signups)
   */
  app.get('/summary', async (request) => {
    const userId = request.authUser!.id;
    const inviterMeta = request.authUser as unknown as { accessLevel?: string };
    const isSuperAdmin = inviterMeta.accessLevel === 'super_admin';

    // Resolve the brand list. Super-admins see every active brand; everyone
    // else sees the ones they have membership on.
    const accessibleCompanies = isSuperAdmin
      ? await db
          .select({ slug: company.slug, name: company.name, schemaName: company.schemaName })
          .from(company)
          .where(eq(company.isActive, true))
      : await db
          .select({
            slug: company.slug,
            name: company.name,
            schemaName: company.schemaName,
          })
          .from(membership)
          .innerJoin(company, eq(membership.companySlug, company.slug))
          .where(and(eq(membership.userId, userId), eq(company.isActive, true)));

    if (accessibleCompanies.length === 0) {
      return { brands: [], activity: [] };
    }

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Per-brand stats: 9 COUNT queries each, but fan out across brands so the
    // total wall-clock is closer to "one brand's worth" rather than NxN.
    const brandStats: BrandStats[] = await Promise.all(
      accessibleCompanies.map(async (c) => {
        const tables = getTenantTables(c.schemaName);
        const [
          [nlConfirmed],
          [nlPending],
          [nlUnsub],
          [contactTotal],
          [contactNew],
          [contactWeek],
          [inquiryTotal],
          [inquiryOpen],
          [inquiryWeek],
        ] = await Promise.all([
          db
            .select({ n: count() })
            .from(tables.newsletterSubscribers)
            .where(
              and(
                eq(tables.newsletterSubscribers.confirmed, true),
                isNull(tables.newsletterSubscribers.unsubscribedAt),
              ),
            ),
          db
            .select({ n: count() })
            .from(tables.newsletterSubscribers)
            .where(
              and(
                eq(tables.newsletterSubscribers.confirmed, false),
                isNull(tables.newsletterSubscribers.unsubscribedAt),
              ),
            ),
          db
            .select({ n: count() })
            .from(tables.newsletterSubscribers)
            .where(isNotNull(tables.newsletterSubscribers.unsubscribedAt)),
          db.select({ n: count() }).from(tables.contactMessages),
          db
            .select({ n: count() })
            .from(tables.contactMessages)
            .where(eq(tables.contactMessages.status, 'new')),
          db
            .select({ n: count() })
            .from(tables.contactMessages)
            .where(gte(tables.contactMessages.createdAt, sevenDaysAgo)),
          db.select({ n: count() }).from(tables.serviceInquiries),
          db
            .select({ n: count() })
            .from(tables.serviceInquiries)
            .where(inArray(tables.serviceInquiries.status, ['new', 'in_review'])),
          db
            .select({ n: count() })
            .from(tables.serviceInquiries)
            .where(gte(tables.serviceInquiries.createdAt, sevenDaysAgo)),
        ]);
        return {
          slug: c.slug,
          name: c.name,
          newsletter: {
            confirmed: nlConfirmed?.n ?? 0,
            pending: nlPending?.n ?? 0,
            unsubscribed: nlUnsub?.n ?? 0,
          },
          contact: {
            total: contactTotal?.n ?? 0,
            new: contactNew?.n ?? 0,
            last7Days: contactWeek?.n ?? 0,
          },
          inquiry: {
            total: inquiryTotal?.n ?? 0,
            openCount: inquiryOpen?.n ?? 0,
            last7Days: inquiryWeek?.n ?? 0,
          },
        };
      }),
    );

    // Recent activity — pull the latest 5 from each kind per brand, then
    // merge + sort + slice client-side. Per-brand limit keeps the result set
    // small even if one brand has 50k contacts.
    const RECENT_PER_BRAND = 5;
    const activityChunks = await Promise.all(
      accessibleCompanies.map(async (c) => {
        const tables = getTenantTables(c.schemaName);
        const [contacts, inquiries, newsletter] = await Promise.all([
          db
            .select({
              id: tables.contactMessages.id,
              name: tables.contactMessages.name,
              email: tables.contactMessages.email,
              subject: tables.contactMessages.subject,
              message: tables.contactMessages.message,
              createdAt: tables.contactMessages.createdAt,
            })
            .from(tables.contactMessages)
            .orderBy(desc(tables.contactMessages.createdAt))
            .limit(RECENT_PER_BRAND),
          db
            .select({
              id: tables.serviceInquiries.id,
              name: tables.serviceInquiries.name,
              email: tables.serviceInquiries.email,
              service: tables.serviceInquiries.service,
              message: tables.serviceInquiries.message,
              createdAt: tables.serviceInquiries.createdAt,
            })
            .from(tables.serviceInquiries)
            .orderBy(desc(tables.serviceInquiries.createdAt))
            .limit(RECENT_PER_BRAND),
          db
            .select({
              id: tables.newsletterSubscribers.id,
              email: tables.newsletterSubscribers.email,
              firstName: tables.newsletterSubscribers.firstName,
              lastName: tables.newsletterSubscribers.lastName,
              createdAt: tables.newsletterSubscribers.createdAt,
            })
            .from(tables.newsletterSubscribers)
            .orderBy(desc(tables.newsletterSubscribers.createdAt))
            .limit(RECENT_PER_BRAND),
        ]);

        const items: ActivityItem[] = [];
        for (const r of contacts) {
          items.push({
            id: `${c.slug}:contact:${r.id}`,
            kind: 'contact',
            companySlug: c.slug,
            companyName: c.name,
            rowId: r.id,
            title: r.name,
            subtitle: r.subject ?? r.message.slice(0, 120),
            createdAt: r.createdAt.toISOString(),
          });
        }
        for (const r of inquiries) {
          items.push({
            id: `${c.slug}:inquiry:${r.id}`,
            kind: 'inquiry',
            companySlug: c.slug,
            companyName: c.name,
            rowId: r.id,
            title: r.name,
            subtitle: r.service ?? r.message.slice(0, 120),
            createdAt: r.createdAt.toISOString(),
          });
        }
        for (const r of newsletter) {
          const name = [r.firstName, r.lastName].filter(Boolean).join(' ').trim();
          items.push({
            id: `${c.slug}:newsletter:${r.id}`,
            kind: 'newsletter',
            companySlug: c.slug,
            companyName: c.name,
            rowId: r.id,
            title: name || r.email,
            subtitle: name ? r.email : null,
            createdAt: r.createdAt.toISOString(),
          });
        }
        return items;
      }),
    );

    const activity = activityChunks
      .flat()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, 10);

    return { brands: brandStats, activity };
  });
};

export default dashboardRoutes;
