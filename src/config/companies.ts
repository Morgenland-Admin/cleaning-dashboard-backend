/** Slugs double as Postgres schema names and S3 key prefixes: lowercase letters, digits, underscore; start with a letter; 2-63 chars. */
export type CompanySlug = string;

const SLUG_RE = /^[a-z][a-z0-9_]{1,62}$/;
export function isValidCompanySlug(value: unknown): value is CompanySlug {
  return typeof value === 'string' && SLUG_RE.test(value);
}

/** Same rules as a slug; guards schema names interpolated into SQL. */
export function isValidSchemaName(value: unknown): value is string {
  return typeof value === 'string' && SLUG_RE.test(value);
}

/** Hyphenated variant used as the S3 key prefix. */
const KEY_PREFIX_RE = /^[a-z][a-z0-9-]{1,62}$/;
export function isValidKeyPrefix(value: unknown): value is string {
  return typeof value === 'string' && KEY_PREFIX_RE.test(value);
}

/** Seed-only. Runtime code must load tenants via src/lib/company-loader.ts. */
export const LEGACY_COMPANY_SLUGS = [
  'cleanilo',
  'hamburg_teppichreinigung',
  'teppichreinigen_lassen',
] as const;
export type LegacyCompanySlug = (typeof LEGACY_COMPANY_SLUGS)[number];
