import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  and,
  desc,
  eq,
  ilike,
  inArray,
  isNotNull,
  isNull,
  lt,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { company, emailLog, membership, user } from '../../db/schema/shared.js';
import { accessLevelOf } from '../../lib/access.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { notFound, parseIntId } from '../../lib/http-errors.js';

// Read side of email_log across brands. Scope: the caller's brands (all active for a super_admin);
// brandless platform mail (password reset) is super_admin only. Viewers may read; `seo` users are
// kept out by the admin allowlist.

const PROBLEM_DELIVERY = ['bounced', 'complained', 'failed', 'suppressed', 'delivery_delayed'];

const listQuerySchema = z.object({
  /** Brand slug, or "system" for platform mail. */
  brand: z.string().min(1).max(63).optional(),
  kind: z.string().min(1).max(32).optional(),
  status: z.enum(['delivered', 'opened', 'problem', 'not_sent']).optional(),
  q: z.string().trim().min(1).max(200).optional(),
  refType: z.enum(['order', 'invoice', 'inquiry', 'contact', 'task']).optional(),
  refId: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(500).optional(),
});

interface Scope {
  slugs: string[];
  system: boolean;
}

async function scopeOf(request: FastifyRequest): Promise<Scope> {
  if (accessLevelOf(request) === 'super_admin') {
    const rows = await db
      .select({ slug: company.slug })
      .from(company)
      .where(eq(company.isActive, true));
    return { slugs: rows.map((r) => r.slug), system: true };
  }
  const rows = await db
    .select({ slug: company.slug })
    .from(membership)
    .innerJoin(company, eq(membership.companySlug, company.slug))
    .where(and(eq(membership.userId, request.authUser!.id), eq(company.isActive, true)));
  return { slugs: rows.map((r) => r.slug), system: false };
}

function scopeWhere(scope: Scope): SQL | null {
  const parts: SQL[] = [];
  if (scope.slugs.length > 0) parts.push(inArray(emailLog.companySlug, scope.slugs));
  if (scope.system) parts.push(isNull(emailLog.companySlug));
  if (parts.length === 0) return null;
  return parts.length === 1 ? parts[0]! : or(...parts)!;
}

function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

const listColumns = {
  id: emailLog.id,
  companySlug: emailLog.companySlug,
  companyName: company.name,
  kind: emailLog.kind,
  toAddress: emailLog.toAddress,
  subject: emailLog.subject,
  status: emailLog.status,
  deliveryStatus: emailLog.deliveryStatus,
  deliveredAt: emailLog.deliveredAt,
  openedAt: emailLog.openedAt,
  clickedAt: emailLog.clickedAt,
  hasBody: sql<boolean>`${emailLog.html} IS NOT NULL`,
  attachmentCount: sql<number>`jsonb_array_length(${emailLog.attachments})::int`,
  refType: emailLog.refType,
  refId: emailLog.refId,
  createdAt: emailLog.createdAt,
};

const emailsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('admin'));

  app.get('/', async (request) => {
    const query = listQuerySchema.parse(request.query);
    const scope = await scopeOf(request);
    const visible = scopeWhere(scope);
    if (!visible) return { emails: [], nextCursor: null };

    const conds: SQL[] = [visible];
    if (query.brand === 'system') conds.push(isNull(emailLog.companySlug));
    else if (query.brand) conds.push(eq(emailLog.companySlug, query.brand));
    if (query.kind) conds.push(eq(emailLog.kind, query.kind));
    if (query.status === 'delivered') conds.push(eq(emailLog.deliveryStatus, 'delivered'));
    if (query.status === 'opened') conds.push(isNotNull(emailLog.openedAt));
    if (query.status === 'not_sent') conds.push(inArray(emailLog.status, ['skipped', 'blocked']));
    if (query.status === 'problem') {
      conds.push(
        or(eq(emailLog.status, 'failed'), inArray(emailLog.deliveryStatus, PROBLEM_DELIVERY))!,
      );
    }
    if (query.q) {
      const like = likeTerm(query.q);
      conds.push(or(ilike(emailLog.toAddress, like), ilike(emailLog.subject, like))!);
    }
    if (query.refType) conds.push(eq(emailLog.refType, query.refType));
    if (query.refId) conds.push(eq(emailLog.refId, query.refId));

    const decoded = query.cursor ? decodeCursor(query.cursor) : null;
    if (decoded) {
      conds.push(
        or(
          lt(emailLog.createdAt, sql`${decoded.createdAt}::timestamptz`),
          and(
            sql`${emailLog.createdAt} = ${decoded.createdAt}::timestamptz`,
            lt(emailLog.id, decoded.id),
          ),
        )!,
      );
    }

    const rows = await db
      .select(listColumns)
      .from(emailLog)
      .leftJoin(company, eq(emailLog.companySlug, company.slug))
      .where(and(...conds))
      .orderBy(desc(emailLog.createdAt), desc(emailLog.id))
      .limit(query.limit + 1);

    const hasMore = rows.length > query.limit;
    const page = hasMore ? rows.slice(0, query.limit) : rows;
    const last = page[page.length - 1];
    return {
      emails: page,
      nextCursor:
        hasMore && last
          ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
          : null,
    };
  });

  app.get('/tracking', async (request) => {
    const scope = await scopeOf(request);
    const rows =
      scope.slugs.length > 0
        ? await db
            .select({
              slug: company.slug,
              name: company.name,
              connected: sql<boolean>`${company.resendWebhookSecret} IS NOT NULL`,
            })
            .from(company)
            .where(inArray(company.slug, scope.slugs))
        : [];
    return {
      brands: rows,
      system: scope.system ? { connected: !!env.RESEND_WEBHOOK_SECRET } : null,
    };
  });

  app.get('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const scope = await scopeOf(request);
    const visible = scopeWhere(scope);
    if (!visible) throw notFound('E-Mail nicht gefunden');

    const [row] = await db
      .select({
        ...listColumns,
        fromAddress: emailLog.fromAddress,
        replyTo: emailLog.replyTo,
        html: emailLog.html,
        attachments: emailLog.attachments,
        error: emailLog.error,
        resendId: emailLog.resendId,
        events: emailLog.events,
        sentByName: user.name,
      })
      .from(emailLog)
      .leftJoin(company, eq(emailLog.companySlug, company.slug))
      .leftJoin(user, eq(emailLog.sentByUserId, user.id))
      .where(and(eq(emailLog.id, id), visible))
      .limit(1);
    if (!row) throw notFound('E-Mail nicht gefunden');
    return { email: row };
  });
};

export default emailsAdminRoutes;
