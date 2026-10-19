/**
 * Drops the `b2b` tag / resets `customer_type` to 'b2c' where B2B rests only on contradicting CRM candidates; never promotes.
 * Direct tenant writes (no API/webhook, so no automation fires); idempotent.
 * DOTENV_CONFIG_PATH=.env.prod node --import tsx scripts/fix-cleanilo-b2b.ts <invoices.json> <reconciliation.csv> [--commit]
 */
import { eq, inArray } from 'drizzle-orm';

import { db } from '../src/db/index.ts';
import { company } from '../src/db/schema/shared.ts';
import { getTenantTables } from '../src/db/schema/tenant.ts';
import { makePlan } from './import-cleanilo-lib.ts';

const IMPORT_TAG = 'import-2021-26';
const B2B_TAG = 'b2b';

async function main(): Promise<void> {
  const [jsonPath, csvPath, ...flags] = process.argv.slice(2);
  if (!jsonPath || !csvPath) {
    console.error('Usage: fix-cleanilo-b2b.ts <invoices.json> <reconciliation.csv> [--commit]');
    process.exit(1);
  }
  const commit = flags.includes('--commit');
  const plan = makePlan(jsonPath, csvPath);

  const [companyRow] = await db.select().from(company).where(eq(company.slug, 'cleanilo')).limit(1);
  if (!companyRow) throw new Error('cleanilo company row not found');
  const t = getTenantTables(companyRow.schemaName);
  const L = console.log;
  L(
    `\n${commit ? 'APPLYING' : 'DRY RUN —'} B2B-flag correction (schema "${companyRow.schemaName}")`,
  );
  L(
    `Plan says ${plan.customers.filter((c) => c.isB2B).length} B2B customers; ` +
      `${plan.disputedB2B.length} disputed segment(s) rejected.\n`,
  );

  const planByEmail = new Map(plan.customers.map((c) => [c.email.toLowerCase(), c]));
  const dbCustomers = await db
    .select({
      id: t.customers.id,
      email: t.customers.email,
      name: t.customers.name,
      tags: t.customers.tags,
    })
    .from(t.customers)
    .where(inArray(t.customers.email, [...planByEmail.keys()]));

  const customerFixes: Array<{ id: number; name: string | null; tags: string[] }> = [];
  let promotionsSkipped = 0;
  for (const row of dbCustomers) {
    const planned = planByEmail.get(row.email.toLowerCase());
    if (!planned) continue;
    const tags = row.tags ?? [];
    if (!tags.includes(IMPORT_TAG)) {
      L(`  ! customer #${row.id} is not tagged "${IMPORT_TAG}" — refusing to touch`);
      continue;
    }
    const hasTag = tags.includes(B2B_TAG);
    if (planned.isB2B && !hasTag) {
      L(`  ! customer #${row.id} would be PROMOTED to b2b — skipped (this script only removes)`);
      promotionsSkipped += 1;
      continue;
    }
    if (!planned.isB2B && hasTag) {
      customerFixes.push({ id: row.id, name: row.name, tags: tags.filter((x) => x !== B2B_TAG) });
    }
  }

  const importCustomerIds = new Set(
    dbCustomers.filter((c) => (c.tags ?? []).includes(IMPORT_TAG)).map((c) => c.id),
  );
  const planInvoices = new Map(plan.invoices.map((i) => [i.invoiceNumber, i]));
  const dbInvoices = await db
    .select({
      id: t.invoices.id,
      number: t.invoices.number,
      customerId: t.invoices.customerId,
      customerType: t.invoices.customerType,
      recipientName: t.invoices.recipientName,
      status: t.invoices.status,
    })
    .from(t.invoices)
    .where(inArray(t.invoices.number, [...planInvoices.keys()]));

  const invoiceFixes: Array<{ id: number; number: string; recipientName: string; status: string }> =
    [];
  for (const row of dbInvoices) {
    const planned = row.number == null ? undefined : planInvoices.get(row.number);
    if (!planned) continue;
    if (row.customerId == null || !importCustomerIds.has(row.customerId)) {
      L(`  ! invoice ${row.number} is not linked to an imported customer — refusing to touch`);
      continue;
    }
    const want = planned.isB2B ? 'b2b' : 'b2c';
    if (want === 'b2b' && row.customerType !== 'b2b') {
      L(`  ! invoice ${row.number} would be PROMOTED to b2b — skipped (this script only removes)`);
      promotionsSkipped += 1;
      continue;
    }
    if (want === 'b2c' && row.customerType === 'b2b') {
      invoiceFixes.push({
        id: row.id,
        number: planned.invoiceNumber,
        recipientName: row.recipientName,
        status: row.status,
      });
    }
  }

  if (customerFixes.length === 0 && invoiceFixes.length === 0) {
    L('Nothing to correct — customers and invoices already match the plan.');
    L(promotionsSkipped > 0 ? `(${promotionsSkipped} promotion(s) skipped, see above.)\n` : '\n');
    process.exit(0);
  }

  L(`Customers losing the "${B2B_TAG}" tag: ${customerFixes.length}`);
  for (const c of customerFixes) L(`    #${c.id}  ${c.name ?? '(kein Name)'}`);
  L(`\nInvoices moving customer_type b2b → b2c: ${invoiceFixes.length}`);
  for (const i of invoiceFixes) L(`    ${i.number}  ${i.recipientName}  [${i.status}]`);
  if (promotionsSkipped > 0) L(`\nPromotions skipped: ${promotionsSkipped}`);

  if (!commit) {
    L('\nDRY RUN only. Re-run with --commit to apply.\n');
    process.exit(0);
  }

  await db.transaction(async (tx) => {
    for (const c of customerFixes) {
      await tx
        .update(t.customers)
        .set({ tags: c.tags, updatedAt: new Date() })
        .where(eq(t.customers.id, c.id));
    }
    for (const i of invoiceFixes) {
      await tx
        .update(t.invoices)
        .set({ customerType: 'b2c', updatedAt: new Date() })
        .where(eq(t.invoices.id, i.id));
    }
  });
  L(`\n→ corrected ${customerFixes.length} customer(s) and ${invoiceFixes.length} invoice(s).`);
  L('Done. Re-run the audit scripts to confirm.\n');
  process.exit(0);
}

void main();
