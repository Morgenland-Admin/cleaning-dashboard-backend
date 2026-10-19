import crypto from 'node:crypto';
import { env } from '../config/env.js';

/**
 * Calendly API v2 client for pickup appointments. Runs under CLEANILO even for Hamburg
 * orders (one account, one calendar) — the only shared-brand exception; mails keep the order's brand.
 * Booking needs a paid Calendly plan (Scheduling API).
 */

// Override is for local stubs only; env.ts rejects non-Calendly hosts in production.
const API_BASE = (env.CALENDLY_API_BASE ?? 'https://api.calendly.com').replace(/\/$/, '');
const TIMEOUT_MS = 10_000;

export const calendlyConfigured = !!env.CALENDLY_API_TOKEN;
export const calendlyBookingConfigured = !!(
  env.CALENDLY_API_TOKEN && env.CALENDLY_PICKUP_EVENT_TYPE_URI
);

export class CalendlyError extends Error {
  readonly status: number;
  readonly title: string | null;
  readonly parameters: string[];

  constructor(message: string, status: number, title: string | null, parameters: string[] = []) {
    super(message);
    this.name = 'CalendlyError';
    this.status = status;
    this.title = title;
    this.parameters = parameters;
  }

  /** A double-booking is a plain 400 naming `event.start_time`, not a 409. */
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
    // Per-field messages ("is missing") are useless without the parameter name.
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
 * Location and required questions are read live (cached 10 min): Calendly validates a
 * booking against the event type's current setup, which can be edited in its UI.
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

export function clearPickupEventTypeCache(): void {
  eventTypeCache = null;
}

/** True for a question that asks for the address, not a long brief that merely mentions it. */
function isAddressQuestion(name: string): boolean {
  return name.length <= 80 && /adresse|address|anschrift/i.test(name);
}

/** Matches required questions by `type`, not name (free text, gets reworded); each gets a non-empty answer. */
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
  // An unanswered required question is a hard 400; a visible marker beats a failed booking.
  const FALLBACK = 'Siehe Auftrag im Dashboard';

  const answers: { question: string; answer: string; position: number }[] = [];
  for (const q of questions) {
    let answer: string | null;
    if (q.type === 'phone_number') {
      // Calendly validates phone numbers; fail with an actionable message, not a raw 400.
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

export interface CalendlyBooking {
  eventUri: string | null;
  inviteeUri: string | null;
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
  startTime: Date;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  addressText?: string | null;
  serviceSummary?: string | null;
  trackingKey: string;
  timezone?: string;
}

/**
 * Books `startTime` for the customer. Throws CalendlyError; `isSlotUnavailable` means
 * "pick another time", anything else is an outage.
 */
export async function bookPickupAppointment(args: BookPickupArgs): Promise<CalendlyBooking> {
  if (!env.CALENDLY_PICKUP_EVENT_TYPE_URI) {
    throw new CalendlyError('CALENDLY_PICKUP_EVENT_TYPE_URI is not configured.', 503, null);
  }

  const eventType = await getPickupEventType();

  const body: Record<string, unknown> = {
    event_type: env.CALENDLY_PICKUP_EVENT_TYPE_URI,
    start_time: toCalendlyUtc(args.startTime),
    invitee: {
      name: args.customerName,
      email: args.customerEmail,
      timezone: args.timezone ?? env.CALENDLY_TIMEZONE,
    },
    // Once `tracking` is sent all six fields are required (partial = 400); only utm_content (order key) matters.
    tracking: {
      utm_source: 'dashboard',
      utm_content: args.trackingKey,
      utm_campaign: '',
      utm_medium: '',
      utm_term: '',
      salesforce_uuid: '',
    },
  };

  // Omit `location` if the event type has none; a physical location must be the event type's own text.
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

interface RawAvailableTimes {
  collection?: { status?: string; start_time?: string; invitees_remaining?: number }[];
}

/** Open start times in [start, end) as UTC ISO strings; Calendly caps the window at 7 days and rejects past starts. */
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

interface RawSchedulingLink {
  resource?: { booking_url?: string };
}

/** Single-use link the customer books themselves (fallback); `trackingKey` rides along as utm_content. */
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

const TRACKING_PREFIX = 'order';

/**
 * `order:<companySlug>:<orderId>`, round-tripped in utm_content to resolve the tenant's order
 * from a webhook (all bookings land in the one CLEANILO account).
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

export interface CalendlyWebhookPayload {
  event?: string;
  payload?: {
    uri?: string;
    email?: string;
    name?: string;
    status?: string;
    cancel_url?: string;
    reschedule_url?: string;
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
 * Verifies `calendly-webhook-signature` over the raw body: `t=<unix>,v1=<hex>` (signed `<t>.<body>`, replay-limited)
 * or a bare hex HMAC, which some accounts send. Both require a valid HMAC-SHA256.
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

/** Whole-minute UTC ISO string — the only shape Calendly accepts for start_time. */
export function toCalendlyUtc(d: Date): string {
  const ms = d.getTime();
  if (!Number.isFinite(ms)) throw new CalendlyError('Invalid date', 400, null);
  return `${new Date(Math.floor(ms / 60_000) * 60_000).toISOString().slice(0, 19)}Z`;
}

export function uuidFromUri(uri: string | null | undefined): string | null {
  if (typeof uri !== 'string') return null;
  const last = uri.replace(/\/+$/, '').split('/').pop();
  return last && last.length > 0 ? last : null;
}
