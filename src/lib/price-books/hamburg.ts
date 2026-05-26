/**
 * Hamburg Teppichreinigung — B2C Endkundenpreise.
 *
 * Mirrors Sektion 1-6 + 9 of Morgenland_Gruppe_Preislisten.pdf (Stand: April 2026).
 * All amounts in cents inkl. 19% MwSt.
 */

import type { PriceBook } from './types.js';

export const hamburgBook: PriceBook = {
  slug: 'hamburg_teppichreinigung',
  brandName: 'Hamburg Teppichreinigung',
  currency: 'EUR',

  carpetCleaning: {
    // Sektion 1, Seite 3.
    prices: {
      maschinell: 1590,
      shaggy: 2290,
      doppelseitig: 2990,
      orient: 2890,
      berber: 2390,
      china: 3690,
      seide: 4490,
      schmutzfangmatten: 1090,
    },
    labels: {
      maschinell: 'Maschinell gefertigt',
      shaggy: 'Shaggy / Hochflor',
      doppelseitig: 'Doppelseitig',
      orient: 'Orient',
      berber: 'Berber',
      china: 'China',
      seide: 'Seide',
      schmutzfangmatten: 'Schmutzfangmatten',
    },
    minOrderCents: 2500,
    freePickupSqmThreshold: 6,
    dropOffLabel: 'Selbst-Abgabe Werkstatt Hamburg-Speicherstadt · kostenlos',
  },

  carpetRepair: {
    // Sektion 2, Seite 4.
    prices: {
      fransen_handketteln: 12190,
      ketteln_fein: 10890,
      ketteln_grob: 8290,
      fransen_mech_ohne_knoten: 5290,
      fransen_mech_mit_knoten: 6590,
      leder: 5290,
    },
    labels: {
      fransen_handketteln: 'Fransen Handketteln',
      ketteln_fein: 'Ketteln fein',
      ketteln_grob: 'Ketteln grob',
      fransen_mech_ohne_knoten: 'Fransen maschinell ohne Knoten',
      fransen_mech_mit_knoten: 'Fransen maschinell mit Knoten',
      leder: 'Leder',
    },
    dropOffLabel: 'Selbst-Abgabe Werkstatt Hamburg-Speicherstadt · kostenlos',
  },

  upholstery: {
    // Sektion 3, Seite 5.
    prices: {
      sessel: 5990,
      sofa_2: 11990,
      sofa_3: 17990,
      eckcouch_klein: 23990,
      eckcouch_gross: 28990,
      kombi: 31990,
    },
    labels: {
      sessel: 'Sessel',
      sofa_2: '2-Sitzer Sofa',
      sofa_3: '3-Sitzer Sofa',
      eckcouch_klein: 'Eckcouch klein',
      eckcouch_gross: 'Eckcouch groß',
      kombi: 'Kombi (Sofa + Sessel)',
    },
    minOnsiteCents: 14990,
    anfahrtCents: 3990,
  },

  addons: {
    // Sektion 6, Seite 8 (online-bookable subset).
    prices: {
      motten: 690,
      impraegnierung: 690,
      geruch: 890,
    },
    labels: {
      motten: 'Mottenbehandlung',
      impraegnierung: 'Imprägnierung (12 Monate)',
      geruch: 'Geruchsbeseitigung',
    },
  },
};
