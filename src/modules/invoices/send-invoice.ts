import type { company } from '../../db/schema/shared.js';
import {
  CRAFTSMAN_DEFAULT_VAT_RATE,
  craftsmanNoteText,
  craftsmanVatFromGross,
} from '../../lib/invoice-text.js';
import { formatEurFromCents } from '../../lib/pricing.js';
import { fetchInvoiceLogo, renderInvoicePdf, type InvoicePdfData } from '../../lib/invoice-pdf.js';
import { brandInfoFromCompany, brandSender, sendEmail } from '../../email/service.js';
import { invoiceEmail } from '../../email/templates.js';

type CompanyFull = typeof company.$inferSelect;

export interface InvoiceForEmail {
  id: number;
  number: string | null;
  recipientName: string;
  recipientCompany?: string | null;
  recipientVatId?: string | null;
  recipientEmail: string | null;
  recipientAddressLine1: string | null;
  recipientAddressLine2: string | null;
  recipientPostalCode: string | null;
  recipientCity: string | null;
  subject: string | null;
  serviceDate: string | null;
  serviceDateEnd: string | null;
  sentAt: Date | null;
  dueAt: Date | null;
  paymentTermsDays: number;
  taxRatePercent: number;
  taxCents: number;
  subtotalCents: number;
  totalCents: number;
  lineItems: Array<{
    label: string;
    note?: string | null;
    quantity: number;
    unitPriceCents: number;
    isPackage?: boolean;
  }>;
  notes: string | null;
  paymentMethod?: string | null;
  /** §35a EStG: invoice covers a Handwerkerleistung. */
  craftsmanService?: boolean | null;
  laborGrossCents?: number | null;
  laborVatCents?: number | null;
  /** The §35a sentence as stored — falls back to composing it from the amounts. */
  craftsmanNote?: string | null;
}

interface MinimalLogger {
  error(obj: unknown, msg?: string): void;
}

/**
 * Download / attachment filename for an invoice PDF:
 *   "<number>-Rechnung-<Kundenname>.pdf"  →  "CL-1426-Rechnung-Hartmann-Leu.pdf"
 * Drafts (no number yet) fall back to "Entwurf-<id>". The recipient name is
 * slugified to filename-safe ASCII-ish (umlauts collapsed to a single word).
 */
export function invoicePdfFilename(numberOrRef: string, recipientName: string): string {
  const namePart = recipientName
    .trim()
    .replace(/[äÄ]/g, 'ae')
    .replace(/[öÖ]/g, 'oe')
    .replace(/[üÜ]/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  const base = [numberOrRef, 'Rechnung', namePart].filter(Boolean).join('-');
  return `${base.replace(/[^\w.-]+/g, '_')}.pdf`;
}

/**
 * Map a company + invoice row into the fully-formatted `InvoicePdfData` the
 * renderer expects. Single source of truth so the emailed PDF, the on-screen
 * preview and the download endpoint all render byte-for-byte the same document.
 */
export function buildInvoicePdfData(
  companyRow: CompanyFull,
  invoice: InvoiceForEmail,
): InvoicePdfData {
  const now = new Date();
  const dueAt = invoice.dueAt ?? now;
  const fmtDate = (d: Date) =>
    d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const fmtDateStr = (s: string) => {
    const [y, m, d] = s.split('-');
    return y && m && d ? `${d}.${m}.${y}` : s;
  };
  const taxRate = invoice.taxCents > 0 ? invoice.taxRatePercent : 0;
  const addressLines = [
    companyRow.addressLine1,
    companyRow.addressLine2,
    [companyRow.postalCode, companyRow.city].filter(Boolean).join(' ') || null,
  ].filter((x): x is string => Boolean(x));

  const recipientAddressLines = [
    invoice.recipientAddressLine1,
    invoice.recipientAddressLine2,
    [invoice.recipientPostalCode, invoice.recipientCity].filter(Boolean).join(' ') || null,
  ].filter((x): x is string => Boolean(x));

  return {
    brandName: companyRow.name,
    invoiceNumber: invoice.number ?? `#${invoice.id}`,
    invoiceDate: fmtDate(invoice.sentAt ?? now),
    dueDate: fmtDate(dueAt),
    paymentTermsDays: invoice.paymentTermsDays,
    subject: invoice.subject,
    recipientName: invoice.recipientName,
    // DIN 5008: the company line sits above the person in the address field.
    recipientCompany: invoice.recipientCompany ?? null,
    recipientVatId: invoice.recipientVatId ?? null,
    // Deliberately no recipient email in the address field — DIN lang window.
    recipientAddressLines,
    // Single date unless a genuinely different end date is set (never "X – X").
    serviceDateLabel: invoice.serviceDate
      ? invoice.serviceDateEnd && invoice.serviceDateEnd !== invoice.serviceDate
        ? `${fmtDateStr(invoice.serviceDate)} – ${fmtDateStr(invoice.serviceDateEnd)}`
        : fmtDateStr(invoice.serviceDate)
      : null,
    lineItems: invoice.lineItems.map((li) => ({
      label: li.label,
      note: li.note ?? null,
      quantity: li.quantity.toLocaleString('de-DE'),
      unitPrice: formatEurFromCents(li.unitPriceCents),
      lineTotal: formatEurFromCents(Math.round(li.quantity * li.unitPriceCents)),
      isPackage: li.isPackage ?? false,
    })),
    subtotal: formatEurFromCents(invoice.subtotalCents),
    tax: invoice.taxCents > 0 ? formatEurFromCents(invoice.taxCents) : null,
    taxRateLabel: taxRate > 0 ? `${taxRate} %` : null,
    total: formatEurFromCents(invoice.totalCents),
    // Stored wording wins (GoBD: reissue must reproduce what was sent); the
    // fallback only covers rows written before the sentence was persisted.
    craftsmanNote: invoice.craftsmanService
      ? (invoice.craftsmanNote ??
        craftsmanNoteText(
          invoice.laborGrossCents ?? 0,
          invoice.laborVatCents ??
            craftsmanVatFromGross(
              invoice.laborGrossCents ?? 0,
              invoice.taxRatePercent > 0 ? invoice.taxRatePercent : CRAFTSMAN_DEFAULT_VAT_RATE,
            ),
        ))
      : null,
    notes: invoice.notes,
    paymentMethod: invoice.paymentMethod ?? 'transfer',
    accentColor: companyRow.primaryColor ?? '#bd5b3e',
    // Only used when no raster wordmark is available — the official logos carry
    // their claim already. "CLEANILO – Einfach. Schnell." → "Einfach. Schnell.".
    claim: (
      companyRow.emailSignature?.slogan ??
      companyRow.emailSignature?.tagline ??
      null
    )?.replace(new RegExp(`^${companyRow.name}\\s*[–—-]\\s*`, 'i'), ''),
    seller: {
      name: companyRow.legalName ?? companyRow.name,
      addressLines,
      vatId: companyRow.vatId,
      registrationNumber: companyRow.registrationNumber,
      email: companyRow.email,
      phone: companyRow.phone,
      mobile: companyRow.mobile,
      website: companyRow.websiteUrl ? companyRow.websiteUrl.replace(/^https?:\/\//i, '') : null,
      // No Steuernummer on invoices — the USt-IdNr. is the only tax id shown.
      businessId: companyRow.businessId,
      legalForm: companyRow.legalForm,
      managingDirectors: companyRow.managingDirectors,
      chamber: companyRow.chamber,
    },
    bank: {
      accountHolder: companyRow.accountHolder ?? companyRow.legalName ?? companyRow.name,
      iban: companyRow.iban,
      bic: companyRow.bic,
      bankName: companyRow.bankName,
      bankAddress: companyRow.bankAddress,
    },
  };
}

export async function sendInvoiceEmail(
  companyRow: CompanyFull,
  invoice: InvoiceForEmail,
  log?: MinimalLogger,
): Promise<{ ok: boolean; skipped: boolean }> {
  if (!invoice.recipientEmail) return { ok: false, skipped: true };

  // Invoices use the wide wordmark (invoiceLogoUrl), not the square avatar.
  const logoSrc = companyRow.invoiceLogoUrl ?? companyRow.logoUrl;
  const pdfData = buildInvoicePdfData(companyRow, invoice);
  pdfData.logo = await fetchInvoiceLogo(logoSrc);

  // Render the PDF attachment (best-effort — fall back to HTML-only).
  let attachments: Array<{ filename: string; content: Buffer }> | undefined;
  try {
    const pdf = await renderInvoicePdf(pdfData);
    attachments = [
      {
        filename: invoicePdfFilename(pdfData.invoiceNumber, pdfData.recipientName),
        content: pdf,
      },
    ];
  } catch (err) {
    log?.error({ err, invoiceId: invoice.id }, 'Failed to render invoice PDF');
  }

  const result = await sendEmail({
    to: invoice.recipientEmail,
    from: brandSender(companyRow),
    apiKey: companyRow.resendApiKey ?? undefined,
    replyTo: companyRow.email ?? undefined,
    attachments,
    email: invoiceEmail({
      brand: { ...brandInfoFromCompany(companyRow), logoUrl: logoSrc },
      recipientName: pdfData.recipientName,
      invoiceNumber: pdfData.invoiceNumber,
      invoiceDateFormatted: pdfData.invoiceDate,
      dueDateFormatted: pdfData.dueDate,
      paymentTermsDays: pdfData.paymentTermsDays,
      subject: pdfData.subject,
      lineItems: pdfData.lineItems.map((li) => ({
        label: li.label,
        note: li.note,
        quantityLabel: li.quantity,
        unitPriceFormatted: li.unitPrice,
        lineTotalFormatted: li.lineTotal,
      })),
      subtotalFormatted: pdfData.subtotal,
      taxFormatted: pdfData.tax,
      taxRateLabel: pdfData.taxRateLabel,
      totalFormatted: pdfData.total,
      craftsmanNote: pdfData.craftsmanNote,
      notes: pdfData.notes,
      seller: pdfData.seller,
      bank: pdfData.bank,
      paymentMethod: pdfData.paymentMethod,
    }),
  });
  return { ok: result.ok && !result.skipped, skipped: result.skipped ?? false };
}
