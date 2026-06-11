import { sql } from 'drizzle-orm';

import { type db } from '../db/index.js';
import type { TenantTables } from '../db/schema/tenant.js';

/** db or an open transaction — both expose select/insert with the same shape. */
type Executor = Pick<typeof db, 'select' | 'insert'>;

/**
 * Upsert a customer by email (case-insensitive) and return its id. Never
 * overwrites an existing row — name/phone are only used when creating. Used by
 * the storefront create paths (orders, inquiries, contacts, newsletter) to keep
 * `customer_id` populated going forward; the boot-time backfill handles history.
 */
export async function linkCustomerByEmail(
  exec: Executor,
  customers: TenantTables['customers'],
  input: { email: string; name?: string | null; phone?: string | null; marketingOptIn?: boolean },
): Promise<number | null> {
  const email = input.email?.trim().toLowerCase();
  if (!email) return null;

  const existing = await exec
    .select({ id: customers.id })
    .from(customers)
    .where(sql`lower(${customers.email}) = ${email}`)
    .limit(1);
  if (existing[0]) return existing[0].id;

  const inserted = await exec
    .insert(customers)
    .values({
      email,
      name: input.name ?? null,
      phone: input.phone ?? null,
      marketingOptIn: input.marketingOptIn ?? false,
    })
    .onConflictDoNothing({ target: customers.email })
    .returning({ id: customers.id });
  if (inserted[0]) return inserted[0].id;

  // Lost a race against a concurrent insert — the row exists now; fetch it.
  const again = await exec
    .select({ id: customers.id })
    .from(customers)
    .where(sql`lower(${customers.email}) = ${email}`)
    .limit(1);
  return again[0]?.id ?? null;
}
