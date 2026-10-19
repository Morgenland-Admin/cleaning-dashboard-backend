import assert from 'node:assert/strict';
import { test } from 'node:test';

import { formatEurFromCents } from '../../lib/pricing.js';
import {
  areaSqm,
  buildReceiptLines,
  buildReceiptView,
  computeReceiptTotals,
  groupOrderItems,
  receiptDraftSchema,
  receiptPaidCents,
  receiptPdfFilename,
  receiptStatusAction,
  type ReceiptDraft,
} from './receipt.js';

/** Order items exactly as the storefront writes them: carpet, then its extras. */
const storefrontItems = [
  {
    code: 'carpet.perser_premium',
    label: 'Teppichreinigung · Perser Premium (Wohnzimmer)',
    quantityLabel: '6 m²',
    quantity: '6.00',
    unitPriceCents: 1890,
    metadata: {},
  },
  {
    code: 'addon.impraegnierung',
    label: 'Imprägnierung (Perser Premium)',
    quantityLabel: '6 m²',
    quantity: '6.00',
    unitPriceCents: 400,
    metadata: {},
  },
  {
    code: 'carpet.maschinell',
    label: 'Teppichreinigung · Maschinell',
    quantityLabel: '2,5 m²',
    quantity: '2.50',
    unitPriceCents: 1290,
    metadata: {},
  },
];

function draftOf(items: ReceiptDraft['items'], over: Partial<ReceiptDraft> = {}): ReceiptDraft {
  return receiptDraftSchema.parse({
    handover: 'pickup',
    receivedAt: '2026-10-16T14:30',
    pickupFeeCents: 0,
    items,
    ...over,
  });
}

test('extras fold into the carpet before them', () => {
  const items = groupOrderItems(storefrontItems);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.code, 'carpet.perser_premium');
  assert.deepEqual(items[0]!.addons, [
    { code: 'addon.impraegnierung', label: 'Imprägnierung (Perser Premium)', unitPriceCents: 400 },
  ]);
  assert.equal(items[1]!.addons.length, 0);
});

test('an extra with a different area stays its own position', () => {
  const items = groupOrderItems([
    storefrontItems[0]!,
    { ...storefrontItems[1]!, quantity: '4.00', quantityLabel: '4 m²' },
  ]);
  assert.equal(items.length, 2);
  assert.equal(items[0]!.addons.length, 0);
  assert.equal(items[1]!.code, 'addon.impraegnierung');
});

test('an unchanged booking re-saves to the same rows and money', () => {
  const { lines } = buildReceiptLines(draftOf(groupOrderItems(storefrontItems)));
  assert.deepEqual(
    lines.map((l) => [l.code, l.quantity, l.quantityLabel, l.subtotalCents]),
    [
      ['carpet.perser_premium', 6, '6 m²', 11340],
      ['addon.impraegnierung', 6, '6 m²', 2400],
      ['carpet.maschinell', 2.5, '2,5 m²', 3225],
    ],
  );
});

test('measured dimensions set the area, and the extra follows it', () => {
  const [perser, maschinell] = groupOrderItems(storefrontItems);
  const { lines, groups } = buildReceiptLines(
    draftOf([{ ...perser!, lengthCm: 200, widthCm: 350, tagNumber: '0815' }, maschinell!]),
  );
  assert.equal(groups[0]!.main.quantity, 7);
  assert.equal(groups[0]!.main.quantityLabel, '7 m²');
  assert.equal(groups[0]!.main.subtotalCents, 13230);
  assert.equal(groups[0]!.addons[0]!.quantity, 7);
  assert.equal(groups[0]!.addons[0]!.subtotalCents, 2800);
  assert.deepEqual(groups[0]!.main.metadata, { lengthCm: 200, widthCm: 350, tagNumber: '0815' });
  assert.deepEqual(lines[1]!.metadata, { addon: true });
});

test('the item details survive a save → load round trip', () => {
  const [perser] = groupOrderItems(storefrontItems);
  const photo = { key: 'htr/receipts/2026/10/abc-teppich.jpg', name: 'teppich.jpg' };
  const { lines } = buildReceiptLines(
    draftOf([
      {
        ...perser!,
        lengthCm: 160,
        widthCm: 230,
        tagNumber: 'A-12',
        condition: 'Fransen lose, Fleck in der Mitte',
        photos: [photo],
      },
    ]),
  );
  const reloaded = groupOrderItems(lines.map((l) => ({ ...l, quantity: l.quantity.toFixed(2) })));
  assert.equal(reloaded.length, 1);
  assert.equal(reloaded[0]!.lengthCm, 160);
  assert.equal(reloaded[0]!.widthCm, 230);
  assert.equal(reloaded[0]!.tagNumber, 'A-12');
  assert.equal(reloaded[0]!.condition, 'Fransen lose, Fleck in der Mitte');
  assert.deepEqual(reloaded[0]!.photos, [photo]);
  assert.equal(reloaded[0]!.addons.length, 1);
});

test('area rounds to two decimals and never prices at zero', () => {
  assert.equal(areaSqm(155, 233), 3.61);
  assert.equal(areaSqm(1, 1), 0.01);
});

test('totals follow checkout: top-up on the gross, voucher last', () => {
  // A 20,00 € booking under a 25,00 € minimum with a 5,00 € voucher.
  const lines = [
    {
      code: 'carpet.maschinell',
      label: 'x',
      quantityLabel: '1 m²',
      quantity: 1,
      unitPriceCents: 2000,
      subtotalCents: 2000,
      metadata: {},
    },
  ];
  const t = computeReceiptTotals(lines, {
    pickupFeeCents: 0,
    discountCents: 500,
    minOrderCents: 2500,
    paidCents: 2000,
  });
  assert.equal(t.minOrderTopUpCents, 500);
  assert.equal(t.totalCents, 2000);
  assert.equal(t.balanceCents, 0);
});

test('a bigger carpet than booked leaves an open amount on a paid order', () => {
  const [perser, maschinell] = groupOrderItems(storefrontItems);
  const draft = draftOf([{ ...perser!, lengthCm: 200, widthCm: 350 }, maschinell!], {
    pickupFeeCents: 1500,
  });
  const { lines, groups } = buildReceiptLines(draft);
  const totals = computeReceiptTotals(lines, {
    pickupFeeCents: 1500,
    discountCents: 0,
    minOrderCents: 2500,
    paidCents: 18465, // the booked 169,65 € + 15,00 € pickup
  });
  assert.equal(totals.totalCents, 13230 + 2800 + 3225 + 1500);
  assert.equal(totals.balanceCents, 2290);
  const view = buildReceiptView({
    order: { orderNumber: '2026/000039', voucherCode: null },
    draft,
    groups,
    totals,
    isUpdate: false,
    invoiceFollows: true,
  });
  assert.deepEqual(view.payment, [
    { label: 'Bereits bezahlt', value: formatEurFromCents(18465), emphasis: false },
    { label: 'Offener Betrag', value: formatEurFromCents(2290), emphasis: true },
  ]);
  assert.deepEqual(view.positions[0]!.details, ['Maße: 200 × 350 cm']);
  assert.equal(view.positions[0]!.addons.length, 1);
});

test('confirmation sentence matches the handover and the piece count', () => {
  const [perser, maschinell] = groupOrderItems(storefrontItems);
  const view = (draft: ReceiptDraft) => {
    const { lines, groups } = buildReceiptLines(draft);
    return buildReceiptView({
      order: { orderNumber: '2026/000039', voucherCode: null },
      draft,
      groups,
      totals: computeReceiptTotals(lines, {
        pickupFeeCents: 0,
        discountCents: 0,
        minOrderCents: 0,
        paidCents: 0,
      }),
      isUpdate: false,
      invoiceFollows: true,
    });
  };
  assert.equal(
    view(draftOf([perser!])).confirmation,
    'Hiermit bestätigen wir, dass wir Ihren Teppich am 16.10.2026 um 14:30 Uhr bei Ihnen abgeholt haben.',
  );
  const dropOff = view(draftOf([perser!, maschinell!], { handover: 'drop_off' }));
  assert.equal(
    dropOff.confirmation,
    'Hiermit bestätigen wir, dass Sie uns Ihre Teppiche am 16.10.2026 um 14:30 Uhr in unserer Werkstatt übergeben haben.',
  );
  assert.deepEqual(dropOff.payment, []);
});

test('status action: advance before handover, resend after, nothing on-site', () => {
  assert.equal(receiptStatusAction({ status: 'paid', pickupMode: 'pickup' }), 'advance');
  assert.equal(receiptStatusAction({ status: 'accepted', pickupMode: 'drop_off' }), 'advance');
  assert.equal(receiptStatusAction({ status: 'in_cleaning', pickupMode: 'pickup' }), 'resend');
  assert.equal(receiptStatusAction({ status: 'accepted', pickupMode: 'onsite' }), null);
  assert.equal(receiptStatusAction({ status: 'payment_pending', pickupMode: 'pickup' }), null);
  assert.equal(receiptStatusAction({ status: 'delivered', pickupMode: 'pickup' }), null);
});

test('paid amount is captured once, then kept', () => {
  assert.equal(receiptPaidCents({ paidAt: null, totalCents: 9000 }, null), 0);
  assert.equal(receiptPaidCents({ paidAt: new Date(), totalCents: 9000 }, null), 9000);
  const meta = {
    handover: 'pickup' as const,
    receivedAt: '2026-10-16T14:30',
    note: null,
    paidCents: 7500,
    savedAt: '',
    savedByUserId: '',
    history: [],
  };
  assert.equal(receiptPaidCents({ paidAt: new Date(), totalCents: 9000 }, meta), 7500);
});

test('photo limit is enforced across items', () => {
  const photos = Array.from({ length: 6 }, (_, i) => ({ key: `htr/receipts/p${i}.jpg` }));
  const item = { ...groupOrderItems(storefrontItems)[1]!, photos };
  const result = receiptDraftSchema.safeParse({
    handover: 'pickup',
    receivedAt: '2026-10-16T14:30',
    pickupFeeCents: 0,
    items: [item, item, item, item, item],
  });
  assert.equal(result.success, false);
});

test('pdf filename is ASCII and carries the order number', () => {
  assert.equal(
    receiptPdfFilename('2026/000039', 'Jörg Weiß'),
    '2026-000039-Eingangsbestaetigung-Joerg-Weiss.pdf',
  );
});
