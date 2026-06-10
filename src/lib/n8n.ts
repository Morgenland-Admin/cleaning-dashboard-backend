import { createHmac } from 'node:crypto';
import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import { captureException } from './observability.js';

/**
 * HMAC over the raw body — the URL alone is not a secret.
 * Verify in n8n: sha256=hex(hmac_sha256(secret, rawBody)).
 */
function signPayload(body: string): string {
  const secret = env.N8N_WEBHOOK_SECRET ?? env.BETTER_AUTH_SECRET;
  return `sha256=${createHmac('sha256', secret).update(body).digest('hex')}`;
}

// Fire-and-forget POST to an n8n webhook. No-op when url is unset.
export async function fireN8nWebhook(
  url: string | undefined,
  payload: Record<string, unknown>,
  log?: FastifyBaseLogger,
): Promise<void> {
  if (!url) return;
  try {
    const body = JSON.stringify(payload);
    const res = await fetch(url, {
      method: 'POST',
      headers: {
        'content-type': 'application/json',
        'x-mgl-signature': signPayload(body),
      },
      body,
      signal: AbortSignal.timeout(5000),
    });
    if (!res.ok) {
      log?.warn({ status: res.status, event: payload.event }, 'n8n webhook returned non-2xx');
    }
  } catch (err) {
    const event = typeof payload.event === 'string' ? payload.event : undefined;
    log?.warn({ err, event }, 'n8n webhook failed');
    captureException(err, { context: 'n8n-webhook', event });
  }
}
