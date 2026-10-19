/** Tests the wiring, not the predicate: every state-changing admin route group must sit behind `requireWriteAccess`. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { and, desc, eq } from 'drizzle-orm';

import { buildApp, type App } from '../app.js';
import { db, pool } from '../db/index.js';
import { company, membership, user } from '../db/schema/shared.js';

type AccessLevel = 'super_admin' | 'admin' | 'manager' | 'seo' | 'viewer';

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
  seo: { id: `${TEST_USER_PREFIX}seo`, accessLevel: 'seo', audience: 'admin' },
  viewer: { id: `${TEST_USER_PREFIX}viewer`, accessLevel: 'viewer', audience: 'admin' },
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

      // One user per access level in the same brand, so `accessLevel` is the only variable.
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

      // Stubbed session, real routes: keeps password hashing out of an authorization test.
      // Guards read `getSession` off the instance at call time, so this reaches all of them.
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
        // Deliberately invalid: a request that clears the gate fails in Zod (400), a blocked one
        // gets 403, and nothing is written.
        ...(method === 'GET' || method === 'DELETE'
          ? {}
          : { payload: { __invalid_probe__: true } }),
      });

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
      '/admin/emails',
      '/admin/service-catalog',
      '/admin/partner-applications',
      '/admin/partners/1/documents',
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

    // `seo` is an allowlist (lib/access.ts `seoMayAccess`); every other read, incl. the shell's polls, is refused.
    const SEO_READS = ['/admin/seo-pages', '/admin/reviews', '/admin/companies', '/admin/users/me'];

    for (const url of SEO_READS) {
      it(`seo can read ${url}`, async () => {
        const res = await call('seo', 'GET', url);
        assert.equal(
          res.statusCode,
          200,
          `expected 200, got ${res.statusCode}: ${res.body.slice(0, 200)}`,
        );
      });
    }

    for (const url of [
      ...READS.filter((u) => !SEO_READS.includes(u)),
      '/admin/dashboard/summary',
      '/admin/notifications/unread-count',
      '/admin/search?q=test',
      '/admin/tasks',
      '/admin/partners',
      '/admin/exports',
      '/admin/push/status',
    ]) {
      it(`seo is refused GET ${url}`, async () => {
        const res = await call('seo', 'GET', url);
        assert.equal(
          res.statusCode,
          403,
          `expected 403, got ${res.statusCode}: ${res.body.slice(0, 200)}`,
        );
      });
    }

    it('seo is refused brand stats (exact match on /admin/companies)', async () => {
      const res = await call('seo', 'GET', `/admin/companies/${slug}/stats`);
      assert.equal(res.statusCode, 403);
    });

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
      ['POST', '/admin/orders/1/receipt'],
      ['POST', '/admin/orders/1/receipt/preview'],
      ['POST', '/admin/orders/1/receipt/send'],
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
      ['POST', '/admin/service-catalog'],
      ['POST', '/admin/orders/1/offers'],
      ['POST', '/admin/inquiries/1/offers'],
      ['POST', '/admin/partners/1/documents/1/review'],
      ['POST', '/admin/tasks'],
      ['PATCH', '/admin/tasks/1'],
      ['POST', '/admin/tasks/1/comments'],
    ];
    // Bodyless or all-optional writes: probed for refusal only, since letting one through would act.
    const REFUSE_ONLY_WRITES: Array<[method: 'POST' | 'PATCH', url: string]> = [
      ['PATCH', '/admin/service-catalog/1'],
      ['POST', '/admin/partner-applications/1/invite'],
      ['POST', '/admin/partner-applications/1/reject'],
      ['POST', '/admin/partner-offers/1/withdraw'],
      ['POST', '/admin/tasks/1/ack'],
      ['POST', '/admin/tasks/1/done'],
      ['POST', '/admin/tasks/1/dismiss'],
    ];
    for (const [method, url] of REFUSE_ONLY_WRITES) {
      for (const level of ['viewer', 'seo'] as const) {
        it(`${level} is refused ${method} ${url}`, async () => {
          const res = await call(level, method, url);
          assert.equal(
            res.statusCode,
            403,
            `expected 403, got ${res.statusCode}: ${res.body.slice(0, 200)}`,
          );
        });
      }
    }

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

    // POST probes only: an invalid PATCH body can pass an all-optional schema and DELETE has no
    // body to fail on, so both would touch a real row.
    const SEO_WRITES: Array<[method: 'POST', url: string]> = [
      ['POST', '/admin/seo-pages'],
      ['POST', '/admin/uploads/sign-public-image'],
    ];

    for (const [method, url] of WRITES) {
      if (SEO_WRITES.some(([m, u]) => m === method && u === url)) continue;
      it(`seo is refused ${method} ${url}`, async () => {
        const res = await call('seo', method, url);
        assert.equal(
          res.statusCode,
          403,
          `expected 403, got ${res.statusCode}: ${res.body.slice(0, 200)}`,
        );
      });
    }

    for (const [method, url] of SEO_WRITES) {
      it(`seo is allowed through to ${method} ${url}`, async () => {
        const res = await call('seo', method, url);
        assert.notEqual(res.statusCode, 403, `seo was blocked on ${method} ${url}`);
        assert.notEqual(res.statusCode, 401, 'seo was treated as unauthenticated');
      });
    }

    // Mirror of the block list: catches a gate accidentally narrowed to super_admin only.
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

    // Goes through HTTP rather than `redactForViewer`: the bug to catch is a route that forgets to call it.
    describe('viewer redaction over HTTP', () => {
      const SENTINEL = 'integration-test-internal-note';

      /** Sets internalNotes on one row of a tenant table, restoring it afterwards. */
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

        // Newest row, so it is on the lists' first page however many rows exist.
        const [row] = await db
          .select({ id: target.id, internalNotes: target.internalNotes })
          .from(target)
          .orderBy(desc(target.createdAt), desc(target.id))
          .limit(1);
        if (!row) return; // nothing seeded for this table
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

      it('hides reviewer email + order link from seo', async () => {
        const asSeo = bodyOf(await call('seo', 'GET', '/admin/reviews?limit=50'));
        for (const row of asSeo.reviews as Array<Record<string, unknown>>) {
          assert.equal(row.customerEmail, null, 'customerEmail leaked to seo');
          assert.equal(row.orderId, null, 'orderId leaked to seo');
        }
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

      it('hides partner-applicant ip / user-agent from a viewer (list + detail)', async () => {
        const { getTenantTables } = await import('../db/schema/tenant.js');
        const { loadCompany } = await import('../lib/company-loader.js');
        const companyRow = await loadCompany(slug);
        assert.ok(companyRow);
        const { partnerApplications } = getTenantTables(companyRow.schemaName);
        const UA = 'integration-test-applicant-ua';
        const [row] = await db
          .insert(partnerApplications)
          .values({
            companyName: 'Redaction Test GmbH',
            contactName: 'Redaction Test',
            email: 'redaction-test@example.invalid',
            postalCode: '20457',
            ipAddress: '203.0.113.7',
            userAgent: UA,
          })
          .returning({ id: partnerApplications.id });
        try {
          type Application = { id: number; ipAddress: unknown; userAgent: unknown };
          const listed = (level: AccessLevel) =>
            call(level, 'GET', '/admin/partner-applications').then((res) =>
              (bodyOf(res).applications as Application[]).find((a) => a.id === row!.id),
            );
          const detail = (level: AccessLevel) =>
            call(level, 'GET', `/admin/partner-applications/${row!.id}`).then(
              (res) => bodyOf(res).application as Application,
            );
          const asManager = await listed('manager');
          assert.equal(
            asManager?.userAgent,
            UA,
            'manager should see the UA — fixture did not apply',
          );
          assert.equal((await detail('manager')).userAgent, UA);
          for (const seen of [await listed('viewer'), await detail('viewer')]) {
            assert.ok(seen, 'viewer should still see the application');
            assert.equal(seen.ipAddress, null, 'applicant ipAddress leaked to a viewer');
            assert.equal(seen.userAgent, null, 'applicant userAgent leaked to a viewer');
          }
        } finally {
          await db.delete(partnerApplications).where(eq(partnerApplications.id, row!.id));
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
