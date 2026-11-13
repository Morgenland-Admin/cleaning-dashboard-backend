/**
 * CLEANILO: Hamburg's B2C prices, plus its own Teppichboden matrix and a 100 € minimum for
 * pickup orders. Polsterreinigung uses the Hamburg table 1:1 (enabled 2026-11, Kabir).
 */

import { hamburgBook } from './hamburg.js';
import type { PriceBook } from './types.js';

const DROP_OFF_LABEL = 'Selbst-Abgabe · eigene Werkstatt, Brook 9, 20457 Hamburg · kostenlos';

const hhCarpet = hamburgBook.carpetCleaning!;

export const cleaniloBook: PriceBook = {
  slug: 'cleanilo',
  brandName: 'CLEANILO',
  currency: 'EUR',

  // Same prices as HTR, own order and wording (Kabir 2026-11): machine-made vs. hand-made, never "Wolle" for maschinell.
  carpetCleaning: {
    ...hhCarpet,
    prices: {
      maschinell: hhCarpet.prices.maschinell,
      shaggy: hhCarpet.prices.shaggy,
      handgeknuepft: hhCarpet.prices.handgeknuepft,
      china: hhCarpet.prices.china,
      perser_premium: hhCarpet.prices.perser_premium,
      seide: hhCarpet.prices.seide,
      antik: hhCarpet.prices.antik,
    },
    labels: {
      maschinell: 'Maschinell gewebte Teppiche',
      shaggy: 'Hochflor / Shaggy',
      handgeknuepft: 'Wollteppiche, handgeknüpft & handgewebt',
      china: 'China-Teppiche',
      perser_premium: 'Perser Premium',
      seide: 'Seidenteppiche',
      antik: 'Antike Teppiche (über 80 Jahre)',
    },
    descriptions: {
      maschinell: 'Synthetik, Bouclé, Viskose',
      shaggy: 'Langflor, Flokati',
      handgeknuepft: 'Orient, Berber, Kelim, Nepal',
      china: 'Peking, Ningxia',
      perser_premium: 'Fein geknüpft, Naturfarben (Einstufung nach Begutachtung)',
      seide: 'Qum, Hereke, Kaschmir',
      antik: 'Sammlerstücke, nach Begutachtung',
    },
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
        bis_50: 29000,
        bis_75: 43000,
        bis_100: 56000,
        bis_125: 69000,
        bis_150: 82000,
        ab_150: null,
      },
      standard: {
        bis_50: 39000,
        bis_75: 59000,
        bis_100: 79000,
        bis_125: 99000,
        bis_150: 119000,
        ab_150: null,
      },
      premium: {
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
