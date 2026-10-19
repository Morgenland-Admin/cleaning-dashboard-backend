import { and, asc, eq, inArray, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { previewOf } from '../chat/lib.js';

/** Sender id for admin messages from the old system (no user account behind them). */
export const LEGACY_ADMIN_SENDER = 'legacy-admin';

/** "+49 170 …", "0170…", "0049…" → "49170…" so phones from different systems match. */
export function normalizePhone(v: unknown): string | null {
  let d = typeof v === 'string' || typeof v === 'number' ? String(v).replace(/\D/g, '') : '';
  if (d.startsWith('00')) d = d.slice(2);
  else if (d.startsWith('0')) d = `49${d.slice(1)}`;
  return d.length >= 8 ? d : null;
}

const lower = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');

/** Old chat attachments are a list of file keys (sometimes a single string). */
export function legacyAttachments(v: unknown): string[] {
  const items = Array.isArray(v) ? v : [v];
  return items
    .filter((a): a is string => typeof a === 'string' && a.trim() !== '')
    .map((a) => a.trim());
}

/**
 * Copies an old-system partner's admin chat (archived in legacy_records) into their portal
 * conversation, matched by email or phone. Runs once: a conversation that already holds the
 * oldest legacy message is skipped. Returns the number of messages added.
 */
export async function attachLegacyPartnerChat(
  tables: TenantTables,
  partner: {
    userId: string;
    email?: string | null;
    phone?: string | null;
    /** Exact old partner records (their phone keys); skips email/phone matching. */
    legacyPhones?: string[];
  },
): Promise<number> {
  const { legacyRecords: r, chatConversations: c, chatMessages: m } = tables;
  const email = lower(partner.email);
  const phone = normalizePhone(partner.phone);
  if (!email && !phone && !partner.legacyPhones?.length) return 0;

  const legacyPartners = await db
    .select({ data: r.data })
    .from(r)
    .where(and(eq(r.source, 'cleanilo_ops'), eq(r.legacyTable, 'cleanilo_partner')));
  const known = legacyPartners.map((p) => p.data);
  // Email wins; phone only when no email matches (old companies sometimes share a number).
  const byEmail = email
    ? known.filter((d) => [d.email, d.business_email].some((e) => lower(e) === email))
    : [];
  const matched = byEmail.length
    ? byEmail
    : phone
      ? known.filter((d) => [d.phone, d.business_phone].some((p) => normalizePhone(p) === phone))
      : [];
  const phones = partner.legacyPhones?.length
    ? partner.legacyPhones
    : matched.map((d) => String(d.phone));
  if (phones.length === 0) return 0;

  const rows = await db
    .select({ data: r.data, at: r.legacyCreatedAt })
    .from(r)
    .where(
      and(
        eq(r.source, 'cleanilo_ops'),
        eq(r.legacyTable, 'admin_partner_chat'),
        inArray(sql<string>`${r.data}->>'partnerPhone'`, phones),
      ),
    )
    .orderBy(asc(r.legacyCreatedAt), asc(r.id));
  const messages = rows
    .map(({ data, at }) => {
      const text = typeof data.message === 'string' ? data.message.trim() : '';
      const body = [
        text,
        ...legacyAttachments(data.attachment).map((a) => `[Anhang im alten System: ${a}]`),
      ]
        .filter(Boolean)
        .join('\n');
      return { body, at: at ?? new Date(), fromPartner: data.owner === 'PARTNER' };
    })
    .filter((msg) => msg.body);
  if (messages.length === 0) return 0;

  const first = messages[0]!;
  const last = messages[messages.length - 1]!;
  return db.transaction(async (tx) => {
    let [conversation] = await tx
      .select({ id: c.id })
      .from(c)
      .where(eq(c.partnerUserId, partner.userId))
      .limit(1);
    if (conversation) {
      const [already] = await tx
        .select({ id: m.id })
        .from(m)
        .where(
          and(
            eq(m.conversationId, conversation.id),
            eq(m.createdAt, first.at),
            eq(m.body, first.body),
          ),
        )
        .limit(1);
      if (already) return 0;
    } else {
      [conversation] = await tx
        .insert(c)
        .values({
          partnerUserId: partner.userId,
          lastMessageAt: last.at,
          lastMessagePreview: previewOf(last.body),
          createdAt: first.at,
          updatedAt: last.at,
        })
        .returning({ id: c.id });
    }
    // History, not news: delivered and read, so nobody gets unread badges.
    await tx.insert(m).values(
      messages.map((msg) => ({
        conversationId: conversation!.id,
        senderUserId: msg.fromPartner ? partner.userId : LEGACY_ADMIN_SENDER,
        senderRole: msg.fromPartner ? 'partner' : 'admin',
        body: msg.body,
        deliveredAt: msg.at,
        readAt: msg.at,
        createdAt: msg.at,
      })),
    );
    return messages.length;
  });
}
