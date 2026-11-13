import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ensureTenantSchemaForTests } from '../../db/test-tenant-schema.js';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { membership, user } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';
import { publicReviewerName } from './routes.js';

const SLUG = 'cleanilo';
const ADMIN = { id: 'test-reviews-admin', accessLevel: 'admin', audience: 'admin' } as const;
// Far future so these rows head the list; microseconds so a millisecond cursor alone would lose them.
const SHARED_CREATED_AT = '2999-01-01T00:00:00.123456Z';

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

type Page = { reviews: Array<{ id: number }>; nextCursor: string | null };

describe('publicReviewerName', () => {
  it('shows first name and city, never the last name', () => {
    assert.equal(publicReviewerName('Max Mustermann', 'Hamburg'), 'Max aus Hamburg');
    assert.equal(publicReviewerName('  Max   Mustermann ', '  Hamburg '), 'Max aus Hamburg');
    assert.equal(publicReviewerName('Max Mustermann', null), 'Max');
    assert.equal(publicReviewerName('Max Mustermann', '  '), 'Max');
    assert.equal(publicReviewerName(null, 'Hamburg'), 'Kunde');
  });
});

describe(
  'reviews lists (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;
    const T = getTenantTables(SLUG);
    const ids: number[] = [];
    const orderIds: number[] = [];
    const publishedIds: number[] = [];

    before(async () => {
      await ensureTenantSchemaForTests(SLUG);
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
      const rows = await db
        .insert(T.reviews)
        .values(
          [1, 2, 3, 4, 5].map((n) => ({
            customerName: `zz-review-paging ${n}`,
            rating: 5,
            status: 'hidden',
            createdAt: sql`${SHARED_CREATED_AT}::timestamptz`,
          })),
        )
        .returning({ id: T.reviews.id });
      ids.push(...rows.map((r) => r.id));
      const [order] = await db
        .insert(T.orders)
        .values({
          publicToken: `zz-review-city-${Date.now()}`,
          kind: 'teppichreinigung',
          subtotalCents: 0,
          totalCents: 0,
          pickupMode: 'drop_off',
          customerName: 'Max Mustermann (Test)',
          customerEmail: 'zz-review-city@example.invalid',
          addressCity: 'Hamburg',
        })
        .returning({ id: T.orders.id });
      orderIds.push(order!.id);
      const published = await db
        .insert(T.reviews)
        .values(
          [
            { orderId: order!.id, customerName: 'Max Mustermann (Test)' },
            { orderId: null, customerName: 'Erika Musterfrau' },
          ].map((r) => ({
            ...r,
            rating: 5,
            status: 'published',
            createdAt: sql`${SHARED_CREATED_AT}::timestamptz`,
          })),
        )
        .returning({ id: T.reviews.id });
      publishedIds.push(...published.map((r) => r.id));

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
    });

    after(async () => {
      await app?.close();
      const reviewIds = [...ids, ...publishedIds];
      if (reviewIds.length) await db.delete(T.reviews).where(inArray(T.reviews.id, reviewIds));
      if (orderIds.length) await db.delete(T.orders).where(inArray(T.orders.id, orderIds));
      await db
        .delete(membership)
        .where(and(eq(membership.userId, ADMIN.id), eq(membership.companySlug, SLUG)));
      await db.delete(user).where(eq(user.id, ADMIN.id));
      await pool.end();
    });

    it('public list names reviewers by first name and order city', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/storefront/reviews?limit=50',
        headers: { 'x-company-slug': SLUG },
      });
      assert.equal(res.statusCode, 200);
      const names = res
        .json<{ reviews: Array<{ id: number; authorName: string }> }>()
        .reviews.filter((r) => publishedIds.includes(r.id))
        .map((r) => r.authorName)
        .sort();
      assert.deepEqual(names, ['Erika', 'Max aus Hamburg']);
    });

    it('pages through rows that share one created_at without dropping any', async () => {
      const seen: number[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 5; i++) {
        const qs = new URLSearchParams({ limit: '2', status: 'hidden' });
        if (cursor) qs.set('cursor', cursor);
        const res = await app.inject({
          method: 'GET',
          url: `/admin/reviews?${qs.toString()}`,
          headers: { 'x-test-user': ADMIN.id, 'x-company-slug': SLUG },
        });
        assert.equal(res.statusCode, 200);
        const page = res.json<Page>();
        seen.push(...page.reviews.map((r) => r.id).filter((id) => ids.includes(id)));
        cursor = page.nextCursor;
        if (seen.length >= ids.length || !cursor) break;
      }
      assert.deepEqual(
        [...seen].sort((a, b) => a - b),
        [...ids].sort((a, b) => a - b),
      );
    });
  },
);
