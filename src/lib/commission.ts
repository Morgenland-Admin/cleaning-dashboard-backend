export const DEFAULT_COMMISSION_RATE = 12;

export interface CommissionSplit {
  ratePercent: number;
  commissionCents: number;
  partnerPayoutCents: number;
}

export function computeCommission(
  totalCents: number,
  ratePercent?: number | null,
): CommissionSplit {
  if (!Number.isFinite(totalCents) || totalCents < 0) {
    throw new Error('totalCents must be a non-negative number');
  }
  const rate =
    ratePercent == null || !Number.isFinite(ratePercent) ? DEFAULT_COMMISSION_RATE : ratePercent;
  if (rate < 0 || rate > 100) {
    throw new Error('commission rate must be between 0 and 100');
  }
  const commissionCents = Math.round((totalCents * rate) / 100);
  const partnerPayoutCents = totalCents - commissionCents;
  return { ratePercent: rate, commissionCents, partnerPayoutCents };
}

/** Parse a numeric/string commission_rate column into a number or null. */
export function parseCommissionRate(raw: unknown): number | null {
  if (raw == null) return null;
  const n = typeof raw === 'number' ? raw : Number(raw);
  return Number.isFinite(n) ? n : null;
}
