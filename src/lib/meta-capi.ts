import { createHash } from 'node:crypto';
import { z } from 'zod';
import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import { captureException } from './observability.js';

const GRAPH_API_VERSION = 'v21.0';

// Forwarded by the storefront only after marketing consent — its presence is
// the consent signal. eventId is shared with the browser Pixel for dedup.
export const metaEventContextSchema = z.object({
  eventId: z.string().min(1).max(100),
  eventSourceUrl: z.string().url().max(2000).optional(),
  fbp: z.string().max(200).optional(),
  fbc: z.string().max(400).optional(),
});

export type MetaEventContext = z.infer<typeof metaEventContextSchema>;

interface BrandMetaConfig {
  pixelId: string;
  accessToken: string;
  testEventCode?: string;
}

// Per-brand CAPI creds from env, like the Resend keys. Unconfigured ⇒ no-op.
function brandMetaConfig(companySlug: string): BrandMetaConfig | null {
  let pixelId: string | undefined;
  let accessToken: string | undefined;
  let testEventCode: string | undefined;

  switch (companySlug) {
    case 'hamburg_teppichreinigung':
      pixelId = env.META_PIXEL_ID_HAMBURG;
      accessToken = env.META_CAPI_TOKEN_HAMBURG;
      testEventCode = env.META_TEST_EVENT_CODE_HAMBURG;
      break;
    default:
      return null;
  }

  if (!pixelId || !accessToken) return null;
  return { pixelId, accessToken, testEventCode };
}

export function metaCapiConfigured(companySlug: string): boolean {
  return brandMetaConfig(companySlug) !== null;
}

// SHA-256 of the normalized value, per Meta's Advanced Matching spec.
function hashField(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const normalized = raw.trim().toLowerCase();
  if (!normalized) return undefined;
  return createHash('sha256').update(normalized).digest('hex');
}

// Phone: digits only before hashing (no country code guessing).
function hashPhone(raw: string | null | undefined): string | undefined {
  if (!raw) return undefined;
  const digits = raw.replace(/\D/g, '');
  if (!digits) return undefined;
  return createHash('sha256').update(digits).digest('hex');
}

export interface MetaServerEventInput {
  eventName: 'Lead' | 'Purchase' | (string & {});
  eventId: string;
  eventSourceUrl?: string | null;
  email?: string | null;
  phone?: string | null;
  fbp?: string | null;
  fbc?: string | null;
  clientIpAddress?: string | null;
  clientUserAgent?: string | null;
  customData?: Record<string, unknown>;
  eventTime?: number;
}

// Fire one server-side CAPI event. Best-effort: any failure is logged and
// swallowed so tracking never breaks a checkout or form submit.
export async function sendMetaServerEvent(
  companySlug: string,
  input: MetaServerEventInput,
  log: FastifyBaseLogger,
): Promise<void> {
  const config = brandMetaConfig(companySlug);
  if (!config) return;

  const userData: Record<string, unknown> = {};
  const em = hashField(input.email);
  const ph = hashPhone(input.phone);
  if (em) userData.em = [em];
  if (ph) userData.ph = [ph];
  // fbp/fbc/ip/ua are passed verbatim — not hashed.
  if (input.fbp) userData.fbp = input.fbp;
  if (input.fbc) userData.fbc = input.fbc;
  if (input.clientIpAddress) userData.client_ip_address = input.clientIpAddress;
  if (input.clientUserAgent) userData.client_user_agent = input.clientUserAgent;

  const eventTime = input.eventTime ?? Math.floor(Date.now() / 1000);

  const body = {
    data: [
      {
        event_name: input.eventName,
        event_time: eventTime,
        event_id: input.eventId,
        action_source: 'website',
        ...(input.eventSourceUrl ? { event_source_url: input.eventSourceUrl } : {}),
        user_data: userData,
        ...(input.customData ? { custom_data: input.customData } : {}),
      },
    ],
    // Routes to Events Manager → Test Events instead of counting as real.
    ...(config.testEventCode ? { test_event_code: config.testEventCode } : {}),
  };

  const url = `https://graph.facebook.com/${GRAPH_API_VERSION}/${config.pixelId}/events?access_token=${encodeURIComponent(config.accessToken)}`;

  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(body),
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      const detail = await res.text().catch(() => '');
      log.warn(
        {
          status: res.status,
          eventName: input.eventName,
          eventId: input.eventId,
          detail: detail.slice(0, 500),
        },
        'Meta CAPI event rejected',
      );
      return;
    }
    log.info({ eventName: input.eventName, eventId: input.eventId }, 'Meta CAPI event sent');
  } catch (err) {
    log.warn({ err, eventName: input.eventName, eventId: input.eventId }, 'Meta CAPI event failed');
    captureException(err, { context: 'meta-capi', eventName: input.eventName });
  }
}
