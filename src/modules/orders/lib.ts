import { nanoid } from 'nanoid';

/**
 * Status FSM (mirrors workflow ALL_09); the admin UI greys out disallowed transitions.
 * `completed` = customer confirmed receipt or 14-day auto-complete; `cancelled` = before
 * processing, refund is separate.
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

/** Allowed transitions; partially_refunded keeps the order going and can still be fully refunded. */
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
    'cancelled',
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

/** URL-safe token for /bestellung/[token]; 24 chars ≈ 143 bits of entropy. */
export function generateOrderToken(): string {
  return nanoid(24);
}
