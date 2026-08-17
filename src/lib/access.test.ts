import assert from 'node:assert/strict';
import { test } from 'node:test';

import { accessLevelOf, isPrivileged, redactForViewer, redactListForViewer } from './access.js';

test('isPrivileged: manager and up, nothing else', () => {
  assert.equal(isPrivileged('super_admin'), true);
  assert.equal(isPrivileged('admin'), true);
  assert.equal(isPrivileged('manager'), true);
  assert.equal(isPrivileged('viewer'), false);
  assert.equal(isPrivileged('none'), false);
  assert.equal(isPrivileged(undefined), false);
  // Not a level we issue — must not be treated as privileged by accident.
  assert.equal(isPrivileged('owner'), false);
});

test('redactForViewer: a privileged row is returned untouched, same reference', () => {
  const row = { internalNotes: 'staff only', ipAddress: '1.2.3.4', customerName: 'Anna' };
  assert.equal(redactForViewer(row, 'manager'), row);
});

test('redactForViewer: a viewer loses notes, forensics and processor ids', () => {
  const out = redactForViewer(
    {
      customerName: 'Anna',
      customerEmail: 'anna@example.com',
      internalNotes: 'staff only',
      ipAddress: '1.2.3.4',
      userAgent: 'Mozilla/5.0',
      stripeSessionId: 'cs_test_1',
      stripePaymentIntentId: 'pi_1',
      paypalOrderId: 'PP-1',
      paypalCaptureId: 'CAP-1',
    },
    'viewer',
  );
  assert.equal(out.internalNotes, null);
  assert.equal(out.ipAddress, null);
  assert.equal(out.userAgent, null);
  assert.equal(out.stripeSessionId, null);
  assert.equal(out.stripePaymentIntentId, null);
  assert.equal(out.paypalOrderId, null);
  assert.equal(out.paypalCaptureId, null);
  // The operational record survives — a viewer still has to do the job.
  assert.equal(out.customerName, 'Anna');
  assert.equal(out.customerEmail, 'anna@example.com');
});

test('redactForViewer: absent fields are not invented', () => {
  const out = redactForViewer({ customerName: 'Anna' }, 'viewer');
  assert.deepEqual(Object.keys(out), ['customerName']);
  assert.equal('internalNotes' in out, false);
});

test('redactForViewer: does not mutate the input row', () => {
  const row = { internalNotes: 'staff only' };
  redactForViewer(row, 'viewer');
  assert.equal(row.internalNotes, 'staff only');
});

test('redactForViewer: an undefined level is treated as unprivileged', () => {
  assert.equal(redactForViewer({ internalNotes: 'x' }, undefined).internalNotes, null);
});

test('redactListForViewer: redacts every row for a viewer', () => {
  const rows = [{ internalNotes: 'a' }, { internalNotes: 'b' }];
  const out = redactListForViewer(rows, 'viewer');
  assert.deepEqual(out, [{ internalNotes: null }, { internalNotes: null }]);
  // input untouched
  assert.deepEqual(rows, [{ internalNotes: 'a' }, { internalNotes: 'b' }]);
});

test('redactListForViewer: privileged list is the same reference', () => {
  const rows = [{ internalNotes: 'a' }];
  assert.equal(redactListForViewer(rows, 'admin'), rows);
});

test('accessLevelOf: reads the level, tolerates a missing user', () => {
  assert.equal(accessLevelOf({ authUser: { accessLevel: 'viewer' } }), 'viewer');
  assert.equal(accessLevelOf({ authUser: null }), undefined);
  assert.equal(accessLevelOf({ authUser: {} }), undefined);
});
