import { eq } from 'drizzle-orm';
import { db } from '../db/index.js';
import { emailLog, type EmailLogEvent } from '../db/schema/shared.js';

/** Permanent record of outgoing mail (`email_log`): `sendEmail` writes one row per send, any outcome. */

export type EmailKind =
  | 'password_reset'
  | 'invite'
  | 'task_assigned'
  | 'task_comment'
  | 'staff_notification'
  | 'contact_ack'
  | 'contact_reply'
  | 'inquiry_ack'
  | 'quote'
  | 'order_confirmation'
  | 'order_status'
  | 'order_message'
  | 'customer_message'
  | 'payment_request'
  | 'appointment_confirmed'
  | 'pickup_scheduling'
  | 'receipt'
  | 'invoice'
  | 'dunning'
  | 'newsletter_confirm'
  | 'partner_offer'
  | 'partner_assigned'
  | 'partner_document'
  | 'partner_application_ack'
  | 'partner_activated';

export type EmailRefType =
  | 'order'
  | 'invoice'
  | 'inquiry'
  | 'contact'
  | 'task'
  | 'partner'
  | 'customer';

export interface EmailLogTag {
  /** Null only for platform mail (password reset). */
  companySlug: string | null;
  kind: EmailKind;
  /** Record the mail is about, in the brand's tenant schema. */
  refType?: EmailRefType;
  refId?: number;
  sentByUserId?: string | null;
}

/** Bodies with a live secret link (reset / invite / opt-in) are not stored: log readers could use it. */
const SECRET_BEARING_KINDS: ReadonlySet<EmailKind> = new Set([
  'password_reset',
  'invite',
  'newsletter_confirm',
]);

export function storesBody(kind: EmailKind): boolean {
  return !SECRET_BEARING_KINDS.has(kind);
}

export type SendOutcome = 'sent' | 'failed' | 'skipped' | 'blocked';

export interface LogSendInput {
  tag: EmailLogTag;
  to: string[];
  from: string;
  replyTo?: string;
  subject: string;
  html: string;
  attachments?: Array<{ filename: string; content: Buffer }>;
  status: SendOutcome;
  resendId?: string;
  error?: string;
}

/** Never throws: a logging failure must not fail a send. */
export async function logSend(input: LogSendInput): Promise<void> {
  try {
    await db.insert(emailLog).values({
      companySlug: input.tag.companySlug,
      kind: input.tag.kind,
      toAddress: input.to.join(', '),
      fromAddress: input.from,
      replyTo: input.replyTo ?? null,
      subject: input.subject,
      html: storesBody(input.tag.kind) ? input.html : null,
      attachments: (input.attachments ?? []).map((a) => ({
        filename: a.filename,
        size: a.content.length,
      })),
      status: input.status,
      error: input.error ?? null,
      resendId: input.resendId ?? null,
      deliveryStatus: null,
      refType: input.tag.refType ?? null,
      refId: input.tag.refId ?? null,
      sentByUserId: input.tag.sentByUserId ?? null,
    });
  } catch (err) {
    console.error('[email] failed to write email_log row:', err);
  }
}

/** Ranked so out-of-order webhooks settle: a late "delivery_delayed" never overwrites "delivered"; a later bounce or complaint wins. */
const DELIVERY_RANK: Record<string, number> = {
  sent: 1,
  delivery_delayed: 2,
  delivered: 3,
  suppressed: 4,
  failed: 4,
  bounced: 5,
  complained: 6,
};

/** Newest N kept; opens can fire many times. */
export const MAX_EVENTS_PER_EMAIL = 30;

export interface DeliveryState {
  deliveryStatus: string | null;
  deliveredAt: Date | null;
  openedAt: Date | null;
  clickedAt: Date | null;
  events: EmailLogEvent[];
}

export interface DeliveryEvent {
  type: string;
  at: Date;
  detail?: string;
}

function earliest(current: Date | null, next: Date): Date {
  return current && current <= next ? current : next;
}

export function applyDeliveryEvent(state: DeliveryState, event: DeliveryEvent): DeliveryState {
  const atIso = event.at.toISOString();
  // Resend retries until 2xx, so the same event can arrive twice.
  if (state.events.some((e) => e.type === event.type && e.at === atIso)) return state;

  const next: DeliveryState = { ...state };
  const entry: EmailLogEvent = { type: event.type, at: atIso };
  if (event.detail) entry.detail = event.detail;
  next.events = [...state.events, entry]
    .sort((a, b) => a.at.localeCompare(b.at))
    .slice(-MAX_EVENTS_PER_EMAIL);

  // An open or click proves delivery even if "delivered" never arrived.
  const statusFromEvent =
    event.type === 'opened' || event.type === 'clicked' ? 'delivered' : event.type;
  const rank = DELIVERY_RANK[statusFromEvent];
  if (rank !== undefined) {
    const currentRank = state.deliveryStatus ? (DELIVERY_RANK[state.deliveryStatus] ?? 0) : 0;
    if (rank >= currentRank) next.deliveryStatus = statusFromEvent;
  }

  if (statusFromEvent === 'delivered') next.deliveredAt = earliest(state.deliveredAt, event.at);
  if (event.type === 'opened') next.openedAt = earliest(state.openedAt, event.at);
  if (event.type === 'clicked') {
    next.clickedAt = earliest(state.clickedAt, event.at);
    next.openedAt = earliest(next.openedAt, event.at);
  }
  return next;
}

/** Returns false when no row has that Resend id (sent before logging, or by another environment on the same account). */
export async function recordDeliveryEvent(
  resendId: string,
  event: DeliveryEvent,
): Promise<boolean> {
  return db.transaction(async (tx) => {
    // Row lock: "delivered" and "opened" often arrive in the same second.
    const [row] = await tx
      .select({
        id: emailLog.id,
        deliveryStatus: emailLog.deliveryStatus,
        deliveredAt: emailLog.deliveredAt,
        openedAt: emailLog.openedAt,
        clickedAt: emailLog.clickedAt,
        events: emailLog.events,
      })
      .from(emailLog)
      .where(eq(emailLog.resendId, resendId))
      .limit(1)
      .for('update');
    if (!row) return false;

    const next = applyDeliveryEvent(row, event);
    if (next === row) return true;
    await tx
      .update(emailLog)
      .set({
        deliveryStatus: next.deliveryStatus,
        deliveredAt: next.deliveredAt,
        openedAt: next.openedAt,
        clickedAt: next.clickedAt,
        events: next.events,
        updatedAt: new Date(),
      })
      .where(eq(emailLog.id, row.id));
    return true;
  });
}
