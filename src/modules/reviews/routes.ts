import type { FastifyPluginAsync } from 'fastify';
import { and, avg, count, desc, eq, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { badRequest, notFound, parseIntId } from '../../lib/http-errors.js';

/** Recompute a partner's avg rating + count from published reviews only. */
async function recomputePartnerRating(tables: TenantTables, partnerId: number): Promise<void> {
  const [agg] = await db
    .select({ avgRating: avg(tables.reviews.rating), n: count() })
    .from(tables.reviews)
    .where(and(eq(tables.reviews.partnerId, partnerId), eq(tables.reviews.status, 'published')));
  const ratingCount = agg?.n ?? 0;
  const ratingStr = agg?.avgRating != null ? Number(agg.avgRating).toFixed(2) : null;
  await db
    .update(tables.partners)
    .set({ rating: ratingStr, ratingCount, updatedAt: new Date() })
    .where(eq(tables.partners.id, partnerId));
}

const createReviewSchema = z.object({
  orderToken: z.string().min(8).max(64),
  rating: z.number().int().min(1).max(5),
  comment: z.string().trim().max(4000).optional(),
  photos: z.array(z.string().url().max(500)).max(10).optional(),
});

const REVIEWABLE_STATUSES = ['delivered', 'completed'] as const;

export const reviewsPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  app.post(
    '/',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = createReviewSchema.parse(request.body);
      const { orders, reviews } = request.company!.tables;

      const [order] = await db
        .select()
        .from(orders)
        .where(eq(orders.publicToken, body.orderToken))
        .limit(1);
      if (
        !order ||
        !REVIEWABLE_STATUSES.includes(order.status as (typeof REVIEWABLE_STATUSES)[number])
      ) {
        reply.code(404).send({ error: 'No reviewable order for this token' });
        return;
      }

      const [existing] = await db
        .select({ id: reviews.id })
        .from(reviews)
        .where(eq(reviews.orderId, order.id))
        .limit(1);
      if (existing) {
        reply.code(409).send({ error: 'This order has already been reviewed' });
        return;
      }

      const partnerId = order.assignedPartnerId ?? null;
      const [row] = await db
        .insert(reviews)
        .values({
          orderId: order.id,
          partnerId,
          customerEmail: order.customerEmail,
          customerName: order.customerName,
          rating: body.rating,
          comment: body.comment ?? null,
          photos: body.photos ?? [],
          source: 'internal',
          status: 'new',
        })
        .returning();

      reply.code(201).send({
        review: {
          id: row!.id,
          rating: row!.rating,
          status: row!.status,
          createdAt: row!.createdAt,
        },
      });
    },
  );
};

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
  status: z.enum(['new', 'published', 'flagged', 'hidden']).optional(),
  // Not z.coerce.boolean() — "false" would coerce to true.
  flagged: z
    .enum(['true', 'false'])
    .transform((v) => v === 'true')
    .optional(),
});

export const reviewsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);

  app.get('/', async (request) => {
    const { limit, cursor, status, flagged } = listQuerySchema.parse(request.query);
    const { reviews } = request.company!.tables;
    const decoded = cursor ? decodeCursor(cursor) : null;
    const conds = [];
    if (status) conds.push(eq(reviews.status, status));
    if (flagged !== undefined) conds.push(eq(reviews.flagged, flagged));
    if (decoded) {
      const cw = or(
        lt(reviews.createdAt, sql`${decoded.createdAt}::timestamptz`),
        and(
          sql`${reviews.createdAt} = ${decoded.createdAt}::timestamptz`,
          lt(reviews.id, decoded.id),
        ),
      );
      if (cw) conds.push(cw);
    }
    const rows = await db
      .select()
      .from(reviews)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(reviews.createdAt), desc(reviews.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    return { reviews: page, nextCursor };
  });

  // Mutations need at least manager level — viewers stay read-only.
  const canModerate = { preHandler: app.requireAccess('super_admin', 'admin', 'manager') };

  const respondSchema = z.object({ response: z.string().trim().min(1).max(4000) });
  app.post('/:id/respond', canModerate, async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { response } = respondSchema.parse(request.body);
    const { reviews } = request.company!.tables;
    const [row] = await db
      .update(reviews)
      .set({
        partnerResponse: response,
        respondedAt: new Date(),
        status: 'published',
        updatedAt: new Date(),
      })
      .where(eq(reviews.id, id))
      .returning();
    if (!row) throw notFound('Review not found');
    if (row.partnerId) await recomputePartnerRating(request.company!.tables, row.partnerId);
    return { review: row };
  });

  const flagSchema = z.object({ reason: z.string().trim().min(1).max(1000) });
  app.post('/:id/flag', canModerate, async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { reason } = flagSchema.parse(request.body);
    const { reviews } = request.company!.tables;
    const [row] = await db
      .update(reviews)
      .set({ flagged: true, flagReason: reason, status: 'flagged', updatedAt: new Date() })
      .where(eq(reviews.id, id))
      .returning();
    if (!row) throw notFound('Review not found');
    if (row.partnerId) await recomputePartnerRating(request.company!.tables, row.partnerId);
    return { review: row };
  });

  const statusSchema = z.object({ status: z.enum(['new', 'published', 'flagged', 'hidden']) });
  app.patch('/:id', canModerate, async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { status } = statusSchema.parse(request.body);
    const { reviews } = request.company!.tables;
    const [row] = await db
      .update(reviews)
      .set({ status, flagged: status === 'flagged', updatedAt: new Date() })
      .where(eq(reviews.id, id))
      .returning();
    if (!row) throw notFound('Review not found');
    if (row.partnerId) await recomputePartnerRating(request.company!.tables, row.partnerId);
    return { review: row };
  });

  app.delete('/:id', canModerate, async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { reviews } = request.company!.tables;
    const [row] = await db.delete(reviews).where(eq(reviews.id, id)).returning();
    if (!row) throw badRequest('Review not found');
    if (row.partnerId) await recomputePartnerRating(request.company!.tables, row.partnerId);
    reply.code(204).send();
  });
};
