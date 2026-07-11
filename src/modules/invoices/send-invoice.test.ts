import assert from 'node:assert/strict';
import { test } from 'node:test';

import { invoicePdfFilename } from './send-invoice.js';

test('invoicePdfFilename: number + Rechnung + slugified customer name', () => {
  assert.equal(invoicePdfFilename('CL-1426', 'Hartmann-Leu'), 'CL-1426-Rechnung-Hartmann-Leu.pdf');
});

test('invoicePdfFilename: transliterates umlauts and ß', () => {
  assert.equal(
    invoicePdfFilename('HT-1426', 'Jürgen Müßig'),
    'HT-1426-Rechnung-Juergen-Muessig.pdf',
  );
});

test('invoicePdfFilename: collapses spaces/punctuation and trims', () => {
  assert.equal(
    invoicePdfFilename('TR-1', 'Müller & Sohn GmbH,'),
    'TR-1-Rechnung-Mueller-Sohn-GmbH.pdf',
  );
});

test('invoicePdfFilename: draft reference (no number) still works', () => {
  assert.equal(
    invoicePdfFilename('Entwurf-42', 'Anna Muster'),
    'Entwurf-42-Rechnung-Anna-Muster.pdf',
  );
});

test('invoicePdfFilename: empty name yields just number + Rechnung', () => {
  assert.equal(invoicePdfFilename('CL-1426', '   '), 'CL-1426-Rechnung.pdf');
});
