import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { and, eq, like } from 'drizzle-orm';

import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { account, company, membership, session, user } from '../../db/schema/shared.js';

type Level = 'super_admin' | 'admin' | 'manager' | 'seo' | 'viewer';

const PREFIX = 'test-staff-';
const EMAIL_DOMAIN = '@staff-test.invalid';
const IDS: Record<Level, string> = {
  super_admin: `${PREFIX}super`,
  admin: `${PREFIX}admin`,
  manager: `${PREFIX}manager`,
  seo: `${PREFIX}seo`,
  viewer: `${PREFIX}viewer`,
};

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

describe(
  'staff user management (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;
    let slug: string;

    async function cleanup() {
      await db.delete(user).where(like(user.email, `%${EMAIL_DOMAIN}`));
    }

    before(async () => {
      const [c] = await db
        .select({ slug: company.slug })
        .from(company)
        .where(eq(company.isActive, true))
        .limit(1);
      assert.ok(c, 'expected at least one active company — run pnpm db:seed:local');
      slug = c.slug;
      await cleanup();

      for (const [level, id] of Object.entries(IDS)) {
        await db.insert(user).values({
          id,
          name: `staff ${level}`,
          firstName: 'staff',
          lastName: level,
          email: `${id}${EMAIL_DOMAIN}`,
          emailVerified: true,
          audience: 'admin',
          accessLevel: level,
          isActive: true,
        });
        await db
          .insert(membership)
          .values({ userId: id, companySlug: slug, role: 'admin', acceptedAt: new Date() });
      }

      app = await buildApp({ logger: false });
      await app.ready();

      // Stubbed session, real routes (same approach as write-access.test.ts).
      (app as unknown as { getSession: unknown }).getSession = (request: {
        headers: Record<string, unknown>;
        authUser: unknown;
        authSession: unknown;
      }) => {
        const level = request.headers['x-test-user'] as Level | undefined;
        if (!level || !(level in IDS)) return Promise.resolve(null);
        const identity = { id: IDS[level], accessLevel: level, audience: 'admin', isActive: true };
        const s = { user: identity, session: { userId: identity.id } };
        request.authSession = s;
        request.authUser = identity;
        return Promise.resolve(s);
      };
    });

    after(async () => {
      await app?.close();
      await cleanup();
      await pool.end();
    });

    const call = (
      level: Level,
      method: 'GET' | 'POST' | 'PATCH',
      url: string,
      payload?: Record<string, unknown>,
    ) =>
      app.inject({
        method,
        url,
        headers: {
          'x-test-user': level,
          ...(payload ? { 'content-type': 'application/json' } : {}),
        },
        ...(payload ? { payload } : {}),
      });

    const newUser = (overrides: Record<string, unknown> = {}) => ({
      email: `${PREFIX}new-${Math.random().toString(36).slice(2, 8)}${EMAIL_DOMAIN}`,
      firstName: 'Neu',
      lastName: 'Person',
      password: 'correct-horse-battery',
      accessLevel: 'manager',
      companySlugs: [slug],
      ...overrides,
    });

    it('is closed to manager, seo and viewer', async () => {
      for (const level of ['manager', 'seo', 'viewer'] as const) {
        const res = await call(level, 'GET', '/admin/staff');
        assert.equal(res.statusCode, 403, `${level} GET /admin/staff`);
      }
      assert.equal((await call('admin', 'GET', '/admin/staff')).statusCode, 200);
      assert.equal((await call('super_admin', 'GET', '/admin/staff')).statusCode, 200);
    });

    it('creates a user with a password and brand memberships', async () => {
      const body = newUser({ email: `${PREFIX}Mixed.Case${EMAIL_DOMAIN}` });
      const res = await call('admin', 'POST', '/admin/staff', body);
      assert.equal(res.statusCode, 201, res.body);
      const created = res.json<{ user: { id: string; email: string } }>().user;
      assert.equal(created.email, body.email.toLowerCase());

      const [m] = await db
        .select({ role: membership.role })
        .from(membership)
        .where(eq(membership.userId, created.id));
      assert.equal(m?.role, 'manager');
      const [cred] = await db
        .select({ password: account.password })
        .from(account)
        .where(and(eq(account.userId, created.id), eq(account.providerId, 'credential')));
      assert.ok(cred?.password && cred.password !== body.password, 'password stored hashed');

      const dup = await call('admin', 'POST', '/admin/staff', body);
      assert.equal(dup.statusCode, 409);
    });

    it('keeps super_admin out of an admin’s reach', async () => {
      const grant = await call(
        'admin',
        'POST',
        '/admin/staff',
        newUser({ accessLevel: 'super_admin' }),
      );
      assert.equal(grant.statusCode, 403);
      const edit = await call('admin', 'PATCH', `/admin/staff/${IDS.super_admin}`, {
        firstName: 'X',
      });
      assert.equal(edit.statusCode, 403);
      const pw = await call('admin', 'POST', `/admin/staff/${IDS.super_admin}/password`, {
        password: 'another-long-one',
      });
      assert.equal(pw.statusCode, 403);
    });

    it('stops users from locking themselves out', async () => {
      const demote = await call('admin', 'PATCH', `/admin/staff/${IDS.admin}`, {
        accessLevel: 'viewer',
      });
      assert.equal(demote.statusCode, 400);
      const disable = await call('admin', 'PATCH', `/admin/staff/${IDS.admin}`, {
        isActive: false,
      });
      assert.equal(disable.statusCode, 400);
      const rename = await call('admin', 'PATCH', `/admin/staff/${IDS.admin}`, {
        firstName: 'Renamed',
        accessLevel: 'admin',
        isActive: true,
        companySlugs: [slug],
      });
      assert.equal(rename.statusCode, 200, rename.body);
    });

    it('deactivating and password reset end the user’s sessions', async () => {
      const res = await call('admin', 'POST', '/admin/staff', newUser());
      const id = res.json<{ user: { id: string } }>().user.id;
      const addSession = (n: string) =>
        db.insert(session).values({
          id: `${PREFIX}${n}`,
          userId: id,
          token: `${PREFIX}token-${n}`,
          expiresAt: new Date(Date.now() + 86_400_000),
        });

      await addSession('a');
      const pw = await call('admin', 'POST', `/admin/staff/${id}/password`, {
        password: 'brand-new-password',
      });
      assert.equal(pw.statusCode, 200, pw.body);
      assert.equal((await db.select().from(session).where(eq(session.userId, id))).length, 0);

      await addSession('b');
      const off = await call('admin', 'PATCH', `/admin/staff/${id}`, { isActive: false });
      assert.equal(off.statusCode, 200, off.body);
      assert.equal((await db.select().from(session).where(eq(session.userId, id))).length, 0);

      const list = await call('admin', 'GET', '/admin/staff?status=inactive');
      const ids = list.json<{ users: Array<{ id: string }> }>().users.map((u) => u.id);
      assert.ok(ids.includes(id));
    });

    it('does not expose partner or customer accounts', async () => {
      const id = `${PREFIX}partner`;
      await db.insert(user).values({
        id,
        name: 'partner',
        email: `${id}${EMAIL_DOMAIN}`,
        audience: 'partner',
        accessLevel: 'viewer',
      });
      assert.equal((await call('admin', 'GET', `/admin/staff/${id}`)).statusCode, 404);
    });
  },
);
