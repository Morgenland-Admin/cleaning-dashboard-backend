import type { FastifyBaseLogger, FastifyInstance } from 'fastify';
import { and, asc, eq, inArray, lt } from 'drizzle-orm';

import { db, pool } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';
import {
  capturePayPalOrder,
  getPayPalOrder,
  paypalConfigured,
  type PayPalCapture,
} from '../../lib/paypal.js';
import { markOrderCancelled, markOrderPaidPayPal } from './routes.js';

/** PayPal expires unapproved orders after 3 h; the margin covers a buyer still in the window. */
export const STALE_AFTER_MS = 3.5 * 60 * 60 * 1000;
export const ABANDONED_REASON = 'PayPal-Zahlung nicht abgeschlossen';
const PER_TENANT_BATCH = 50;
const DEFAULT_INTERVAL_MS = 30 * 60 * 1000;
const PAYPAL_EXPIRY_LOCK_KEY = 7_421_004;

export interface StalePayPalOrder {
  id: number;
  paypalOrderId: string | null;
}

export interface PayPalExpiryDeps {
  configured: boolean;
  now: Date;
  withLock: (fn: () => Promise<void>) => Promise<void>;
  listTenants: () => Promise<{ slug: string; schemaName: string }[]>;
  findStale: (schemaName: string, cutoff: Date) => Promise<StalePayPalOrder[]>;
  getOrder: (paypalOrderId: string) => Promise<PayPalCapture>;
  capture: (paypalOrderId: string, idempotencyKey: string) => Promise<PayPalCapture>;
  markPaid: (slug: string, orderId: number, capture: PaidCapture) => Promise<void>;
  markCancelled: (slug: string, orderId: number, reason: string) => Promise<void>;
  log: Pick<FastifyBaseLogger, 'info' | 'warn' | 'error'>;
}

type PaidCapture = Parameters<typeof markOrderPaidPayPal>[3];

export interface PayPalExpiryResult {
  paid: number;
  cancelled: number;
  kept: number;
}

async function lookupPayPalOrder(
  deps: PayPalExpiryDeps,
  paypalOrderId: string,
): Promise<PayPalCapture | null> {
  try {
    return await deps.getOrder(paypalOrderId);
  } catch (err) {
    if ((err as { status?: number }).status === 404) return null;
    throw err;
  }
}

async function settleOrder(
  deps: PayPalExpiryDeps,
  slug: string,
  order: StalePayPalOrder,
): Promise<keyof PayPalExpiryResult> {
  let pp = order.paypalOrderId ? await lookupPayPalOrder(deps, order.paypalOrderId) : null;

  if (pp?.status === 'APPROVED') {
    pp = await deps.capture(order.paypalOrderId!, `pp_capture_${slug}_${order.id}`);
  }

  if (pp?.captureStatus === 'COMPLETED') {
    await deps.markPaid(slug, order.id, {
      amountCents: pp.amountCents,
      status: pp.status,
      orderId: order.paypalOrderId,
      captureId: pp.captureId,
    });
    return 'paid';
  }

  // Approved/completed but not settled (e.g. capture PENDING): money may still arrive via webhook.
  if (pp?.status === 'APPROVED' || pp?.status === 'COMPLETED') {
    deps.log.warn(
      { slug, orderId: order.id, status: pp.status, captureStatus: pp.captureStatus },
      '[paypal-expiry] PayPal order not settled — left payment_pending',
    );
    return 'kept';
  }

  await deps.markCancelled(slug, order.id, ABANDONED_REASON);
  return 'cancelled';
}

/** Settles upfront PayPal orders the buyer never finished: capture/mark paid if PayPal has the money, else cancel. */
export async function runPayPalExpirySweep(deps: PayPalExpiryDeps): Promise<PayPalExpiryResult> {
  const result: PayPalExpiryResult = { paid: 0, cancelled: 0, kept: 0 };
  if (!deps.configured) return result;

  const cutoff = new Date(deps.now.getTime() - STALE_AFTER_MS);
  await deps.withLock(async () => {
    for (const tenant of await deps.listTenants()) {
      let stale: StalePayPalOrder[];
      try {
        stale = await deps.findStale(tenant.schemaName, cutoff);
      } catch (err) {
        deps.log.error({ err, slug: tenant.slug }, '[paypal-expiry] tenant sweep failed');
        continue;
      }
      for (const order of stale) {
        try {
          result[await settleOrder(deps, tenant.slug, order)] += 1;
        } catch (err) {
          result.kept += 1;
          deps.log.error(
            { err, slug: tenant.slug, orderId: order.id },
            '[paypal-expiry] order failed',
          );
        }
      }
    }
  });

  if (result.paid || result.cancelled) deps.log.info(result, '[paypal-expiry] sweep done');
  return result;
}

async function withSweepLock(fn: () => Promise<void>): Promise<void> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${PAYPAL_EXPIRY_LOCK_KEY}) AS locked`,
    );
    if (!res.rows[0]?.locked) return;
    try {
      await fn();
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${PAYPAL_EXPIRY_LOCK_KEY})`);
    }
  } finally {
    client.release();
  }
}

function liveDeps(app: FastifyInstance): PayPalExpiryDeps {
  return {
    configured: paypalConfigured,
    now: new Date(),
    withLock: withSweepLock,
    listTenants: () =>
      db
        .select({ slug: company.slug, schemaName: company.schemaName })
        .from(company)
        .where(eq(company.isActive, true)),
    findStale: (schemaName, cutoff) => {
      const { orders } = getTenantTables(schemaName);
      return db
        .select({ id: orders.id, paypalOrderId: orders.paypalOrderId })
        .from(orders)
        .where(
          and(
            eq(orders.paymentProvider, 'paypal'),
            eq(orders.paymentMode, 'upfront'),
            inArray(orders.status, ['pending', 'payment_pending']),
            lt(orders.createdAt, cutoff),
          ),
        )
        .orderBy(asc(orders.createdAt))
        .limit(PER_TENANT_BATCH);
    },
    getOrder: getPayPalOrder,
    capture: capturePayPalOrder,
    markPaid: (slug, orderId, capture) => markOrderPaidPayPal(app, slug, orderId, capture),
    markCancelled: (slug, orderId, reason) => markOrderCancelled(app, slug, orderId, reason),
    log: app.log,
  };
}

let workerInterval: NodeJS.Timeout | null = null;
let inFlight: Promise<unknown> | null = null;

export function startPayPalExpiryWorker(
  app: FastifyInstance,
  opts: { intervalMs?: number } = {},
): void {
  if (workerInterval || !paypalConfigured) return;
  const tick = (): void => {
    if (inFlight) return;
    inFlight = runPayPalExpirySweep(liveDeps(app))
      .catch((err) => app.log.error({ err }, '[paypal-expiry] sweep failed'))
      .finally(() => {
        inFlight = null;
      });
  };
  tick();
  workerInterval = setInterval(tick, opts.intervalMs ?? DEFAULT_INTERVAL_MS);
  workerInterval.unref?.();
}

export async function stopPayPalExpiryWorker(): Promise<void> {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  if (inFlight) await inFlight;
}
