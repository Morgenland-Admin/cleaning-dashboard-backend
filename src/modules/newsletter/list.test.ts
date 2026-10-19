// Admin newsletter list: server-side status filter, search, per-status counts and paging across
// rows that share a created_at. Session is stubbed (`x-test-user`); skips without a database.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { eq, inArray } from 'drizzle-orm';

import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { company, membership, user } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';

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

const USER = { id: 'test-newsletter-list-viewer', accessLevel: 'viewer', audience: 'admin' };

interface ListBody {
  subscribers: Array<{ id: number; email: string }>;
  nextCursor: string | null;
  counts: { all: number; confirmed: number; pending: number; unsubscribed: number } | null;
}

describe(
  'newsletter admin list (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;
    let slug: string;
    let tables: ReturnType<typeof getTenantTables>;
    const tag = `nl-${randomBytes(4).toString('hex')}`;
    const ids: number[] = [];

    before(async () => {
      const [brand] = await db
        .select({ slug: company.slug, schemaName: company.schemaName })
        .from(company)
        .where(eq(company.isActive, true))
        .limit(1);
      assert.ok(brand, 'expected an active company — run pnpm db:seed:local');
      slug = brand.slug;
      tables = getTenantTables(brand.schemaName);

      await db
        .insert(user)
        .values({
          ...USER,
          name: 'newsletter list viewer',
          email: `${USER.id}@example.invalid`,
          emailVerified: true,
          isActive: true,
        })
        .onConflictDoNothing();
      await db
        .insert(membership)
        .values({ userId: USER.id, companySlug: slug, role: 'admin', acceptedAt: new Date() })
        .onConflictDoNothing();

      // One statement: every row gets the same microsecond created_at, like a CSV import.
      const rows = await db
        .insert(tables.newsletterSubscribers)
        .values([
          { email: `${tag}-a@example.invalid`, confirmed: true },
          { email: `${tag}-b@example.invalid`, confirmed: true },
          { email: `${tag}-c@example.invalid`, confirmed: false },
          { email: `${tag}-d@example.invalid`, confirmed: true, unsubscribedAt: new Date() },
        ])
        .returning({ id: tables.newsletterSubscribers.id });
      ids.push(...rows.map((r) => r.id));

      app = await buildApp({ logger: false });
      await app.ready();
      (app as unknown as { getSession: unknown }).getSession = (request: {
        headers: Record<string, unknown>;
        authUser: unknown;
        authSession: unknown;
      }) => {
        if (request.headers['x-test-user'] !== USER.id) return Promise.resolve(null);
        const session = { user: USER, session: { userId: USER.id } };
        request.authSession = session;
        request.authUser = USER;
        return Promise.resolve(session);
      };
    });

    after(async () => {
      await app?.close();
      await db
        .delete(tables.newsletterSubscribers)
        .where(inArray(tables.newsletterSubscribers.id, ids));
      await db.delete(membership).where(eq(membership.userId, USER.id));
      await db.delete(user).where(eq(user.id, USER.id));
      await pool.end();
    });

    const list = async (qs: string) => {
      const res = await app.inject({
        method: 'GET',
        url: `/admin/newsletter?q=${tag}&${qs}`,
        headers: { 'x-test-user': USER.id, 'x-company-slug': slug },
      });
      assert.equal(res.statusCode, 200, res.body);
      return res.json<ListBody>();
    };

    it('counts every status for the search on the first page', async () => {
      const body = await list('limit=50');
      assert.deepEqual(body.counts, { all: 4, confirmed: 2, pending: 1, unsubscribed: 1 });
    });

    it('filters by status on the server', async () => {
      const body = await list('status=confirmed&limit=50');
      assert.deepEqual(body.subscribers.map((s) => s.email).sort(), [
        `${tag}-a@example.invalid`,
        `${tag}-b@example.invalid`,
      ]);
    });

    it('pages through rows that share a created_at without dropping any', async () => {
      const seen: number[] = [];
      let cursor: string | null = null;
      do {
        const body: ListBody = await list(
          `limit=1${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`,
        );
        assert.equal(body.counts === null, cursor !== null);
        seen.push(...body.subscribers.map((s) => s.id));
        cursor = body.nextCursor;
      } while (cursor && seen.length < 10);
      assert.deepEqual([...seen].sort(), [...ids].sort());
    });
  },
);
