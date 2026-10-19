/**
 * TRL: carpet + repair only, no on-site Polsterreinigung (Hamburg-local). Prices mirror Hamburg's B2C book for now.
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

  upholstery: null,

  teppichbodenCleaning: null,

  addons: hamburgBook.addons,
};
