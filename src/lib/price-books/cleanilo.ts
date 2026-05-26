/**
 * CLEANILO — Reinigungsmarktplatz deutschlandweit.
 *
 * Until CLEANILO's own Preisliste sections are wired (Gehweg-/Steinreinigung,
 * B2B-Annahmestellen wholesale tier, Teppichbodenreinigung Staffel — see
 * Sektion 5, 7, 8 of the PDF), CLEANILO sells the same B2C book as Hamburg.
 *
 * Polsterreinigung is disabled here because it's an on-site service tied to
 * the Hamburg team; CLEANILO orders flow through partner matching nationwide
 * and cannot fulfil Vor-Ort-Polster directly. Customers who need it on the
 * CLEANILO site are funnelled through the Anfrage form instead.
 *
 * To change a CLEANILO price independently of Hamburg, edit the field below.
 */

import { hamburgBook } from './hamburg.js';
import type { PriceBook } from './types.js';

export const cleaniloBook: PriceBook = {
  slug: 'cleanilo',
  brandName: 'CLEANILO',
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
