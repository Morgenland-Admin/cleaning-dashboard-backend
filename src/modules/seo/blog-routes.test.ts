/** Blog endpoints over HTTP: list/search/counts, slug check, duplicate, publish rules, stale-write guard. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { and, eq } from 'drizzle-orm';

import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { company, membership, user } from '../../db/schema/shared.js';

const USER_ID = 'test-blog-routes-seo';
const PREFIX = 'blog/zz-test-';

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

/** light-my-request types json() as any; read it as unknown and name the shape once. */
function json<T>(res: { json: () => unknown }): T {
  return res.json() as T;
}

describe(
  'blog routes (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;
    let slug: string;

    const call = (method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string, payload?: unknown) =>
      app.inject({
        method,
        url: `/admin/seo-pages${url}`,
        headers: {
          'x-test-user': USER_ID,
          'x-company-slug': slug,
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload ? { payload: payload as Record<string, unknown> } : {}),
      });

    async function cleanup() {
      const res = await call('GET', `/posts?q=zz-test-&limit=100`);
      for (const p of json<{ posts: Array<{ id: number }> }>(res).posts) {
        await call('DELETE', `/${p.id}`);
      }
    }

    before(async () => {
      const [activeCompany] = await db
        .select({ slug: company.slug })
        .from(company)
        .where(eq(company.isActive, true))
        .limit(1);
      assert.ok(activeCompany, 'expected at least one active company — run pnpm db:seed:local');
      slug = activeCompany.slug;
      await db
        .insert(user)
        .values({
          id: USER_ID,
          name: 'blog routes test',
          email: `${USER_ID}@example.invalid`,
          emailVerified: true,
          audience: 'admin',
          accessLevel: 'seo',
          isActive: true,
        })
        .onConflictDoNothing();
      await db
        .insert(membership)
        .values({ userId: USER_ID, companySlug: slug, role: 'viewer', acceptedAt: new Date() })
        .onConflictDoNothing();

      app = await buildApp({ logger: false });
      await app.ready();
      const identity = { id: USER_ID, accessLevel: 'seo', audience: 'admin' };
      (app as unknown as { getSession: unknown }).getSession = (request: {
        headers: Record<string, unknown>;
        authUser: unknown;
        authSession: unknown;
      }) => {
        if (request.headers['x-test-user'] !== USER_ID) return Promise.resolve(null);
        const session = { user: identity, session: { userId: USER_ID } };
        request.authSession = session;
        request.authUser = identity;
        return Promise.resolve(session);
      };
      await cleanup();
    });

    after(async () => {
      await cleanup();
      await app?.close();
      await db
        .delete(membership)
        .where(and(eq(membership.userId, USER_ID), eq(membership.companySlug, slug)));
      await db.delete(user).where(eq(user.id, USER_ID));
      await pool.end();
    });

    const create = async (path: string, extra: Record<string, unknown> = {}) => {
      const res = await call('POST', '', { type: 'blog', path: `${PREFIX}${path}`, ...extra });
      assert.equal(res.statusCode, 201, res.body);
      return json<{ page: { id: number; updatedAt: string; path: string } }>(res).page;
    };

    it('lists, searches, sorts and counts blog posts', async () => {
      await create('alpha', { title: 'Zz Alpha', bodyHtml: '<p>Text</p>' });
      await create('beta', {
        title: 'Zz Beta',
        bodyHtml: '<p>Text</p>',
        schemaJsonld: [{ '@type': 'BlogPosting', image: { url: 'https://x.de/a.jpg' } }],
      });

      const all = await call('GET', '/posts?q=zz-test-&sort=title');
      assert.equal(all.statusCode, 200, all.body);
      const body = json<{
        posts: Array<{ title: string; image: string | null }>;
        total: number;
        counts: { all: number; draft: number; attention: number };
      }>(all);
      assert.equal(body.total, 2);
      assert.deepEqual(
        body.posts.map((p) => p.title),
        ['Zz Alpha', 'Zz Beta'],
      );
      assert.equal(body.posts[1]?.image, 'https://x.de/a.jpg');
      assert.equal(body.counts.all, 2);
      assert.equal(body.counts.draft, 2);
      // Alpha has no featured image, so it needs attention.
      assert.equal(body.counts.attention, 1);

      const attention = await call('GET', '/posts?q=zz-test-&attention=1');
      assert.deepEqual(
        json<{ posts: Array<{ title: string }> }>(attention).posts.map((p) => p.title),
        ['Zz Alpha'],
      );
    });

    it('treats LIKE wildcards in the search literally', async () => {
      const res = await call('GET', '/posts?q=zz%25test');
      assert.equal(json<{ total: number }>(res).total, 0);
    });

    it('checks slug availability and suggests the next free one', async () => {
      const taken = await call('GET', `/check-path?path=${PREFIX}alpha`);
      assert.deepEqual(json<unknown>(taken), {
        valid: true,
        available: false,
        suggestion: `${PREFIX}alpha-2`,
      });
      const free = await call('GET', `/check-path?path=${PREFIX}gamma`);
      assert.equal(json<{ available: boolean }>(free).available, true);
      const invalid = await call('GET', `/check-path?path=Blog/Äh`);
      assert.equal(json<{ valid: boolean }>(invalid).valid, false);
    });

    it('refuses to publish a blog post without title or content', async () => {
      const res = await call('POST', '', {
        type: 'blog',
        path: `${PREFIX}empty`,
        status: 'live',
        title: 'Only a title',
      });
      assert.equal(res.statusCode, 400);
      assert.equal(json<{ code: string }>(res).code, 'NOT_READY');

      const draft = await create('empty-draft', { title: 'Draft' });
      const publish = await call('PATCH', `/${draft.id}`, { status: 'live' });
      assert.equal(publish.statusCode, 400);
    });

    it('stores normalised SEO meta and rejects a stale write', async () => {
      const post = await create('meta', { title: 'Zz Meta', bodyHtml: '<p>Text</p>' });
      const first = await call('PATCH', `/${post.id}`, {
        expectedUpdatedAt: post.updatedAt,
        meta: { excerpt: 'Kurz', noindex: false, canonicalUrl: '', focusKeyphrase: 'teppich' },
      });
      assert.equal(first.statusCode, 200, first.body);
      const saved = json<{ page: { meta: unknown; updatedAt: string } }>(first).page;
      assert.deepEqual(saved.meta, { excerpt: 'Kurz', focusKeyphrase: 'teppich' });

      // The original version is now outdated.
      const stale = await call('PATCH', `/${post.id}`, {
        expectedUpdatedAt: post.updatedAt,
        title: 'Older tab',
      });
      assert.equal(stale.statusCode, 409);
      assert.equal(json<{ code: string }>(stale).code, 'STALE');

      const fresh = await call('PATCH', `/${post.id}`, {
        expectedUpdatedAt: saved.updatedAt,
        title: 'Newer',
      });
      assert.equal(fresh.statusCode, 200, fresh.body);
    });

    it('duplicates a post as an undated draft', async () => {
      const src = await create('dup', {
        title: 'Zz Dup',
        bodyHtml: '<p>Text</p>',
        schemaJsonld: { '@type': 'BlogPosting', datePublished: '2026-01-01T00:00:00Z' },
      });
      const res = await call('POST', `/${src.id}/duplicate`);
      assert.equal(res.statusCode, 201, res.body);
      const copy = json<{
        page: { path: string; title: string; status: string; schemaJsonld: unknown };
      }>(res).page;
      assert.equal(copy.path, `${PREFIX}dup-kopie`);
      assert.equal(copy.title, 'Zz Dup (Kopie)');
      assert.equal(copy.status, 'draft');
      assert.deepEqual(copy.schemaJsonld, { '@type': 'BlogPosting' });

      const again = await call('POST', `/${src.id}/duplicate`);
      assert.equal(json<{ page: { path: string } }>(again).page.path, `${PREFIX}dup-kopie-2`);
    });
  },
);
