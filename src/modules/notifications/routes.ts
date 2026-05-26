import type { FastifyPluginAsync } from 'fastify';
import { and, count, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { company, membership } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';

type NotificationKind = 'contact' | 'inquiry';
type Notification = {
  id: string;
  kind: NotificationKind;
  companySlug: string;
  companyName: string;
  rowId: number;
  title: string;
  message: string;
  createdAt: string;
};

/**
 * Resolve which brands the calling admin can see notifications from.
 * Super-admins see every active brand; everyone else sees their memberships.
 */
async function accessibleBrands(userId: string, isSuperAdmin: boolean) {
  if (isSuperAdmin) {
    return db
      .select({ slug: company.slug, name: company.name, schemaName: company.schemaName })
      .from(company)
      .where(eq(company.isActive, true));
  }
  return db
    .select({ slug: company.slug, name: company.name, schemaName: company.schemaName })
    .from(membership)
    .innerJoin(company, eq(membership.companySlug, company.slug))
    .where(and(eq(membership.userId, userId), eq(company.isActive, true)));
}

const notificationsRoutes: FastifyPluginAsync = async (app) => {
  /**
   * Header bell badge count. "Unread" today means:
   *   - contact_messages with status='new'
   *   - service_inquiries with status='new' or 'in_review'
   * Aggregated across every brand the user can see. Future per-user dismissal
   * state would live on a separate `notification_reads` table.
   */
  app.get('/unread-count', async (request) => {
    const userId = request.authUser!.id;
    const inviterMeta = request.authUser as unknown as { accessLevel?: string };
    const isSuperAdmin = inviterMeta.accessLevel === 'super_admin';

    const brands = await accessibleBrands(userId, isSuperAdmin);
    if (brands.length === 0) return { count: 0, byBrand: [] };

    const counts = await Promise.all(
      brands.map(async (b) => {
        const tables = getTenantTables(b.schemaName);
        const [[contacts], [inquiries]] = await Promise.all([
          db
            .select({ n: count() })
            .from(tables.contactMessages)
            .where(eq(tables.contactMessages.status, 'new')),
          db
            .select({ n: count() })
            .from(tables.serviceInquiries)
            .where(inArray(tables.serviceInquiries.status, ['new', 'in_review'])),
        ]);
        const total = (contacts?.n ?? 0) + (inquiries?.n ?? 0);
        return { slug: b.slug, name: b.name, count: total };
      }),
    );

    const total = counts.reduce((sum, b) => sum + b.count, 0);
    return { count: total, byBrand: counts };
  });

  /**
   * Notification feed for the bell dropdown. Lists the most-recent
   * "actionable" rows (new contacts, new/in_review inquiries) across every
   * accessible brand, merged + sorted. Each item carries enough info to
   * route the user to the right detail page on click.
   */
  const listQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
  });
  app.get('/', async (request) => {
    const { limit } = listQuerySchema.parse(request.query);
    const userId = request.authUser!.id;
    const inviterMeta = request.authUser as unknown as { accessLevel?: string };
    const isSuperAdmin = inviterMeta.accessLevel === 'super_admin';

    const brands = await accessibleBrands(userId, isSuperAdmin);
    if (brands.length === 0) return { items: [] };

    // Pull per-brand chunks then merge — keeps each query bounded by an index.
    const PER_BRAND = Math.min(limit, 10);
    const perBrand = await Promise.all(
      brands.map(async (b) => {
        const tables = getTenantTables(b.schemaName);
        const [contacts, inquiries] = await Promise.all([
          db
            .select({
              id: tables.contactMessages.id,
              name: tables.contactMessages.name,
              subject: tables.contactMessages.subject,
              message: tables.contactMessages.message,
              createdAt: tables.contactMessages.createdAt,
            })
            .from(tables.contactMessages)
            .where(eq(tables.contactMessages.status, 'new'))
            .orderBy(desc(tables.contactMessages.createdAt))
            .limit(PER_BRAND),
          db
            .select({
              id: tables.serviceInquiries.id,
              name: tables.serviceInquiries.name,
              service: tables.serviceInquiries.service,
              message: tables.serviceInquiries.message,
              createdAt: tables.serviceInquiries.createdAt,
            })
            .from(tables.serviceInquiries)
            .where(inArray(tables.serviceInquiries.status, ['new', 'in_review']))
            .orderBy(desc(tables.serviceInquiries.createdAt))
            .limit(PER_BRAND),
        ]);

        const items: Notification[] = [];
        for (const r of contacts) {
          items.push({
            id: `${b.slug}:contact:${r.id}`,
            kind: 'contact',
            companySlug: b.slug,
            companyName: b.name,
            rowId: r.id,
            title: r.name,
            message: r.subject ?? r.message.slice(0, 140),
            createdAt: r.createdAt.toISOString(),
          });
        }
        for (const r of inquiries) {
          items.push({
            id: `${b.slug}:inquiry:${r.id}`,
            kind: 'inquiry',
            companySlug: b.slug,
            companyName: b.name,
            rowId: r.id,
            title: r.name,
            message: r.service ?? r.message.slice(0, 140),
            createdAt: r.createdAt.toISOString(),
          });
        }
        return items;
      }),
    );

    const items = perBrand
      .flat()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : -1))
      .slice(0, limit);

    return { items };
  });
};

export default notificationsRoutes;
