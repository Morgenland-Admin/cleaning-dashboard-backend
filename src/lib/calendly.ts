import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Calendly API v2 client — used for pickup/on-site appointments ("Besichtigung /
 * Ausführung").
 *
 * ── Why Calendly and not the Google Calendar API ──
 * Calendly is connected to the CLEANILO Gmail account and already syncs both ways
 * with that account's Google Calendar. Booking through Calendly therefore gets the
 * calendar write for free — plus Calendly's own reminders, workflows, cancel and
 * reschedule links — with a single credential (one Personal Access Token). Writing
 * straight to the Google Calendar API would need a second credential set (service
 * account or OAuth client + consent), would not block Calendly availability as
 * reliably, and would give us no reminders. See docs/calendly-pickups.md.
 *
 * ── Brand exception ──
 * Everything here runs under CLEANILO even for Hamburg-Teppichreinigung orders:
 * one Calendly account, one calendar. This is the only place brands are shared;
 * every customer mail still goes out under the order's own brand.
 *
 * Booking needs a *paid* Calendly plan (the Scheduling API is not on the free
 * tier). Without a token every function below is a no-op that reports
 * `configured: false` rather than throwing, so the dashboard keeps working.
 */

/**
 * Overridable only so the booking flow can be exercised against a local stub
 * without touching the real calendar. env.ts refuses a non-Calendly host in
 * production, so this can never redirect live bookings.
 */
const API_BASE = (env.CALENDLY_API_BASE ?? 'https://api.calendly.com').replace(/\/$/, '');
const TIMEOUT_MS = 10_000;

/** True when a token is present. Booking additionally needs an event type URI. */
export const calendlyConfigured = !!env.CALENDLY_API_TOKEN;
/** True when we can actually place a booking (token + event type). */
export const calendlyBookingConfigured = !!(
  env.CALENDLY_API_TOKEN && env.CALENDLY_PICKUP_EVENT_TYPE_URI
);

export class CalendlyError extends Error {
  readonly status: number;
  /** Calendly's machine-readable error title, e.g. "Conflict". */
  readonly title: string | null;
  /** Offending request fields, e.g. ["event.start_time"]. */
  readonly parameters: string[];

  constructor(message: string, status: number, title: string | null, parameters: string[] = []) {
    super(message);
    this.name = 'CalendlyError';
    this.status = status;
    this.title = title;
    this.parameters = parameters;
  }

  /**
   * The slot was taken (or otherwise no longer bookable) — the operator must
   * pick another time rather than retry the same one.
   *
   * A double-booking comes back as a plain 400 naming `event.start_time`
   * ("Diese Startzeit wurde eingetragen"), not a 409, so the parameter has to be
   * inspected — otherwise a taken slot reads to the operator as an outage.
   */
  get isSlotUnavailable(): boolean {
    if (this.status === 409 || this.status === 422) return true;
    return this.status === 400 && this.parameters.some((p) => p.endsWith('start_time'));
  }
}

interface CalendlyErrorBody {
  title?: string;
  message?: string;
  details?: { parameter?: string; message?: string }[];
}

async function calendlyFetch<T>(path: string, init: RequestInit = {}): Promise<T> {
  if (!env.CALENDLY_API_TOKEN) {
    throw new CalendlyError('CALENDLY_API_TOKEN is not configured.', 503, null);
  }
  const res = await fetch(`${API_BASE}${path}`, {
    ...init,
    headers: {
      Authorization: `Bearer ${env.CALENDLY_API_TOKEN}`,
      'Content-Type': 'application/json',
      ...(init.headers ?? {}),
    },
    signal: init.signal ?? AbortSignal.timeout(TIMEOUT_MS),
  });

  const text = await res.text();
  const body: unknown = text ? safeJsonParse(text) : {};
  if (!res.ok) {
    const err = body as CalendlyErrorBody;
    // Calendly's per-field messages read "is missing" on their own — useless
    // without the parameter name, so pair them up.
    const fieldErrors = (err?.details ?? [])
      .map((d) => [d.parameter, d.message].filter(Boolean).join(' '))
      .filter(Boolean);
    const detail = fieldErrors.length
      ? `${err?.message ?? 'invalid request'} (${fieldErrors.join('; ')})`
      : (err?.message ?? text.slice(0, 300));
    throw new CalendlyError(
      `Calendly ${init.method ?? 'GET'} ${path} failed (${res.status}): ${detail}`,
      res.status,
      err?.title ?? null,
      (err?.details ?? []).map((d) => d.parameter).filter((p): p is string => !!p),
    );
  }
  return body as T;
}

function safeJsonParse(text: string): unknown {
  try {
    return JSON.parse(text);
  } catch {
    return { message: text };
  }
}

// ── Event type (location + required questions) ───────────────────────────────

export interface CalendlyEventTypeConfig {
  locations: { kind: string; location: string | null }[];
  questions: { name: string; type: string; position: number; required: boolean }[];
}

interface RawEventType {
  resource?: {
    locations?: { kind?: string; location?: string | null }[] | null;
    custom_questions?: {
      name?: string;
      type?: string;
      position?: number;
      required?: boolean;
      enabled?: boolean;
    }[];
  };
}

let eventTypeCache: { value: CalendlyEventTypeConfig; expiresAt: number } | null = null;
const EVENT_TYPE_TTL_MS = 10 * 60 * 1000;

/**
 * The pickup event type's location and required questions, cached for 10 minutes.
 *
 * Read rather than configured because Calendly validates a booking against the
 * event type's *current* setup: a physical location must repeat the exact text
 * the event type carries, and every enabled+required custom question must be
 * answered. Hard-coding either means an edit in the Calendly UI silently breaks
 * booking; reading it means the edit is picked up within the TTL.
 */
export async function getPickupEventType(force = false): Promise<CalendlyEventTypeConfig> {
  if (!force && eventTypeCache && eventTypeCache.expiresAt > Date.now()) {
    return eventTypeCache.value;
  }
  const uuid = uuidFromUri(env.CALENDLY_PICKUP_EVENT_TYPE_URI);
  if (!uuid) {
    throw new CalendlyError('CALENDLY_PICKUP_EVENT_TYPE_URI is not configured.', 503, null);
  }
  const raw = await calendlyFetch<RawEventType>(`/event_types/${encodeURIComponent(uuid)}`);
  const value: CalendlyEventTypeConfig = {
    locations: (raw.resource?.locations ?? [])
      .filter((l): l is { kind: string; location?: string | null } => typeof l?.kind === 'string')
      .map((l) => ({ kind: l.kind, location: l.location || null })),
    questions: (raw.resource?.custom_questions ?? [])
      .filter((q) => q.enabled !== false && typeof q.name === 'string')
      .map((q, i) => ({
        name: q.name!,
        type: q.type ?? 'string',
        position: q.position ?? i,
        required: q.required === true,
      })),
  };
  eventTypeCache = { value, expiresAt: Date.now() + EVENT_TYPE_TTL_MS };
  return value;
}

/** Drop the cached event type — used by tests and after a config change. */
export function clearPickupEventTypeCache(): void {
  eventTypeCache = null;
}

/**
 * Answer the event type's required questions from the order.
 *
 * The questions are free text Kabir writes in Calendly, so matching them by name
 * would break the first time he rewords one. We match on `type` instead
 * (phone_number → phone, everything else → address/service summary) and always
 * send *something* non-empty for a required question — an unanswered required
 * question is a hard 400 and would block the booking entirely.
 */
/**
 * True for a question that *asks for* the address, not one that merely mentions
 * it. CLEANILO's event type has both: a short "Wie ist die vollständige
 * Adresse?" and a long free-text brief that lists "die Adresse" among several
 * things to describe — a bare keyword match hands the address to the long one
 * and drops the service description entirely.
 */
function isAddressQuestion(name: string): boolean {
  return name.length <= 80 && /adresse|address|anschrift/i.test(name);
}

export function buildQuestionAnswers(
  questions: CalendlyEventTypeConfig['questions'],
  args: {
    customerPhone?: string | null;
    addressText?: string | null;
    serviceSummary?: string | null;
  },
): { question: string; answer: string; position: number }[] {
  const phone = args.customerPhone?.trim() || null;
  const address = args.addressText?.trim() || null;
  const service = args.serviceSummary?.trim() || null;
  // Last resort for a required question we have no data for. Better a marker the
  // operator can see in Calendly than a booking that never happens.
  const FALLBACK = 'Siehe Auftrag im Dashboard';

  const answers: { question: string; answer: string; position: number }[] = [];
  for (const q of questions) {
    let answer: string | null;
    if (q.type === 'phone_number') {
      // Calendly validates this one — a text placeholder is rejected, so fail
      // with something the operator can act on instead of a raw 400.
      if (!phone && q.required) {
        throw new CalendlyError(
          'Calendly verlangt eine Telefonnummer für diesen Termin, der Auftrag hat aber keine. ' +
            'Bitte zuerst die Telefonnummer im Auftrag ergänzen.',
          400,
          'MissingPhone',
        );
      }
      answer = phone;
    } else if (isAddressQuestion(q.name)) {
      answer = address ?? service;
    } else {
      // Free-text brief: lead with what the job is, and append the address so
      // the crew has it even when the event type has no separate address field.
      answer =
        [service, address && !service?.includes(address) ? address : null]
          .filter(Boolean)
          .join(' · ') || null;
    }
    if (!answer && !q.required) continue;
    answers.push({
      question: q.name,
      answer: (answer ?? FALLBACK).slice(0, 10_000),
      position: q.position,
    });
  }
  return answers;
}

// ── Booking ──────────────────────────────────────────────────────────────────

export interface CalendlyBooking {
  /** Scheduled-event URI, e.g. https://api.calendly.com/scheduled_events/UUID */
  eventUri: string | null;
  /** Invitee URI — the per-guest record carrying cancel/reschedule links. */
  inviteeUri: string | null;
  /** UTC start we booked, echoed back by Calendly. */
  startTime: string | null;
  cancelUrl: string | null;
  rescheduleUrl: string | null;
  status: string | null;
}

interface RawInviteeResponse {
  resource?: {
    uri?: string;
    event?: string;
    start_time?: string;
    cancel_url?: string;
    reschedule_url?: string;
    status?: string;
  };
}

export interface BookPickupArgs {
  /** UTC instant of the appointment start. */
  startTime: Date;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  /** Service address — feeds the event type's address question. */
  addressText?: string | null;
  /** What the job is, for the event type's "what do you need" question. */
  serviceSummary?: string | null;
  /** Correlation key echoed back on webhooks — see buildTrackingKey(). */
  trackingKey: string;
  /** IANA zone the invitee sees times in. */
  timezone?: string;
}

/**
 * Book `startTime` into the CLEANILO pickup event type on the customer's behalf
 * (Calendly Scheduling API). Calendly then writes the event to the synced
 * CLEANILO Google Calendar and fires its own reminders.
 *
 * Throws CalendlyError; `isSlotUnavailable` distinguishes "slot gone" (operator
 * picks another time) from a real outage.
 */
export async function bookPickupAppointment(args: BookPickupArgs): Promise<CalendlyBooking> {
  if (!env.CALENDLY_PICKUP_EVENT_TYPE_URI) {
    throw new CalendlyError('CALENDLY_PICKUP_EVENT_TYPE_URI is not configured.', 503, null);
  }

  // Location and required questions are whatever the event type is configured
  // with — read them rather than guess, so Kabir can edit the event type in
  // Calendly without us shipping code. Cached; see getPickupEventType().
  const eventType = await getPickupEventType();

  const body: Record<string, unknown> = {
    event_type: env.CALENDLY_PICKUP_EVENT_TYPE_URI,
    // Calendly requires UTC with a trailing Z and rejects sub-minute precision.
    start_time: toCalendlyUtc(args.startTime),
    invitee: {
      name: args.customerName,
      email: args.customerEmail,
      timezone: args.timezone ?? env.CALENDLY_TIMEZONE,
    },
    // All six tracking fields must be present once `tracking` is sent at all —
    // a partial object is a 400 ("is missing"). Only utm_content carries meaning
    // for us: it is the order correlation key echoed back on invitee.* webhooks.
    tracking: {
      utm_source: 'dashboard',
      utm_content: args.trackingKey,
      utm_campaign: '',
      utm_medium: '',
      utm_term: '',
      salesforce_uuid: '',
    },
  };

  // Omit `location` entirely when the event type has none, else Calendly rejects
  // it. For a physical location the text is fixed by the event type — sending
  // our own address here is an "invalid location choice".
  const location = eventType.locations[0];
  if (location) {
    body.location = location.location
      ? { kind: location.kind, location: location.location }
      : { kind: location.kind };
  }

  const answers = buildQuestionAnswers(eventType.questions, args);
  if (answers.length > 0) body.questions_and_answers = answers;

  const raw = await calendlyFetch<RawInviteeResponse>('/invitees', {
    method: 'POST',
    body: JSON.stringify(body),
  });
  const r = raw.resource ?? {};
  return {
    eventUri: r.event ?? null,
    inviteeUri: r.uri ?? null,
    startTime: r.start_time ?? null,
    cancelUrl: r.cancel_url ?? null,
    rescheduleUrl: r.reschedule_url ?? null,
    status: r.status ?? null,
  };
}

/** Cancel a scheduled event we booked. Best-effort — returns false on failure. */
export async function cancelPickupAppointment(
  eventUri: string,
  reason?: string,
): Promise<{ ok: boolean; error?: string }> {
  const uuid = uuidFromUri(eventUri);
  if (!uuid) return { ok: false, error: 'Unparsable scheduled-event URI' };
  try {
    await calendlyFetch(`/scheduled_events/${encodeURIComponent(uuid)}/cancellation`, {
      method: 'POST',
      body: JSON.stringify({ reason: reason?.slice(0, 1000) ?? 'Auftrag storniert' }),
    });
    return { ok: true };
  } catch (err) {
    return { ok: false, error: err instanceof Error ? err.message : String(err) };
  }
}

// ── Availability ─────────────────────────────────────────────────────────────

interface RawAvailableTimes {
  collection?: { status?: string; start_time?: string; invitees_remaining?: number }[];
}

/**
 * Open start times for the pickup event type in [start, end). Calendly caps the
 * window at 7 days per call and rejects a start in the past, so callers should
 * pass a clamped range. Returns UTC ISO strings.
 */
export async function listAvailablePickupTimes(start: Date, end: Date): Promise<string[]> {
  if (!env.CALENDLY_PICKUP_EVENT_TYPE_URI) {
    throw new CalendlyError('CALENDLY_PICKUP_EVENT_TYPE_URI is not configured.', 503, null);
  }
  const params = new URLSearchParams({
    event_type: env.CALENDLY_PICKUP_EVENT_TYPE_URI,
    start_time: toCalendlyUtc(start),
    end_time: toCalendlyUtc(end),
  });
  const raw = await calendlyFetch<RawAvailableTimes>(
    `/event_type_available_times?${params.toString()}`,
  );
  return (raw.collection ?? [])
    .filter((slot) => slot.status === 'available' && !!slot.start_time)
    .map((slot) => slot.start_time!);
}

// ── Single-use scheduling link (fallback route) ───────────────────────────────

interface RawSchedulingLink {
  resource?: { booking_url?: string };
}

/**
 * One-shot scheduling link the customer books themselves — the fallback when we
 * cannot book for them (no paid plan, slot conflicts, or the customer wants to
 * pick). `trackingKey` rides along as utm_content so the invitee.created webhook
 * can find the order again.
 */
export async function createPickupSchedulingLink(trackingKey: string): Promise<string> {
  if (!env.CALENDLY_PICKUP_EVENT_TYPE_URI) {
    throw new CalendlyError('CALENDLY_PICKUP_EVENT_TYPE_URI is not configured.', 503, null);
  }
  const raw = await calendlyFetch<RawSchedulingLink>('/scheduling_links', {
    method: 'POST',
    body: JSON.stringify({
      max_event_count: 1,
      owner: env.CALENDLY_PICKUP_EVENT_TYPE_URI,
      owner_type: 'EventType',
    }),
  });
  const url = raw.resource?.booking_url;
  if (!url) throw new CalendlyError('Calendly returned no booking_url', 502, null);
  const sep = url.includes('?') ? '&' : '?';
  return `${url}${sep}utm_source=dashboard&utm_content=${encodeURIComponent(trackingKey)}`;
}

// ── Correlation key ──────────────────────────────────────────────────────────

const TRACKING_PREFIX = 'order';

/**
 * `order:<companySlug>:<orderId>` — survives the Calendly round-trip in
 * utm_content and tells us which tenant's order a webhook belongs to. Needed
 * because bookings all land in the one CLEANILO Calendly account regardless of
 * the order's brand.
 */
export function buildTrackingKey(companySlug: string, orderId: number): string {
  return `${TRACKING_PREFIX}:${companySlug}:${orderId}`;
}

export function parseTrackingKey(value: unknown): { companySlug: string; orderId: number } | null {
  if (typeof value !== 'string') return null;
  const parts = value.split(':');
  if (parts.length !== 3 || parts[0] !== TRACKING_PREFIX) return null;
  const companySlug = parts[1]!;
  const orderId = Number(parts[2]);
  if (!companySlug || !Number.isInteger(orderId) || orderId <= 0) return null;
  return { companySlug, orderId };
}

// ── Webhooks ─────────────────────────────────────────────────────────────────

export interface CalendlyWebhookPayload {
  event?: string;
  payload?: {
    uri?: string;
    email?: string;
    name?: string;
    status?: string;
    cancel_url?: string;
    reschedule_url?: string;
    /** Present on invitee.created when the invitee rescheduled an earlier booking. */
    rescheduled?: boolean;
    tracking?: Record<string, string | null>;
    scheduled_event?: {
      uri?: string;
      start_time?: string;
      end_time?: string;
      status?: string;
      name?: string;
    };
    cancellation?: { canceled_by?: string; reason?: string };
  };
}

/**
 * Verify `calendly-webhook-signature` over the raw request body.
 *
 * Calendly documents the Stripe-style `t=<unix>,v1=<hex>` form, where the signed
 * string is `<t>.<rawBody>`. Some accounts have been observed sending a bare hex
 * digest of the body instead, so both shapes are accepted — each still requires a
 * valid HMAC-SHA256 under the subscription's signing key, so accepting the bare
 * form costs no authenticity. Timestamped signatures are additionally rejected
 * outside `toleranceSeconds` to block replay.
 */
export function verifyCalendlyWebhook(
  header: string | undefined,
  rawBody: string,
  opts: { signingKey?: string | null; nowMs?: number; toleranceSeconds?: number } = {},
): boolean {
  const signingKey = opts.signingKey ?? env.CALENDLY_WEBHOOK_SIGNING_KEY;
  if (!signingKey || !header) return false;

  const parts = header.split(',').reduce<Record<string, string>>((acc, part) => {
    const idx = part.indexOf('=');
    if (idx > 0) acc[part.slice(0, idx).trim()] = part.slice(idx + 1).trim();
    return acc;
  }, {});

  const timestamp = parts.t;
  const signature = parts.v1;

  if (timestamp && signature) {
    const toleranceSeconds = opts.toleranceSeconds ?? 300;
    const ts = Number(timestamp);
    if (!Number.isFinite(ts)) return false;
    const nowSeconds = Math.floor((opts.nowMs ?? Date.now()) / 1000);
    if (Math.abs(nowSeconds - ts) > toleranceSeconds) return false;
    return hmacEquals(signingKey, `${timestamp}.${rawBody}`, signature);
  }

  // Bare-digest form: the whole header value is the hex HMAC of the raw body.
  const bare = header.trim();
  if (!/^[0-9a-f]{64}$/i.test(bare)) return false;
  return hmacEquals(signingKey, rawBody, bare);
}

function hmacEquals(key: string, payload: string, expectedHex: string): boolean {
  const actual = crypto.createHmac('sha256', key).update(payload, 'utf8').digest();
  let expected: Buffer;
  try {
    expected = Buffer.from(expectedHex, 'hex');
  } catch {
    return false;
  }
  if (expected.length !== actual.length) return false;
  return crypto.timingSafeEqual(actual, expected);
}

// ── Helpers ──────────────────────────────────────────────────────────────────

/** Whole-minute UTC ISO string — the only shape Calendly accepts for start_time. */
export function toCalendlyUtc(d: Date): string {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new CalendlyError('Invalid date', 400, null);
  return `${new Date(Math.floor(ms / 60_000) * 60_000).toISOString().slice(0, 19)}Z`;
}

/** Trailing UUID of any Calendly resource URI. */
export function uuidFromUri(uri: string | null | undefined): string | null {
  if (typeof uri !== 'string') return null;
  const last = uri.replace(/\/+$/, '').split('/').pop();
  return last && last.length > 0 ? last : null;
}
