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
  schemaName: z.string().min(2).max(63).optional(),
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

// Column allowlist for any company row returned over the API. Deliberately
// EXCLUDES secrets (resendApiKey) — never `.returning()` the raw row.
const companyPublicColumns = {
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
  accountHolder: company.accountHolder,
  iban: company.iban,
  bic: company.bic,
  bankName: company.bankName,
  bankAddress: company.bankAddress,
  logoUrl: company.logoUrl,
  primaryColor: company.primaryColor,
  senderEmail: company.senderEmail,
  senderName: company.senderName,
  storefrontOrigin: company.storefrontOrigin,
  isActive: company.isActive,
} as const;

const companiesRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/', async (request) => {
    const userId = request.authUser!.id;
    const rows = await db
      .select({ ...companyPublicColumns, role: membership.role })
      .from(membership)
      .innerJoin(company, eq(membership.companySlug, company.slug))
      .where(eq(membership.userId, userId));
    return { companies: rows };
  });

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

    const [existing] = await db
      .select({ slug: company.slug })
      .from(company)
      .where(eq(company.slug, body.slug))
      .limit(1);
    if (existing) throw conflict('Company with this slug already exists');

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
        .returning(companyPublicColumns);
      await tx
        .insert(membership)
        .values({ userId, companySlug: body.slug, role: 'owner', acceptedAt: new Date() })
        .onConflictDoNothing();
      return row;
    });

    invalidateCompany();
    void app.refreshCorsOrigins();
    reply.code(201);
    return { company: inserted };
  });

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
    accountHolder: z.string().max(200).nullable().optional(),
    iban: z
      .string()
      .transform((s) => s.replace(/\s+/g, '').toUpperCase())
      .pipe(z.string().regex(/^[A-Z]{2}[0-9A-Z]{13,32}$/, 'IBAN must be 15–34 chars'))
      .nullable()
      .optional(),
    bic: z
      .string()
      .transform((s) => s.replace(/\s+/g, '').toUpperCase())
      .pipe(z.string().regex(/^[A-Z0-9]{8}([A-Z0-9]{3})?$/, 'BIC must be 8 or 11 chars'))
      .nullable()
      .optional(),
    bankName: z.string().max(200).nullable().optional(),
    bankAddress: z.string().max(200).nullable().optional(),
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
    // storefrontOrigin is folded into the process-wide credentialed CORS allowlist,
    // so a tenant admin must not be able to set it — super_admin only.
    if (body.storefrontOrigin !== undefined && inviterMeta.accessLevel !== 'super_admin') {
      reply.code(403).send({ error: 'Nur ein super_admin darf die storefrontOrigin ändern.' });
      return;
    }
    const [updated] = await db
      .update(company)
      .set({ ...body, updatedAt: new Date() })
      .where(eq(company.slug, slug))
      .returning(companyPublicColumns);
    if (!updated) {
      reply.code(404).send({ error: 'Company not found' });
      return;
    }
    invalidateCompany(slug);
    void app.refreshCorsOrigins();
    return { company: updated };
  });

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

    const sevenDaysAgo = new Date(Date.now() - 7 * 24 * 60 * 60 * 1000);

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
