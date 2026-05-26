import type { FastifyPluginAsync } from 'fastify';
import { and, count, eq, gte, inArray, isNotNull, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { company, membership, session } from '../../db/schema/shared.js';
import { createTenantSchemaSql, getTenantTables } from '../../db/schema/tenant.js';
import { isValidCompanySlug, isValidKeyPrefix, isValidSchemaName } from '../../config/companies.js';
import { invalidateCompany, loadCompany } from '../../lib/company-loader.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/http-errors.js';

const switchSchema = z.object({ slug: z.string().min(1) });

const createCompanySchema = z.object({
  slug: z.string().min(2).max(63),
  name: z.string().min(1).max(200),
  /** Defaults to `slug` if omitted. Must satisfy isValidSchemaName. */
  schemaName: z.string().min(2).max(63).optional(),
  /** S3 folder. Defaults to slug with `_` -> `-`. */
  keyPrefix: z.string().min(2).max(63).optional(),
  storefrontOrigin: z.string().url().optional(),
  senderEmail: z.string().email().optional(),
  senderName: z.string().max(200).optional(),
  email: z.string().email().optional(),
  websiteUrl: z.string().url().optional(),
  primaryColor: z
    .string()
    .regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/, 'primaryColor must be #rrggbb or #rrggbbaa')
    .optional(),
  logoUrl: z.string().url().optional(),
});

const companiesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  // List companies this user has access to. Returns the full set of editable
  // fields so the admin UI can pre-fill the edit form without a second fetch.
  app.get('/', async (request) => {
    const userId = request.authUser!.id;
    const rows = await db
      .select({
        slug: company.slug,
        name: company.name,
        legalName: company.legalName,
        schemaName: company.schemaName,
        email: company.email,
        phone: company.phone,
        websiteUrl: company.websiteUrl,
        addressLine1: company.addressLine1,
        addressLine2: company.addressLine2,
        city: company.city,
        region: company.region,
        postalCode: company.postalCode,
        country: company.country,
        vatId: company.vatId,
        registrationNumber: company.registrationNumber,
        logoUrl: company.logoUrl,
        primaryColor: company.primaryColor,
        senderEmail: company.senderEmail,
        senderName: company.senderName,
        storefrontOrigin: company.storefrontOrigin,
        isActive: company.isActive,
        role: membership.role,
      })
      .from(membership)
      .innerJoin(company, eq(membership.companySlug, company.slug))
      .where(eq(membership.userId, userId));
    return { companies: rows };
  });

  // Create a new company. super_admin only. This is what makes the multi-tenant
  // model truly dynamic — inserting a `company` row + provisioning its
  // Postgres schema + tables, all from an authenticated request.
  app.post('/', { preHandler: app.requireAccess('super_admin') }, async (request, reply) => {
    const body = createCompanySchema.parse(request.body);
    if (!isValidCompanySlug(body.slug)) {
      throw badRequest(
        'slug must be lowercase letters/digits/underscore, starting with a letter (2-63 chars)',
      );
    }
    const schemaName = body.schemaName ?? body.slug;
    if (!isValidSchemaName(schemaName)) {
      throw badRequest('schemaName has invalid characters');
    }
    const keyPrefix = body.keyPrefix ?? body.slug.replace(/_/g, '-');
    if (!isValidKeyPrefix(keyPrefix)) {
      throw badRequest(
        'keyPrefix must be lowercase letters/digits/hyphen, starting with a letter (2-63 chars)',
      );
    }

    // Pre-flight uniqueness — surface a friendlier error than a Postgres
    // constraint violation.
    const [existing] = await db
      .select({ slug: company.slug })
      .from(company)
      .where(eq(company.slug, body.slug))
      .limit(1);
    if (existing) throw conflict('Company with this slug already exists');

    // Provision schema + insert company row + grant ownership atomically.
    // If any step fails (e.g. concurrent slug collision past the pre-flight),
    // Postgres rolls back the schema creation too, so we never leave an
    // orphaned schema in the registry-less state. The schema SQL is
    // idempotent (CREATE ... IF NOT EXISTS) so retries are safe.
    const userId = request.authUser!.id;
    const inserted = await db.transaction(async (tx) => {
      await tx.execute(sql.raw(createTenantSchemaSql(schemaName)));
      const [row] = await tx
        .insert(company)
        .values({
          slug: body.slug,
          name: body.name,
          schemaName,
          keyPrefix,
          storefrontOrigin: body.storefrontOrigin,
          senderEmail: body.senderEmail,
          senderName: body.senderName ?? body.name,
          email: body.email,
          websiteUrl: body.websiteUrl,
          primaryColor: body.primaryColor,
          logoUrl: body.logoUrl,
        })
        .returning();
      await tx
        .insert(membership)
        .values({ userId, companySlug: body.slug, role: 'owner', acceptedAt: new Date() })
        .onConflictDoNothing();
      return row;
    });

    invalidateCompany();
    // Force-refresh the CORS allow-list so the new storefrontOrigin (if any)
    // is granted access on this instance immediately, not after the 60 s tick.
    void app.refreshCorsOrigins();
    reply.code(201);
    return { company: inserted };
  });

  // Update an existing company's branding / contact / sender details. Limited
  // to owner-membership on the target (or super_admin). Schema name + slug
  // + key prefix cannot be changed — they're load-bearing for the tenant
  // schema and S3 layout.
  // Editable surface — slug, schemaName, keyPrefix are intentionally NOT here
  // because they're load-bearing for tenant isolation + S3 layout.
  const updateCompanySchema = z.object({
    name: z.string().min(1).max(200).optional(),
    legalName: z.string().max(200).nullable().optional(),
    email: z.string().email().nullable().optional(),
    phone: z.string().max(32).nullable().optional(),
    websiteUrl: z.string().url().nullable().optional(),
    addressLine1: z.string().max(200).nullable().optional(),
    addressLine2: z.string().max(200).nullable().optional(),
    city: z.string().max(120).nullable().optional(),
    region: z.string().max(120).nullable().optional(),
    postalCode: z.string().max(20).nullable().optional(),
    country: z.string().length(2).nullable().optional(),
    vatId: z.string().max(32).nullable().optional(),
    registrationNumber: z.string().max(64).nullable().optional(),
    primaryColor: z
      .string()
      .regex(/^#[0-9a-fA-F]{6}([0-9a-fA-F]{2})?$/)
      .nullable()
      .optional(),
    logoUrl: z.string().url().nullable().optional(),
    senderEmail: z.string().email().nullable().optional(),
    senderName: z.string().max(200).nullable().optional(),
    storefrontOrigin: z.string().url().nullable().optional(),
    isActive: z.boolean().optional(),
  });
  app.patch('/:slug', { preHandler: app.requireAudience('admin') }, async (request, reply) => {
    const slug = (request.params as { slug: string }).slug;
    if (!isValidCompanySlug(slug)) throw badRequest('Invalid slug');
    const body = updateCompanySchema.parse(request.body);
    const inviter = request.authUser!;
    const inviterMeta = inviter as unknown as { accessLevel?: string };
    if (inviterMeta.accessLevel !== 'super_admin') {
      const [m] = await db
        .select()
        .from(membership)
        .where(and(eq(membership.userId, inviter.id), eq(membership.companySlug, slug)))
        .limit(1);
      if (!m || (m.role !== 'owner' && m.role !== 'admin')) {
        reply.code(403).send({ error: 'Forbidden — must be owner/admin on this company' });
        return;
      }
    }
    const [updated] = await db
      .update(company)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(company.slug, slug))
      .returning();
    if (!updated) {
      reply.code(404).send({ error: 'Company not found' });
      return;
    }
    invalidateCompany(slug);
    void app.refreshCorsOrigins();
    return { company: updated };
  });

  // Aggregate stats for one brand — powers the brand detail page widgets.
  // Membership-gated (not super_admin-only) so any user with access to the
  // brand can see its overview.
  app.get('/:slug/stats', { preHandler: app.requireAudience('admin') }, async (request, reply) => {
    const slug = (request.params as { slug: string }).slug;
    if (!isValidCompanySlug(slug)) throw badRequest('Invalid slug');

    const userId = request.authUser!.id;
    const inviterMeta = request.authUser as unknown as { accessLevel?: string };
    if (inviterMeta.accessLevel !== 'super_admin') {
      const [m] = await db
        .select({ role: membership.role })
        .from(membership)
        .where(and(eq(membership.userId, userId), eq(membership.companySlug, slug)))
        .limit(1);
      if (!m) {
        reply.code(403).send({ error: 'Forbidden — not a member of this company' });
        return;
      }
    }

    const companyRow = await loadCompany(slug);
    if (!companyRow) throw notFound('Company not found');
    const tables = getTenantTables(companyRow.schemaName);

    // 7-day window — created_at indexed, so this is cheap.
    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

    // Parallelize per-table queries — Postgres pools handle this fine, and the
    // serial path would otherwise add 5–10 ms latency per query.
    const [
      [nlConfirmed],
      [nlPending],
      [nlUnsub],
      [contactTotal],
      [contactNew],
      [contactWeek],
      [inquiryTotal],
      [inquiryOpen],
      [inquiryWeek],
    ] = await Promise.all([
      db
        .select({ n: count() })
        .from(tables.newsletterSubscribers)
        .where(
          and(
            eq(tables.newsletterSubscribers.confirmed, true),
            isNull(tables.newsletterSubscribers.unsubscribedAt),
          ),
        ),
      db
        .select({ n: count() })
        .from(tables.newsletterSubscribers)
        .where(
          and(
            eq(tables.newsletterSubscribers.confirmed, false),
            isNull(tables.newsletterSubscribers.unsubscribedAt),
          ),
        ),
      db
        .select({ n: count() })
        .from(tables.newsletterSubscribers)
        .where(isNotNull(tables.newsletterSubscribers.unsubscribedAt)),
      db.select({ n: count() }).from(tables.contactMessages),
      db
        .select({ n: count() })
        .from(tables.contactMessages)
        .where(eq(tables.contactMessages.status, 'new')),
      db
        .select({ n: count() })
        .from(tables.contactMessages)
        .where(gte(tables.contactMessages.createdAt, sevenDaysAgo)),
      db.select({ n: count() }).from(tables.serviceInquiries),
      db
        .select({ n: count() })
        .from(tables.serviceInquiries)
        .where(inArray(tables.serviceInquiries.status, ['new', 'in_review'])),
      db
        .select({ n: count() })
        .from(tables.serviceInquiries)
        .where(gte(tables.serviceInquiries.createdAt, sevenDaysAgo)),
    ]);

    return {
      stats: {
        newsletter: {
          confirmed: nlConfirmed?.n ?? 0,
          pending: nlPending?.n ?? 0,
          unsubscribed: nlUnsub?.n ?? 0,
        },
        contact: {
          total: contactTotal?.n ?? 0,
          new: contactNew?.n ?? 0,
          last7Days: contactWeek?.n ?? 0,
        },
        inquiry: {
          total: inquiryTotal?.n ?? 0,
          openCount: inquiryOpen?.n ?? 0,
          last7Days: inquiryWeek?.n ?? 0,
        },
      },
    };
  });

  // Switch active company — stores slug on the session row.
  app.post('/switch', async (request) => {
    const userId = request.authUser!.id;
    const { slug } = switchSchema.parse(request.body);
    if (!isValidCompanySlug(slug)) throw badRequest('Invalid company slug');

    const [m] = await db
      .select()
      .from(membership)
      .where(and(eq(membership.userId, userId), eq(membership.companySlug, slug)))
      .limit(1);
    if (!m) throw forbidden('Not a member of this company');

    const sessionId = request.authSession?.session.id;
    if (sessionId) {
      await db
        .update(session)
        .set({ activeCompanySlug: slug, updatedAt: new Date() })
        .where(eq(session.id, sessionId));
    }
    return { activeCompany: slug };
  });
};

export default companiesRoutes;
