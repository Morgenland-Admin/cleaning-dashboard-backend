/**
 * Boot-time DB bootstrap + migration script.
 *
 * Runs ahead of `node dist/server.js` (see Dockerfile CMD). Three phases:
 *
 *   1. Ensure the three legacy tenant schemas exist. Drizzle migrations
 *      reference tables in these schemas (e.g. CREATE TABLE "cleanilo".orders);
 *      without the schemas, migration 0000 fails on a fresh database.
 *
 *   2. Run drizzle migrations idempotently.
 *
 *   3. Upsert the three legacy company rows so the X-Company-Slug header
 *      resolves on first boot. This is the absolute minimum runtime state
 *      needed for the storefronts to work. Additional companies are created
 *      via POST /admin/companies once an admin user exists.
 *
 * Idempotent: rerunning is safe on every container start.
 */

import { drizzle } from 'drizzle-orm/node-postgres';
import { migrate } from 'drizzle-orm/node-postgres/migrator';
import { sql } from 'drizzle-orm';
import pg from 'pg';

import { env } from '../config/env.js';
import { type LEGACY_COMPANY_SLUGS } from '../config/companies.js';
import { company } from './schema/shared.js';
import { createTenantSchemaSql } from './schema/tenant.js';

const { Pool } = pg;

interface LegacyConfig {
  slug: string;
  name: string;
  schemaName: string;
  keyPrefix: string;
  storefrontOrigin: string;
  senderEmail: string;
  senderName: string;
  websiteUrl: string;
  resendApiKey: string | null;
  logoUrl: string | null;
  /**
   * Legal + banking identity for invoices / dunning. Only seeded where we have
   * confirmed real-world data — brands left undefined keep their existing values
   * (admins fill them in via PATCH /admin/companies). Seeded fields are
   * coalesced so a later admin edit is never clobbered on the next boot.
   */
  legal?: {
    legalName: string;
    addressLine1: string;
    postalCode: string;
    city: string;
    country: string;
    accountHolder: string;
    iban: string;
    bic: string;
    bankName: string;
    bankAddress: string;
  };
}

const LEGACY_BOOTSTRAP: Record<(typeof LEGACY_COMPANY_SLUGS)[number], LegacyConfig> = {
  cleanilo: {
    slug: 'cleanilo',
    name: 'Cleanilo',
    schemaName: 'cleanilo',
    keyPrefix: 'cleanilo',
    storefrontOrigin: 'https://cleanilo.de',
    senderEmail: 'info@cleanilo.de',
    senderName: 'CLEANILO',
    websiteUrl: 'https://cleanilo.de',
    resendApiKey: env.RESEND_API_KEY_CLEANILO ?? null,
    logoUrl: 'https://reinigungs-portal.com/cleanilo.png',
    legal: {
      legalName: 'Cleanilo – M. Kabir Madjidian & M. Amiri GbR',
      addressLine1: 'Brook 9',
      postalCode: '20457',
      city: 'Hamburg',
      country: 'DE',
      accountHolder: 'Cleanilo – M. Kabir Madjidian & M. Amiri GbR',
      iban: 'DE91202208000043001639',
      bic: 'SXPYDEHHXXX',
      bankName: 'Banking Circle S.A. – German Branch',
      bankAddress: 'Maximilianstraße 54, 80538 München, Deutschland',
    },
  },
  hamburg_teppichreinigung: {
    slug: 'hamburg_teppichreinigung',
    name: 'Hamburg Teppichreinigung',
    schemaName: 'hamburg_teppichreinigung',
    keyPrefix: 'hamburg-teppichreinigung',
    storefrontOrigin: 'https://hamburg-teppichreinigung.de',
    senderEmail: 'info@hamburg-teppichreinigung.de',
    senderName: 'Hamburg Teppichreinigung',
    websiteUrl: 'https://hamburg-teppichreinigung.de',
    resendApiKey: env.RESEND_API_KEY_HAMBURG ?? null,
    logoUrl: 'https://reinigungs-portal.com/hamburg-teppichreinigung.png',
    legal: {
      // Same GbR bank account as Cleanilo, but shown under the bare GbR name
      // (no brand prefix) on HTR invoices.
      legalName: 'M. Kabir Madjidian & M. Amiri GbR',
      addressLine1: 'Brook 9',
      postalCode: '20457',
      city: 'Hamburg',
      country: 'DE',
      accountHolder: 'M. Kabir Madjidian & M. Amiri GbR',
      iban: 'DE91202208000043001639',
      bic: 'SXPYDEHHXXX',
      bankName: 'Banking Circle S.A. – German Branch',
      bankAddress: 'Maximilianstraße 54, 80538 München, Deutschland',
    },
  },
  teppichreinigen_lassen: {
    slug: 'teppichreinigen_lassen',
    name: 'Teppichreinigen Lassen',
    schemaName: 'teppichreinigen_lassen',
    keyPrefix: 'teppichreinigen-lassen',
    storefrontOrigin: 'https://teppichreinigen-lassen.de',
    senderEmail: 'info@teppichreinigen-lassen.de',
    senderName: 'teppichreinigen-lassen.de',
    websiteUrl: 'https://teppichreinigen-lassen.de',
    resendApiKey: env.RESEND_API_KEY_TRL ?? null,
    logoUrl: null,
    legal: {
      // Same GbR bank account, bare GbR name (no brand prefix) on TRL invoices.
      legalName: 'M. Kabir Madjidian & M. Amiri GbR',
      addressLine1: 'Brook 9',
      postalCode: '20457',
      city: 'Hamburg',
      country: 'DE',
      accountHolder: 'M. Kabir Madjidian & M. Amiri GbR',
      iban: 'DE91202208000043001639',
      bic: 'SXPYDEHHXXX',
      bankName: 'Banking Circle S.A. – German Branch',
      bankAddress: 'Maximilianstraße 54, 80538 München, Deutschland',
    },
  },
};

// pg_advisory_lock key, shared by all replicas.
const MIGRATION_LOCK_KEY = 7_421_001;

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const db = drizzle(pool);

  // Serialize migrations across replicas. Advisory locks are session-level,
  // so lock and unlock must run on the same pinned client.
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
    // Only set a default logo when none exists — never clobber an admin upload.
    if (cfg.logoUrl) updateSet.logoUrl = sql`coalesce(${company.logoUrl}, ${cfg.logoUrl})`;
    // Legal + banking identity: seed only where blank so admin edits always win.
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
        logoUrl: cfg.logoUrl,
        websiteUrl: cfg.websiteUrl,
        email: cfg.senderEmail,
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
