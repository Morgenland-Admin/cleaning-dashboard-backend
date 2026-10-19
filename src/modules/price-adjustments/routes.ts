import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { encodeCursor, keysetAfter } from '../../lib/cursor.js';
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
  app.addHook('preHandler', app.requireWriteAccess);

  app.get('/', async (request) => {
    const { priceAdjustments } = request.company!.tables;
    // Not z.coerce.boolean() — "false" would coerce to true.
    const q = z
      .object({
        active: z
          .enum(['true', 'false'])
          .transform((v) => v === 'true')
          .optional(),
        limit: z.coerce.number().int().min(1).max(200).default(50),
        cursor: z.string().min(1).max(500).optional(),
      })
      .parse(request.query);
    const conds = [];
    if (q.active !== undefined) conds.push(eq(priceAdjustments.active, q.active));
    const after = keysetAfter(
      priceAdjustments,
      priceAdjustments.createdAt,
      priceAdjustments.id,
      q.cursor,
    );
    if (after) conds.push(after);
    const rows = await db
      .select()
      .from(priceAdjustments)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(priceAdjustments.createdAt), desc(priceAdjustments.id))
      .limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const page = hasMore ? rows.slice(0, q.limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    return { adjustments: page, nextCursor, note: 'Record-only — not applied to live quotes.' };
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
