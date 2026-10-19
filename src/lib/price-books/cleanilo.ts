/**
 * CLEANILO: Hamburg's B2C prices, plus its own Teppichboden matrix and a 100 € minimum for
 * pickup orders. Polsterreinigung uses the Hamburg table 1:1 (enabled 2026-11, Kabir).
 */

import { hamburgBook } from './hamburg.js';
import type { PriceBook } from './types.js';

const DROP_OFF_LABEL =
  'Selbst-Abgabe · Werkstatt Brook 9, 20457 Hamburg (Speicherstadt) · kostenlos';

export const cleaniloBook: PriceBook = {
  slug: 'cleanilo',
  brandName: 'CLEANILO',
  currency: 'EUR',

  carpetCleaning: hamburgBook.carpetCleaning && {
    ...hamburgBook.carpetCleaning,
    pickupMinOrderCents: 10000,
    dropOffLabel: DROP_OFF_LABEL,
  },

  carpetRepair: hamburgBook.carpetRepair && {
    ...hamburgBook.carpetRepair,
    dropOffLabel: DROP_OFF_LABEL,
  },

  upholstery: hamburgBook.upholstery,

  teppichbodenCleaning: {
    prices: {
      basis: {
        bis_30: 18500,
        bis_50: 29000,
        bis_75: 43000,
        bis_100: 56000,
        bis_125: 69000,
        bis_150: 82000,
        ab_150: null,
      },
      standard: {
        bis_30: 24900,
        bis_50: 39000,
        bis_75: 59000,
        bis_100: 79000,
        bis_125: 99000,
        bis_150: 119000,
        ab_150: null,
      },
      premium: {
        bis_30: 34900,
        bis_50: 59000,
        bis_75: 89000,
        bis_100: 119000,
        bis_125: 149000,
        bis_150: 179000,
        ab_150: null,
      },
    },
    tierLabels: hamburgBook.teppichbodenCleaning!.tierLabels,
    tierDescriptions: hamburgBook.teppichbodenCleaning!.tierDescriptions,
    bracketLabels: hamburgBook.teppichbodenCleaning!.bracketLabels,
  },

  addons: hamburgBook.addons,
};
