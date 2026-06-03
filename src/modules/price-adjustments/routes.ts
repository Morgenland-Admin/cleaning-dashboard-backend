import type { FastifyPluginAsync } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { notFound, parseIntId } from '../../lib/http-errors.js';

const createSchema = z.object({
  scope: z.enum(['global', 'service', 'zone']).default('global'),
  scopeKey: z.string().max(64).optional(),
  adjustmentPercent: z.number().min(-100).max(100),
  reason: z.string().max(2000).optional(),
  active: z.boolean().default(true),
  validFrom: z.string().datetime().optional(),
  validTo: z.string().datetime().optional(),
});

export const priceAdjustmentsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);

  app.get('/', async (request) => {
    const { priceAdjustments } = request.company!.tables;
    const q = z.object({ active: z.coerce.boolean().optional() }).parse(request.query);
    const rows = await db
      .select()
      .from(priceAdjustments)
      .where(q.active !== undefined ? eq(priceAdjustments.active, q.active) : undefined)
      .orderBy(desc(priceAdjustments.createdAt))
      .limit(200);
    return { adjustments: rows, note: 'Record-only — not applied to live quotes.' };
  });

  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { priceAdjustments } = request.company!.tables;
    const [row] = await db
      .insert(priceAdjustments)
      .values({
        scope: body.scope,
        scopeKey: body.scopeKey,
        adjustmentPercent: body.adjustmentPercent.toFixed(2),
        reason: body.reason,
        active: body.active,
        validFrom: body.validFrom ? new Date(body.validFrom) : null,
        validTo: body.validTo ? new Date(body.validTo) : null,
        createdByUserId: request.authUser!.id,
      })
      .returning();
    reply.code(201).send({ adjustment: row });
  });

  app.patch('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = z.object({ active: z.boolean() }).parse(request.body);
    const { priceAdjustments } = request.company!.tables;
    const [row] = await db
      .update(priceAdjustments)
      .set({ active: body.active })
      .where(eq(priceAdjustments.id, id))
      .returning();
    if (!row) throw notFound('Adjustment not found');
    return { adjustment: row };
  });
};

export default priceAdjustmentsAdminRoutes;
