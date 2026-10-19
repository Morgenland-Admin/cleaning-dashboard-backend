import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { membership, user } from '../../db/schema/shared.js';
import { createTenantSchemaSql, getTenantTables } from '../../db/schema/tenant.js';
import { inquiryIdFromQuery, likePattern } from './filters.js';

const SLUG = 'cleanilo';
const SOURCE = 'test_inbox_list';
// Rows written by one statement share a microsecond created_at (like the legacy import).
const SAME = 'test_inbox_same_ts';
const SAME_TS = sql`'2020-03-02 10:00:00.123456+00'::timestamptz`;
const ADMIN = { id: 'test-inbox-admin', accessLevel: 'admin', audience: 'admin' } as const;

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

type InquiryList = {
  inquiries: Array<{ id: number; name: string; status: string }>;
  nextCursor: string | null;
};
type ContactList = { messages: Array<{ id: number; name: string }>; nextCursor: string | null };
type Counts = { byStatus: Record<string, number>; bySource: Record<string, number> };
type CallbackQueue = {
  inquiries: Array<{ id: number; name: string }>;
  nextCursor: string | null;
  total: number | null;
};

describe('list filter helpers', () => {
  it('escapes LIKE wildcards', () => {
    assert.equal(likePattern('50%_a\\b'), '%50\\%\\_a\\\\b%');
  });

  it('reads ids, #ids and inquiry numbers', () => {
    assert.equal(inquiryIdFromQuery('123'), 123);
    assert.equal(inquiryIdFromQuery('#123'), 123);
    assert.equal(inquiryIdFromQuery('ANF-2026-000123'), 123);
    assert.equal(inquiryIdFromQuery('anf-2026-000123'), 123);
    assert.equal(inquiryIdFromQuery('Teppich'), null);
    assert.equal(inquiryIdFromQuery('0'), null);
    assert.equal(inquiryIdFromQuery('99999999999'), null);
  });
});

describe(
  'inbox list routes (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;
    const T = getTenantTables(SLUG);
    const base = new Date('2020-03-01T10:00:00Z').getTime();
    const at = (minutes: number) => new Date(base + minutes * 60_000);

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

      const inquiry = (name: string, status: string, minutes: number, extra = {}) => ({
        name,
        status,
        message: `Nachricht von ${name}`,
        source: SOURCE,
        createdAt: at(minutes),
        ...extra,
      });
      await db
        .insert(T.serviceInquiries)
        .values([
          inquiry('Anna Neu', 'new', 1, { callbackOwner: 'human', phone: '040 111' }),
          inquiry('Bernd Pruefung', 'in_review', 2),
          inquiry('Clara Angebot', 'quoted', 3, { service: 'Orientteppich' }),
          inquiry('Dora Verloren', 'lost', 4),
          inquiry('Emil Neu', 'new', 5, { callbackOwner: 'human', phone: '040 222' }),
          inquiry('Frida Neu', 'new', 6, { callbackOwner: 'human', phone: '040 333' }),
        ]);

      await db.insert(T.contactMessages).values(
        ['new', 'read', 'replied', 'archived', 'archived'].map((status, i) => ({
          name: `Kontakt ${i}`,
          email: i === 4 ? 'alt-1@import.cleanilo.local' : `kontakt${i}@example.invalid`,
          message: i === 2 ? 'Frage zum Sofa' : 'Hallo',
          status,
          source: SOURCE,
          createdAt: at(i),
        })),
      );

      await db.insert(T.serviceInquiries).values(
        [1, 2, 3, 4, 5].map((n) => ({
          name: `Gleichzeitig ${n}`,
          status: 'new',
          message: 'Import',
          source: SAME,
          callbackOwner: 'human',
          createdAt: SAME_TS,
        })),
      );
      await db.insert(T.contactMessages).values(
        [1, 2, 3, 4, 5].map((n) => ({
          name: `Gleichzeitig ${n}`,
          email: `same${n}@example.invalid`,
          message: 'Import',
          status: 'archived',
          source: SAME,
          createdAt: SAME_TS,
        })),
      );

      app = await buildApp({ logger: false });
      await app.ready();
      (app as unknown as { getSession: unknown }).getSession = (request: {
        authUser: unknown;
        authSession: unknown;
      }) => {
        const session = { user: ADMIN, session: { userId: ADMIN.id } };
        request.authSession = session;
        request.authUser = ADMIN;
        return Promise.resolve(session);
      };
    });

    after(async () => {
      await app?.close();
      await db.delete(T.serviceInquiries).where(inArray(T.serviceInquiries.source, [SOURCE, SAME]));
      await db.delete(T.contactMessages).where(inArray(T.contactMessages.source, [SOURCE, SAME]));
      await db
        .delete(membership)
        .where(and(eq(membership.userId, ADMIN.id), eq(membership.companySlug, SLUG)));
      await db.delete(user).where(eq(user.id, ADMIN.id));
      await pool.end();
    });

    const get = async <B>(url: string) => {
      const res = await app.inject({ method: 'GET', url, headers: { 'x-company-slug': SLUG } });
      assert.equal(res.statusCode, 200, res.body);
      return res.json<B>();
    };
    const names = (rows: Array<{ name: string }>) => rows.map((r) => r.name);

    it('filters inquiries by status group, status and search', async () => {
      const open = await get<InquiryList>(`/admin/inquiries?source=${SOURCE}&status=open`);
      assert.deepEqual(names(open.inquiries), [
        'Frida Neu',
        'Emil Neu',
        'Bernd Pruefung',
        'Anna Neu',
      ]);
      const lost = await get<InquiryList>(`/admin/inquiries?source=${SOURCE}&status=lost`);
      assert.deepEqual(names(lost.inquiries), ['Dora Verloren']);
      const found = await get<InquiryList>(`/admin/inquiries?source=${SOURCE}&q=orient`);
      assert.deepEqual(names(found.inquiries), ['Clara Angebot']);
      const byId = await get<InquiryList>(
        `/admin/inquiries?source=${SOURCE}&q=%23${found.inquiries[0]!.id}`,
      );
      assert.deepEqual(names(byId.inquiries), ['Clara Angebot']);
    });

    it('pages inquiries with a keyset cursor', async () => {
      const first = await get<InquiryList>(`/admin/inquiries?source=${SOURCE}&limit=4`);
      assert.equal(first.inquiries.length, 4);
      assert.ok(first.nextCursor);
      const second = await get<InquiryList>(
        `/admin/inquiries?source=${SOURCE}&limit=4&cursor=${first.nextCursor}`,
      );
      assert.deepEqual(names(second.inquiries), ['Bernd Pruefung', 'Anna Neu']);
      assert.equal(second.nextCursor, null);
    });

    // Walks every page with `limit` and returns the names seen, in order.
    async function walk<R extends { name: string }>(
      url: string,
      pick: (body: never) => { rows: R[]; nextCursor: string | null },
    ) {
      const seen: string[] = [];
      let cursor: string | null = null;
      for (let guard = 0; guard < 100; guard++) {
        const body = await get<never>(`${url}${cursor ? `&cursor=${cursor}` : ''}`);
        const page = pick(body);
        seen.push(...page.rows.map((r) => r.name));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      return seen;
    }
    const same = [1, 2, 3, 4, 5].map((n) => `Gleichzeitig ${n}`);

    it('pages rows sharing one microsecond timestamp without dropping any', async () => {
      const inquiries = await walk(`/admin/inquiries?source=${SAME}&limit=2`, (b: InquiryList) => ({
        rows: b.inquiries,
        nextCursor: b.nextCursor,
      }));
      assert.deepEqual(inquiries, [...same].reverse());
      const contacts = await walk(`/admin/contact?source=${SAME}&limit=2`, (b: ContactList) => ({
        rows: b.messages,
        nextCursor: b.nextCursor,
      }));
      assert.deepEqual(contacts, [...same].reverse());
      const queue = await walk(
        '/admin/inquiries/human-callback-queue?limit=2',
        (b: CallbackQueue) => ({ rows: b.inquiries, nextCursor: b.nextCursor }),
      );
      assert.deepEqual(
        queue.filter((n) => n.startsWith('Gleichzeitig')),
        same,
      );
    });

    it('counts inquiries per status and source', async () => {
      const counts = await get<Counts>(`/admin/inquiries/counts?source=${SOURCE}`);
      assert.deepEqual(counts.byStatus, { new: 3, in_review: 1, quoted: 1, lost: 1 });
      assert.equal(counts.bySource[SOURCE], 6);
      const searched = await get<Counts>(
        `/admin/inquiries/counts?source=${SOURCE}&q=neu&status=open`,
      );
      assert.deepEqual(searched.byStatus, { new: 3 });
      assert.equal(searched.bySource[SOURCE], 3);
    });

    it('pages the human callback queue oldest first', async () => {
      const all = await get<CallbackQueue>('/admin/inquiries/human-callback-queue?limit=200');
      const ours = all.inquiries.filter((r) => r.name.endsWith(' Neu'));
      assert.deepEqual(names(ours), ['Anna Neu', 'Emil Neu', 'Frida Neu']);
      assert.ok((all.total ?? 0) >= 3);

      const first = await get<CallbackQueue>('/admin/inquiries/human-callback-queue?limit=1');
      assert.equal(first.inquiries.length, 1);
      assert.ok(first.nextCursor);
      const second = await get<CallbackQueue>(
        `/admin/inquiries/human-callback-queue?limit=1&cursor=${first.nextCursor}`,
      );
      assert.equal(second.total, null);
      assert.notEqual(second.inquiries[0]?.id, first.inquiries[0]?.id);
    });

    it('filters and counts contact requests', async () => {
      const open = await get<ContactList>(`/admin/contact?source=${SOURCE}&status=open`);
      assert.deepEqual(names(open.messages), ['Kontakt 1', 'Kontakt 0']);
      const found = await get<ContactList>(`/admin/contact?source=${SOURCE}&q=sofa`);
      assert.deepEqual(names(found.messages), ['Kontakt 2']);
      const counts = await get<Counts>(`/admin/contact/counts?source=${SOURCE}`);
      assert.deepEqual(counts.byStatus, { new: 1, read: 1, replied: 1, archived: 2 });
    });
  },
);
