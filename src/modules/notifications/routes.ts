import type { FastifyPluginAsync } from 'fastify';
import { and, count, desc, eq, max, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { company, membership } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';
import {
  inquiryChannelOf,
  inquiryChannelSql,
  notImported,
  senderLabel,
  type InquiryChannel,
} from '../../lib/inbox.js';

type NotificationKind = 'contact' | 'inquiry';
type Notification = {
  id: string;
  kind: NotificationKind;
  companySlug: string;
  companyName: string;
  rowId: number;
  title: string;
  message: string;
  channel: InquiryChannel | null;
  createdAt: string;
};
type Channels = Record<InquiryChannel, number>;

const emptyChannels = (): Channels => ({ phone: 0, email: 0, web: 0 });

// Super-admins see every active brand; everyone else only their memberships.
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

const laterIso = (a: string | null, b: Date | null | undefined) => {
  if (!b) return a;
  const iso = b.toISOString();
  return !a || iso > a ? iso : a;
};

const notificationsRoutes: FastifyPluginAsync = async (app) => {
  // "Unread" = untouched (`new`) contact messages and inquiries; imported history never counts.
  app.get('/unread-count', async (request) => {
    const userId = request.authUser!.id;
    const isSuperAdmin =
      (request.authUser as unknown as { accessLevel?: string }).accessLevel === 'super_admin';

    const brands = await accessibleBrands(userId, isSuperAdmin);
    const byBrand = await Promise.all(
      brands.map(async (b) => {
        const { serviceInquiries: si, contactMessages: cm } = getTenantTables(b.schemaName);
        const [inquiryRows, [contacts]] = await Promise.all([
          db
            .select({
              channel: inquiryChannelSql(si.source),
              n: count(),
              latest: max(si.createdAt),
            })
            .from(si)
            .where(and(eq(si.status, 'new'), notImported(si.source)))
            .groupBy(sql`1`),
          db
            .select({ n: count(), latest: max(cm.createdAt) })
            .from(cm)
            .where(and(eq(cm.status, 'new'), notImported(cm.source))),
        ]);
        const channels = emptyChannels();
        let latestAt: string | null = laterIso(null, contacts?.latest);
        for (const r of inquiryRows) {
          channels[r.channel] = (channels[r.channel] ?? 0) + r.n;
          latestAt = laterIso(latestAt, r.latest);
        }
        const inquiry = channels.phone + channels.email + channels.web;
        const contact = contacts?.n ?? 0;
        return {
          slug: b.slug,
          name: b.name,
          count: inquiry + contact,
          inquiry,
          contact,
          channels,
          latestAt,
        };
      }),
    );

    const inquiryChannels = emptyChannels();
    let latestAt: string | null = null;
    for (const b of byBrand) {
      for (const c of Object.keys(inquiryChannels) as InquiryChannel[]) {
        inquiryChannels[c] += b.channels[c];
      }
      if (b.latestAt && (!latestAt || b.latestAt > latestAt)) latestAt = b.latestAt;
    }
    const inquiry = byBrand.reduce((s, b) => s + b.inquiry, 0);
    const contact = byBrand.reduce((s, b) => s + b.contact, 0);
    return {
      count: inquiry + contact,
      latestAt,
      byKind: { inquiry, contact },
      inquiryChannels,
      byBrand,
    };
  });

  const listQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(50).default(20),
    brand: z.string().min(1).max(63).optional(),
  });
  app.get('/', async (request) => {
    const { limit, brand } = listQuerySchema.parse(request.query);
    const userId = request.authUser!.id;
    const isSuperAdmin =
      (request.authUser as unknown as { accessLevel?: string }).accessLevel === 'super_admin';

    const brands = (await accessibleBrands(userId, isSuperAdmin)).filter(
      (b) => !brand || b.slug === brand,
    );
    if (brands.length === 0) return { items: [] };

    const perBrand = await Promise.all(
      brands.map(async (b) => {
        const { serviceInquiries: si, contactMessages: cm } = getTenantTables(b.schemaName);
        const [contacts, inquiries] = await Promise.all([
          db
            .select({
              id: cm.id,
              name: cm.name,
              email: cm.email,
              phone: cm.phone,
              subject: cm.subject,
              message: cm.message,
              createdAt: cm.createdAt,
            })
            .from(cm)
            .where(and(eq(cm.status, 'new'), notImported(cm.source)))
            .orderBy(desc(cm.createdAt), desc(cm.id))
            .limit(limit),
          db
            .select({
              id: si.id,
              name: si.name,
              email: si.email,
              phone: si.phone,
              service: si.service,
              callReason: si.callReason,
              message: si.message,
              source: si.source,
              createdAt: si.createdAt,
            })
            .from(si)
            .where(and(eq(si.status, 'new'), notImported(si.source)))
            .orderBy(desc(si.createdAt), desc(si.id))
            .limit(limit),
        ]);

        const items: Notification[] = [];
        for (const r of contacts) {
          items.push({
            id: `${b.slug}:contact:${r.id}`,
            kind: 'contact',
            companySlug: b.slug,
            companyName: b.name,
            rowId: r.id,
            title: senderLabel(r.name, r.phone, r.email),
            message: r.subject?.trim() || r.message.slice(0, 140),
            channel: null,
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
            title: senderLabel(r.name, r.phone, r.email),
            message: r.callReason?.trim() || r.service?.trim() || r.message.slice(0, 140),
            channel: inquiryChannelOf(r.source),
            createdAt: r.createdAt.toISOString(),
          });
        }
        return items;
      }),
    );

    const items = perBrand
      .flat()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, limit);

    return { items };
  });
};

export default notificationsRoutes;
