export type PickupZone = 1 | 2 | 3 | 4;

export interface Coords {
  lat: number;
  lon: number;
}

export interface PickupZoneResult {
  zone: PickupZone;
  feeCents: number;
  label: string;
  outOfArea: boolean;
}

const ZONE_FEES_CENTS: Record<PickupZone, number> = {
  1: 2990,
  2: 3990,
  3: 4990,
  4: 0,
};

const ZONE_LABELS: Record<PickupZone, string> = {
  1: 'Zone 1 · Hamburg + 15 km',
  2: 'Zone 2 · 15–30 km',
  3: 'Zone 3 · 30–50 km',
  4: 'Zone 4 · außerhalb · auf Anfrage',
};

const OVERRIDES: Record<string, PickupZone> = {};

const WORKSHOP: Coords = { lat: 53.5443, lon: 10.0027 };

const ROAD_DETOUR_FACTOR = 1.3;

const ZONE_MAX_KM: { zone: PickupZone; maxKm: number }[] = [
  { zone: 1, maxKm: 15 },
  { zone: 2, maxKm: 30 },
  { zone: 3, maxKm: 50 },
];

function haversineKm(a: Coords, b: Coords): number {
  const R = 6371;
  const toRad = (deg: number) => (deg * Math.PI) / 180;
  const dLat = toRad(b.lat - a.lat);
  const dLon = toRad(b.lon - a.lon);
  const h =
    Math.sin(dLat / 2) ** 2 +
    Math.cos(toRad(a.lat)) * Math.cos(toRad(b.lat)) * Math.sin(dLon / 2) ** 2;
  return 2 * R * Math.asin(Math.sqrt(h));
}

function zoneForDistanceKm(km: number): PickupZone {
  for (const t of ZONE_MAX_KM) {
    if (km <= t.maxKm) return t.zone;
  }
  return 4;
}

const PREFIX_TO_ZONE: Record<string, PickupZone> = {
  '20': 1,
  '21': 1,
  '22': 1,
  '25': 2,
  '27': 2,
  '23': 2,
  '24': 3,
  '28': 3,
  '29': 3,
  '31': 3,
};

const BEYOND_NORTH = new Set([
  '0',
  '1',
  '3',
  '4',
  '5',
  '6',
  '7',
  '8',
  '9',
  '26',
  '30',
  '32',
  '33',
  '34',
  '35',
  '36',
  '37',
  '38',
  '39',
]);

export function resolvePickupZone(plzInput: string, coords?: Coords): PickupZoneResult {
  const plz = plzInput.trim();
  if (!/^\d{5}$/.test(plz)) {
    throw new Error('PLZ must be exactly 5 digits');
  }

  let zone: PickupZone;
  if (OVERRIDES[plz]) {
    zone = OVERRIDES[plz];
  } else if (coords && Number.isFinite(coords.lat) && Number.isFinite(coords.lon)) {
    zone = zoneForDistanceKm(haversineKm(WORKSHOP, coords) * ROAD_DETOUR_FACTOR);
  } else {
    zone =
      PREFIX_TO_ZONE[plz.slice(0, 2)] ??
      (BEYOND_NORTH.has(plz.slice(0, 1)) || BEYOND_NORTH.has(plz.slice(0, 2)) ? 4 : 3);
  }

  return {
    zone,
    feeCents: ZONE_FEES_CENTS[zone],
    label: ZONE_LABELS[zone],
    outOfArea: zone === 4,
  };
}

export function effectivePickupFeeCents(
  zone: PickupZone,
  totalCarpetSqm: number,
  freeSqmThreshold: number,
): number {
  if (zone === 4) return 0;
  if (totalCarpetSqm >= freeSqmThreshold) return 0;
  return ZONE_FEES_CENTS[zone];
}
