/** Per-brand PriceBook registry, resolved by company slug; an unknown slug returns null and the caller decides. */

import { cleaniloBook } from './cleanilo.js';
import { hamburgBook } from './hamburg.js';
import { teppichreinigenLassenBook } from './teppichreinigen_lassen.js';
import type { PriceBook } from './types.js';

const BOOKS: Record<string, PriceBook> = {
  hamburg_teppichreinigung: hamburgBook,
  cleanilo: cleaniloBook,
  teppichreinigen_lassen: teppichreinigenLassenBook,
};

export function getPriceBook(slug: string): PriceBook | null {
  return BOOKS[slug] ?? null;
}

export function listPriceBooks(): readonly PriceBook[] {
  return Object.values(BOOKS);
}

export type { PriceBook } from './types.js';
