import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { notFound, parseIntId } from '../../lib/http-errors.js';

const createSchema = z.object({
  customerEmail: z.string().email().max(254),
  customerName: z.string().max(200).optional(),
  planName: z.string().min(1).max(120),
  monthlyPriceCents: z.number().int().min(0).max(10_000_000).default(0),
  intervalMonths: z.number().int().min(1).max(24).default(1),
  stripeSubscriptionId: z.string().max(255).optional(),
  servicesIncluded: z.array(z.string().max(120)).max(50).optional(),
  nextServiceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .optional(),
});

const updateSchema = z.object({
  planName: z.string().min(1).max(120).optional(),
  monthlyPriceCents: z.number().int().min(0).max(10_000_000).optional(),
  intervalMonths: z.number().int().min(1).max(24).optional(),
  stripeSubscriptionId: z.string().max(255).nullable().optional(),
  servicesIncluded: z.array(z.string().max(120)).max(50).optional(),
  nextServiceDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/)
    .nullable()
    .optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
  status: z.enum(['active', 'paused', 'cancelled']).optional(),
  email: z.string().email().optional(),
});

export const subscriptionsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);

  app.get('/', async (request) => {
    const { limit, cursor, status, email } = listQuerySchema.parse(request.query);
    const { subscriptions } = request.company!.tables;
    const decoded = cursor ? decodeCursor(cursor) : null;
    const conds = [];
    if (status) conds.push(eq(subscriptions.status, status));
    if (email) conds.push(eq(subscriptions.customerEmail, email));
    if (decoded) {
      const cw = or(
        lt(subscriptions.createdAt, sql`${decoded.createdAt}::timestamptz`),
        and(
          sql`${subscriptions.createdAt} = ${decoded.createdAt}::timestamptz`,
          lt(subscriptions.id, decoded.id),
        ),
      );
      if (cw) conds.push(cw);
    }
    const rows = await db
      .select()
      .from(subscriptions)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(subscriptions.createdAt), desc(subscriptions.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    return { subscriptions: page, nextCursor };
  });

  app.get('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { subscriptions } = request.company!.tables;
    const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
    if (!row) throw notFound('Subscription not found');
    return { subscription: row };
  });

  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { subscriptions } = request.company!.tables;
    const [row] = await db
      .insert(subscriptions)
      .values({
        customerEmail: body.customerEmail,
        customerName: body.customerName,
        planName: body.planName,
        monthlyPriceCents: body.monthlyPriceCents,
        intervalMonths: body.intervalMonths,
        stripeSubscriptionId: body.stripeSubscriptionId,
        servicesIncluded: body.servicesIncluded ?? [],
        nextServiceDate: body.nextServiceDate ?? null,
      })
      .returning();
    reply.code(201).send({ subscription: row });
  });

  app.patch('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = updateSchema.parse(request.body);
    const { subscriptions } = request.company!.tables;
    const [row] = await db
      .update(subscriptions)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(subscriptions.id, id))
      .returning();
    if (!row) throw notFound('Subscription not found');
    return { subscription: row };
  });

  for (const [action, patch] of [
    ['pause', { status: 'paused' as const, pausedAt: true }],
    ['resume', { status: 'active' as const, pausedAt: false }],
    ['cancel', { status: 'cancelled' as const, cancelledAt: true }],
  ] as const) {
    app.post(`/:id/${action}`, async (request) => {
      const id = parseIntId((request.params as { id: string }).id);
      const { subscriptions } = request.company!.tables;
      const now = new Date();
      const set: Record<string, unknown> = { status: patch.status, updatedAt: now };
      if ('pausedAt' in patch) set.pausedAt = patch.pausedAt ? now : null;
      if ('cancelledAt' in patch && patch.cancelledAt) set.cancelledAt = now;
      const [row] = await db
        .update(subscriptions)
        .set(set)
        .where(eq(subscriptions.id, id))
        .returning();
      if (!row) throw notFound('Subscription not found');
      return { subscription: row };
    });
  }
};

export default subscriptionsAdminRoutes;
