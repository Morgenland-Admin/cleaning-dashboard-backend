/**
 * Correction for the CLEANILO historical import: replace a real CRM email that
 * was accepted on an ambiguous name-only match with the standard import
 * placeholder.
 *
 * Background: the reconciliation offered several equally-rated `name_exact` +
 * SICHER candidates for one invoice (a bare surname matches many people) and the
 * importer's Map-overwrite silently kept the last one. The agreed rule is that a
 * name alone never verifies an address — that invoice must carry a placeholder.
 * `applyMatches` now rejects ambiguous candidates (see `fix-cleanilo-b2b.ts`
 * for the same treatment of contradicting B2B segments); this script repairs the row
 * that already landed.
 *
 *   Dry run:  DOTENV_CONFIG_PATH=.env.prod node --import tsx scripts/fix-cleanilo-ambiguous-email.ts
 *   Apply:    … scripts/fix-cleanilo-ambiguous-email.ts --commit
 *
 * Writes go straight to the tenant tables (no API, no webhook) so no
 * notification, dunning or automation can fire. Idempotent: a customer already
 * on a placeholder is left untouched.
 */
import { and, eq, sql } from 'drizzle-orm';

import { db } from '../src/db/index.ts';
import { company } from '../src/db/schema/shared.ts';
import { getTenantTables } from '../src/db/schema/tenant.ts';
import { makePlan, placeholderEmail } from './import-cleanilo-lib.ts';

const NOTE = 'E-Mail-Zuordnung verworfen (mehrdeutiger Namenstreffer) — Platzhalter gesetzt';

async function main(): Promise<void> {
  const [jsonPath, csvPath, ...flags] = process.argv.slice(2);
  if (!jsonPath || !csvPath) {
    console.error(
      'Usage: fix-cleanilo-ambiguous-email.ts <invoices.json> <reconciliation.csv> [--commit]',
    );
    process.exit(1);
  }
  const commit = flags.includes('--commit');
  const plan = makePlan(jsonPath, csvPath);
  if (plan.ambiguousMatches.length === 0) {
    console.log('No ambiguous CRM matches in the current plan — nothing to correct.');
    process.exit(0);
  }

  const [companyRow] = await db.select().from(company).where(eq(company.slug, 'cleanilo')).limit(1);
  if (!companyRow) throw new Error('cleanilo company row not found');
  const t = getTenantTables(companyRow.schemaName);
  const L = console.log;
  L(
    `\n${commit ? 'APPLYING' : 'DRY RUN —'} ambiguous-match email correction (schema "${companyRow.schemaName}")\n`,
  );

  for (const amb of plan.ambiguousMatches) {
    // The plan is now placeholder-based for this invoice; take the exact
    // placeholder the importer would have written so the row matches a re-run.
    const invoice = plan.invoices.find((i) => i.invoiceNumber === amb.invoiceNumber);
    if (!invoice) {
      L(`  ${amb.invoiceNumber}: not in the import plan (skipped row?) — nothing to do`);
      continue;
    }
    const target = placeholderEmail(invoice);

    const [dbInvoice] = await db
      .select({
        id: t.invoices.id,
        orderId: t.invoices.orderId,
        customerId: t.invoices.customerId,
        recipientEmail: t.invoices.recipientEmail,
        notes: t.invoices.notes,
      })
      .from(t.invoices)
      .where(eq(t.invoices.number, amb.invoiceNumber))
      .limit(1);
    if (!dbInvoice) {
      L(`  ${amb.invoiceNumber}: no such invoice in the tenant — nothing to do`);
      continue;
    }
    const customerId = dbInvoice.customerId;
    if (customerId == null) {
      L(`  ${amb.invoiceNumber}: invoice has no customer link — skipped`);
      continue;
    }

    const [cust] = await db
      .select({ id: t.customers.id, email: t.customers.email, tags: t.customers.tags })
      .from(t.customers)
      .where(eq(t.customers.id, customerId))
      .limit(1);
    if (!cust) {
      L(`  ${amb.invoiceNumber}: customer #${customerId} missing — skipped`);
      continue;
    }
    if (cust.email.endsWith('@import.cleanilo.local')) {
      L(`  ${amb.invoiceNumber}: customer already on a placeholder — nothing to do`);
      continue;
    }
    if (!cust.tags?.includes('import-2021-26')) {
      L(
        `  ${amb.invoiceNumber}: customer #${customerId} is not an imported row — refusing to touch`,
      );
      continue;
    }

    // The placeholder must be free (customers.email is UNIQUE).
    const clash = await db
      .select({ id: t.customers.id })
      .from(t.customers)
      .where(and(eq(t.customers.email, target), sql`${t.customers.id} <> ${customerId}`))
      .limit(1);
    if (clash.length > 0) {
      L(`  ${amb.invoiceNumber}: placeholder already used by customer #${clash[0]!.id} — aborting`);
      process.exitCode = 1;
      continue;
    }

    const ordersToFix = await db
      .select({ id: t.orders.id })
      .from(t.orders)
      .where(eq(t.orders.customerId, customerId));

    L(`  invoice ${amb.invoiceNumber} / customer #${customerId}`);
    L(
      `    rejected candidates        ${amb.candidates.length} (none can be verified by address or invoice)`,
    );
    L(`    customer email             real address → ${target}`);
    L(`    invoice recipient email    ${dbInvoice.recipientEmail ? 'set → null' : 'already null'}`);
    L(`    order customer emails      ${ordersToFix.length} row(s) → ${target}`);

    if (!commit) continue;

    await db.transaction(async (tx) => {
      await tx
        .update(t.customers)
        .set({ email: target, marketingOptIn: false, updatedAt: new Date() })
        .where(eq(t.customers.id, customerId));
      for (const o of ordersToFix) {
        await tx
          .update(t.orders)
          .set({ customerEmail: target, updatedAt: new Date() })
          .where(eq(t.orders.id, o.id));
      }
      const notes = dbInvoice.notes?.includes(NOTE)
        ? dbInvoice.notes
        : [dbInvoice.notes, NOTE].filter(Boolean).join(' · ');
      await tx
        .update(t.invoices)
        .set({ recipientEmail: null, notes, updatedAt: new Date() })
        .where(eq(t.invoices.id, dbInvoice.id));
    });
    L(`    → corrected`);
  }

  L(
    commit
      ? '\nDone. Re-run the audit scripts to confirm.\n'
      : '\nDRY RUN only. Re-run with --commit to apply.\n',
  );
  process.exit(process.exitCode ?? 0);
}

void main();
