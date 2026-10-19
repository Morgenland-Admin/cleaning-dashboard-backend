import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { Resend } from 'resend';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { isValidCompanySlug } from '../../config/companies.js';
import { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import { recordDeliveryEvent, type DeliveryEvent } from '../../email/log.js';

// Resend → us: delivery status for email_log. One endpoint per Resend account (free plan: one webhook each);
// the account only selects the signing secret (brand secret, or RESEND_WEBHOOK_SECRET for "system").
// Rows are matched by Resend's email id alone, unique across accounts.

const verifier = new Resend('re_webhook_verify_only');

// A webhook can beat our own email_log insert: an unknown id on a fresh event gets 503 so Resend retries;
// an old unknown one is acknowledged and dropped (refusing it forever would get the endpoint disabled).
export const UNKNOWN_EMAIL_RETRY_WINDOW_MS = 2 * 60_000;

const payloadSchema = z.object({
  type: z.string(),
  created_at: z.string(),
  data: z
    .object({
      email_id: z.string().optional(),
      bounce: z.object({ message: z.string().optional() }).partial().optional(),
      failed: z.object({ reason: z.string().optional() }).partial().optional(),
      suppressed: z.object({ message: z.string().optional() }).partial().optional(),
      click: z.object({ link: z.string().optional() }).partial().optional(),
    })
    .passthrough(),
});

type ResendPayload = z.infer<typeof payloadSchema>;

const TRACKED_TYPES = new Set([
  'email.sent',
  'email.delivered',
  'email.delivery_delayed',
  'email.bounced',
  'email.complained',
  'email.failed',
  'email.suppressed',
  'email.opened',
  'email.clicked',
]);

export function toDeliveryEvent(payload: ResendPayload): DeliveryEvent | null {
  if (!TRACKED_TYPES.has(payload.type)) return null;
  const at = new Date(payload.created_at);
  if (Number.isNaN(at.getTime())) return null;
  const d = payload.data;
  const detail =
    d.bounce?.message ?? d.failed?.reason ?? d.suppressed?.message ?? d.click?.link ?? undefined;
  return {
    type: payload.type.slice('email.'.length),
    at,
    ...(detail ? { detail: detail.slice(0, 500) } : {}),
  };
}

async function signingSecretFor(account: string): Promise<string | null> {
  if (account === 'system') return env.RESEND_WEBHOOK_SECRET ?? null;
  if (!isValidCompanySlug(account)) return null;
  const [row] = await db
    .select({ secret: company.resendWebhookSecret })
    .from(company)
    .where(eq(company.slug, account))
    .limit(1);
  return row?.secret ?? null;
}

function header(value: string | string[] | undefined): string | undefined {
  return Array.isArray(value) ? value[0] : value;
}

export const resendWebhookRoutes: FastifyPluginAsync = async (app) => {
  // Signatures cover the exact bytes Resend sent — keep the body raw.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'string' }, (_req, body, done) => {
    done(null, body);
  });

  app.post(
    '/resend/:account',
    { config: { rateLimit: { max: 600, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { account } = request.params as { account: string };
      const secret = await signingSecretFor(account);
      if (!secret) {
        reply.code(404).send({ error: 'Webhook not configured' });
        return;
      }

      // Resend signs with Svix; accept the standard-webhooks names too.
      const h = request.headers;
      const id = header(h['svix-id']) ?? header(h['webhook-id']);
      const timestamp = header(h['svix-timestamp']) ?? header(h['webhook-timestamp']);
      const signature = header(h['svix-signature']) ?? header(h['webhook-signature']);
      if (!id || !timestamp || !signature) {
        reply.code(400).send({ error: 'Missing signature headers' });
        return;
      }

      let raw: unknown;
      try {
        raw = verifier.webhooks.verify({
          payload: request.body as string,
          headers: { id, timestamp, signature },
          webhookSecret: secret,
        });
      } catch (err) {
        request.log.warn({ err, account }, 'Resend webhook signature verification failed');
        reply.code(400).send({ error: 'Invalid signature' });
        return;
      }

      const parsed = payloadSchema.safeParse(raw);
      const event = parsed.success ? toDeliveryEvent(parsed.data) : null;
      const emailId = parsed.success ? parsed.data.data.email_id : undefined;
      if (!event || !emailId) {
        reply.send({ ok: true, ignored: true });
        return;
      }

      const matched = await recordDeliveryEvent(emailId, event);
      if (!matched && Date.now() - event.at.getTime() < UNKNOWN_EMAIL_RETRY_WINDOW_MS) {
        reply.code(503).send({ error: 'Email not logged yet — retry' });
        return;
      }
      reply.send({ ok: true, matched });
    },
  );
};
