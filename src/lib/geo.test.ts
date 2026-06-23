import { test } from 'node:test';
import assert from 'node:assert/strict';
import { geocodePlz, haversineKm, routeCallback } from './geo.js';

// Reference: PLZ 20457 (Hamburg HafenCity), the env default.
const HAMBURG = { lat: 53.53165, lng: 9.98526 };

test('geocodePlz resolves a known PLZ to its centroid', () => {
  assert.deepEqual(geocodePlz('20457'), HAMBURG);
});

test('geocodePlz normalises whitespace', () => {
  assert.deepEqual(geocodePlz('  20457 '), HAMBURG);
});

test('geocodePlz returns null for malformed / unknown PLZ', () => {
  assert.equal(geocodePlz('123'), null);
  assert.equal(geocodePlz('abcde'), null);
  assert.equal(geocodePlz('00000'), null);
  assert.equal(geocodePlz(''), null);
  assert.equal(geocodePlz(null), null);
  assert.equal(geocodePlz(undefined), null);
});

test('haversine distance is zero from a point to itself', () => {
  assert.equal(Math.round(haversineKm(HAMBURG, HAMBURG)), 0);
});

// Boundary cases Kabir spot-checked against the 100 km cutoff.
test('cities within 100 km route to a human', () => {
  for (const plz of ['28195' /* Bremen */, '24103' /* Kiel */, '23552' /* Lübeck */]) {
    const r = routeCallback(plz);
    assert.equal(r.geoStatus, 'geocoded');
    assert.equal(
      r.callbackOwner,
      'human',
      `${plz} (${r.distanceKm?.toFixed(0)} km) should be human`,
    );
    assert.ok((r.distanceKm ?? Infinity) <= 100, `${plz} should be <= 100 km`);
  }
});

test('cities beyond 100 km route to the AI queue', () => {
  for (const plz of ['30159' /* Hannover */, '10115' /* Berlin */]) {
    const r = routeCallback(plz);
    assert.equal(r.geoStatus, 'geocoded');
    assert.equal(r.callbackOwner, 'ai', `${plz} (${r.distanceKm?.toFixed(0)} km) should be ai`);
    assert.ok((r.distanceKm ?? 0) > 100, `${plz} should be > 100 km`);
  }
});

test('the reference PLZ itself is a human callback (distance ~0)', () => {
  const r = routeCallback('20457');
  assert.equal(r.callbackOwner, 'human');
  assert.ok((r.distanceKm ?? 1) < 1);
});

test('ungeocodable PLZ fails safe to human triage', () => {
  const r = routeCallback('99999-not-a-plz');
  assert.equal(r.geoStatus, 'ungeocoded');
  assert.equal(r.callbackOwner, 'human');
  assert.equal(r.distanceKm, null);
});
