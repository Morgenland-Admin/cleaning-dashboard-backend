import { test } from 'node:test';
import assert from 'node:assert/strict';
import { canTransition, allowedNextStatuses, generateOrderToken } from './lib.js';

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
