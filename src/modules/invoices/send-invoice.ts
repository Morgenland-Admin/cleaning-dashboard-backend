import type { company } from '../../db/schema/shared.js';
import { formatEurFromCents } from '../../lib/pricing.js';
import { renderInvoicePdf } from '../../lib/invoice-pdf.js';
import { brandInfoFromCompany, brandSender, sendEmail } from '../../email/service.js';
import { invoiceEmail } from '../../email/templates.js';

type CompanyFull = typeof company.$inferSelect;

interface InvoiceForEmail {
  id: number;
  number: string | null;
  recipientName: string;
  recipientEmail: string | null;
  recipientAddressLine1: string | null;
  recipientAddressLine2: string | null;
  recipientPostalCode: string | null;
  recipientCity: string | null;
  serviceDate: string | null;
  serviceDateEnd: string | null;
  sentAt: Date | null;
  dueAt: Date | null;
  paymentTermsDays: number;
  taxRatePercent: number;
  taxCents: number;
  subtotalCents: number;
  totalCents: number;
  lineItems: Array<{ label: string; quantity: number; unitPriceCents: number }>;
  notes: string | null;
}

interface MinimalLogger {
  error(obj: unknown, msg?: string): void;
}

export async function sendInvoiceEmail(
  companyRow: CompanyFull,
  invoice: InvoiceForEmail,
  log?: MinimalLogger,
): Promise<{ ok: boolean; skipped: boolean }> {
  if (!invoice.recipientEmail) return { ok: false, skipped: true };

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

  const invoiceNumber = invoice.number ?? `#${invoice.id}`;
  const invoiceDate = fmtDate(invoice.sentAt ?? now);
  const dueDate = fmtDate(dueAt);
  const serviceDateLabel = invoice.serviceDate
    ? invoice.serviceDateEnd
      ? `${fmtDateStr(invoice.serviceDate)} – ${fmtDateStr(invoice.serviceDateEnd)}`
      : fmtDateStr(invoice.serviceDate)
    : null;
  const recipientAddressLines = [
    invoice.recipientAddressLine1,
    invoice.recipientAddressLine2,
    [invoice.recipientPostalCode, invoice.recipientCity].filter(Boolean).join(' ') || null,
  ].filter((x): x is string => Boolean(x));
  const taxFormatted = invoice.taxCents > 0 ? formatEurFromCents(invoice.taxCents) : null;
  const taxRateLabel = taxRate > 0 ? `${taxRate} %` : null;
  const subtotalFormatted = formatEurFromCents(invoice.subtotalCents);
  const totalFormatted = formatEurFromCents(invoice.totalCents);
  const lineItems = invoice.lineItems.map((li) => ({
    label: li.label,
    quantity: li.quantity.toLocaleString('de-DE'),
    unitPrice: formatEurFromCents(li.unitPriceCents),
    lineTotal: formatEurFromCents(Math.round(li.quantity * li.unitPriceCents)),
  }));
  const seller = {
    name: companyRow.legalName ?? companyRow.name,
    addressLines,
    vatId: companyRow.vatId,
    registrationNumber: companyRow.registrationNumber,
    email: companyRow.email,
    phone: companyRow.phone,
  };
  const bank = {
    accountHolder: companyRow.accountHolder ?? companyRow.legalName ?? companyRow.name,
    iban: companyRow.iban,
    bic: companyRow.bic,
    bankName: companyRow.bankName,
    bankAddress: companyRow.bankAddress,
  };

  // Render the PDF attachment (best-effort — fall back to HTML-only).
  let attachments: Array<{ filename: string; content: Buffer }> | undefined;
  try {
    const pdf = await renderInvoicePdf({
      brandName: companyRow.name,
      invoiceNumber,
      invoiceDate,
      dueDate,
      paymentTermsDays: invoice.paymentTermsDays,
      recipientName: invoice.recipientName,
      recipientEmail: invoice.recipientEmail,
      recipientAddressLines,
      serviceDateLabel,
      lineItems,
      subtotal: subtotalFormatted,
      tax: taxFormatted,
      taxRateLabel,
      total: totalFormatted,
      notes: invoice.notes,
      accentColor: companyRow.primaryColor ?? '#bd5b3e',
      seller,
      bank,
    });
    attachments = [{ filename: `Rechnung-${invoiceNumber}.pdf`, content: pdf }];
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
      brand: brandInfoFromCompany(companyRow),
      recipientName: invoice.recipientName,
      invoiceNumber,
      invoiceDateFormatted: invoiceDate,
      dueDateFormatted: dueDate,
      paymentTermsDays: invoice.paymentTermsDays,
      lineItems: lineItems.map((li) => ({
        label: li.label,
        quantityLabel: li.quantity,
        unitPriceFormatted: li.unitPrice,
        lineTotalFormatted: li.lineTotal,
      })),
      subtotalFormatted,
      taxFormatted,
      taxRateLabel,
      totalFormatted,
      notes: invoice.notes,
      seller,
      bank,
    }),
  });
  return { ok: result.ok && !result.skipped, skipped: result.skipped ?? false };
}
