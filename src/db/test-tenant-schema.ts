import { sql } from 'drizzle-orm';

import { db } from './index.js';
import { createTenantSchemaSql } from './schema/tenant.js';

/** Test setup: tenant DDL under the migration lock, so parallel test files don't race on CREATE. */
export async function ensureTenantSchemaForTests(slug: string): Promise<void> {
  await db.transaction(async (tx) => {
    await tx.execute(sql`SELECT pg_advisory_xact_lock(7421001)`);
    await tx.execute(sql.raw(createTenantSchemaSql(slug)));
  });
}
