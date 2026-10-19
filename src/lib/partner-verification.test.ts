import { test } from 'node:test';
import assert from 'node:assert/strict';
import { partnerChecklist, type VerificationPartner } from './partner-verification.js';

const complete: VerificationPartner = {
  status: 'active',
  companyName: 'Reinigung GmbH',
  contactEmail: 'info@example.com',
  contactPhone: '+49 40 1',
  addressLine1: 'Weg 1',
  postalCode: '20457',
  city: 'Hamburg',
  lat: 53.5,
  services: ['teppichreinigung'],
  contractVersion: '2026-10',
  payoutsEnabled: false,
  stripeConnectStatus: 'none',
};

const approvedDocs = [
  { kind: 'gewerbeanmeldung', status: 'approved', expiresAt: null },
  { kind: 'haftpflicht', status: 'approved', expiresAt: '2027-01-01' },
];

test('complete partner is verified; payouts are tracked but not required', () => {
  const c = partnerChecklist(complete, approvedDocs, '2026-10', '2026-10-20');
  assert.equal(c.verified, true);
  assert.deepEqual(c.missing, []);
  assert.equal(c.payouts.ok, false);
});

test('expired insurance blocks verification', () => {
  const docs = [
    approvedDocs[0]!,
    { kind: 'haftpflicht', status: 'approved', expiresAt: '2026-10-19' },
  ];
  const c = partnerChecklist(complete, docs, '2026-10', '2026-10-20');
  assert.equal(c.verified, false);
  assert.equal(c.documents.find((d) => d.kind === 'haftpflicht')!.state, 'expired');
});

test('a pending re-upload shows pending, a rejected-only document shows rejected', () => {
  const docs = [
    { kind: 'gewerbeanmeldung', status: 'rejected', expiresAt: null },
    { kind: 'haftpflicht', status: 'approved', expiresAt: '2026-01-01' },
    { kind: 'haftpflicht', status: 'pending', expiresAt: null },
  ];
  const c = partnerChecklist(complete, docs, null, '2026-10-20');
  assert.deepEqual(
    c.documents.map((d) => d.state),
    ['rejected', 'pending'],
  );
});

test('new contract version requires re-acceptance', () => {
  const c = partnerChecklist(complete, approvedDocs, '2027-01', '2026-10-20');
  assert.equal(c.contract.ok, false);
  assert.deepEqual(c.missing, ['contract']);
});

test('no contract configured means no contract step', () => {
  const c = partnerChecklist(
    { ...complete, contractVersion: null },
    approvedDocs,
    null,
    '2026-10-20',
  );
  assert.equal(c.contract.ok, true);
  assert.equal(c.verified, true);
});

test('missing profile, services and location are listed', () => {
  const c = partnerChecklist(
    { ...complete, contactPhone: null, services: [], lat: null },
    [],
    null,
    '2026-10-20',
  );
  assert.deepEqual(c.missing, [
    'profile',
    'services',
    'location',
    'document:gewerbeanmeldung',
    'document:haftpflicht',
  ]);
});
