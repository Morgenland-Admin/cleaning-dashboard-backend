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
  /** Paketrechnung: no per-line prices. */
  packageMode?: boolean | null;
  notes: string | null;
  paymentMethod?: string | null;
  /** §35a EStG Handwerkerleistung. */
  craftsmanService?: boolean | null;
  laborGrossCents?: number | null;
  laborVatCents?: number | null;
  /** Stored §35a sentence; composed from the amounts when absent. */
  craftsmanNote?: string | null;
}

interface MinimalLogger {
  error(obj: unknown, msg?: string): void;
}

/** "<number>-Rechnung-<Kundenname>.pdf"; drafts use "Entwurf-<id>"; the name is slugified to filename-safe ASCII. */
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

/** Brand letterhead (accent, claim, seller, bank) from the company row; shared with the receipt confirmation. */
export function letterheadFromCompany(companyRow: CompanyFull): {
  accentColor: string;
  claim: string | undefined;
  seller: InvoicePdfData['seller'];
  bank: NonNullable<InvoicePdfData['bank']>;
} {
  const addressLines = [
    companyRow.addressLine1,
    companyRow.addressLine2,
    [companyRow.postalCode, companyRow.city].filter(Boolean).join(' ') || null,
  ].filter((x): x is string => Boolean(x));
  return {
    accentColor: companyRow.primaryColor ?? '#bd5b3e',
    // Only used without a raster wordmark; strips the brand prefix ("CLEANILO – Einfach." → "Einfach.").
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
      // No Steuernummer on invoices; only the USt-IdNr. is shown.
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

/** Single source for the emailed PDF, the preview and the download, so all render the same document. */
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
    // DIN 5008: company line above the person.
    recipientCompany: invoice.recipientCompany ?? null,
    recipientVatId: invoice.recipientVatId ?? null,
    // No recipient email in the address field (DIN lang window).
    recipientAddressLines,
    // Never "X – X".
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
    packageMode: invoice.packageMode === true,
    subtotal: formatEurFromCents(invoice.subtotalCents),
    tax: invoice.taxCents > 0 ? formatEurFromCents(invoice.taxCents) : null,
    taxRateLabel: taxRate > 0 ? `${taxRate} %` : null,
    total: formatEurFromCents(invoice.totalCents),
    // Stored wording wins (GoBD: a reissue must reproduce what was sent).
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
    ...letterheadFromCompany(companyRow),
  };
}

export async function sendInvoiceEmail(
  companyRow: CompanyFull,
  invoice: InvoiceForEmail,
  log?: MinimalLogger,
): Promise<{ ok: boolean; skipped: boolean }> {
  if (!invoice.recipientEmail) return { ok: false, skipped: true };

  // Wide wordmark, not the square avatar.
  const logoSrc = companyRow.invoiceLogoUrl ?? companyRow.logoUrl;
  const pdfData = buildInvoicePdfData(companyRow, invoice);
  pdfData.logo = await fetchInvoiceLogo(logoSrc);

  // Best-effort; falls back to HTML-only.
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
    log: { companySlug: companyRow.slug, kind: 'invoice', refType: 'invoice', refId: invoice.id },
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
      packageMode: pdfData.packageMode,
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
