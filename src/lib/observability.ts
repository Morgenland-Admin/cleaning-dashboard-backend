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
  } catch (err) {
    // A DSN is configured but the SDK couldn't load — surface it loudly instead
    // of silently running with no error tracking on a payments backend.
    console.error(
      '[observability] SENTRY_DSN is set but @sentry/node failed to load — ' +
        'error tracking is DISABLED. Run `pnpm add @sentry/node` or unset SENTRY_DSN.',
      err,
    );
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
