// Customer-facing number, e.g. "ANF-2026-000123": derived from id + the createdAt year (never the current date),
// so it needs no counter table and stays stable for the life of the row.
export function formatInquiryNumber(id: number, createdAt: Date): string {
  return `ANF-${createdAt.getUTCFullYear()}-${String(id).padStart(6, '0')}`;
}
