import { haversineKm, type Coords } from './geo.js';

export interface MatchCandidate {
  id: number;
  companyName: string | null;
  status: string;
  lat: number | null;
  lng: number | null;
  serviceRadiusKm: number;
  services: string[];
  rating: number | null;
  verified: boolean;
  openOffers: number;
}

export type MatchReason =
  | 'not_active'
  | 'not_verified'
  | 'no_location'
  | 'out_of_radius'
  | 'service_not_offered';

export interface MatchResult {
  partnerId: number;
  companyName: string | null;
  distanceKm: number | null;
  rating: number | null;
  openOffers: number;
  eligible: boolean;
  reasons: MatchReason[];
}

/**
 * Every partner with why they do or don't fit, eligible ones first by distance, then rating.
 * `target` null (unknown PLZ) skips the radius check; `serviceSlugs` null skips the service check,
 * otherwise the partner must offer at least one of them.
 */
export function rankPartners(
  candidates: MatchCandidate[],
  target: Coords | null,
  serviceSlugs: string[] | null,
): MatchResult[] {
  const results = candidates.map((c): MatchResult => {
    const reasons: MatchReason[] = [];
    if (c.status !== 'active') reasons.push('not_active');
    if (!c.verified) reasons.push('not_verified');
    let distanceKm: number | null = null;
    if (c.lat == null || c.lng == null) {
      reasons.push('no_location');
    } else if (target) {
      distanceKm = Math.round(haversineKm(target, { lat: c.lat, lng: c.lng }) * 10) / 10;
      if (distanceKm > c.serviceRadiusKm) reasons.push('out_of_radius');
    }
    if (serviceSlugs && !serviceSlugs.some((s) => c.services.includes(s))) {
      reasons.push('service_not_offered');
    }
    return {
      partnerId: c.id,
      companyName: c.companyName,
      distanceKm,
      rating: c.rating,
      openOffers: c.openOffers,
      eligible: reasons.length === 0,
      reasons,
    };
  });
  return results.sort((a, b) => {
    if (a.eligible !== b.eligible) return a.eligible ? -1 : 1;
    const da = a.distanceKm ?? Number.POSITIVE_INFINITY;
    const dbk = b.distanceKm ?? Number.POSITIVE_INFINITY;
    if (da !== dbk) return da - dbk;
    return (b.rating ?? 0) - (a.rating ?? 0);
  });
}
