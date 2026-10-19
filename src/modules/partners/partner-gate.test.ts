/** HTTP wiring of the partner portal: status gate, own-data scoping and origin↔brand binding. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { and, eq } from 'drizzle-orm';

import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { company, membership, user } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';

const SLUG = 'cleanilo';
const PARTNER_USER = 'test-partner-gate-user';

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
  'partner portal gate (HTTP)',
  { skip: ready ? false : 'needs a migrated DB with the cleanilo brand' },
  () => {
    let app: App;
    let partnerId: number;
    const tables = getTenantTables(SLUG);

    before(async () => {
      await db
        .insert(user)
        .values({
          id: PARTNER_USER,
          name: 'gate test partner',
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
        .values({
          userId: PARTNER_USER,
          companyName: 'Gate Test GmbH',
          status: 'suspended',
          internalNotes: 'staff-only note',
        })
        .returning({ id: tables.partners.id });
      partnerId = p!.id;

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
      await db.delete(tables.partners).where(eq(tables.partners.userId, PARTNER_USER));
      await db
        .delete(membership)
        .where(and(eq(membership.userId, PARTNER_USER), eq(membership.companySlug, SLUG)));
      await db.delete(user).where(eq(user.id, PARTNER_USER));
      await pool.end();
    });

    const get = (url: string, headers: Record<string, string> = {}) =>
      app.inject({
        method: 'GET',
        url,
        headers: { 'x-test-user': 'partner', 'x-company-slug': SLUG, ...headers },
      });

    const setStatus = (status: string) =>
      db.update(tables.partners).set({ status }).where(eq(tables.partners.id, partnerId));

    it('suspended partner can read their profile, without staff notes', async () => {
      const res = await get('/partner/partners/me');
      assert.equal(res.statusCode, 200, res.body);
      assert.ok(!res.body.includes('staff-only note'), 'internalNotes leaked to the partner');
      assert.equal(res.json<{ partner: { status: string } }>().partner.status, 'suspended');
    });

    for (const url of ['/partner/offers', '/partner/orders', '/partner/orders/earnings']) {
      it(`suspended partner is refused ${url}`, async () => {
        await setStatus('suspended');
        const res = await get(url);
        assert.equal(res.statusCode, 403, res.body);
      });
      it(`active partner reaches ${url}`, async () => {
        await setStatus('active');
        const res = await get(url);
        assert.equal(res.statusCode, 200, res.body);
      });
    }

    it('active partner sees their checklist and documents', async () => {
      await setStatus('active');
      const me = await get('/partner/partners/me');
      assert.equal(me.statusCode, 200);
      const body = me.json<{ checklist: { verified: boolean; missing: string[] } }>();
      assert.equal(body.checklist.verified, false);
      assert.ok(body.checklist.missing.includes('document:gewerbeanmeldung'));
      const docs = await get('/partner/partners/me/documents');
      assert.equal(docs.statusCode, 200, docs.body);
    });

    it('commission rates follow the partner override, else the catalog chain', async () => {
      const res = await get('/partner/partners/me/commission');
      assert.equal(res.statusCode, 200, res.body);
      const body = res.json<{
        partnerRatePercent: number | null;
        services: Record<string, number>;
      }>();
      assert.equal(body.partnerRatePercent, null);
      assert.equal(typeof body.services.teppichreinigung, 'number');
      // Request jobs are assigned with the slug as kind, so they get a rate too.
      assert.equal(typeof body.services.dachreinigung, 'number');

      await db
        .update(tables.partners)
        .set({ commissionRate: '9.50' })
        .where(eq(tables.partners.id, partnerId));
      const own = (await get('/partner/partners/me/commission')).json<{
        partnerRatePercent: number | null;
        services: Record<string, number>;
      }>();
      await db
        .update(tables.partners)
        .set({ commissionRate: null })
        .where(eq(tables.partners.id, partnerId));
      assert.equal(own.partnerRatePercent, 9.5);
      assert.ok(Object.values(own.services).every((r) => r === 9.5));
    });

    it('a partner cannot reach admin routes', async () => {
      const res = await get('/admin/partners');
      assert.equal(res.statusCode, 403);
    });

    it("another brand's origin cannot act as this brand", async () => {
      const res = await app.inject({
        method: 'GET',
        url: '/storefront/services',
        headers: { 'x-company-slug': SLUG, origin: 'https://hamburg-teppichreinigung.de' },
      });
      assert.equal(res.statusCode, 403, res.body);
    });

    it("the brand's own origins and server-side calls are allowed", async () => {
      for (const origin of ['https://www.cleanilo.de', 'https://cleanilo.de', undefined]) {
        const res = await app.inject({
          method: 'GET',
          url: '/storefront/services',
          headers: { 'x-company-slug': SLUG, ...(origin ? { origin } : {}) },
        });
        assert.equal(res.statusCode, 200, `${origin}: ${res.body}`);
      }
    });

    it('public catalog, brand and reviews respond', async () => {
      const services = await get('/storefront/services');
      assert.equal(services.json<{ services: unknown[] }>().services.length >= 36, true);
      const brand = await get('/storefront/brand');
      assert.equal(
        brand.json<{ brand: { partnerPortalOrigin: string } }>().brand.partnerPortalOrigin,
        'https://partner.cleanilo.de',
      );
      const reviews = await get('/storefront/reviews');
      assert.equal(reviews.statusCode, 200, reviews.body);
    });
  },
);
