/**
 * teppichreinigen-lassen.de — Spezialisierte Teppichplattform.
 *
 * TRL is the specialised carpet (Teppich + Reparatur) marketplace. It does
 * NOT offer on-site Polsterreinigung — that's Hamburg-local only.
 *
 * Prices currently mirror Hamburg's B2C book. When the brand's own price tier
 * (e.g. premium / royal / exklusiv as their preisliste page promises) ships,
 * edit the fields below.
 */

import { hamburgBook } from './hamburg.js';
import type { PriceBook } from './types.js';

export const teppichreinigenLassenBook: PriceBook = {
  slug: 'teppichreinigen_lassen',
  brandName: 'teppichreinigen-lassen.de',
  currency: 'EUR',

  carpetCleaning: hamburgBook.carpetCleaning && {
    ...hamburgBook.carpetCleaning,
    dropOffLabel: 'Selbst-Abgabe Werkstatt Hamburg-Speicherstadt · kostenlos',
  },

  carpetRepair: hamburgBook.carpetRepair && {
    ...hamburgBook.carpetRepair,
    dropOffLabel: 'Selbst-Abgabe Werkstatt Hamburg-Speicherstadt · kostenlos',
  },

  // TRL is Teppich-only — on-site Polster routes through the Anfrage form.
  upholstery: null,

  addons: hamburgBook.addons,
};
