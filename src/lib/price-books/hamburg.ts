/**
 * Hamburg Teppichreinigung — B2C Endkundenpreise.
 *
 * Mirrors HTR_Preisliste.pdf (Stand 2026). All amounts in cents inkl. MwSt.
 */

import type { PriceBook } from './types.js';

export const hamburgBook: PriceBook = {
  slug: 'hamburg_teppichreinigung',
  brandName: 'Hamburg Teppichreinigung',
  currency: 'EUR',

  carpetCleaning: {
    prices: {
      maschinell: 1590,
      shaggy: 2290,
      handgeknuepft: 2990,
      perser_premium: 3990,
      china: 3690,
      seide: 5990,
      antik: 6990,
    },
    labels: {
      maschinell: 'Maschinell',
      shaggy: 'Shaggy / Hochflor',
      handgeknuepft: 'Handgeknüpfte & handgewebte Teppiche',
      perser_premium: 'Perser Premium',
      china: 'China',
      seide: 'Seide',
      antik: 'Antike Teppiche (>80 Jahre)',
    },
    minOrderCents: 2500,
    freePickupSqmThreshold: 6,
    dropOffLabel: 'Selbst-Abgabe Werkstatt Hamburg-Speicherstadt · kostenlos',
  },

  carpetRepair: {
    prices: {
      fransen_sichern: 3500,
      kanten_sichern: 3500,
      fransen_erneuern: 12000,
      kanten_erneuern: 5500,
      auf_mass_kuerzen: 5500,
    },
    labels: {
      fransen_sichern: 'Fransen sichern / befestigen',
      kanten_sichern: 'Kanten sichern (Overlock / Ketteln)',
      fransen_erneuern: 'Fransen erneuern (Standard, handgeknüpft)',
      kanten_erneuern: 'Kanten komplett erneuern',
      auf_mass_kuerzen: 'Teppich auf Maß kürzen & neu einfassen',
    },
    dropOffLabel: 'Selbst-Abgabe Werkstatt Hamburg-Speicherstadt · kostenlos',
  },

  upholstery: {
    prices: {
      stuhl_klein: 1500,
      hocker: 2000,
      stuhl_gross: 2000,
      buerostuhl: 2500,
      hocker_gross: 3000,
      sessel: 4900,
      sofa_2: 9500,
      auto_innenraum: 13900,
      sofa_3: 14500,
      eckcouch_klein: 19500,
      eckcouch_gross: 23900,
      kombi: 25900,
    },
    labels: {
      stuhl_klein: 'Stuhl klein',
      hocker: 'Hocker',
      stuhl_gross: 'Stuhl groß',
      buerostuhl: 'Bürostuhl',
      hocker_gross: 'Hocker groß',
      sessel: 'Sessel',
      sofa_2: 'Sofa 2-Sitzer',
      auto_innenraum: 'Auto-Innenraum (5 Sitze)',
      sofa_3: 'Sofa 3-Sitzer',
      eckcouch_klein: 'Eckcouch klein',
      eckcouch_gross: 'Eckcouch groß',
      kombi: 'Kombi (1er + 2er + 3er)',
    },
    minOrderCents: 12000,
  },

  teppichbodenCleaning: {
    prices: {
      basis: {
        bis_30: 21000,
        bis_50: 32500,
        bis_75: 48000,
        bis_100: 62500,
        bis_125: 77000,
        bis_150: 92000,
        ab_150: null,
      },
      standard: {
        bis_30: 27900,
        bis_50: 44000,
        bis_75: 66000,
        bis_100: 89000,
        bis_125: 111000,
        bis_150: 133000,
        ab_150: null,
      },
      premium: {
        bis_30: 39000,
        bis_50: 66000,
        bis_75: 99000,
        bis_100: 134000,
        bis_125: 167000,
        bis_150: 200000,
        ab_150: null,
      },
    },
    tierLabels: {
      basis: 'Basisreinigung',
      standard: 'Standardreinigung',
      premium: 'Premiumreinigung',
    },
    tierDescriptions: {
      basis: 'Für gepflegte Flächen ohne starke Flecken',
      standard: 'Für normale Verschmutzung und Laufspuren',
      premium: 'Mit Fleckenbehandlung & Imprägnierung',
    },
    bracketLabels: {
      bis_30: 'bis 30 m²',
      bis_50: 'bis 50 m²',
      bis_75: 'bis 75 m²',
      bis_100: 'bis 100 m²',
      bis_125: 'bis 125 m²',
      bis_150: 'bis 150 m²',
      ab_150: 'ab 150 m²',
    },
  },

  addons: {
    prices: {
      impraegnierung: 500,
      mottenschutz: 500,
      mottenbekaempfung: 2150,
    },
    labels: {
      impraegnierung: 'Imprägnierung',
      mottenschutz: 'Mottenschutz',
      mottenbekaempfung: 'Mottenbekämpfung (Thermo-Verfahren)',
    },
  },
};
