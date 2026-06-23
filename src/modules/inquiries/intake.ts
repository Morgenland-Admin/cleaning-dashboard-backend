import { sql } from 'drizzle-orm';
import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { linkCustomerByEmail } from '../../lib/customers.js';
import { buildCallbackFields, notifyInquiryCreated } from './routes.js';

// Machine-to-machine intake for the voice-AI / web-form callback funnel (via n8n):
// creates an inquiry, runs the same geo-routing as the public form, and returns
// the routing decision. Auth is a shared X-Intake-Token, not a user session.

const intakeSchema = z
  .object({
    // Phone leads may lack email/name; require phone OR email (see refine below).
    name: z.string().min(1).max(120).optional(),
    email: z.string().email().max(254).optional(),
    phone: z.string().max(32).optional(),
    service: z.string().max(200).optional(),
    message: z.string().min(1).max(5000).optional(),
    callReason: z.string().max(2000).optional(), // "Grund des Anrufs" from the AI
    // Service PLZ — drives routing.
    plz: z
      .string()
      .regex(/^\d{5}$/, 'plz must be exactly 5 digits')
      .optional(),
    preferredDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'preferredDate must be YYYY-MM-DD')
      .optional(),
    source: z.string().max(64).optional(),
    locale: z.string().min(2).max(16).optional(),
    consentPrivacy: z.boolean().optional(), // prior consent assumed; default true

    consentMarketing: z.boolean().optional(),
    metadata: z.record(z.string().max(120), z.unknown()).optional(),
  })
  .refine((b) => Boolean(b.phone?.trim() || b.email?.trim()), {
    message: 'Either phone or email is required',
    path: ['phone'],
  });

// Constant-time compare, tolerant of length mismatch.
function tokenMatches(provided: string, expected: string): boolean {
  const a = Buffer.from(provided);
  const b = Buffer.from(expected);
  if (a.length !== b.length) return false;
  return timingSafeEqual(a, b);
}

export const inquiriesIntakeRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', async (request: FastifyRequest, reply: FastifyReply) => {
    if (!env.INQUIRY_INTAKE_TOKEN) {
      reply.code(503).send({ error: 'Intake endpoint is not configured' });
      return;
    }
    const header = request.headers['x-intake-token'];
    const provided = Array.isArray(header) ? header[0] : header;
    if (!provided || !tokenMatches(provided, env.INQUIRY_INTAKE_TOKEN)) {
      reply.code(401).send({ error: 'Invalid intake token' });
      return;
    }
  });
  app.addHook('preHandler', app.resolveCompanyPublic);

  app.post(
    '/',
    {
      bodyLimit: 64 * 1024,
      // Token-gated, but cap anyway against a leaked token / runaway loop.
      config: { rateLimit: { max: 60, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      const body = intakeSchema.parse(request.body);
      const { serviceInquiries, customers } = request.company!.tables;

      // Idempotency: the funnel may retry — return the existing lead if the
      // call id was already recorded, instead of duplicating it.
      const retellCallId =
        typeof body.metadata?.retellCallId === 'string' ? body.metadata.retellCallId : null;
      if (retellCallId) {
        const [dup] = await db
          .select()
          .from(serviceInquiries)
          .where(sql`${serviceInquiries.metadata} ->> 'retellCallId' = ${retellCallId}`)
          .limit(1);
        if (dup) {
          const r = buildCallbackFields(dup.plz, dup.callReason);
          reply.code(200);
          return {
            ok: true,
            deduped: true,
            inquiry: dup,
            routing: {
              callbackOwner: r.callbackOwner,
              assignedTo: r.assignedTo,
              distanceKm: r.geoMeta.distanceKm,
              geoStatus: r.geoMeta.geoStatus,
            },
          };
        }
      }

      // Nameless phone leads still need a dashboard label.
      const name = body.name?.trim() || 'Telefon-Lead';
      const email = body.email?.trim() || null;

      const consentMarketing = body.consentMarketing ?? false;
      // No email ⇒ can't dedupe a customer; the inquiry stands alone.
      const customerId = email
        ? await linkCustomerByEmail(db, customers, {
            email,
            name: body.name,
            phone: body.phone,
            marketingOptIn: consentMarketing,
          })
        : null;

      const { plz, callReason, callbackOwner, assignedTo, geoMeta } = buildCallbackFields(
        body.plz,
        body.callReason,
      );

      // Funnel records consent before calling; default true, caller can override.
      const consentPrivacy = body.consentPrivacy ?? true;

      const [row] = await db
        .insert(serviceInquiries)
        .values({
          customerId,
          name,
          email,
          phone: body.phone,
          service: body.service,
          preferredDate: body.preferredDate,
          message: body.message ?? body.callReason ?? '(kein Text)',
          locale: body.locale ?? 'de',
          source: body.source ?? 'ai_phone',
          plz,
          callReason,
          callbackOwner,
          assignedTo,
          metadata: { ...(body.metadata ?? {}), geo: geoMeta },
          consentPrivacy,
          consentMarketing,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        })
        .returning();

      if (row) {
        await notifyInquiryCreated(request.company!.slug, row, request.log);
      }

      reply.code(201);
      return {
        ok: true,
        inquiry: row,
        routing: {
          callbackOwner,
          assignedTo,
          distanceKm: geoMeta.distanceKm,
          geoStatus: geoMeta.geoStatus,
        },
      };
    },
  );
};
