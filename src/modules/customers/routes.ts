import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { notFound, parseIntId } from '../../lib/http-errors.js';
import { computeLoyaltyTier } from '../../lib/loyalty.js';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
  tier: z.enum(['neukunde', 'stammkunde', 'premium']).optional(),
  email: z.string().email().optional(),
});

const updateSchema = z.object({
  name: z.string().max(200).nullable().optional(),
  phone: z.string().max(32).nullable().optional(),
  loyaltyTier: z.enum(['neukunde', 'stammkunde', 'premium']).optional(),
  marketingOptIn: z.boolean().optional(),
});

export const customersAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', app.requireAccess('super_admin', 'admin', 'manager'));

  app.get('/', async (request) => {
    const { limit, cursor, tier, email } = listQuerySchema.parse(request.query);
    const { customers } = request.company!.tables;
    const decoded = cursor ? decodeCursor(cursor) : null;
    const conds = [];
    if (tier) conds.push(eq(customers.loyaltyTier, tier));
    if (email) conds.push(eq(customers.email, email));
    if (decoded) {
      const cw = or(
        lt(customers.createdAt, sql`${decoded.createdAt}::timestamptz`),
        and(
          sql`${customers.createdAt} = ${decoded.createdAt}::timestamptz`,
          lt(customers.id, decoded.id),
        ),
      );
      if (cw) conds.push(cw);
    }
    const rows = await db
      .select()
      .from(customers)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(customers.createdAt), desc(customers.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    return { customers: page, nextCursor };
  });

  app.get('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { customers } = request.company!.tables;
    const [row] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
    if (!row) throw notFound('Customer not found');
    return { customer: row };
  });

  app.patch('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = updateSchema.parse(request.body);
    const { customers } = request.company!.tables;
    const [row] = await db
      .update(customers)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(customers.id, id))
      .returning();
    if (!row) throw notFound('Customer not found');
    return { customer: row };
  });

  app.post('/:id/recompute-tier', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { customers } = request.company!.tables;
    const [row] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
    if (!row) throw notFound('Customer not found');
    const tier = computeLoyaltyTier(row.totalOrders, row.totalSpentCents);
    const [updated] = await db
      .update(customers)
      .set({ loyaltyTier: tier, updatedAt: new Date() })
      .where(eq(customers.id, id))
      .returning();
    return { customer: updated };
  });
};

export default customersAdminRoutes;
