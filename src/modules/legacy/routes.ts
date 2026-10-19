import type { FastifyPluginAsync } from 'fastify';
import { and, asc, count, desc, eq, max, min, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { notFound, parseIntId } from '../../lib/http-errors.js';

// "Altdaten": raw rows imported from a retired system, browsable and deletable by admins.

const listQuerySchema = z.object({
  source: z.string().min(1).max(32),
  table: z.string().min(1).max(96),
  q: z.string().trim().max(200).optional(),
  limit: z.coerce.number().int().min(1).max(200).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const searchQuerySchema = z.object({
  q: z.string().trim().min(2).max(200),
  limit: z.coerce.number().int().min(1).max(100).default(50),
  offset: z.coerce.number().int().min(0).max(1_000_000).default(0),
});

const bulkDeleteQuerySchema = z.object({
  source: z.string().min(1).max(32),
  table: z.string().min(1).max(96),
});

const PREVIEW_KEYS = [
  'name',
  'company',
  'email',
  'phone',
  'clientPhone',
  'partnerPhone',
  'title',
  'subject',
  'service',
  'status',
  'message',
  'description',
  'activity',
  'notification_type',
] as const;

/** One-line summary of a raw row for the list view. */
export function previewOf(data: Record<string, unknown>): string {
  const parts: string[] = [];
  for (const key of PREVIEW_KEYS) {
    const v = data[key];
    if (typeof v === 'string' && v.trim()) parts.push(v.trim());
    else if (typeof v === 'number') parts.push(String(v));
    if (parts.length >= 4) break;
  }
  return parts.join(' · ').replace(/\s+/g, ' ').slice(0, 160);
}

const escapeLike = (s: string) => s.replace(/[\\%_]/g, (c) => `\\${c}`);

export const legacyRecordsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', app.requireWriteAccess);
  // Raw personal data from the old system: admins only.
  app.addHook('preHandler', app.requireAccess('super_admin', 'admin'));

  app.get('/summary', async (request) => {
    const { legacyRecords: r } = request.company!.tables;
    const rows = await db
      .select({
        source: r.source,
        table: r.legacyTable,
        count: count(),
        firstAt: min(r.legacyCreatedAt),
        lastAt: max(r.legacyCreatedAt),
      })
      .from(r)
      .groupBy(r.source, r.legacyTable)
      .orderBy(asc(r.source), asc(r.legacyTable));
    return { tables: rows };
  });

  app.get('/', async (request) => {
    const { source, table, q, limit, offset } = listQuerySchema.parse(request.query);
    const { legacyRecords: r } = request.company!.tables;
    const where = and(
      eq(r.source, source),
      eq(r.legacyTable, table),
      q ? sql`${r.data}::text ILIKE ${`%${escapeLike(q)}%`}` : undefined,
    );
    const [rows, totals] = await Promise.all([
      db
        .select()
        .from(r)
        .where(where)
        .orderBy(sql`${r.legacyCreatedAt} desc nulls last`, desc(r.id))
        .limit(limit)
        .offset(offset),
      db.select({ total: count() }).from(r).where(where),
    ]);
    return {
      items: rows.map(({ data, ...row }) => ({ ...row, preview: previewOf(data) })),
      total: totals[0]?.total ?? 0,
    };
  });

  // Across every table; a seq scan over the raw rows, so it is an explicit search, not search-as-you-type.
  app.get('/search', async (request) => {
    const { q, limit, offset } = searchQuerySchema.parse(request.query);
    const { legacyRecords: r } = request.company!.tables;
    const rows = await db
      .select()
      .from(r)
      .where(sql`${r.data}::text ILIKE ${`%${escapeLike(q)}%`}`)
      .orderBy(sql`${r.legacyCreatedAt} desc nulls last`, desc(r.id))
      .limit(limit + 1)
      .offset(offset);
    const page = rows.slice(0, limit);
    return {
      items: page.map(({ data, ...row }) => ({ ...row, preview: previewOf(data) })),
      hasMore: rows.length > limit,
    };
  });

  app.get('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { legacyRecords: r } = request.company!.tables;
    const [row] = await db.select().from(r).where(eq(r.id, id)).limit(1);
    if (!row) throw notFound('Record not found');
    return { record: row };
  });

  app.delete('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { legacyRecords: r } = request.company!.tables;
    const deleted = await db.delete(r).where(eq(r.id, id)).returning({ id: r.id });
    if (deleted.length === 0) throw notFound('Record not found');
    return { ok: true };
  });

  // Deletes every row of one source table, e.g. all old chat messages.
  app.delete('/', async (request) => {
    const { source, table } = bulkDeleteQuerySchema.parse(request.query);
    const { legacyRecords: r } = request.company!.tables;
    const deleted = await db
      .delete(r)
      .where(and(eq(r.source, source), eq(r.legacyTable, table)))
      .returning({ id: r.id });
    return { deleted: deleted.length };
  });
};
