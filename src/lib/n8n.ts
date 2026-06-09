import type { FastifyBaseLogger } from 'fastify';

import { captureException } from './observability.js';

// Fire-and-forget POST to an n8n webhook. No-op when url is unset.
export async function fireN8nWebhook(
  url: string | undefined,
  payload: Record<string, unknown>,
  log?: FastifyBaseLogger,
): Promise<void> {
  if (!url) return;
  try {
    const res = await fetch(url, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify(payload),
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
