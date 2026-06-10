import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { exportJobs, membership } from '../../db/schema/shared.js';
import { parseIntId } from '../../lib/http-errors.js';
import { s3Configured, signObjectDownload } from '../../lib/s3.js';

// Strict: a silently ignored filter key would produce a mislabelled full PII dump.
const filterSchema = z
  .object({
    createdFrom: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    createdTo: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/)
      .optional(),
    status: z.string().max(32).optional(),
  })
  .strict();

const createSchema = z.object({
  companySlug: z.string().min(1).max(63),
  kind: z.enum(['orders', 'inquiries', 'contacts', 'newsletter']),
  format: z.enum(['csv']).default('csv'),
  filter: filterSchema.default({}),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(50).default(20),
  cursor: z.string().optional(),
  status: z.enum(['pending', 'processing', 'done', 'failed', 'cancelled', 'all']).default('all'),
});

async function userBrandSlugs(userId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: membership.companySlug })
    .from(membership)
    .where(eq(membership.userId, userId));
  return rows.map((r) => r.slug);
}

export const exportsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAccess('super_admin', 'admin', 'manager'));

  app.post('/', async (request, reply) => {
    if (!s3Configured) {
      reply.code(503).send({ error: 'S3 not configured — exports are disabled' });
      return;
    }
    const body = createSchema.parse(request.body);
    const userId = request.authUser!.id;
    const brands = await userBrandSlugs(userId);
    if (!brands.includes(body.companySlug)) {
      reply.code(403).send({ error: 'No access to brand' });
      return;
    }
    const [row] = await db
      .insert(exportJobs)
      .values({
        companySlug: body.companySlug,
        requestedByUserId: userId,
        kind: body.kind,
        format: body.format,
        filter: body.filter,
        status: 'pending',
      })
      .returning();
    reply.code(202).send({ job: row });
  });

  app.get('/', async (request, reply) => {
    const q = listQuerySchema.parse(request.query);
    const userId = request.authUser!.id;
    const conds = [eq(exportJobs.requestedByUserId, userId)];
    if (q.status !== 'all') conds.push(eq(exportJobs.status, q.status));
    if (q.cursor) {
      const cur = decodeCursor(q.cursor);
      // Tuple predicate matching the (createdAt DESC, id DESC) ordering.
      if (cur) {
        const cw = or(
          lt(exportJobs.createdAt, sql`${cur.createdAt}::timestamptz`),
          and(
            sql`${exportJobs.createdAt} = ${cur.createdAt}::timestamptz`,
            lt(exportJobs.id, cur.id),
          ),
        );
        if (cw) conds.push(cw);
      }
    }
    const rows = await db
      .select()
      .from(exportJobs)
      .where(and(...conds))
      .orderBy(desc(exportJobs.createdAt), desc(exportJobs.id))
      .limit(q.limit + 1);
    const hasMore = rows.length > q.limit;
    const items = hasMore ? rows.slice(0, q.limit) : rows;
    const last = items[items.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ id: last.id, createdAt: last.createdAt.toISOString() })
        : null;
    reply.send({ items, nextCursor });
  });

  app.get('/:id', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const userId = request.authUser!.id;
    const [row] = await db
      .select()
      .from(exportJobs)
      .where(and(eq(exportJobs.id, id), eq(exportJobs.requestedByUserId, userId)))
      .limit(1);
    if (!row) {
      reply.code(404).send({ error: 'Export job not found' });
      return;
    }
    reply.send({ job: row });
  });

  app.get('/:id/download', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const userId = request.authUser!.id;
    const [row] = await db
      .select()
      .from(exportJobs)
      .where(and(eq(exportJobs.id, id), eq(exportJobs.requestedByUserId, userId)))
      .limit(1);
    if (!row) {
      reply.code(404).send({ error: 'Export job not found' });
      return;
    }
    if (row.status !== 'done' || !row.s3Key) {
      reply.code(409).send({ error: `Export is ${row.status}, not ready for download` });
      return;
    }
    if (row.expiresAt && row.expiresAt.getTime() < Date.now()) {
      reply.code(410).send({ error: 'Export expired' });
      return;
    }
    const { downloadUrl, expiresIn } = await signObjectDownload({
      key: row.s3Key,
      expiresIn: 60 * 5,
    });
    reply.send({ downloadUrl, expiresIn });
  });

  app.post('/:id/cancel', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const userId = request.authUser!.id;
    const [updated] = await db
      .update(exportJobs)
      .set({ status: 'cancelled', completedAt: new Date() })
      .where(
        and(
          eq(exportJobs.id, id),
          eq(exportJobs.requestedByUserId, userId),
          eq(exportJobs.status, 'pending'),
        ),
      )
      .returning();
    if (!updated) {
      reply.code(409).send({ error: 'Job not cancellable (already processing or done)' });
      return;
    }
    reply.send({ job: updated });
  });
};

export default exportsAdminRoutes;
