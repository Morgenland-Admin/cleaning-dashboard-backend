import {
  bookPickupAppointment,
  buildTrackingKey,
  calendlyBookingConfigured,
  cancelPickupAppointment,
  CalendlyError,
  createPickupSchedulingLink,
} from '../../lib/calendly.js';
import { berlinLocalToUtc } from './cancellation.js';

/**
 * Pickup appointments ↔ Calendly. Kept out of routes.ts because the state lives
 * in `orders.metadata.calendly` and needs a single owner.
 *
 * Route (decided 2026-08-06, see docs/calendly-pickups.md): the operator confirms
 * a slot in the dashboard and we book it into the CLEANILO Calendly event type via
 * the Scheduling API. Calendly owns the write to the CLEANILO Google Calendar, so
 * the confirmed pickup shows up there automatically — no Google credentials, and
 * Calendly's reminders / cancel / reschedule links come along for free.
 *
 * Our order stays the source of truth: a Calendly failure never blocks or rolls
 * back the confirmation, it is reported back to the operator instead.
 */

export type CalendlyPickupStatus = 'booked' | 'link_sent' | 'cancelled' | 'failed';

export interface CalendlyPickupMeta {
  status: CalendlyPickupStatus;
  /** Berlin wall-clock slot ("YYYY-MM-DDTHH:mm") this booking represents. */
  slot?: string | null;
  /** UTC instant Calendly holds. */
  startTime?: string | null;
  eventUri?: string | null;
  inviteeUri?: string | null;
  cancelUrl?: string | null;
  rescheduleUrl?: string | null;
  /** Single-use scheduling URL, when the customer books themselves. */
  bookingUrl?: string | null;
  /** Who wrote this state: the dashboard action or an incoming Calendly webhook. */
  source: 'dashboard' | 'webhook';
  /** Operator-facing failure reason for status 'failed'. */
  error?: string | null;
  updatedAt: string;
}

const SLOT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

/** Read the Calendly block out of an order's metadata, if it looks like ours. */
export function readCalendlyMeta(metadata: unknown): CalendlyPickupMeta | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const raw = (metadata as { calendly?: unknown }).calendly;
  if (!raw || typeof raw !== 'object') return null;
  const status = (raw as { status?: unknown }).status;
  if (
    status !== 'booked' &&
    status !== 'link_sent' &&
    status !== 'cancelled' &&
    status !== 'failed'
  ) {
    return null;
  }
  return raw as CalendlyPickupMeta;
}

/** "YYYY-MM-DDTHH:mm" (Europe/Berlin wall clock) → the UTC instant it denotes. */
export function slotToUtc(slot: string): Date | null {
  const m = SLOT_RE.exec(slot);
  if (!m) return null;
  return berlinLocalToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

/**
 * UTC instant → "YYYY-MM-DDTHH:mm" Europe/Berlin wall clock, the shape the rest of
 * the app stores slots in. Used when a booking arrives from Calendly rather than
 * from us.
 */
export function utcToBerlinSlot(utcIso: string): string | null {
  const d = new Date(utcIso);
  if (Number.isNaN(d.getTime())) return null;
  const parts: Record<string, string> = {};
  for (const p of new Intl.DateTimeFormat('en-GB', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d)) {
    parts[p.type] = p.value;
  }
  if (!parts.year || !parts.month || !parts.day) return null;
  // en-GB renders midnight as "24" in some ICU versions — normalise it.
  const hour = parts.hour === '24' ? '00' : parts.hour;
  return `${parts.year}-${parts.month}-${parts.day}T${hour}:${parts.minute}`;
}

export interface BookConfirmedSlotArgs {
  companySlug: string;
  orderId: number;
  /** Berlin wall-clock slot the operator confirmed. */
  slot: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  /** Service address — answers the event type's address question. */
  addressText?: string | null;
  /** What the job is, for the event type's "what do you need" question. */
  serviceSummary?: string | null;
  /** Existing Calendly state, so a re-confirmation replaces the old event. */
  existing: CalendlyPickupMeta | null;
  log: { warn: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void };
}

export interface BookConfirmedSlotResult {
  /** Whether a Calendly booking now exists for this slot. */
  ok: boolean;
  /** Not configured at all — nothing attempted, nothing to report as an error. */
  skipped?: boolean;
  /** Slot is no longer bookable in Calendly — the operator must pick another. */
  slotUnavailable?: boolean;
  error?: string;
  /** Metadata to persist, or null when nothing changed. */
  meta: CalendlyPickupMeta | null;
}

/**
 * Book the operator-confirmed slot into the CLEANILO Calendly calendar. Replaces
 * any event previously booked for this order (re-confirmation). Never throws.
 */
export async function bookConfirmedSlot(
  args: BookConfirmedSlotArgs,
): Promise<BookConfirmedSlotResult> {
  if (!calendlyBookingConfigured) {
    return { ok: false, skipped: true, meta: null };
  }

  const startTime = slotToUtc(args.slot);
  if (!startTime) {
    return { ok: false, error: `Unlesbarer Termin: ${args.slot}`, meta: null };
  }

  // Already booked for exactly this slot — don't create a duplicate event.
  if (
    args.existing?.status === 'booked' &&
    args.existing.slot === args.slot &&
    args.existing.eventUri
  ) {
    return { ok: true, meta: null };
  }

  // Re-confirmation of a different time: drop the stale event first so the
  // calendar doesn't keep both. Best-effort — a failure here must not stop the
  // new booking, it just leaves one entry to clear by hand.
  if (args.existing?.status === 'booked' && args.existing.eventUri) {
    const cancelled = await cancelPickupAppointment(
      args.existing.eventUri,
      'Termin wurde verschoben',
    );
    if (!cancelled.ok) {
      args.log.warn(
        { orderId: args.orderId, eventUri: args.existing.eventUri, error: cancelled.error },
        'calendly: could not cancel superseded pickup event',
      );
    }
  }

  const now = new Date().toISOString();
  try {
    const booking = await bookPickupAppointment({
      startTime,
      customerName: args.customerName,
      customerEmail: args.customerEmail,
      customerPhone: args.customerPhone,
      addressText: args.addressText,
      serviceSummary: args.serviceSummary,
      trackingKey: buildTrackingKey(args.companySlug, args.orderId),
    });
    return {
      ok: true,
      meta: {
        status: 'booked',
        slot: args.slot,
        startTime: booking.startTime ?? startTime.toISOString(),
        eventUri: booking.eventUri,
        inviteeUri: booking.inviteeUri,
        cancelUrl: booking.cancelUrl,
        rescheduleUrl: booking.rescheduleUrl,
        source: 'dashboard',
        error: null,
        updatedAt: now,
      },
    };
  } catch (err) {
    const slotUnavailable = err instanceof CalendlyError && err.isSlotUnavailable;
    const message = err instanceof Error ? err.message : String(err);
    args.log.error(
      { orderId: args.orderId, err, slot: args.slot },
      'calendly: pickup booking failed',
    );
    return {
      ok: false,
      slotUnavailable,
      error: slotUnavailable
        ? 'Calendly hat den Termin abgelehnt — die Zeit ist im CLEANILO-Kalender nicht (mehr) frei. Bitte eine andere Zeit bestätigen.'
        : 'Calendly-Buchung fehlgeschlagen. Der Termin ist im Auftrag bestätigt, steht aber noch nicht im CLEANILO-Kalender.',
      meta: {
        status: 'failed',
        slot: args.slot,
        startTime: startTime.toISOString(),
        source: 'dashboard',
        error: message.slice(0, 500),
        updatedAt: now,
      },
    };
  }
}

export interface CreateBookingLinkResult {
  ok: boolean;
  skipped?: boolean;
  error?: string;
  bookingUrl?: string;
  meta: CalendlyPickupMeta | null;
}

/**
 * Fallback route: a single-use CLEANILO scheduling link the customer books
 * themselves. Calendly still writes the event to the CLEANILO Google Calendar and
 * the invitee.created webhook writes the chosen time back onto the order.
 */
export async function createBookingLink(args: {
  companySlug: string;
  orderId: number;
}): Promise<CreateBookingLinkResult> {
  if (!calendlyBookingConfigured) {
    return { ok: false, skipped: true, meta: null };
  }
  try {
    const bookingUrl = await createPickupSchedulingLink(
      buildTrackingKey(args.companySlug, args.orderId),
    );
    return {
      ok: true,
      bookingUrl,
      meta: {
        status: 'link_sent',
        bookingUrl,
        source: 'dashboard',
        error: null,
        updatedAt: new Date().toISOString(),
      },
    };
  } catch (err) {
    return {
      ok: false,
      error: err instanceof Error ? err.message : String(err),
      meta: null,
    };
  }
}
