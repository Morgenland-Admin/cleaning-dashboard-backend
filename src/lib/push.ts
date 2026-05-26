/**
 * Web Push helper. Wraps the `web-push` library:
 *   - configures VAPID lazily on first use,
 *   - exposes pushConfigured() so routes can 503 cleanly when keys missing,
 *   - sends to a list of subscriptions, auto-dropping ones the push service
 *     reports as gone (404 / 410).
 *
 * Push services (FCM, Mozilla, Apple) issue endpoints that may expire — the
 * 410 Gone response means the subscription is dead. We delete those rows so
 * they don't pile up.
 */

import webpush, { type PushSubscription as WebPushSubscription } from 'web-push';
import { and, eq, inArray } from 'drizzle-orm';

import { db } from '../db/index.js';
import { membership, pushSubscriptions as pushSubsTable } from '../db/schema/shared.js';
import { env } from '../config/env.js';

let configured = false;

function configureOnce(): boolean {
  if (configured) return true;
  if (!env.VAPID_PUBLIC_KEY || !env.VAPID_PRIVATE_KEY) return false;
  webpush.setVapidDetails(env.VAPID_SUBJECT, env.VAPID_PUBLIC_KEY, env.VAPID_PRIVATE_KEY);
  configured = true;
  return true;
}

export function pushConfigured(): boolean {
  return Boolean(env.VAPID_PUBLIC_KEY && env.VAPID_PRIVATE_KEY);
}

export interface PushPayload {
  title: string;
  body: string;
  /** Path the SW should open on click (e.g. "/contacts"). */
  url: string;
  /** Stable identifier for de-duping notifications client-side. */
  tag?: string;
  /** Optional brand for icon / colour hints. */
  brandSlug?: string;
}

/**
 * Send a push notification to every user with admin-level membership in the
 * given brand. Silent if VAPID keys aren't configured (logs a warning once).
 */
export async function sendPushToBrandAdmins(
  companySlug: string,
  payload: PushPayload,
): Promise<{ sent: number; failed: number; pruned: number }> {
  if (!configureOnce()) {
    return { sent: 0, failed: 0, pruned: 0 };
  }

  // Admin-level membership = owner | admin | manager. Viewers don't get
  // pushed by default (they can opt in later via a personal setting).
  const recipients = await db
    .select({ subId: pushSubsTable.id, sub: pushSubsTable })
    .from(pushSubsTable)
    .innerJoin(membership, eq(membership.userId, pushSubsTable.userId))
    .where(
      and(
        eq(membership.companySlug, companySlug),
        inArray(membership.role, ['owner', 'admin', 'manager']),
      ),
    );

  if (recipients.length === 0) {
    return { sent: 0, failed: 0, pruned: 0 };
  }

  const body = JSON.stringify(payload);
  const deadIds: number[] = [];
  let sent = 0;
  let failed = 0;

  // Sequential is fine — we don't expect more than a handful of subs per
  // brand in the foreseeable future. Parallel would just risk hitting a
  // push service rate limit without a measurable win.
  for (const { subId, sub } of recipients) {
    const webPushSub: WebPushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      await webpush.sendNotification(webPushSub, body, {
        TTL: 60 * 60 * 24, // 24h — beyond that, the alert is stale anyway
        urgency: 'normal',
      });
      sent += 1;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) {
        deadIds.push(subId);
      } else {
        failed += 1;
      }
    }
  }

  if (deadIds.length > 0) {
    await db.delete(pushSubsTable).where(inArray(pushSubsTable.id, deadIds));
  }

  return { sent, failed, pruned: deadIds.length };
}

/** Alias for clarity at call sites that aren't about "tests". */
export const sendPushToUser = sendTestPushToUser;

/** Send a push to a single user — used by the "Send test" button and the
 *  task-assignment / task-comment notifications. */
export async function sendTestPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  if (!configureOnce()) return { sent: 0, pruned: 0 };

  const subs = await db.select().from(pushSubsTable).where(eq(pushSubsTable.userId, userId));

  const body = JSON.stringify(payload);
  const deadIds: number[] = [];
  let sent = 0;

  for (const sub of subs) {
    try {
      await webpush.sendNotification(
        {
          endpoint: sub.endpoint,
          keys: { p256dh: sub.p256dh, auth: sub.auth },
        },
        body,
        { TTL: 60 },
      );
      sent += 1;
    } catch (err) {
      const status = (err as { statusCode?: number }).statusCode;
      if (status === 404 || status === 410) deadIds.push(sub.id);
    }
  }

  if (deadIds.length > 0) {
    await db.delete(pushSubsTable).where(inArray(pushSubsTable.id, deadIds));
  }

  return { sent, pruned: deadIds.length };
}
