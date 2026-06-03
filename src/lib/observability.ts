import { env } from '../config/env.js';

interface SentryLike {
  init(opts: { dsn: string; environment?: string; tracesSampleRate?: number }): void;
  captureException(err: unknown, hint?: { extra?: Record<string, unknown> }): void;
  captureMessage(msg: string, ctx?: unknown): void;
}

let sentry: SentryLike | null = null;
let initialised = false;

export async function initObservability(): Promise<boolean> {
  if (initialised) return !!sentry;
  initialised = true;
  if (!env.SENTRY_DSN) return false;
  try {
    const moduleName = '@sentry/node';
    const mod = (await import(moduleName)) as unknown as SentryLike;
    mod.init({
      dsn: env.SENTRY_DSN,
      environment: env.NODE_ENV,
      tracesSampleRate: 0,
    });
    sentry = mod;
    return true;
  } catch {
    return false;
  }
}

/** Report an exception to Sentry if configured; otherwise a no-op. */
export function captureException(err: unknown, extra?: Record<string, unknown>): void {
  if (sentry) sentry.captureException(err, extra ? { extra } : undefined);
}

export function isObservabilityEnabled(): boolean {
  return !!sentry;
}
