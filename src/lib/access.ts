/**
 * The `viewer` read model: a viewer sees the operational record but not staff notes, IP/user-agent,
 * or payment-processor ids (effectively credentials for looking a payment up in Stripe/PayPal).
 */

const PRIVILEGED_LEVELS = new Set(['manager', 'admin', 'super_admin']);

export function accessLevelOf(request: { authUser: unknown }): string | undefined {
  return (request.authUser as { accessLevel?: string } | null)?.accessLevel;
}

/** Manager and up; `viewer`, `seo` and no level are not privileged. */
export function isPrivileged(accessLevel: string | undefined): boolean {
  return !!accessLevel && PRIVILEGED_LEVELS.has(accessLevel);
}

const REDACTED_FIELDS = [
  'ipAddress',
  'userAgent',
  'internalNotes',
  'stripeSessionId',
  'stripePaymentIntentId',
  'paypalOrderId',
  'paypalCaptureId',
] as const;

/** Blanks the viewer-hidden columns; only fields the row already has are touched, so narrow projections are safe. */
export function redactForViewer<T extends object>(
  row: T,
  accessLevel: string | undefined,
  extraFields: readonly string[] = [],
): T {
  if (isPrivileged(accessLevel)) return row;
  // Widened for the writes; sound because every write is `in`-guarded and only stores null.
  const out = { ...row } as Record<string, unknown>;
  for (const field of REDACTED_FIELDS) {
    if (field in out) out[field] = null;
  }
  // Not in REDACTED_FIELDS: a partner reading their own profile is also `viewer`, so blanking `iban`
  // globally would hide their own bank details. Only cross-tenant admin views pass extras.
  for (const field of extraFields) {
    if (field in out) out[field] = null;
  }
  return out as T;
}

export function redactListForViewer<T extends object>(
  rows: T[],
  accessLevel: string | undefined,
  extraFields: readonly string[] = [],
): T[] {
  if (isPrivileged(accessLevel)) return rows;
  return rows.map((row) => redactForViewer(row, accessLevel, extraFields));
}

/** Partner banking columns: visible to the partner themselves, not to a brand viewer. */
export const PARTNER_PAYOUT_FIELDS = ['iban', 'bic'] as const;

/**
 * `seo` allowlist (blog/SEO writers): a new route stays closed to `seo` until added here. Matched against
 * Fastify's route pattern, never the raw URL; `methods: '*'` leaves the route's own gate in charge. Mirrors frontend SEO_PATHS.
 */
const SEO_ROUTES: ReadonlyArray<{ methods: readonly string[] | '*'; path: string }> = [
  { methods: '*', path: '/admin/users/me' },
  { methods: ['GET'], path: '/admin/companies' },
  { methods: '*', path: '/admin/seo-pages' },
  { methods: ['POST'], path: '/admin/uploads/sign-public-image' },
  { methods: ['GET'], path: '/admin/reviews' },
];

/** Exact-match paths: `/admin/companies` must not open `/admin/companies/:slug/stats`. */
const SEO_EXACT = new Set(['/admin/companies', '/admin/reviews']);

export function seoMayAccess(method: string, routeUrl: string | undefined): boolean {
  if (!routeUrl) return false;
  const url = routeUrl.length > 1 ? routeUrl.replace(/\/+$/, '') : routeUrl;
  return SEO_ROUTES.some(({ methods, path }) => {
    if (methods !== '*' && !methods.includes(method)) return false;
    if (SEO_EXACT.has(path)) return url === path;
    return url === path || url.startsWith(`${path}/`);
  });
}

/** Review columns an `seo` reader does not get: the reviewer's contact + order link. */
export const SEO_HIDDEN_REVIEW_FIELDS = ['customerEmail', 'orderId'] as const;
