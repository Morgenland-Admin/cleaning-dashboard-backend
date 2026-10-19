import type { FastifyPluginAsync } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { badRequest, notFound } from '../../lib/http-errors.js';
import {
  partnerKeyPrefix,
  s3Configured,
  signObjectDownload,
  signPartnerUpload,
} from '../../lib/s3.js';
import { requireOwnPartner } from '../partners/lib.js';
import { broadcast, hasRole, roomKey } from './hub.js';
import {
  ensureConversation,
  markDelivered,
  markRead,
  messagePage,
  pageQuerySchema,
  previewOf,
} from './lib.js';
import { rowToPayload, sendBodySchema } from './routes.js';

const MAX_BYTES = 10 * 1024 * 1024;
const signSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1).max(80),
  size: z.number().int().positive().max(MAX_BYTES),
});
const CHAT_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
  'application/pdf',
]);

/** The partner side of the admin↔partner thread; one conversation per partner and brand. */
export const chatPartnerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);

  app.get('/messages', async (request) => {
    const { before, limit = 50 } = pageQuerySchema.parse(request.query);
    await requireOwnPartner(request);
    const tables = request.company!.tables;
    const userId = request.authUser!.id;
    const conv = await ensureConversation(tables, userId);
    if (!before) {
      await markDelivered(
        tables,
        request.company!.slug,
        [{ id: conv.id, partnerUserId: userId }],
        'admin',
      );
    }
    const { rows, hasMore } = await messagePage(tables, conv.id, { before, limit });
    return { conversation: conv, messages: rows.map((r) => rowToPayload(r)), hasMore };
  });

  app.post(
    '/messages',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = sendBodySchema.parse(request.body);
      const partner = await requireOwnPartner(request);
      const userId = request.authUser!.id;
      const slug = request.company!.slug;
      const tables = request.company!.tables;
      const ownPrefix = partnerKeyPrefix(request.company!.keyPrefix, partner.id, 'chat');
      if (body.attachments?.some((a) => !a.key.startsWith(ownPrefix))) {
        throw badRequest('Attachment does not belong to this partner');
      }
      const conv = await ensureConversation(tables, userId);
      const now = new Date();
      const preview = previewOf(body.body, body.attachments);
      const message = await db.transaction(async (tx) => {
        const [inserted] = await tx
          .insert(tables.chatMessages)
          .values({
            conversationId: conv.id,
            senderUserId: userId,
            senderRole: 'partner',
            body: body.body ?? null,
            attachments: body.attachments ?? [],
            deliveredAt: hasRole(roomKey(slug, userId), 'admin') ? now : null,
          })
          .returning();
        await tx
          .update(tables.chatConversations)
          .set({
            lastMessageAt: now,
            lastMessagePreview: preview,
            unreadForAdmin: sql`${tables.chatConversations.unreadForAdmin} + 1`,
            updatedAt: now,
          })
          .where(eq(tables.chatConversations.id, conv.id));
        return inserted!;
      });

      const payload = rowToPayload(message);
      broadcast(
        roomKey(slug, userId),
        { type: 'message', conversationId: conv.id, message: payload },
        userId,
      );
      // Not awaited: the partner's "sent" tick should not wait for web-push round trips.
      void import('../../lib/push.js')
        .then(({ sendPushToBrandAdmins }) =>
          sendPushToBrandAdmins(slug, {
            title: `${request.company!.name} · ${partner.companyName ?? 'Partner'}`,
            body: body.body ? body.body.slice(0, 120) : '📎 Anhang erhalten',
            url: `/chat?partner=${encodeURIComponent(userId)}`,
            tag: `chat:${conv.id}`,
            brandSlug: slug,
          }),
        )
        .catch((err: unknown) => request.log.warn({ err }, 'partner chat push failed'));
      reply.code(201);
      return { message: payload };
    },
  );

  // Only keys attached to a message in the partner's own thread can be downloaded.
  app.get('/attachment', async (request) => {
    const { key } = z.object({ key: z.string().min(1).max(500) }).parse(request.query);
    await requireOwnPartner(request);
    const tables = request.company!.tables;
    const conv = await ensureConversation(tables, request.authUser!.id);
    const [hit] = await db
      .select({ id: tables.chatMessages.id })
      .from(tables.chatMessages)
      .where(
        and(
          eq(tables.chatMessages.conversationId, conv.id),
          sql`${tables.chatMessages.attachments} @> ${JSON.stringify([{ key }])}::jsonb`,
        ),
      )
      .limit(1);
    if (!hit) throw notFound('Attachment not found');
    return signObjectDownload({ key });
  });

  app.post('/read', async (request, reply) => {
    await requireOwnPartner(request);
    const userId = request.authUser!.id;
    const tables = request.company!.tables;
    const conv = await ensureConversation(tables, userId);
    const now = new Date();
    await markRead(tables, conv.id, 'admin', now);
    await db
      .update(tables.chatConversations)
      .set({ unreadForPartner: 0, updatedAt: now })
      .where(eq(tables.chatConversations.id, conv.id));
    broadcast(
      roomKey(request.company!.slug, userId),
      { type: 'read', conversationId: conv.id, by: 'partner', readAt: now.toISOString() },
      userId,
    );
    reply.code(204).send();
  });

  app.post(
    '/sign-upload',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!s3Configured) {
        reply.code(503).send({ error: 'Uploads are not configured on this server' });
        return;
      }
      const body = signSchema.parse(request.body);
      if (!CHAT_TYPES.has(body.contentType)) {
        reply.code(415).send({ error: `Unsupported file type "${body.contentType}"` });
        return;
      }
      const partner = await requireOwnPartner(request);
      const signed = await signPartnerUpload({
        keyPrefix: request.company!.keyPrefix,
        partnerId: partner.id,
        area: 'chat',
        filename: body.filename,
        contentType: body.contentType,
        sizeBytes: body.size,
      });
      reply.code(201).send(signed);
    },
  );
};
