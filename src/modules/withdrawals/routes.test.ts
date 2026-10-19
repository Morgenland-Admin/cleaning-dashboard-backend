import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';
import { and, eq, inArray, sql } from 'drizzle-orm';
import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { emailLog } from '../../db/schema/shared.js';
import { createTenantSchemaSql, getTenantTables } from '../../db/schema/tenant.js';

const SLUG = 'cleanilo';
const EMAIL = 'zz-withdrawal-test@example.invalid';

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
  'storefront withdrawals (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;
    const T = getTenantTables(SLUG);
    const headers = { 'x-company-slug': SLUG };
    const orderIds: number[] = [];

    before(async () => {
      await db.execute(sql.raw(createTenantSchemaSql(SLUG)));
      const rows = await db
        .insert(T.orders)
        .values({
          publicToken: 'zz-withdrawal-order',
          orderNumber: 'ZZ/WIDERRUF1',
          kind: 'teppichreinigung',
          status: 'paid',
          subtotalCents: 1000,
          totalCents: 1000,
          pickupMode: 'drop_off',
          customerName: 'zz withdrawal',
          customerEmail: EMAIL,
        } as typeof T.orders.$inferInsert)
        .returning({ id: T.orders.id });
      orderIds.push(...rows.map((r) => r.id));
      app = await buildApp({ logger: false });
      await app.ready();
    });

    after(async () => {
      await app?.close();
      const msgs = await db
        .select({ id: T.contactMessages.id })
        .from(T.contactMessages)
        .where(eq(T.contactMessages.email, EMAIL));
      const ids = msgs.map((m) => m.id);
      if (ids.length) {
        await db
          .delete(emailLog)
          .where(
            and(
              eq(emailLog.companySlug, SLUG),
              eq(emailLog.refType, 'contact'),
              inArray(emailLog.refId, ids),
            ),
          );
        await db.delete(T.contactMessages).where(inArray(T.contactMessages.id, ids));
      }
      if (orderIds.length) await db.delete(T.orders).where(inArray(T.orders.id, orderIds));
      await db.delete(T.customers).where(eq(T.customers.email, EMAIL));
      await pool.end();
    });

    it('stores the declaration, links the order and logs a receipt mail', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/storefront/withdrawals',
        headers,
        payload: {
          name: 'Zz Widerruf',
          email: EMAIL.toUpperCase(),
          orderNumber: 'ZZ/WIDERRUF1',
          orderDate: '2026-11-01',
          message: 'Ich widerrufe.',
        },
      });
      assert.equal(res.statusCode, 201);
      const body = res.json<{ ok: boolean; receivedAt: string; reference: string }>();
      assert.equal(body.ok, true);
      assert.match(body.reference, /^W-\d+$/);
      assert.ok(!Number.isNaN(Date.parse(body.receivedAt)));

      const id = Number(body.reference.slice(2));
      const [row] = await db.select().from(T.contactMessages).where(eq(T.contactMessages.id, id));
      assert.equal(row?.source, 'widerruf');
      assert.equal(row?.subject, 'Widerruf ZZ/WIDERRUF1');
      assert.ok(row?.message.includes('Datum der Bestellung: 01.11.2026'));
      const meta = row?.metadata as { withdrawal?: { orderId?: number } };
      assert.equal(meta.withdrawal?.orderId, orderIds[0]);

      const logs = await db
        .select({ kind: emailLog.kind })
        .from(emailLog)
        .where(and(eq(emailLog.refType, 'contact'), eq(emailLog.refId, id)));
      assert.ok(logs.some((l) => l.kind === 'withdrawal_receipt'));
    });

    it('answers ok and stores nothing for bots', async () => {
      const before = await db
        .select({ id: T.contactMessages.id })
        .from(T.contactMessages)
        .where(eq(T.contactMessages.email, EMAIL));
      const res = await app.inject({
        method: 'POST',
        url: '/storefront/withdrawals',
        headers,
        payload: { name: 'Bot', email: EMAIL, website: 'http://spam.example' },
      });
      assert.equal(res.statusCode, 200);
      assert.deepEqual(res.json(), { ok: true });
      const afterRows = await db
        .select({ id: T.contactMessages.id })
        .from(T.contactMessages)
        .where(eq(T.contactMessages.email, EMAIL));
      assert.equal(afterRows.length, before.length);
    });

    it('rejects a missing name', async () => {
      const res = await app.inject({
        method: 'POST',
        url: '/storefront/withdrawals',
        headers,
        payload: { name: '', email: EMAIL },
      });
      assert.equal(res.statusCode, 400);
    });
  },
);
