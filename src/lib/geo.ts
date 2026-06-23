import { env } from '../config/env.js';
import { PLZ_CENTROIDS } from './plz-centroids.generated.js';

export type CallbackOwner = 'human' | 'ai';

export interface Coords {
  lat: number;
  lng: number;
}

/**
 * How the geo lookup resolved:
 *  - `geocoded`  → PLZ found in the centroid table, distance computed.
 *  - `ungeocoded`→ PLZ missing/invalid; could not place it on the map.
 */
export type GeoStatus = 'geocoded' | 'ungeocoded';

export interface CallbackRouting {
  callbackOwner: CallbackOwner;
  /** Straight-line km from the reference point, or null when ungeocodable. */
  distanceKm: number | null;
  geoStatus: GeoStatus;
}

/** Great-circle distance in km between two lat/lng points. */
export function haversineKm(a: Coords, b: Coords): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLng = toRad(b.lng - a.lng);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLng / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

/** Normalises input to a 5-digit PLZ and returns its centroid, or null. */
export function geocodePlz(plzInput: string | null | undefined): Coords | null {
  if (!plzInput) return null;
  const plz = plzInput.trim();
  if (!/^\d{5}$/.test(plz)) return null;
  const hit = PLZ_CENTROIDS[plz];
  return hit ? { lat: hit[0], lng: hit[1] } : null;
}

/**
 * Decide who owns the callback for a service PLZ.
 *
 * Within the configured radius of the reference point → a HUMAN handles it
 * (Hamburg-area lead, called personally). Outside → the automated AI queue.
 *
 * Fail-safe: a PLZ we cannot place (malformed, non-German, or absent from the
 * table) routes to a HUMAN for triage rather than letting the AI cold-call a
 * lead whose location we never confirmed.
 */
export function routeCallback(plzInput: string | null | undefined): CallbackRouting {
  const coords = geocodePlz(plzInput);
  if (!coords) {
    return { callbackOwner: 'human', distanceKm: null, geoStatus: 'ungeocoded' };
  }
  const ref: Coords = { lat: env.CALLBACK_GEO_REF_LAT, lng: env.CALLBACK_GEO_REF_LNG };
  const distanceKm = haversineKm(ref, coords);
  const callbackOwner: CallbackOwner = distanceKm <= env.CALLBACK_GEO_RADIUS_KM ? 'human' : 'ai';
  return { callbackOwner, distanceKm, geoStatus: 'geocoded' };
}
