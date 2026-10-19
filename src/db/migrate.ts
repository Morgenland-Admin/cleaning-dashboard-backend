/**
 * Runs before `node dist/server.js` and is safe to rerun on every start: creates the legacy tenant
 * schemas (migration 0000 references them), applies drizzle migrations, upserts the legacy company rows.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import pg from 'pg';

import { env } from '../config/env.js';
import { LEGACY_BOOTSTRAP } from './bootstrap-companies.js';
import { company } from './schema/shared.js';
import { createTenantSchemaSql } from './schema/tenant.js';

const { Pool } = pg;

const MIGRATION_LOCK_KEY = 7_421_001;

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const db = drizzle(pool);

  // Serializes replicas; the lock is session-level, so unlock must use the same client.
  console.log('[migrate] acquiring advisory lock…');
  const lockClient = await pool.connect();
  await lockClient.query(`SELECT pg_advisory_lock(${MIGRATION_LOCK_KEY})`);

  console.log('[migrate] ensuring tenant schemas…');
  for (const cfg of Object.values(LEGACY_BOOTSTRAP)) {
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${cfg.schemaName}"`));
  }

  console.log('[migrate] applying drizzle migrations…');
  await migrate(db, { migrationsFolder: './drizzle' });

  console.log('[migrate] ensuring tenant tables (orders + chat)…');
  for (const cfg of Object.values(LEGACY_BOOTSTRAP)) {
    await db.execute(sql.raw(createTenantSchemaSql(cfg.schemaName)));
  }

  console.log('[migrate] upserting legacy company rows…');
  for (const cfg of Object.values(LEGACY_BOOTSTRAP)) {
    const updateSet: Record<string, unknown> = {
      senderEmail: cfg.senderEmail,
      senderName: cfg.senderName,
      email: cfg.senderEmail,
      updatedAt: new Date(),
    };
    if (cfg.resendApiKey) updateSet.resendApiKey = cfg.resendApiKey;
    if (cfg.resendWebhookSecret) updateSet.resendWebhookSecret = cfg.resendWebhookSecret;
    // Coalesced fields only seed blanks, so admin edits (uploads, live counter) win.
    if (cfg.logoUrl) updateSet.logoUrl = sql`coalesce(${company.logoUrl}, ${cfg.logoUrl})`;
    if (cfg.invoiceLogoUrl)
      updateSet.invoiceLogoUrl = sql`coalesce(${company.invoiceLogoUrl}, ${cfg.invoiceLogoUrl})`;
    if (cfg.phone) updateSet.phone = sql`coalesce(${company.phone}, ${cfg.phone})`;
    if (cfg.mobile) updateSet.mobile = sql`coalesce(${company.mobile}, ${cfg.mobile})`;
    if (cfg.primaryColor)
      updateSet.primaryColor = sql`coalesce(${company.primaryColor}, ${cfg.primaryColor})`;
    if (cfg.invoiceNumberPrefix)
      updateSet.invoiceNumberPrefix = sql`coalesce(${company.invoiceNumberPrefix}, ${cfg.invoiceNumberPrefix})`;
    if (cfg.invoiceNumberStart != null)
      updateSet.invoiceNumberNext = sql`coalesce(${company.invoiceNumberNext}, ${cfg.invoiceNumberStart})`;
    // Seed-owned: overwritten on every boot.
    if (cfg.emailSignature) updateSet.emailSignature = cfg.emailSignature;
    if (cfg.legal) {
      const l = cfg.legal;
      updateSet.legalName = sql`coalesce(${company.legalName}, ${l.legalName})`;
      updateSet.addressLine1 = sql`coalesce(${company.addressLine1}, ${l.addressLine1})`;
      updateSet.postalCode = sql`coalesce(${company.postalCode}, ${l.postalCode})`;
      updateSet.city = sql`coalesce(${company.city}, ${l.city})`;
      updateSet.country = sql`coalesce(${company.country}, ${l.country})`;
      updateSet.accountHolder = sql`coalesce(${company.accountHolder}, ${l.accountHolder})`;
      updateSet.iban = sql`coalesce(${company.iban}, ${l.iban})`;
      updateSet.bic = sql`coalesce(${company.bic}, ${l.bic})`;
      updateSet.bankName = sql`coalesce(${company.bankName}, ${l.bankName})`;
      updateSet.bankAddress = sql`coalesce(${company.bankAddress}, ${l.bankAddress})`;
      if (l.vatId) updateSet.vatId = sql`coalesce(${company.vatId}, ${l.vatId})`;
      if (l.businessId)
        updateSet.businessId = sql`coalesce(${company.businessId}, ${l.businessId})`;
      if (l.legalForm) updateSet.legalForm = sql`coalesce(${company.legalForm}, ${l.legalForm})`;
      if (l.managingDirectors)
        updateSet.managingDirectors = sql`coalesce(${company.managingDirectors}, ${l.managingDirectors})`;
      if (l.chamber) updateSet.chamber = sql`coalesce(${company.chamber}, ${l.chamber})`;
    }

    await db
      .insert(company)
      .values({
        slug: cfg.slug,
        name: cfg.name,
        schemaName: cfg.schemaName,
        keyPrefix: cfg.keyPrefix,
        storefrontOrigin: cfg.storefrontOrigin,
        senderEmail: cfg.senderEmail,
        senderName: cfg.senderName,
        resendApiKey: cfg.resendApiKey,
        resendWebhookSecret: cfg.resendWebhookSecret,
        logoUrl: cfg.logoUrl,
        invoiceLogoUrl: cfg.invoiceLogoUrl,
        websiteUrl: cfg.websiteUrl,
        email: cfg.senderEmail,
        phone: cfg.phone,
        mobile: cfg.mobile,
        primaryColor: cfg.primaryColor,
        invoiceNumberPrefix: cfg.invoiceNumberPrefix,
        invoiceNumberNext: cfg.invoiceNumberStart,
        emailSignature: cfg.emailSignature,
        isActive: true,
        ...(cfg.legal
          ? {
              legalName: cfg.legal.legalName,
              addressLine1: cfg.legal.addressLine1,
              postalCode: cfg.legal.postalCode,
              city: cfg.legal.city,
              country: cfg.legal.country,
              accountHolder: cfg.legal.accountHolder,
              iban: cfg.legal.iban,
              bic: cfg.legal.bic,
              bankName: cfg.legal.bankName,
              bankAddress: cfg.legal.bankAddress,
              vatId: cfg.legal.vatId,
              businessId: cfg.legal.businessId,
              legalForm: cfg.legal.legalForm,
              managingDirectors: cfg.legal.managingDirectors,
              chamber: cfg.legal.chamber,
            }
          : {}),
      })
      .onConflictDoUpdate({ target: company.slug, set: updateSet });
  }

  await lockClient.query(`SELECT pg_advisory_unlock(${MIGRATION_LOCK_KEY})`);
  lockClient.release();
  await pool.end();
  console.log('[migrate] done.');
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
