/**
 * Cancellation policy engine (ALL_06).
 *
 * Pure function — no DB, no Stripe. Given an order's current state and the
 * decision time, returns whether the cancellation is allowed and what the
 * refund mode should be:
 *
 *   mode = "full"     → automatic full refund, no admin override needed
 *   mode = "partial"  → operator can refund a fraction (default 50%)
 *   mode = "denied"   → after pickup; manual decision required (free-text)
 *
 * Rules derived from PDF §11 "Stornierungen" + Sektion 1-9 timing:
 *   - Order not yet paid                       → always cancellable (no refund needed)
 *   - Paid, > 24h before scheduled pickup/date → full refund
 *   - Paid, < 24h before scheduled pickup/date → 50% refund (admin can override)
 *   - After pickup_up status                   → denied (must be handled out-of-band)
 *
 * The "scheduled date" is `preferredDate` (Polster on-site) or, for pickup/drop_off
 * orders, the `paidAt + 24h` proxy (since carpet orders rarely have a hard date).
 * If preferredDate is null and order is paid, we use paidAt as the anchor.
 */

import type { OrderStatus } from './lib.js';

export type CancellationMode = 'full' | 'partial' | 'denied';

export interface CancellationContext {
  status: OrderStatus;
  totalCents: number;
  paidAt: Date | null;
  preferredDate: Date | null;
  /** "now" — passed in so this fn stays pure / testable. */
  now: Date;
}

export interface CancellationDecision {
  allowed: boolean;
  mode: CancellationMode;
  reasonCode:
    | 'not_yet_paid'
    | 'well_in_advance'
    | 'within_24h'
    | 'after_pickup'
    | 'terminal_state'
    | 'invalid_status';
  /** Suggested refund in cents — admin can override on partial. */
  suggestedRefundCents: number;
  /** Human-readable explanation (German, shown in the confirm modal). */
  message: string;
}

const HOUR_MS = 60 * 60 * 1000;

export function evaluateCancellation(ctx: CancellationContext): CancellationDecision {
  // Terminal states can't be cancelled.
  if (ctx.status === 'cancelled' || ctx.status === 'refunded') {
    return {
      allowed: false,
      mode: 'denied',
      reasonCode: 'terminal_state',
      suggestedRefundCents: 0,
      message: 'Auftrag ist bereits storniert oder erstattet.',
    };
  }

  // Not paid yet → free cancel, no money moved.
  if (ctx.status === 'pending' || ctx.status === 'payment_pending') {
    return {
      allowed: true,
      mode: 'full',
      reasonCode: 'not_yet_paid',
      suggestedRefundCents: 0,
      message: 'Auftrag ist noch nicht bezahlt — sofortige Stornierung ohne Rückerstattung.',
    };
  }

  // Already past pickup → operator must decide out-of-band (cleaning may have started).
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
      message:
        'Nach Abholung nur Teilerstattung nach Absprache. Bitte separat über Erstattung-Aktion erstatten.',
    };
  }

  // Paid or accepted, not yet picked up — timing decides.
  const anchor = ctx.preferredDate ?? ctx.paidAt;
  if (!anchor) {
    // Shouldn't happen for status=paid (paidAt is set on payment), but defensive.
    return {
      allowed: true,
      mode: 'partial',
      reasonCode: 'within_24h',
      suggestedRefundCents: Math.floor(ctx.totalCents / 2),
      message: 'Kein Termin gesetzt — 50% Teilerstattung vorgeschlagen, individuell anpassbar.',
    };
  }

  const hoursUntilAnchor = (anchor.getTime() - ctx.now.getTime()) / HOUR_MS;
  if (hoursUntilAnchor >= 24) {
    return {
      allowed: true,
      mode: 'full',
      reasonCode: 'well_in_advance',
      suggestedRefundCents: ctx.totalCents,
      message: 'Mehr als 24 Stunden vor Termin — automatische volle Rückerstattung.',
    };
  }

  return {
    allowed: true,
    mode: 'partial',
    reasonCode: 'within_24h',
    suggestedRefundCents: Math.floor(ctx.totalCents / 2),
    message:
      'Weniger als 24 Stunden vor Termin — 50% Teilerstattung vorgeschlagen, individuell anpassbar.',
  };
}
