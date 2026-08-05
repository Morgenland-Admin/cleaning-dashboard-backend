/**
 * Fixed customer-facing sentences printed on every invoice, plus the §35a EStG
 * (Handwerkerleistung) maths.
 *
 * These strings live here — not inline in the PDF renderer or the email
 * template — so the printed document, the emailed HTML and the value frozen on
 * the invoice row all read from one source. The §35a sentence is additionally
 * persisted per invoice (`invoices.craftsman_note`) at write time, so reissuing
 * the PDF years later reproduces exactly the text the customer received, even
 * if the wording here is changed later.
 */

/** Standard closing line, printed on every invoice (all brands). */
export const INVOICE_THANK_YOU =
  'Vielen Dank für Ihren Auftrag und Ihr Vertrauen. ' +
  'Wir freuen uns, wenn wir wieder für Sie tätig sein dürfen.';

/** VAT rate assumed for the labour share when the invoice carries no VAT rate. */
export const CRAFTSMAN_DEFAULT_VAT_RATE = 19;

/**
 * VAT contained in a gross (VAT-inclusive) labour amount — 200,00 € at 19 %
 * → 31,93 €. This is the amount the tax office expects inside the brackets of
 * the §35a sentence; it is a default only, the operator may override it.
 */
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

/**
 * §35a EStG block, printed above the closing line when the invoice is flagged
 * as a Handwerkerleistung. Wording is fixed (Kabir, 08/2026) — the customer
 * hands this to their tax office. A zero VAT share (Kleinunternehmer, §19 UStG)
 * drops the bracket instead of printing "inkl. 0 Euro MwSt.".
 */
export function craftsmanNoteText(grossCents: number, vatCents?: number | null): string {
  const bracket = vatCents && vatCents > 0 ? ` (inkl. ${euroWord(vatCents)} MwSt.)` : '';
  return (
    `Im Bruttorechnungsbetrag sind Arbeitskosten / Lohnanteile in Höhe von ` +
    `${euroWord(grossCents)}${bracket} enthalten, die nach § 35a EStG steuerlich absetzbar sind.`
  );
}
