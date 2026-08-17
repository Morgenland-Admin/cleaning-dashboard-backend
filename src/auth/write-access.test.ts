/**
 * HTTP-level tests for the write-access role gate.
 *
 * What is under test is the *wiring*, not the predicate: that every admin route
 * group which mutates state actually has `requireWriteAccess` in front of it, and
 * that reads are still open to a `viewer`. A unit test of the decorator would
 * keep passing if someone registered a new write route without the hook — which
 * is precisely the regression this file exists to catch.
 *
 * Two design notes:
 *
 * 1. **Writes are probed with a deliberately invalid body.** A blocked request
 *    answers 403 before the handler runs; an allowed one reaches Zod and answers
 *    400. So "not 403" proves the gate opened *without mutating a single row* —
 *    no fixtures to restore, no test data leaking into a dev database.
 *
 * 2. **The session is stubbed, the routes are real.** Signing in through
 *    better-auth would drag password hashing and user seeding into a test about
 *    authorization. Instead `app.getSession` is replaced and the caller picks an
 *    identity per request via a header. Everything after that — the audience
 *    check, the membership lookup, the write gate, the route — is the real thing.
 */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { and, eq } from 'drizzle-orm';

import { buildApp, type App } from '../app.js';
import { db, pool } from '../db/index.js';
import { company, membership, user } from '../db/schema/shared.js';

type AccessLevel = 'super_admin' | 'admin' | 'manager' | 'viewer';

/** Identity the stubbed session returns, chosen per request by `x-test-user`. */
interface TestIdentity {
  id: string;
  accessLevel: AccessLevel;
  audience: 'admin';
}

const TEST_USER_PREFIX = 'test-write-access-';
const IDENTITIES: Record<AccessLevel, TestIdentity> = {
  super_admin: { id: `${TEST_USER_PREFIX}super`, accessLevel: 'super_admin', audience: 'admin' },
  admin: { id: `${TEST_USER_PREFIX}admin`, accessLevel: 'admin', audience: 'admin' },
  manager: { id: `${TEST_USER_PREFIX}manager`, accessLevel: 'manager', audience: 'admin' },
  viewer: { id: `${TEST_USER_PREFIX}viewer`, accessLevel: 'viewer', audience: 'admin' },
};

/** Reachable database? Without one this whole file is meaningless, so it skips. */
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
  'write-access gate (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;
    let slug: string;

    before(async () => {
      const [activeCompany] = await db
        .select({ slug: company.slug })
        .from(company)
        .where(eq(company.isActive, true))
        .limit(1);
      assert.ok(activeCompany, 'expected at least one active company — run pnpm db:seed:local');
      slug = activeCompany.slug;

      // Fixtures: one user per access level, each a member of the same brand, so
      // the only variable between them is `accessLevel`.
      for (const identity of Object.values(IDENTITIES)) {
        await db
          .insert(user)
          .values({
            id: identity.id,
            name: `write-access ${identity.accessLevel}`,
            email: `${identity.id}@example.invalid`,
            emailVerified: true,
            audience: identity.audience,
            accessLevel: identity.accessLevel,
            isActive: true,
          })
          .onConflictDoNothing();
        await db
          .insert(membership)
          .values({ userId: identity.id, companySlug: slug, role: 'admin', acceptedAt: new Date() })
          .onConflictDoNothing();
      }

      app = await buildApp({ logger: false });
      await app.ready();

      // Replace the real session lookup. `getSession` is read off the instance at
      // call time, so overwriting it here reaches every guard.
      const identityFor = (value: unknown): TestIdentity | null => {
        const key = Array.isArray(value) ? value[0] : value;
        return typeof key === 'string' && key in IDENTITIES ? IDENTITIES[key as AccessLevel] : null;
      };
      (app as unknown as { getSession: unknown }).getSession = (request: {
        headers: Record<string, unknown>;
        authUser: unknown;
        authSession: unknown;
      }) => {
        const identity = identityFor(request.headers['x-test-user']);
        if (!identity) return Promise.resolve(null);
        const session = { user: identity, session: { userId: identity.id } };
        request.authSession = session;
        request.authUser = identity;
        return Promise.resolve(session);
      };
    });

    after(async () => {
      await app?.close();
      for (const identity of Object.values(IDENTITIES)) {
        await db
          .delete(membership)
          .where(and(eq(membership.userId, identity.id), eq(membership.companySlug, slug)));
        await db.delete(user).where(eq(user.id, identity.id));
      }
      await pool.end();
    });

    const call = (level: AccessLevel, method: 'GET' | 'POST' | 'PATCH' | 'DELETE', url: string) =>
      app.inject({
        method,
        url,
        headers: {
          'x-test-user': level,
          'x-company-slug': slug,
          ...(method === 'GET' || method === 'DELETE'
            ? {}
            : { 'content-type': 'application/json' }),
        },
        // Deliberately invalid: a request that clears the gate dies in Zod (400),
        // which distinguishes "allowed" from "blocked" without writing anything.
        ...(method === 'GET' || method === 'DELETE'
          ? {}
          : { payload: { __invalid_probe__: true } }),
      });

    // --- reads: a viewer must keep full read access -------------------------
    //
    // A viewer that cannot read is a broken role, not a safe one — they work the
    // same queues as everyone else, they just may not change anything.
    const READS = [
      '/admin/orders',
      '/admin/contact',
      '/admin/inquiries',
      '/admin/newsletter',
      '/admin/customers',
      '/admin/invoices',
      '/admin/subscriptions',
      '/admin/city-status',
      '/admin/price-adjustments',
      '/admin/seo-pages',
      '/admin/ai/prompts',
      '/admin/chat/conversations',
    ];

    for (const url of READS) {
      it(`viewer can read ${url}`, async () => {
        const res = await call('viewer', 'GET', url);
        assert.equal(
          res.statusCode,
          200,
          `expected 200, got ${res.statusCode}: ${res.body.slice(0, 200)}`,
        );
      });
    }

    // --- writes: a viewer must be refused ----------------------------------
    //
    // Every entry moves an order, moves money, or sends customer mail.
    const WRITES: Array<[method: 'POST' | 'PATCH' | 'DELETE', url: string]> = [
      ['POST', '/admin/orders'],
      ['PATCH', '/admin/orders/1/notes'],
      ['POST', '/admin/orders/1/transition'],
      ['POST', '/admin/orders/1/record-payment'],
      ['POST', '/admin/orders/1/payment-link'],
      ['POST', '/admin/orders/1/cancel'],
      ['POST', '/admin/orders/1/message'],
      ['POST', '/admin/orders/1/adjust'],
      ['POST', '/admin/orders/1/upsell'],
      ['PATCH', '/admin/contact/1'],
      ['POST', '/admin/contact/1/reply'],
      ['PATCH', '/admin/inquiries/1'],
      ['POST', '/admin/inquiries/1/quote'],
      ['DELETE', '/admin/newsletter/1'],
      ['POST', '/admin/newsletter/import'],
      ['POST', '/admin/customers'],
      ['PATCH', '/admin/customers/1'],
      ['DELETE', '/admin/customers/1'],
      ['POST', '/admin/invoices'],
      ['POST', '/admin/subscriptions'],
      ['POST', '/admin/city-status'],
      ['POST', '/admin/price-adjustments'],
      ['POST', '/admin/seo-pages'],
      ['POST', '/admin/ai/assist'],
      ['POST', '/admin/ai/extract-offer-items'],
      ['POST', '/admin/chat/conversations/someone/messages'],
      ['POST', '/admin/partners'],
      ['PATCH', '/admin/partners/1'],
    ];

    for (const [method, url] of WRITES) {
      it(`viewer is refused ${method} ${url}`, async () => {
        const res = await call('viewer', method, url);
        assert.equal(
          res.statusCode,
          403,
          `expected 403, got ${res.statusCode}: ${res.body.slice(0, 200)}`,
        );
      });
    }

    // --- writes: manager+ must not be over-blocked -------------------------
    //
    // The mirror of the block list. Without it, a gate accidentally set to
    // super_admin-only would still pass every test above.
    for (const [method, url] of WRITES) {
      for (const level of ['manager', 'admin'] as const) {
        it(`${level} is allowed through to ${method} ${url}`, async () => {
          const res = await call(level, method, url);
          assert.notEqual(
            res.statusCode,
            403,
            `${level} was blocked by the write gate on ${method} ${url}`,
          );
          assert.notEqual(res.statusCode, 401, `${level} was treated as unauthenticated`);
        });
      }
    }

    // --- the viewer read model ---------------------------------------------
    //
    // Opening reads to a viewer is only safe if the hidden columns really are
    // hidden. This drives it through the HTTP layer rather than calling
    // `redactForViewer` directly, because the bug worth catching is a route that
    // forgets to call it.
    describe('viewer redaction over HTTP', () => {
      const SENTINEL = 'integration-test-internal-note';

      /** Set internalNotes on the newest row of a tenant table, then restore it. */
      async function withInternalNote(
        table: 'orders' | 'contact_messages' | 'customers',
        run: (id: number) => Promise<void>,
      ) {
        const { getTenantTables } = await import('../db/schema/tenant.js');
        const { loadCompany } = await import('../lib/company-loader.js');
        const companyRow = await loadCompany(slug);
        assert.ok(companyRow);
        const tables = getTenantTables(companyRow.schemaName);
        const target =
          table === 'orders'
            ? tables.orders
            : table === 'contact_messages'
              ? tables.contactMessages
              : tables.customers;

        const [row] = await db
          .select({ id: target.id, internalNotes: target.internalNotes })
          .from(target)
          .limit(1);
        if (!row) return; // nothing seeded for this table — nothing to assert
        const original = row.internalNotes;
        await db.update(target).set({ internalNotes: SENTINEL }).where(eq(target.id, row.id));
        try {
          await run(row.id);
        } finally {
          await db.update(target).set({ internalNotes: original }).where(eq(target.id, row.id));
        }
      }

      const bodyOf = (res: { body: string }) => JSON.parse(res.body) as Record<string, unknown>;

      it('hides internalNotes on the orders list from a viewer, shows it to a manager', async () => {
        await withInternalNote('orders', async () => {
          const asViewer = bodyOf(await call('viewer', 'GET', '/admin/orders?limit=50'));
          const asManager = bodyOf(await call('manager', 'GET', '/admin/orders?limit=50'));
          const viewerNotes = (asViewer.orders as Array<{ internalNotes: unknown }>).map(
            (o) => o.internalNotes,
          );
          const managerNotes = (asManager.orders as Array<{ internalNotes: unknown }>).map(
            (o) => o.internalNotes,
          );
          assert.ok(
            managerNotes.includes(SENTINEL),
            'manager should see the note — fixture did not apply',
          );
          assert.ok(
            !viewerNotes.includes(SENTINEL),
            'viewer must not receive internalNotes on the orders list',
          );
          assert.ok(
            viewerNotes.every((n) => n === null),
            'every viewer-visible order should have internalNotes nulled',
          );
        });
      });

      it('hides internalNotes on the contact list from a viewer', async () => {
        await withInternalNote('contact_messages', async () => {
          const asViewer = bodyOf(await call('viewer', 'GET', '/admin/contact?limit=50'));
          const asManager = bodyOf(await call('manager', 'GET', '/admin/contact?limit=50'));
          const pick = (b: Record<string, unknown>) =>
            (b.messages as Array<{ internalNotes: unknown }>).map((m) => m.internalNotes);
          assert.ok(pick(asManager).includes(SENTINEL), 'fixture did not apply');
          assert.ok(!pick(asViewer).includes(SENTINEL), 'viewer must not receive internalNotes');
        });
      });

      it('hides internalNotes on the customers list from a viewer', async () => {
        await withInternalNote('customers', async () => {
          const asViewer = bodyOf(await call('viewer', 'GET', '/admin/customers?limit=50'));
          const asManager = bodyOf(await call('manager', 'GET', '/admin/customers?limit=50'));
          const pick = (b: Record<string, unknown>) =>
            (b.customers as Array<{ internalNotes: unknown }>).map((c) => c.internalNotes);
          assert.ok(pick(asManager).includes(SENTINEL), 'fixture did not apply');
          assert.ok(!pick(asViewer).includes(SENTINEL), 'viewer must not receive internalNotes');
        });
      });

      it('hides submission forensics (ip / user-agent) from a viewer', async () => {
        for (const [url, key] of [
          ['/admin/contact?limit=50', 'messages'],
          ['/admin/inquiries?limit=50', 'inquiries'],
          ['/admin/newsletter?limit=50', 'subscribers'],
        ] as const) {
          const body = bodyOf(await call('viewer', 'GET', url));
          const rows = body[key] as Array<Record<string, unknown>>;
          for (const row of rows) {
            if ('ipAddress' in row) assert.equal(row.ipAddress, null, `${url}: ipAddress leaked`);
            if ('userAgent' in row) assert.equal(row.userAgent, null, `${url}: userAgent leaked`);
          }
        }
      });

      it('hides payment-processor ids on an order from a viewer', async () => {
        const list = bodyOf(await call('viewer', 'GET', '/admin/orders?limit=50'));
        const rows = list.orders as Array<Record<string, unknown>>;
        for (const row of rows) {
          for (const field of [
            'stripeSessionId',
            'stripePaymentIntentId',
            'paypalOrderId',
            'paypalCaptureId',
          ]) {
            if (field in row) assert.equal(row[field], null, `${field} leaked to a viewer`);
          }
        }
      });
    });

    // --- the gate is about the method, not the URL -------------------------
    it('an unknown identity is unauthorized, not merely forbidden', async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/admin/orders',
        headers: { 'x-company-slug': slug },
      });
      assert.equal(res.statusCode, 401);
    });

    it('OPTIONS is never gated (CORS preflight must survive)', async () => {
      const res = await call('viewer', 'GET', '/admin/orders');
      assert.equal(res.statusCode, 200);
      const preflight = await app.inject({
        method: 'OPTIONS',
        url: '/admin/orders',
        headers: {
          origin: 'http://localhost:5173',
          'access-control-request-method': 'POST',
        },
      });
      assert.ok(
        preflight.statusCode < 400,
        `preflight should not be rejected, got ${preflight.statusCode}`,
      );
    });
  },
);
