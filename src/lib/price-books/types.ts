/**
 * Per-brand price book.
 *
 * A `PriceBook` is the complete catalog of services + prices a single brand
 * sells through the storefront. The shape lets a brand:
 *   - disable a whole service (e.g. CLEANILO doesn't offer on-site Polster today
 *     → set `upholstery: null` and the quote endpoint will refuse it),
 *   - keep its own unit prices and labels,
 *   - keep its own min-order / pickup thresholds.
 *
 * Books are pure data — no DB, no I/O — so the pricing engine stays a single
 * deterministic function. To change prices, edit the brand's file in
 * `price-books/<slug>.ts`. A future iteration can swap this for a per-tenant
 * DB table without changing the engine signature.
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
  /** Sektion 1, Mindestauftrag. */
  minOrderCents: number;
  /** Free pickup kicks in once total carpet area ≥ this threshold (qm). */
  freePickupSqmThreshold: number;
  /** Customer-facing label for "drop off at our workshop". */
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
  /**
   * Festpreis-Matrix (Cents) je Tier × Flächen-Bracket.
   *
   * `null` ⇒ "auf Anfrage" — Engine antwortet mit `outOfArea: true` und
   * Lead-Gen-Funnel-Reason. Heute der Fall für `ab_150`.
   */
  prices: Record<TeppichbodenTier, Record<TeppichbodenBracket, number | null>>;
  /** Card-Titel ("Basisreinigung", "Standardreinigung", "Premiumreinigung"). */
  tierLabels: Record<TeppichbodenTier, string>;
  /** Card-Subtitle / Kurzbeschreibung pro Paket. */
  tierDescriptions: Record<TeppichbodenTier, string>;
  /** Anzeige-Labels für Brackets ("bis 30 m²", "ab 150 m²"). */
  bracketLabels: Record<TeppichbodenBracket, string>;
}

export interface AddonsBook {
  prices: Record<ZusatzKind, number>;
  labels: Record<ZusatzKind, string>;
}

export interface PriceBook {
  /** Brand slug — included for logging / Stripe metadata. */
  slug: string;
  /** Human brand name (for emails, Stripe descriptors). */
  brandName: string;
  /** Currency code — currently always "EUR" but explicit for clarity. */
  currency: 'EUR';
  /** null → service not sold by this brand. */
  carpetCleaning: CarpetCleaningBook | null;
  carpetRepair: CarpetRepairBook | null;
  upholstery: UpholsteryBook | null;
  /** Fitted-carpet (fest verlegt) on-site cleaning. null → not offered. */
  teppichbodenCleaning: TeppichbodenBook | null;
  /** Add-ons attach to carpet lines. If the brand sells carpetCleaning, it
   *  should also expose addons (set to a book; otherwise an empty record). */
  addons: AddonsBook;
}
