import { test } from 'node:test';
import assert from 'node:assert/strict';
import { evaluateCancellation } from './cancellation.js';

const HOUR = 60 * 60 * 1000;
const now = new Date('2026-06-02T12:00:00Z');

test('unpaid orders cancel fully with no refund', () => {
  const d = evaluateCancellation({
    status: 'pending',
    totalCents: 5000,
    paidAt: null,
    preferredDate: null,
    now,
  });
  assert.equal(d.allowed, true);
  assert.equal(d.mode, 'full');
  assert.equal(d.suggestedRefundCents, 0);
});

test('cancelling >24h before appointment → full refund', () => {
  const d = evaluateCancellation({
    status: 'paid',
    totalCents: 5000,
    paidAt: now,
    preferredDate: new Date(now.getTime() + 48 * HOUR),
    now,
  });
  assert.equal(d.allowed, true);
  assert.equal(d.suggestedRefundCents, 5000);
});

test('cancelling <24h before appointment → 50% refund', () => {
  const d = evaluateCancellation({
    status: 'paid',
    totalCents: 5000,
    paidAt: now,
    preferredDate: new Date(now.getTime() + 3 * HOUR),
    now,
  });
  assert.equal(d.allowed, true);
  assert.equal(d.mode, 'partial');
  assert.equal(d.suggestedRefundCents, 2500);
});

test('after pickup cancellation is denied', () => {
  for (const status of ['picked_up', 'in_cleaning', 'ready', 'delivered', 'completed'] as const) {
    const d = evaluateCancellation({
      status,
      totalCents: 5000,
      paidAt: now,
      preferredDate: null,
      now,
    });
    assert.equal(d.allowed, false, status);
  }
});

test('already terminal states are denied', () => {
  for (const status of ['cancelled', 'refunded'] as const) {
    const d = evaluateCancellation({
      status,
      totalCents: 5000,
      paidAt: now,
      preferredDate: null,
      now,
    });
    assert.equal(d.allowed, false, status);
  }
});
