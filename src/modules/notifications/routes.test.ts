import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { membership, user } from '../../db/schema/shared.js';
import { createTenantSchemaSql, getTenantTables } from '../../db/schema/tenant.js';
import { inquiryChannelOf, isImportedSource, senderLabel } from '../../lib/inbox.js';

const SLUG = 'cleanilo';
const ADMIN = { id: 'test-inbox-admin', accessLevel: 'admin', audience: 'admin' } as const;
const TAG = 'zz-inbox-test';

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

describe('inbox helpers', () => {
  it('classifies sources', () => {
    assert.equal(isImportedSource('import_legacy_cleanilo'), true);
    assert.equal(isImportedSource('ai_phone'), false);
    assert.equal(isImportedSource(null), false);
    assert.equal(inquiryChannelOf('ai_phone'), 'phone');
    assert.equal(inquiryChannelOf('email_inbound'), 'email');
    assert.equal(inquiryChannelOf(null), 'web');
  });

  it('never labels a sender with an import placeholder address', () => {
    assert.equal(senderLabel('  ', null, 'altkunde-1@import.cleanilo.local'), '');
    assert.equal(senderLabel('', '+49 40 1', 'a@b.de'), '+49 40 1');
    assert.equal(senderLabel(null, null, 'a@b.de'), 'a@b.de');
  });
});

type Unread = {
  count: number;
  byKind: { inquiry: number; contact: number };
  inquiryChannels: { phone: number; email: number; web: number };
  byBrand: Array<{ slug: string; count: number }>;
};
type List = {
  items: Array<{ kind: string; rowId: number; title: string; channel: string | null }>;
};

describe(
  'notifications, dashboard and search ignore imported history (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;
    const T = getTenantTables(SLUG);
    const inquiryIds: number[] = [];
    const contactIds: number[] = [];
    let before0: Unread;

    const get = async <R>(url: string) =>
      (
        await app.inject({
          method: 'GET',
          url,
          headers: { 'x-test-user': ADMIN.id, 'x-company-slug': SLUG },
        })
      ).json<R>();

    before(async () => {
      await db.execute(sql.raw(createTenantSchemaSql(SLUG)));
      await db
        .insert(user)
        .values({
          ...ADMIN,
          name: ADMIN.id,
          email: `${ADMIN.id}@example.invalid`,
          emailVerified: true,
          isActive: true,
        })
        .onConflictDoNothing();
      await db
        .insert(membership)
        .values({ userId: ADMIN.id, companySlug: SLUG, role: 'admin', acceptedAt: new Date() })
        .onConflictDoNothing();

      app = await buildApp({ logger: false });
      await app.ready();
      (app as unknown as { getSession: unknown }).getSession = (request: {
        headers: Record<string, unknown>;
        authUser: unknown;
        authSession: unknown;
      }) => {
        if (request.headers['x-test-user'] !== ADMIN.id) return Promise.resolve(null);
        const session = { user: ADMIN, session: { userId: ADMIN.id } };
        request.authSession = session;
        request.authUser = ADMIN;
        return Promise.resolve(session);
      };

      before0 = await get<Unread>('/admin/notifications/unread-count');

      const inq = await db
        .insert(T.serviceInquiries)
        .values([
          { name: `${TAG} phone`, phone: '+49 40 000', message: 'x', source: 'ai_phone' },
          { name: '', email: 'lead@example.invalid', message: 'x', source: 'email_inbound' },
          { name: `${TAG} old`, message: 'x', source: 'import_legacy_cleanilo' },
        ])
        .returning({ id: T.serviceInquiries.id });
      inquiryIds.push(...inq.map((r) => r.id));
      const con = await db
        .insert(T.contactMessages)
        .values([
          { name: `${TAG} web`, email: 'c@example.invalid', message: 'x' },
          {
            name: `${TAG} old contact`,
            email: 'altkunde-9@import.cleanilo.local',
            message: 'x',
            source: 'import_legacy_cleanilo',
          },
        ])
        .returning({ id: T.contactMessages.id });
      contactIds.push(...con.map((r) => r.id));
    });

    after(async () => {
      await app?.close();
      if (inquiryIds.length) {
        await db.delete(T.serviceInquiries).where(inArray(T.serviceInquiries.id, inquiryIds));
      }
      if (contactIds.length) {
        await db.delete(T.contactMessages).where(inArray(T.contactMessages.id, contactIds));
      }
      await db
        .delete(membership)
        .where(and(eq(membership.userId, ADMIN.id), eq(membership.companySlug, SLUG)));
      await db.delete(user).where(eq(user.id, ADMIN.id));
      await pool.end();
    });

    it('counts only live new rows, grouped by kind and channel', async () => {
      const now = await get<Unread>('/admin/notifications/unread-count');
      assert.equal(now.count - before0.count, 3);
      assert.equal(now.byKind.inquiry - before0.byKind.inquiry, 2);
      assert.equal(now.byKind.contact - before0.byKind.contact, 1);
      assert.equal(now.inquiryChannels.phone - before0.inquiryChannels.phone, 1);
      assert.equal(now.inquiryChannels.email - before0.inquiryChannels.email, 1);
    });

    it('lists newest live rows with a usable title, filterable by brand', async () => {
      const list = await get<List>(`/admin/notifications?limit=50&brand=${SLUG}`);
      const ours = list.items.filter(
        (i) =>
          (i.kind === 'inquiry' && inquiryIds.includes(i.rowId)) ||
          (i.kind === 'contact' && contactIds.includes(i.rowId)),
      );
      assert.equal(ours.length, 3);
      assert.ok(ours.every((i) => !i.title.includes('old')));
      assert.ok(ours.some((i) => i.title === 'lead@example.invalid' && i.channel === 'email'));
      const other = await get<List>('/admin/notifications?brand=no_such_brand');
      assert.equal(other.items.length, 0);
    });

    it('keeps imported rows out of the overview activity', async () => {
      const summary = await get<{ activity: Array<{ title: string }> }>('/admin/dashboard/summary');
      assert.ok(summary.activity.every((a) => !a.title.includes(`${TAG} old`)));
    });

    it('flags imported search hits and never titles them with a placeholder address', async () => {
      const res = await get<{
        hits: Array<{ kind: string; id: number; title: string; imported: boolean }>;
      }>(`/admin/search?q=${encodeURIComponent(TAG)}&limit=10`);
      const old = res.hits.find((h) => h.kind === 'contact' && h.id === contactIds[1]);
      assert.equal(old?.imported, true);
      assert.ok(res.hits.every((h) => !h.title.includes('@import.cleanilo.local')));
      const firstImported = res.hits.findIndex((h) => h.imported);
      assert.ok(firstImported === -1 || res.hits.slice(firstImported).every((h) => h.imported));
    });
  },
);
