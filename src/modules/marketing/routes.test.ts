import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { ensureTenantSchemaForTests } from '../../db/test-tenant-schema.js';
import { eq } from 'drizzle-orm';
import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { getTenantTables } from '../../db/schema/tenant.js';
import {
  marketingUnsubscribeUrl,
  signMarketingOptOutToken,
  verifyMarketingOptOutToken,
  verifyUnsubscribeToken,
} from '../../lib/token.js';

const SLUG = 'cleanilo';

describe('marketing opt-out token', () => {
  it('round-trips and rejects tampering or newsletter reuse', () => {
    const token = signMarketingOptOutToken(42, SLUG);
    assert.deepEqual(verifyMarketingOptOutToken(token), { customerId: 42, slug: SLUG });
    const [payload, sig] = token.split('.');
    const forged = Buffer.from(JSON.stringify({ c: 43, s: SLUG })).toString('base64url');
    assert.equal(verifyMarketingOptOutToken(`${forged}.${sig}`), null);
    assert.equal(verifyMarketingOptOutToken(`${payload}.${sig}x`), null);
    assert.equal(verifyUnsubscribeToken(token), null);
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
  'marketing unsubscribe (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;
    const T = getTenantTables(SLUG);
    let customerId = 0;

    before(async () => {
      await ensureTenantSchemaForTests(SLUG);
      const [row] = await db
        .insert(T.customers)
        .values({
          email: `zz-marketing-optout-${Date.now()}@example.invalid`,
          marketingOptIn: true,
        })
        .returning({ id: T.customers.id });
      customerId = row!.id;
      app = await buildApp({ logger: false });
      await app.ready();
    });

    after(async () => {
      await app?.close();
      if (customerId) await db.delete(T.customers).where(eq(T.customers.id, customerId));
      await pool.end();
    });

    const pathOf = (channel: 'email' | 'sms') => {
      const u = new URL(marketingUnsubscribeUrl(SLUG, customerId, channel));
      return `${u.pathname}${u.search}`;
    };

    it('GET only shows the confirmation page', async () => {
      const res = await app.inject({ method: 'GET', url: pathOf('email') });
      assert.equal(res.statusCode, 200);
      assert.match(res.body, /Werbe-E-Mails/);
      const [row] = await db.select().from(T.customers).where(eq(T.customers.id, customerId));
      assert.equal(row!.emailMarketingOptOutAt, null);
    });

    it('POST sets only the chosen channel', async () => {
      const res = await app.inject({
        method: 'POST',
        url: pathOf('sms'),
        headers: { 'content-type': 'application/x-www-form-urlencoded' },
        payload: 'List-Unsubscribe=One-Click',
      });
      assert.equal(res.statusCode, 200);
      let [row] = await db.select().from(T.customers).where(eq(T.customers.id, customerId));
      assert.ok(row!.smsMarketingOptOutAt);
      assert.equal(row!.emailMarketingOptOutAt, null);
      assert.equal(row!.marketingOptIn, true);

      await app.inject({ method: 'POST', url: pathOf('email') });
      [row] = await db.select().from(T.customers).where(eq(T.customers.id, customerId));
      assert.ok(row!.emailMarketingOptOutAt);
      assert.equal(row!.marketingOptIn, false);
    });

    it('rejects a bad token', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/storefront/marketing/unsubscribe?t=abcdefgh.ijkl&channel=email',
      });
      assert.equal(res.statusCode, 400);
    });
  },
);
