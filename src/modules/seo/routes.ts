import type { FastifyPluginAsync } from 'fastify';
import { and, asc, desc, eq, ilike, inArray, isNull, lt, ne, or, sql, type SQL } from 'drizzle-orm';
import type { PgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { env } from '../../config/env.js';
import { loadCompany } from '../../lib/company-loader.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { badRequest, conflict, HttpError, notFound, parseIntId } from '../../lib/http-errors.js';
import { sanitizeHtml } from '../../lib/sanitize-html.js';
import { publicPathsFor, revalidateStorefront } from '../../lib/storefront-revalidate.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import {
  blogMetaSchema,
  copyPath,
  escapeLike,
  likeTerm,
  missingForPublish,
  normalizeMeta,
  publicMeta,
  suggestPath,
  withoutPublishDates,
} from './blog.js';
import { ensureJsonLdDatePublished, setJsonLdImage, type JsonLd } from './jsonld.js';

const PATH_RE = /^[a-z0-9][a-z0-9/_-]{0,299}$/;

const jsonldSchema = z.union([z.record(z.unknown()), z.array(z.unknown())]).optional();
const faqSchema = z
  .array(z.object({ question: z.string().min(1).max(2000), answer: z.string().min(1).max(8000) }))
  .max(50)
  .optional();

const createSchema = z.object({
  type: z.enum(['service', 'city', 'blog']).default('service'),
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
  meta: blogMetaSchema.optional(),
  status: z.enum(['draft', 'live', 'protected']).default('draft'),
  gscPosition: z.number().min(0).max(1000).optional(),
  source: z.string().max(64).optional(),
});

const updateSchema = createSchema.partial().extend({
  // Optimistic concurrency: the updatedAt the client last saw; a mismatch is refused with 409 STALE.
  expectedUpdatedAt: z.string().datetime({ offset: true }).optional(),
});

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
  'meta',
] as const;

const PUBLIC_STATUSES = ['live', 'protected'] as const;

function isPublicStatus(status: string): boolean {
  return (PUBLIC_STATUSES as readonly string[]).includes(status);
}

function assertPublishable(row: { title?: string | null; bodyHtml?: string | null }) {
  const missing = missingForPublish({ title: row.title, bodyHtml: row.bodyHtml });
  if (missing.length > 0) {
    throw new HttpError(
      400,
      `A blog post needs ${missing.join(' and ')} before it can be published`,
      'NOT_READY',
    );
  }
}

type SeoPagesTable = TenantTables['seoPages'];

// Derived blog facts in SQL; JSON-LD may be one node or a @graph-style array, `lax` unwraps both.
function blogFacts(seoPages: SeoPagesTable) {
  const image = sql<string | null>`coalesce(
    jsonb_path_query_first(${seoPages.schemaJsonld}, 'lax $.image ? (@.type() == "string")') #>> '{}',
    jsonb_path_query_first(${seoPages.schemaJsonld}, 'lax $.image.url ? (@.type() == "string")') #>> '{}'
  )`;
  const datePublished = sql<
    string | null
  >`jsonb_path_query_first(${seoPages.schemaJsonld}, 'lax $.datePublished ? (@.type() == "string")') #>> '{}'`;
  const hasTitle = sql<boolean>`(coalesce(btrim(${seoPages.title}), '') <> '')`;
  const hasBody = sql<boolean>`(coalesce(btrim(regexp_replace(${seoPages.bodyHtml}, '<[^>]*>|&nbsp;', '', 'gi')), '') <> '')`;
  const needsAttention = sql<boolean>`(not ${hasTitle} or not ${hasBody} or ${image} is null)`;
  const noindex = sql<boolean>`coalesce((${seoPages.meta}->>'noindex')::boolean, false)`;
  return { image, datePublished, hasTitle, hasBody, needsAttention, noindex };
}

const postsQuerySchema = z.object({
  q: z.string().trim().max(200).optional(),
  status: z.enum(['draft', 'live', 'protected']).optional(),
  attention: z.enum(['1', 'true']).optional(),
  sort: z.enum(['updated', 'created', 'published', 'title']).default('updated'),
  offset: z.coerce.number().int().min(0).max(100_000).default(0),
  limit: z.coerce.number().int().min(1).max(100).default(25),
});

const checkPathSchema = z.object({
  path: z.string().trim().max(300),
  excludeId: z.coerce.number().int().positive().optional(),
});

async function pathsLike(seoPages: SeoPagesTable, path: string): Promise<Set<string>> {
  const rows = await db
    .select({ path: seoPages.path })
    .from(seoPages)
    .where(or(eq(seoPages.path, path), ilike(seoPages.path, `${escapeLike(path)}-%`)));
  return new Set(rows.map((r) => r.path));
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
  type: z.enum(['service', 'city', 'blog']).optional(),
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

  // Blog index: lean rows, search, sort, status/attention filters and tab counts in one call.
  app.get('/posts', async (request) => {
    const { q, status, attention, sort, offset, limit } = postsQuerySchema.parse(request.query);
    const { seoPages } = request.company!.tables;
    const facts = blogFacts(seoPages);

    const base: SQL[] = [eq(seoPages.type, 'blog')];
    if (q) {
      const like = likeTerm(q);
      base.push(
        or(
          ilike(seoPages.title, like),
          ilike(seoPages.path, like),
          ilike(seoPages.metaTitle, like),
          ilike(seoPages.metaDescription, like),
        )!,
      );
    }
    const filtered = [...base];
    if (status) filtered.push(eq(seoPages.status, status));
    if (attention) filtered.push(facts.needsAttention);

    const order =
      sort === 'title'
        ? [
            sql`lower(coalesce(nullif(btrim(${seoPages.title}), ''), ${seoPages.path})) asc`,
            asc(seoPages.id),
          ]
        : sort === 'created'
          ? [desc(seoPages.createdAt), desc(seoPages.id)]
          : sort === 'published'
            ? [sql`${facts.datePublished} desc nulls last`, desc(seoPages.id)]
            : [desc(seoPages.updatedAt), desc(seoPages.id)];

    const [rows, [totals], [counts]] = await Promise.all([
      db
        .select({
          id: seoPages.id,
          path: seoPages.path,
          title: seoPages.title,
          metaTitle: seoPages.metaTitle,
          metaDescription: seoPages.metaDescription,
          status: seoPages.status,
          gscPosition: seoPages.gscPosition,
          source: seoPages.source,
          createdAt: seoPages.createdAt,
          updatedAt: seoPages.updatedAt,
          image: facts.image,
          datePublished: facts.datePublished,
          hasTitle: facts.hasTitle,
          hasBody: facts.hasBody,
          noindex: facts.noindex,
        })
        .from(seoPages)
        .where(and(...filtered))
        .orderBy(...order)
        .limit(limit)
        .offset(offset),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(seoPages)
        .where(and(...filtered)),
      db
        .select({
          all: sql<number>`count(*)::int`,
          draft: sql<number>`(count(*) filter (where ${seoPages.status} = 'draft'))::int`,
          live: sql<number>`(count(*) filter (where ${seoPages.status} = 'live'))::int`,
          protected: sql<number>`(count(*) filter (where ${seoPages.status} = 'protected'))::int`,
          attention: sql<number>`(count(*) filter (where ${facts.needsAttention}))::int`,
        })
        .from(seoPages)
        .where(and(...base)),
    ]);
    return { posts: rows, total: totals?.total ?? 0, counts };
  });

  // Live duplicate-slug check for the editor; suggests the next free "-2", "-3", ….
  app.get('/check-path', async (request) => {
    const { path, excludeId } = checkPathSchema.parse(request.query);
    if (!PATH_RE.test(path)) return { valid: false, available: false, suggestion: null };
    const { seoPages } = request.company!.tables;
    const [clash] = await db
      .select({ id: seoPages.id })
      .from(seoPages)
      .where(
        excludeId
          ? and(eq(seoPages.path, path), ne(seoPages.id, excludeId))
          : eq(seoPages.path, path),
      )
      .limit(1);
    if (!clash) return { valid: true, available: true, suggestion: null };
    return {
      valid: true,
      available: false,
      suggestion: suggestPath(path, await pathsLike(seoPages, path)),
    };
  });

  app.get('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { seoPages } = request.company!.tables;
    const [row] = await db.select().from(seoPages).where(eq(seoPages.id, id)).limit(1);
    if (!row) throw notFound('SEO page not found');
    return { page: row };
  });

  // Mutations: manager+ or the dedicated `seo` level (blog writers); viewers stay read-only.
  const canEdit = { preHandler: app.requireAccess('super_admin', 'admin', 'manager', 'seo') };

  app.post('/', canEdit, async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { seoPages } = request.company!.tables;
    if (body.type === 'blog' && isPublicStatus(body.status)) assertPublishable(body);
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
        bodyHtml: body.bodyHtml != null ? sanitizeHtml(body.bodyHtml) : body.bodyHtml,
        schemaJsonld: body.schemaJsonld ?? null,
        faq: body.faq ?? [],
        meta: body.meta ? normalizeMeta(body.meta) : {},
        status: body.status,
        gscPosition: body.gscPosition != null ? body.gscPosition.toFixed(2) : null,
        source: body.source,
      })
      .returning();
    if (row && isPublicStatus(row.status)) {
      void revalidateStorefront(request.company!.slug, publicPathsFor(row), request.log);
    }
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
      bodyHtml: p.bodyHtml != null ? sanitizeHtml(p.bodyHtml) : p.bodyHtml,
      schemaJsonld: p.schemaJsonld ?? null,
      faq: p.faq ?? [],
      meta: p.meta ? normalizeMeta(p.meta) : {},
      status: p.status,
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

  // PUBLISHING RULE: content overwrites are refused (409) on a protected page (status=protected or gsc_position <= 5);
  // status / gscPosition / source may still change so a human can un-protect.
  app.patch('/:id', canEdit, async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = updateSchema.parse(request.body);
    const { seoPages } = request.company!.tables;

    const [current] = await db.select().from(seoPages).where(eq(seoPages.id, id)).limit(1);
    if (!current) throw notFound('SEO page not found');

    const stale = () =>
      reply.code(409).send({
        error: 'This post was changed elsewhere since it was opened.',
        code: 'STALE',
        updatedAt: current.updatedAt,
      });
    if (
      body.expectedUpdatedAt &&
      new Date(body.expectedUpdatedAt).getTime() !== current.updatedAt.getTime()
    ) {
      stale();
      return;
    }

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
    if (typeof patch.bodyHtml === 'string') patch.bodyHtml = sanitizeHtml(patch.bodyHtml);
    if (body.schemaJsonld !== undefined) patch.schemaJsonld = body.schemaJsonld;
    if (body.faq !== undefined) patch.faq = body.faq;
    if (body.meta !== undefined) patch.meta = normalizeMeta(body.meta);
    if (body.gscPosition !== undefined) patch.gscPosition = body.gscPosition.toFixed(2);

    // First publish of a blog post without a date stamps it now, not the draft's insert time.
    const wasPublic = isPublicStatus(current.status);
    const nextType = body.type ?? current.type;
    const willBePublic = isPublicStatus(body.status ?? current.status);
    if (
      nextType === 'blog' &&
      willBePublic &&
      (body.status !== undefined || body.title !== undefined || body.bodyHtml !== undefined)
    ) {
      assertPublishable({
        title: body.title ?? current.title,
        bodyHtml: body.bodyHtml ?? current.bodyHtml,
      });
    }
    if (nextType === 'blog' && body.status && isPublicStatus(body.status) && !wasPublic) {
      const base = (patch.schemaJsonld as JsonLd | null | undefined) ?? current.schemaJsonld;
      const stamped = ensureJsonLdDatePublished(base ?? null, new Date().toISOString());
      if (stamped) patch.schemaJsonld = stamped;
    }

    // Conditional on the version the client saw, so a concurrent save between read and write still loses.
    const [row] = await db
      .update(seoPages)
      .set(patch)
      .where(
        body.expectedUpdatedAt
          ? and(
              eq(seoPages.id, id),
              sql`date_trunc('milliseconds', ${seoPages.updatedAt}) = ${body.expectedUpdatedAt}::timestamptz`,
            )
          : eq(seoPages.id, id),
      )
      .returning();
    if (!row) {
      stale();
      return;
    }
    if (wasPublic || isPublicStatus(row.status)) {
      // Old paths too: a slug change or unpublish must drop the previous URL.
      void revalidateStorefront(
        request.company!.slug,
        [...publicPathsFor(current), ...publicPathsFor(row)],
        request.log,
      );
    }
    return { page: row };
  });

  // Merges a public image URL into the page's JSON-LD (article hero). Additive, so allowed on protected pages.
  const featuredImageSchema = z.object({ imageUrl: z.string().url().max(2000) });
  app.patch('/:id/featured-image', canEdit, async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { imageUrl } = featuredImageSchema.parse(request.body);
    const { seoPages } = request.company!.tables;
    const [current] = await db.select().from(seoPages).where(eq(seoPages.id, id)).limit(1);
    if (!current) throw notFound('SEO page not found');
    const schemaJsonld = setJsonLdImage(current.schemaJsonld ?? null, imageUrl);
    const [row] = await db
      .update(seoPages)
      .set({ schemaJsonld, updatedAt: new Date() })
      .where(eq(seoPages.id, id))
      .returning();
    if (row && isPublicStatus(row.status)) {
      void revalidateStorefront(request.company!.slug, publicPathsFor(row), request.log);
    }
    return { page: row };
  });

  // Copies a post into a new draft ("… (Kopie)" at the next free "-kopie" path).
  app.post('/:id/duplicate', canEdit, async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { seoPages } = request.company!.tables;
    const [src] = await db.select().from(seoPages).where(eq(seoPages.id, id)).limit(1);
    if (!src) throw notFound('SEO page not found');
    const base = src.path.replace(/-kopie(?:-\d+)?$/, '');
    const path = copyPath(src.path, await pathsLike(seoPages, `${base}-kopie`));
    try {
      const [row] = await db
        .insert(seoPages)
        .values({
          type: src.type,
          path,
          category: src.category,
          city: src.city,
          region: src.region,
          title: src.title ? `${src.title} (Kopie)`.slice(0, 300) : null,
          metaTitle: src.metaTitle,
          metaDescription: src.metaDescription,
          h1: src.h1,
          bodyHtml: src.bodyHtml,
          schemaJsonld: withoutPublishDates(src.schemaJsonld ?? null),
          faq: src.faq,
          meta: src.meta,
          status: 'draft',
          source: 'dashboard',
        })
        .returning();
      reply.code(201).send({ page: row });
    } catch (err) {
      if ((err as { code?: string }).code === '23505')
        throw conflict('Copy path already taken, try again');
      throw err;
    }
  });

  app.delete('/:id', canEdit, async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { seoPages } = request.company!.tables;
    const [row] = await db.delete(seoPages).where(eq(seoPages.id, id)).returning();
    if (!row) throw notFound('SEO page not found');
    if (isPublicStatus(row.status)) {
      void revalidateStorefront(request.company!.slug, publicPathsFor(row), request.log);
    }
    reply.code(204).send();
  });
};

// Overlay rows: the page already exists as a fixed storefront route (e.g. HTR /leistungen/<slug>) and the
// seo_pages row only supplies patchable text. Never publish them under /seo/<path>: the storefront owns
// the canonical URL and sitemap.
const OVERLAY_CATEGORY = 'leistung';

function notOverlay(seoPages: { category: PgColumn }) {
  return or(isNull(seoPages.category), ne(seoPages.category, OVERLAY_CATEGORY))!;
}

function escapeXml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&apos;');
}

const publicListQuerySchema = z.object({
  type: z.enum(['service', 'city', 'blog']).optional(),
});

export const seoPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  app.get('/', async (request) => {
    const { type } = publicListQuerySchema.parse(request.query);
    const { seoPages } = request.company!.tables;
    // Overlay rows are excluded: not standalone /seo/ URLs, so never prerendered or listed in a sitemap.
    const conds = [inArray(seoPages.status, [...PUBLIC_STATUSES]), notOverlay(seoPages)];
    if (type) conds.push(eq(seoPages.type, type));

    if (type) {
      const rows = await db
        .select({
          path: seoPages.path,
          type: seoPages.type,
          title: seoPages.title,
          metaTitle: seoPages.metaTitle,
          metaDescription: seoPages.metaDescription,
          h1: seoPages.h1,
          schemaJsonld: seoPages.schemaJsonld,
          meta: seoPages.meta,
          createdAt: seoPages.createdAt,
          updatedAt: seoPages.updatedAt,
        })
        .from(seoPages)
        .where(and(...conds))
        .orderBy(desc(seoPages.createdAt), desc(seoPages.id));
      return { pages: rows.map((r) => ({ ...r, meta: publicMeta(r.meta) })) };
    }
    const rows = await db
      .select({ path: seoPages.path, type: seoPages.type, updatedAt: seoPages.updatedAt })
      .from(seoPages)
      .where(and(...conds))
      .orderBy(asc(seoPages.path));
    return { pages: rows };
  });

  // Brand-aware sitemap for the storefront's /sitemap.xml; absolute URLs use the brand's storefrontOrigin.
  app.get('/sitemap.xml', async (request, reply) => {
    const { seoPages } = request.company!.tables;
    const companyRow = await loadCompany(request.company!.slug);
    const origin = (companyRow?.storefrontOrigin ?? env.APP_BASE_URL).replace(/\/$/, '');
    // Sitemaps cap at 50k URLs: cap the query and log when hit.
    const SITEMAP_MAX = 50_000;
    const rows = await db
      .select({ path: seoPages.path, type: seoPages.type, updatedAt: seoPages.updatedAt })
      .from(seoPages)
      .where(
        and(
          inArray(seoPages.status, [...PUBLIC_STATUSES]),
          notOverlay(seoPages),
          sql`not ${blogFacts(seoPages).noindex}`,
        ),
      )
      .orderBy(asc(seoPages.path))
      .limit(SITEMAP_MAX + 1);
    if (rows.length > SITEMAP_MAX) {
      request.log.warn(
        { company: request.company!.slug },
        `SEO sitemap exceeds ${SITEMAP_MAX} URLs — truncated; split into a sitemap index.`,
      );
      rows.length = SITEMAP_MAX;
    }
    const urls = rows
      .map((r) => {
        // Blog paths already carry the "blog/" prefix; service/city render under /seo/.
        const publicPath = r.type === 'blog' ? r.path : `seo/${r.path}`;
        const loc = escapeXml(`${origin}/${publicPath}`);
        const lastmod = r.updatedAt.toISOString().slice(0, 10);
        return `  <url>\n    <loc>${loc}</loc>\n    <lastmod>${lastmod}</lastmod>\n  </url>`;
      })
      .join('\n');
    const xml = `<?xml version="1.0" encoding="UTF-8"?>\n<urlset xmlns="http://www.sitemaps.org/schemas/sitemap/0.9">\n${urls}\n</urlset>\n`;
    reply
      .header('content-type', 'application/xml; charset=utf-8')
      .header('cache-control', 'public, max-age=3600')
      .send(xml);
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
        meta: seoPages.meta,
        createdAt: seoPages.createdAt,
        updatedAt: seoPages.updatedAt,
      })
      .from(seoPages)
      .where(and(eq(seoPages.path, path), inArray(seoPages.status, [...PUBLIC_STATUSES])))
      .limit(1);
    if (!page) {
      reply.code(404).send({ error: 'Page not found' });
      return;
    }
    reply.send({ page: { ...page, meta: publicMeta(page.meta) } });
  });
};
