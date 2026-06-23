import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';
import { timingSafeEqual } from 'node:crypto';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { linkCustomerByEmail } from '../../lib/customers.js';
import { buildCallbackFields, notifyInquiryCreated } from './routes.js';

/**
 * Machine-to-machine intake for the voice-AI / web-form callback funnel.
 *
 * This is the connector the AI funnel calls (typically via n8n): it creates an
 * inquiry with the service PLZ + call reason, runs the same geo-routing as the
 * public form, and returns the routing decision so the caller knows whether the
 * lead went to a human or the AI queue.
 *
 * Auth is a shared service token (X-Intake-Token), NOT a user session — the
 * caller is a machine. The brand is selected with the usual X-Company-Slug
 * header (resolveCompanyPublic). CORS is irrelevant here (server-to-server).
 */

const intakeSchema = z
  .object({
    // Voice-AI phone leads often have no email and sometimes no name — the core
    // of a phone lead is phone + reason + PLZ. Both are optional here; a missing
    // name falls back to a placeholder on insert. We only require that the lead
    // be reachable somehow (see the refine below).
    name: z.string().min(1).max(120).optional(),
    email: z.string().email().max(254).optional(),
    phone: z.string().max(32).optional(),
    service: z.string().max(200).optional(),
    message: z.string().min(1).max(5000).optional(),
    /** "Grund des Anrufs" captured by the inbound AI. */
    callReason: z.string().max(2000).optional(),
    /** Service PLZ (where the cleaning happens) — drives routing. */
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
    /** AI calls only happen with prior consent; default true, overridable. */
    consentPrivacy: z.boolean().optional(),
    consentMarketing: z.boolean().optional(),
    metadata: z.record(z.string().max(120), z.unknown()).optional(),
  })
  .refine((b) => Boolean(b.phone?.trim() || b.email?.trim()), {
    message: 'Either phone or email is required',
    path: ['phone'],
  });

/** Constant-time comparison that tolerates length mismatch. */
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

  app.post('/', { bodyLimit: 64 * 1024 }, async (request, reply) => {
    const body = intakeSchema.parse(request.body);
    const { serviceInquiries, customers } = request.company!.tables;

    // Phone leads with no name still need a human-readable label in the dashboard.
    const name = body.name?.trim() || 'Telefon-Lead';
    const email = body.email?.trim() || null;

    const consentMarketing = body.consentMarketing ?? false;
    // Without an email we can't dedupe a customer; the inquiry stands on its own.
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

    // The AI funnel records consent before placing a call; default to true so a
    // routed lead is callable, but let the caller override explicitly.
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
  });
};
