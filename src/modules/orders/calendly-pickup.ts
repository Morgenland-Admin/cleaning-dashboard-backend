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
 * Pickup appointments ↔ Calendly (state in `orders.metadata.calendly`). Always booked into the
 * CLEANILO event type. The order stays source of truth: a Calendly failure never blocks the confirmation.
 */

export type CalendlyPickupStatus = 'booked' | 'link_sent' | 'cancelled' | 'failed';

export interface CalendlyPickupMeta {
  status: CalendlyPickupStatus;
  /** Berlin wall-clock slot ("YYYY-MM-DDTHH:mm"). */
  slot?: string | null;
  /** UTC instant Calendly holds. */
  startTime?: string | null;
  eventUri?: string | null;
  inviteeUri?: string | null;
  cancelUrl?: string | null;
  rescheduleUrl?: string | null;
  bookingUrl?: string | null;
  source: 'dashboard' | 'webhook';
  error?: string | null;
  updatedAt: string;
}

const SLOT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;

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

export function slotToUtc(slot: string): Date | null {
  const m = SLOT_RE.exec(slot);
  if (!m) return null;
  return berlinLocalToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
}

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
  slot: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  addressText?: string | null;
  serviceSummary?: string | null;
  existing: CalendlyPickupMeta | null;
  log: { warn: (obj: object, msg?: string) => void; error: (obj: object, msg?: string) => void };
}

export interface BookConfirmedSlotResult {
  ok: boolean;
  /** Calendly not configured: nothing attempted, not an error. */
  skipped?: boolean;
  slotUnavailable?: boolean;
  error?: string;
  /** Metadata to persist; null = unchanged. */
  meta: CalendlyPickupMeta | null;
}

/** Books the confirmed slot; replaces an earlier event for this order. Never throws. */
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

  // Idempotent: this slot is already booked.
  if (
    args.existing?.status === 'booked' &&
    args.existing.slot === args.slot &&
    args.existing.eventUri
  ) {
    return { ok: true, meta: null };
  }

  // Best-effort cancel of the superseded event; a failure must not block the new booking.
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

/** Fallback: single-use scheduling link; the invitee.created webhook writes the chosen time back. */
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
