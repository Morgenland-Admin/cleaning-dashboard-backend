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

/** Manager and up. A `viewer` (or a user with no level) is not privileged. */
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
