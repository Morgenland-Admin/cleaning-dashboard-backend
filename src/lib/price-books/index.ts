/**
 * Per-brand PriceBook registry.
 *
 * Routes resolve a book by company slug. An unknown slug returns null — the
 * caller (orders module) decides how to respond (404 vs fallback).
 */

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

/** Used by the storefront catalog endpoint to surface enabled services. */
export function listPriceBooks(): readonly PriceBook[] {
  return Object.values(BOOKS);
}

export type { PriceBook } from './types.js';
