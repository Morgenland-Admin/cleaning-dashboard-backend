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

export type PartnerStep = 'accepted' | 'picked_up' | 'in_cleaning' | 'ready' | 'delivered';

interface PartnerProgress {
  status: string;
  acceptedAt?: Date | null;
  pickedUpAt?: Date | null;
  inCleaningAt?: Date | null;
  readyAt?: Date | null;
  deliveredAt?: Date | null;
  completedAt?: Date | null;
}

/** The single status the assigned partner may set next; null when nothing is theirs to do. */
export function partnerNextStatus(order: PartnerProgress): PartnerStep | null {
  switch (order.status) {
    // `paid` → `accepted` is the team's call, not the partner's.
    case 'accepted':
      return 'picked_up';
    case 'picked_up':
      return 'in_cleaning';
    case 'in_cleaning':
      return 'ready';
    case 'ready':
      return 'delivered';
    case 'partially_refunded':
      // Resumes after the furthest step reached; the FSM alone would allow going backwards.
      if (order.deliveredAt || order.completedAt) return null;
      if (order.readyAt) return 'delivered';
      if (order.inCleaningAt) return 'ready';
      if (order.pickedUpAt) return 'in_cleaning';
      return order.acceptedAt ? 'picked_up' : null;
    default:
      return null;
  }
}

/** Orders that are finished from the partner's side (their last step is `delivered`). */
export const PARTNER_DONE_STATUSES: readonly OrderStatus[] = [
  'delivered',
  'completed',
  'cancelled',
  'refunded',
];

export function isPartnerDone(order: PartnerProgress): boolean {
  if ((PARTNER_DONE_STATUSES as readonly string[]).includes(order.status)) return true;
  return order.status === 'partially_refunded' && !!(order.deliveredAt || order.completedAt);
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

export const KIND_LABEL: Record<string, string> = {
  teppichreinigung: 'Teppichreinigung',
  teppichreparatur: 'Teppichreparatur',
  polsterreinigung: 'Polsterreinigung (Vor-Ort)',
  teppichbodenreinigung: 'Teppichbodenreinigung (Vor-Ort)',
};

/** "YYYY/000123" from the creation year — never the current year. */
export function formatOrderNumber(id: number, createdAt: Date): string {
  return `${createdAt.getUTCFullYear()}/${String(id).padStart(6, '0')}`;
}

/** Persisted order number; createdAt-based fallback for legacy rows. */
export function orderNumberOf(row: {
  id: number;
  orderNumber?: string | null;
  createdAt?: Date | null;
}): string {
  if (row.orderNumber) return row.orderNumber;
  return formatOrderNumber(row.id, row.createdAt ?? new Date());
}

/** Done or dead orders; every other status is still in flight ("open"). */
export const CLOSED_ORDER_STATUSES: readonly OrderStatus[] = ['completed', 'cancelled', 'refunded'];

/** Substring pattern for ILIKE with the wildcard characters escaped. */
export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** "2026/000123" → 123: rows without a stored number display one derived from the id. */
export function derivedOrderId(q: string): number | null {
  const m = /^(\d{4})\s*\/\s*(\d{1,9})$/.exec(q.trim());
  if (!m) return null;
  const n = Number(m[2]);
  return n > 0 && n <= 2147483647 ? n : null;
}
