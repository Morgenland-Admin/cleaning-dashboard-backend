export type LoyaltyTier = 'neukunde' | 'stammkunde' | 'premium';

export const STAMMKUNDE_MIN_ORDERS = 2;
export const STAMMKUNDE_MIN_SPENT_CENTS = 30_000;
export const PREMIUM_MIN_ORDERS = 5;
export const PREMIUM_MIN_SPENT_CENTS = 100_000;

export function computeLoyaltyTier(totalOrders: number, totalSpentCents: number): LoyaltyTier {
  if (totalOrders >= PREMIUM_MIN_ORDERS || totalSpentCents >= PREMIUM_MIN_SPENT_CENTS) {
    return 'premium';
  }
  if (totalOrders >= STAMMKUNDE_MIN_ORDERS || totalSpentCents >= STAMMKUNDE_MIN_SPENT_CENTS) {
    return 'stammkunde';
  }
  return 'neukunde';
}
