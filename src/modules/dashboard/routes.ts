import type { FastifyPluginAsync } from 'fastify';
import { and, count, desc, eq, inArray, sql, type SQL } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { company, membership, tasks } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';
import { isNonContactableEmail } from '../../email/service.js';
import { inquiryChannelSql, notImported, senderLabel } from '../../lib/inbox.js';

type BrandStats = {
  slug: string;
  name: string;
  newsletter: { confirmed: number; pending: number; unsubscribed: number };
  contact: { total: number; new: number; last7Days: number };
  inquiry: {
    total: number;
    openCount: number;
    last7Days: number;
    new: number;
    channels: { phone: number; email: number; web: number };
    humanCallbacks: number;
  };
  orders: { open: number; today: number; last7Days: number };
  invoices: { overdue: number; draft: number };
  partnerApplications: { new: number };
  chat: { unread: number };
  tasks: { open: number };
};

type ActivityKind = 'contact' | 'inquiry' | 'newsletter' | 'order';
type ActivityItem = {
  id: string;
  kind: ActivityKind;
  companySlug: string;
  companyName: string;
  rowId: number;
  title: string;
  subtitle: string | null;
  orderKind?: string;
  createdAt: string;
};

const CLOSED_ORDER_STATUSES = ['completed', 'cancelled', 'refunded'];
const RECENT_PER_BRAND = 8;

const countWhere = (cond: SQL) => sql<number>`count(*) filter (where ${cond})`.mapWith(Number);

const dashboardRoutes: FastifyPluginAsync = async (app) => {
  // Everything here ignores imported history (source `import_…`): it answers "what is new / open now".
  app.get('/summary', async (request) => {
    const userId = request.authUser!.id;
    const isSuperAdmin =
      (request.authUser as unknown as { accessLevel?: string }).accessLevel === 'super_admin';

    const accessibleCompanies = isSuperAdmin
      ? await db
          .select({ slug: company.slug, name: company.name, schemaName: company.schemaName })
          .from(company)
          .where(eq(company.isActive, true))
      : await db
          .select({ slug: company.slug, name: company.name, schemaName: company.schemaName })
          .from(membership)
          .innerJoin(company, eq(membership.companySlug, company.slug))
          .where(and(eq(membership.userId, userId), eq(company.isActive, true)));

    if (accessibleCompanies.length === 0) {
      return { brands: [], activity: [] };
    }

    const weekAgo = sql`now() - interval '7 days'`;
    const todayBerlin = sql`(now() at time zone 'Europe/Berlin')::date`;

    const taskRows = await db
      .select({ slug: tasks.companySlug, n: count() })
      .from(tasks)
      .where(
        and(
          inArray(
            tasks.companySlug,
            accessibleCompanies.map((c) => c.slug),
          ),
          eq(tasks.status, 'open'),
        ),
      )
      .groupBy(tasks.companySlug);
    const openTasks = new Map(taskRows.map((r) => [r.slug, r.n]));

    const brandStats: BrandStats[] = await Promise.all(
      accessibleCompanies.map(async (c) => {
        const t = getTenantTables(c.schemaName);
        const nl = t.newsletterSubscribers;
        const cm = t.contactMessages;
        const si = t.serviceInquiries;
        const o = t.orders;
        const orderOpen = sql`${o.status} not in (${sql.join(
          CLOSED_ORDER_STATUSES.map((st) => sql`${st}`),
          sql`, `,
        )})`;
        const [[news], [contacts], [inquiries], channelRows, [orders], [invoices], [apps], [chat]] =
          await Promise.all([
            db
              .select({
                confirmed: countWhere(sql`${nl.confirmed} and ${nl.unsubscribedAt} is null`),
                pending: countWhere(
                  sql`not ${nl.confirmed} and ${nl.unsubscribedAt} is null and ${notImported(nl.source)}`,
                ),
                unsubscribed: countWhere(sql`${nl.unsubscribedAt} is not null`),
              })
              .from(nl),
            db
              .select({
                total: count(),
                new: countWhere(sql`${cm.status} = 'new' and ${notImported(cm.source)}`),
                last7Days: countWhere(
                  sql`${cm.createdAt} >= ${weekAgo} and ${notImported(cm.source)}`,
                ),
              })
              .from(cm),
            db
              .select({
                total: count(),
                openCount: countWhere(
                  sql`${si.status} in ('new', 'in_review') and ${notImported(si.source)}`,
                ),
                last7Days: countWhere(
                  sql`${si.createdAt} >= ${weekAgo} and ${notImported(si.source)}`,
                ),
                humanCallbacks: countWhere(
                  sql`${si.status} = 'new' and ${si.callbackOwner} = 'human'`,
                ),
              })
              .from(si),
            db
              .select({ channel: inquiryChannelSql(si.source), n: count() })
              .from(si)
              .where(and(eq(si.status, 'new'), notImported(si.source)))
              .groupBy(sql`1`),
            db
              .select({
                open: countWhere(orderOpen),
                today: countWhere(sql`${orderOpen} and ${o.preferredDate} = ${todayBerlin}`),
                last7Days: countWhere(sql`${o.createdAt} >= ${weekAgo}`),
              })
              .from(o)
              .where(notImported(o.source)),
            db
              .select({
                overdue: countWhere(sql`${t.invoices.status} = 'overdue'`),
                draft: countWhere(sql`${t.invoices.status} = 'draft'`),
              })
              .from(t.invoices),
            db
              .select({ n: count() })
              .from(t.partnerApplications)
              .where(eq(t.partnerApplications.status, 'new')),
            db
              .select({
                unread:
                  sql<number>`coalesce(sum(${t.chatConversations.unreadForAdmin}), 0)`.mapWith(
                    Number,
                  ),
              })
              .from(t.chatConversations),
          ]);
        const channels = { phone: 0, email: 0, web: 0 };
        for (const r of channelRows) channels[r.channel] = (channels[r.channel] ?? 0) + r.n;
        return {
          slug: c.slug,
          name: c.name,
          newsletter: {
            confirmed: news?.confirmed ?? 0,
            pending: news?.pending ?? 0,
            unsubscribed: news?.unsubscribed ?? 0,
          },
          contact: {
            total: contacts?.total ?? 0,
            new: contacts?.new ?? 0,
            last7Days: contacts?.last7Days ?? 0,
          },
          inquiry: {
            total: inquiries?.total ?? 0,
            openCount: inquiries?.openCount ?? 0,
            last7Days: inquiries?.last7Days ?? 0,
            new: channels.phone + channels.email + channels.web,
            channels,
            humanCallbacks: inquiries?.humanCallbacks ?? 0,
          },
          orders: {
            open: orders?.open ?? 0,
            today: orders?.today ?? 0,
            last7Days: orders?.last7Days ?? 0,
          },
          invoices: { overdue: invoices?.overdue ?? 0, draft: invoices?.draft ?? 0 },
          partnerApplications: { new: apps?.n ?? 0 },
          chat: { unread: chat?.unread ?? 0 },
          tasks: { open: openTasks.get(c.slug) ?? 0 },
        };
      }),
    );

    const activityChunks = await Promise.all(
      accessibleCompanies.map(async (c) => {
        const t = getTenantTables(c.schemaName);
        const [contacts, inquiries, newsletter, orders] = await Promise.all([
          db
            .select({
              id: t.contactMessages.id,
              name: t.contactMessages.name,
              email: t.contactMessages.email,
              phone: t.contactMessages.phone,
              subject: t.contactMessages.subject,
              message: t.contactMessages.message,
              createdAt: t.contactMessages.createdAt,
            })
            .from(t.contactMessages)
            .where(notImported(t.contactMessages.source))
            .orderBy(desc(t.contactMessages.createdAt))
            .limit(RECENT_PER_BRAND),
          db
            .select({
              id: t.serviceInquiries.id,
              name: t.serviceInquiries.name,
              email: t.serviceInquiries.email,
              phone: t.serviceInquiries.phone,
              service: t.serviceInquiries.service,
              message: t.serviceInquiries.message,
              createdAt: t.serviceInquiries.createdAt,
            })
            .from(t.serviceInquiries)
            .where(notImported(t.serviceInquiries.source))
            .orderBy(desc(t.serviceInquiries.createdAt))
            .limit(RECENT_PER_BRAND),
          db
            .select({
              id: t.newsletterSubscribers.id,
              email: t.newsletterSubscribers.email,
              firstName: t.newsletterSubscribers.firstName,
              lastName: t.newsletterSubscribers.lastName,
              createdAt: t.newsletterSubscribers.createdAt,
            })
            .from(t.newsletterSubscribers)
            .where(notImported(t.newsletterSubscribers.source))
            .orderBy(desc(t.newsletterSubscribers.createdAt))
            .limit(RECENT_PER_BRAND),
          db
            .select({
              id: t.orders.id,
              orderNumber: t.orders.orderNumber,
              kind: t.orders.kind,
              customerName: t.orders.customerName,
              customerEmail: t.orders.customerEmail,
              customerPhone: t.orders.customerPhone,
              createdAt: t.orders.createdAt,
            })
            .from(t.orders)
            .where(notImported(t.orders.source))
            .orderBy(desc(t.orders.createdAt))
            .limit(RECENT_PER_BRAND),
        ]);

        const items: ActivityItem[] = [];
        const base = { companySlug: c.slug, companyName: c.name };
        for (const r of contacts) {
          items.push({
            ...base,
            id: `${c.slug}:contact:${r.id}`,
            kind: 'contact',
            rowId: r.id,
            title: senderLabel(r.name, r.phone, r.email),
            subtitle: r.subject?.trim() || r.message.slice(0, 120),
            createdAt: r.createdAt.toISOString(),
          });
        }
        for (const r of inquiries) {
          items.push({
            ...base,
            id: `${c.slug}:inquiry:${r.id}`,
            kind: 'inquiry',
            rowId: r.id,
            title: senderLabel(r.name, r.phone, r.email),
            subtitle: r.service?.trim() || r.message.slice(0, 120),
            createdAt: r.createdAt.toISOString(),
          });
        }
        for (const r of newsletter) {
          const name = [r.firstName, r.lastName].filter(Boolean).join(' ').trim();
          const email = isNonContactableEmail(r.email) ? '' : r.email;
          items.push({
            ...base,
            id: `${c.slug}:newsletter:${r.id}`,
            kind: 'newsletter',
            rowId: r.id,
            title: name || email,
            subtitle: name && email ? email : null,
            createdAt: r.createdAt.toISOString(),
          });
        }
        for (const r of orders) {
          items.push({
            ...base,
            id: `${c.slug}:order:${r.id}`,
            kind: 'order',
            rowId: r.id,
            title: senderLabel(r.customerName, r.customerPhone, r.customerEmail),
            subtitle: r.orderNumber,
            orderKind: r.kind,
            createdAt: r.createdAt.toISOString(),
          });
        }
        return items;
      }),
    );

    const activity = activityChunks
      .flat()
      .sort((a, b) => (a.createdAt < b.createdAt ? 1 : a.createdAt > b.createdAt ? -1 : 0))
      .slice(0, 60);

    return { brands: brandStats, activity };
  });
};

export default dashboardRoutes;
