import assert from 'node:assert/strict';
import { test } from 'node:test';

import { buildLineItemsFromOrder, netFromGross, type InvoiceSourceOrder } from './from-order.js';

function order(over: Partial<InvoiceSourceOrder> = {}): InvoiceSourceOrder {
  return {
    id: 1,
    orderNumber: '2026/000021',
    customerName: 'Luiza Turini',
    customerEmail: 'l@example.com',
    addressLine1: 'Tornquiststraße 45',
    addressLine2: null,
    addressPostalCode: '20259',
    addressCity: 'Hamburg',
    addressCountry: 'DE',
    currency: 'EUR',
    pickupFeeCents: 0,
    minOrderTopUpCents: 0,
    discountCents: 0,
    voucherCode: null,
    totalCents: 0,
    paidAt: null,
    ...over,
  };
}

test('netFromGross backs 19% VAT out of a gross amount', () => {
  assert.equal(netFromGross(8900, 19), 7479); // 89.00 → 74.79
  assert.equal(netFromGross(11900, 19), 10000);
});

test('each order item becomes a net line, quantityLabel folded into the label', () => {
  const { lineItems } = buildLineItemsFromOrder(order({ totalCents: 3244 }), [
    { label: 'Teppichreinigung · Maschinell', quantityLabel: '2,04 m²', subtotalCents: 3244 },
  ]);
  assert.equal(lineItems.length, 1);
  assert.equal(lineItems[0]!.label, 'Teppichreinigung · Maschinell (2,04 m²)');
  assert.equal(lineItems[0]!.unitPriceCents, netFromGross(3244, 19));
});

test('an item with no quantityLabel keeps its bare label', () => {
  const { lineItems } = buildLineItemsFromOrder(order({ totalCents: 1000 }), [
    { label: 'Imprägnierung', quantityLabel: null, subtotalCents: 1000 },
  ]);
  assert.equal(lineItems[0]!.label, 'Imprägnierung');
});

test('pickup fee, minimum-order top-up and discount each get their own line', () => {
  const { lineItems } = buildLineItemsFromOrder(
    order({
      totalCents: 12000,
      pickupFeeCents: 1000,
      minOrderTopUpCents: 500,
      discountCents: 2000,
      voucherCode: 'WILLKOMMEN10',
    }),
    [{ label: 'Teppichreinigung', quantityLabel: '6 m²', subtotalCents: 12500 }],
  );
  const labels = lineItems.map((l) => l.label);
  assert.deepEqual(labels, [
    'Teppichreinigung (6 m²)',
    'Abholung / Lieferung',
    'Mindestbestellwert-Aufschlag',
    'Rabatt (WILLKOMMEN10)',
  ]);
  // The discount is the only negative line.
  assert.ok(lineItems[3]!.unitPriceCents < 0);
});

test('a discount without a voucher code is still labelled', () => {
  const { lineItems } = buildLineItemsFromOrder(order({ totalCents: 5000, discountCents: 500 }), [
    { label: 'Reinigung', quantityLabel: null, subtotalCents: 5500 },
  ]);
  assert.equal(lineItems.at(-1)!.label, 'Rabatt');
});

test('an order with no items still yields one line referencing the order', () => {
  const { lineItems } = buildLineItemsFromOrder(order({ totalCents: 8900 }), []);
  assert.equal(lineItems.length, 1);
  assert.equal(lineItems[0]!.label, 'Auftrag 2026/000021');
  assert.equal(lineItems[0]!.unitPriceCents, 7479);
});

test('an order with neither items nor a number falls back to the id', () => {
  const { lineItems } = buildLineItemsFromOrder(
    order({ id: 42, orderNumber: null, totalCents: 100 }),
    [],
  );
  assert.equal(lineItems[0]!.label, 'Auftrag #42');
});

/*
 * The invariant that matters: whatever per-line rounding does, subtotal + tax
 * has to land exactly on what the customer was charged. Tax is the remainder,
 * never a recomputed percentage — this is the test that fails if someone
 * "tidies" it into `Math.round(subtotal * 0.19)`.
 */
test('subtotal + tax always equals the order total, to the cent', () => {
  const cases: Array<{ total: number; items: number[] }> = [
    { total: 8900, items: [8900] },
    { total: 37744, items: [3244, 1020, 17940, 3000, 9540, 3000] }, // the real 6-line order
    { total: 1, items: [1] },
    { total: 3333, items: [1111, 1111, 1111] },
    { total: 9999, items: [3333, 3333, 3333] },
    { total: 10001, items: [7, 9994] },
  ];
  for (const c of cases) {
    const { subtotalCents, taxCents } = buildLineItemsFromOrder(
      order({ totalCents: c.total }),
      c.items.map((s, i) => ({ label: `Pos ${i}`, quantityLabel: null, subtotalCents: s })),
    );
    assert.equal(
      subtotalCents + taxCents,
      c.total,
      `subtotal ${subtotalCents} + tax ${taxCents} != total ${c.total}`,
    );
  }
});

test('totals hold with pickup fee, top-up and discount in the mix', () => {
  const o = order({
    totalCents: 12000,
    pickupFeeCents: 1000,
    minOrderTopUpCents: 500,
    discountCents: 2000,
  });
  const { subtotalCents, taxCents } = buildLineItemsFromOrder(o, [
    { label: 'Teppichreinigung', quantityLabel: '6 m²', subtotalCents: 12500 },
  ]);
  assert.equal(subtotalCents + taxCents, 12000);
});
