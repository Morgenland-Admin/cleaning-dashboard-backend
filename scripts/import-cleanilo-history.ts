/**
 * CLEANILO historical invoice-customer import.
 *
 *   Dry run (default, no writes):
 *     node --import tsx scripts/import-cleanilo-history.ts <invoices.json> <reconciliation.csv>
 *   Real import (guarded — direct writes to the cleanilo tenant):
 *     node --import tsx scripts/import-cleanilo-history.ts <invoices.json> <reconciliation.csv> --commit
 *
 * Automation-safety (agreed with Kabir): rows are written DIRECTLY as
 * closed/paid, bypassing every live code path — no order-confirmation,
 * auto-invoicing, status notifications or dunning fire. Invoices land as `paid`
 * (outside the dunning sweep's sent/overdue filter); all imported customers
 * carry the no-marketing flag. Original invoice numbers are preserved (GoBD).
 *
 * The dry-run path does not touch the DB layer, so it runs with no database
 * connection. Only --commit dynamically loads the writer.
 */
import { eur, makePlan, type ImportPlan } from './import-cleanilo-lib.ts';

type LoyaltyTier = 'neukunde' | 'stammkunde' | 'premium';

function printReport(plan: ImportPlan): void {
  const { invoices, customers, merges } = plan;
  const grossTotal = invoices.reduce((s, i) => s + i.grossCents, 0);
  const verifiedCount = customers.filter((c) => !c.emailIsPlaceholder).length;
  const b2bCount = customers.filter((c) => c.isB2B).length;
  const tierCounts: Record<LoyaltyTier, number> = { neukunde: 0, stammkunde: 0, premium: 0 };
  for (const c of customers) tierCounts[c.tier] += 1;
  const variantMerges = merges.filter((m) => m.variants.length > 1);

  const L = console.log;
  L('\n══════════════════════════════════════════════════════════════');
  L('  CLEANILO HISTORICAL IMPORT — DRY RUN (nothing written)');
  L('══════════════════════════════════════════════════════════════\n');
  L('TOTALS');
  L(`  Invoices (order history)      ${invoices.length}`);
  L(`  Gross volume                  ${eur(grossTotal)}`);
  L(`  Customers after merge         ${customers.length}`);
  L(`    with verified email         ${verifiedCount}`);
  L(`    with placeholder email      ${customers.length - verifiedCount}  (no-marketing)`);
  L(`  B2B customers (tag: b2b)      ${b2bCount}`);
  L(
    `  Duplicate groups merged       ${merges.length}  (${variantMerges.length} across spelling variants)`,
  );
  L('');
  L('TIER ROLLUP (auto: premium ≥5 orders|≥€1000, stammkunde ≥2|≥€300)');
  L(`  Premium                       ${tierCounts.premium}`);
  L(`  Stammkunde                    ${tierCounts.stammkunde}`);
  L(`  Neukunde                      ${tierCounts.neukunde}`);
  L('');
  L('MERGE LIST — multi-invoice customers (⚠ = merged across spelling variants)');
  for (const m of merges) {
    const flag = m.variants.length > 1 ? '⚠ ' : '  ';
    L(`  ${flag}${m.canonicalName}  —  ${m.address || 'n/a'}`);
    L(`      ${m.invoices.length} invoices · ${eur(m.totalCents)} · ${m.invoices.join(', ')}`);
    if (m.variants.length > 1) L(`      variants: ${m.variants.join('  |  ')}`);
  }
  L('');
  L('VERIFIED-EMAIL CUSTOMERS (real address used — confirm these matches)');
  const verified = customers.filter((c) => !c.emailIsPlaceholder);
  if (verified.length === 0) L('  (none)');
  for (const c of verified) {
    L(`  ${c.name}  <${c.email}>  · ${c.totalOrders} inv · ${eur(c.totalSpentCents)} · ${c.tier}`);
  }
  L('\n── end of dry run — no database writes performed ──\n');
}

async function main(): Promise<void> {
  const [jsonPath, csvPath, ...flags] = process.argv.slice(2);
  if (!jsonPath || !csvPath) {
    console.error(
      'Usage: import-cleanilo-history.ts <invoices.json> <reconciliation.csv> [--commit]',
    );
    process.exit(1);
  }
  const plan = makePlan(jsonPath, csvPath);
  printReport(plan);

  if (!flags.includes('--commit')) {
    console.log('DRY RUN only. Re-run with --commit to write to the cleanilo tenant.\n');
    return;
  }

  console.log('--commit set — writing to the cleanilo tenant …');
  const { commitImport } = await import('./import-cleanilo-commit.ts');
  const result = await commitImport(plan);
  console.log(
    `\nImport complete: ${result.customersWritten} customers, ${result.ordersWritten} orders, ${result.invoicesWritten} invoices.\n`,
  );
  process.exit(0);
}

void main();
