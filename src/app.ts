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
import internalRoutes from './routes/internal.js';
import partnerRoutes from './routes/partner.js';
import storefrontRoutes from './routes/storefront.js';
import { loadAllActiveCompanies } from './lib/company-loader.js';
import { db } from './db/index.js';
import { sql } from 'drizzle-orm';
import { initObservability } from './lib/observability.js';

export async function buildApp(opts: FastifyServerOptions = {}) {
  await initObservability();
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
    trustProxy: 1,
    ...opts,
  });

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
  corsRefreshInterval.unref?.();
  app.addHook('onClose', async () => clearInterval(corsRefreshInterval));
  app.decorate('refreshCorsOrigins', refreshCorsOrigins);

  // CSP sized for the few HTML pages (inline styles + same-origin form).
  await app.register(helmet, {
    contentSecurityPolicy: {
      directives: {
        defaultSrc: ["'none'"],
        styleSrc: ["'unsafe-inline'"],
        imgSrc: ["'self'", 'data:'],
        formAction: ["'self'"],
        baseUri: ["'none'"],
        frameAncestors: ["'none'"],
      },
    },
  });
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
  await app.register(rateLimit, {
    global: false,
    max: 20,
    timeWindow: '1 minute',
    enableDraftSpec: true,
    errorResponseBuilder: (_req, ctx) => ({
      error: 'Too many requests. Please slow down.',
      retryAfterSeconds: Math.ceil(ctx.ttl / 1000),
    }),
  });
  await app.register(errorHandler);
  await app.register(authPlugin);
  await app.register(companyContext);

  app.get('/health', async (_req, reply) => {
    try {
      await db.execute(sql`SELECT 1`);
      return { status: 'ok', db: 'up', time: new Date().toISOString() };
    } catch (err) {
      app.log.error({ err }, 'health check: database unreachable');
      reply.code(503);
      return { status: 'degraded', db: 'down', time: new Date().toISOString() };
    }
  });

  await app.register(adminRoutes, { prefix: '/admin' });
  await app.register(partnerRoutes, { prefix: '/partner' });
  await app.register(storefrontRoutes, { prefix: '/storefront' });
  await app.register(internalRoutes, { prefix: '/internal' });

  const chatWsPlugin = (await import('./modules/chat/ws.js')).default;
  await app.register(chatWsPlugin, { prefix: '/ws' });

  return app;
}

export type App = Awaited<ReturnType<typeof buildApp>>;
