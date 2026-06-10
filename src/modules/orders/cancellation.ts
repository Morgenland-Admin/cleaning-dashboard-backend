import type { OrderStatus } from './lib.js';

export type CancellationMode = 'full' | 'partial' | 'denied';

export interface CancellationContext {
  status: OrderStatus;
  totalCents: number;
  /** Cents already refunded — caps further refunds. */
  refundedAmountCents: number;
  paidAt: Date | null;
  /** Date-only fallback when no exact slot was confirmed. */
  preferredDate: Date | null;
  /** Confirmed appointment "YYYY-MM-DDTHH:mm" in Europe/Berlin local time. */
  confirmedSlot: string | null;
  now: Date;
}

export interface CancellationDecision {
  allowed: boolean;
  mode: CancellationMode;
  reasonCode:
    | 'not_yet_paid'
    | 'well_in_advance'
    | 'within_24h'
    | 'no_appointment'
    | 'after_pickup'
    | 'terminal_state'
    | 'invalid_status';
  suggestedRefundCents: number;
  /** Hard ceiling for any refund: total minus what was already refunded. */
  maxRefundCents: number;
  message: string;
}

const HOUR_MS = 60 * 60 * 1000;
const SLOT_RE = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}):(\d{2})$/;
const DATE_RE = /^(\d{4})-(\d{2})-(\d{2})/;

/** Offset (ms) that Europe/Berlin is ahead of UTC at the given instant. */
function berlinOffsetMs(utcDate: Date): number {
  const dtf = new Intl.DateTimeFormat('en-US', {
    timeZone: 'Europe/Berlin',
    year: 'numeric',
    month: '2-digit',
    day: '2-digit',
    hour: '2-digit',
    minute: '2-digit',
    second: '2-digit',
    hour12: false,
  });
  const parts: Record<string, string> = {};
  for (const p of dtf.formatToParts(utcDate)) parts[p.type] = p.value;
  const asUtc = Date.UTC(
    Number(parts.year),
    Number(parts.month) - 1,
    Number(parts.day),
    Number(parts.hour === '24' ? '0' : parts.hour),
    Number(parts.minute),
    Number(parts.second),
  );
  return asUtc - utcDate.getTime();
}

/** Interpret naive Europe/Berlin wall-clock components as a UTC instant. */
export function berlinLocalToUtc(
  year: number,
  month: number,
  day: number,
  hour: number,
  minute: number,
): Date {
  const naive = Date.UTC(year, month - 1, day, hour, minute);
  // Two passes to land correctly around DST switches.
  const guess = naive - berlinOffsetMs(new Date(naive));
  return new Date(naive - berlinOffsetMs(new Date(guess)));
}

/** Service-start instant for the 24h rule: confirmed slot → end of preferredDate (Berlin) → null. */
export function resolveCancellationAnchor(ctx: {
  confirmedSlot: string | null;
  preferredDate: Date | null;
}): Date | null {
  if (ctx.confirmedSlot) {
    const m = SLOT_RE.exec(ctx.confirmedSlot);
    if (m) {
      return berlinLocalToUtc(Number(m[1]), Number(m[2]), Number(m[3]), Number(m[4]), Number(m[5]));
    }
  }
  if (ctx.preferredDate) {
    const m = DATE_RE.exec(ctx.preferredDate.toISOString());
    if (m) {
      return berlinLocalToUtc(Number(m[1]), Number(m[2]), Number(m[3]), 23, 59);
    }
  }
  return null;
}

export function evaluateCancellation(ctx: CancellationContext): CancellationDecision {
  const remainingCents = Math.max(0, ctx.totalCents - Math.max(0, ctx.refundedAmountCents));

  if (ctx.status === 'cancelled' || ctx.status === 'refunded') {
    return {
      allowed: false,
      mode: 'denied',
      reasonCode: 'terminal_state',
      suggestedRefundCents: 0,
      maxRefundCents: 0,
      message: 'Auftrag ist bereits storniert oder erstattet.',
    };
  }

  // Not paid yet — includes unpaid after-service orders already in 'accepted'.
  if (ctx.status === 'pending' || ctx.status === 'payment_pending' || ctx.paidAt === null) {
    return {
      allowed: true,
      mode: 'full',
      reasonCode: 'not_yet_paid',
      suggestedRefundCents: 0,
      maxRefundCents: 0,
      message: 'Auftrag ist noch nicht bezahlt — sofortige Stornierung ohne Rückerstattung.',
    };
  }

  if (
    ctx.status === 'picked_up' ||
    ctx.status === 'in_cleaning' ||
    ctx.status === 'ready' ||
    ctx.status === 'delivered' ||
    ctx.status === 'completed'
  ) {
    return {
      allowed: false,
      mode: 'denied',
      reasonCode: 'after_pickup',
      suggestedRefundCents: 0,
      maxRefundCents: remainingCents,
      message:
        'Nach Abholung nur Teilerstattung nach Absprache. Bitte separat über Erstattung-Aktion erstatten.',
    };
  }

  // Paid states: refunds capped at the not-yet-refunded remainder.
  const anchor = resolveCancellationAnchor(ctx);
  if (!anchor) {
    // Paid but unscheduled — Widerrufsrecht-safe default is a full refund.
    return {
      allowed: true,
      mode: 'full',
      reasonCode: 'no_appointment',
      suggestedRefundCents: remainingCents,
      maxRefundCents: remainingCents,
      message:
        'Kein Termin vereinbart — volle Rückerstattung des offenen Betrags vorgeschlagen, individuell anpassbar.',
    };
  }

  const hoursUntilAnchor = (anchor.getTime() - ctx.now.getTime()) / HOUR_MS;
  if (hoursUntilAnchor >= 24) {
    return {
      allowed: true,
      mode: 'full',
      reasonCode: 'well_in_advance',
      suggestedRefundCents: remainingCents,
      maxRefundCents: remainingCents,
      message: 'Mehr als 24 Stunden vor Termin — automatische volle Rückerstattung.',
    };
  }

  return {
    allowed: true,
    mode: 'partial',
    reasonCode: 'within_24h',
    suggestedRefundCents: Math.min(remainingCents, Math.floor(ctx.totalCents / 2)),
    maxRefundCents: remainingCents,
    message:
      'Weniger als 24 Stunden vor Termin — 50% Teilerstattung vorgeschlagen, individuell anpassbar.',
  };
}
