/**
 * The `viewer` read model.
 *
 * A `viewer` works the same queues as everyone else, so they see the operational
 * record — who the customer is, what they ordered, what it cost. What they do
 * *not* see is the material that is either internal commentary or forensic:
 * staff notes, the IP/user-agent captured at submission, and payment-processor
 * identifiers (which are effectively credentials for looking the payment up in
 * Stripe/PayPal).
 *
 * This lives in one file because it was previously a private helper inside the
 * orders module, which meant every other module that returned the same columns
 * silently leaked them.
 */

const PRIVILEGED_LEVELS = new Set(['manager', 'admin', 'super_admin']);

/** Read an access level off a request without asserting the session's shape. */
export function accessLevelOf(request: { authUser: unknown }): string | undefined {
  return (request.authUser as { accessLevel?: string } | null)?.accessLevel;
}

/**
 * Manager and up. A `viewer`, an `seo` blog writer (or a user with no level) is
 * not privileged. `seo` is further fenced off by `seoMayAccess` below.
 */
export function isPrivileged(accessLevel: string | undefined): boolean {
  return !!accessLevel && PRIVILEGED_LEVELS.has(accessLevel);
}

/** Columns hidden from a `viewer` wherever they appear. */
const REDACTED_FIELDS = [
  'ipAddress',
  'userAgent',
  'internalNotes',
  'stripeSessionId',
  'stripePaymentIntentId',
  'paypalOrderId',
  'paypalCaptureId',
] as const;

/**
 * Blank the viewer-hidden columns on a row.
 *
 * Any row shape is accepted, and only the fields it actually has are touched —
 * a response never grows keys it did not already carry, so this is safe to apply
 * to a narrow `select({...})` projection as well as a full row.
 */
export function redactForViewer<T extends object>(
  row: T,
  accessLevel: string | undefined,
  extraFields: readonly string[] = [],
): T {
  if (isPrivileged(accessLevel)) return row;
  // Widened to a plain record for the writes: TS will not let a generic `T` be
  // indexed for assignment, and the cast is sound because every write is guarded
  // by an `in` check and only ever stores null.
  const out = { ...row } as Record<string, unknown>;
  for (const field of REDACTED_FIELDS) {
    if (field in out) out[field] = null;
  }
  // Context-specific additions. Deliberately *not* in REDACTED_FIELDS: a partner
  // reading their own profile is also `accessLevel: viewer`, so blanking e.g.
  // `iban` globally would hide a partner's own bank details from themselves.
  // Only the cross-tenant admin views pass extras.
  for (const field of extraFields) {
    if (field in out) out[field] = null;
  }
  return out as T;
}

/** `redactForViewer` over a list. */
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
 * The `seo` scope: blog/SEO writers who never need the operational record.
 *
 * An allowlist, not a blocklist — a route added later stays closed to `seo`
 * until someone opts it in here. Matched against Fastify's route *pattern*
 * (`/admin/seo-pages/:id`), never the raw URL, so query strings and encoded
 * paths cannot widen it. `methods: '*'` still leaves the route's own gate in
 * charge (e.g. seo-pages writes are `canEdit`).
 *
 * Mirrored for navigation in the frontend's `lib/access.ts` (SEO_PATHS).
 */
const SEO_ROUTES: ReadonlyArray<{ methods: readonly string[] | '*'; path: string }> = [
  { methods: '*', path: '/admin/users/me' }, // own profile, settings, addresses
  { methods: ['GET'], path: '/admin/companies' }, // brand list (brand switcher + brands page)
  { methods: '*', path: '/admin/seo-pages' }, // blog + SEO pages
  { methods: ['POST'], path: '/admin/uploads/sign-public-image' }, // blog images
  { methods: ['GET'], path: '/admin/reviews' }, // read-only, reviewer email hidden
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
