import { eq, sql } from 'drizzle-orm';

import type { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];

const DEFAULT_PREFIX = 'INV';
const DEFAULT_START = 1;

/**
 * Next per-brand invoice number "<prefix>-<n>" via one atomic UPDATE … RETURNING on `company` (gapless).
 * Issue time only (GoBD), inside the issue transaction.
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
  // RETURNING is the post-increment value; the assigned number is one less.
  const assigned = (row.next ?? DEFAULT_START + 1) - 1;
  const prefix = row.prefix ?? DEFAULT_PREFIX;
  return `${prefix}-${assigned}`;
}
