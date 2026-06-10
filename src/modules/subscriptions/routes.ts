import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { conflict, notFound, parseIntId } from '../../lib/http-errors.js';
import { getStripe, stripeConfigured } from '../../lib/stripe.js';

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
  status: z.enum(['active', 'paused', 'past_due', 'cancelled']).optional(),
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

  // Stripe is updated BEFORE the local row — a dashboard cancel must always stop billing.
  const LIFECYCLE: Record<
    'pause' | 'resume' | 'cancel',
    { from: string[]; to: 'paused' | 'active' | 'cancelled' }
  > = {
    pause: { from: ['active'], to: 'paused' },
    resume: { from: ['paused', 'past_due'], to: 'active' },
    cancel: { from: ['active', 'paused', 'past_due'], to: 'cancelled' },
  };

  async function syncStripeLifecycle(
    action: 'pause' | 'resume' | 'cancel',
    stripeSubscriptionId: string,
  ): Promise<void> {
    const stripe = getStripe();
    if (action === 'cancel') {
      await stripe.subscriptions.cancel(stripeSubscriptionId);
      return;
    }
    await stripe.subscriptions.update(stripeSubscriptionId, {
      pause_collection: action === 'pause' ? { behavior: 'void' } : null,
    });
  }

  for (const action of ['pause', 'resume', 'cancel'] as const) {
    const rule = LIFECYCLE[action];
    app.post(`/:id/${action}`, async (request, reply) => {
      const id = parseIntId((request.params as { id: string }).id);
      const { subscriptions } = request.company!.tables;
      const now = new Date();

      const [row] = await db.select().from(subscriptions).where(eq(subscriptions.id, id)).limit(1);
      if (!row) throw notFound('Subscription not found');
      if (!rule.from.includes(row.status)) {
        throw conflict(`Aktion "${action}" ist im Status "${row.status}" nicht möglich.`);
      }

      if (row.stripeSubscriptionId) {
        if (!stripeConfigured) {
          reply.code(503).send({ error: 'Stripe not configured on this server' });
          return;
        }
        try {
          await syncStripeLifecycle(action, row.stripeSubscriptionId);
        } catch (err) {
          const code = (err as { code?: string }).code;
          // Already cancelled at Stripe — just record the local cancel.
          if (!(action === 'cancel' && code === 'resource_missing')) {
            request.log.error(
              { err, subscriptionId: id, action },
              'Stripe subscription sync failed',
            );
            reply
              .code(502)
              .send({ error: 'Stripe-Synchronisation fehlgeschlagen — Aktion abgebrochen.' });
            return;
          }
        }
      }

      const set: Record<string, unknown> = { status: rule.to, updatedAt: now };
      if (rule.to === 'paused') set.pausedAt = now;
      if (rule.to === 'active') set.pausedAt = null;
      if (rule.to === 'cancelled') set.cancelledAt = now;

      // CAS on the validated status.
      const [updated] = await db
        .update(subscriptions)
        .set(set)
        .where(and(eq(subscriptions.id, id), eq(subscriptions.status, row.status)))
        .returning();
      if (!updated) {
        // The synchronous Stripe webhook may have already written the target
        // status — that's success, not a conflict.
        const [latest] = await db
          .select()
          .from(subscriptions)
          .where(eq(subscriptions.id, id))
          .limit(1);
        if (latest?.status === rule.to) {
          return { subscription: latest };
        }
        throw conflict('Abo wurde zwischenzeitlich geändert — bitte neu laden.');
      }
      return { subscription: updated };
    });
  }
};

export default subscriptionsAdminRoutes;
