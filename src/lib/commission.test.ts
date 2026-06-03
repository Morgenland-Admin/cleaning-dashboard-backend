import { test } from 'node:test';
import assert from 'node:assert/strict';
import { computeCommission, parseCommissionRate, DEFAULT_COMMISSION_RATE } from './commission.js';

test('default rate applies when none given', () => {
  const r = computeCommission(10000, null);
  assert.equal(r.ratePercent, DEFAULT_COMMISSION_RATE);
  assert.equal(r.commissionCents, 1200);
  assert.equal(r.partnerPayoutCents, 8800);
});

test('commission + payout always equals total (no rounding leak)', () => {
  for (const total of [1, 99, 100, 333, 4999, 12345, 99999]) {
    for (const rate of [0, 10, 12, 16, 33.33, 100]) {
      const r = computeCommission(total, rate);
      assert.equal(r.commissionCents + r.partnerPayoutCents, total, `total=${total} rate=${rate}`);
      assert.ok(r.commissionCents >= 0 && r.partnerPayoutCents >= 0);
    }
  }
});

test('explicit rate overrides default', () => {
  const r = computeCommission(20000, 10);
  assert.equal(r.commissionCents, 2000);
  assert.equal(r.partnerPayoutCents, 18000);
});

test('rejects invalid inputs', () => {
  assert.throws(() => computeCommission(-1, 12));
  assert.throws(() => computeCommission(100, 101));
  assert.throws(() => computeCommission(100, -5));
});

test('parseCommissionRate handles numeric strings and null', () => {
  assert.equal(parseCommissionRate('12.00'), 12);
  assert.equal(parseCommissionRate(10), 10);
  assert.equal(parseCommissionRate(null), null);
  assert.equal(parseCommissionRate('abc'), null);
});
