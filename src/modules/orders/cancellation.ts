import type { OrderStatus } from './lib.js';

export type CancellationMode = 'full' | 'partial' | 'denied';

export interface CancellationContext {
  status: OrderStatus;
  totalCents: number;
  paidAt: Date | null;
  preferredDate: Date | null;
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
  suggestedRefundCents: number;
  message: string;
}

const HOUR_MS = 60 * 60 * 1000;

export function evaluateCancellation(ctx: CancellationContext): CancellationDecision {
  if (ctx.status === 'cancelled' || ctx.status === 'refunded') {
    return {
      allowed: false,
      mode: 'denied',
      reasonCode: 'terminal_state',
      suggestedRefundCents: 0,
      message: 'Auftrag ist bereits storniert oder erstattet.',
    };
  }

  if (ctx.status === 'pending' || ctx.status === 'payment_pending') {
    return {
      allowed: true,
      mode: 'full',
      reasonCode: 'not_yet_paid',
      suggestedRefundCents: 0,
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
      message:
        'Nach Abholung nur Teilerstattung nach Absprache. Bitte separat über Erstattung-Aktion erstatten.',
    };
  }

  const anchor = ctx.preferredDate ?? ctx.paidAt;
  if (!anchor) {
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
