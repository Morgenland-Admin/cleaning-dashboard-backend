/** Order edits re-split the partner commission with the assignment's rate chain (partner › catalog › 12 %). */
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { and, eq, inArray } from 'drizzle-orm';

import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { company, membership, user } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';

const SLUG = 'cleanilo';
const MANAGER = 'test-commission-patch-manager';
const PARTNER_USER = 'test-commission-patch-partner';
// Test-only kind so the catalog lookup can only hit this fixture.
const KIND = 'test_commission_patch';

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
  'commission on order edits (HTTP)',
  { skip: ready ? false : 'needs a migrated DB with the cleanilo brand' },
  () => {
    let app: App;
    let partnerId: number;
    let catalogId: number;
    const orderIds: number[] = [];
    const tables = getTenantTables(SLUG);

    before(async () => {
      await db
        .insert(user)
        .values({
          id: MANAGER,
          name: 'commission test manager',
          email: `${MANAGER}@example.invalid`,
          emailVerified: true,
          audience: 'admin',
          accessLevel: 'manager',
          isActive: true,
        })
        .onConflictDoNothing();
      await db
        .insert(membership)
        .values({ userId: MANAGER, companySlug: SLUG, role: 'admin', acceptedAt: new Date() })
        .onConflictDoNothing();
      await db.delete(tables.partners).where(eq(tables.partners.userId, PARTNER_USER));
      const [p] = await db
        .insert(tables.partners)
        .values({ userId: PARTNER_USER, companyName: 'Commission Test GmbH', status: 'active' })
        .returning({ id: tables.partners.id });
      partnerId = p!.id;
      await db.delete(tables.serviceCatalog).where(eq(tables.serviceCatalog.orderKind, KIND));
      const [svc] = await db
        .insert(tables.serviceCatalog)
        .values({
          slug: 'test-commission-patch',
          name: 'Commission test service',
          pricingMode: 'fixed',
          orderKind: KIND,
          commissionRate: '15.00',
        })
        .returning({ id: tables.serviceCatalog.id });
      catalogId = svc!.id;

      app = await buildApp({ logger: false });
      await app.ready();
      const identity = { id: MANAGER, accessLevel: 'manager', audience: 'admin' };
      (app as unknown as { getSession: unknown }).getSession = (request: {
        headers: Record<string, unknown>;
        authUser: unknown;
        authSession: unknown;
      }) => {
        if (request.headers['x-test-user'] !== 'manager') return Promise.resolve(null);
        const session = { user: identity, session: { userId: identity.id } };
        request.authSession = session;
        request.authUser = identity;
        return Promise.resolve(session);
      };
    });

    after(async () => {
      await app?.close();
      if (orderIds.length) {
        await db.delete(tables.orderItems).where(inArray(tables.orderItems.orderId, orderIds));
        await db.delete(tables.orders).where(inArray(tables.orders.id, orderIds));
      }
      if (catalogId) {
        await db.delete(tables.serviceCatalog).where(eq(tables.serviceCatalog.id, catalogId));
      }
      await db.delete(tables.partners).where(eq(tables.partners.userId, PARTNER_USER));
      await db
        .delete(membership)
        .where(and(eq(membership.userId, MANAGER), eq(membership.companySlug, SLUG)));
      await db.delete(user).where(eq(user.id, MANAGER));
      await pool.end();
    });

    /** A 100 € order assigned at the catalog's 15 %. */
    async function seedOrder(): Promise<number> {
      const [o] = await db
        .insert(tables.orders)
        .values({
          publicToken: `test-commission-${randomUUID()}`,
          kind: KIND,
          status: 'accepted',
          subtotalCents: 10_000,
          totalCents: 10_000,
          pickupMode: 'pickup',
          customerName: 'Commission Test',
          customerEmail: 'commission-test@example.invalid',
          assignedPartnerId: partnerId,
          assignedAt: new Date(),
          commissionCents: 1_500,
          partnerPayoutCents: 8_500,
          payoutStatus: 'pending',
        })
        .returning({ id: tables.orders.id });
      orderIds.push(o!.id);
      return o!.id;
    }

    const post = (url: string, payload: unknown) =>
      app.inject({
        method: 'POST',
        url,
        headers: {
          'x-test-user': 'manager',
          'x-company-slug': SLUG,
          'content-type': 'application/json',
        },
        payload: payload as Record<string, unknown>,
      });

    type Split = { commissionCents: number; partnerPayoutCents: number; totalCents: number };
    const splitOf = (res: { json: <T>() => T }) => res.json<{ order: Split }>().order;

    const line = { code: 'test.line', label: 'Testposition', quantityLabel: '1 Stk', quantity: 1 };

    it('adjust keeps the catalog rate when the partner has no override', async () => {
      const id = await seedOrder();
      const res = await post(`/admin/orders/${id}/adjust`, {
        items: [{ ...line, unitPriceCents: 20_000 }],
      });
      assert.equal(res.statusCode, 200, res.body);
      const order = splitOf(res);
      assert.equal(order.totalCents, 20_000);
      assert.equal(order.commissionCents, 3_000, 'commission fell back to the platform default');
      assert.equal(order.partnerPayoutCents, 17_000);
    });

    it('upsell keeps the catalog rate when the partner has no override', async () => {
      const id = await seedOrder();
      const res = await post(`/admin/orders/${id}/upsell`, { ...line, unitPriceCents: 10_000 });
      assert.equal(res.statusCode, 200, res.body);
      const order = splitOf(res);
      assert.equal(order.totalCents, 20_000);
      assert.equal(order.commissionCents, 3_000, 'commission fell back to the platform default');
    });

    it('a partner override still beats the catalog rate', async () => {
      await db
        .update(tables.partners)
        .set({ commissionRate: '10.00' })
        .where(eq(tables.partners.id, partnerId));
      try {
        const id = await seedOrder();
        const res = await post(`/admin/orders/${id}/adjust`, {
          items: [{ ...line, unitPriceCents: 20_000 }],
        });
        assert.equal(res.statusCode, 200, res.body);
        assert.equal(splitOf(res).commissionCents, 2_000);
      } finally {
        await db
          .update(tables.partners)
          .set({ commissionRate: null })
          .where(eq(tables.partners.id, partnerId));
      }
    });
  },
);
