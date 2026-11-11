import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { and, eq, like } from 'drizzle-orm';
import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { brandMaterialDrafts, membership, user } from '../../db/schema/shared.js';

const SLUG = 'cleanilo';
const PATH = 'kunden/zz-test-materials';
const OTHER = 'partner/zz-test-materials';
const ME = { id: 'test-brand-materials-admin', accessLevel: 'admin', audience: 'admin' } as const;
const ME_NAME = 'Brand Materials Tester';

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

type Draft = { templatePath: string; data: unknown; updatedAt: string; updatedByName: string };

describe(
  'brand materials routes (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;

    const cleanup = () =>
      db
        .delete(brandMaterialDrafts)
        .where(
          and(
            eq(brandMaterialDrafts.companySlug, SLUG),
            like(brandMaterialDrafts.templatePath, '%/zz-test-materials'),
          ),
        );

    before(async () => {
      await db
        .insert(user)
        .values({
          ...ME,
          name: ME_NAME,
          email: `${ME.id}@example.invalid`,
          emailVerified: true,
          isActive: true,
        })
        .onConflictDoNothing();
      await db
        .insert(membership)
        .values({ userId: ME.id, companySlug: SLUG, role: 'admin', acceptedAt: new Date() })
        .onConflictDoNothing();
      await cleanup();

      app = await buildApp({ logger: false });
      await app.ready();
      (app as unknown as { getSession: unknown }).getSession = (request: {
        authUser: unknown;
        authSession: unknown;
      }) => {
        const session = { user: ME, session: { userId: ME.id } };
        request.authSession = session;
        request.authUser = ME;
        return Promise.resolve(session);
      };
    });

    after(async () => {
      await app?.close();
      await cleanup();
      await db
        .delete(membership)
        .where(and(eq(membership.userId, ME.id), eq(membership.companySlug, SLUG)));
      await db.delete(user).where(eq(user.id, ME.id));
      await pool.end();
    });

    const call = (method: 'GET' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
      app.inject({
        method,
        url: `/admin/brand-materials${url}`,
        headers: {
          'x-company-slug': SLUG,
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload ? { payload: payload as Record<string, unknown> } : {}),
      });

    let firstUpdatedAt = '';

    it('inserts a draft', async () => {
      const res = await call('PATCH', '', { templatePath: PATH, data: { edits: { a: 'b' } } });
      assert.equal(res.statusCode, 200, res.body);
      const { draft } = res.json<{ draft: Draft }>();
      assert.equal(draft.templatePath, PATH);
      assert.deepEqual(draft.data, { edits: { a: 'b' } });
      assert.equal(draft.updatedByName, ME_NAME);
      firstUpdatedAt = draft.updatedAt;
    });

    it('updates it with the matching expectedUpdatedAt', async () => {
      await new Promise((r) => setTimeout(r, 5));
      const res = await call('PATCH', '', {
        templatePath: PATH,
        data: { edits: { a: 'c' }, utm: true },
        expectedUpdatedAt: firstUpdatedAt,
      });
      assert.equal(res.statusCode, 200, res.body);
      const { draft } = res.json<{ draft: Draft }>();
      assert.deepEqual(draft.data, { edits: { a: 'c' }, utm: true });
      assert.notEqual(draft.updatedAt, firstUpdatedAt);
    });

    it('refuses a stale expectedUpdatedAt with 409 STALE', async () => {
      const res = await call('PATCH', '', {
        templatePath: PATH,
        data: { edits: { a: 'lost' } },
        expectedUpdatedAt: firstUpdatedAt,
      });
      assert.equal(res.statusCode, 409, res.body);
      const body = res.json<{ code: string; updatedAt: string }>();
      assert.equal(body.code, 'STALE');
      assert.ok(body.updatedAt && body.updatedAt !== firstUpdatedAt);
      const [row] = await db
        .select({ data: brandMaterialDrafts.data })
        .from(brandMaterialDrafts)
        .where(
          and(
            eq(brandMaterialDrafts.companySlug, SLUG),
            eq(brandMaterialDrafts.templatePath, PATH),
          ),
        );
      assert.deepEqual(row?.data, { edits: { a: 'c' }, utm: true });
    });

    it('refuses to overwrite an existing row without expectedUpdatedAt', async () => {
      const res = await call('PATCH', '', { templatePath: PATH, data: { edits: { a: 'blind' } } });
      assert.equal(res.statusCode, 409, res.body);
      assert.equal(res.json<{ code: string }>().code, 'STALE');
    });

    it('inserts despite an expectedUpdatedAt when no row exists', async () => {
      const res = await call('PATCH', '', {
        templatePath: OTHER,
        data: { values: { phone: '040' } },
        expectedUpdatedAt: firstUpdatedAt,
      });
      assert.equal(res.statusCode, 200, res.body);
    });

    it('rejects a bad templatePath and an http image URL', async () => {
      const bad = await call('PATCH', '', { templatePath: 'kunden/../x', data: {} });
      assert.equal(bad.statusCode, 400);
      const http = await call('PATCH', '', {
        templatePath: PATH,
        data: { images: { '0': 'http://example.com/a.jpg' } },
      });
      assert.equal(http.statusCode, 400);
    });

    it('rejects an oversized payload with TOO_LARGE', async () => {
      const edits = Object.fromEntries(
        Array.from({ length: 45 }, (_, i) => [`k${i}`, 'x'.repeat(5000)]),
      );
      const res = await call('PATCH', '', { templatePath: PATH, data: { edits } });
      assert.equal(res.statusCode, 400);
      assert.equal(res.json<{ code: string }>().code, 'TOO_LARGE');
    });

    it('lists the brand drafts ordered by templatePath with updatedByName', async () => {
      const res = await call('GET', '');
      assert.equal(res.statusCode, 200, res.body);
      const ours = res
        .json<{ drafts: Draft[] }>()
        .drafts.filter((d) => d.templatePath.endsWith('/zz-test-materials'));
      assert.deepEqual(
        ours.map((d) => d.templatePath),
        [PATH, OTHER],
      );
      assert.ok(ours.every((d) => d.updatedByName === ME_NAME));
    });

    it('deletes idempotently', async () => {
      const first = await call('DELETE', `?templatePath=${encodeURIComponent(OTHER)}`);
      assert.equal(first.statusCode, 200, first.body);
      assert.deepEqual(first.json(), { ok: true });
      const again = await call('DELETE', `?templatePath=${encodeURIComponent(OTHER)}`);
      assert.equal(again.statusCode, 200);
      const list = (await call('GET', '')).json<{ drafts: Draft[] }>();
      assert.ok(!list.drafts.some((d) => d.templatePath === OTHER));
    });
  },
);
