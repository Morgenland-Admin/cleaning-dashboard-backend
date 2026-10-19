import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { and, eq, sql } from 'drizzle-orm';
import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { membership, user } from '../../db/schema/shared.js';
import { createTenantSchemaSql, getTenantTables } from '../../db/schema/tenant.js';
import { previewOf } from './routes.js';

const SLUG = 'cleanilo';
const SOURCE = 'test_legacy_routes';
const USERS = {
  admin: { id: 'test-legacy-admin', accessLevel: 'admin', audience: 'admin' },
  manager: { id: 'test-legacy-manager', accessLevel: 'manager', audience: 'admin' },
} as const;

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

type Summary = { tables: Array<{ source: string; table: string; count: number }> };
type ListBody = {
  total: number;
  items: Array<{ id: number; legacyId: string; preview: string; data?: unknown }>;
};
type Detail = { record: { data: Record<string, unknown> } };

describe('previewOf', () => {
  it('joins the first readable fields', () => {
    assert.equal(
      previewOf({ name: 'A', email: 'a@x.de', id: 3, message: '  hi\nthere ' }),
      'A · a@x.de · hi there',
    );
  });
});

describe(
  'legacy records admin routes (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;
    const T = getTenantTables(SLUG);

    before(async () => {
      await db.execute(sql.raw(createTenantSchemaSql(SLUG)));
      for (const u of Object.values(USERS)) {
        await db
          .insert(user)
          .values({
            ...u,
            name: u.id,
            email: `${u.id}@example.invalid`,
            emailVerified: true,
            isActive: true,
          })
          .onConflictDoNothing();
        await db
          .insert(membership)
          .values({ userId: u.id, companySlug: SLUG, role: 'admin', acceptedAt: new Date() })
          .onConflictDoNothing();
      }
      await db
        .insert(T.legacyRecords)
        .values([
          {
            source: SOURCE,
            legacyTable: 'orders',
            legacyId: '1',
            data: { name: 'Erika', note: 'Teppich' },
            legacyCreatedAt: new Date('2023-01-02'),
          },
          {
            source: SOURCE,
            legacyTable: 'orders',
            legacyId: '2',
            data: { name: 'Max', note: 'Sofa' },
            legacyCreatedAt: new Date('2024-05-06'),
          },
          {
            source: SOURCE,
            legacyTable: 'chats',
            legacyId: '9',
            data: { message: 'Hallo zzlegacysearch' },
          },
        ])
        .onConflictDoNothing();

      app = await buildApp({ logger: false });
      await app.ready();
      (app as unknown as { getSession: unknown }).getSession = (request: {
        headers: Record<string, unknown>;
        authUser: unknown;
        authSession: unknown;
      }) => {
        const u = USERS[request.headers['x-test-user'] as keyof typeof USERS];
        if (!u) return Promise.resolve(null);
        const session = { user: u, session: { userId: u.id } };
        request.authSession = session;
        request.authUser = u;
        return Promise.resolve(session);
      };
    });

    after(async () => {
      await app?.close();
      await db.delete(T.legacyRecords).where(eq(T.legacyRecords.source, SOURCE));
      for (const u of Object.values(USERS)) {
        await db
          .delete(membership)
          .where(and(eq(membership.userId, u.id), eq(membership.companySlug, SLUG)));
        await db.delete(user).where(eq(user.id, u.id));
      }
      await pool.end();
    });

    const call = (who: keyof typeof USERS, method: 'GET' | 'DELETE', url: string) =>
      app.inject({ method, url, headers: { 'x-test-user': who, 'x-company-slug': SLUG } });
    const json = async <T>(method: 'GET' | 'DELETE', url: string) =>
      (await call('admin', method, url)).json<T>();
    const tableUrl = (table: string, q = '') =>
      `/admin/legacy-records?source=${SOURCE}&table=${table}${q ? `&q=${q}` : ''}`;

    it('is closed to managers', async () => {
      assert.equal((await call('manager', 'GET', '/admin/legacy-records/summary')).statusCode, 403);
      assert.equal((await call('manager', 'DELETE', '/admin/legacy-records/1')).statusCode, 403);
    });

    it('summarises, lists, searches and shows records', async () => {
      const summary = await json<Summary>('GET', '/admin/legacy-records/summary');
      const orders = summary.tables.find((t) => t.source === SOURCE && t.table === 'orders');
      assert.equal(orders?.count, 2);

      const list = await json<ListBody>('GET', tableUrl('orders', 'sofa'));
      assert.equal(list.total, 1);
      assert.equal(list.items[0]?.legacyId, '2');
      assert.equal(list.items[0]?.preview, 'Max');
      assert.equal(list.items[0]?.data, undefined);

      const detail = await json<Detail>('GET', `/admin/legacy-records/${list.items[0]?.id}`);
      assert.deepEqual(detail.record.data, { name: 'Max', note: 'Sofa' });
    });

    it('searches across tables', async () => {
      const found = await json<{ items: Array<{ legacyTable: string }>; hasMore: boolean }>(
        'GET',
        '/admin/legacy-records/search?q=zzlegacysearch',
      );
      assert.ok(found.items.some((i) => i.legacyTable === 'chats'));
      assert.equal(
        (await call('admin', 'GET', '/admin/legacy-records/search?q=x')).statusCode,
        400,
      );
    });

    it('deletes one record and whole tables', async () => {
      const list = await json<ListBody>('GET', tableUrl('orders'));
      const id = list.items[0]?.id;
      assert.equal((await call('admin', 'DELETE', `/admin/legacy-records/${id}`)).statusCode, 200);
      assert.equal((await call('admin', 'GET', `/admin/legacy-records/${id}`)).statusCode, 404);

      const bulk = await json<{ deleted: number }>('DELETE', tableUrl('orders'));
      assert.equal(bulk.deleted, 1);
      const rest = await json<ListBody>('GET', tableUrl('chats'));
      assert.equal(rest.total, 1);
    });
  },
);
