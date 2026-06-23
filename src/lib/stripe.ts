import Stripe from 'stripe';
import { env } from '../config/env.js';

let cached: Stripe | null = null;

export const stripeConfigured = !!env.STRIPE_SECRET_KEY;

export function getStripe(): Stripe {
  if (cached) return cached;
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured.');
  }
  cached = new Stripe(env.STRIPE_SECRET_KEY, {
    apiVersion: '2026-04-22.dahlia',
    typescript: true,
    // Don't let a hung Stripe call tie up a request + pool connection.
    timeout: 10_000,
    maxNetworkRetries: 2,
  });
  return cached;
}
