import { test } from 'node:test';
import assert from 'node:assert/strict';
import crypto from 'node:crypto';

import {
  CalendlyError,
  buildQuestionAnswers,
  buildTrackingKey,
  parseTrackingKey,
  toCalendlyUtc,
  uuidFromUri,
  verifyCalendlyWebhook,
} from './calendly.js';

const KEY = 'test-signing-key-0123456789';
const BODY = '{"event":"invitee.created","payload":{"uri":"x"}}';

function sign(payload: string, key = KEY): string {
  return crypto.createHmac('sha256', key).update(payload, 'utf8').digest('hex');
}

// ── tracking key (order correlation across the shared CLEANILO account) ──

test('tracking key round-trips company slug and order id', () => {
  const key = buildTrackingKey('hamburg_teppichreinigung', 4711);
  assert.equal(key, 'order:hamburg_teppichreinigung:4711');
  assert.deepEqual(parseTrackingKey(key), {
    companySlug: 'hamburg_teppichreinigung',
    orderId: 4711,
  });
});

test('tracking key rejects anything that is not ours', () => {
  for (const bad of [
    undefined,
    null,
    42,
    '',
    'order:cleanilo',
    'order:cleanilo:0',
    'order:cleanilo:-3',
    'order:cleanilo:abc',
    'order::7',
    'lead:cleanilo:7',
    'order:cleanilo:7:extra',
  ]) {
    assert.equal(parseTrackingKey(bad), null, `should reject ${JSON.stringify(bad)}`);
  }
});

// ── webhook signature ──

test('accepts the documented t=/v1= signature', () => {
  const t = 1_800_000_000;
  const header = `t=${t},v1=${sign(`${t}.${BODY}`)}`;
  assert.equal(verifyCalendlyWebhook(header, BODY, { signingKey: KEY, nowMs: t * 1000 }), true);
});

test('accepts the bare-digest signature form', () => {
  assert.equal(verifyCalendlyWebhook(sign(BODY), BODY, { signingKey: KEY }), true);
});

test('rejects a signature made with the wrong key', () => {
  const t = 1_800_000_000;
  const header = `t=${t},v1=${sign(`${t}.${BODY}`, 'other-key')}`;
  assert.equal(verifyCalendlyWebhook(header, BODY, { signingKey: KEY, nowMs: t * 1000 }), false);
  assert.equal(verifyCalendlyWebhook(sign(BODY, 'other-key'), BODY, { signingKey: KEY }), false);
});

test('rejects a tampered body', () => {
  const t = 1_800_000_000;
  const header = `t=${t},v1=${sign(`${t}.${BODY}`)}`;
  assert.equal(
    verifyCalendlyWebhook(header, BODY.replace('created', 'canceled'), {
      signingKey: KEY,
      nowMs: t * 1000,
    }),
    false,
  );
});

test('rejects a replayed signature outside the tolerance window', () => {
  const t = 1_800_000_000;
  const header = `t=${t},v1=${sign(`${t}.${BODY}`)}`;
  const opts = { signingKey: KEY, toleranceSeconds: 300 };
  assert.equal(verifyCalendlyWebhook(header, BODY, { ...opts, nowMs: (t + 299) * 1000 }), true);
  assert.equal(verifyCalendlyWebhook(header, BODY, { ...opts, nowMs: (t + 301) * 1000 }), false);
  // Clock skew in the other direction is treated the same.
  assert.equal(verifyCalendlyWebhook(header, BODY, { ...opts, nowMs: (t - 301) * 1000 }), false);
});

test('rejects when the signing key or header is missing', () => {
  assert.equal(verifyCalendlyWebhook(sign(BODY), BODY, { signingKey: null }), false);
  assert.equal(verifyCalendlyWebhook(undefined, BODY, { signingKey: KEY }), false);
  assert.equal(verifyCalendlyWebhook('', BODY, { signingKey: KEY }), false);
});

test('rejects junk that is not a signature at all', () => {
  for (const bad of ['not-hex', 't=,v1=', 'v1=deadbeef', `t=abc,v1=${sign(`abc.${BODY}`)}`]) {
    assert.equal(
      verifyCalendlyWebhook(bad, BODY, { signingKey: KEY, nowMs: 1_800_000_000_000 }),
      false,
      `should reject ${bad}`,
    );
  }
});

// ── formatting helpers ──

test('toCalendlyUtc emits whole-minute UTC with a trailing Z', () => {
  assert.equal(toCalendlyUtc(new Date('2026-08-12T08:00:00.000Z')), '2026-08-12T08:00:00Z');
  // Seconds and millis are floored — Calendly rejects sub-minute precision.
  assert.equal(toCalendlyUtc(new Date('2026-08-12T08:00:45.900Z')), '2026-08-12T08:00:00Z');
});

test('uuidFromUri takes the trailing segment', () => {
  assert.equal(uuidFromUri('https://api.calendly.com/scheduled_events/AAAA-BBBB'), 'AAAA-BBBB');
  assert.equal(uuidFromUri('https://api.calendly.com/scheduled_events/AAAA/'), 'AAAA');
  assert.equal(uuidFromUri(null), null);
  assert.equal(uuidFromUri(undefined), null);
});

// ── question answering (shapes the live API actually enforces) ──

const Q = (over: Partial<{ name: string; type: string; position: number; required: boolean }>) => ({
  name: 'Frage',
  type: 'string',
  position: 0,
  required: true,
  ...over,
});

test('phone questions get the phone, address questions the address', () => {
  const answers = buildQuestionAnswers(
    [
      Q({ name: 'Telefonnummer', type: 'phone_number', position: 0 }),
      Q({ name: 'Wie ist die vollständige Adresse?', position: 2 }),
      Q({ name: 'Welchen Service brauchen Sie?', position: 1 }),
    ],
    {
      customerPhone: '+49 40 111',
      addressText: 'Brook 9, 20457 Hamburg',
      serviceSummary: 'Teppichreinigung · Auftrag 2026/000001',
    },
  );
  assert.deepEqual(answers, [
    { question: 'Telefonnummer', answer: '+49 40 111', position: 0 },
    {
      question: 'Wie ist die vollständige Adresse?',
      answer: 'Brook 9, 20457 Hamburg',
      position: 2,
    },
    {
      question: 'Welchen Service brauchen Sie?',
      // Free-text gets the job plus the address appended.
      answer: 'Teppichreinigung · Auftrag 2026/000001 · Brook 9, 20457 Hamburg',
      position: 1,
    },
  ]);
});

test('a long brief that merely mentions "Adresse" is not the address question', () => {
  // CLEANILO's real event type has exactly this pair; matching on the keyword
  // alone gave the long brief the address and dropped the service description.
  const LONG =
    'Damit wir uns gut vorbereiten können: Bitte nennen Sie kurz den gewünschten ' +
    'Service, die Adresse, Umfang (m²/Anzahl) und ggf. Flecken oder besondere ' +
    'Hinweise (Zugang/Parken).';
  const answers = buildQuestionAnswers(
    [Q({ name: LONG, position: 1 }), Q({ name: 'Wie ist die vollständige Adresse?', position: 2 })],
    { addressText: 'Brook 9, 20457 Hamburg', serviceSummary: 'Teppichreinigung · 2 Perser' },
  );
  assert.equal(answers[0]!.answer, 'Teppichreinigung · 2 Perser · Brook 9, 20457 Hamburg');
  assert.equal(answers[1]!.answer, 'Brook 9, 20457 Hamburg');
});

test('a required question with no matching data still gets a non-empty answer', () => {
  // An unanswered required question is a hard 400 — a visible marker beats a
  // booking that never happens.
  const answers = buildQuestionAnswers([Q({ name: 'Sonstiges' })], {});
  assert.equal(answers.length, 1);
  assert.equal(answers[0]!.answer, 'Siehe Auftrag im Dashboard');
});

test('optional questions with no data are omitted entirely', () => {
  assert.deepEqual(buildQuestionAnswers([Q({ name: 'Sonstiges', required: false })], {}), []);
});

test('a required phone question without a phone fails loud, not with junk', () => {
  // Calendly validates phone_number, so a text placeholder would 400 anyway —
  // this way the operator is told to add the number to the order.
  assert.throws(
    () => buildQuestionAnswers([Q({ name: 'Telefonnummer', type: 'phone_number' })], {}),
    /Telefonnummer/,
  );
  // Optional phone question with no phone is simply skipped.
  assert.deepEqual(
    buildQuestionAnswers([Q({ name: 'Telefonnummer', type: 'phone_number', required: false })], {}),
    [],
  );
});

test('a taken slot is recognised however Calendly reports it', () => {
  // Observed live: a double-booking is a plain 400 naming event.start_time,
  // not a 409 — misreading it would tell the operator "outage" instead of
  // "pick another time".
  const taken = new CalendlyError('…', 400, 'Invalid Argument', ['event.start_time']);
  assert.equal(taken.isSlotUnavailable, true);
  assert.equal(new CalendlyError('…', 409, 'Conflict').isSlotUnavailable, true);
  assert.equal(new CalendlyError('…', 422, 'Invalid Argument').isSlotUnavailable, true);
  // A different 400 is a real bug on our side, not a busy calendar.
  assert.equal(
    new CalendlyError('…', 400, 'Invalid Argument', ['tracking.utm_medium']).isSlotUnavailable,
    false,
  );
  assert.equal(new CalendlyError('…', 500, 'InternalError').isSlotUnavailable, false);
});
