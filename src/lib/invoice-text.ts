/**
 * Fixed customer-facing invoice sentences plus the §35a EStG maths. One source for PDF, email and the frozen
 * `invoices.craftsman_note`, so a reissue reproduces the text the customer received even if wording here changes.
 */

export const INVOICE_THANK_YOU =
  'Vielen Dank für Ihren Auftrag und Ihr Vertrauen. ' +
  'Wir freuen uns, wenn wir wieder für Sie tätig sein dürfen.';

/** VAT rate assumed for the labour share when the invoice carries no VAT rate. */
export const CRAFTSMAN_DEFAULT_VAT_RATE = 19;

/** VAT inside a gross labour amount (200,00 € at 19 % → 31,93 €); a default the operator may override. */
export function craftsmanVatFromGross(
  grossCents: number,
  ratePercent = CRAFTSMAN_DEFAULT_VAT_RATE,
): number {
  if (!Number.isFinite(grossCents) || ratePercent <= 0) return 0;
  return Math.round((grossCents * ratePercent) / (100 + ratePercent));
}

/** "200 Euro" / "31,93 Euro" — the §35a sentence spells out the currency. */
function euroWord(cents: number): string {
  const value = cents / 100;
  return `${value.toLocaleString('de-DE', {
    minimumFractionDigits: cents % 100 === 0 ? 0 : 2,
    maximumFractionDigits: 2,
  })} Euro`;
}

/** §35a EStG block; wording is fixed (the customer hands it to their tax office). A zero VAT share drops the bracket. */
export function craftsmanNoteText(grossCents: number, vatCents?: number | null): string {
  const bracket = vatCents && vatCents > 0 ? ` (inkl. ${euroWord(vatCents)} MwSt.)` : '';
  return (
    `Im Bruttorechnungsbetrag sind Arbeitskosten / Lohnanteile in Höhe von ` +
    `${euroWord(grossCents)}${bracket} enthalten, die nach § 35a EStG steuerlich absetzbar sind.`
  );
}
