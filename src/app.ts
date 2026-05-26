import Fastify, { type FastifyServerOptions } from 'fastify';
import cors from '@fastify/cors';
import helmet from '@fastify/helmet';
import rateLimit from '@fastify/rate-limit';
import sensible from '@fastify/sensible';
import { env } from './config/env.js';
import authPlugin from './auth/plugin.js';
import companyContext from './plugins/company-context.js';
import errorHandler from './plugins/error-handler.js';
import adminRoutes from './routes/admin.js';
import partnerRoutes from './routes/partner.js';
import storefrontRoutes from './routes/storefront.js';
import { loadAllActiveCompanies } from './lib/company-loader.js';

export async function buildApp(opts: FastifyServerOptions = {}) {
  // Pino redact paths — keep PII / credentials out of the structured logs.
  // Wildcards cover both root-level and nested occurrences (e.g. request
  // bodies and ad-hoc child loggers). Always lives in prod; pretty-printed
  // dev output applies the same redaction so screen-shared logs are safe.
  const redactPaths = [
    'req.headers.authorization',
    'req.headers.cookie',
    'headers.authorization',
    'headers.cookie',
    '*.password',
    '*.token',
    '*.email',
    '*.recipientEmail',
    '*.subscriberId',
    '*.ipAddress',
    '*.userAgent',
  ];
  const app = Fastify({
    logger:
      env.NODE_ENV === 'development'
        ? {
            transport: { target: 'pino-pretty', options: { translateTime: 'HH:MM:ss' } },
            redact: { paths: redactPaths, censor: '[redacted]' },
          }
        : {
            redact: { paths: redactPaths, censor: '[redacted]' },
          },
    // Trust 1 hop of reverse proxy (Traefik / nginx / Cloudflare) so
    // `request.ip` reflects the real client IP for rate-limit + logs.
    trustProxy: 1,
    ...opts,
  });

  // Pre-warm the dynamic CORS origin set from the company table + refresh on
  // a 60 s interval. The `@fastify/cors` origin callback runs synchronously,
  // so we cannot await the DB inside it — instead we keep a Set in memory and
  // refresh in the background. POST /admin/companies invalidates the
  // loader cache + calls refreshCorsOrigins() so a new brand's CORS lights up
  // immediately on this instance.
  const dynamicOrigins = new Set<string>();
  async function refreshCorsOrigins() {
    try {
      const companies = await loadAllActiveCompanies();
      const next = new Set<string>();
      for (const c of companies) {
        if (c.storefrontOrigin) next.add(c.storefrontOrigin);
      }
      dynamicOrigins.clear();
      for (const o of next) dynamicOrigins.add(o);
    } catch (err) {
      app.log.warn({ err }, 'Failed to refresh CORS origin set');
    }
  }
  await refreshCorsOrigins();
  const corsRefreshInterval = setInterval(() => {
    void refreshCorsOrigins();
  }, 60_000);
  // Don't keep the event loop alive solely for this timer (e.g. during tests).
  corsRefreshInterval.unref?.();
  app.addHook('onClose', async () => clearInterval(corsRefreshInterval));
  // Expose the refresher so route handlers (admin POST /companies) can force
  // an immediate refresh after writes.
  app.decorate('refreshCorsOrigins', refreshCorsOrigins);

  await app.register(helmet, { contentSecurityPolicy: false });
  await app.register(cors, {
    origin: (origin, cb) => {
      if (!origin) return cb(null, true);
      if (env.CORS_ORIGINS.includes(origin)) return cb(null, true);
      cb(null, dynamicOrigins.has(origin));
    },
    credentials: true,
    allowedHeaders: ['Content-Type', 'Authorization', 'X-Company-Slug', 'Cookie'],
    exposedHeaders: ['Set-Cookie'],
  });
  await app.register(sensible);
  // Rate limiter is opt-in per route (global: false). Storefront routes
  // explicitly enable it via `config: { rateLimit: {...} }`. Auth + admin
  // routes are NOT covered here — Better Auth has its own rate limiting,
  // admin routes are session-gated.
  await app.register(rateLimit, {
    global: false,
    max: 20,
    timeWindow: '1 minute',
    // Include standardized `RateLimit-*` headers so the frontend can
    // surface a "try again soon" message if needed.
    enableDraftSpec: true,
    // 429 body — keeps shape consistent with our error-handler.
    errorResponseBuilder: (_req, ctx) => ({
      error: 'Too many requests. Please slow down.',
      retryAfterSeconds: Math.ceil(ctx.ttl / 1000),
    }),
  });
  await app.register(errorHandler);
  await app.register(authPlugin);
  await app.register(companyContext);

  app.get('/health', async () => ({ status: 'ok', time: new Date().toISOString() }));

  // Public-facing host is api.reinigungs-portal.com — routes are mounted at the
  // root rather than under /api to avoid the double "api.example.com/api/..."
  // prefix. Better Auth is mounted at /auth via its basePath option.
  await app.register(adminRoutes, { prefix: '/admin' });
  await app.register(partnerRoutes, { prefix: '/partner' });
  await app.register(storefrontRoutes, { prefix: '/storefront' });

  // WebSocket endpoint for chat. Registered at the root so the URL is
  // `/ws/chat` — symmetric with the REST surface and not gated by the
  // admin audience hook (it does its own session + role check at upgrade).
  const chatWsPlugin = (await import('./modules/chat/ws.js')).default;
  await app.register(chatWsPlugin, { prefix: '/ws' });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
