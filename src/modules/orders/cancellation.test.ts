import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  berlinLocalToUtc,
  evaluateCancellation,
  resolveCancellationAnchor,
  type CancellationContext,
} from './cancellation.js';

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-06-02T12:00:00Z');

function ctx(overrides: Partial<CancellationContext>): CancellationContext {
  return {
    status: 'paid',
    totalCents: 5000,
    refundedAmountCents: 0,
    paidAt: now,
    preferredDate: null,
    confirmedSlot: null,
    now,
    ...overrides,
  };
}

test('unpaid orders cancel fully with no refund', () => {
  const d = evaluateCancellation(ctx({ status: 'pending', paidAt: null }));
  assert.equal(d.allowed, true);
  assert.equal(d.mode, 'full');
  assert.equal(d.suggestedRefundCents, 0);
});

test('unpaid after-service order in accepted cancels with no refund', () => {
  const d = evaluateCancellation(ctx({ status: 'accepted', paidAt: null }));
  assert.equal(d.allowed, true);
  assert.equal(d.reasonCode, 'not_yet_paid');
  assert.equal(d.suggestedRefundCents, 0);
});

test('cancelling >24h before appointment → full refund', () => {
  const d = evaluateCancellation(ctx({ preferredDate: new Date(now.getTime() + 48 * HOUR) }));
  assert.equal(d.allowed, true);
  assert.equal(d.suggestedRefundCents, 5000);
});

test('cancelling <24h before appointment → 50% refund', () => {
  const d = evaluateCancellation(ctx({ confirmedSlot: '2026-06-02T16:00' }));
  assert.equal(d.allowed, true);
  assert.equal(d.mode, 'partial');
  assert.equal(d.suggestedRefundCents, 2500);
});

test('confirmed slot 27h away in Berlin time counts as well in advance', () => {
  const d = evaluateCancellation(ctx({ confirmedSlot: '2026-06-03T17:00' }));
  assert.equal(d.reasonCode, 'well_in_advance');
  assert.equal(d.suggestedRefundCents, 5000);
});

test('date-only appointment anchors to end of day Berlin (customer benefit)', () => {
  const d = evaluateCancellation(ctx({ preferredDate: new Date('2026-06-03') }));
  assert.equal(d.reasonCode, 'well_in_advance');
});

test('paid order with no appointment suggests full refund of remaining amount', () => {
  const d = evaluateCancellation(ctx({}));
  assert.equal(d.allowed, true);
  assert.equal(d.reasonCode, 'no_appointment');
  assert.equal(d.suggestedRefundCents, 5000);
});

test('partially refunded order caps refund at the remaining amount', () => {
  const d = evaluateCancellation(ctx({ status: 'partially_refunded', refundedAmountCents: 3000 }));
  assert.equal(d.allowed, true);
  assert.equal(d.maxRefundCents, 2000);
  assert.ok(d.suggestedRefundCents <= 2000);
});

test('partially refunded order <24h suggests at most the remaining amount', () => {
  const d = evaluateCancellation(
    ctx({
      status: 'partially_refunded',
      refundedAmountCents: 4000,
      confirmedSlot: '2026-06-02T16:00',
    }),
  );
  assert.equal(d.mode, 'partial');
  // Capped at the 1000 still refundable (50% would be 2500).
  assert.equal(d.suggestedRefundCents, 1000);
  assert.equal(d.maxRefundCents, 1000);
});

test('after pickup cancellation is denied', () => {
  for (const status of ['picked_up', 'in_cleaning', 'ready', 'delivered', 'completed'] as const) {
    const d = evaluateCancellation(ctx({ status }));
    assert.equal(d.allowed, false, status);
  }
});

test('already terminal states are denied', () => {
  for (const status of ['cancelled', 'refunded'] as const) {
    const d = evaluateCancellation(ctx({ status }));
    assert.equal(d.allowed, false, status);
  }
});

test('berlinLocalToUtc handles CEST (summer) and CET (winter)', () => {
  assert.equal(berlinLocalToUtc(2026, 6, 3, 17, 0).toISOString(), '2026-06-03T15:00:00.000Z');
  assert.equal(berlinLocalToUtc(2026, 1, 15, 17, 0).toISOString(), '2026-01-15T16:00:00.000Z');
});

test('resolveCancellationAnchor prefers the confirmed slot over the date', () => {
  const anchor = resolveCancellationAnchor({
    confirmedSlot: '2026-06-03T09:30',
    preferredDate: new Date('2026-06-05'),
  });
  assert.equal(anchor?.toISOString(), '2026-06-03T07:30:00.000Z');
});
