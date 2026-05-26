/**
 * Slug-shape rules. Slugs are used as identifiers in URLs, Postgres schema
 * names, and S3 key prefixes — keep them strict:
 *   - lowercase letters, digits, underscore only
 *   - must start with a letter (so it's a valid Postgres identifier)
 *   - 2–63 chars (Postgres NAMEDATALEN-1)
 *
 * The list of *actual* tenants is loaded from the `company` table at runtime
 * via src/lib/company-loader.ts — this module only owns the type + validation.
 */
export type CompanySlug = string;

const SLUG_RE = /^[a-z][a-z0-9_]{1,62}$/;
export function isValidCompanySlug(value: unknown): value is CompanySlug {
  return typeof value === 'string' && SLUG_RE.test(value);
}

/** Same rules as a slug — keeps the Postgres identifier safe to interpolate. */
export function isValidSchemaName(value: unknown): value is string {
  return typeof value === 'string' && SLUG_RE.test(value);
}

/** Hyphenated, URL-safe variant — used as the S3 key prefix per company. */
const KEY_PREFIX_RE = /^[a-z][a-z0-9-]{1,62}$/;
export function isValidKeyPrefix(value: unknown): value is string {
  return typeof value === 'string' && KEY_PREFIX_RE.test(value);
}

/**
 * Legacy slugs — kept ONLY so the seed script can target the original three
 * companies on a fresh database. Anywhere in the runtime that needs to know
 * which companies exist must use src/lib/company-loader.ts instead.
 */
export const LEGACY_COMPANY_SLUGS = [
  'cleanilo',
  'hamburg_teppichreinigung',
  'teppichreinigen_lassen',
] as const;
export type LegacyCompanySlug = (typeof LEGACY_COMPANY_SLUGS)[number];
