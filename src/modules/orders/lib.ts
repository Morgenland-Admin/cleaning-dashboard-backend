import { nanoid } from 'nanoid';

/**
 * Status FSM mirroring workflow ALL_09. The status of an order can only move
 * along these directed edges; the admin UI greys out transitions that aren't
 * allowed from the current state.
 *
 * pending           — order row exists, no payment yet (DRAFT before checkout)
 * payment_pending   — Stripe Checkout Session created, waiting for completion
 * paid              — Stripe webhook reported success; ready for admin to accept
 * accepted          — admin acknowledged + scheduled
 * picked_up         — driver collected the carpet (or customer dropped off)
 * in_cleaning       — workshop is processing
 * ready             — done, awaiting delivery / pickup
 * delivered         — handed back to customer
 * completed         — customer confirmed receipt (or 14-day auto-complete)
 * cancelled         — terminated before payment/processing (refund handled separately)
 * refunded          — money returned, terminal
 */
export type OrderStatus =
  | 'pending'
  | 'payment_pending'
  | 'paid'
  | 'accepted'
  | 'picked_up'
  | 'in_cleaning'
  | 'ready'
  | 'delivered'
  | 'completed'
  | 'cancelled'
  | 'partially_refunded'
  | 'refunded';

export const ORDER_STATUSES: readonly OrderStatus[] = [
  'pending',
  'payment_pending',
  'paid',
  'accepted',
  'picked_up',
  'in_cleaning',
  'ready',
  'delivered',
  'completed',
  'cancelled',
  'partially_refunded',
  'refunded',
];

/**
 * Allowed forward + side transitions. Any paid state can move to
 * partially_refunded (some money back, order continues) or refunded (terminal).
 * A partially_refunded order can still be fully refunded later.
 */
const FORWARD: Record<OrderStatus, OrderStatus[]> = {
  pending: ['payment_pending', 'cancelled'],
  payment_pending: ['paid', 'cancelled'],
  paid: ['accepted', 'cancelled', 'partially_refunded', 'refunded'],
  accepted: ['picked_up', 'cancelled', 'partially_refunded', 'refunded'],
  picked_up: ['in_cleaning', 'cancelled', 'partially_refunded', 'refunded'],
  in_cleaning: ['ready', 'cancelled', 'partially_refunded', 'refunded'],
  ready: ['delivered', 'cancelled', 'partially_refunded', 'refunded'],
  delivered: ['completed', 'partially_refunded', 'refunded'],
  completed: ['partially_refunded', 'refunded'],
  cancelled: [],
  partially_refunded: [
    'accepted',
    'picked_up',
    'in_cleaning',
    'ready',
    'delivered',
    'completed',
    'refunded',
  ],
  refunded: [],
};

export function canTransition(from: OrderStatus, to: OrderStatus): boolean {
  return FORWARD[from]?.includes(to) ?? false;
}

export function allowedNextStatuses(from: OrderStatus): OrderStatus[] {
  return FORWARD[from] ?? [];
}

/** Map a status to the order column that stamps its at-time. Falsy = no col. */
export function statusTimestampColumn(s: OrderStatus): string | null {
  switch (s) {
    case 'paid':
      return 'paidAt';
    case 'accepted':
      return 'acceptedAt';
    case 'picked_up':
      return 'pickedUpAt';
    case 'in_cleaning':
      return 'inCleaningAt';
    case 'ready':
      return 'readyAt';
    case 'delivered':
      return 'deliveredAt';
    case 'completed':
      return 'completedAt';
    case 'cancelled':
      return 'cancelledAt';
    case 'refunded':
      return 'refundedAt';
    default:
      return null;
  }
}

/**
 * URL-safe random token for /bestellung/[token]. 24 chars = ~143 bits of
 * entropy — same order of magnitude as a UUIDv4, but URL-safe without
 * any percent-encoding. Nanoid's default alphabet excludes ambiguous chars.
 */
export function generateOrderToken(): string {
  return nanoid(24);
}
