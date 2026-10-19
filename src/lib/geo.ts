import { env } from '../config/env.js';
import { PLZ_CENTROIDS } from './plz-centroids.generated.js';

export type CallbackOwner = 'human' | 'ai';

export interface Coords {
  lat: number;
  lng: number;
}

export type GeoStatus = 'geocoded' | 'ungeocoded';

export interface CallbackRouting {
  callbackOwner: CallbackOwner;
  distanceKm: number | null;
  geoStatus: GeoStatus;
}

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

export function geocodePlz(plzInput: string | null | undefined): Coords | null {
  if (!plzInput) return null;
  const plz = plzInput.trim();
  if (!/^\d{5}$/.test(plz)) return null;
  const hit = PLZ_CENTROIDS[plz];
  return hit ? { lat: hit[0], lng: hit[1] } : null;
}

/**
 * Within the configured radius a HUMAN calls, outside the AI queue. Fail-safe: a PLZ we cannot place
 * goes to a HUMAN for triage, never the AI cold-calling a lead whose location is unconfirmed.
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
