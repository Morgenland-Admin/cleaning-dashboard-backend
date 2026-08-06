/**
 * Exercises the LIVE application read paths over the imported CLEANILO rows,
 * so the audit tests the dashboard's own logic and not hand-written SQL.
 * Read-only — computeCustomerTotals/computeLoyaltyTier are pure readers.
 *
 *   DOTENV_CONFIG_PATH=.env.prod node --import tsx scripts/audit-cleanilo-live-reads.ts
 */
import { eq, sql } from 'drizzle-orm';

import { db } from '../src/db/index.ts';
import { company } from '../src/db/schema/shared.ts';
import { getTenantTables } from '../src/db/schema/tenant.ts';
import { computeCustomerTotals } from '../src/lib/customer-stats.ts';
import { computeLoyaltyTier } from '../src/lib/loyalty.ts';

function eur(cents: number): string {
  return (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2 }) + ' €';
}

async function main(): Promise<void> {
  const [companyRow] = await db.select().from(company).where(eq(company.slug, 'cleanilo')).limit(1);
  const t = getTenantTables(companyRow!.schemaName);
  const L = console.log;

  const imported = await db
    .select({
      id: t.customers.id,
      email: t.customers.email,
      name: t.customers.name,
      storedOrders: t.customers.totalOrders,
      storedSpent: t.customers.totalSpentCents,
      storedTier: t.customers.loyaltyTier,
    })
    .from(t.customers)
    .where(sql`${t.customers.tags} @> '["import-2021-26"]'::jsonb`)
    .orderBy(t.customers.id);

  L(`\nLIVE READ PATH — computeCustomerTotals over ${imported.length} imported customers\n`);

  let spentDrift = 0;
  let orderDrift = 0;
  let tierDrift = 0;
  let liveSpentTotal = 0;
  const worst: string[] = [];

  for (const c of imported) {
    const live = await computeCustomerTotals(t, c.id, c.email);
    liveSpentTotal += live.totalSpentCents;
    const liveTier = computeLoyaltyTier(live.totalOrders, live.totalSpentCents);
    if (live.totalSpentCents !== Number(c.storedSpent)) {
      spentDrift += 1;
      if (worst.length < 10)
        worst.push(
          `    ${c.name}: stored ${eur(Number(c.storedSpent))} vs live ${eur(live.totalSpentCents)}`,
        );
    }
    if (live.totalOrders !== Number(c.storedOrders)) orderDrift += 1;
    if (liveTier !== c.storedTier) {
      tierDrift += 1;
      if (worst.length < 10)
        worst.push(`    ${c.name}: tier stored ${c.storedTier} vs live ${liveTier}`);
    }
  }

  L(`  stored vs live turnover mismatches   ${spentDrift}`);
  L(`  stored vs live order-count mismatch  ${orderDrift}`);
  L(`  stored vs live tier mismatches       ${tierDrift}`);
  for (const w of worst) L(w);
  L(`  live turnover sum (imported custs)   ${eur(liveSpentTotal)}`);
  L(
    `  → double-count check: equals imported invoice volume 278.639,13 € ? ${
      liveSpentTotal === 27863913 ? 'yes (no double count)' : 'NO — differs'
    }`,
  );

  L(`\nVERIFIED-EMAIL CUSTOMERS IN PROD (rule: real address only if verified via address/invoice)`);
  const verified = imported.filter((c) => !c.email.endsWith('@import.cleanilo.local'));
  for (const c of verified) {
    L(
      `  ${(c.name ?? '—').padEnd(34)} ${c.email.padEnd(34)} ${String(c.storedOrders).padStart(2)} inv  ${eur(Number(c.storedSpent))}`,
    );
  }
  L(`  total verified: ${verified.length}`);

  const schmidt = imported.filter((c) => /schmidt/i.test(c.name ?? ''));
  L(`\nSCHMIDT CHECK (must be placeholder unless verified via address/invoice)`);
  if (schmidt.length === 0) L('  no customer matching /schmidt/i');
  for (const c of schmidt) {
    const isPlaceholder = c.email.endsWith('@import.cleanilo.local');
    L(
      `  ${c.name}  ${c.email}  → ${isPlaceholder ? 'placeholder ✓' : 'REAL EMAIL — must be justified'}`,
    );
  }

  L('');
  process.exit(spentDrift + orderDrift + tierDrift === 0 ? 0 : 1);
}

void main();
