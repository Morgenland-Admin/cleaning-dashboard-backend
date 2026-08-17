import { test } from 'node:test';
import assert from 'node:assert/strict';

import { calendlyBookingConfigured } from '../../lib/calendly.js';
import {
  bookConfirmedSlot,
  readCalendlyMeta,
  slotToUtc,
  utcToBerlinSlot,
  type CalendlyPickupMeta,
} from './calendly-pickup.js';

const silentLog = { warn: () => {}, error: () => {} };

// ── slot ↔ UTC (the bug class that silently books an hour off) ──

test('slotToUtc reads a slot as Berlin wall clock — summer (CEST, UTC+2)', () => {
  assert.equal(slotToUtc('2026-08-12T10:00')!.toISOString(), '2026-08-12T08:00:00.000Z');
});

test('slotToUtc reads a slot as Berlin wall clock — winter (CET, UTC+1)', () => {
  assert.equal(slotToUtc('2026-01-15T10:00')!.toISOString(), '2026-01-15T09:00:00.000Z');
});

test('slotToUtc handles the days either side of the DST switch', () => {
  // Germany switches 2026-03-29 and 2026-10-25, both at 02:00/03:00 local.
  assert.equal(slotToUtc('2026-03-28T10:00')!.toISOString(), '2026-03-28T09:00:00.000Z');
  assert.equal(slotToUtc('2026-03-30T10:00')!.toISOString(), '2026-03-30T08:00:00.000Z');
  assert.equal(slotToUtc('2026-10-24T10:00')!.toISOString(), '2026-10-24T08:00:00.000Z');
  assert.equal(slotToUtc('2026-10-26T10:00')!.toISOString(), '2026-10-26T09:00:00.000Z');
});

test('slotToUtc rejects malformed slots', () => {
  for (const bad of ['2026-08-12', '2026-08-12 10:00', '12.08.2026T10:00', '', 'x']) {
    assert.equal(slotToUtc(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

test('utcToBerlinSlot is the inverse of slotToUtc across DST', () => {
  for (const slot of [
    '2026-08-12T10:00',
    '2026-01-15T10:00',
    '2026-03-30T00:30',
    '2026-10-26T23:45',
    '2026-12-31T00:00',
  ]) {
    const utc = slotToUtc(slot)!;
    assert.equal(utcToBerlinSlot(utc.toISOString()), slot, `round-trip failed for ${slot}`);
  }
});

test('utcToBerlinSlot renders midnight as 00, not 24', () => {
  // 2026-08-11T22:00Z is 2026-08-12 00:00 in Berlin (CEST).
  assert.equal(utcToBerlinSlot('2026-08-11T22:00:00.000Z'), '2026-08-12T00:00');
});

test('utcToBerlinSlot rejects an unparsable instant', () => {
  assert.equal(utcToBerlinSlot('not-a-date'), null);
});

// ── metadata reader ──

test('readCalendlyMeta returns the block only when it carries a known status', () => {
  const meta: CalendlyPickupMeta = {
    status: 'booked',
    slot: '2026-08-12T10:00',
    source: 'dashboard',
    updatedAt: '2026-08-06T12:00:00.000Z',
  };
  assert.deepEqual(readCalendlyMeta({ calendly: meta }), meta);
  assert.equal(readCalendlyMeta({ calendly: { status: 'pending' } }), null);
  assert.equal(readCalendlyMeta({ calendly: {} }), null);
  assert.equal(readCalendlyMeta({ calendly: 'booked' }), null);
  assert.equal(readCalendlyMeta({}), null);
  assert.equal(readCalendlyMeta(null), null);
  assert.equal(readCalendlyMeta(undefined), null);
});

// ── booking guardrails ──

const baseArgs = {
  companySlug: 'cleanilo',
  orderId: 1,
  customerName: 'Test',
  customerEmail: 'test@example.com',
  existing: null,
  log: silentLog,
};

test('bookConfirmedSlot rejects an unparsable slot before touching the network', async () => {
  // Holds whether or not credentials are present — the guard runs first.
  const result = await bookConfirmedSlot({ ...baseArgs, slot: '12.08.2026 10:00' });
  assert.equal(result.ok, false);
  assert.equal(result.meta, null);
  assert.match(result.error!, /Unlesbarer Termin/);
});

test(
  'bookConfirmedSlot skips cleanly when Calendly is not configured',
  {
    // A developer with live credentials in .env would otherwise have this unit
    // test book a real appointment in the CLEANILO calendar. CI has no token, so
    // the assertion still runs where it matters.
    skip: calendlyBookingConfigured
      ? 'CALENDLY_* configured locally — would hit the live API'
      : false,
  },
  async () => {
    const result = await bookConfirmedSlot({ ...baseArgs, slot: '2026-08-12T10:00' });
    assert.equal(result.skipped, true);
    assert.equal(result.ok, false);
    assert.equal(result.meta, null);
    assert.equal(result.error, undefined);
  },
);
