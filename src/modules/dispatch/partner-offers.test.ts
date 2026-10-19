/** Partner offer routes over HTTP: lapsed offers, stored vs estimated money, closed-offer codes. */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { and, eq, inArray } from 'drizzle-orm';

import { buildApp, type App } from '../../app.js';
import { db, pool } from '../../db/index.js';
import { company, membership, user } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';
import { NONCONTACTABLE_EMAIL_DOMAIN } from '../../email/service.js';
import { generateOrderToken } from '../orders/lib.js';

const SLUG = 'cleanilo';
const PARTNER_USER = 'test-partner-offers-user';

interface OfferItem {
  id: number;
  status: string;
  payoutCents: number;
  commissionCents: number;
}
interface OfferDetail {
  offer: { status: string };
  job: Record<string, unknown>;
  payoutCents: number | null;
  commissionCents: number | null;
  orderId: number | null;
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
  'partner offer routes (HTTP)',
  { skip: ready ? false : 'needs a migrated DB with the cleanilo brand' },
  () => {
    let app: App;
    let partnerId: number;
    let orderIds: number[] = [];
    const offer = { lapsed: 0, mine: 0, reassigned: 0 };
    const tables = getTenantTables(SLUG);

    before(async () => {
      await db
        .insert(user)
        .values({
          id: PARTNER_USER,
          name: 'offers test partner',
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
        .values({ userId: PARTNER_USER, companyName: 'Offers Test GmbH', status: 'active' })
        .returning({ id: tables.partners.id });
      partnerId = p!.id;

      const order = (extra: Record<string, unknown>) => ({
        publicToken: generateOrderToken(),
        kind: 'teppichreinigung',
        status: 'paid',
        subtotalCents: 10_000,
        totalCents: 10_000,
        pickupMode: 'pickup',
        customerName: 'Erika Muster',
        customerEmail: `offers-test@${NONCONTACTABLE_EMAIL_DOMAIN}`,
        ...extra,
      });
      const orders = await db
        .insert(tables.orders)
        .values([
          order({}),
          // Assigned at an older rate: the stored split wins over today's estimate.
          order({
            assignedPartnerId: partnerId,
            assignedAt: new Date(),
            commissionCents: 1_000,
            partnerPayoutCents: 9_000,
            payoutStatus: 'pending',
          }),
          order({ assignedPartnerId: partnerId + 1_000_000, assignedAt: new Date() }),
        ])
        .returning({ id: tables.orders.id });
      orderIds = orders.map((o) => o.id);
      const past = new Date(Date.now() - 60_000);
      const offers = await db
        .insert(tables.partnerOffers)
        .values([
          { partnerId, orderId: orderIds[0]!, status: 'offered', expiresAt: past },
          { partnerId, orderId: orderIds[1]!, status: 'accepted', expiresAt: past },
          { partnerId, orderId: orderIds[2]!, status: 'accepted', expiresAt: past },
        ])
        .returning({ id: tables.partnerOffers.id });
      [offer.lapsed, offer.mine, offer.reassigned] = offers.map((o) => o.id) as [
        number,
        number,
        number,
      ];

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
      await db.delete(tables.partnerOffers).where(eq(tables.partnerOffers.partnerId, partnerId));
      if (orderIds.length) {
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

    it('a lapsed offer leaves the open list and shows as expired in the history', async () => {
      const open = (await call('GET', '/partner/offers?scope=open')).json<{
        offers: OfferItem[];
      }>();
      assert.equal(
        open.offers.some((o) => o.id === offer.lapsed),
        false,
      );
      const history = (await call('GET', '/partner/offers?scope=history')).json<{
        offers: OfferItem[];
      }>();
      const lapsed = history.offers.find((o) => o.id === offer.lapsed);
      assert.equal(lapsed?.status, 'expired');
      assert.equal('createdByUserId' in lapsed, false);
      assert.equal(lapsed.payoutCents + lapsed.commissionCents, 10_000);
    });

    it('a lapsed offer can be neither accepted nor declined', async () => {
      const accept = await call('POST', `/partner/offers/${offer.lapsed}/accept`, {});
      assert.equal(accept.statusCode, 409);
      assert.equal(accept.json<{ code: string }>().code, 'OFFER_CLOSED');
      const decline = await call('POST', `/partner/offers/${offer.lapsed}/decline`, {});
      assert.equal(decline.statusCode, 409);
      assert.equal(decline.json<{ code: string }>().code, 'OFFER_CLOSED');
    });

    it('an accepted offer shows the stored split and links its order', async () => {
      const body = (await call('GET', `/partner/offers/${offer.mine}`)).json<OfferDetail>();
      assert.equal(body.payoutCents, 9_000);
      assert.equal(body.commissionCents, 1_000);
      assert.equal(body.orderId, orderIds[1]);
    });

    it('an accepted offer whose order moved on does not link it', async () => {
      const body = (await call('GET', `/partner/offers/${offer.reassigned}`)).json<OfferDetail>();
      assert.equal(body.offer.status, 'accepted');
      assert.equal(body.orderId, null);
      assert.equal('customerName' in body.job, false);
    });
  },
);
