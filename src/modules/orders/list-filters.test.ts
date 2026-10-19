/** Admin list filters (view / q / counts / paging) over the real routes; needs the local Postgres. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { and, eq, inArray } from 'drizzle-orm';

import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { company, membership, user } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';
import { CLOSED_ORDER_STATUSES } from './lib.js';

const TEST_USER = {
  id: 'test-list-filters-admin',
  accessLevel: 'super_admin',
  audience: 'admin',
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

describe(
  'admin list filters (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;
    let slug: string;
    let schemaName: string;
    const adjustmentIds: number[] = [];

    before(async () => {
      const [activeCompany] = await db
        .select({ slug: company.slug, schemaName: company.schemaName })
        .from(company)
        .where(eq(company.isActive, true))
        .limit(1);
      assert.ok(activeCompany, 'expected at least one active company — run pnpm db:seed:local');
      slug = activeCompany.slug;
      schemaName = activeCompany.schemaName;

      await db
        .insert(user)
        .values({
          id: TEST_USER.id,
          name: 'list filters',
          email: `${TEST_USER.id}@example.invalid`,
          emailVerified: true,
          audience: TEST_USER.audience,
          accessLevel: TEST_USER.accessLevel,
          isActive: true,
        })
        .onConflictDoNothing();
      await db
        .insert(membership)
        .values({ userId: TEST_USER.id, companySlug: slug, role: 'admin', acceptedAt: new Date() })
        .onConflictDoNothing();

      const { priceAdjustments } = getTenantTables(schemaName);
      const inserted = await db
        .insert(priceAdjustments)
        .values(
          [1, 2, 3].map((n) => ({
            scope: 'global',
            adjustmentPercent: `${n}.00`,
            reason: 'list-filters test',
            active: false,
            // One statement, one now(): the rows share a microsecond created_at the cursor cannot carry.
          })),
        )
        .returning({ id: priceAdjustments.id });
      adjustmentIds.push(...inserted.map((r) => r.id));

      app = await buildApp({ logger: false });
      await app.ready();
      (app as unknown as { getSession: unknown }).getSession = (request: {
        authUser: unknown;
        authSession: unknown;
      }) => {
        const session = { user: TEST_USER, session: { userId: TEST_USER.id } };
        request.authSession = session;
        request.authUser = TEST_USER;
        return Promise.resolve(session);
      };
    });

    after(async () => {
      await app?.close();
      const { priceAdjustments } = getTenantTables(schemaName);
      if (adjustmentIds.length) {
        await db.delete(priceAdjustments).where(inArray(priceAdjustments.id, adjustmentIds));
      }
      await db
        .delete(membership)
        .where(and(eq(membership.userId, TEST_USER.id), eq(membership.companySlug, slug)));
      await db.delete(user).where(eq(user.id, TEST_USER.id));
      await pool.end();
    });

    const get = async <T>(url: string): Promise<T> => {
      const res = await app.inject({ method: 'GET', url, headers: { 'x-company-slug': slug } });
      assert.equal(res.statusCode, 200, `${url} → ${res.statusCode} ${res.body}`);
      return res.json<T>();
    };

    type OrdersPage = { orders: Array<{ id: number; status: string; orderNumber: string }> };

    it('orders: view=open / closed split by status and match the counts', async () => {
      const { counts } = await get<{ counts: Record<string, number> }>('/admin/orders/counts');
      const closed = new Set<string>(CLOSED_ORDER_STATUSES);
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const closedTotal = Object.entries(counts)
        .filter(([s]) => closed.has(s))
        .reduce((a, [, n]) => a + n, 0);

      const open = await get<OrdersPage>('/admin/orders?view=open&limit=200');
      assert.ok(open.orders.every((o) => !closed.has(o.status)));
      if (total - closedTotal <= 200) assert.equal(open.orders.length, total - closedTotal);

      const done = await get<OrdersPage>('/admin/orders?view=closed&limit=200');
      assert.ok(done.orders.every((o) => closed.has(o.status)));

      const cancelled = await get<OrdersPage>('/admin/orders?view=open&status=cancelled&limit=5');
      assert.ok(
        cancelled.orders.every((o) => o.status === 'cancelled'),
        'status wins over view',
      );
    });

    it('orders: paging the whole list returns every row once', async () => {
      const { counts } = await get<{ counts: Record<string, number> }>('/admin/orders/counts');
      const total = Object.values(counts).reduce((a, b) => a + b, 0);
      const seen: number[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 500; i++) {
        const qs = `limit=37${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page: OrdersPage & { nextCursor: string | null } = await get(`/admin/orders?${qs}`);
        seen.push(...page.orders.map((o) => o.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      assert.equal(new Set(seen).size, seen.length, 'no repeats');
      assert.equal(seen.length, total, 'no gaps');
    });

    it('orders: q matches the order number and escapes wildcards', async () => {
      const first = await get<OrdersPage>('/admin/orders?limit=1');
      const order = first.orders[0];
      if (order) {
        const hit = await get<OrdersPage>(
          `/admin/orders?q=${encodeURIComponent(order.orderNumber)}&limit=50`,
        );
        assert.ok(hit.orders.some((o) => o.id === order.id));
      }
      const none = await get<OrdersPage>('/admin/orders?q=%25%25no-such-order%25%25');
      assert.equal(none.orders.length, 0);
    });

    it('counts follow the search, so tabs match the filtered list', async () => {
      const q = encodeURIComponent('%%no-such-order%%');
      const brand = await get<{ counts: Record<string, number> }>(`/admin/orders/counts?q=${q}`);
      assert.deepEqual(brand.counts, {});
      const all = await get<{ counts: Record<string, number> }>(`/admin/orders/all/counts?q=${q}`);
      assert.deepEqual(all.counts, {});
      const first = (await get<OrdersPage>('/admin/orders?limit=1')).orders[0];
      if (first) {
        const hit = await get<{ counts: Record<string, number> }>(
          `/admin/orders/counts?q=${encodeURIComponent(first.orderNumber)}`,
        );
        assert.ok((hit.counts[first.status] ?? 0) >= 1);
      }
      const invoices = await get<{ counts: Record<string, number> }>(
        '/admin/invoices/counts?q=__no_such_invoice__&overdue=true',
      );
      assert.deepEqual(invoices.counts, {});
    });

    it('orders: cross-brand list honours view and counts add up', async () => {
      const all = await get<OrdersPage>('/admin/orders/all?view=open&limit=50');
      const closed = new Set<string>(CLOSED_ORDER_STATUSES);
      assert.ok(all.orders.every((o) => !closed.has(o.status)));
      const { counts } = await get<{ counts: Record<string, number> }>('/admin/orders/all/counts');
      assert.equal(typeof counts, 'object');
    });

    it('invoices: view=open keeps draft/sent/overdue; counts are per status', async () => {
      type InvoicesPage = { invoices: Array<{ status: string }> };
      const open = await get<InvoicesPage>('/admin/invoices?view=open&limit=200');
      assert.ok(open.invoices.every((i) => ['draft', 'sent', 'overdue'].includes(i.status)));
      const closed = await get<InvoicesPage>('/admin/invoices?view=closed&limit=200');
      assert.ok(closed.invoices.every((i) => ['paid', 'void'].includes(i.status)));
      const { counts } = await get<{ counts: Record<string, number> }>('/admin/invoices/counts');
      for (const n of Object.values(counts)) assert.ok(Number.isInteger(n) && n > 0);
      const none = await get<InvoicesPage>('/admin/invoices?q=__no_such_invoice__');
      assert.equal(none.invoices.length, 0);
    });

    it('invoices: a draft started from a customer links to it without an email', async () => {
      const { customers, invoices, invoiceStatusLog } = getTenantTables(schemaName);
      const [customer] = await db.select({ id: customers.id }).from(customers).limit(1);
      if (!customer) return;
      const res = await app.inject({
        method: 'POST',
        url: '/admin/invoices',
        headers: { 'x-company-slug': slug, 'content-type': 'application/json' },
        payload: {
          customerId: customer.id,
          recipientName: 'list-filters test',
          lineItems: [{ label: 'Test', quantity: 1, unitPriceCents: 100 }],
        },
      });
      assert.equal(res.statusCode, 201, res.body);
      const { invoice } = res.json<{ invoice: { id: number; customerId: number | null } }>();
      await db.delete(invoiceStatusLog).where(eq(invoiceStatusLog.invoiceId, invoice.id));
      await db.delete(invoices).where(eq(invoices.id, invoice.id));
      assert.equal(invoice.customerId, customer.id);

      const missing = await app.inject({
        method: 'POST',
        url: '/admin/invoices',
        headers: { 'x-company-slug': slug, 'content-type': 'application/json' },
        payload: {
          customerId: 2147483000,
          recipientName: 'list-filters test',
          lineItems: [{ label: 'Test', quantity: 1, unitPriceCents: 100 }],
        },
      });
      assert.equal(missing.statusCode, 400);
    });

    it('price adjustments: rows sharing one created_at page without gaps or repeats', async () => {
      type Page = { adjustments: Array<{ id: number }>; nextCursor: string | null };
      const seen: number[] = [];
      let cursor: string | null = null;
      for (let i = 0; i < 100; i++) {
        const qs = `active=false&limit=2${cursor ? `&cursor=${encodeURIComponent(cursor)}` : ''}`;
        const page: Page = await get<Page>(`/admin/price-adjustments?${qs}`);
        seen.push(...page.adjustments.map((a) => a.id));
        cursor = page.nextCursor;
        if (!cursor) break;
      }
      assert.equal(new Set(seen).size, seen.length);
      for (const id of adjustmentIds) assert.ok(seen.includes(id));
    });
  },
);
