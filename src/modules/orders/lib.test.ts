import { test } from 'node:test';
import assert from 'node:assert/strict';
import {
  CLOSED_ORDER_STATUSES,
  allowedNextStatuses,
  canTransition,
  derivedOrderId,
  generateOrderToken,
  isPartnerDone,
  likePattern,
  partnerNextStatus,
} from './lib.js';

test('valid forward transitions', () => {
  assert.ok(canTransition('pending', 'payment_pending'));
  assert.ok(canTransition('payment_pending', 'paid'));
  assert.ok(canTransition('paid', 'accepted'));
  assert.ok(canTransition('delivered', 'completed'));
});

test('illegal transitions are rejected', () => {
  assert.equal(canTransition('paid', 'delivered'), false);
  assert.equal(canTransition('pending', 'paid'), false);
  assert.equal(canTransition('completed', 'accepted'), false);
  assert.equal(canTransition('cancelled', 'paid'), false);
  assert.equal(canTransition('refunded', 'paid'), false);
});

test('partial refund can still become full refund; refunded is terminal', () => {
  assert.ok(canTransition('paid', 'partially_refunded'));
  assert.ok(canTransition('partially_refunded', 'refunded'));
  assert.deepEqual(allowedNextStatuses('refunded'), []);
});

test('order tokens are unique and url-safe', () => {
  const a = generateOrderToken();
  const b = generateOrderToken();
  assert.notEqual(a, b);
  assert.match(a, /^[A-Za-z0-9_-]{24}$/);
});

test('closed statuses are the terminal ones plus completed', () => {
  assert.deepEqual([...CLOSED_ORDER_STATUSES].sort(), ['cancelled', 'completed', 'refunded']);
  for (const s of CLOSED_ORDER_STATUSES.filter((s) => s !== 'completed')) {
    assert.deepEqual(allowedNextStatuses(s), []);
  }
});

test('search helpers escape wildcards and parse derived numbers', () => {
  assert.equal(likePattern('50%_a\\b'), '%50\\%\\_a\\\\b%');
  assert.equal(derivedOrderId('2026/000123'), 123);
  assert.equal(derivedOrderId(' 2025 / 7 '), 7);
  assert.equal(derivedOrderId('ALT-123'), null);
  assert.equal(derivedOrderId('2026/0'), null);
});

test('partner gets exactly one next step, always one the FSM allows', () => {
  assert.equal(partnerNextStatus({ status: 'pending' }), null);
  assert.equal(partnerNextStatus({ status: 'payment_pending' }), null);
  assert.equal(partnerNextStatus({ status: 'paid' }), null, 'the team confirms paid jobs');
  assert.equal(partnerNextStatus({ status: 'accepted' }), 'picked_up');
  assert.equal(partnerNextStatus({ status: 'ready' }), 'delivered');
  assert.equal(partnerNextStatus({ status: 'delivered' }), null);
  assert.equal(partnerNextStatus({ status: 'cancelled' }), null);
  for (const s of ['accepted', 'picked_up', 'in_cleaning', 'ready'] as const) {
    assert.ok(canTransition(s, partnerNextStatus({ status: s })!), s);
  }
});

test('a partial refund resumes after the furthest step instead of jumping back', () => {
  const at = new Date();
  // The FSM alone offers picked_up here, which would move a job in cleaning backwards.
  assert.ok(allowedNextStatuses('partially_refunded').includes('picked_up'));
  assert.equal(
    partnerNextStatus({ status: 'partially_refunded', acceptedAt: at, inCleaningAt: at }),
    'ready',
  );
  assert.equal(partnerNextStatus({ status: 'partially_refunded', acceptedAt: at }), 'picked_up');
  assert.equal(partnerNextStatus({ status: 'partially_refunded' }), null);
  assert.equal(partnerNextStatus({ status: 'partially_refunded', deliveredAt: at }), null);
});

test('partner done = delivered or later, cancelled, refunded', () => {
  assert.equal(isPartnerDone({ status: 'delivered' }), true);
  assert.equal(isPartnerDone({ status: 'ready' }), false);
  assert.equal(isPartnerDone({ status: 'partially_refunded' }), false);
  assert.equal(isPartnerDone({ status: 'partially_refunded', deliveredAt: new Date() }), true);
});
