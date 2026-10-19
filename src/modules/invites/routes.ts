import type { FastifyPluginAsync } from 'fastify';
import { randomBytes } from 'node:crypto';
import { and, eq, gte } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { auth } from '../../auth/index.js';
import { env } from '../../config/env.js';
import { isValidCompanySlug } from '../../config/companies.js';
import { db } from '../../db/index.js';
import { account, company, membership, user, verification } from '../../db/schema/shared.js';
import { adminSender, brandInfoFromCompany, brandSender, sendEmail } from '../../email/service.js';
import { inviteEmail, partnerInviteEmail } from '../../email/templates.js';
import { geocodePlz } from '../../lib/geo.js';
import { badRequest, conflict, notFound } from '../../lib/http-errors.js';

const ROLES = ['owner', 'admin', 'manager', 'viewer', 'partner'] as const;
const AUDIENCES = ['admin', 'partner'] as const;
const ACCESS_LEVELS = ['super_admin', 'admin', 'manager', 'seo', 'viewer', 'none'] as const;

const partnerPrefillSchema = z.object({
  companyName: z.string().min(1).max(200),
  contactPhone: z.string().max(32).optional(),
  websiteUrl: z.string().url().optional(),
  city: z.string().max(120).optional(),
  postalCode: z.string().max(20).optional(),
  serviceRadiusKm: z.number().int().min(5).max(300).optional(),
  services: z.array(z.string().max(80)).max(60).optional(),
});

const createInviteSchema = z.object({
  email: z.string().email(),
  companySlug: z.string().min(1).max(63),
  role: z.enum(ROLES).default('viewer'),
  audience: z.enum(AUDIENCES).default('admin'),
  accessLevel: z.enum(ACCESS_LEVELS).default('viewer'),
  partner: partnerPrefillSchema.optional(),
});

const INVITE_TTL_MS = 7 * 24 * 60 * 60 * 1000;

function inviteIdentifier(token: string): string {
  return `invite:${token}`;
}

interface InvitePayload {
  email: string;
  companySlug: string;
  role: (typeof ROLES)[number];
  audience: (typeof AUDIENCES)[number];
  accessLevel: (typeof ACCESS_LEVELS)[number];
  invitedByUserId: string;
  invitedByName: string;
  /** When set, accept creates a partners row in the tenant schema. */
  partner?: z.infer<typeof partnerPrefillSchema>;
}

export interface IssueInviteInput {
  email: string;
  companySlug: string;
  role: (typeof ROLES)[number];
  audience: (typeof AUDIENCES)[number];
  accessLevel: (typeof ACCESS_LEVELS)[number];
  partner?: z.infer<typeof partnerPrefillSchema>;
  inviter: { id: string; name: string };
}

/** Stores the invite token and mails it; partner invites go out branded, linking to the brand's portal. */
export async function issueInvite(input: IssueInviteInput): Promise<{ expiresAt: Date }> {
  const [companyRow] = await db
    .select()
    .from(company)
    .where(eq(company.slug, input.companySlug))
    .limit(1);
  if (!companyRow) throw notFound('Company not found');

  const [existingUser] = await db.select().from(user).where(eq(user.email, input.email)).limit(1);
  if (existingUser) {
    const [m] = await db
      .select()
      .from(membership)
      .where(
        and(eq(membership.userId, existingUser.id), eq(membership.companySlug, input.companySlug)),
      )
      .limit(1);
    if (m) throw conflict('User is already a member of this company');
  }

  const token = randomBytes(24).toString('base64url');
  const payload: InvitePayload = {
    email: input.email,
    companySlug: input.companySlug,
    role: input.role,
    audience: input.audience,
    accessLevel: input.accessLevel,
    invitedByUserId: input.inviter.id,
    invitedByName: input.inviter.name,
    partner: input.partner,
  };
  const expiresAt = new Date(Date.now() + INVITE_TTL_MS);

  await db.insert(verification).values({
    id: `invite_${token}`,
    identifier: inviteIdentifier(token),
    value: JSON.stringify(payload),
    expiresAt,
  });

  const portal = companyRow.partnerPortalOrigin?.replace(/\/$/, '');
  const log = {
    companySlug: companyRow.slug,
    kind: 'invite' as const,
    sentByUserId: input.inviter.id,
  };
  try {
    if (input.audience === 'partner' && portal) {
      await sendEmail({
        to: input.email,
        from: brandSender(companyRow),
        apiKey: companyRow.resendApiKey ?? undefined,
        replyTo: companyRow.email ?? undefined,
        log,
        email: partnerInviteEmail({
          brand: brandInfoFromCompany(companyRow),
          companyName: input.partner?.companyName ?? null,
          inviteUrl: `${portal}/einladung?token=${encodeURIComponent(token)}`,
        }),
      });
    } else {
      const inviteUrl = `${env.APP_BASE_URL.replace(/\/$/, '')}/accept-invite?token=${encodeURIComponent(token)}`;
      await sendEmail({
        to: input.email,
        from: adminSender(),
        log,
        email: inviteEmail({
          inviterName: input.inviter.name,
          inviteUrl,
          brandName: companyRow.name,
        }),
      });
    }
  } catch (err) {
    console.warn('[invites] failed to send invite email', err);
  }
  return { expiresAt };
}

export const invitesAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('admin'));

  app.post('/', async (request, reply) => {
    const body = createInviteSchema.parse(request.body);
    if (!isValidCompanySlug(body.companySlug)) {
      throw badRequest('Invalid companySlug');
    }
    const inviter = request.authUser!;
    const inviterMeta = inviter as unknown as { accessLevel?: string };
    const isSuperAdmin = inviterMeta.accessLevel === 'super_admin';

    if (!isSuperAdmin) {
      const [m] = await db
        .select()
        .from(membership)
        .where(and(eq(membership.userId, inviter.id), eq(membership.companySlug, body.companySlug)))
        .limit(1);
      if (!m || (m.role !== 'owner' && m.role !== 'admin')) {
        reply.code(403).send({ error: 'Forbidden — must be owner/admin on this company' });
        return;
      }
      // Privilege ceiling: accessLevel is platform-wide, so only a super_admin may mint a super_admin
      // (a tenant owner/admin granting it would bypass every membership check).
      if (body.accessLevel === 'super_admin') {
        reply
          .code(403)
          .send({ error: 'Forbidden — only a super_admin may grant super_admin access' });
        return;
      }
    }

    const { expiresAt } = await issueInvite({
      email: body.email,
      companySlug: body.companySlug,
      role: body.role,
      audience: body.audience,
      accessLevel: body.accessLevel,
      partner: body.partner,
      inviter: { id: inviter.id, name: (inviter as { name?: string }).name ?? 'Admin' },
    });

    reply.code(201);
    return {
      invite: {
        email: body.email,
        companySlug: body.companySlug,
        role: body.role,
        expiresAt: expiresAt.toISOString(),
      },
    };
  });
};

const acceptInviteSchema = z.object({
  token: z.string().min(8).max(200),
  password: z.string().min(8).max(200),
  firstName: z.string().min(1).max(120),
  lastName: z.string().min(1).max(120).optional(),
});

export const invitesPublicRoutes: FastifyPluginAsync = async (app) => {
  const queryGet = z.object({ token: z.string().min(8).max(200) });
  app.get(
    '/',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const q = queryGet.safeParse(request.query);
      if (!q.success) {
        reply.code(400).send({ error: 'Invalid token' });
        return;
      }
      const now = new Date();
      const [v] = await db
        .select()
        .from(verification)
        .where(
          and(
            eq(verification.identifier, inviteIdentifier(q.data.token)),
            gte(verification.expiresAt, now),
          ),
        )
        .limit(1);
      if (!v) {
        reply.code(410).send({ error: 'Invite expired or not found' });
        return;
      }
      let payload: InvitePayload;
      try {
        payload = JSON.parse(v.value);
      } catch {
        reply.code(500).send({ error: 'Invite payload malformed' });
        return;
      }
      const [companyRow] = await db
        .select({ slug: company.slug, name: company.name })
        .from(company)
        .where(eq(company.slug, payload.companySlug))
        .limit(1);
      return {
        invite: {
          email: payload.email,
          companyName: companyRow?.name ?? null,
          companySlug: payload.companySlug,
          role: payload.role,
          invitedByName: payload.invitedByName,
          expiresAt: v.expiresAt.toISOString(),
        },
      };
    },
  );

  app.post(
    '/accept',
    { config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = acceptInviteSchema.parse(request.body);
      const now = new Date();
      const [v] = await db
        .select()
        .from(verification)
        .where(
          and(
            eq(verification.identifier, inviteIdentifier(body.token)),
            gte(verification.expiresAt, now),
          ),
        )
        .limit(1);
      if (!v) {
        reply.code(410).send({ error: 'Invite expired or not found' });
        return;
      }
      let payload: InvitePayload;
      try {
        payload = JSON.parse(v.value);
      } catch {
        reply.code(500).send({ error: 'Invite payload malformed' });
        return;
      }

      const [existing] = await db.select().from(user).where(eq(user.email, payload.email)).limit(1);
      let userId: string;
      if (existing) {
        userId = existing.id;
        const [existingCredential] = await db
          .select()
          .from(account)
          .where(and(eq(account.userId, userId), eq(account.providerId, 'credential')))
          .limit(1);
        if (!existingCredential) {
          const hashed = await auth.$context.then((ctx) => ctx.password.hash(body.password));
          await db.insert(account).values({
            id: nanoid(),
            userId,
            providerId: 'credential',
            accountId: userId,
            password: hashed,
          });

          await db
            .update(user)
            .set({
              firstName: body.firstName,
              lastName: body.lastName ?? null,
              audience: payload.audience,
              accessLevel: payload.accessLevel,
              emailVerified: true,
              isActive: true,
              invitedByUserId: payload.invitedByUserId,
              updatedAt: now,
            })
            .where(eq(user.id, userId));
        }
      } else {
        const name = body.lastName
          ? `${body.firstName} ${body.lastName}`.trim()
          : body.firstName.trim();
        userId = nanoid();
        const hashed = await auth.$context.then((ctx) => ctx.password.hash(body.password));
        await db.insert(user).values({
          id: userId,
          name,
          email: payload.email,
          firstName: body.firstName,
          lastName: body.lastName ?? null,
          audience: payload.audience,
          accessLevel: payload.accessLevel,
          emailVerified: true,
          isActive: true,
          invitedByUserId: payload.invitedByUserId,
        });
        await db.insert(account).values({
          id: nanoid(),
          userId,
          providerId: 'credential',
          accountId: userId,
          password: hashed,
        });
      }

      await db
        .insert(membership)
        .values({
          userId,
          companySlug: payload.companySlug,
          role: payload.role,
          invitedByUserId: payload.invitedByUserId,
          invitedAt: v.createdAt,
          acceptedAt: now,
        })
        .onConflictDoUpdate({
          target: [membership.userId, membership.companySlug],
          set: { role: payload.role, acceptedAt: now },
        });

      if (payload.partner) {
        const { loadCompany } = await import('../../lib/company-loader.js');
        const { getTenantTables } = await import('../../db/schema/tenant.js');
        const companyRow = await loadCompany(payload.companySlug);
        if (companyRow) {
          const tables = getTenantTables(companyRow.schemaName);
          const { partners } = tables;
          const coords = geocodePlz(payload.partner.postalCode);
          await db
            .insert(partners)
            .values({
              userId,
              companyName: payload.partner.companyName,
              contactEmail: payload.email,
              contactPhone: payload.partner.contactPhone,
              websiteUrl: payload.partner.websiteUrl,
              city: payload.partner.city,
              postalCode: payload.partner.postalCode,
              lat: coords?.lat ?? null,
              lng: coords?.lng ?? null,
              serviceRadiusKm: payload.partner.serviceRadiusKm ?? 30,
              services: payload.partner.services ?? [],
              status: 'pending',
            })
            .onConflictDoNothing();
          // A returning partner from the old CLEANILO system gets their old admin chat back.
          try {
            const { attachLegacyPartnerChat } = await import('../legacy/partner-chat.js');
            const added = await attachLegacyPartnerChat(tables, {
              userId,
              email: payload.email,
              phone: payload.partner.contactPhone,
            });
            if (added) request.log.info({ added }, 'legacy partner chat attached');
          } catch (err) {
            request.log.warn({ err }, 'legacy partner chat attach failed');
          }
        }
      }

      await db.delete(verification).where(eq(verification.id, v.id));

      reply.code(201);
      return { ok: true, companySlug: payload.companySlug };
    },
  );
};
