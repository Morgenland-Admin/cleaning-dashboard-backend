import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import { createTenantSchemaSql, getTenantTables } from '../../db/schema/tenant.js';
import {
  attachLegacyPartnerChat,
  LEGACY_ADMIN_SENDER,
  legacyAttachments,
  normalizePhone,
} from './partner-chat.js';

const SLUG = 'cleanilo';
const PARTNER_USER = 'test-legacy-chat-partner';
const LEGACY_PHONE = '+4915099990001';
const IDS = ['test-chat-partner', 'test-chat-1', 'test-chat-2'];

async function databaseReachable(): Promise<boolean> {
  try {
    const client = await pool.connect();
    client.release();
    return true;
  } catch {
    return false;
  }
}
const dbUp = await databaseReachable();

describe('normalizePhone', () => {
  it('matches the common German spellings', () => {
    assert.equal(normalizePhone('+49 150 9999 0001'), '4915099990001');
    assert.equal(normalizePhone('01509999-0001'), '4915099990001');
    assert.equal(normalizePhone('0049 1509999 0001'), '4915099990001');
    assert.equal(normalizePhone('123'), null);
  });
});

describe(
  'attachLegacyPartnerChat',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    const T = getTenantTables(SLUG);

    before(async () => {
      await db.execute(sql.raw(createTenantSchemaSql(SLUG)));
      await db
        .insert(T.legacyRecords)
        .values([
          {
            source: 'cleanilo_ops',
            legacyTable: 'cleanilo_partner',
            legacyId: IDS[0]!,
            data: { phone: LEGACY_PHONE, email: 'old-partner@example.invalid' },
          },
          {
            source: 'cleanilo_ops',
            legacyTable: 'admin_partner_chat',
            legacyId: IDS[1]!,
            data: { partnerPhone: LEGACY_PHONE, owner: 'ADMIN', message: 'Willkommen' },
            legacyCreatedAt: new Date('2023-03-01T10:00:00Z'),
          },
          {
            source: 'cleanilo_ops',
            legacyTable: 'admin_partner_chat',
            legacyId: IDS[2]!,
            data: {
              partnerPhone: LEGACY_PHONE,
              owner: 'PARTNER',
              message: 'Danke',
              attachment: ['docs/a.pdf'],
            },
            legacyCreatedAt: new Date('2023-03-01T11:00:00Z'),
          },
        ])
        .onConflictDoNothing();
    });

    after(async () => {
      await db
        .delete(T.chatConversations)
        .where(eq(T.chatConversations.partnerUserId, PARTNER_USER));
      await db
        .delete(T.legacyRecords)
        .where(
          and(eq(T.legacyRecords.source, 'cleanilo_ops'), inArray(T.legacyRecords.legacyId, IDS)),
        );
      await pool.end();
    });

    it('reads attachment lists and single strings', () => {
      assert.deepEqual(legacyAttachments(['a.pdf', ' ', 'b.jpg']), ['a.pdf', 'b.jpg']);
      assert.deepEqual(legacyAttachments('c.pdf'), ['c.pdf']);
      assert.deepEqual(legacyAttachments([]), []);
    });

    it('only attaches the old records it is given', async () => {
      assert.equal(
        await attachLegacyPartnerChat(T, { userId: PARTNER_USER, legacyPhones: ['+490000000000'] }),
        0,
      );
    });

    it('ignores partners the old system did not know', async () => {
      assert.equal(
        await attachLegacyPartnerChat(T, { userId: PARTNER_USER, email: 'new@example.invalid' }),
        0,
      );
    });

    it('copies the old chat once, read and with original dates', async () => {
      const added = await attachLegacyPartnerChat(T, {
        userId: PARTNER_USER,
        email: 'Old-Partner@example.invalid',
      });
      assert.equal(added, 2);
      assert.equal(
        await attachLegacyPartnerChat(T, { userId: PARTNER_USER, phone: '0150 9999 0001' }),
        0,
      );

      const [conversation] = await db
        .select()
        .from(T.chatConversations)
        .where(eq(T.chatConversations.partnerUserId, PARTNER_USER));
      assert.ok(conversation);
      assert.equal(conversation.unreadForAdmin, 0);
      assert.equal(conversation.unreadForPartner, 0);

      const messages = await db
        .select()
        .from(T.chatMessages)
        .where(eq(T.chatMessages.conversationId, conversation.id))
        .orderBy(T.chatMessages.createdAt);
      assert.deepEqual(
        messages.map((m) => [m.senderRole, m.senderUserId, m.body]),
        [
          ['admin', LEGACY_ADMIN_SENDER, 'Willkommen'],
          ['partner', PARTNER_USER, 'Danke\n[Anhang im alten System: docs/a.pdf]'],
        ],
      );
      assert.equal(messages[0]!.createdAt.toISOString(), '2023-03-01T10:00:00.000Z');
      assert.ok(messages.every((m) => m.readAt));
    });
  },
);
