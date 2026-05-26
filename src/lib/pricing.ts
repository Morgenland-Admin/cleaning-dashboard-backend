/**
 * Pricing engine for storefront orders.
 *
 * Pure function: same `priceOrder(input, book)` powers both
 *   - /storefront/orders/quote (display in the wizard)
 *   - /storefront/orders/checkout (Stripe line items)
 * so a tampered cart can never change what we charge — the client only ever
 * submits a configuration, never a price.
 *
 * Per-brand variation: prices, labels, mins and which services are even
 * sold live in `price-books/<slug>.ts`. To change a brand's prices, edit
 * its file; to add a 4th brand, create a new book + register in
 * `price-books/index.ts`. The engine itself doesn't know about brand names.
 *
 * The const-arrays exported below (TEPPICH_ARTS, REPARATUR_ARTS, …) are the
 * **universal vocabulary** of every possible tier across all brands; a brand
 * subsets them via its book. Zod uses these arrays for input validation —
 * input validity ≠ brand availability; the latter is checked inside the
 * engine and rejected as "service nicht verfügbar".
 */

import { effectivePickupFeeCents, resolvePickupZone } from './pickup-zones.js';
import type { PriceBook } from './price-books/types.js';

// --- Universal service vocabulary -------------------------------------------
// Used by Zod for input validation. A brand opts into a subset via its book.

export const TEPPICH_ARTS = [
  'maschinell',
  'shaggy',
  'doppelseitig',
  'orient',
  'berber',
  'china',
  'seide',
  'schmutzfangmatten',
] as const;
export type TeppichArt = (typeof TEPPICH_ARTS)[number];

export const REPARATUR_ARTS = [
  'fransen_handketteln',
  'ketteln_fein',
  'ketteln_grob',
  'fransen_mech_ohne_knoten',
  'fransen_mech_mit_knoten',
  'leder',
] as const;
export type ReparaturArt = (typeof REPARATUR_ARTS)[number];

export const POLSTER_ITEMS = [
  'sessel',
  'sofa_2',
  'sofa_3',
  'eckcouch_klein',
  'eckcouch_gross',
  'kombi',
] as const;
export type PolsterItem = (typeof POLSTER_ITEMS)[number];

export const ZUSATZ_KINDS = ['motten', 'impraegnierung', 'geruch'] as const;
export type ZusatzKind = (typeof ZUSATZ_KINDS)[number];

// --- Input shapes ------------------------------------------------------------

export interface CarpetLineInput {
  art: TeppichArt;
  /** Square meters. Decimal allowed (e.g. 2.5). */
  sqm: number;
  /** Optional human label, e.g. "Wohnzimmerteppich". Stored, not priced. */
  note?: string;
  /** Per-carpet add-ons priced per qm. */
  addons?: ZusatzKind[];
}

export interface RepairLineInput {
  art: ReparaturArt;
  /** Laufende Meter — decimal allowed. */
  meters: number;
  note?: string;
}

export interface PolsterLineInput {
  item: PolsterItem;
  quantity: number;
}

export type OrderServiceInput =
  | {
      kind: 'teppichreinigung';
      carpets: CarpetLineInput[];
      /** "pickup" runs through pickup-zone fee logic; "drop_off" is free. */
      pickupMode: 'pickup' | 'drop_off';
      /** German 5-digit PLZ. Required when pickupMode === "pickup". */
      pickupPlz?: string;
    }
  | {
      kind: 'teppichreparatur';
      repairs: RepairLineInput[];
      pickupMode: 'pickup' | 'drop_off';
      pickupPlz?: string;
    }
  | {
      kind: 'polsterreinigung';
      items: PolsterLineInput[];
      /** PLZ for the on-site appointment — used to surface zone in admin UI. */
      addressPlz: string;
    };

// --- Output shapes -----------------------------------------------------------

export interface PricedLine {
  /** Machine-stable code for the line — e.g. "carpet.orient", "addon.motten". */
  code: string;
  /** Human-readable German label, shown to customers + on Stripe + on the invoice. */
  label: string;
  /** Quantity column, e.g. "2.5 qm", "1 lfdm", "1 Sessel". */
  quantityLabel: string;
  /** Per-unit price in cents (display only — the source of truth is `subtotalCents`). */
  unitPriceCents: number;
  /** Quantity used for the math — float allowed. */
  quantity: number;
  /** Line total in cents. */
  subtotalCents: number;
}

export interface PriceQuote {
  lines: PricedLine[];
  subtotalCents: number;
  /** Pickup fee (0 if Selbst-Abgabe or ≥ freePickupSqmThreshold qm carpet). */
  pickupFeeCents: number;
  pickupLabel: string | null;
  /** Min-order bump if the gross is below the service's Mindestauftrag. */
  minOrderTopUpCents: number;
  totalCents: number;
  /** True when the configured service literally cannot be sold online — caller
   *  should reroute to the Anfrage form. */
  outOfArea: boolean;
  /** Reason string when outOfArea === true, for the storefront to display. */
  outOfAreaReason?: string;
}

// --- Math helpers ------------------------------------------------------------

/** Bankers-round to whole cents. We multiply floats (sqm × €) so this matters. */
function toCents(cents: number): number {
  // Math.round is half-to-even-ish only in some JS engines; Math.floor(x + 0.5)
  // is safe for non-negative values which is what we have here.
  return Math.floor(cents + 0.5);
}

// --- Main entry point --------------------------------------------------------

/**
 * Compute the full price quote for an order configuration against a brand's
 * price book. Pure — no DB, no external calls. The returned object is what
 * we both (a) show the customer in the cart and (b) hand to Stripe as
 * Checkout Session line items.
 */
export function priceOrder(input: OrderServiceInput, book: PriceBook): PriceQuote {
  switch (input.kind) {
    case 'teppichreinigung':
      return priceTeppichreinigung(input, book);
    case 'teppichreparatur':
      return priceTeppichreparatur(input, book);
    case 'polsterreinigung':
      return pricePolsterreinigung(input, book);
  }
}

function priceTeppichreinigung(
  input: {
    carpets: CarpetLineInput[];
    pickupMode: 'pickup' | 'drop_off';
    pickupPlz?: string;
  },
  book: PriceBook,
): PriceQuote {
  const catalog = book.carpetCleaning;
  if (!catalog) {
    return serviceUnavailable(book, 'Teppichreinigung');
  }
  if (input.carpets.length === 0) {
    return emptyQuote('Mindestens ein Teppich erforderlich');
  }

  const lines: PricedLine[] = [];
  let totalSqm = 0;

  for (const c of input.carpets) {
    if (c.sqm <= 0) {
      return emptyQuote('Teppichfläche muss > 0 m² sein');
    }
    const unit = catalog.prices[c.art];
    const subtotal = toCents(unit * c.sqm);
    lines.push({
      code: `carpet.${c.art}`,
      label: `Teppichreinigung · ${catalog.labels[c.art]}${c.note ? ` (${c.note})` : ''}`,
      quantityLabel: `${formatSqm(c.sqm)} m²`,
      unitPriceCents: unit,
      quantity: c.sqm,
      subtotalCents: subtotal,
    });
    totalSqm += c.sqm;

    for (const addon of c.addons ?? []) {
      const addonUnit = book.addons.prices[addon];
      const addonSubtotal = toCents(addonUnit * c.sqm);
      lines.push({
        code: `addon.${addon}`,
        label: `${book.addons.labels[addon]} (${catalog.labels[c.art]})`,
        quantityLabel: `${formatSqm(c.sqm)} m²`,
        unitPriceCents: addonUnit,
        quantity: c.sqm,
        subtotalCents: addonSubtotal,
      });
    }
  }

  const subtotalCents = lines.reduce((acc, l) => acc + l.subtotalCents, 0);

  // Pickup fee
  let pickupFeeCents = 0;
  let pickupLabel: string | null = null;
  if (input.pickupMode === 'pickup') {
    if (!input.pickupPlz) {
      return emptyQuote('PLZ erforderlich für Abholung');
    }
    let zoneResult;
    try {
      zoneResult = resolvePickupZone(input.pickupPlz);
    } catch (err) {
      return emptyQuote(err instanceof Error ? err.message : 'Ungültige PLZ');
    }
    if (zoneResult.outOfArea) {
      return {
        lines: [],
        subtotalCents: 0,
        pickupFeeCents: 0,
        pickupLabel: null,
        minOrderTopUpCents: 0,
        totalCents: 0,
        outOfArea: true,
        outOfAreaReason:
          'Abholung außerhalb 50 km — bitte stellen Sie eine Anfrage, wir melden uns mit einem individuellen Angebot.',
      };
    }
    pickupFeeCents = effectivePickupFeeCents(
      zoneResult.zone,
      totalSqm,
      catalog.freePickupSqmThreshold,
    );
    pickupLabel =
      pickupFeeCents === 0 && totalSqm >= catalog.freePickupSqmThreshold
        ? `Abholung ${zoneResult.label} · kostenlos ab ${catalog.freePickupSqmThreshold} m²`
        : `Abholung ${zoneResult.label}`;
  } else {
    pickupLabel = catalog.dropOffLabel;
  }

  // Min-order top-up
  const grossBeforeMin = subtotalCents + pickupFeeCents;
  const minOrderTopUpCents =
    grossBeforeMin < catalog.minOrderCents ? catalog.minOrderCents - grossBeforeMin : 0;

  return {
    lines,
    subtotalCents,
    pickupFeeCents,
    pickupLabel,
    minOrderTopUpCents,
    totalCents: grossBeforeMin + minOrderTopUpCents,
    outOfArea: false,
  };
}

function priceTeppichreparatur(
  input: {
    repairs: RepairLineInput[];
    pickupMode: 'pickup' | 'drop_off';
    pickupPlz?: string;
  },
  book: PriceBook,
): PriceQuote {
  const catalog = book.carpetRepair;
  if (!catalog) {
    return serviceUnavailable(book, 'Teppichreparatur');
  }
  if (input.repairs.length === 0) {
    return emptyQuote('Mindestens eine Reparaturposition erforderlich');
  }
  const lines: PricedLine[] = [];
  for (const r of input.repairs) {
    if (r.meters <= 0) return emptyQuote('Reparaturlänge muss > 0 m sein');
    const unit = catalog.prices[r.art];
    const subtotal = toCents(unit * r.meters);
    lines.push({
      code: `repair.${r.art}`,
      label: `Teppichreparatur · ${catalog.labels[r.art]}${r.note ? ` (${r.note})` : ''}`,
      quantityLabel: `${formatSqm(r.meters)} lfdm`,
      unitPriceCents: unit,
      quantity: r.meters,
      subtotalCents: subtotal,
    });
  }
  const subtotalCents = lines.reduce((a, l) => a + l.subtotalCents, 0);

  // Repair pickup uses the zone table but never gets the free-≥6qm rule
  // (the discount is keyed to carpet area, not repair length).
  let pickupFeeCents = 0;
  let pickupLabel: string | null = null;
  if (input.pickupMode === 'pickup') {
    if (!input.pickupPlz) return emptyQuote('PLZ erforderlich für Abholung');
    let zoneResult;
    try {
      zoneResult = resolvePickupZone(input.pickupPlz);
    } catch (err) {
      return emptyQuote(err instanceof Error ? err.message : 'Ungültige PLZ');
    }
    if (zoneResult.outOfArea) {
      return {
        lines: [],
        subtotalCents: 0,
        pickupFeeCents: 0,
        pickupLabel: null,
        minOrderTopUpCents: 0,
        totalCents: 0,
        outOfArea: true,
        outOfAreaReason: 'Abholung außerhalb 50 km — bitte stellen Sie eine Anfrage.',
      };
    }
    pickupFeeCents = zoneResult.feeCents;
    pickupLabel = `Abholung ${zoneResult.label}`;
  } else {
    pickupLabel = catalog.dropOffLabel;
  }

  return {
    lines,
    subtotalCents,
    pickupFeeCents,
    pickupLabel,
    minOrderTopUpCents: 0,
    totalCents: subtotalCents + pickupFeeCents,
    outOfArea: false,
  };
}

function pricePolsterreinigung(
  input: { items: PolsterLineInput[]; addressPlz: string },
  book: PriceBook,
): PriceQuote {
  const catalog = book.upholstery;
  if (!catalog) {
    return serviceUnavailable(book, 'Polsterreinigung');
  }
  if (input.items.length === 0) {
    return emptyQuote('Mindestens ein Möbelstück erforderlich');
  }
  // We still validate the PLZ — Polsterreinigung is on-site, so out-of-area
  // means we can't take the booking online.
  let zoneResult;
  try {
    zoneResult = resolvePickupZone(input.addressPlz);
  } catch (err) {
    return emptyQuote(err instanceof Error ? err.message : 'Ungültige PLZ');
  }
  if (zoneResult.outOfArea) {
    return {
      lines: [],
      subtotalCents: 0,
      pickupFeeCents: 0,
      pickupLabel: null,
      minOrderTopUpCents: 0,
      totalCents: 0,
      outOfArea: true,
      outOfAreaReason: 'Vor-Ort-Service außerhalb 50 km — bitte stellen Sie eine Anfrage.',
    };
  }

  const lines: PricedLine[] = [];
  for (const it of input.items) {
    if (!Number.isInteger(it.quantity) || it.quantity <= 0) {
      return emptyQuote('Anzahl muss eine positive Ganzzahl sein');
    }
    const unit = catalog.prices[it.item];
    lines.push({
      code: `polster.${it.item}`,
      label: `Polsterreinigung · ${catalog.labels[it.item]}`,
      quantityLabel: `${it.quantity}×`,
      unitPriceCents: unit,
      quantity: it.quantity,
      subtotalCents: unit * it.quantity,
    });
  }
  const subtotalCents = lines.reduce((a, l) => a + l.subtotalCents, 0);

  // Min on-site: if total < catalog.minOnsiteCents, add Anfahrtspauschale as a
  // separate line so the customer sees why their order ticked up.
  let pickupFeeCents = 0;
  let pickupLabel: string | null = null;
  if (subtotalCents < catalog.minOnsiteCents) {
    pickupFeeCents = catalog.anfahrtCents;
    pickupLabel = `Anfahrtspauschale · Vor-Ort-Service unter ${formatEurFromCents(catalog.minOnsiteCents)}`;
  } else {
    pickupLabel = `Vor-Ort-Service · ${zoneResult.label} · keine Anfahrtspauschale`;
  }

  return {
    lines,
    subtotalCents,
    pickupFeeCents,
    pickupLabel,
    minOrderTopUpCents: 0,
    totalCents: subtotalCents + pickupFeeCents,
    outOfArea: false,
  };
}

// --- Helpers -----------------------------------------------------------------

function emptyQuote(reason: string): PriceQuote {
  return {
    lines: [],
    subtotalCents: 0,
    pickupFeeCents: 0,
    pickupLabel: null,
    minOrderTopUpCents: 0,
    totalCents: 0,
    outOfArea: true,
    outOfAreaReason: reason,
  };
}

function serviceUnavailable(book: PriceBook, label: string): PriceQuote {
  return emptyQuote(
    `${label} wird von ${book.brandName} aktuell nicht online angeboten — bitte stellen Sie eine Anfrage.`,
  );
}

/** German number formatting for qm/lfdm display (1.5 → "1,5"). */
function formatSqm(n: number): string {
  return n.toLocaleString('de-DE', {
    minimumFractionDigits: n % 1 === 0 ? 0 : 1,
    maximumFractionDigits: 2,
  });
}

/** Format cents as German EUR string, e.g. 2990 → "29,90 €". Used in emails. */
export function formatEurFromCents(cents: number): string {
  return (cents / 100).toLocaleString('de-DE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
  });
}
