import { eq, sql } from 'drizzle-orm';

import type { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';

/** The transaction handle passed to db.transaction(async (tx) => …). */
type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const DEFAULT_PREFIX = 'INV';
const DEFAULT_START = 1;

/**
 * Reserve the next per-brand invoice number "<prefix>-<n>" (e.g. "CL-1426").
 * One atomic UPDATE … RETURNING on the shared `company` row keeps the series
 * gapless per brand. Assigned at issue time only (GoBD); must run inside the
 * issue transaction.
 */
export async function nextInvoiceNumber(tx: Tx, companySlug: string): Promise<string> {
  const [row] = await tx
    .update(company)
    .set({
      invoiceNumberNext: sql`coalesce(${company.invoiceNumberNext}, ${DEFAULT_START}) + 1`,
    })
    .where(eq(company.slug, companySlug))
    .returning({
      prefix: company.invoiceNumberPrefix,
      next: company.invoiceNumberNext,
    });
  if (!row) throw new Error(`Cannot assign invoice number: company "${companySlug}" not found`);
  // RETURNING yields the post-increment value; the number we assign is one less.
  const assigned = (row.next ?? DEFAULT_START + 1) - 1;
  const prefix = row.prefix ?? DEFAULT_PREFIX;
  return `${prefix}-${assigned}`;
}
