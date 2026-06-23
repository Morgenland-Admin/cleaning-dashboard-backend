import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { and, count, desc, eq, gte, like } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { conflict, notFound, parseIntId } from '../../lib/http-errors.js';

const STATUSES = ['locked', 'soft_launch', 'active', 'scaling'] as const;

const createSchema = z.object({
  city: z.string().min(1).max(120),
  plzPrefix: z
    .string()
    .trim()
    .regex(/^\d{1,5}$/, 'plzPrefix must be 1–5 digits'),
  status: z.enum(STATUSES).default('locked'),
  seoPageGenerated: z.boolean().optional(),
  googleAdsActive: z.boolean().optional(),
  notes: z.string().max(2000).optional(),
});

const updateSchema = z.object({
  city: z.string().min(1).max(120).optional(),
  status: z.enum(STATUSES).optional(),
  seoPageGenerated: z.boolean().optional(),
  googleAdsActive: z.boolean().optional(),
  notes: z.string().max(2000).nullable().optional(),
});

export const cityStatusAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  // Reads stay open to any member; mutations need manager+.
  const requireManager = app.requireAccess('super_admin', 'admin', 'manager') as (
    request: FastifyRequest,
    reply: FastifyReply,
  ) => Promise<void>;
  app.addHook('preHandler', async (request, reply) => {
    if (request.method !== 'GET') await requireManager(request, reply);
  });

  app.get('/', async (request) => {
    const { cityStatus } = request.company!.tables;
    const q = z.object({ status: z.enum(STATUSES).optional() }).parse(request.query);
    const rows = await db
      .select()
      .from(cityStatus)
      .where(q.status ? eq(cityStatus.status, q.status) : undefined)
      .orderBy(desc(cityStatus.orderCount30d), cityStatus.city);
    return { cities: rows };
  });

  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { cityStatus } = request.company!.tables;
    const [existing] = await db
      .select({ id: cityStatus.id })
      .from(cityStatus)
      .where(eq(cityStatus.plzPrefix, body.plzPrefix))
      .limit(1);
    if (existing) throw conflict('A city with this PLZ prefix already exists');
    const [row] = await db
      .insert(cityStatus)
      .values({ ...body, lastStatusChange: new Date() })
      .returning();
    reply.code(201).send({ city: row });
  });

  app.patch('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = updateSchema.parse(request.body);
    const { cityStatus } = request.company!.tables;
    const set: Record<string, unknown> = { ...body, updatedAt: new Date() };
    if (body.status) set.lastStatusChange = new Date();
    const [row] = await db.update(cityStatus).set(set).where(eq(cityStatus.id, id)).returning();
    if (!row) throw notFound('City not found');
    return { city: row };
  });

  app.post('/:id/recompute', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { cityStatus, partners, orders } = request.company!.tables;
    const [row] = await db.select().from(cityStatus).where(eq(cityStatus.id, id)).limit(1);
    if (!row) throw notFound('City not found');
    const prefix = `${row.plzPrefix}%`;
    const thirtyDaysAgo = new Date(Date.now() - 30 * 24 * 60 * 60 * 1000);

    const [[partnerAgg], [activeAgg], [orderAgg]] = await Promise.all([
      db.select({ n: count() }).from(partners).where(like(partners.postalCode, prefix)),
      db
        .select({ n: count() })
        .from(partners)
        .where(and(like(partners.postalCode, prefix), eq(partners.status, 'active'))),
      db
        .select({ n: count() })
        .from(orders)
        .where(and(like(orders.pickupPlz, prefix), gte(orders.createdAt, thirtyDaysAgo))),
    ]);
    const partnerCount = partnerAgg?.n ?? 0;
    const activePartnerCount = activeAgg?.n ?? 0;
    const orderCount30d = orderAgg?.n ?? 0;
    const ordersPerPartner =
      activePartnerCount > 0 ? (orderCount30d / activePartnerCount).toFixed(2) : null;

    const [updated] = await db
      .update(cityStatus)
      .set({
        partnerCount,
        activePartnerCount,
        orderCount30d,
        ordersPerPartner,
        updatedAt: new Date(),
      })
      .where(eq(cityStatus.id, id))
      .returning();
    return { city: updated };
  });

  app.delete('/:id', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { cityStatus } = request.company!.tables;
    const [row] = await db.delete(cityStatus).where(eq(cityStatus.id, id)).returning();
    if (!row) throw notFound('City not found');
    reply.code(204).send();
  });
};

export default cityStatusAdminRoutes;
