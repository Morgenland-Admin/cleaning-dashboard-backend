import assert from 'node:assert/strict';
import { test } from 'node:test';

import { applyDeliveryEvent, MAX_EVENTS_PER_EMAIL, storesBody, type DeliveryState } from './log.js';
import { toDeliveryEvent } from '../modules/emails/webhook.js';

const fresh = (): DeliveryState => ({
  deliveryStatus: null,
  deliveredAt: null,
  openedAt: null,
  clickedAt: null,
  events: [],
});

const at = (s: string) => new Date(`2026-10-18T10:${s}Z`);

test('storesBody: secret-bearing mail is logged without its HTML', () => {
  assert.equal(storesBody('password_reset'), false);
  assert.equal(storesBody('invite'), false);
  assert.equal(storesBody('newsletter_confirm'), false);
  assert.equal(storesBody('invoice'), true);
  assert.equal(storesBody('receipt'), true);
});

test('applyDeliveryEvent: sent → delivered → opened', () => {
  let s = applyDeliveryEvent(fresh(), { type: 'sent', at: at('00:00') });
  assert.equal(s.deliveryStatus, 'sent');
  s = applyDeliveryEvent(s, { type: 'delivered', at: at('00:02') });
  assert.equal(s.deliveryStatus, 'delivered');
  assert.deepEqual(s.deliveredAt, at('00:02'));
  s = applyDeliveryEvent(s, { type: 'opened', at: at('05:00') });
  assert.equal(s.deliveryStatus, 'delivered');
  assert.deepEqual(s.openedAt, at('05:00'));
  assert.deepEqual(
    s.events.map((e) => e.type),
    ['sent', 'delivered', 'opened'],
  );
});

test('applyDeliveryEvent: out-of-order "sent" or "delayed" never downgrades delivered', () => {
  let s = applyDeliveryEvent(fresh(), { type: 'delivered', at: at('00:02') });
  s = applyDeliveryEvent(s, { type: 'sent', at: at('00:00') });
  s = applyDeliveryEvent(s, { type: 'delivery_delayed', at: at('00:01') });
  assert.equal(s.deliveryStatus, 'delivered');
  assert.deepEqual(
    s.events.map((e) => e.type),
    ['sent', 'delivery_delayed', 'delivered'],
  );
});

test('applyDeliveryEvent: a bounce or complaint after delivery wins', () => {
  let s = applyDeliveryEvent(fresh(), { type: 'delivered', at: at('00:02') });
  s = applyDeliveryEvent(s, { type: 'bounced', at: at('00:03'), detail: 'Mailbox full' });
  assert.equal(s.deliveryStatus, 'bounced');
  assert.equal(s.events.at(-1)?.detail, 'Mailbox full');
  s = applyDeliveryEvent(s, { type: 'complained', at: at('09:00') });
  assert.equal(s.deliveryStatus, 'complained');
});

test('applyDeliveryEvent: an open without a delivered event still counts as delivered', () => {
  const s = applyDeliveryEvent(fresh(), { type: 'opened', at: at('05:00') });
  assert.equal(s.deliveryStatus, 'delivered');
  assert.deepEqual(s.deliveredAt, at('05:00'));
});

test('applyDeliveryEvent: a click implies an open; first open/click time is kept', () => {
  let s = applyDeliveryEvent(fresh(), { type: 'clicked', at: at('06:00'), detail: 'https://x' });
  assert.deepEqual(s.openedAt, at('06:00'));
  assert.deepEqual(s.clickedAt, at('06:00'));
  s = applyDeliveryEvent(s, { type: 'opened', at: at('05:30') });
  assert.deepEqual(s.openedAt, at('05:30'));
  s = applyDeliveryEvent(s, { type: 'opened', at: at('07:00') });
  assert.deepEqual(s.openedAt, at('05:30'));
});

test('applyDeliveryEvent: a retried webhook is a no-op (same reference)', () => {
  const s = applyDeliveryEvent(fresh(), { type: 'delivered', at: at('00:02') });
  assert.equal(applyDeliveryEvent(s, { type: 'delivered', at: at('00:02') }), s);
});

test('applyDeliveryEvent: event history is capped to the newest entries', () => {
  let s = fresh();
  for (let i = 0; i < MAX_EVENTS_PER_EMAIL + 5; i += 1) {
    s = applyDeliveryEvent(s, { type: 'opened', at: new Date(Date.UTC(2026, 9, 18, 10, 0, i)) });
  }
  assert.equal(s.events.length, MAX_EVENTS_PER_EMAIL);
  assert.equal(s.events[0]?.at, new Date(Date.UTC(2026, 9, 18, 10, 0, 5)).toISOString());
});

test('toDeliveryEvent: strips the prefix, carries the reason, ignores inbound mail', () => {
  const base = { created_at: '2026-10-18T10:00:00.000Z', data: { email_id: 'e1' } };
  assert.deepEqual(
    toDeliveryEvent({
      ...base,
      type: 'email.bounced',
      data: { email_id: 'e1', bounce: { message: 'No such user' } },
    }),
    { type: 'bounced', at: new Date(base.created_at), detail: 'No such user' },
  );
  assert.equal(toDeliveryEvent({ ...base, type: 'email.received' }), null);
  assert.equal(toDeliveryEvent({ ...base, type: 'contact.created' }), null);
  assert.equal(toDeliveryEvent({ ...base, type: 'email.sent', created_at: 'garbage' }), null);
});
