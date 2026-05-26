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

  // On-site Polsterreinigung is Hamburg-only. CLEANILO partner network is
  // still being built per city — until then the storefront should route
  // Polster requests to the Anfrage form.
  upholstery: null,

  addons: hamburgBook.addons,
};
