/**
 * Row-by-row reconciliation of the CLEANILO import plan against what is
 * actually in the tenant. Read-only.
 *
 *   DOTENV_CONFIG_PATH=.env.prod node --import tsx scripts/audit-cleanilo-import.ts <invoices.json> <reconciliation.csv>
 *
 * Fails loudly on: a planned invoice missing from the DB, an amount/recipient
 * mismatch, a planned customer missing, or an imported row in the DB that the
 * plan does not account for.
 */
import { sql } from 'drizzle-orm';

import { db } from '../src/db/index.ts';
import { eur, makePlan } from './import-cleanilo-lib.ts';

async function q<T = Record<string, unknown>>(text: string): Promise<T[]> {
  const res = await db.execute(sql.raw(text));
  return (Array.isArray(res) ? res : (res as { rows: T[] }).rows) as T[];
}

const key = (number: string, cents: number, name: string) => `${number}|${cents}|${name}`;

async function main(): Promise<void> {
  const [jsonPath, csvPath] = process.argv.slice(2);
  if (!jsonPath || !csvPath) {
    console.error('Usage: audit-cleanilo-import.ts <invoices.json> <reconciliation.csv>');
    process.exit(1);
  }
  const plan = makePlan(jsonPath, csvPath);
  const [companyRow] = await q<{ schema_name: string }>(
    `select schema_name from company where slug = 'cleanilo' limit 1`,
  );
  const s = companyRow!.schema_name;

  const dbInvoices = await q<{
    number: string;
    total_cents: number;
    recipient_name: string;
    service_date: string | null;
    status: string;
    notes: string | null;
  }>(
    `select number, total_cents, recipient_name, service_date, status, notes
       from "${s}".invoices where notes like 'Historischer Import%'`,
  );
  const dbByKey = new Map(
    dbInvoices.map((r) => [key(r.number, Number(r.total_cents), r.recipient_name), r]),
  );

  const L = console.log;
  L(`\nROW-BY-ROW RECONCILIATION — plan vs. schema "${s}"\n`);
  L(`  planned invoices           ${plan.invoices.length}`);
  L(`  imported rows in DB        ${dbInvoices.length}`);

  const missing = plan.invoices.filter(
    (i) => !dbByKey.has(key(i.invoiceNumber, i.grossCents, i.name)),
  );
  const planKeys = new Set(plan.invoices.map((i) => key(i.invoiceNumber, i.grossCents, i.name)));
  const extra = dbInvoices.filter(
    (r) => !planKeys.has(key(r.number, Number(r.total_cents), r.recipient_name)),
  );
  L(`  planned but NOT in DB      ${missing.length}`);
  for (const m of missing) L(`    ✗ ${m.invoiceNumber}  ${m.name}  ${eur(m.grossCents)}`);
  L(`  in DB but NOT in plan      ${extra.length}`);
  for (const e of extra) L(`    ✗ ${e.number}  ${e.recipient_name}  ${eur(Number(e.total_cents))}`);

  // Skipped rows must be absent.
  const skippedPresent = plan.skipped.filter((sk) =>
    dbInvoices.some((r) => r.number === sk.invoiceNumber),
  );
  L(`  skipped rows wrongly in DB ${skippedPresent.length}   (must be 0)`);

  // Original numbers of renumbered invoices must be recorded in notes.
  let noteOk = 0;
  for (const r of plan.renumbered) {
    const row = dbInvoices.find((d) => d.number === r.to);
    if (row?.notes?.includes(r.from)) noteOk += 1;
    else L(`    ✗ ${r.to} note missing original ${r.from}`);
  }
  L(`  renumbered w/ original-Nr  ${noteOk}/${plan.renumbered.length}`);

  // Estimated-date invoices must have no service_date (no false Leistungsdatum).
  const est = plan.invoices.filter((i) => i.dateEstimated);
  const estBad = est.filter(
    (i) => dbByKey.get(key(i.invoiceNumber, i.grossCents, i.name))?.service_date !== null,
  );
  L(`  est.-date w/o serviceDate  ${est.length - estBad.length}/${est.length}`);

  // Customers: every planned email present, and every planned total matches.
  const dbCustomers = await q<{
    email: string;
    name: string;
    total_orders: number;
    total_spent_cents: number;
    loyalty_tier: string;
  }>(
    `select email, name, total_orders, total_spent_cents, loyalty_tier
       from "${s}".customers where tags @> '["import-2021-26"]'::jsonb`,
  );
  const dbCustByEmail = new Map(dbCustomers.map((c) => [c.email.toLowerCase(), c]));
  const missingCust = plan.customers.filter((c) => !dbCustByEmail.has(c.email.toLowerCase()));
  const mismatch = plan.customers.filter((c) => {
    const row = dbCustByEmail.get(c.email.toLowerCase());
    return (
      row &&
      (Number(row.total_spent_cents) !== c.totalSpentCents ||
        Number(row.total_orders) !== c.totalOrders ||
        row.loyalty_tier !== c.tier)
    );
  });
  L(`\n  planned customers          ${plan.customers.length}`);
  L(`  imported customers in DB   ${dbCustomers.length}`);
  L(`  planned but NOT in DB      ${missingCust.length}`);
  for (const m of missingCust) L(`    ✗ ${m.name}  <${m.email}>`);
  L(`  totals/tier mismatches     ${mismatch.length}`);
  for (const m of mismatch) {
    const row = dbCustByEmail.get(m.email.toLowerCase())!;
    L(
      `    ✗ ${m.name}: plan ${m.totalOrders}/${eur(m.totalSpentCents)}/${m.tier} vs db ${row.total_orders}/${eur(Number(row.total_spent_cents))}/${row.loyalty_tier}`,
    );
  }

  // Merge groups: each merged customer must hold all of its invoices.
  let mergeOk = 0;
  for (const m of plan.merges) {
    // Merge records carry no customer key — match on the invoice-number set.
    const wanted = [...m.invoices].sort().join(',');
    const cust = plan.customers.find(
      (c) =>
        c.sourceInvoices
          .map((i) => i.invoiceNumber)
          .sort()
          .join(',') === wanted,
    );
    const row = cust ? dbCustByEmail.get(cust.email.toLowerCase()) : undefined;
    if (row && Number(row.total_orders) === m.invoices.length) mergeOk += 1;
    else
      L(
        `    ✗ merge ${m.canonicalName}: expected ${m.invoices.length} orders, db has ${row?.total_orders ?? 'n/a'}`,
      );
  }
  L(`  merge groups intact        ${mergeOk}/${plan.merges.length}`);

  const failures =
    missing.length +
    extra.length +
    skippedPresent.length +
    missingCust.length +
    mismatch.length +
    estBad.length +
    (plan.renumbered.length - noteOk) +
    (plan.merges.length - mergeOk);
  L(
    `\n  RESULT: ${failures === 0 ? 'PASS — plan and DB agree on every row' : `${failures} FAILURE(S)`}\n`,
  );
  process.exit(failures === 0 ? 0 : 1);
}

void main();
