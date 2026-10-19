import { test } from 'node:test';
import assert from 'node:assert/strict';
import { rankPartners, type MatchCandidate } from './partner-matching.js';
import { geocodePlz } from './geo.js';

const hamburg = geocodePlz('20457')!;
const munich = geocodePlz('80331')!;

function candidate(over: Partial<MatchCandidate>): MatchCandidate {
  return {
    id: 1,
    companyName: 'A',
    status: 'active',
    lat: hamburg.lat,
    lng: hamburg.lng,
    serviceRadiusKm: 30,
    services: ['teppichreinigung'],
    rating: null,
    verified: true,
    openOffers: 0,
    ...over,
  };
}

test('eligible partner within radius offering the service', () => {
  const [r] = rankPartners([candidate({})], hamburg, ['teppichreinigung']);
  assert.equal(r!.eligible, true);
  assert.deepEqual(r!.reasons, []);
  assert.equal(r!.distanceKm, 0);
});

test('every failing rule is reported', () => {
  const [r] = rankPartners(
    [candidate({ status: 'pending', verified: false, services: ['dachreinigung'] })],
    munich,
    ['teppichreinigung'],
  );
  assert.equal(r!.eligible, false);
  assert.deepEqual(r!.reasons, [
    'not_active',
    'not_verified',
    'out_of_radius',
    'service_not_offered',
  ]);
});

test('partner without coordinates is never eligible', () => {
  const [r] = rankPartners([candidate({ lat: null, lng: null })], hamburg, null);
  assert.deepEqual(r!.reasons, ['no_location']);
  assert.equal(r!.distanceKm, null);
});

test('unknown target skips the radius check but keeps the service check', () => {
  const [r] = rankPartners([candidate({ lat: munich.lat, lng: munich.lng })], null, [
    'teppichreinigung',
  ]);
  assert.equal(r!.eligible, true);
});

test('eligible first, then nearest, then best rated', () => {
  const near = geocodePlz('22087')!;
  const ranked = rankPartners(
    [
      candidate({ id: 1, lat: munich.lat, lng: munich.lng, serviceRadiusKm: 1000 }),
      candidate({ id: 2, verified: false }),
      candidate({ id: 3, lat: near.lat, lng: near.lng, rating: 4 }),
      candidate({ id: 4, lat: near.lat, lng: near.lng, rating: 5 }),
    ],
    hamburg,
    ['teppichreinigung'],
  );
  assert.deepEqual(
    ranked.map((r) => r.partnerId),
    [4, 3, 1, 2],
  );
});

test('any of several service slugs is enough', () => {
  const [r] = rankPartners([candidate({ services: ['orientteppichreinigung'] })], hamburg, [
    'teppichreinigung',
    'orientteppichreinigung',
  ]);
  assert.equal(r!.eligible, true);
});
