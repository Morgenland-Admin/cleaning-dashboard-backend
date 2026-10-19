// Email log HTTP tests: brand scoping, Resend webhook signature + row matching, blocked sends still logged.
// The session is stubbed (`x-test-user` picks the identity); skips without a database.
import assert from 'node:assert/strict';
import { createHmac, randomBytes } from 'node:crypto';
import { after, before, describe, it } from 'node:test';

import { eq, inArray } from 'drizzle-orm';

import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { company, emailLog, membership, user } from '../../db/schema/shared.js';
import { NONCONTACTABLE_EMAIL_DOMAIN, sendEmail } from '../../email/service.js';

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

const PREFIX = 'test-email-log-';
const IDENTITIES = {
  super: { id: `${PREFIX}super`, accessLevel: 'super_admin', audience: 'admin' },
  manager: { id: `${PREFIX}manager`, accessLevel: 'manager', audience: 'admin' },
} as const;
type Who = keyof typeof IDENTITIES;
type ListBody = { emails: Array<{ id: number }> };

function sign(secret: string, id: string, timestamp: number, body: string): string {
  const key = Buffer.from(secret.replace(/^whsec_/, ''), 'base64');
  return `v1,${createHmac('sha256', key).update(`${id}.${timestamp}.${body}`).digest('base64')}`;
}

describe(
  'email log (HTTP)',
  { skip: dbUp ? false : 'no reachable DATABASE_URL — start postgres to run these' },
  () => {
    let app: App;
    let brandA: string;
    let brandB: string;
    let originalSecret: string | null = null;
    const secret = `whsec_${randomBytes(24).toString('base64')}`;
    const rowIds: number[] = [];
    const resendA = `${PREFIX}${randomBytes(6).toString('hex')}`;
    let rowA = 0;
    let rowB = 0;
    let rowSystem = 0;

    before(async () => {
      const brands = await db
        .select({ slug: company.slug, secret: company.resendWebhookSecret })
        .from(company)
        .where(eq(company.isActive, true))
        .limit(2);
      assert.ok(brands.length === 2, 'expected two active companies — run pnpm db:seed:local');
      brandA = brands[0]!.slug;
      brandB = brands[1]!.slug;
      originalSecret = brands[0]!.secret;
      await db.update(company).set({ resendWebhookSecret: secret }).where(eq(company.slug, brandA));

      for (const identity of Object.values(IDENTITIES)) {
        await db
          .insert(user)
          .values({
            id: identity.id,
            name: `email-log ${identity.accessLevel}`,
            email: `${identity.id}@example.invalid`,
            emailVerified: true,
            audience: identity.audience,
            accessLevel: identity.accessLevel,
            isActive: true,
          })
          .onConflictDoNothing();
      }
      // The manager is a member of brand A only.
      await db
        .insert(membership)
        .values({
          userId: IDENTITIES.manager.id,
          companySlug: brandA,
          role: 'admin',
          acceptedAt: new Date(),
        })
        .onConflictDoNothing();

      const base = {
        kind: 'invoice',
        toAddress: 'kunde@example.invalid',
        fromAddress: 'Test <test@example.invalid>',
        subject: `${PREFIX}subject`,
        html: '<p>hello</p>',
        status: 'sent',
      };
      const inserted = await db
        .insert(emailLog)
        .values([
          { ...base, companySlug: brandA, resendId: resendA },
          { ...base, companySlug: brandB },
          { ...base, companySlug: null, kind: 'password_reset', html: null },
        ])
        .returning({ id: emailLog.id });
      [rowA, rowB, rowSystem] = inserted.map((r) => r.id) as [number, number, number];
      rowIds.push(rowA, rowB, rowSystem);

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
      await db.delete(emailLog).where(inArray(emailLog.id, rowIds));
      await db
        .delete(emailLog)
        .where(eq(emailLog.toAddress, `${PREFIX}blocked@${NONCONTACTABLE_EMAIL_DOMAIN}`));
      await db
        .update(company)
        .set({ resendWebhookSecret: originalSecret })
        .where(eq(company.slug, brandA));
      await db.delete(membership).where(eq(membership.userId, IDENTITIES.manager.id));
      for (const identity of Object.values(IDENTITIES)) {
        await db.delete(user).where(eq(user.id, identity.id));
      }
      await pool.end();
    });

    const get = (who: Who, url: string) =>
      app.inject({ method: 'GET', url, headers: { 'x-test-user': who } });

    const listIds = async (who: Who) => {
      const res = await get(who, `/admin/emails?q=${PREFIX}subject&limit=100`);
      assert.equal(res.statusCode, 200, res.body);
      return res.json<ListBody>().emails.map((e) => e.id);
    };

    it('a manager sees only their own brands — no other brand, no platform mail', async () => {
      const ids = await listIds('manager');
      assert.ok(ids.includes(rowA));
      assert.ok(!ids.includes(rowB));
      assert.ok(!ids.includes(rowSystem));
    });

    it('a super_admin sees every brand plus platform mail', async () => {
      const ids = await listIds('super');
      assert.ok(ids.includes(rowA) && ids.includes(rowB) && ids.includes(rowSystem));
    });

    it('detail outside the caller’s scope is a 404, inside it carries the HTML', async () => {
      assert.equal((await get('manager', `/admin/emails/${rowB}`)).statusCode, 404);
      assert.equal((await get('manager', `/admin/emails/${rowSystem}`)).statusCode, 404);
      const res = await get('manager', `/admin/emails/${rowA}`);
      assert.equal(res.statusCode, 200);
      assert.equal(res.json<{ email: { html: string } }>().email.html, '<p>hello</p>');
    });

    it('the brand filter narrows to one brand', async () => {
      const res = await get('super', `/admin/emails?brand=${brandB}&q=${PREFIX}subject`);
      const ids = res.json<ListBody>().emails.map((e) => e.id);
      assert.deepEqual(ids, [rowB]);
    });

    it('a blocked send is still logged, and secret-bearing mail keeps no body', async () => {
      const to = `${PREFIX}blocked@${NONCONTACTABLE_EMAIL_DOMAIN}`;
      const res = await sendEmail({
        to,
        from: 'Test <test@example.invalid>',
        email: { subject: `${PREFIX}invite`, html: '<a href="https://x/?token=secret">x</a>' },
        log: { companySlug: brandA, kind: 'invite' },
      });
      assert.equal(res.skipped, true);
      const [row] = await db.select().from(emailLog).where(eq(emailLog.toAddress, to)).limit(1);
      assert.ok(row, 'expected an email_log row for the blocked send');
      assert.equal(row.status, 'blocked');
      assert.equal(row.companySlug, brandA);
      assert.equal(row.html, null);
    });

    const postWebhook = (
      account: string,
      payload: unknown,
      opts: { signWith?: string; tamper?: boolean } = {},
    ) => {
      const body = JSON.stringify(payload);
      const id = `msg_${randomBytes(8).toString('hex')}`;
      const ts = Math.floor(Date.now() / 1000);
      return app.inject({
        method: 'POST',
        url: `/webhooks/resend/${account}`,
        headers: {
          'content-type': 'application/json',
          'svix-id': id,
          'svix-timestamp': String(ts),
          'svix-signature': sign(opts.signWith ?? secret, id, ts, body),
        },
        payload: opts.tamper ? body.replace('delivered', 'bounced') : body,
      });
    };

    const event = (type: string, emailId: string, createdAt = new Date()) => ({
      type,
      created_at: createdAt.toISOString(),
      data: { email_id: emailId, created_at: createdAt.toISOString(), from: 'x', to: ['y'] },
    });

    it('rejects a bad signature and a tampered body', async () => {
      const wrong = `whsec_${randomBytes(24).toString('base64')}`;
      assert.equal(
        (await postWebhook(brandA, event('email.delivered', resendA), { signWith: wrong }))
          .statusCode,
        400,
      );
      assert.equal(
        (await postWebhook(brandA, event('email.delivered', resendA), { tamper: true })).statusCode,
        400,
      );
    });

    it('an account with no secret configured is a 404', async () => {
      const res = await postWebhook('no_such_brand', event('email.delivered', resendA));
      assert.equal(res.statusCode, 404);
    });

    it('a signed delivered event updates the matching row', async () => {
      const res = await postWebhook(brandA, event('email.delivered', resendA));
      assert.equal(res.statusCode, 200, res.body);
      const [row] = await db.select().from(emailLog).where(eq(emailLog.id, rowA));
      assert.equal(row?.deliveryStatus, 'delivered');
      assert.ok(row?.deliveredAt);
      assert.equal(row?.events.length, 1);
    });

    it('an unknown id is retried while fresh, acknowledged once old', async () => {
      const unknown = `${PREFIX}unknown`;
      assert.equal((await postWebhook(brandA, event('email.sent', unknown))).statusCode, 503);
      const old = new Date(Date.now() - 60 * 60_000);
      assert.equal((await postWebhook(brandA, event('email.sent', unknown, old))).statusCode, 200);
    });

    it('inbound and non-email events are acknowledged and ignored', async () => {
      const res = await postWebhook(brandA, event('email.received', resendA));
      assert.equal(res.statusCode, 200);
      assert.equal(res.json<{ ignored?: boolean }>().ignored, true);
    });
  },
);
