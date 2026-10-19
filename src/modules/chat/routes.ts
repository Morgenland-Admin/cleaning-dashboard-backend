import type { FastifyPluginAsync } from 'fastify';
import { desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { user } from '../../db/schema/shared.js';
import { broadcast, hasRole, roomKey, type ChatMessagePayload } from './hub.js';
import {
  ensureConversation,
  findConversation,
  markDelivered,
  markRead,
  messagePage,
  pageQuerySchema,
  previewOf,
} from './lib.js';

export const sendBodySchema = z
  .object({
    body: z.string().max(8000).optional(),
    attachments: z
      .array(
        z.object({
          key: z.string().min(1).max(500),
          name: z.string().min(1).max(200),
          size: z.number().int().nonnegative(),
          contentType: z.string().max(80).optional(),
        }),
      )
      .max(10)
      .optional(),
  })
  .refine(
    (v) => (v.body && v.body.trim().length > 0) || (v.attachments && v.attachments.length > 0),
    { message: 'Either body or at least one attachment is required' },
  );

const typingSchema = z.object({ isTyping: z.boolean() });

export function rowToPayload(
  row: {
    id: number;
    conversationId: number;
    senderUserId: string;
    senderRole: string;
    body: string | null;
    attachments: Array<{ key: string; name: string; size: number; contentType?: string }>;
    deliveredAt: Date | null;
    readAt: Date | null;
    createdAt: Date;
  },
  senderName?: string | null,
): ChatMessagePayload {
  return {
    id: row.id,
    conversationId: row.conversationId,
    senderUserId: row.senderUserId,
    senderRole: row.senderRole === 'partner' ? 'partner' : 'admin',
    body: row.body,
    attachments: row.attachments,
    deliveredAt: row.deliveredAt?.toISOString() ?? null,
    readAt: row.readAt?.toISOString() ?? null,
    createdAt: row.createdAt.toISOString(),
    ...(senderName !== undefined ? { senderName } : {}),
  };
}

export const chatAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('admin'));
  app.addHook('preHandler', app.requireCompany);

  app.get('/conversations', async (request) => {
    const { chatConversations, partners } = request.company!.tables;
    const rows = await db
      .select({
        id: chatConversations.id,
        partnerId: partners.id,
        partnerUserId: partners.userId,
        partnerCompanyName: partners.companyName,
        partnerContactEmail: partners.contactEmail,
        partnerContactPhone: partners.contactPhone,
        partnerName: user.name,
        partnerEmail: user.email,
        partnerPhone: user.phone,
        partnerStatus: partners.status,
        lastMessageAt: chatConversations.lastMessageAt,
        lastMessagePreview: chatConversations.lastMessagePreview,
        unreadForAdmin: chatConversations.unreadForAdmin,
        createdAt: chatConversations.createdAt,
      })
      .from(partners)
      .leftJoin(chatConversations, eq(chatConversations.partnerUserId, partners.userId))
      .leftJoin(user, eq(user.id, partners.userId))
      .where(inArray(partners.status, ['pending', 'active']))
      .orderBy(sql`${chatConversations.lastMessageAt} desc nulls last`, desc(partners.createdAt));
    // The list reaching an admin counts as delivery of the partners' messages.
    await markDelivered(
      request.company!.tables,
      request.company!.slug,
      rows.flatMap((r) =>
        r.id != null && r.partnerUserId ? [{ id: r.id, partnerUserId: r.partnerUserId }] : [],
      ),
      'partner',
    );
    return { conversations: rows };
  });

  app.get('/conversations/:partnerUserId/messages', async (request, reply) => {
    const partnerUserId = (request.params as { partnerUserId: string }).partnerUserId;
    const { before, limit = 50 } = pageQuerySchema.parse(request.query);
    const tables = request.company!.tables;
    const { partners } = tables;

    const [partnerRow] = await db
      .select({ userId: partners.userId })
      .from(partners)
      .where(eq(partners.userId, partnerUserId))
      .limit(1);
    if (!partnerRow) {
      reply.code(404).send({ error: 'Partner not found in this brand' });
      return;
    }

    const conv = await ensureConversation(tables, partnerUserId);

    if (!before) {
      await markDelivered(
        tables,
        request.company!.slug,
        [{ id: conv.id, partnerUserId }],
        'partner',
      );
    }
    const { rows, hasMore } = await messagePage(tables, conv.id, { before, limit });
    const senderIds = [
      ...new Set(rows.filter((r) => r.senderRole === 'admin').map((r) => r.senderUserId)),
    ];
    const names = senderIds.length
      ? await db
          .select({ id: user.id, name: user.name })
          .from(user)
          .where(inArray(user.id, senderIds))
      : [];
    const nameOf = new Map(names.map((n) => [n.id, n.name]));

    return {
      conversation: conv,
      messages: rows.map((r) =>
        rowToPayload(r, r.senderRole === 'admin' ? (nameOf.get(r.senderUserId) ?? null) : null),
      ),
      hasMore,
    };
  });

  // Manager+ to send; read/typing receipts stay open so a `viewer` can follow a thread.
  app.post(
    '/conversations/:partnerUserId/messages',
    { preHandler: app.requireAccess('super_admin', 'admin', 'manager') },
    async (request, reply) => {
      const partnerUserId = (request.params as { partnerUserId: string }).partnerUserId;
      const body = sendBodySchema.parse(request.body);
      const adminId = request.authUser!.id;
      const slug = request.company!.slug;
      const { chatConversations, chatMessages, partners } = request.company!.tables;

      const [partnerRow] = await db
        .select({ userId: partners.userId })
        .from(partners)
        .where(eq(partners.userId, partnerUserId))
        .limit(1);
      if (!partnerRow) {
        reply.code(404).send({ error: 'Partner not found in this brand' });
        return;
      }

      const conv = await ensureConversation(request.company!.tables, partnerUserId);
      const result = await db.transaction(async (tx) => {
        const preview = previewOf(body.body, body.attachments);
        const now = new Date();
        const [inserted] = await tx
          .insert(chatMessages)
          .values({
            conversationId: conv.id,
            senderUserId: adminId,
            senderRole: 'admin',
            body: body.body ?? null,
            attachments: body.attachments ?? [],
            // Delivered right away only when the partner has the thread open.
            deliveredAt: hasRole(roomKey(slug, partnerUserId), 'partner') ? now : null,
          })
          .returning();

        await tx
          .update(chatConversations)
          .set({
            lastMessageAt: now,
            lastMessagePreview: preview,
            unreadForPartner: sql`${chatConversations.unreadForPartner} + 1`,
            updatedAt: now,
          })
          .where(eq(chatConversations.id, conv.id));

        return { conversation: conv, message: inserted! };
      });

      const payload = rowToPayload(result.message, request.authUser!.name ?? null);
      broadcast(
        roomKey(slug, partnerUserId),
        {
          type: 'message',
          conversationId: result.conversation.id,
          message: payload,
        },
        adminId,
      );

      try {
        const { sendPushToUser } = await import('../../lib/push.js');
        await sendPushToUser(partnerUserId, {
          title: `${request.company!.name} · Neue Nachricht`,
          body: body.body ? body.body.slice(0, 120) : '📎 Anhang erhalten',
          url: '/nachrichten',
          tag: `chat:${result.conversation.id}`,
          brandSlug: slug,
        });
      } catch (err) {
        request.log.warn({ err, partnerUserId }, 'chat push dispatch failed');
      }

      reply.code(201);
      return { message: payload };
    },
  );

  app.post('/conversations/:partnerUserId/read', async (request, reply) => {
    const partnerUserId = (request.params as { partnerUserId: string }).partnerUserId;
    const slug = request.company!.slug;
    const { chatConversations } = request.company!.tables;

    const conv = await findConversation(request.company!.tables, partnerUserId);
    if (!conv) {
      reply.code(204).send();
      return;
    }

    const now = new Date();
    await markRead(request.company!.tables, conv.id, 'partner', now);
    await db
      .update(chatConversations)
      .set({ unreadForAdmin: 0, updatedAt: now })
      .where(eq(chatConversations.id, conv.id));

    broadcast(
      roomKey(slug, partnerUserId),
      {
        type: 'read',
        conversationId: conv.id,
        by: 'admin',
        readAt: now.toISOString(),
      },
      request.authUser!.id,
    );

    reply.code(204).send();
  });

  app.post('/conversations/:partnerUserId/typing', async (request, reply) => {
    const partnerUserId = (request.params as { partnerUserId: string }).partnerUserId;
    const { isTyping } = typingSchema.parse(request.body);
    const slug = request.company!.slug;

    const conv = await findConversation(request.company!.tables, partnerUserId);
    if (!conv) {
      reply.code(204).send();
      return;
    }

    broadcast(
      roomKey(slug, partnerUserId),
      {
        type: 'typing',
        conversationId: conv.id,
        from: 'admin',
        isTyping,
      },
      request.authUser!.id,
    );

    reply.code(204).send();
  });
};
