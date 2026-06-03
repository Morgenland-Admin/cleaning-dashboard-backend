import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeLoyaltyTier } from './loyalty.js';

test('new customer is neukunde', () => {
  assert.equal(computeLoyaltyTier(0, 0), 'neukunde');
  assert.equal(computeLoyaltyTier(1, 5000), 'neukunde');
});

test('promotes by order count', () => {
  assert.equal(computeLoyaltyTier(2, 0), 'stammkunde');
  assert.equal(computeLoyaltyTier(5, 0), 'premium');
});

test('promotes by lifetime spend even with one order', () => {
  assert.equal(computeLoyaltyTier(1, 30_000), 'stammkunde');
  assert.equal(computeLoyaltyTier(1, 100_000), 'premium');
});

test('takes the higher of the two signals', () => {
  assert.equal(computeLoyaltyTier(2, 100_000), 'premium');
});
