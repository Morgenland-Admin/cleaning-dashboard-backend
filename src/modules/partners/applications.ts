import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { partnerApplicationAckEmail } from '../../email/templates.js';
import { brandInfoFromCompany, brandSender, sendEmail } from '../../email/service.js';
import { accessLevelOf, redactForViewer, redactListForViewer } from '../../lib/access.js';
import { conflict, notFound, parseIntId } from '../../lib/http-errors.js';
import { spawnTask } from '../../lib/tasks.js';
import { validateServiceSlugs } from '../service-catalog/routes.js';
import { issueInvite } from '../invites/routes.js';
import { loadCompanyFull } from './lib.js';

const applicationSchema = z.object({
  companyName: z.string().trim().min(1).max(200),
  contactName: z.string().trim().min(1).max(200),
  email: z.string().trim().email().max(200),
  phone: z.string().trim().max(32).optional(),
  websiteUrl: z.string().trim().url().max(300).optional(),
  legalForm: z.string().trim().max(64).optional(),
  postalCode: z
    .string()
    .trim()
    .regex(/^\d{5}$/),
  city: z.string().trim().max(120).optional(),
  serviceRadiusKm: z.number().int().min(5).max(300).optional(),
  services: z.array(z.string().max(80)).min(1).max(60),
  employeeCount: z.string().trim().max(16).optional(),
  message: z.string().trim().max(4000).optional(),
  consentPrivacy: z.literal(true, {
    errorMap: () => ({ message: 'Privacy consent is required' }),
  }),
  source: z.string().trim().max(64).optional(),
  // Honeypot: bots fill it, people never see it.
  website: z.string().max(200).optional(),
});

const listQuerySchema = z.object({
  status: z.enum(['new', 'invited', 'rejected']).optional(),
});

const rejectSchema = z.object({ reason: z.string().trim().max(1000).optional() });

export const partnerApplicationsPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  app.post(
    '/',
    { bodyLimit: 32 * 1024, config: { rateLimit: { max: 3, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = applicationSchema.parse(request.body);
      if (body.website) {
        reply.code(201).send({ ok: true });
        return;
      }
      const tables = request.company!.tables;
      const services = (await validateServiceSlugs(tables, body.services)) ?? [];
      const ua = request.headers['user-agent'];
      const [row] = await db
        .insert(tables.partnerApplications)
        .values({
          companyName: body.companyName,
          contactName: body.contactName,
          email: body.email.toLowerCase(),
          phone: body.phone,
          websiteUrl: body.websiteUrl,
          legalForm: body.legalForm,
          postalCode: body.postalCode,
          city: body.city,
          serviceRadiusKm: body.serviceRadiusKm ?? 30,
          services,
          employeeCount: body.employeeCount,
          message: body.message,
          consentPrivacy: true,
          source: body.source ?? 'storefront',
          ipAddress: request.ip,
          userAgent: typeof ua === 'string' ? ua.slice(0, 500) : null,
        })
        .returning({ id: tables.partnerApplications.id });
      const slug = request.company!.slug;

      void spawnTask({
        companySlug: slug,
        kind: 'partner_application',
        refKind: 'partner_application',
        refId: row!.id,
        title: `Partnerbewerbung: ${body.companyName} (${body.postalCode})`,
        body: `${body.contactName} · ${services.length} Leistungen · Umkreis ${body.serviceRadiusKm ?? 30} km`,
      }).catch((err) => request.log.warn({ err }, 'partner application task failed'));

      void import('../../lib/push.js')
        .then(({ sendPushToBrandAdmins }) =>
          sendPushToBrandAdmins(slug, {
            title: `${request.company!.name} · Neue Partnerbewerbung`,
            body: `${body.companyName} · ${body.postalCode} ${body.city ?? ''}`.trim(),
            url: '/partner?tab=bewerbungen',
            tag: `partner-application:${row!.id}`,
            brandSlug: slug,
          }),
        )
        .catch((err) => request.log.warn({ err }, 'partner application push failed'));

      const companyRow = await loadCompanyFull(slug);
      if (companyRow) {
        void sendEmail({
          to: body.email,
          from: brandSender(companyRow),
          apiKey: companyRow.resendApiKey ?? undefined,
          replyTo: companyRow.email ?? undefined,
          log: { companySlug: slug, kind: 'partner_application_ack' },
          email: partnerApplicationAckEmail({
            brand: brandInfoFromCompany(companyRow),
            contactName: body.contactName,
          }),
        }).catch(() => null);
      }

      reply.code(201).send({ ok: true });
    },
  );
};

export const partnerApplicationsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', app.requireWriteAccess);

  app.get('/', async (request) => {
    const { status } = listQuerySchema.parse(request.query);
    const { partnerApplications: a } = request.company!.tables;
    const rows = await db
      .select()
      .from(a)
      .where(status ? eq(a.status, status) : undefined)
      .orderBy(desc(a.createdAt))
      .limit(200);
    // Applicant IP/user-agent are hidden from viewers.
    return { applications: redactListForViewer(rows, accessLevelOf(request)) };
  });

  app.get('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { partnerApplications: a } = request.company!.tables;
    const [row] = await db.select().from(a).where(eq(a.id, id)).limit(1);
    if (!row) throw notFound('Application not found');
    return { application: redactForViewer(row, accessLevelOf(request)) };
  });

  // Sends a partner invite prefilled from the application; accepting it creates the pending partner.
  app.post('/:id/invite', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { partnerApplications: a } = request.company!.tables;
    const [row] = await db.select().from(a).where(eq(a.id, id)).limit(1);
    if (!row) throw notFound('Application not found');
    if (row.status !== 'new') throw conflict(`Application is already ${row.status}`);
    const inviter = request.authUser!;
    const { expiresAt } = await issueInvite({
      email: row.email,
      companySlug: request.company!.slug,
      role: 'partner',
      audience: 'partner',
      accessLevel: 'none',
      partner: {
        companyName: row.companyName,
        contactPhone: row.phone ?? undefined,
        websiteUrl: row.websiteUrl ?? undefined,
        city: row.city ?? undefined,
        postalCode: row.postalCode,
        serviceRadiusKm: row.serviceRadiusKm,
        services: row.services,
      },
      inviter: { id: inviter.id, name: (inviter as { name?: string }).name ?? 'Admin' },
    });
    const now = new Date();
    const [updated] = await db
      .update(a)
      .set({ status: 'invited', invitedAt: now, handledByUserId: inviter.id, updatedAt: now })
      .where(and(eq(a.id, id), eq(a.status, 'new')))
      .returning();
    return { application: updated, inviteExpiresAt: expiresAt.toISOString() };
  });

  app.post('/:id/reject', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { reason } = rejectSchema.parse(request.body ?? {});
    const { partnerApplications: a } = request.company!.tables;
    const now = new Date();
    const [row] = await db
      .update(a)
      .set({
        status: 'rejected',
        rejectionReason: reason ?? null,
        handledByUserId: request.authUser!.id,
        updatedAt: now,
      })
      .where(and(eq(a.id, id), eq(a.status, 'new')))
      .returning();
    if (!row) throw conflict('Application not found or already handled');
    return { application: row };
  });
};
