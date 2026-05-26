import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { company } from '../db/schema/shared.js';

export interface CompanyRow {
  slug: string;
  name: string;
  schemaName: string;
  keyPrefix: string;
  storefrontOrigin: string | null;
  senderEmail: string | null;
  senderName: string | null;
  primaryColor: string | null;
  email: string | null;
  isActive: boolean;
}

/**
 * In-memory cache of the active company registry. Keyed by slug. Each entry
 * has a short TTL so a new row added by another instance (e.g. behind a load
 * balancer) eventually shows up without a redeploy. Hot paths can also call
 * `invalidateCompany()` directly after writes so the same instance sees its
 * own changes immediately.
 */
const TTL_MS = 60_000;

interface CacheEntry {
  value: CompanyRow | null;
  expiresAt: number;
}

const cache = new Map<string, CacheEntry>();
let allCache: { rows: CompanyRow[]; expiresAt: number } | null = null;

function normalize(row: typeof company.$inferSelect): CompanyRow {
  return {
    slug: row.slug,
    name: row.name,
    schemaName: row.schemaName,
    keyPrefix: row.keyPrefix ?? row.slug,
    storefrontOrigin: row.storefrontOrigin ?? null,
    senderEmail: row.senderEmail ?? null,
    senderName: row.senderName ?? null,
    primaryColor: row.primaryColor ?? null,
    email: row.email ?? null,
    isActive: row.isActive,
  };
}

export async function loadCompany(slug: string): Promise<CompanyRow | null> {
  const hit = cache.get(slug);
  if (hit && hit.expiresAt > Date.now()) return hit.value;
  const [row] = await db.select().from(company).where(eq(company.slug, slug)).limit(1);
  const value = row ? normalize(row) : null;
  cache.set(slug, { value, expiresAt: Date.now() + TTL_MS });
  return value;
}

export async function loadAllActiveCompanies(): Promise<CompanyRow[]> {
  if (allCache && allCache.expiresAt > Date.now()) return allCache.rows;
  const rows = await db.select().from(company).where(eq(company.isActive, true));
  const normalized = rows.map(normalize);
  allCache = { rows: normalized, expiresAt: Date.now() + TTL_MS };
  // Warm the per-slug cache too so subsequent loadCompany() calls hit it.
  for (const r of normalized) {
    cache.set(r.slug, { value: r, expiresAt: Date.now() + TTL_MS });
  }
  return normalized;
}

export function invalidateCompany(slug?: string) {
  if (slug) cache.delete(slug);
  else cache.clear();
  allCache = null;
}
