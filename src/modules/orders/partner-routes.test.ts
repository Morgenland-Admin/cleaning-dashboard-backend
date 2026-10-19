/** Partner order routes over HTTP: allowlisted view, list scopes, next step, earnings totals. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { and, eq, inArray } from 'drizzle-orm';

import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { company, emailLog, membership, user } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';
import { NONCONTACTABLE_EMAIL_DOMAIN } from '../../email/service.js';
import { generateOrderToken } from './lib.js';

const SLUG = 'cleanilo';
const PARTNER_USER = 'test-partner-orders-user';

type Json = Record<string, unknown>;
interface OrderList {
  orders: Array<Json & { id: number }>;
}
interface Detail {
  order: Json & { status: string };
  allowedNextStatuses: string[];
  statusLog: Array<Json & { toStatus: string }>;
}
interface Earnings {
  totals: Record<string, number>;
  orders: Json[];
  hasMore: boolean;
}

async function cleaniloReady(): Promise<boolean> {
  try {
    const [row] = await db
      .select({ slug: company.slug })
      .from(company)
      .where(eq(company.slug, SLUG))
      .limit(1);
    return !!row;
  } catch {
    return false;
  }
}

const ready = await cleaniloReady();

describe(
  'partner order routes (HTTP)',
  { skip: ready ? false : 'needs a migrated DB with the cleanilo brand' },
  () => {
    let app: App;
    let partnerId: number;
    const ids: Record<'paid' | 'refunded' | 'delivered' | 'cancelled', number> = {
      paid: 0,
      refunded: 0,
      delivered: 0,
      cancelled: 0,
    };
    const tables = getTenantTables(SLUG);

    // Placeholder customer address: sendEmail blocks it, so status changes never mail anyone.
    const baseOrder = () => ({
      publicToken: generateOrderToken(),
      kind: 'teppichreinigung',
      subtotalCents: 10_000,
      totalCents: 10_000,
      pickupMode: 'pickup',
      customerName: 'Erika Muster',
      customerEmail: `partner-test@${NONCONTACTABLE_EMAIL_DOMAIN}`,
      customerPhone: '+49 40 123',
      assignedPartnerId: partnerId,
      assignedAt: new Date(),
      commissionCents: 1_200,
      partnerPayoutCents: 8_800,
      payoutStatus: 'pending',
    });

    before(async () => {
      await db
        .insert(user)
        .values({
          id: PARTNER_USER,
          name: 'orders test partner',
          email: `${PARTNER_USER}@example.invalid`,
          emailVerified: true,
          audience: 'partner',
          accessLevel: 'none',
          isActive: true,
        })
        .onConflictDoNothing();
      await db
        .insert(membership)
        .values({
          userId: PARTNER_USER,
          companySlug: SLUG,
          role: 'partner',
          acceptedAt: new Date(),
        })
        .onConflictDoNothing();
      const [p] = await db
        .insert(tables.partners)
        .values({ userId: PARTNER_USER, companyName: 'Orders Test GmbH', status: 'active' })
        .returning({ id: tables.partners.id });
      partnerId = p!.id;

      const at = new Date();
      const rows = await db
        .insert(tables.orders)
        .values([
          {
            ...baseOrder(),
            status: 'paid',
            internalNotes: 'staff only',
            voucherCode: 'SECRET10',
            paypalOrderId: 'PP-1',
            metadata: {
              preferredSlots: ['2026-11-03T09:00', 42],
              confirmedSlot: '2026-11-03T09:00',
              bids: [{ partner: 'Konkurrenz', price: 99 }],
              meta: { fbp: 'fb.1.2' },
            },
          },
          { ...baseOrder(), status: 'partially_refunded', acceptedAt: at, inCleaningAt: at },
          { ...baseOrder(), status: 'delivered', deliveredAt: at },
          { ...baseOrder(), status: 'cancelled', cancelledAt: at },
        ])
        .returning({ id: tables.orders.id, status: tables.orders.status });
      for (const r of rows) {
        const key = r.status === 'partially_refunded' ? 'refunded' : (r.status as keyof typeof ids);
        ids[key] = r.id;
      }

      app = await buildApp({ logger: false });
      await app.ready();
      const identity = {
        id: PARTNER_USER,
        audience: 'partner',
        accessLevel: 'none',
        isActive: true,
      };
      (app as unknown as { getSession: unknown }).getSession = (request: {
        headers: Record<string, unknown>;
        authUser: unknown;
        authSession: unknown;
      }) => {
        if (request.headers['x-test-user'] !== 'partner') return Promise.resolve(null);
        const session = { user: identity, session: { userId: identity.id } };
        request.authSession = session;
        request.authUser = identity;
        return Promise.resolve(session);
      };
    });

    after(async () => {
      await app?.close();
      const own = await db
        .select({ id: tables.orders.id })
        .from(tables.orders)
        .where(eq(tables.orders.assignedPartnerId, partnerId));
      const orderIds = own.map((o) => o.id);
      if (orderIds.length) {
        await db
          .delete(emailLog)
          .where(
            and(
              eq(emailLog.companySlug, SLUG),
              eq(emailLog.refType, 'order'),
              inArray(emailLog.refId, orderIds),
            ),
          );
        await db
          .delete(tables.orderStatusLog)
          .where(inArray(tables.orderStatusLog.orderId, orderIds));
        await db.delete(tables.orders).where(inArray(tables.orders.id, orderIds));
      }
      await db.delete(tables.partners).where(eq(tables.partners.userId, PARTNER_USER));
      await db
        .delete(membership)
        .where(and(eq(membership.userId, PARTNER_USER), eq(membership.companySlug, SLUG)));
      await db.delete(user).where(eq(user.id, PARTNER_USER));
      await pool.end();
    });

    const call = (method: 'GET' | 'POST', url: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        payload: payload as Record<string, unknown> | undefined,
        headers: { 'x-test-user': 'partner', 'x-company-slug': SLUG },
      });

    it('detail is an allowlist: no token, email, payment ids or internal metadata', async () => {
      const res = await call('GET', `/partner/orders/${ids.paid}`);
      assert.equal(res.statusCode, 200);
      const body = res.json<Detail>();
      for (const key of [
        'publicToken',
        'customerEmail',
        'internalNotes',
        'voucherCode',
        'paypalOrderId',
        'metadata',
        'partnerPhotos',
      ]) {
        assert.equal(key in body.order, false, key);
      }
      assert.deepEqual(body.order.preferredSlots, ['2026-11-03T09:00']);
      assert.equal(body.order.confirmedSlot, '2026-11-03T09:00');
      assert.equal(body.order.customerName, 'Erika Muster');
      assert.deepEqual(body.allowedNextStatuses, []);
    });

    it('the list splits active and done jobs on the server', async () => {
      const active = (await call('GET', '/partner/orders?scope=active')).json<OrderList>();
      const done = (await call('GET', '/partner/orders?scope=done')).json<OrderList>();
      const activeIds = active.orders.map((o) => o.id);
      const doneIds = done.orders.map((o) => o.id);
      assert.deepEqual(activeIds.sort(), [ids.paid, ids.refunded].sort());
      assert.deepEqual(doneIds.sort(), [ids.delivered, ids.cancelled].sort());
      assert.equal('publicToken' in active.orders[0]!, false);
    });

    it('a partially refunded job cannot jump back to an earlier step', async () => {
      const detail = (await call('GET', `/partner/orders/${ids.refunded}`)).json<Detail>();
      assert.deepEqual(detail.allowedNextStatuses, ['ready']);
      const res = await call('POST', `/partner/orders/${ids.refunded}/transition`, {
        toStatus: 'picked_up',
      });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json<Json>().code, 'TRANSITION_NOT_ALLOWED');
    });

    it('a paid job waits for the team: the partner cannot confirm it', async () => {
      const res = await call('POST', `/partner/orders/${ids.paid}/transition`, {
        toStatus: 'accepted',
      });
      assert.equal(res.statusCode, 409);
      assert.equal(res.json<Json>().code, 'TRANSITION_NOT_ALLOWED');
      const detail = (await call('GET', `/partner/orders/${ids.paid}`)).json<Detail>();
      assert.deepEqual(detail.allowedNextStatuses, []);
      assert.equal('publicToken' in detail.order, false);
    });

    it('once the team confirms, the partner moves on and the log hides who acted', async () => {
      await db
        .update(tables.orders)
        .set({ status: 'accepted', acceptedAt: new Date() })
        .where(eq(tables.orders.id, ids.paid));
      const res = await call('POST', `/partner/orders/${ids.paid}/transition`, {
        toStatus: 'picked_up',
      });
      assert.equal(res.statusCode, 200);
      const detail = (await call('GET', `/partner/orders/${ids.paid}`)).json<Detail>();
      assert.equal(detail.statusLog[0]!.toStatus, 'picked_up');
      assert.equal('changedByUserId' in detail.statusLog[0]!, false);
    });

    it('done jobs offer no step', async () => {
      const res = await call('POST', `/partner/orders/${ids.cancelled}/transition`, {
        toStatus: 'picked_up',
      });
      assert.equal(res.statusCode, 409);
    });

    it('earnings totals cover every order in range and use Berlin days', async () => {
      const base = baseOrder();
      const many = Array.from({ length: 501 }, (_, i) => ({
        ...baseOrder(),
        status: 'completed',
        assignedAt: new Date(Date.UTC(2020, 2, 10, 12, 0, i % 60)),
        payoutStatus: i < 100 ? 'paid' : 'pending',
      }));
      await db.insert(tables.orders).values([
        ...many,
        // 1 March 00:30 in Berlin, still 29 February in UTC.
        { ...base, status: 'completed', assignedAt: new Date('2020-02-29T23:30:00Z') },
        // 1 April 00:30 in Berlin (summer time), still 31 March in UTC.
        {
          ...baseOrder(),
          status: 'completed',
          assignedAt: new Date('2020-03-31T22:30:00Z'),
        },
        { ...baseOrder(), status: 'cancelled', assignedAt: new Date('2020-03-15T12:00:00Z') },
      ]);

      const res = await call('GET', '/partner/orders/earnings?from=2020-03-01&to=2020-03-31');
      assert.equal(res.statusCode, 200);
      const body = res.json<Earnings>();
      // 501 + the 1 March job; the cancelled one is listed but not counted.
      assert.equal(body.totals.orders, 502);
      assert.equal(body.totals.grossCents, 502 * 10_000);
      assert.equal(body.totals.commissionCents, 502 * 1_200);
      assert.equal(body.totals.payoutCents, 502 * 8_800);
      assert.equal(body.totals.paidOutCents, 100 * 8_800);
      assert.equal(body.totals.openPayoutCents, 402 * 8_800);
      assert.equal(body.orders.length, 500);
      assert.equal(body.hasMore, true);
    });
  },
);
