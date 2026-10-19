// Customer email history + compose routes over HTTP. Never reaches Resend: only guard paths and
// the render-only preview are exercised. Session is stubbed (`x-test-user`); skips without a database.
import assert from 'node:assert/strict';
import { randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { and, eq, inArray } from 'drizzle-orm';

import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { company, emailLog, membership, user } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';
import { NONCONTACTABLE_EMAIL_DOMAIN } from '../../email/service.js';

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

const PREFIX = 'test-customer-mail-';
const IDENTITIES = {
  manager: { id: `${PREFIX}manager`, accessLevel: 'manager', audience: 'admin' },
  viewer: { id: `${PREFIX}viewer`, accessLevel: 'viewer', audience: 'admin' },
} as const;
type Who = keyof typeof IDENTITIES;

describe(
  'customer email routes (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;
    let slug: string;
    let otherSlug: string;
    let tables: ReturnType<typeof getTenantTables>;
    const tag = randomBytes(4).toString('hex');
    const realEmail = `${PREFIX}${tag}@example.invalid`;
    const placeholderEmail = `${PREFIX}${tag}@${NONCONTACTABLE_EMAIL_DOMAIN}`;
    let realId = 0;
    let placeholderId = 0;
    const logIds: number[] = [];
    let toAddressRow = 0;
    let refRow = 0;

    before(async () => {
      const brands = await db
        .select({ slug: company.slug, schemaName: company.schemaName })
        .from(company)
        .where(eq(company.isActive, true))
        .limit(2);
      assert.ok(brands.length === 2, 'expected two active companies — run pnpm db:seed:local');
      slug = brands[0]!.slug;
      otherSlug = brands[1]!.slug;
      tables = getTenantTables(brands[0]!.schemaName);

      for (const identity of Object.values(IDENTITIES)) {
        await db
          .insert(user)
          .values({
            id: identity.id,
            name: `customer-mail ${identity.accessLevel}`,
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

      const inserted = await db
        .insert(tables.customers)
        .values([
          { email: realEmail, name: 'Anna Muster', salutation: 'frau', lastName: 'Muster' },
          { email: placeholderEmail, name: null, phone: '+49 40 123' },
        ])
        .returning({ id: tables.customers.id });
      [realId, placeholderId] = inserted.map((r) => r.id) as [number, number];

      const base = {
        kind: 'contact_reply',
        fromAddress: 'Test <test@example.invalid>',
        subject: `${PREFIX}subject`,
        html: '<p>x</p>',
        status: 'sent',
      };
      const rows = await db
        .insert(emailLog)
        .values([
          { ...base, companySlug: slug, toAddress: `other@example.invalid, ${realEmail}` },
          {
            ...base,
            companySlug: slug,
            toAddress: 'buchhaltung@example.invalid',
            refType: 'customer',
            refId: realId,
          },
          // Another brand's mail to the same address belongs to that brand's customer.
          { ...base, companySlug: otherSlug, toAddress: realEmail },
        ])
        .returning({ id: emailLog.id });
      logIds.push(...rows.map((r) => r.id));
      [toAddressRow, refRow] = logIds as [number, number];

      app = await buildApp({ logger: false });
      await app.ready();
      (app as unknown as { getSession: unknown }).getSession = (request: {
        headers: Record<string, unknown>;
        authUser: unknown;
        authSession: unknown;
      }) => {
        const key = request.headers['x-test-user'];
        const identity =
          typeof key === 'string' && key in IDENTITIES ? IDENTITIES[key as Who] : null;
        if (!identity) return Promise.resolve(null);
        const session = { user: identity, session: { userId: identity.id } };
        request.authSession = session;
        request.authUser = identity;
        return Promise.resolve(session);
      };
    });

    after(async () => {
      await app?.close();
      await db.delete(emailLog).where(inArray(emailLog.id, logIds));
      await db.delete(emailLog).where(inArray(emailLog.toAddress, [realEmail, placeholderEmail]));
      await db
        .delete(tables.customers)
        .where(inArray(tables.customers.id, [realId, placeholderId].filter(Boolean)));
      for (const identity of Object.values(IDENTITIES)) {
        await db.delete(membership).where(eq(membership.userId, identity.id));
        await db.delete(user).where(eq(user.id, identity.id));
      }
      await pool.end();
    });

    const call = (who: Who, method: 'GET' | 'POST', url: string, payload?: unknown) =>
      app.inject({
        method,
        url,
        headers: {
          'x-test-user': who,
          'x-company-slug': slug,
          ...(payload === undefined ? {} : { 'content-type': 'application/json' }),
        },
        ...(payload === undefined ? {} : { payload: payload as object }),
      });

    const customerMailRows = (address: string) =>
      db
        .select({ id: emailLog.id })
        .from(emailLog)
        .where(and(eq(emailLog.toAddress, address), eq(emailLog.kind, 'customer_message')));

    it('lists mail to the address and about the customer, newest first, own brand only', async () => {
      const res = await call('viewer', 'GET', `/admin/customers/${realId}/emails?limit=50`);
      assert.equal(res.statusCode, 200, res.body);
      const ids = res.json<{ emails: Array<{ id: number }> }>().emails.map((e) => e.id);
      assert.deepEqual(ids, [refRow, toAddressRow]);
    });

    it('pages with a cursor', async () => {
      const first = await call('viewer', 'GET', `/admin/customers/${realId}/emails?limit=1`);
      const body = first.json<{ emails: Array<{ id: number }>; nextCursor: string | null }>();
      assert.deepEqual(
        body.emails.map((e) => e.id),
        [refRow],
      );
      assert.ok(body.nextCursor);
      const second = await call(
        'viewer',
        'GET',
        `/admin/customers/${realId}/emails?limit=1&cursor=${encodeURIComponent(body.nextCursor)}`,
      );
      const next = second.json<{ emails: Array<{ id: number }>; nextCursor: string | null }>();
      assert.deepEqual(
        next.emails.map((e) => e.id),
        [toAddressRow],
      );
      assert.equal(next.nextCursor, null);
    });

    it('overview counts the same history and the linked lists page', async () => {
      const res = await call('viewer', 'GET', `/admin/customers/${realId}/overview`);
      assert.equal(res.statusCode, 200, res.body);
      assert.equal(res.json<{ stats: { emails: number } }>().stats.emails, 2);
      for (const kind of ['orders', 'invoices', 'inquiries', 'contacts']) {
        const list = await call('viewer', 'GET', `/admin/customers/${realId}/${kind}?limit=5`);
        assert.equal(list.statusCode, 200, list.body);
        const json = list.json<Record<string, unknown>>();
        assert.ok(Array.isArray(json[kind]), `${kind} is not a list`);
        assert.equal(json.nextCursor, null);
      }
    });

    it('a viewer cannot send', async () => {
      const res = await call('viewer', 'POST', `/admin/customers/${realId}/email`, {
        subject: 'Hallo',
        body: 'Test',
      });
      assert.equal(res.statusCode, 403);
    });

    it('refuses a placeholder address before anything is sent or logged', async () => {
      const res = await call('manager', 'POST', `/admin/customers/${placeholderId}/email`, {
        subject: 'Hallo',
        body: 'Test',
      });
      assert.equal(res.statusCode, 422, res.body);
      assert.equal(res.json<{ code: string }>().code, 'NON_CONTACTABLE');
      assert.equal((await customerMailRows(placeholderEmail)).length, 0);
    });

    it('validates the body and the customer', async () => {
      const empty = await call('manager', 'POST', `/admin/customers/${realId}/email`, {
        subject: '  ',
        body: 'Test',
      });
      assert.equal(empty.statusCode, 400);
      const missing = await call('manager', 'POST', '/admin/customers/2147483000/email', {
        subject: 'Hallo',
        body: 'Test',
      });
      assert.equal(missing.statusCode, 404);
    });

    it('preview renders the formal branded mail without sending or logging', async () => {
      const res = await call('manager', 'POST', `/admin/customers/${realId}/email/preview`, {
        subject: 'Ihr Termin',
        body: 'Wir kommen <morgen>.',
      });
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json<{ to: string; subject: string; html: string }>();
      assert.equal(body.to, realEmail);
      assert.equal(body.subject, 'Ihr Termin');
      assert.ok(body.html.includes('Sehr geehrte Frau Muster,'));
      assert.ok(body.html.includes('Wir kommen &lt;morgen&gt;.'));
      assert.equal((await customerMailRows(realEmail)).length, 0);
    });
  },
);
