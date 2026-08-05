import assert from 'node:assert/strict';
import { test } from 'node:test';

import { craftsmanNoteText, craftsmanVatFromGross, INVOICE_THANK_YOU } from './invoice-text.js';

test('craftsmanVatFromGross: VAT contained in a gross amount at 19 %', () => {
  // Kabir's reference figures: 200,00 € gross labour contain 31,93 € VAT.
  assert.equal(craftsmanVatFromGross(20_000), 3193);
  assert.equal(craftsmanVatFromGross(70_000), 11_176);
});

test('craftsmanVatFromGross: honours a non-default rate, 0 % yields nothing', () => {
  assert.equal(craftsmanVatFromGross(10_700, 7), 700);
  assert.equal(craftsmanVatFromGross(10_000, 0), 0);
});

test('craftsmanNoteText: exact §35a wording with both amounts', () => {
  assert.equal(
    craftsmanNoteText(20_000, 3193),
    'Im Bruttorechnungsbetrag sind Arbeitskosten / Lohnanteile in Höhe von 200 Euro ' +
      '(inkl. 31,93 Euro MwSt.) enthalten, die nach § 35a EStG steuerlich absetzbar sind.',
  );
});

test('craftsmanNoteText: cents are spelled out, thousands grouped German-style', () => {
  assert.equal(
    craftsmanNoteText(189_050, 30_193),
    'Im Bruttorechnungsbetrag sind Arbeitskosten / Lohnanteile in Höhe von 1.890,50 Euro ' +
      '(inkl. 301,93 Euro MwSt.) enthalten, die nach § 35a EStG steuerlich absetzbar sind.',
  );
});

test('craftsmanNoteText: no VAT share (§19 UStG) drops the bracket', () => {
  assert.equal(
    craftsmanNoteText(20_000, 0),
    'Im Bruttorechnungsbetrag sind Arbeitskosten / Lohnanteile in Höhe von 200 Euro ' +
      'enthalten, die nach § 35a EStG steuerlich absetzbar sind.',
  );
});

test('INVOICE_THANK_YOU: exact standard closing line', () => {
  assert.equal(
    INVOICE_THANK_YOU,
    'Vielen Dank für Ihren Auftrag und Ihr Vertrauen. ' +
      'Wir freuen uns, wenn wir wieder für Sie tätig sein dürfen.',
  );
});
