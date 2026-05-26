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
}

const LEGACY_BOOTSTRAP: Record<(typeof LEGACY_COMPANY_SLUGS)[number], LegacyConfig> = {
  cleanilo: {
    slug: 'cleanilo',
    name: 'Cleanilo',
    schemaName: 'cleanilo',
    keyPrefix: 'cleanilo',
    storefrontOrigin: 'https://cleanilo.de',
    senderEmail: 'hello@cleanilo.de',
    senderName: 'CLEANILO',
    websiteUrl: 'https://cleanilo.de',
  },
  hamburg_teppichreinigung: {
    slug: 'hamburg_teppichreinigung',
    name: 'Hamburg Teppichreinigung',
    schemaName: 'hamburg_teppichreinigung',
    keyPrefix: 'hamburg-teppichreinigung',
    storefrontOrigin: 'https://hamburg-teppichreinigung.de',
    senderEmail: 'hallo@hamburg-teppichreinigung.de',
    senderName: 'Hamburg Teppichreinigung',
    websiteUrl: 'https://hamburg-teppichreinigung.de',
  },
  teppichreinigen_lassen: {
    slug: 'teppichreinigen_lassen',
    name: 'Teppichreinigen Lassen',
    schemaName: 'teppichreinigen_lassen',
    keyPrefix: 'teppichreinigen-lassen',
    storefrontOrigin: 'https://teppichreinigen-lassen.de',
    senderEmail: 'kontakt@teppichreinigen-lassen.de',
    senderName: 'teppichreinigen-lassen.de',
    websiteUrl: 'https://teppichreinigen-lassen.de',
  },
};

async function main(): Promise<void> {
  const pool = new Pool({ connectionString: env.DATABASE_URL });
  const db = drizzle(pool);

  // Phase 1 — tenant schemas. Quote-identifier-safe (no user input here, all
  // schema names come from a const allowlist).
  console.log('[migrate] ensuring tenant schemas…');
  for (const cfg of Object.values(LEGACY_BOOTSTRAP)) {
    await db.execute(sql.raw(`CREATE SCHEMA IF NOT EXISTS "${cfg.schemaName}"`));
  }

  // Phase 2 — Drizzle migrations against ./drizzle. This covers the public
  // schema tables (user / company / membership / tasks / push_subscriptions /
  // export_jobs / etc) and the FIVE tenant tables that have top-level
  // exports in tenant.ts (newsletter_subscribers, contact_messages,
  // contact_replies, service_inquiries, partners).
  console.log('[migrate] applying drizzle migrations…');
  await migrate(db, { migrationsFolder: './drizzle' });

  // Phase 3 — fill in the REMAINING tenant tables (orders / order_items /
  // order_status_log / chat_conversations / chat_messages). These aren't
  // top-level exports — they're built by buildTenantTables() at runtime, so
  // drizzle-kit doesn't generate migrations for them. createTenantSchemaSql
  // is idempotent (IF NOT EXISTS everywhere), so this is safe to re-run on
  // every boot and on already-existing schemas.
  console.log('[migrate] ensuring tenant tables (orders + chat)…');
  for (const cfg of Object.values(LEGACY_BOOTSTRAP)) {
    await db.execute(sql.raw(createTenantSchemaSql(cfg.schemaName)));
  }

  // Phase 4 — minimal company-row bootstrap. ON CONFLICT DO NOTHING so we
  // never overwrite operator-edited values on subsequent boots.
  console.log('[migrate] upserting legacy company rows…');
  for (const cfg of Object.values(LEGACY_BOOTSTRAP)) {
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
        websiteUrl: cfg.websiteUrl,
        email: cfg.senderEmail,
        isActive: true,
      })
      .onConflictDoNothing({ target: company.slug });
  }

  await pool.end();
  console.log('[migrate] done.');
}

main().catch((err) => {
  console.error('[migrate] failed:', err);
  process.exit(1);
});
