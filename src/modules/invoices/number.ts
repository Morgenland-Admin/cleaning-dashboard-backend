import { sql } from 'drizzle-orm';

import type { db } from '../../db/index.js';
import type { TenantTables } from '../../db/schema/tenant.js';

/** The transaction handle passed to db.transaction(async (tx) => …). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

/**
 * Reserve the next gapless per-year invoice number (atomic upsert-returning on
 * the counter row). Assigned at issue time only, so abandoned drafts don't burn
 * a number (GoBD). Must run inside the issue transaction.
 */
export async function nextInvoiceNumber(tx: Tx, tables: TenantTables, now: Date): Promise<string> {
  const year = now.getUTCFullYear();
  const [row] = await tx
    .insert(tables.invoiceCounters)
    .values({ year, nextValue: 1 })
    .onConflictDoUpdate({
      target: tables.invoiceCounters.year,
      set: { nextValue: sql`${tables.invoiceCounters.nextValue} + 1` },
    })
    .returning({ nextValue: tables.invoiceCounters.nextValue });
  const seq = row!.nextValue;
  return `INV-${year}-${String(seq).padStart(6, '0')}`;
}
