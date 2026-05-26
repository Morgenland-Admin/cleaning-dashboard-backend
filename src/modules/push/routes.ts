import type { FastifyPluginAsync } from 'fastify';
import { and, eq } from 'drizzle-orm';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { pushSubscriptions } from '../../db/schema/shared.js';
import { pushConfigured, sendTestPushToUser } from '../../lib/push.js';

const subscribeSchema = z.object({
  endpoint: z.string().url(),
  keys: z.object({
    p256dh: z.string().min(1),
    auth: z.string().min(1),
  }),
  userAgent: z.string().max(500).optional(),
});

const unsubscribeSchema = z.object({
  endpoint: z.string().url(),
});

export const pushAdminRoutes: FastifyPluginAsync = async (app) => {
  app.get('/vapid-key', async (_request, reply) => {
    if (!pushConfigured()) {
      reply.code(503).send({ error: 'Push notifications not configured' });
      return;
    }
    reply.send({ publicKey: env.VAPID_PUBLIC_KEY });
  });

  app.get('/status', async (request, reply) => {
    const userId = request.authUser!.id;
    const rows = await db
      .select({ endpoint: pushSubscriptions.endpoint })
      .from(pushSubscriptions)
      .where(eq(pushSubscriptions.userId, userId));
    reply.send({
      configured: pushConfigured(),
      subscriptions: rows.map((r) => r.endpoint),
    });
  });

  app.post('/subscribe', async (request, reply) => {
    if (!pushConfigured()) {
      reply.code(503).send({ error: 'Push notifications not configured' });
      return;
    }
    const body = subscribeSchema.parse(request.body);
    const userId = request.authUser!.id;
    const now = new Date();
    await db
      .insert(pushSubscriptions)
      .values({
        userId,
        endpoint: body.endpoint,
        p256dh: body.keys.p256dh,
        auth: body.keys.auth,
        userAgent: body.userAgent ?? null,
        createdAt: now,
        lastUsedAt: now,
      })
      .onConflictDoUpdate({
        target: pushSubscriptions.endpoint,
        set: {
          userId,
          p256dh: body.keys.p256dh,
          auth: body.keys.auth,
          userAgent: body.userAgent ?? null,
          lastUsedAt: now,
        },
      });
    reply.code(201).send({ ok: true });
  });

  app.delete('/subscribe', async (request, reply) => {
    const body = unsubscribeSchema.parse(request.body);
    const userId = request.authUser!.id;
    await db
      .delete(pushSubscriptions)
      .where(
        and(eq(pushSubscriptions.userId, userId), eq(pushSubscriptions.endpoint, body.endpoint)),
      );
    reply.code(200).send({ ok: true });
  });

  app.post('/test', async (request, reply) => {
    if (!pushConfigured()) {
      reply.code(503).send({ error: 'Push notifications not configured' });
      return;
    }
    const userId = request.authUser!.id;
    const result = await sendTestPushToUser(userId, {
      title: 'Reinigungs-Portal',
      body: 'Push-Benachrichtigungen sind aktiviert. Sie erhalten ab jetzt neue Vorgänge in Echtzeit.',
      url: '/',
      tag: 'test',
    });
    reply.send({ ok: true, ...result });
  });
};

export default pushAdminRoutes;
