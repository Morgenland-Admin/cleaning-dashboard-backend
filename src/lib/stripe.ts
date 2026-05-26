import Stripe from 'stripe';
import { env } from '../config/env.js';

/**
 * Lazy-init Stripe client. We boot the backend without STRIPE_SECRET_KEY in
 * dev (matches the S3 pattern — missing config → 503 from the endpoint, not a
 * crash on startup). Call `getStripe()` from the route; it throws if config
 * is missing so the caller can map it to a 503.
 */
let cached: Stripe | null = null;

export const stripeConfigured = !!env.STRIPE_SECRET_KEY;

export function getStripe(): Stripe {
  if (cached) return cached;
  if (!env.STRIPE_SECRET_KEY) {
    throw new Error('STRIPE_SECRET_KEY is not configured.');
  }
  cached = new Stripe(env.STRIPE_SECRET_KEY, {
    // Pin the API version so adding new Stripe features doesn't silently
    // change webhook payload shape behind our back. Bump deliberately when
    // we audit the changelog.
    apiVersion: '2026-04-22.dahlia',
    typescript: true,
  });
  return cached;
}
