import type { FastifyPluginAsync } from 'fastify';
import { desc, eq } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { accessLevelOf, PARTNER_PAYOUT_FIELDS, redactListForViewer } from '../../lib/access.js';
import { db } from '../../db/index.js';
import { company, membership, user } from '../../db/schema/shared.js';
import { conflict, notFound, parseIntId } from '../../lib/http-errors.js';
import { getStripe, stripeConfigured } from '../../lib/stripe.js';
import { env } from '../../config/env.js';

const onboardSchema = z.object({
  companyName: z.string().min(1).max(200).optional(),
  legalName: z.string().max(200).optional(),
  taxId: z.string().max(32).optional(),
  vatId: z.string().max(32).optional(),
  contactEmail: z.string().email().optional(),
  contactPhone: z.string().max(32).optional(),
  websiteUrl: z.string().url().optional(),
  addressLine1: z.string().max(200).optional(),
  addressLine2: z.string().max(200).optional(),
  city: z.string().max(120).optional(),
  region: z.string().max(120).optional(),
  postalCode: z.string().max(20).optional(),
  country: z.string().length(2).optional(),
  serviceAreas: z.array(z.string().max(120)).max(50).optional(),
  services: z.array(z.string().max(120)).max(50).optional(),
  iban: z.string().max(34).optional(),
  bic: z.string().max(11).optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(['pending', 'active', 'suspended', 'rejected']).optional(),
  internalNotes: z.string().max(2000).optional(),
  tier: z.enum(['basic', 'professional', 'premium']).optional(),
  monthlyFeeCents: z.number().int().min(0).max(10_000_000).optional(),
  score: z.number().int().min(0).max(100).nullable().optional(),
});

export const partnersSelfRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('partner'));
  app.addHook('preHandler', app.requireCompany);

  app.get('/me', async (request) => {
    const userId = request.authUser!.id;
    const { partners } = request.company!.tables;
    const [row] = await db.select().from(partners).where(eq(partners.userId, userId)).limit(1);
    return { partner: row ?? null };
  });

  app.post('/onboard', async (request, reply) => {
    const userId = request.authUser!.id;
    const body = onboardSchema.parse(request.body);
    const { partners } = request.company!.tables;

    const [existing] = await db
      .select({ id: partners.id })
      .from(partners)
      .where(eq(partners.userId, userId))
      .limit(1);
    if (existing) throw conflict('You already have a partner profile on this company');

    const [row] = await db
      .insert(partners)
      .values({ userId, ...body })
      .returning();
    reply.code(201);
    return { partner: row };
  });

  app.post('/connect/onboard', async (request, reply) => {
    if (!stripeConfigured) {
      reply.code(503).send({ error: 'Payments are not configured on this server' });
      return;
    }
    const userId = request.authUser!.id;
    const { partners } = request.company!.tables;
    const [partner] = await db.select().from(partners).where(eq(partners.userId, userId)).limit(1);
    if (!partner) throw notFound('Partner profile not found — complete onboarding first');

    const [companyRow] = await db
      .select()
      .from(company)
      .where(eq(company.slug, request.company!.slug))
      .limit(1);
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

    const base = (companyRow?.storefrontOrigin ?? env.APP_BASE_URL).replace(/\/$/, '');
    const accountLink = await stripe.accountLinks.create({
      account: connectId,
      refresh_url: `${base}/partner/auszahlungen?connect=refresh`,
      return_url: `${base}/partner/auszahlungen?connect=return`,
      type: 'account_onboarding',
    });

    reply.send({ onboardingUrl: accountLink.url, connectId });
  });

  /** Re-sync the partner's Connect account flags from Stripe. */
  app.get('/connect/status', async (request) => {
    const userId = request.authUser!.id;
    const { partners } = request.company!.tables;
    const [partner] = await db.select().from(partners).where(eq(partners.userId, userId)).limit(1);
    if (!partner) throw notFound('Partner profile not found');
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

export const partnersAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('admin'));
  app.addHook('preHandler', app.requireCompany);
  // Approving, suspending and creating partner accounts are all privileged.
  app.addHook('preHandler', app.requireWriteAccess);

  app.get('/', async (request) => {
    const { partners } = request.company!.tables;
    const rows = await db.select().from(partners).orderBy(desc(partners.createdAt)).limit(200);
    // Internal notes plus payout banking — a brand viewer needs neither.
    return {
      partners: redactListForViewer(rows, accessLevelOf(request), PARTNER_PAYOUT_FIELDS),
    };
  });

  const createPartnerSchema = z.object({
    email: z.string().email(),
    companyName: z.string().min(1).max(200),
    legalName: z.string().max(200).optional(),
    contactPhone: z.string().max(32).optional(),
    websiteUrl: z.string().url().optional(),
    addressLine1: z.string().max(200).optional(),
    addressLine2: z.string().max(200).optional(),
    city: z.string().max(120).optional(),
    region: z.string().max(120).optional(),
    postalCode: z.string().max(20).optional(),
    country: z.string().length(2).optional(),
    services: z.array(z.string().max(120)).max(50).optional(),
    serviceAreas: z.array(z.string().max(120)).max(50).optional(),
    iban: z.string().max(34).optional(),
    bic: z.string().max(11).optional(),
    taxId: z.string().max(32).optional(),
    vatId: z.string().max(32).optional(),
    internalNotes: z.string().max(2000).optional(),
  });
  app.post('/', async (request, reply) => {
    const body = createPartnerSchema.parse(request.body);
    const { partners } = request.company!.tables;
    const companySlug = request.company!.slug;
    const now = new Date();

    const [existingUser] = await db.select().from(user).where(eq(user.email, body.email)).limit(1);

    let userId: string;
    if (existingUser) {
      userId = existingUser.id;
    } else {
      userId = nanoid();
      await db.insert(user).values({
        id: userId,
        name: body.companyName,
        email: body.email,
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

    const [existingPartner] = await db
      .select()
      .from(partners)
      .where(eq(partners.userId, userId))
      .limit(1);
    if (existingPartner) {
      throw conflict('This user already has a partner profile on this company');
    }

    const [row] = await db
      .insert(partners)
      .values({
        userId,
        companyName: body.companyName,
        legalName: body.legalName,
        contactEmail: body.email,
        contactPhone: body.contactPhone,
        websiteUrl: body.websiteUrl,
        addressLine1: body.addressLine1,
        addressLine2: body.addressLine2,
        city: body.city,
        region: body.region,
        postalCode: body.postalCode,
        country: body.country,
        services: body.services ?? [],
        serviceAreas: body.serviceAreas ?? [],
        iban: body.iban,
        bic: body.bic,
        taxId: body.taxId,
        vatId: body.vatId,
        internalNotes: body.internalNotes,
        status: 'pending',
      })
      .returning();

    reply.code(201);
    return { partner: row, userCreated: !existingUser };
  });

  app.patch('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = updateStatusSchema.parse(request.body);
    const adminId = request.authUser!.id;
    const { partners } = request.company!.tables;
    const now = new Date();
    const patch: Record<string, unknown> = { updatedAt: now };
    if (body.status !== undefined) patch.status = body.status;
    if (body.internalNotes !== undefined) patch.internalNotes = body.internalNotes;
    if (body.tier !== undefined) patch.tier = body.tier;
    if (body.monthlyFeeCents !== undefined) patch.monthlyFeeCents = body.monthlyFeeCents;
    if (body.score !== undefined) patch.score = body.score;
    if (body.status === 'active') {
      patch.approvedAt = now;
      patch.approvedByUserId = adminId;
    }
    if (body.status === 'suspended') patch.suspendedAt = now;
    const [row] = await db.update(partners).set(patch).where(eq(partners.id, id)).returning();
    if (!row) throw notFound('Partner not found');
    return { partner: row };
  });
};
