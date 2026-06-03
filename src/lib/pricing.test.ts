import { test } from 'node:test';
import assert from 'node:assert/strict';
import { priceOrder } from './pricing.js';
import { hamburgBook } from './price-books/hamburg.js';

test('carpet cleaning: subtotal equals the sum of line subtotals', () => {
  const q = priceOrder(
    {
      kind: 'teppichreinigung',
      carpets: [
        { art: 'maschinell', sqm: 4 },
        { art: 'shaggy', sqm: 2.5 },
      ],
      pickupMode: 'drop_off',
    },
    hamburgBook,
  );
  assert.equal(q.outOfArea, false);
  const sumLines = q.lines.reduce((a, l) => a + l.subtotalCents, 0);
  assert.equal(q.subtotalCents, sumLines);
  assert.equal(q.totalCents, q.subtotalCents + q.pickupFeeCents + q.minOrderTopUpCents);
  for (const l of q.lines) assert.ok(Number.isInteger(l.subtotalCents));
});

test('out-of-area PLZ yields an out-of-area quote, no price', () => {
  const q = priceOrder(
    {
      kind: 'teppichreinigung',
      carpets: [{ art: 'maschinell', sqm: 4 }],
      pickupMode: 'pickup',
      pickupPlz: '80331', // Munich → far beyond the 50km service radius
    },
    hamburgBook,
  );
  assert.equal(q.outOfArea, true);
  assert.equal(q.totalCents, 0);
  assert.ok(q.outOfAreaReason);
});

test('minimum-order top-up never makes the total dip below the floor', () => {
  const q = priceOrder(
    {
      kind: 'teppichreinigung',
      carpets: [{ art: 'maschinell', sqm: 0.5 }],
      pickupMode: 'drop_off',
    },
    hamburgBook,
  );
  if (hamburgBook.carpetCleaning) {
    assert.ok(q.totalCents >= hamburgBook.carpetCleaning.minOrderCents);
  }
});

test('totals are always whole cents', () => {
  const q = priceOrder(
    {
      kind: 'teppichreinigung',
      carpets: [{ art: 'perser_premium', sqm: 3.33 }],
      pickupMode: 'drop_off',
    },
    hamburgBook,
  );
  assert.ok(Number.isInteger(q.totalCents));
  assert.ok(Number.isInteger(q.subtotalCents));
});
