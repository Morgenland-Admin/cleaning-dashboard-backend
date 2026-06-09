// Prod-safe seed for n8n live tests: only test rows, tagged source='n8n-test'.
//   pnpm db:seed:n8n-test           insert (idempotent per brand)
//   pnpm db:seed:n8n-test --clean   remove all 'n8n-test' rows
import { eq, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';

import { db, pool } from './index.js';
import { company } from './schema/shared.js';
import { getTenantTables } from './schema/tenant.js';

const SOURCE = 'n8n-test';
const DAY_MS = 24 * 60 * 60 * 1000;
const CLEAN = process.argv.includes('--clean');

async function cleanBrand(schemaName: string): Promise<number> {
  const t = getTenantTables(schemaName);
  const o = await db
    .delete(t.orders)
    .where(eq(t.orders.source, SOURCE))
    .returning({ id: t.orders.id });
  const i = await db
    .delete(t.serviceInquiries)
    .where(eq(t.serviceInquiries.source, SOURCE))
    .returning({ id: t.serviceInquiries.id });
  return o.length + i.length;
}

async function seedBrand(schemaName: string): Promise<boolean> {
  const t = getTenantTables(schemaName);
  const [{ n } = { n: 0 }] = await db
    .select({ n: sql<number>`count(*)::int` })
    .from(t.orders)
    .where(eq(t.orders.source, SOURCE));
  if (Number(n) > 0) return false; // already seeded

  const now = new Date();
  const baseOrder = {
    kind: 'teppichreinigung',
    currency: 'EUR',
    subtotalCents: 8900,
    totalCents: 8900,
    pickupMode: 'pickup' as const,
    customerName: 'Test Kunde',
    consentPrivacy: true,
    locale: 'de',
    source: SOURCE,
  };

  await db.insert(t.orders).values([
    // ALL_09 / ALL_96: freshly accepted.
    {
      ...baseOrder,
      publicToken: nanoid(24),
      status: 'accepted',
      customerEmail: 'test.accepted@example.com',
      customerPhone: '+491700000001',
      paidAt: now,
      acceptedAt: now,
    },
    // ALL_09: paid, awaiting acceptance.
    {
      ...baseOrder,
      publicToken: nanoid(24),
      status: 'paid',
      customerEmail: 'test.paid@example.com',
      customerPhone: '+491700000002',
      paidAt: now,
    },
    // ALL_18: stuck in accepted >14 days.
    {
      ...baseOrder,
      publicToken: nanoid(24),
      status: 'accepted',
      customerEmail: 'test.stuck@example.com',
      customerPhone: '+491700000003',
      createdAt: new Date(now.getTime() - 16 * DAY_MS),
      paidAt: new Date(now.getTime() - 16 * DAY_MS),
      acceptedAt: new Date(now.getTime() - 15 * DAY_MS),
    },
  ]);

  // ALL_95: inquiry with a photo attachment.
  await db.insert(t.serviceInquiries).values({
    name: 'Foto Testkunde',
    email: 'test.photo@example.com',
    phone: '+491700000004',
    service: 'Teppichreinigung',
    message: 'Test-Anfrage mit Teppich-Foto für die Carpet-Identifier-Tests (ALL_95).',
    locale: 'de',
    source: SOURCE,
    consentPrivacy: true,
    attachments: [
      {
        key: 'n8n-test/carpet-sample.jpg',
        name: 'carpet-sample.jpg',
        size: 482000,
        contentType: 'image/jpeg',
      },
    ],
  });
  return true;
}

async function main() {
  const companies = await db
    .select({ schemaName: company.schemaName, name: company.name })
    .from(company);

  if (CLEAN) {
    console.info('→ Removing n8n test data…');
    for (const c of companies) {
      const removed = await cleanBrand(c.schemaName);
      console.info(`   ✓ ${c.name}: removed ${removed} row(s)`);
    }
    console.info('\nDone. All rows tagged source="n8n-test" deleted.');
    return;
  }

  console.info('→ Seeding n8n test data (orders + photo inquiry per brand)…');
  for (const c of companies) {
    const seeded = await seedBrand(c.schemaName);
    console.info(`   ${seeded ? '✓' : '·'} ${c.name}${seeded ? '' : ' (already seeded, skipped)'}`);
  }
  console.info('\nDone. ALL_09 / ALL_96 / ALL_18 / ALL_95 test data is in place.');
}

main()
  .catch((err) => {
    console.error('n8n test seed failed:', err);
    process.exit(1);
  })
  .finally(() => pool.end());
