import { and, asc, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { broadcast, roomKey } from './hub.js';

type Role = 'admin' | 'partner';

export const pageQuerySchema = z.object({
  before: z.coerce.number().int().positive().optional(),
  limit: z.coerce.number().int().min(1).max(200).optional(),
});

// Text lines the legacy import left for files it could not link.
const LEGACY_FILE_LINE = /^\[Anhang im alten System: [^\]]+\]$/;

const oldestConversation = (
  exec: Pick<typeof db, 'select'>,
  tables: TenantTables,
  partnerUserId: string,
) =>
  exec
    .select()
    .from(tables.chatConversations)
    .where(eq(tables.chatConversations.partnerUserId, partnerUserId))
    .orderBy(asc(tables.chatConversations.id))
    .limit(1)
    .then((rows) => rows[0] ?? null);

/** The partner's thread; the oldest row wins if a race ever made two. */
export const findConversation = (tables: TenantTables, partnerUserId: string) =>
  oldestConversation(db, tables, partnerUserId);

/** As `findConversation`, creating it under a per-partner lock so parallel requests can't each insert one. */
export async function ensureConversation(tables: TenantTables, partnerUserId: string) {
  const existing = await findConversation(tables, partnerUserId);
  if (existing) return existing;
  return db.transaction(async (tx) => {
    await tx.execute(sql`select pg_advisory_xact_lock(hashtext(${`chat:${partnerUserId}`}))`);
    const raced = await oldestConversation(tx, tables, partnerUserId);
    if (raced) return raced;
    const [created] = await tx
      .insert(tables.chatConversations)
      .values({ partnerUserId })
      .returning();
    return created!;
  });
}

/** Conversation-list preview: the text, else the first file name. */
export function previewOf(
  body: string | null | undefined,
  attachments: Array<{ name: string }> = [],
): string {
  const lines = (body ?? '').split('\n').map((l) => l.trim());
  const text = lines
    .filter((l) => !LEGACY_FILE_LINE.test(l))
    .join(' ')
    .replace(/\s+/g, ' ')
    .trim();
  if (text) return text.slice(0, 200);
  const first = attachments[0];
  if (first)
    return `📎 ${first.name}${attachments.length > 1 ? ` +${attachments.length - 1}` : ''}`;
  return lines.some((l) => LEGACY_FILE_LINE.test(l)) ? '📎 Anhang (altes System)' : '';
}

/** Newest `limit` messages before the cursor, returned oldest first. */
export async function messagePage(
  tables: TenantTables,
  conversationId: number,
  { before, limit }: { before?: number; limit: number },
) {
  const m = tables.chatMessages;
  let cursor;
  if (before) {
    const [row] = await db
      .select({ createdAt: m.createdAt })
      .from(m)
      .where(and(eq(m.id, before), eq(m.conversationId, conversationId)))
      .limit(1);
    if (!row) return { rows: [], hasMore: false };
    cursor = or(
      lt(m.createdAt, row.createdAt),
      and(eq(m.createdAt, row.createdAt), lt(m.id, before)),
    );
  }
  const rows = await db
    .select()
    .from(m)
    .where(and(eq(m.conversationId, conversationId), cursor))
    .orderBy(desc(m.createdAt), desc(m.id))
    .limit(limit + 1);
  return { rows: rows.slice(0, limit).reverse(), hasMore: rows.length > limit };
}

/**
 * Marks messages from `senderRole` as delivered once the other side's app has them, and tells
 * the room. Read implies delivered, so this never touches read rows.
 */
export async function markDelivered(
  tables: TenantTables,
  slug: string,
  conversations: Array<{ id: number; partnerUserId: string }>,
  senderRole: Role,
): Promise<void> {
  if (conversations.length === 0) return;
  const m = tables.chatMessages;
  const now = new Date();
  const hit = await db
    .update(m)
    .set({ deliveredAt: now })
    .where(
      and(
        inArray(
          m.conversationId,
          conversations.map((c) => c.id),
        ),
        eq(m.senderRole, senderRole),
        isNull(m.deliveredAt),
      ),
    )
    .returning({ conversationId: m.conversationId });
  const ids = new Set(hit.map((h) => h.conversationId));
  for (const c of conversations) {
    if (!ids.has(c.id)) continue;
    broadcast(roomKey(slug, c.partnerUserId), {
      type: 'delivered',
      conversationId: c.id,
      by: senderRole === 'admin' ? 'partner' : 'admin',
      deliveredAt: now.toISOString(),
    });
  }
}

/** Marks the other side's messages read (and delivered, if that was missed). */
export async function markRead(
  tables: TenantTables,
  conversationId: number,
  senderRole: Role,
  now: Date,
) {
  const m = tables.chatMessages;
  await db
    .update(m)
    .set({ readAt: now, deliveredAt: sql`coalesce(${m.deliveredAt}, ${now})` })
    .where(
      and(eq(m.conversationId, conversationId), eq(m.senderRole, senderRole), isNull(m.readAt)),
    );
}
