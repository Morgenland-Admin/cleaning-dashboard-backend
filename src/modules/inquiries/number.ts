/**
 * Customer-facing inquiry number, e.g. "ANF-2026-000123" (ANF = Anfrage).
 * Derived purely from the row's id + creation year, so it needs no counter
 * table or migration and is stable for the life of the row (mirrors the
 * order-number fallback). The year comes from `createdAt`, never the current
 * date, so it never drifts.
 */
export function formatInquiryNumber(id: number, createdAt: Date): string {
  return `ANF-${createdAt.getUTCFullYear()}-${String(id).padStart(6, '0')}`;
}
