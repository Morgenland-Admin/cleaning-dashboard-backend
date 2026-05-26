import { effectivePickupFeeCents, resolvePickupZone, type Coords } from './pickup-zones.js';
import type { PriceBook } from './price-books/types.js';

export const TEPPICH_ARTS = [
  'maschinell',
  'shaggy',
  'handgeknuepft',
  'perser_premium',
  'china',
  'seide',
  'antik',
] as const;
export type TeppichArt = (typeof TEPPICH_ARTS)[number];

export const REPARATUR_ARTS = [
  'fransen_sichern',
  'kanten_sichern',
  'fransen_erneuern',
  'kanten_erneuern',
  'auf_mass_kuerzen',
] as const;
export type ReparaturArt = (typeof REPARATUR_ARTS)[number];

export const POLSTER_ITEMS = [
  'stuhl_klein',
  'hocker',
  'stuhl_gross',
  'buerostuhl',
  'hocker_gross',
  'sessel',
  'sofa_2',
  'auto_innenraum',
  'sofa_3',
  'eckcouch_klein',
  'eckcouch_gross',
  'kombi',
] as const;
export type PolsterItem = (typeof POLSTER_ITEMS)[number];

export const ZUSATZ_KINDS = ['impraegnierung', 'mottenschutz', 'mottenbekaempfung'] as const;
export type ZusatzKind = (typeof ZUSATZ_KINDS)[number];

export const TEPPICHBODEN_TIERS = ['basis', 'standard', 'premium'] as const;
export type TeppichbodenTier = (typeof TEPPICHBODEN_TIERS)[number];

/**
 * Flächenstaffeln — Festpreis pro Auftrag (nicht pro m²).
 *
 * Die letzte Bracket `ab_150` hat im PriceBook für jede Tier einen `null`-Preis
 * und löst im Engine eine "individuelles-Angebot"-Antwort aus
 * (`outOfArea: true`). Das Frontend leitet dann auf das Kontaktformular.
 */
export const TEPPICHBODEN_BRACKETS = [
  'bis_30',
  'bis_50',
  'bis_75',
  'bis_100',
  'bis_125',
  'bis_150',
  'ab_150',
] as const;
export type TeppichbodenBracket = (typeof TEPPICHBODEN_BRACKETS)[number];

export interface CarpetLineInput {
  art: TeppichArt;
  sqm: number;
  note?: string;
  addons?: ZusatzKind[];
}

export interface RepairLineInput {
  art: ReparaturArt;
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
      pickupMode: 'pickup' | 'drop_off';
      pickupPlz?: string;
      /** Geocoded address coords — used for accurate distance-based zoning. */
      pickupCoords?: Coords;
    }
  | {
      kind: 'teppichreparatur';
      repairs: RepairLineInput[];
      pickupMode: 'pickup' | 'drop_off';
      pickupPlz?: string;
      pickupCoords?: Coords;
    }
  | {
      kind: 'polsterreinigung';
      items: PolsterLineInput[];
      addressPlz: string;
      addressCoords?: Coords;
    }
  | {
      kind: 'teppichbodenreinigung';
      tier: TeppichbodenTier;
      bracket: TeppichbodenBracket;
      /** Optionale, exakte Flächen-Angabe — nur zur Anzeige / E-Mail-Hinweis. */
      sqm?: number;
      addressPlz: string;
      addressCoords?: Coords;
    };

export interface PricedLine {
  code: string;
  label: string;
  quantityLabel: string;
  unitPriceCents: number;
  quantity: number;
  subtotalCents: number;
}

export interface PriceQuote {
  lines: PricedLine[];
  subtotalCents: number;
  pickupFeeCents: number;
  pickupLabel: string | null;
  minOrderTopUpCents: number;
  totalCents: number;
  outOfArea: boolean;
  outOfAreaReason?: string;
}

function toCents(cents: number): number {
  return Math.floor(cents + 0.5);
}

/** Compute the full price quote. Pure — no DB or external calls. */
export function priceOrder(input: OrderServiceInput, book: PriceBook): PriceQuote {
  switch (input.kind) {
    case 'teppichreinigung':
      return priceTeppichreinigung(input, book);
    case 'teppichreparatur':
      return priceTeppichreparatur(input, book);
    case 'polsterreinigung':
      return pricePolsterreinigung(input, book);
    case 'teppichbodenreinigung':
      return priceTeppichbodenreinigung(input, book);
  }
}

function priceTeppichreinigung(
  input: {
    carpets: CarpetLineInput[];
    pickupMode: 'pickup' | 'drop_off';
    pickupPlz?: string;
    pickupCoords?: Coords;
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

  let pickupFeeCents = 0;
  let pickupLabel: string | null = null;
  if (input.pickupMode === 'pickup') {
    if (!input.pickupPlz) {
      return emptyQuote('PLZ erforderlich für Abholung');
    }
    let zoneResult;
    try {
      zoneResult = resolvePickupZone(input.pickupPlz, input.pickupCoords);
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
    pickupCoords?: Coords;
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

  let pickupFeeCents = 0;
  let pickupLabel: string | null = null;
  if (input.pickupMode === 'pickup') {
    if (!input.pickupPlz) return emptyQuote('PLZ erforderlich für Abholung');
    let zoneResult;
    try {
      zoneResult = resolvePickupZone(input.pickupPlz, input.pickupCoords);
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
  input: { items: PolsterLineInput[]; addressPlz: string; addressCoords?: Coords },
  book: PriceBook,
): PriceQuote {
  const catalog = book.upholstery;
  if (!catalog) {
    return serviceUnavailable(book, 'Polsterreinigung');
  }
  if (input.items.length === 0) {
    return emptyQuote('Mindestens ein Möbelstück erforderlich');
  }
  let zoneResult;
  try {
    zoneResult = resolvePickupZone(input.addressPlz, input.addressCoords);
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

  const minOrderTopUpCents =
    subtotalCents < catalog.minOrderCents ? catalog.minOrderCents - subtotalCents : 0;

  return {
    lines,
    subtotalCents,
    pickupFeeCents: 0,
    pickupLabel: `Vor-Ort-Service · ${zoneResult.label}`,
    minOrderTopUpCents,
    totalCents: subtotalCents + minOrderTopUpCents,
    outOfArea: false,
  };
}

function priceTeppichbodenreinigung(
  input: {
    tier: TeppichbodenTier;
    bracket: TeppichbodenBracket;
    sqm?: number;
    addressPlz: string;
    addressCoords?: Coords;
  },
  book: PriceBook,
): PriceQuote {
  const catalog = book.teppichbodenCleaning;
  if (!catalog) {
    return serviceUnavailable(book, 'Teppichbodenreinigung');
  }

  let zoneResult;
  try {
    zoneResult = resolvePickupZone(input.addressPlz, input.addressCoords);
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

  const bracketPrice = catalog.prices[input.tier]?.[input.bracket];

  if (bracketPrice == null) {
    return {
      lines: [],
      subtotalCents: 0,
      pickupFeeCents: 0,
      pickupLabel: null,
      minOrderTopUpCents: 0,
      totalCents: 0,
      outOfArea: true,
      outOfAreaReason:
        'Für diese Fläche erstellen wir Ihnen ein individuelles Festpreis-Angebot — bitte stellen Sie eine kostenfreie Anfrage.',
    };
  }

  const sqmLabel =
    typeof input.sqm === 'number' && input.sqm > 0 ? ` · ${formatSqm(input.sqm)} m²` : '';
  const lines: PricedLine[] = [
    {
      code: `teppichboden.${input.tier}`,
      label: `Teppichbodenreinigung · ${catalog.tierLabels[input.tier]}`,
      quantityLabel: `${catalog.bracketLabels[input.bracket]}${sqmLabel}`,
      unitPriceCents: bracketPrice,
      quantity: 1,
      subtotalCents: bracketPrice,
    },
  ];

  return {
    lines,
    subtotalCents: bracketPrice,
    pickupFeeCents: 0,
    pickupLabel: `Vor-Ort-Service · ${zoneResult.label}`,
    minOrderTopUpCents: 0,
    totalCents: bracketPrice,
    outOfArea: false,
  };
}

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

function formatSqm(n: number): string {
  return n.toLocaleString('de-DE', {
    minimumFractionDigits: n % 1 === 0 ? 0 : 1,
    maximumFractionDigits: 2,
  });
}

/** Format cents as German EUR string, e.g. 2990 → "29,90 €". */
export function formatEurFromCents(cents: number): string {
  return (cents / 100).toLocaleString('de-DE', {
    style: 'currency',
    currency: 'EUR',
    minimumFractionDigits: 2,
  });
}
