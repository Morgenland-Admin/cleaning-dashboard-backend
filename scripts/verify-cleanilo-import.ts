/**
 * Read-only audit of the CLEANILO historical import (no writes).
 *
 *   DOTENV_CONFIG_PATH=.env.prod node --import tsx scripts/verify-cleanilo-import.ts
 *
 * Checks the state the import is supposed to leave behind:
 *  - row counts (customers / orders / invoices) split imported vs. pre-existing
 *  - revenue reconciliation against the source total
 *  - automation-safety invariants (no dunning-eligible invoice, no open order,
 *    no marketing opt-in, no live invoice-number sequence burned)
 *  - the 7 renumbered collisions and the 10 verified emails
 *  - customer_id linkage on orders and invoices
 */
import { sql } from 'drizzle-orm';

import { db } from '../src/db/index.ts';

const IMPORT_SOURCE = 'import_cleanilo_2021_26';
const IMPORT_TAG = 'import-2021-26';

function eur(cents: number): string {
  return (cents / 100).toLocaleString('de-DE', { minimumFractionDigits: 2 }) + ' €';
}

async function q<T = Record<string, unknown>>(text: string): Promise<T[]> {
  const res = await db.execute(sql.raw(text));
  return (Array.isArray(res) ? res : (res as { rows: T[] }).rows) as T[];
}

async function main(): Promise<void> {
  const [companyRow] = await q<{ slug: string; schema_name: string }>(
    `select slug, schema_name from company where slug = 'cleanilo' limit 1`,
  );
  if (!companyRow) throw new Error('cleanilo company row not found');
  const s = companyRow.schema_name;
  const L = console.log;
  L(`\nCLEANILO import audit — schema "${s}"\n`);

  const rows = async (t: string, where = 'true') =>
    Number((await q<{ n: string }>(`select count(*) n from "${s}"."${t}" where ${where}`))[0]!.n);

  const custTotal = await rows('customers');
  const custImported = await rows('customers', `tags @> '["${IMPORT_TAG}"]'::jsonb`);
  const ordTotal = await rows('orders');
  const ordImported = await rows('orders', `source = '${IMPORT_SOURCE}'`);
  const invTotal = await rows('invoices');
  const invImported = await rows('invoices', `notes like 'Historischer Import%'`);

  L('COUNTS                       total   imported   pre-existing');
  L(`  customers                  ${custTotal}\t${custImported}\t${custTotal - custImported}`);
  L(`  orders                     ${ordTotal}\t${ordImported}\t${ordTotal - ordImported}`);
  L(`  invoices                   ${invTotal}\t${invImported}\t${invTotal - invImported}`);

  const [rev] = await q<{ total: string | null }>(
    `select sum(total_cents) total from "${s}".invoices where notes like 'Historischer Import%'`,
  );
  const importedRev = Number(rev?.total ?? 0);
  L(`\nREVENUE`);
  L(`  imported invoice volume    ${eur(importedRev)}`);
  L(`  + skipped empty row        ${eur(40001)}`);
  L(`  = source reconciliation    ${eur(importedRev + 40001)}   (expected 279.039,14 €)`);

  L(`\nAUTOMATION SAFETY (all must be 0)`);
  const dunnable = await rows(
    'invoices',
    `notes like 'Historischer Import%' and status in ('sent','overdue')`,
  );
  const dunned = await rows('invoices', `notes like 'Historischer Import%' and dunning_level <> 0`);
  const notPaid = await rows('invoices', `notes like 'Historischer Import%' and status <> 'paid'`);
  const openOrders = await rows('orders', `source = '${IMPORT_SOURCE}' and status <> 'completed'`);
  const optedIn = await rows(
    'customers',
    `tags @> '["${IMPORT_TAG}"]'::jsonb and marketing_opt_in`,
  );
  const orderMktg = await rows('orders', `source = '${IMPORT_SOURCE}' and consent_marketing`);
  L(`  invoices sent/overdue      ${dunnable}`);
  L(`  invoices dunning_level>0   ${dunned}`);
  L(`  invoices not 'paid'        ${notPaid}`);
  L(`  orders not 'completed'     ${openOrders}`);
  L(`  customers marketing opt-in ${optedIn}`);
  L(`  orders consent_marketing   ${orderMktg}`);

  L(`\nDATA RULES`);
  const b2b = await rows(
    'customers',
    `tags @> '["b2b"]'::jsonb and tags @> '["${IMPORT_TAG}"]'::jsonb`,
  );
  const placeholder = await rows('customers', `email like '%@import.cleanilo.local'`);
  const verified = custImported - placeholder;
  // 57 at import time; 6 rejected 08/2026 when B2B stopped being ORed across
  // contradicting CRM candidates (Kabir's call — see fix-cleanilo-b2b.ts).
  L(`  b2b tagged                 ${b2b}   (expected 51)`);
  L(`  placeholder emails         ${placeholder}`);
  // 9, not 10: one CRM name match had several equally-rated candidates and no
  // way to corroborate by address or invoice, so it keeps a placeholder.
  L(`  verified real emails       ${verified}   (expected 9)`);

  const renum = await q<{ number: string; recipient_name: string; total_cents: number }>(
    `select number, recipient_name, total_cents from "${s}".invoices where number like '%-1' order by number`,
  );
  L(`  renumbered collisions      ${renum.length}   (expected 7)`);
  for (const r of renum) L(`    ${r.number}  ${r.recipient_name}  ${eur(Number(r.total_cents))}`);

  const [dup] = await q<{ n: string }>(
    `select count(*) n from (select number from "${s}".invoices group by number having count(*) > 1) d`,
  );
  L(`  duplicate invoice numbers  ${dup!.n}   (expected 0)`);

  const emptyRow = await rows('invoices', `number in ('2023/1224')`);
  L(`  empty row 2023/1224 absent ${emptyRow === 0 ? 'yes' : `NO — ${emptyRow} row(s)`}`);

  const noServiceDate = await rows('invoices', `notes like '%Datum im Original fehlend%'`);
  L(`  est.-date invoices noted   ${noServiceDate}   (expected 4)`);

  L(`\nLINKAGE`);
  const ordNoCust = await rows('orders', `source = '${IMPORT_SOURCE}' and customer_id is null`);
  const invNoCust = await rows(
    'invoices',
    `notes like 'Historischer Import%' and customer_id is null`,
  );
  const invNoOrder = await rows(
    'invoices',
    `notes like 'Historischer Import%' and order_id is null`,
  );
  const [items] = await q<{ n: string }>(
    `select count(*) n from "${s}".order_items oi join "${s}".orders o on o.id = oi.order_id where o.source = '${IMPORT_SOURCE}'`,
  );
  L(`  orders w/o customer_id     ${ordNoCust}   (expected 0)`);
  L(`  invoices w/o customer_id   ${invNoCust}   (expected 0)`);
  L(`  invoices w/o order_id      ${invNoOrder}   (expected 0)`);
  L(`  order_items on imports     ${items!.n}   (expected = imported orders)`);

  const [seq] = await q<{
    invoice_number_next: number | null;
    invoice_number_prefix: string | null;
  }>(`select invoice_number_next, invoice_number_prefix from company where slug = 'cleanilo'`);
  L(`\nLIVE NUMBER SEQUENCE (must be untouched by the import)`);
  L(
    `  prefix / next              ${seq?.invoice_number_prefix ?? '—'} / ${seq?.invoice_number_next ?? '—'}`,
  );

  const tiers = await q<{ loyalty_tier: string; n: string }>(
    `select loyalty_tier, count(*) n from "${s}".customers where tags @> '["${IMPORT_TAG}"]'::jsonb group by loyalty_tier order by 1`,
  );
  L(`\nTIER ROLLUP (imported customers)`);
  for (const t of tiers) L(`  ${t.loyalty_tier.padEnd(26)} ${t.n}`);

  const years = await q<{ y: string; n: string; total: string }>(
    `select substring(number from 1 for 4) y, count(*) n, sum(total_cents) total
       from "${s}".invoices where notes like 'Historischer Import%' group by 1 order by 1`,
  );
  L(`\nBY YEAR`);
  for (const y of years)
    L(`  ${y.y}  ${String(y.n).padStart(3)} invoices  ${eur(Number(y.total))}`);

  L('');
  process.exit(0);
}

void main();
