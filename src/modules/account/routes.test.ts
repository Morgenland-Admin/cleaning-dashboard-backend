import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { inArray, sql } from 'drizzle-orm';
import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { createTenantSchemaSql, getTenantTables } from '../../db/schema/tenant.js';
import { env } from '../../config/env.js';
import { signCustomerToken, verifyCustomerToken } from '../../lib/token.js';
import { loginLinkOrigin } from './routes.js';

const SLUG = 'cleanilo';
const EMAIL = 'zz-account-test@example.invalid';
const OTHER = 'zz-account-other@example.invalid';

describe('customer token', () => {
  it('round-trips and is bound to brand, use and expiry', () => {
    const t = signCustomerToken(' Kunde@Example.com ', SLUG, 'login', 60);
    assert.deepEqual(verifyCustomerToken(t, SLUG, 'login'), { email: 'kunde@example.com' });
    assert.equal(verifyCustomerToken(t, SLUG, 'session'), null);
    assert.equal(verifyCustomerToken(t, 'hamburg', 'login'), null);
    assert.equal(verifyCustomerToken(`${t}x`, SLUG, 'login'), null);
    assert.equal(
      verifyCustomerToken(signCustomerToken(EMAIL, SLUG, 'login', -1), SLUG, 'login'),
      null,
    );
  });
});

describe('login link origin', () => {
  const brand = {
    storefrontOrigin: 'https://www.cleanilo.de/',
    storefrontAliases: ['https://cleanilo.de'],
  };

  it('links back to a storefront the API trusts', () => {
    assert.equal(loginLinkOrigin('https://cleanilo.de', brand), 'https://cleanilo.de');
    const envOrigin = env.CORS_ORIGINS[0];
    if (envOrigin) assert.equal(loginLinkOrigin(envOrigin, brand), envOrigin);
  });

  it('falls back to the brand storefront for unknown or missing origins', () => {
    assert.equal(loginLinkOrigin('https://evil.example', brand), 'https://www.cleanilo.de');
    assert.equal(loginLinkOrigin(undefined, brand), 'https://www.cleanilo.de');
    assert.equal(
      loginLinkOrigin(undefined, { storefrontOrigin: null, storefrontAliases: [] }),
      env.APP_BASE_URL.replace(/\/$/, ''),
    );
  });
});

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
  'storefront account (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;
    const T = getTenantTables(SLUG);
    const ids: number[] = [];
    const headers = { 'x-company-slug': SLUG };

    const order = (token: string, email: string, status: string) => ({
      publicToken: token,
      kind: 'teppichreinigung',
      status,
      subtotalCents: 1000,
      totalCents: 1000,
      pickupMode: 'dropoff',
      customerName: 'zz account test',
      customerEmail: email,
    });

    before(async () => {
      await db.execute(sql.raw(createTenantSchemaSql(SLUG)));
      const rows = await db
        .insert(T.orders)
        .values([
          order('zz-account-paid', EMAIL.toUpperCase(), 'paid'),
          order('zz-account-abandoned', EMAIL, 'pending'),
          order('zz-account-foreign', OTHER, 'paid'),
        ] as (typeof T.orders.$inferInsert)[])
        .returning({ id: T.orders.id });
      ids.push(...rows.map((r) => r.id));
      app = await buildApp({ logger: false });
      await app.ready();
    });

    after(async () => {
      await app?.close();
      if (ids.length) await db.delete(T.orders).where(inArray(T.orders.id, ids));
      await pool.end();
    });

    it('rejects order listing without a session', async () => {
      const res = await app.inject({ method: 'GET', url: '/storefront/account/orders', headers });
      assert.equal(res.statusCode, 401);
      const login = signCustomerToken(EMAIL, SLUG, 'login', 60);
      const asSession = await app.inject({
        method: 'GET',
        url: '/storefront/account/orders',
        headers: { ...headers, authorization: `Bearer ${login}` },
      });
      assert.equal(asSession.statusCode, 401);
    });

    it('exchanges a login link for a session and lists only own, real orders', async () => {
      const bad = await app.inject({
        method: 'POST',
        url: '/storefront/account/session',
        headers,
        payload: { token: 'x'.repeat(40) },
      });
      assert.equal(bad.statusCode, 401);

      const res = await app.inject({
        method: 'POST',
        url: '/storefront/account/session',
        headers,
        payload: { token: signCustomerToken(EMAIL, SLUG, 'login', 60) },
      });
      assert.equal(res.statusCode, 200);
      const { sessionToken } = res.json<{ sessionToken: string }>();

      const list = await app.inject({
        method: 'GET',
        url: '/storefront/account/orders',
        headers: { ...headers, authorization: `Bearer ${sessionToken}` },
      });
      assert.equal(list.statusCode, 200);
      const body = list.json<{ orders: Array<Record<string, unknown>> }>();
      assert.deepEqual(
        body.orders.map((o) => o.publicToken),
        ['zz-account-paid'],
      );
      assert.equal('customerEmail' in body.orders[0]!, false);
      assert.equal('internalNotes' in body.orders[0]!, false);
    });

    it('answers ok for unknown addresses and bots alike', async () => {
      for (const payload of [
        { email: 'zz-nobody@example.invalid' },
        { email: EMAIL, website: 'http://spam.example' },
      ]) {
        const res = await app.inject({
          method: 'POST',
          url: '/storefront/account/login-link',
          headers,
          payload,
        });
        assert.equal(res.statusCode, 200);
        assert.deepEqual(res.json(), { ok: true });
      }
    });
  },
);
