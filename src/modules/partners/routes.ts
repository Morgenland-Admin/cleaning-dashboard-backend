import type { FastifyPluginAsync } from 'fastify';
import { count, desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import {
  accessLevelOf,
  PARTNER_PAYOUT_FIELDS,
  redactForViewer,
  redactListForViewer,
} from '../../lib/access.js';
import { db } from '../../db/index.js';
import { membership, user } from '../../db/schema/shared.js';
import { DEFAULT_COMMISSION_RATE, parseCommissionRate } from '../../lib/commission.js';
import { badRequest, conflict, forbidden, notFound, parseIntId } from '../../lib/http-errors.js';
import { getStripe, stripeConfigured } from '../../lib/stripe.js';
import { env } from '../../config/env.js';
import { loadCompany, partnerPortalBase } from '../../lib/company-loader.js';
import { resolveCommissionRate } from '../orders/assign.js';
import { validateServiceSlugs } from '../service-catalog/routes.js';
import {
  checklistFor,
  partnerProfileSchema,
  locationPatch,
  requireOwnPartner,
  findPartnerByUser,
  toSelfView,
  notifyPartnerActivated,
  partnerById,
  verifiedPartnerIds,
} from './lib.js';

const onboardSchema = partnerProfileSchema.partial().extend({
  companyName: z.string().trim().min(1).max(200),
});

const updateProfileSchema = partnerProfileSchema.partial();

const adminUpdateSchema = partnerProfileSchema.partial().extend({
  status: z.enum(['pending', 'active', 'suspended', 'rejected']).optional(),
  internalNotes: z.string().max(2000).nullable().optional(),
  tier: z.enum(['basic', 'professional', 'premium']).optional(),
  monthlyFeeCents: z.number().int().min(0).max(10_000_000).optional(),
  score: z.number().int().min(0).max(100).nullable().optional(),
  // Null falls back to the platform default (12 %).
  commissionRate: z.number().min(0).max(50).nullable().optional(),
});

const acceptContractSchema = z.object({ version: z.string().trim().min(1).max(32) });

/** Both connect URLs land on the partner portal's payout page. */
function connectReturnUrls(base: string, hasPortal: boolean) {
  const page = hasPortal ? `${base}/auszahlungen` : `${base}/partner/auszahlungen`;
  return { refresh_url: `${page}?connect=refresh`, return_url: `${page}?connect=return` };
}

export const partnersSelfRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('partner'));
  app.addHook('preHandler', app.requireCompany);

  app.get('/me', async (request) => {
    const tables = request.company!.tables;
    const row = await findPartnerByUser(tables, request.authUser!.id);
    const companyRow = await loadCompany(request.company!.slug);
    const contract = {
      version: companyRow?.partnerContractVersion ?? null,
      url: companyRow?.partnerContractUrl ?? null,
    };
    if (!row) return { partner: null, checklist: null, contract };
    const checklist = await checklistFor(tables, row, contract.version);
    return { partner: toSelfView(row), checklist, contract };
  });

  app.patch('/me', async (request) => {
    const body = updateProfileSchema.parse(request.body);
    const partner = await requireOwnPartner(request);
    if (partner.status === 'suspended' || partner.status === 'rejected') {
      throw forbidden('Partnerkonto ist gesperrt');
    }
    const { partners } = request.company!.tables;
    const services = await validateServiceSlugs(request.company!.tables, body.services);
    const [row] = await db
      .update(partners)
      .set({
        ...body,
        services,
        ...locationPatch(body.postalCode),
        updatedAt: new Date(),
      })
      .where(eq(partners.id, partner.id))
      .returning();
    return { partner: row ? toSelfView(row) : null };
  });

  app.post('/onboard', async (request, reply) => {
    const userId = request.authUser!.id;
    const body = onboardSchema.parse(request.body);
    const tables = request.company!.tables;
    if (await findPartnerByUser(tables, userId)) {
      throw conflict('Sie haben bereits ein Partnerprofil.');
    }
    const services = await validateServiceSlugs(tables, body.services);
    const [row] = await db
      .insert(tables.partners)
      .values({
        userId,
        ...body,
        contactEmail: body.contactEmail ?? request.authUser!.email,
        services: services ?? [],
        ...locationPatch(body.postalCode),
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict('Sie haben bereits ein Partnerprofil.');
    reply.code(201);
    return { partner: toSelfView(row) };
  });

  app.get('/me/contract', async (request) => {
    const partner = await requireOwnPartner(request);
    const companyRow = await loadCompany(request.company!.slug);
    return {
      version: companyRow?.partnerContractVersion ?? null,
      url: companyRow?.partnerContractUrl ?? null,
      acceptedVersion: partner.contractVersion,
      acceptedAt: partner.contractAcceptedAt,
    };
  });

  app.post('/me/contract/accept', async (request, reply) => {
    const { version } = acceptContractSchema.parse(request.body);
    const partner = await requireOwnPartner(request);
    const companyRow = await loadCompany(request.company!.slug);
    const current = companyRow?.partnerContractVersion ?? null;
    if (!current) throw badRequest('Derzeit ist kein Partnervertrag hinterlegt.');
    if (version !== current) {
      reply.code(409).send({
        error: 'Der Partnervertrag wurde aktualisiert. Bitte lesen Sie die neue Version.',
        version: current,
      });
      return;
    }
    const { partners, partnerContractAcceptances } = request.company!.tables;
    const now = new Date();
    const ua = request.headers['user-agent'];
    await db.transaction(async (tx) => {
      await tx.insert(partnerContractAcceptances).values({
        partnerId: partner.id,
        version,
        acceptedByUserId: request.authUser!.id,
        ipAddress: request.ip,
        userAgent: typeof ua === 'string' ? ua.slice(0, 500) : null,
        acceptedAt: now,
      });
      await tx
        .update(partners)
        .set({ contractVersion: version, contractAcceptedAt: now, updatedAt: now })
        .where(eq(partners.id, partner.id));
    });
    return { acceptedVersion: version, acceptedAt: now.toISOString() };
  });

  // Rates exactly as assignOrderToPartner applies them; inquiry-only services carry none.
  app.get('/me/commission', async (request) => {
    const partner = await requireOwnPartner(request);
    const tables = request.company!.tables;
    const { serviceCatalog: c } = tables;
    const rows = await db
      .select({ slug: c.slug, orderKind: c.orderKind })
      .from(c)
      .where(eq(c.isActive, true));
    // Same key assignment uses: fixed-price orders carry the orderKind, request jobs the slug.
    const keyOf = (r: { slug: string; orderKind: string | null }) => r.orderKind ?? r.slug;
    const keys = [...new Set(rows.map(keyOf))];
    const byKey = new Map(
      await Promise.all(
        keys.map(
          async (key) =>
            [
              key,
              (await resolveCommissionRate(tables, partner, key)) ?? DEFAULT_COMMISSION_RATE,
            ] as const,
        ),
      ),
    );
    return {
      partnerRatePercent: parseCommissionRate(partner.commissionRate),
      services: Object.fromEntries(rows.map((r) => [r.slug, byKey.get(keyOf(r))!])),
    };
  });

  app.post('/connect/onboard', async (request, reply) => {
    if (!stripeConfigured) {
      reply.code(503).send({ error: 'Payments are not configured on this server' });
      return;
    }
    const userId = request.authUser!.id;
    const { partners } = request.company!.tables;
    const partner = await findPartnerByUser(request.company!.tables, userId);
    if (!partner) throw notFound('Partner profile not found — complete onboarding first');
    if (partner.status === 'suspended' || partner.status === 'rejected') {
      throw forbidden('Partnerkonto ist gesperrt');
    }

    const companyRow = await loadCompany(request.company!.slug);
    const stripe = getStripe();

    let connectId = partner.stripeConnectId;
    if (!connectId) {
      const account = await stripe.accounts.create({
        type: 'express',
        country: partner.country ?? 'DE',
        email: partner.contactEmail ?? undefined,
        business_type: 'company',
        capabilities: { transfers: { requested: true } },
        metadata: {
          companySlug: request.company!.slug,
          partnerId: String(partner.id),
          partnerUserId: userId,
        },
      });
      connectId = account.id;
      await db
        .update(partners)
        .set({ stripeConnectId: connectId, stripeConnectStatus: 'pending', updatedAt: new Date() })
        .where(eq(partners.id, partner.id));
    }

    const base =
      (companyRow && partnerPortalBase(companyRow)) ?? env.APP_BASE_URL.replace(/\/$/, '');
    const accountLink = await stripe.accountLinks.create({
      account: connectId,
      ...connectReturnUrls(base, !!companyRow?.partnerPortalOrigin),
      type: 'account_onboarding',
    });

    reply.send({ onboardingUrl: accountLink.url, connectId });
  });

  // Stripe Express dashboard (payout history, bank account) for an onboarded partner.
  app.post('/connect/dashboard-link', async (request, reply) => {
    if (!stripeConfigured) {
      reply.code(503).send({ error: 'Payments are not configured on this server' });
      return;
    }
    const partner = await requireOwnPartner(request);
    if (!partner.stripeConnectId) throw notFound('No payout account yet');
    const link = await getStripe().accounts.createLoginLink(partner.stripeConnectId);
    reply.send({ url: link.url });
  });

  app.get('/connect/status', async (request) => {
    const { partners } = request.company!.tables;
    const partner = await requireOwnPartner(request);
    if (!partner.stripeConnectId || !stripeConfigured) {
      return {
        connected: false,
        status: partner.stripeConnectStatus,
        chargesEnabled: partner.chargesEnabled,
        payoutsEnabled: partner.payoutsEnabled,
      };
    }
    const account = await getStripe().accounts.retrieve(partner.stripeConnectId);
    const status = account.payouts_enabled
      ? 'active'
      : account.details_submitted
        ? 'restricted'
        : 'pending';
    const [updated] = await db
      .update(partners)
      .set({
        stripeConnectStatus: status,
        chargesEnabled: !!account.charges_enabled,
        payoutsEnabled: !!account.payouts_enabled,
        updatedAt: new Date(),
      })
      .where(eq(partners.id, partner.id))
      .returning();
    return {
      connected: true,
      status: updated?.stripeConnectStatus ?? status,
      chargesEnabled: updated?.chargesEnabled ?? false,
      payoutsEnabled: updated?.payoutsEnabled ?? false,
    };
  });
};

const listQuerySchema = z.object({
  status: z.enum(['pending', 'active', 'suspended', 'rejected']).optional(),
});

export const partnersAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('admin'));
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', app.requireWriteAccess);

  app.get('/', async (request) => {
    const { status } = listQuerySchema.parse(request.query);
    const tables = request.company!.tables;
    const { partners } = tables;
    const rows = await db
      .select()
      .from(partners)
      .where(status ? eq(partners.status, status) : undefined)
      .orderBy(desc(partners.createdAt))
      .limit(200);
    const companyRow = await loadCompany(request.company!.slug);
    const verified = await verifiedPartnerIds(
      tables,
      rows,
      companyRow?.partnerContractVersion ?? null,
    );
    // Internal notes and payout banking are hidden from viewers.
    return {
      partners: redactListForViewer(
        rows.map((r) => ({ ...r, verified: verified.has(r.id) })),
        accessLevelOf(request),
        PARTNER_PAYOUT_FIELDS,
      ),
    };
  });

  app.get('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const tables = request.company!.tables;
    const { partners, partnerDocuments, partnerContractAcceptances, partnerOffers, orders } =
      tables;
    const [row] = await db.select().from(partners).where(eq(partners.id, id)).limit(1);
    if (!row) throw notFound('Partner not found');
    const companyRow = await loadCompany(request.company!.slug);
    const [checklist, documents, acceptances, offerStats, [assigned]] = await Promise.all([
      checklistFor(tables, row, companyRow?.partnerContractVersion ?? null),
      db
        .select()
        .from(partnerDocuments)
        .where(eq(partnerDocuments.partnerId, id))
        .orderBy(desc(partnerDocuments.createdAt)),
      db
        .select()
        .from(partnerContractAcceptances)
        .where(eq(partnerContractAcceptances.partnerId, id))
        .orderBy(desc(partnerContractAcceptances.acceptedAt)),
      db
        .select({ status: partnerOffers.status, n: count() })
        .from(partnerOffers)
        .where(eq(partnerOffers.partnerId, id))
        .groupBy(partnerOffers.status),
      db.select({ n: count() }).from(orders).where(eq(orders.assignedPartnerId, id)),
    ]);
    const level = accessLevelOf(request);
    return {
      partner: redactForViewer(row, level, PARTNER_PAYOUT_FIELDS),
      checklist,
      documents,
      contractAcceptances: redactListForViewer(acceptances, level),
      offerStats: Object.fromEntries(offerStats.map((s) => [s.status, s.n])),
      assignedOrders: assigned?.n ?? 0,
    };
  });

  const createPartnerSchema = partnerProfileSchema.partial().extend({
    email: z.string().email(),
    companyName: z.string().trim().min(1).max(200),
    internalNotes: z.string().max(2000).optional(),
    commissionRate: z.number().min(0).max(50).nullable().optional(),
  });
  app.post('/', async (request, reply) => {
    const { email, commissionRate, ...body } = createPartnerSchema.parse(request.body);
    const tables = request.company!.tables;
    const { partners } = tables;
    const companySlug = request.company!.slug;
    const now = new Date();
    const services = await validateServiceSlugs(tables, body.services);

    const [existingUser] = await db.select().from(user).where(eq(user.email, email)).limit(1);

    let userId: string;
    if (existingUser) {
      userId = existingUser.id;
    } else {
      userId = nanoid();
      await db.insert(user).values({
        id: userId,
        name: body.companyName,
        email,
        emailVerified: false,
        audience: 'partner',
        accessLevel: 'none',
        isActive: false,
      });
    }

    await db
      .insert(membership)
      .values({
        userId,
        companySlug,
        role: 'partner',
        invitedByUserId: request.authUser!.id,
        invitedAt: now,
      })
      .onConflictDoUpdate({
        target: [membership.userId, membership.companySlug],
        set: { role: 'partner' },
      });

    const [row] = await db
      .insert(partners)
      .values({
        userId,
        ...body,
        contactEmail: body.contactEmail ?? email,
        services: services ?? [],
        ...locationPatch(body.postalCode),
        commissionRate: commissionRate == null ? null : commissionRate.toFixed(2),
        status: 'pending',
      })
      .onConflictDoNothing()
      .returning();
    if (!row) throw conflict('This user already has a partner profile on this company');

    reply.code(201);
    return { partner: row, userCreated: !existingUser };
  });

  app.patch('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const {
      commissionRate,
      services: rawServices,
      ...body
    } = adminUpdateSchema.parse(request.body);
    const adminId = request.authUser!.id;
    const tables = request.company!.tables;
    const now = new Date();
    const services = await validateServiceSlugs(tables, rawServices);
    const patch: Record<string, unknown> = {
      ...body,
      ...locationPatch(body.postalCode),
      updatedAt: now,
    };
    if (services !== undefined) patch.services = services;
    if (commissionRate !== undefined) {
      patch.commissionRate = commissionRate === null ? null : commissionRate.toFixed(2);
    }
    if (body.status === 'active') {
      patch.approvedAt = now;
      patch.approvedByUserId = adminId;
      patch.suspendedAt = null;
    }
    if (body.status === 'suspended') patch.suspendedAt = now;
    const before = await partnerById(tables, id);
    if (!before) throw notFound('Partner not found');
    const [row] = await db
      .update(tables.partners)
      .set(patch)
      .where(eq(tables.partners.id, id))
      .returning();
    if (!row) throw notFound('Partner not found');
    if (body.status === 'active' && before.status !== 'active') {
      void notifyPartnerActivated(request.company!.slug, request.company!.name, row, adminId);
    }
    const companyRow = await loadCompany(request.company!.slug);
    const checklist = await checklistFor(tables, row, companyRow?.partnerContractVersion ?? null);
    return { partner: row, checklist };
  });
};
