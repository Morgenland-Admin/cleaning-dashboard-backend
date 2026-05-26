/**
 * Coarse PLZ → pickup-zone lookup for Hamburg Teppichreinigung.
 *
 * The PDF lists 4 buckets by distance from the Speicherstadt workshop:
 *   Zone 1: 0–15 km   → 29.90 €  (Hamburg + immediate suburbs)
 *   Zone 2: 15–30 km  → 39.90 €
 *   Zone 3: 30–50 km  → 49.90 €
 *   Zone 4: > 50 km   → "Auf Anfrage" (no online checkout)
 *
 * All zones: pickup is FREE if the order is ≥ 6 qm of carpet (per Section 9
 * of the price list). We don't apply the fee for Selbst-Abgabe — that's the
 * pickup_mode = "drop_off" branch in the order schema.
 *
 * We use a PLZ-prefix lookup instead of a geocoder because:
 *   (a) zero external API dep on a hot path
 *   (b) the prices are coarse — bucketing by prefix is accurate enough
 *   (c) edge-case PLZs (rare) can be added to OVERRIDES as we learn them
 *
 * If the prefix isn't recognized we fall back to the most expensive served
 * zone (Zone 3) — the driver can still decline a pickup outside Hamburg's
 * normal coverage area, but the customer at least sees a price. Pure
 * unknowns (e.g. southern Germany) fall to Zone 4 via the explicit
 * BEYOND_NORTH list.
 */

export type PickupZone = 1 | 2 | 3 | 4;

export interface PickupZoneResult {
  zone: PickupZone;
  /** Fee in cents (matches Stripe + DB storage). 0 for Zone 4 = no online sale. */
  feeCents: number;
  /** Human label, German. */
  label: string;
  /** True if Zone 4 → must go through Anfrage flow, no checkout. */
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

// PLZ → zone overrides for known edge cases. PLZs at zone borders are
// inevitably approximate; this table lets us correct them per real-world
// experience without changing the prefix logic.
const OVERRIDES: Record<string, PickupZone> = {
  // (Add specific 5-digit PLZs here as the team encounters odd cases.)
};

// First-2-digit prefixes that cover Hamburg + reasonable pickup radius.
// Hamburg city is 20xxx–22xxx; the surrounding PLZs spill into 21xxx (Lower
// Saxony south of Elbe), 22xxx (Hamburg-Bergedorf + Schleswig-Holstein south),
// 23xxx (Lübeck axis), 25xxx (north-west to Pinneberg), 27xxx (Stade-Bremen
// corridor), 24xxx/28xxx (further out). Beyond that we're past 50 km.
const PREFIX_TO_ZONE: Record<string, PickupZone> = {
  // Zone 1 — Hamburg metro
  '20': 1,
  '21': 1, // most of 21xxx is south-bank Hamburg / Harburg / Buxtehude
  '22': 1, // Hamburg east + Schleswig-Holstein near suburbs

  // Zone 2 — ~15–30 km out
  '25': 2, // Pinneberg, Elmshorn axis
  '27': 2, // Stade, Buxtehude-west, Tostedt
  '23': 2, // Bad Oldesloe / Reinbek (some of 23xxx is closer, some farther)

  // Zone 3 — ~30–50 km out
  '24': 3, // Neumünster / Kiel approach
  '28': 3, // Bremen suburbs
  '29': 3, // Lüneburg outer + Lower Saxony farther
  '31': 3, // Hildesheim direction (edge)
};

// Anything starting with one of these is unambiguously > 50 km from Hamburg.
// We list the prefixes rather than blacklisting — explicit and auditable.
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

/**
 * Look up the pickup zone + fee for a 5-digit German PLZ.
 *
 * Returns Zone 4 (outOfArea=true) for anything outside the served radius —
 * the storefront then renders an Anfrage CTA instead of a checkout button.
 *
 * Throws for malformed PLZ (anything not exactly 5 digits) so the route
 * handler can surface a 400.
 */
export function resolvePickupZone(plzInput: string): PickupZoneResult {
  const plz = plzInput.trim();
  if (!/^\d{5}$/.test(plz)) {
    throw new Error('PLZ must be exactly 5 digits');
  }

  const zone =
    OVERRIDES[plz] ??
    PREFIX_TO_ZONE[plz.slice(0, 2)] ??
    (BEYOND_NORTH.has(plz.slice(0, 1)) || BEYOND_NORTH.has(plz.slice(0, 2)) ? 4 : 3);

  return {
    zone,
    feeCents: ZONE_FEES_CENTS[zone],
    label: ZONE_LABELS[zone],
    outOfArea: zone === 4,
  };
}

/**
 * Carpet orders ≥ `freeSqmThreshold` qm get free pickup in all zones (Section
 * 9 of the PDF — Hamburg's threshold is 6 qm; brands can override via their
 * PriceBook). Returns the effective fee in cents after the free-pickup rule.
 */
export function effectivePickupFeeCents(
  zone: PickupZone,
  totalCarpetSqm: number,
  freeSqmThreshold: number,
): number {
  if (zone === 4) return 0; // out-of-area: handled separately
  if (totalCarpetSqm >= freeSqmThreshold) return 0;
  return ZONE_FEES_CENTS[zone];
}
