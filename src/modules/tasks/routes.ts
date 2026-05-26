import type { FastifyPluginAsync } from 'fastify';
import { and, asc, desc, eq, inArray, lt } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { parseIntId } from '../../lib/http-errors.js';
import { membership, taskComments, tasks, user } from '../../db/schema/shared.js';
import { notifyTaskAssigned, notifyTaskComment, spawnTask } from '../../lib/tasks.js';

const listQuerySchema = z.object({
  status: z.enum(['open', 'in_progress', 'done', 'dismissed', 'all']).default('open'),
  brand: z.string().min(1).max(63).optional(),
  /** When true, only the tasks assigned to me. */
  mine: z.coerce.boolean().default(false),
  limit: z.coerce.number().int().min(1).max(100).default(20),
  cursor: z.string().optional(),
});

const createSchema = z.object({
  companySlug: z.string().min(1).max(63),
  kind: z.string().min(1).max(64).default('ad_hoc'),
  title: z.string().min(1).max(500),
  body: z.string().max(8000).optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).default('normal'),
  assigneeUserId: z.string().optional(),
  dueAt: z.string().datetime().optional(),
});

const editSchema = z.object({
  title: z.string().min(1).max(500).optional(),
  body: z.string().max(8000).nullable().optional(),
  priority: z.enum(['low', 'normal', 'high', 'urgent']).optional(),
  /** Set to null to clear. */
  dueAt: z.string().datetime().nullable().optional(),
  /** Set to null to unassign. */
  assigneeUserId: z.string().nullable().optional(),
});

const commentSchema = z.object({
  body: z.string().trim().min(1).max(4000),
});

/** Brands the user is a member of — gates every list / mutation. */
async function userBrandSlugs(userId: string): Promise<string[]> {
  const rows = await db
    .select({ slug: membership.companySlug })
    .from(membership)
    .where(eq(membership.userId, userId));
  return rows.map((r) => r.slug);
}

export const tasksAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get('/', async (request, reply) => {
    const q = listQuerySchema.parse(request.query);
    const userId = request.authUser!.id;
    const userBrands = await userBrandSlugs(userId);
    if (userBrands.length === 0) {
      reply.send({ items: [], nextCursor: null });
      return;
    }

    const brandFilter = q.brand && userBrands.includes(q.brand) ? [q.brand] : userBrands;

    const conds = [inArray(tasks.companySlug, brandFilter)];
    if (q.status !== 'all') conds.push(eq(tasks.status, q.status));
    if (q.mine) conds.push(eq(tasks.assigneeUserId, userId));

    const cursor = q.cursor ? decodeCursor(q.cursor) : null;
    if (cursor) conds.push(lt(tasks.id, cursor.id));

    const rows = await db
      .select()
      .from(tasks)
      .where(and(...conds))
      .orderBy(desc(tasks.createdAt), desc(tasks.id))
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

  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const userId = request.authUser!.id;
    const userBrands = await userBrandSlugs(userId);
    if (!userBrands.includes(body.companySlug)) {
      reply.code(403).send({ error: 'No access to brand' });
      return;
    }
    const result = await spawnTask({
      companySlug: body.companySlug,
      kind: body.kind as never,
      title: body.title,
      body: body.body,
      priority: body.priority,
      assigneeUserId: body.assigneeUserId,
    });

    const [created] = await db.select().from(tasks).where(eq(tasks.id, result.id)).limit(1);

    if (created && body.assigneeUserId && body.assigneeUserId !== userId) {
      void notifyTaskAssigned({
        task: created,
        previousAssigneeUserId: null,
        triggeredByUserId: userId,
      }).catch(() => null);
    }

    reply.code(201).send({ task: created, created: result.created });
  });

  app.get('/summary', async (request, reply) => {
    const userId = request.authUser!.id;
    const brands = await userBrandSlugs(userId);
    if (brands.length === 0) {
      reply.send({ openByBrand: [], openTotal: 0 });
      return;
    }
    const rows = await db
      .select({ slug: tasks.companySlug })
      .from(tasks)
      .where(and(inArray(tasks.companySlug, brands), eq(tasks.status, 'open')));
    const counts = new Map<string, number>();
    for (const r of rows) counts.set(r.slug, (counts.get(r.slug) ?? 0) + 1);
    reply.send({
      openByBrand: Array.from(counts.entries()).map(([slug, count]) => ({
        slug,
        count,
      })),
      openTotal: rows.length,
    });
  });

  app.get('/members', async (request, reply) => {
    const q = z.object({ brand: z.string().min(1).max(63) }).parse(request.query);
    const userId = request.authUser!.id;
    const userBrands = await userBrandSlugs(userId);
    if (!userBrands.includes(q.brand)) {
      reply.code(403).send({ error: 'No access to brand' });
      return;
    }
    const rows = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        firstName: user.firstName,
        lastName: user.lastName,
        role: membership.role,
      })
      .from(membership)
      .innerJoin(user, eq(user.id, membership.userId))
      .where(eq(membership.companySlug, q.brand))
      .orderBy(asc(user.name));
    reply.send({ members: rows });
  });

  app.get('/:id', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const userId = request.authUser!.id;
    const brands = await userBrandSlugs(userId);
    const [row] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), inArray(tasks.companySlug, brands)))
      .limit(1);
    if (!row) {
      reply.code(404).send({ error: 'Task not found' });
      return;
    }

    const userIds = [row.assigneeUserId, row.resolvedByUserId].filter((v): v is string =>
      Boolean(v),
    );
    const users = userIds.length
      ? await db
          .select({ id: user.id, name: user.name, email: user.email })
          .from(user)
          .where(inArray(user.id, userIds))
      : [];
    const byId = new Map(users.map((u) => [u.id, u]));
    reply.send({
      task: row,
      assignee: row.assigneeUserId ? (byId.get(row.assigneeUserId) ?? null) : null,
      resolvedBy: row.resolvedByUserId ? (byId.get(row.resolvedByUserId) ?? null) : null,
    });
  });

  app.patch('/:id', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const userId = request.authUser!.id;
    const brands = await userBrandSlugs(userId);
    const body = editSchema.parse(request.body);

    const [existing] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), inArray(tasks.companySlug, brands)))
      .limit(1);
    if (!existing) {
      reply.code(404).send({ error: 'Task not found' });
      return;
    }

    if (body.assigneeUserId) {
      const [m] = await db
        .select()
        .from(membership)
        .where(
          and(
            eq(membership.userId, body.assigneeUserId),
            eq(membership.companySlug, existing.companySlug),
          ),
        )
        .limit(1);
      if (!m) {
        reply.code(400).send({
          error: 'Assignee is not a member of this brand',
        });
        return;
      }
    }

    const patch: Partial<typeof tasks.$inferInsert> = {
      updatedAt: new Date(),
    };
    if (body.title !== undefined) patch.title = body.title;
    if (body.body !== undefined) patch.body = body.body;
    if (body.priority !== undefined) patch.priority = body.priority;
    if (body.dueAt !== undefined) patch.dueAt = body.dueAt === null ? null : new Date(body.dueAt);
    if (body.assigneeUserId !== undefined) patch.assigneeUserId = body.assigneeUserId;

    const [updated] = await db.update(tasks).set(patch).where(eq(tasks.id, id)).returning();

    if (
      updated &&
      body.assigneeUserId !== undefined &&
      body.assigneeUserId &&
      body.assigneeUserId !== existing.assigneeUserId &&
      body.assigneeUserId !== userId
    ) {
      void notifyTaskAssigned({
        task: updated,
        previousAssigneeUserId: existing.assigneeUserId,
        triggeredByUserId: userId,
      }).catch(() => null);
    }

    reply.send({ task: updated });
  });

  app.post('/:id/ack', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const userId = request.authUser!.id;
    const brands = await userBrandSlugs(userId);
    const [updated] = await db
      .update(tasks)
      .set({
        status: 'in_progress',
        assigneeUserId: userId,
        updatedAt: new Date(),
      })
      .where(and(eq(tasks.id, id), inArray(tasks.companySlug, brands)))
      .returning();
    if (!updated) {
      reply.code(404).send({ error: 'Task not found' });
      return;
    }
    reply.send({ task: updated });
  });

  app.post('/:id/done', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const userId = request.authUser!.id;
    const brands = await userBrandSlugs(userId);
    const now = new Date();
    const [updated] = await db
      .update(tasks)
      .set({
        status: 'done',
        resolvedAt: now,
        resolvedByUserId: userId,
        updatedAt: now,
      })
      .where(and(eq(tasks.id, id), inArray(tasks.companySlug, brands)))
      .returning();
    if (!updated) {
      reply.code(404).send({ error: 'Task not found' });
      return;
    }
    reply.send({ task: updated });
  });

  app.post('/:id/dismiss', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const userId = request.authUser!.id;
    const brands = await userBrandSlugs(userId);
    const now = new Date();
    const [updated] = await db
      .update(tasks)
      .set({
        status: 'dismissed',
        resolvedAt: now,
        resolvedByUserId: userId,
        updatedAt: now,
      })
      .where(and(eq(tasks.id, id), inArray(tasks.companySlug, brands)))
      .returning();
    if (!updated) {
      reply.code(404).send({ error: 'Task not found' });
      return;
    }
    reply.send({ task: updated });
  });

  app.get('/:id/comments', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const userId = request.authUser!.id;
    const brands = await userBrandSlugs(userId);
    const [task] = await db
      .select({ id: tasks.id })
      .from(tasks)
      .where(and(eq(tasks.id, id), inArray(tasks.companySlug, brands)))
      .limit(1);
    if (!task) {
      reply.code(404).send({ error: 'Task not found' });
      return;
    }
    const rows = await db
      .select({
        id: taskComments.id,
        body: taskComments.body,
        createdAt: taskComments.createdAt,
        authorUserId: taskComments.authorUserId,
        authorName: user.name,
        authorEmail: user.email,
      })
      .from(taskComments)
      .leftJoin(user, eq(user.id, taskComments.authorUserId))
      .where(eq(taskComments.taskId, id))
      .orderBy(asc(taskComments.createdAt));
    reply.send({ comments: rows });
  });

  app.post('/:id/comments', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = commentSchema.parse(request.body);
    const userId = request.authUser!.id;
    const brands = await userBrandSlugs(userId);
    const [task] = await db
      .select()
      .from(tasks)
      .where(and(eq(tasks.id, id), inArray(tasks.companySlug, brands)))
      .limit(1);
    if (!task) {
      reply.code(404).send({ error: 'Task not found' });
      return;
    }
    const [inserted] = await db
      .insert(taskComments)
      .values({
        taskId: id,
        authorUserId: userId,
        body: body.body,
      })
      .returning();

    await db.update(tasks).set({ updatedAt: new Date() }).where(eq(tasks.id, id));

    if (task.assigneeUserId && task.assigneeUserId !== userId) {
      void notifyTaskComment({
        task,
        commentBody: body.body,
        triggeredByUserId: userId,
      }).catch(() => null);
    }

    reply.code(201).send({ comment: inserted });
  });
};

export default tasksAdminRoutes;
