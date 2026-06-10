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
  url: string;
  tag?: string;
  brandSlug?: string;
}

/** Push to all admin-level members of a brand. No-op if VAPID unconfigured. */
export async function sendPushToBrandAdmins(
  companySlug: string,
  payload: PushPayload,
): Promise<{ sent: number; failed: number; pruned: number }> {
  if (!configureOnce()) {
    return { sent: 0, failed: 0, pruned: 0 };
  }

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

  for (const { subId, sub } of recipients) {
    const webPushSub: WebPushSubscription = {
      endpoint: sub.endpoint,
      keys: { p256dh: sub.p256dh, auth: sub.auth },
    };
    try {
      await webpush.sendNotification(webPushSub, body, {
        TTL: 60 * 60 * 24,
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

/** Push to all of one user's devices. 24h TTL so offline devices still get it. */
export async function sendPushToUser(
  userId: string,
  payload: PushPayload,
  opts: { ttlSeconds?: number } = {},
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
        { TTL: opts.ttlSeconds ?? 60 * 60 * 24 },
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

/** Short-TTL variant for the "test notification" button. */
export async function sendTestPushToUser(
  userId: string,
  payload: PushPayload,
): Promise<{ sent: number; pruned: number }> {
  return sendPushToUser(userId, payload, { ttlSeconds: 60 });
}
