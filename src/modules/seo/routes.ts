import type { FastifyPluginAsync } from 'fastify';
import { and, asc, desc, eq, inArray, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { badRequest, conflict, notFound, parseIntId } from '../../lib/http-errors.js';

const PATH_RE = /^[a-z0-9][a-z0-9/_-]{0,299}$/;

const jsonldSchema = z.union([z.record(z.unknown()), z.array(z.unknown())]).optional();
const faqSchema = z
  .array(z.object({ question: z.string().min(1).max(2000), answer: z.string().min(1).max(8000) }))
  .max(50)
  .optional();

const createSchema = z.object({
  type: z.enum(['service', 'city']).default('service'),
  path: z.string().trim().regex(PATH_RE, 'path must be a lowercase slug, optionally with "/"'),
  category: z.string().max(64).optional(),
  city: z.string().max(120).optional(),
  region: z.string().max(120).optional(),
  title: z.string().max(300).optional(),
  metaTitle: z.string().max(300).optional(),
  metaDescription: z.string().max(500).optional(),
  h1: z.string().max(300).optional(),
  bodyHtml: z.string().max(200_000).optional(),
  schemaJsonld: jsonldSchema,
  faq: faqSchema,
  status: z.enum(['draft', 'live', 'protected']).default('draft'),
  gscPosition: z.number().min(0).max(1000).optional(),
  source: z.string().max(64).optional(),
});

const updateSchema = createSchema.partial();

const CONTENT_FIELDS = [
  'type',
  'path',
  'city',
  'region',
  'title',
  'metaTitle',
  'metaDescription',
  'h1',
  'bodyHtml',
  'schemaJsonld',
  'faq',
] as const;

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
  type: z.enum(['service', 'city']).optional(),
  status: z.enum(['draft', 'live', 'protected']).optional(),
  category: z.string().max(64).optional(),
});

export const seoAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);

  app.get('/', async (request) => {
    const { limit, cursor, type, status, category } = listQuerySchema.parse(request.query);
    const { seoPages } = request.company!.tables;
    const decoded = cursor ? decodeCursor(cursor) : null;
    const conds = [];
    if (type) conds.push(eq(seoPages.type, type));
    if (status) conds.push(eq(seoPages.status, status));
    if (category) conds.push(eq(seoPages.category, category));
    if (decoded) {
      const cw = or(
        lt(seoPages.createdAt, sql`${decoded.createdAt}::timestamptz`),
        and(
          sql`${seoPages.createdAt} = ${decoded.createdAt}::timestamptz`,
          lt(seoPages.id, decoded.id),
        ),
      );
      if (cw) conds.push(cw);
    }
    const rows = await db
      .select()
      .from(seoPages)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(seoPages.createdAt), desc(seoPages.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    return { pages: page, nextCursor };
  });

  app.get('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { seoPages } = request.company!.tables;
    const [row] = await db.select().from(seoPages).where(eq(seoPages.id, id)).limit(1);
    if (!row) throw notFound('SEO page not found');
    return { page: row };
  });

  // Mutations need at least manager level — viewers stay read-only.
  const canEdit = { preHandler: app.requireAccess('super_admin', 'admin', 'manager') };

  app.post('/', canEdit, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { seoPages } = request.company!.tables;
    const [existing] = await db
      .select({ id: seoPages.id })
      .from(seoPages)
      .where(eq(seoPages.path, body.path))
      .limit(1);
    if (existing) throw conflict('A page with this path already exists');
    const [row] = await db
      .insert(seoPages)
      .values({
        type: body.type,
        path: body.path,
        category: body.category,
        city: body.city,
        region: body.region,
        title: body.title,
        metaTitle: body.metaTitle,
        metaDescription: body.metaDescription,
        h1: body.h1,
        bodyHtml: body.bodyHtml,
        schemaJsonld: body.schemaJsonld ?? null,
        faq: body.faq ?? [],
        status: body.status,
        gscPosition: body.gscPosition != null ? body.gscPosition.toFixed(2) : null,
        source: body.source,
      })
      .returning();
    reply.code(201).send({ page: row });
  });

  const bulkSchema = z.object({ pages: z.array(createSchema).min(1).max(2000) });
  app.post('/bulk', { bodyLimit: 8 * 1024 * 1024, ...canEdit }, async (request, reply) => {
    const { pages } = bulkSchema.parse(request.body);
    const { seoPages } = request.company!.tables;
    const rows = pages.map((p) => ({
      type: p.type,
      path: p.path,
      category: p.category,
      city: p.city,
      region: p.region,
      title: p.title,
      metaTitle: p.metaTitle,
      metaDescription: p.metaDescription,
      h1: p.h1,
      bodyHtml: p.bodyHtml,
      schemaJsonld: p.schemaJsonld ?? null,
      faq: p.faq ?? [],
      status: p.status, // defaults to 'draft'
      gscPosition: p.gscPosition != null ? p.gscPosition.toFixed(2) : null,
      source: p.source,
    }));
    let inserted = 0;
    const BATCH = 500;
    for (let i = 0; i < rows.length; i += BATCH) {
      const chunk = rows.slice(i, i + BATCH);
      const res = await db
        .insert(seoPages)
        .values(chunk)
        .onConflictDoNothing({ target: seoPages.path })
        .returning({ id: seoPages.id });
      inserted += res.length;
    }
    reply.code(201).send({ total: pages.length, inserted, skipped: pages.length - inserted });
  });

  /**
   * PUBLISHING RULE: refuse content overwrites on a protected page (status=protected
   * or gsc_position <= 5). status / gscPosition / source may still change (so a human
   * can un-protect). Automated jobs get a 409 and should file a suggestion instead.
   */
  app.patch('/:id', canEdit, async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = updateSchema.parse(request.body);
    const { seoPages } = request.company!.tables;

    const [current] = await db.select().from(seoPages).where(eq(seoPages.id, id)).limit(1);
    if (!current) throw notFound('SEO page not found');

    const isProtected =
      current.status === 'protected' ||
      (current.gscPosition != null && Number(current.gscPosition) <= 5);
    const touchesContent = CONTENT_FIELDS.some((f) => body[f] !== undefined);
    if (isProtected && touchesContent) {
      reply.code(409).send({
        error:
          'Page is protected (status=protected or top-5 ranking) — content overwrite refused. Send a suggestion instead; only status/gscPosition may change.',
        code: 'PROTECTED',
      });
      return;
    }

    if (body.path && body.path !== current.path) {
      if (!PATH_RE.test(body.path)) throw badRequest('Invalid path');
      const [clash] = await db
        .select({ id: seoPages.id })
        .from(seoPages)
        .where(eq(seoPages.path, body.path))
        .limit(1);
      if (clash) throw conflict('Another page already uses this path');
    }

    const patch: Record<string, unknown> = { updatedAt: new Date() };
    for (const k of [
      'type',
      'path',
      'category',
      'city',
      'region',
      'title',
      'metaTitle',
      'metaDescription',
      'h1',
      'bodyHtml',
      'status',
      'source',
    ] as const) {
      if (body[k] !== undefined) patch[k] = body[k];
    }
    if (body.schemaJsonld !== undefined) patch.schemaJsonld = body.schemaJsonld;
    if (body.faq !== undefined) patch.faq = body.faq;
    if (body.gscPosition !== undefined) patch.gscPosition = body.gscPosition.toFixed(2);

    const [row] = await db.update(seoPages).set(patch).where(eq(seoPages.id, id)).returning();
    return { page: row };
  });

  app.delete('/:id', canEdit, async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { seoPages } = request.company!.tables;
    const [row] = await db.delete(seoPages).where(eq(seoPages.id, id)).returning();
    if (!row) throw notFound('SEO page not found');
    reply.code(204).send();
  });
};

const PUBLIC_STATUSES = ['live', 'protected'] as const;

export const seoPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  app.get('/', async (request) => {
    const { seoPages } = request.company!.tables;
    const rows = await db
      .select({ path: seoPages.path, type: seoPages.type, updatedAt: seoPages.updatedAt })
      .from(seoPages)
      .where(inArray(seoPages.status, [...PUBLIC_STATUSES]))
      .orderBy(asc(seoPages.path));
    return { pages: rows };
  });

  app.get('/*', async (request, reply) => {
    const rawPath = (request.params as Record<string, string>)['*'] ?? '';
    const path = rawPath.replace(/^\/+|\/+$/g, '');
    if (!path) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }
    const { seoPages } = request.company!.tables;

    const [page] = await db
      .select({
        type: seoPages.type,
        path: seoPages.path,
        category: seoPages.category,
        city: seoPages.city,
        region: seoPages.region,
        title: seoPages.title,
        metaTitle: seoPages.metaTitle,
        metaDescription: seoPages.metaDescription,
        h1: seoPages.h1,
        bodyHtml: seoPages.bodyHtml,
        schemaJsonld: seoPages.schemaJsonld,
        faq: seoPages.faq,
        updatedAt: seoPages.updatedAt,
      })
      .from(seoPages)
      .where(and(eq(seoPages.path, path), inArray(seoPages.status, [...PUBLIC_STATUSES])))
      .limit(1);
    if (!page) {
      reply.code(404).send({ error: 'Page not found' });
      return;
    }
    reply.send({ page });
  });
};
