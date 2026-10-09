import type { FastifyBaseLogger } from 'fastify';

import { env } from '../config/env.js';
import { loadCompany } from './company-loader.js';

const TIMEOUT_MS = 5_000;

/** Overlay rows (see seo/routes.ts) render on a fixed storefront route. */
const OVERLAY_CATEGORY = 'leistung';

// Per-brand secret, like the Resend / Meta creds. Unconfigured ⇒ no-op, and the
// storefront falls back to its hourly ISR refresh.
function brandSecret(companySlug: string): string | undefined {
  switch (companySlug) {
    case 'hamburg_teppichreinigung':
      return env.STOREFRONT_REVALIDATE_SECRET_HAMBURG;
    default:
      return undefined;
  }
}

export function storefrontRevalidateConfigured(companySlug: string): boolean {
  return !!brandSecret(companySlug);
}

/**
 * The storefront URLs a seo_pages row renders at. Mirrors the sitemap: blog
 * paths already carry "blog/", overlay rows live on their own fixed route, the
 * rest under /seo/. A blog post also changes the /blog index.
 */
export function publicPathsFor(row: {
  type: string;
  path: string;
  category: string | null;
}): string[] {
  if (row.type === 'blog') return ['/blog', `/${row.path}`];
  if (row.category === OVERLAY_CATEGORY) return [`/${row.path}`];
  return [`/seo/${row.path}`];
}

/**
 * Tell the brand storefront to drop its cached copy of these paths so a
 * publish / edit / unpublish is visible right away. Fire-and-forget by design:
 * it never throws, and a failure only means the hourly refresh applies.
 */
export async function revalidateStorefront(
  companySlug: string,
  paths: string[],
  log: FastifyBaseLogger,
): Promise<void> {
  const secret = brandSecret(companySlug);
  const unique = [...new Set(paths)];
  if (!secret || unique.length === 0) return;
  try {
    const company = await loadCompany(companySlug);
    const origin = company?.storefrontOrigin?.replace(/\/$/, '');
    if (!origin) return;
    // Trailing slash matches the storefront's trailingSlash config, saving a 308 hop.
    const res = await fetch(`${origin}/api/revalidate/`, {
      method: 'POST',
      headers: { 'content-type': 'application/json', 'x-revalidate-secret': secret },
      body: JSON.stringify({ paths: unique }),
      signal: AbortSignal.timeout(TIMEOUT_MS),
    });
    if (!res.ok) {
      log.warn({ company: companySlug, status: res.status }, 'storefront revalidate rejected');
    }
  } catch (err) {
    log.warn({ company: companySlug, err }, 'storefront revalidate failed');
  }
}
