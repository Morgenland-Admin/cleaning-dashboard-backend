/**
 * Per-brand price book: pure data (no DB/I/O) so the pricing engine stays deterministic.
 * A service set to `null` is not sold by the brand and the quote endpoint refuses it.
 */

import type {
  PolsterItem,
  ReparaturArt,
  TeppichArt,
  TeppichbodenBracket,
  TeppichbodenTier,
  ZusatzKind,
} from '../pricing.js';

export interface CarpetCleaningBook {
  prices: Record<TeppichArt, number>;
  labels: Record<TeppichArt, string>;
  minOrderCents: number;
  /** Free pickup kicks in once total carpet area ≥ this threshold (qm). */
  freePickupSqmThreshold: number;
  dropOffLabel: string;
}

export interface CarpetRepairBook {
  prices: Record<ReparaturArt, number>;
  labels: Record<ReparaturArt, string>;
  dropOffLabel: string;
}

export interface UpholsteryBook {
  prices: Record<PolsterItem, number>;
  labels: Record<PolsterItem, string>;
  minOrderCents: number;
}

export interface TeppichbodenBook {
  /** Festpreis matrix in cents per tier × area bracket; `null` = "auf Anfrage" (engine returns `outOfArea: true`). */
  prices: Record<TeppichbodenTier, Record<TeppichbodenBracket, number | null>>;
  tierLabels: Record<TeppichbodenTier, string>;
  tierDescriptions: Record<TeppichbodenTier, string>;
  bracketLabels: Record<TeppichbodenBracket, string>;
}

export interface AddonsBook {
  prices: Record<ZusatzKind, number>;
  labels: Record<ZusatzKind, string>;
}

export interface PriceBook {
  slug: string;
  brandName: string;
  currency: 'EUR';
  carpetCleaning: CarpetCleaningBook | null;
  carpetRepair: CarpetRepairBook | null;
  upholstery: UpholsteryBook | null;
  teppichbodenCleaning: TeppichbodenBook | null;
  /** Add-ons attach to carpet lines; a brand selling carpetCleaning should expose them. */
  addons: AddonsBook;
}
