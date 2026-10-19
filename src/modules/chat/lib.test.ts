import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { eq, sql } from 'drizzle-orm';
import { db, pool } from '../../db/index.js';
import { createTenantSchemaSql, getTenantTables } from '../../db/schema/tenant.js';
import { ensureConversation, markDelivered, markRead, messagePage, previewOf } from './lib.js';

const SLUG = 'cleanilo';
const PARTNER_USER = 'test-chat-lib-partner';

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

describe('previewOf', () => {
  it('uses the text, collapsed to one line', () => {
    assert.equal(previewOf('  Hallo\n\nwie   geht es? '), 'Hallo wie geht es?');
    assert.equal(previewOf('x'.repeat(300)).length, 200);
  });
  it('falls back to the file names', () => {
    assert.equal(previewOf(null, [{ name: 'a.pdf' }]), '📎 a.pdf');
    assert.equal(previewOf('', [{ name: 'a.pdf' }, { name: 'b.jpg' }]), '📎 a.pdf +1');
  });
  it('hides legacy file markers', () => {
    assert.equal(previewOf('Danke\n[Anhang im alten System: docs/a.pdf]'), 'Danke');
    assert.equal(previewOf('[Anhang im alten System: docs/a.pdf]'), '📎 Anhang (altes System)');
  });
});

describe(
  'chat paging and receipts',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    const T = getTenantTables(SLUG);
    let conversationId = 0;
    const ids: number[] = [];

    before(async () => {
      await db.execute(sql.raw(createTenantSchemaSql(SLUG)));
      const [conv] = await db
        .insert(T.chatConversations)
        .values({ partnerUserId: PARTNER_USER })
        .returning();
      conversationId = conv!.id;
      // Two rows share a timestamp so the id tie-break is exercised.
      const at = (min: number) => new Date(Date.UTC(2026, 0, 1, 10, min));
      const rows = await db
        .insert(T.chatMessages)
        .values(
          [0, 1, 2, 2, 3].map((min, i) => ({
            conversationId,
            senderUserId: i % 2 ? PARTNER_USER : 'test-admin',
            senderRole: i % 2 ? 'partner' : 'admin',
            body: `m${i}`,
            createdAt: at(min),
          })),
        )
        .returning({ id: T.chatMessages.id });
      ids.push(...rows.map((r) => r.id));
    });

    after(async () => {
      await db
        .delete(T.chatConversations)
        .where(eq(T.chatConversations.partnerUserId, PARTNER_USER));
      await pool.end();
    });

    it('returns the newest page oldest-first, then older pages', async () => {
      const first = await messagePage(T, conversationId, { limit: 2 });
      assert.deepEqual(
        first.rows.map((r) => r.body),
        ['m3', 'm4'],
      );
      assert.equal(first.hasMore, true);
      const second = await messagePage(T, conversationId, { before: first.rows[0]!.id, limit: 2 });
      assert.deepEqual(
        second.rows.map((r) => r.body),
        ['m1', 'm2'],
      );
      const last = await messagePage(T, conversationId, { before: second.rows[0]!.id, limit: 2 });
      assert.deepEqual(
        last.rows.map((r) => r.body),
        ['m0'],
      );
      assert.equal(last.hasMore, false);
    });

    it('parallel first calls create exactly one conversation', async () => {
      const user = `${PARTNER_USER}-race`;
      const convs = await Promise.all(Array.from({ length: 5 }, () => ensureConversation(T, user)));
      assert.equal(new Set(convs.map((c) => c.id)).size, 1);
      const rows = await db
        .select()
        .from(T.chatConversations)
        .where(eq(T.chatConversations.partnerUserId, user));
      assert.equal(rows.length, 1);
      await db.delete(T.chatConversations).where(eq(T.chatConversations.partnerUserId, user));
    });

    it('marks only the sender side delivered, and read implies delivered', async () => {
      await markDelivered(
        T,
        SLUG,
        [{ id: conversationId, partnerUserId: PARTNER_USER }],
        'partner',
      );
      const rows = await db
        .select()
        .from(T.chatMessages)
        .where(eq(T.chatMessages.conversationId, conversationId));
      for (const r of rows) {
        assert.equal(!!r.deliveredAt, r.senderRole === 'partner', `delivered ${r.body}`);
      }

      await markRead(T, conversationId, 'admin', new Date());
      const after = await db
        .select()
        .from(T.chatMessages)
        .where(eq(T.chatMessages.conversationId, conversationId));
      for (const r of after.filter((x) => x.senderRole === 'admin')) {
        assert.ok(r.readAt && r.deliveredAt, `read ${r.body}`);
      }
    });
  },
);
