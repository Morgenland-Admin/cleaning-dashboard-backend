import type { FastifyPluginAsync } from 'fastify';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { user } from '../../db/schema/shared.js';
import { broadcast, roomKey, type ChatMessagePayload } from './hub.js';

const sendBodySchema = z
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

function rowToPayload(row: {
  id: number;
  conversationId: number;
  senderUserId: string;
  senderRole: string;
  body: string | null;
  attachments: Array<{ key: string; name: string; size: number; contentType?: string }>;
  deliveredAt: Date | null;
  readAt: Date | null;
  createdAt: Date;
}): ChatMessagePayload {
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
        partnerUserId: partners.userId,
        partnerCompanyName: partners.companyName,
        partnerContactEmail: partners.contactEmail,
        partnerName: user.name,
        partnerEmail: user.email,
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
    return { conversations: rows };
  });

  app.get('/conversations/:partnerUserId/messages', async (request, reply) => {
    const partnerUserId = (request.params as { partnerUserId: string }).partnerUserId;
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

    let [conv] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.partnerUserId, partnerUserId))
      .limit(1);
    if (!conv) {
      [conv] = await db.insert(chatConversations).values({ partnerUserId }).returning();
    }

    const messages = await db
      .select()
      .from(chatMessages)
      .where(eq(chatMessages.conversationId, conv!.id))
      .orderBy(asc(chatMessages.createdAt))
      .limit(100);

    return {
      conversation: conv,
      messages: messages.map(rowToPayload),
    };
  });

  // Sending to a partner workshop is a real outbound action — manager+.
  // Read/typing receipts stay open so a `viewer` can follow a thread.
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

      const result = await db.transaction(async (tx) => {
        let [conv] = await tx
          .select()
          .from(chatConversations)
          .where(eq(chatConversations.partnerUserId, partnerUserId))
          .limit(1);
        if (!conv) {
          [conv] = await tx.insert(chatConversations).values({ partnerUserId }).returning();
        }

        const preview = body.body
          ? body.body.slice(0, 200)
          : body.attachments && body.attachments.length > 0
            ? `📎 ${body.attachments[0]!.name}`
            : '';

        const now = new Date();
        const [inserted] = await tx
          .insert(chatMessages)
          .values({
            conversationId: conv!.id,
            senderUserId: adminId,
            senderRole: 'admin',
            body: body.body ?? null,
            attachments: body.attachments ?? [],
            deliveredAt: now,
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
          .where(eq(chatConversations.id, conv!.id));

        return { conversation: conv!, message: inserted! };
      });

      const payload = rowToPayload(result.message);
      broadcast(
        roomKey(slug, partnerUserId),
        {
          type: 'message',
          conversationId: result.conversation.id,
          message: payload,
        },
        adminId,
      );

      // PWA push for the partner — the WS broadcast only reaches open tabs.
      try {
        const { sendPushToUser } = await import('../../lib/push.js');
        await sendPushToUser(partnerUserId, {
          title: `${request.company!.name} · Neue Nachricht`,
          body: body.body ? body.body.slice(0, 120) : '📎 Anhang erhalten',
          url: '/chat',
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
    const { chatConversations, chatMessages } = request.company!.tables;

    const [conv] = await db
      .select()
      .from(chatConversations)
      .where(eq(chatConversations.partnerUserId, partnerUserId))
      .limit(1);
    if (!conv) {
      reply.code(204).send();
      return;
    }

    const now = new Date();
    await db.transaction(async (tx) => {
      await tx
        .update(chatMessages)
        .set({ readAt: now })
        .where(
          and(
            eq(chatMessages.conversationId, conv.id),
            eq(chatMessages.senderRole, 'partner'),
            sql`${chatMessages.readAt} IS NULL`,
          ),
        );
      await tx
        .update(chatConversations)
        .set({ unreadForAdmin: 0, updatedAt: now })
        .where(eq(chatConversations.id, conv.id));
    });

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
    const { chatConversations } = request.company!.tables;

    const [conv] = await db
      .select({ id: chatConversations.id })
      .from(chatConversations)
      .where(eq(chatConversations.partnerUserId, partnerUserId))
      .limit(1);
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
