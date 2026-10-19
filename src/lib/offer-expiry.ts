import { and, eq, lt } from 'drizzle-orm';

import { db, pool } from '../db/index.js';
import { company } from '../db/schema/shared.js';
import { getTenantTables } from '../db/schema/tenant.js';
import { sendPushToBrandAdmins } from './push.js';

const OFFER_EXPIRY_LOCK_KEY = 7_421_003;
const DEFAULT_INTERVAL_MS = 5 * 60 * 1000;

/** Marks lapsed offers expired and tells brand admins, so a job never waits on a silent partner. */
export async function runOfferExpirySweep(now: Date = new Date()): Promise<number> {
  const client = await pool.connect();
  let total = 0;
  try {
    const res = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${OFFER_EXPIRY_LOCK_KEY}) AS locked`,
    );
    if (!res.rows[0]?.locked) return 0;
    try {
      const companies = await db.select().from(company).where(eq(company.isActive, true));
      for (const c of companies) {
        const { partnerOffers: o } = getTenantTables(c.schemaName);
        const expired = await db
          .update(o)
          .set({ status: 'expired', updatedAt: now })
          .where(and(eq(o.status, 'offered'), lt(o.expiresAt, now)))
          .returning({ id: o.id, orderId: o.orderId, inquiryId: o.inquiryId });
        total += expired.length;
        if (expired.length === 0) continue;
        const first = expired[0]!;
        await sendPushToBrandAdmins(c.slug, {
          title: `${c.name} · ${expired.length} Partner-Angebot(e) abgelaufen`,
          body: 'Bitte einen anderen Partner anfragen.',
          url:
            first.orderId != null
              ? `/auftraege/${first.orderId}`
              : `/inquiries/${c.slug}/${first.inquiryId}`,
          tag: `offers-expired:${c.slug}`,
          brandSlug: c.slug,
        }).catch((err) => console.error('[offer-expiry] push failed', c.slug, err));
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${OFFER_EXPIRY_LOCK_KEY})`);
    }
  } finally {
    client.release();
  }
  return total;
}

let workerInterval: NodeJS.Timeout | null = null;
let inFlight: Promise<unknown> | null = null;

export function startOfferExpiryWorker(opts: { intervalMs?: number } = {}): void {
  if (workerInterval) return;
  const tick = (): void => {
    if (inFlight) return;
    inFlight = runOfferExpirySweep()
      .catch((err) => console.error('[offer-expiry]', err))
      .finally(() => {
        inFlight = null;
      });
  };
  tick();
  workerInterval = setInterval(tick, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  workerInterval.unref?.();
}

export async function stopOfferExpiryWorker(): Promise<void> {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  if (inFlight) await inFlight;
}
