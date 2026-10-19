import type { FastifyPluginAsync } from 'fastify';
import { asc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { badRequest, conflict, notFound, parseIntId } from '../../lib/http-errors.js';

const SLUG_RE = /^[a-z0-9]+(?:-[a-z0-9]+)*$/;

const baseSchema = z.object({
  name: z.string().trim().min(1).max(200),
  category: z.string().trim().max(64).nullable().optional(),
  pricingMode: z.enum(['fixed', 'inquiry']).optional(),
  orderKind: z.string().trim().max(32).nullable().optional(),
  description: z.string().trim().max(4000).nullable().optional(),
  commissionRate: z.number().min(0).max(50).nullable().optional(),
  isActive: z.boolean().optional(),
  sortOrder: z.number().int().min(0).max(10_000).optional(),
});

const createSchema = baseSchema.extend({
  slug: z.string().trim().min(2).max(80).regex(SLUG_RE, 'slug: lowercase words joined by -'),
});
const updateSchema = baseSchema.partial();

/** Deduplicated catalog slugs; unknown or inactive slugs are a 400. */
export async function validateServiceSlugs(
  tables: TenantTables,
  slugs: string[] | undefined,
): Promise<string[] | undefined> {
  if (slugs === undefined) return undefined;
  const unique = [...new Set(slugs.map((s) => s.trim()).filter(Boolean))];
  if (unique.length === 0) return [];
  const rows = await db
    .select({ slug: tables.serviceCatalog.slug, isActive: tables.serviceCatalog.isActive })
    .from(tables.serviceCatalog)
    .where(inArray(tables.serviceCatalog.slug, unique));
  const known = new Set(rows.filter((r) => r.isActive).map((r) => r.slug));
  const unknown = unique.filter((s) => !known.has(s));
  if (unknown.length > 0) throw badRequest(`Unknown services: ${unknown.join(', ')}`);
  return unique;
}

function toNumericString(v: number | null | undefined): string | null | undefined {
  return v === undefined ? undefined : v === null ? null : v.toFixed(2);
}

export const serviceCatalogPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  app.get('/', async (request) => {
    const { serviceCatalog: c } = request.company!.tables;
    const rows = await db
      .select({
        slug: c.slug,
        name: c.name,
        category: c.category,
        pricingMode: c.pricingMode,
        orderKind: c.orderKind,
        description: c.description,
      })
      .from(c)
      .where(eq(c.isActive, true))
      .orderBy(asc(c.sortOrder), asc(c.name));
    return { services: rows };
  });
};

export const serviceCatalogAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', app.requireWriteAccess);

  app.get('/', async (request) => {
    const { serviceCatalog: c } = request.company!.tables;
    const rows = await db.select().from(c).orderBy(asc(c.sortOrder), asc(c.name));
    return { services: rows };
  });

  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { serviceCatalog: c } = request.company!.tables;
    const [row] = await db
      .insert(c)
      .values({
        ...body,
        pricingMode: body.pricingMode ?? 'inquiry',
        commissionRate: toNumericString(body.commissionRate),
      })
      .onConflictDoNothing({ target: c.slug })
      .returning();
    if (!row) throw conflict('A service with this slug already exists');
    reply.code(201);
    return { service: row };
  });

  // Slug is immutable: it is a public URL and the value stored on partners.
  app.patch('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = updateSchema.parse(request.body);
    const { serviceCatalog: c } = request.company!.tables;
    const [row] = await db
      .update(c)
      .set({ ...body, commissionRate: toNumericString(body.commissionRate), updatedAt: new Date() })
      .where(eq(c.id, id))
      .returning();
    if (!row) throw notFound('Service not found');
    return { service: row };
  });
};
