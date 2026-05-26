import type { FastifyPluginAsync } from 'fastify';
import { and, asc, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { user } from '../../db/schema/shared.js';
import { broadcast, roomKey, type ChatMessagePayload } from './hub.js';

/**
 * Admin-side chat routes. All operations are scoped to the active company
 * (resolved via the standard `X-Company-Slug` header by app.requireCompany).
 *
 * Conversation key is the partner's user_id — there's exactly one
 * conversation row per partner per brand. Auto-created on first send.
 *
 * REST is the source of truth; WebSocket broadcasts are best-effort UX
 * accelerators. Clients that miss a WS event will still re-sync on the next
 * GET /messages refresh.
 */

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

  /**
   * List conversations in the active brand. Joined with partner_name +
   * partner_email so the inbox can render without per-row user lookups.
   */
  app.get('/conversations', async (request) => {
    const { chatConversations, partners } = request.company!.tables;
    // Driven from `partners` (not `chat_conversations`) so every active
    // partner is selectable in the inbox — even before either side has sent
    // a message. The conversation row is created lazily on first send, so a
    // partner with `id = null` and no preview just means "no chat yet".
    //
    // Suspended / rejected partners are excluded — once the relationship is
    // over, the admin shouldn't be able to start a new thread with them.
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
      // Conversations with recent activity first; partners without a
      // conversation row sink to the bottom but stay reachable.
      .orderBy(sql`${chatConversations.lastMessageAt} desc nulls last`, desc(partners.createdAt));
    return { conversations: rows };
  });

  /**
   * Fetch (or auto-create) a conversation for a specific partner user id.
   * Returns the conversation row + the most recent 100 messages, oldest first.
   */
  app.get('/conversations/:partnerUserId/messages', async (request, reply) => {
    const partnerUserId = (request.params as { partnerUserId: string }).partnerUserId;
    const { chatConversations, chatMessages, partners } = request.company!.tables;

    // Verify the partner actually belongs to this brand — otherwise an admin
    // could probe arbitrary user IDs by guessing.
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

  /**
   * Send a message from the admin to the partner. Inserts the message,
   * updates the conversation denorms, bumps partner's unread counter, and
   * broadcasts on the WS room so anyone listening gets it instantly.
   */
  app.post('/conversations/:partnerUserId/messages', async (request, reply) => {
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

    // Tx so the insert + denorm update are atomic — without this, a crash
    // mid-flight would leave the conversation list showing a stale preview.
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

    reply.code(201);
    return { message: payload };
  });

  /**
   * Mark the conversation as read by the admin — zeroes the admin's unread
   * counter and stamps `read_at` on every incoming (partner→admin) message
   * that's still unread. Broadcasts a `read` event so the partner's UI can
   * update the "Gelesen" indicator on outgoing bubbles.
   */
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
            // Only the rows that haven't been read yet — avoids touching old ones.
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

  /**
   * Typing indicator. No DB writes — just a WS broadcast. Returns 204 and
   * silently no-ops if no one's listening on the other side.
   */
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
