/** Catalog commission lookup for fixed-price kinds and catalog-slug kinds (imported/inquiry orders). */
import assert from 'node:assert/strict';
import { after, before, describe, it } from 'node:test';

import { eq, inArray, like } from 'drizzle-orm';

import { db, pool } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';
import { NONCONTACTABLE_EMAIL_DOMAIN } from '../../email/service.js';
import { orderTarget } from '../dispatch/lib.js';
import { assignOrderToPartner, resolveCommissionRate } from './assign.js';
import { generateOrderToken } from './lib.js';

const SLUG = 'cleanilo';
const PREFIX = 'zz-commission-test';

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
  'commission rate lookup',
  { skip: ready ? false : 'needs a migrated DB with the cleanilo brand' },
  () => {
    const tables = getTenantTables(SLUG);
    const slugKind = `${PREFIX}-slug`;
    const fixedKind = `${PREFIX}-fixed`;
    const orderIds: number[] = [];
    const noOverride = { commissionRate: null };

    before(async () => {
      await db.insert(tables.serviceCatalog).values([
        // An inquiry-type service: orders carry its slug as kind, it has no order_kind.
        { slug: slugKind, name: 'Slug kind', pricingMode: 'inquiry', commissionRate: '20.00' },
        // Two services share one fixed-price kind; the one whose slug is the kind wins.
        {
          slug: `${fixedKind}-variant`,
          name: 'Variant',
          pricingMode: 'fixed',
          orderKind: fixedKind,
          commissionRate: '25.00',
          sortOrder: -100,
        },
        {
          slug: fixedKind,
          name: 'Canonical',
          pricingMode: 'fixed',
          orderKind: fixedKind,
          commissionRate: '15.00',
          sortOrder: 100,
        },
      ]);
    });

    after(async () => {
      if (orderIds.length) {
        await db.delete(tables.orders).where(inArray(tables.orders.id, orderIds));
      }
      await db.delete(tables.serviceCatalog).where(like(tables.serviceCatalog.slug, `${PREFIX}%`));
      await pool.end();
    });

    it('a catalog-slug kind uses that service rate, not the 12 % default', async () => {
      assert.equal(await resolveCommissionRate(tables, noOverride, slugKind), 20);
    });

    it('a shared fixed-price kind resolves to the service named like the kind', async () => {
      assert.equal(await resolveCommissionRate(tables, noOverride, fixedKind), 15);
      assert.equal(await resolveCommissionRate(tables, noOverride, `${PREFIX}-none`), null);
    });

    it('the partner override still wins', async () => {
      assert.equal(await resolveCommissionRate(tables, { commissionRate: '8' }, slugKind), 8);
    });

    it('assignment stores the split at the catalog rate', async () => {
      const [order] = await db
        .insert(tables.orders)
        .values({
          publicToken: generateOrderToken(),
          kind: slugKind,
          status: 'paid',
          subtotalCents: 10_000,
          totalCents: 10_000,
          pickupMode: 'onsite',
          customerName: 'Test',
          customerEmail: `commission-test@${NONCONTACTABLE_EMAIL_DOMAIN}`,
        })
        .returning();
      orderIds.push(order!.id);
      const partner = { id: 999_999_999, commissionRate: null } as Parameters<
        typeof assignOrderToPartner
      >[2];
      const result = await assignOrderToPartner(tables, order!, partner);
      assert.equal(result?.split.commissionCents, 2_000);
      assert.equal(result?.order.partnerPayoutCents, 8_000);

      // Dispatch matching filters partners by the same service.
      const target = await orderTarget(tables, order!);
      assert.deepEqual(target.serviceSlugs, [slugKind]);
    });
  },
);
