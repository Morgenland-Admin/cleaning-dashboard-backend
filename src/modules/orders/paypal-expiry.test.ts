import assert from 'node:assert/strict';
import { test } from 'node:test';

import type { PayPalCapture } from '../../lib/paypal.js';
import {
  ABANDONED_REASON,
  STALE_AFTER_MS,
  runPayPalExpirySweep,
  type PayPalExpiryDeps,
} from './paypal-expiry.js';

const HOUR = 60 * 60 * 1000;
const NOW = new Date('2026-11-11T12:00:00Z');

interface FakeOrder {
  id: number;
  paypalOrderId: string | null;
  createdAt: Date;
}

function pp(status: string, captureStatus: string | null = null): PayPalCapture {
  return {
    id: 'PP-1',
    status,
    captureStatus,
    captureId: captureStatus ? 'CAP-1' : null,
    amountCents: captureStatus ? 12900 : null,
    currency: captureStatus ? 'EUR' : null,
    referenceId: null,
    invoiceId: null,
  };
}

function httpError(status: number): Error {
  return Object.assign(new Error(`PayPal GET failed (${status})`), { status });
}

function harness(opts: {
  configured?: boolean;
  tenants?: Record<string, FakeOrder[]>;
  paypal?: Record<string, PayPalCapture | Error>;
  capture?: PayPalCapture;
}) {
  const calls = {
    withLock: 0,
    listTenants: 0,
    findStale: [] as { schemaName: string; cutoff: Date }[],
    getOrder: [] as string[],
    capture: [] as { paypalOrderId: string; key: string }[],
    paid: [] as { slug: string; orderId: number; capture: unknown }[],
    cancelled: [] as { slug: string; orderId: number; reason: string }[],
  };
  const tenants = opts.tenants ?? {};
  const deps: PayPalExpiryDeps = {
    configured: opts.configured ?? true,
    now: NOW,
    withLock: async (fn) => {
      calls.withLock += 1;
      await fn();
    },
    listTenants: async () => {
      calls.listTenants += 1;
      return Object.keys(tenants).map((slug) => ({ slug, schemaName: `tenant_${slug}` }));
    },
    findStale: async (schemaName, cutoff) => {
      calls.findStale.push({ schemaName, cutoff });
      const rows = tenants[schemaName.replace(/^tenant_/, '')] ?? [];
      return rows.filter((o) => o.createdAt < cutoff);
    },
    getOrder: async (id) => {
      calls.getOrder.push(id);
      const r = opts.paypal?.[id];
      if (!r) throw httpError(404);
      if (r instanceof Error) throw r;
      return r;
    },
    capture: async (paypalOrderId, key) => {
      calls.capture.push({ paypalOrderId, key });
      return opts.capture ?? pp('COMPLETED', 'COMPLETED');
    },
    markPaid: async (slug, orderId, capture) => {
      calls.paid.push({ slug, orderId, capture });
    },
    markCancelled: async (slug, orderId, reason) => {
      calls.cancelled.push({ slug, orderId, reason });
    },
    log: { info: () => {}, warn: () => {}, error: () => {} },
  };
  return { deps, calls };
}

const old = (id: number, paypalOrderId: string | null = `PP-${id}`): FakeOrder => ({
  id,
  paypalOrderId,
  createdAt: new Date(NOW.getTime() - 5 * HOUR),
});

test('PayPal not configured → no lock, no queries, no PayPal calls', async () => {
  const { deps, calls } = harness({ configured: false, tenants: { cleanilo: [old(1)] } });
  const res = await runPayPalExpirySweep(deps);
  assert.deepEqual(res, { paid: 0, cancelled: 0, kept: 0 });
  assert.equal(calls.withLock, 0);
  assert.equal(calls.listTenants, 0);
  assert.equal(calls.findStale.length, 0);
  assert.equal(calls.getOrder.length, 0);
});

test('expired, never approved (CREATED) → cancelled with the German reason', async () => {
  const { deps, calls } = harness({
    tenants: { cleanilo: [old(7)] },
    paypal: { 'PP-7': pp('CREATED') },
  });
  const res = await runPayPalExpirySweep(deps);
  assert.deepEqual(res, { paid: 0, cancelled: 1, kept: 0 });
  assert.deepEqual(calls.cancelled, [{ slug: 'cleanilo', orderId: 7, reason: ABANDONED_REASON }]);
  assert.equal(calls.capture.length, 0);
  assert.equal(calls.paid.length, 0);
});

test('PAYER_ACTION_REQUIRED, VOIDED and a PayPal 404 all cancel', async () => {
  const { deps, calls } = harness({
    tenants: { cleanilo: [old(1), old(2), old(3)] },
    paypal: { 'PP-1': pp('PAYER_ACTION_REQUIRED'), 'PP-2': pp('VOIDED') },
  });
  const res = await runPayPalExpirySweep(deps);
  assert.equal(res.cancelled, 3);
  assert.deepEqual(
    calls.cancelled.map((c) => c.orderId),
    [1, 2, 3],
  );
});

test('COMPLETED with a COMPLETED capture → marked paid, not cancelled', async () => {
  const { deps, calls } = harness({
    tenants: { htr: [old(42)] },
    paypal: { 'PP-42': pp('COMPLETED', 'COMPLETED') },
  });
  const res = await runPayPalExpirySweep(deps);
  assert.deepEqual(res, { paid: 1, cancelled: 0, kept: 0 });
  assert.deepEqual(calls.paid, [
    {
      slug: 'htr',
      orderId: 42,
      capture: { amountCents: 12900, status: 'COMPLETED', orderId: 'PP-42', captureId: 'CAP-1' },
    },
  ]);
  assert.equal(calls.capture.length, 0);
  assert.equal(calls.cancelled.length, 0);
});

test('APPROVED but not captured → captured with the route idempotency key, then paid', async () => {
  const { deps, calls } = harness({
    tenants: { cleanilo: [old(42)] },
    paypal: { 'PP-42': pp('APPROVED') },
  });
  const res = await runPayPalExpirySweep(deps);
  assert.equal(res.paid, 1);
  assert.deepEqual(calls.capture, [{ paypalOrderId: 'PP-42', key: 'pp_capture_cleanilo_42' }]);
  assert.equal(calls.paid[0]?.orderId, 42);
  assert.equal(calls.cancelled.length, 0);
});

test('capture PENDING or completed order without settled capture → left payment_pending', async () => {
  const { deps, calls } = harness({
    tenants: { cleanilo: [old(1), old(2)] },
    paypal: { 'PP-1': pp('APPROVED'), 'PP-2': pp('COMPLETED', 'PENDING') },
    capture: pp('COMPLETED', 'PENDING'),
  });
  const res = await runPayPalExpirySweep(deps);
  assert.deepEqual(res, { paid: 0, cancelled: 0, kept: 2 });
  assert.equal(calls.paid.length, 0);
  assert.equal(calls.cancelled.length, 0);
});

test('young order is untouched; cutoff is now minus the stale window', async () => {
  const young: FakeOrder = {
    id: 5,
    paypalOrderId: 'PP-5',
    createdAt: new Date(NOW.getTime() - 1 * HOUR),
  };
  const { deps, calls } = harness({
    tenants: { cleanilo: [young] },
    paypal: { 'PP-5': pp('CREATED') },
  });
  const res = await runPayPalExpirySweep(deps);
  assert.deepEqual(res, { paid: 0, cancelled: 0, kept: 0 });
  assert.equal(calls.findStale[0]?.cutoff.getTime(), NOW.getTime() - STALE_AFTER_MS);
  assert.equal(calls.getOrder.length, 0);
  assert.equal(calls.cancelled.length, 0);
});

test('PayPal outage (5xx) does not cancel; other orders and tenants still run', async () => {
  const { deps, calls } = harness({
    tenants: { cleanilo: [old(1), old(2)], htr: [old(3)] },
    paypal: { 'PP-1': httpError(503), 'PP-2': pp('CREATED'), 'PP-3': pp('CREATED') },
  });
  const res = await runPayPalExpirySweep(deps);
  assert.deepEqual(res, { paid: 0, cancelled: 2, kept: 1 });
  assert.deepEqual(
    calls.cancelled.map((c) => `${c.slug}:${c.orderId}`),
    ['cleanilo:2', 'htr:3'],
  );
});
