/**
 * Renders a German "Rechnung" PDF for an invoice using pdfkit (pure JS, no
 * headless browser). Returns a Buffer ready to attach to a Resend email.
 *
 * Mirrors the data shown in `invoiceEmail` so the PDF and the HTML body match.
 * Strings are pre-formatted (German EUR / dates) by the caller.
 */
import PDFDocument from 'pdfkit';

export interface InvoicePdfData {
  brandName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  paymentTermsDays: number;
  recipientName: string;
  recipientEmail?: string | null;
  /** §14 UStG: recipient postal address lines (street, "PLZ Ort", country). */
  recipientAddressLines?: string[];
  /** §14 UStG: pre-formatted Leistungsdatum or "von – bis" Leistungszeitraum. */
  serviceDateLabel?: string | null;
  lineItems: Array<{
    label: string;
    quantity: string;
    unitPrice: string;
    lineTotal: string;
  }>;
  subtotal: string;
  tax: string | null;
  taxRateLabel: string | null;
  total: string;
  notes?: string | null;
  accentColor: string;
  /** Optional raster brand logo (PNG/JPEG) drawn top-left; falls back to text. */
  logo?: Buffer | null;
  seller: {
    name: string;
    addressLines: string[];
    vatId?: string | null;
    registrationNumber?: string | null;
    email?: string | null;
    phone?: string | null;
    mobile?: string | null;
    website?: string | null;
    // German Pflichtangaben for the legal footer.
    taxNumber?: string | null; // Steuernummer
    businessId?: string | null; // Betriebsnummer
    legalForm?: string | null; // Rechtsform
    managingDirectors?: string | null; // Geschäftsführer
    chamber?: string | null; // Handwerkskammer
  };
  /** Seller bank details rendered as the Bankverbindung block. */
  bank?: {
    accountHolder?: string | null;
    iban?: string | null;
    bic?: string | null;
    bankName?: string | null;
    bankAddress?: string | null;
  };
}

/**
 * Best-effort fetch of a brand logo for embedding in the PDF. Returns undefined
 * on any failure (network, timeout, non-image) so the renderer falls back to
 * the text wordmark — a logo must never block invoice generation. Only raster
 * PNG/JPEG are usable by pdfkit; SVG/others are rejected.
 */
export async function fetchInvoiceLogo(url?: string | null): Promise<Buffer | undefined> {
  if (!url || !/^https?:\/\/.+\.(png|jpe?g)(\?.*)?$/i.test(url)) return undefined;
  try {
    const res = await fetch(url, { signal: AbortSignal.timeout(3000) });
    if (!res.ok) return undefined;
    const type = res.headers.get('content-type') ?? '';
    if (!/image\/(png|jpe?g)/i.test(type)) return undefined;
    const buf = Buffer.from(await res.arrayBuffer());
    return buf.length > 0 && buf.length < 2_000_000 ? buf : undefined;
  } catch {
    return undefined;
  }
}

/** Group an IBAN into blocks of four for readability. */
function formatIbanPdf(iban: string): string {
  return iban
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/(.{4})/g, '$1 ')
    .trim();
}

const PAGE_LEFT = 50;
const PAGE_RIGHT = 545; // A4 width 595 - 50 margin
const MUTED = '#6b5b48';
const INK = '#2d2419';
const RULE = '#d8c7a8';

// Item table columns (left x / width).
const COL_DESC = { x: 50, w: 250 };
const COL_QTY = { x: 300, w: 45 };
const COL_UNIT = { x: 350, w: 95 };
const COL_AMT = { x: 450, w: 95 };

export function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 50 });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const accent = /^#[0-9a-fA-F]{6}$/.test(data.accentColor) ? data.accentColor : '#bd5b3e';

    // ── Header ──────────────────────────────────────────────────────────
    // Right column: full sender / contact block (brand, entity, address,
    // phone, mobile, web, email, Betriebsnummer).
    const SENDER_X = 350;
    const SENDER_W = PAGE_RIGHT - SENDER_X;
    let sy = 48;
    doc
      .fillColor(accent)
      .font('Helvetica-Bold')
      .fontSize(12)
      .text(data.brandName.toUpperCase(), SENDER_X, sy, { width: SENDER_W });
    sy = doc.y + 1;
    const senderLines: string[] = [];
    if (data.seller.name && data.seller.name !== data.brandName) senderLines.push(data.seller.name);
    const [addr0, ...addrRest] = data.seller.addressLines;
    if (addr0) senderLines.push(`Zentrale: ${addr0}`);
    for (const a of addrRest) senderLines.push(a);
    if (data.seller.phone) senderLines.push(`Tel.: ${data.seller.phone}`);
    if (data.seller.mobile) senderLines.push(`Mobil: ${data.seller.mobile}`);
    if (data.seller.website) senderLines.push(`Internet: ${data.seller.website}`);
    if (data.seller.email) senderLines.push(`E-Mail: ${data.seller.email}`);
    if (data.seller.businessId) senderLines.push(`Betriebsnummer: ${data.seller.businessId}`);
    doc.font('Helvetica').fontSize(9).fillColor(INK);
    for (const line of senderLines) {
      doc.text(line, SENDER_X, sy, { width: SENDER_W });
      sy = doc.y + 1;
    }
    const senderBottom = sy;

    // Left: brand logo (raster) if we have one, else the brand wordmark.
    let logoDrawn = false;
    if (data.logo) {
      try {
        doc.image(data.logo, PAGE_LEFT, 46, { height: 40 });
        logoDrawn = true;
      } catch {
        logoDrawn = false;
      }
    }
    if (!logoDrawn) {
      doc
        .fillColor(accent)
        .font('Helvetica-Bold')
        .fontSize(22)
        .text(data.brandName, PAGE_LEFT, 50, { width: 280 });
    }

    // From-line + recipient (left column).
    let ly = 112;
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(7.5)
      .text(`${data.brandName} · ${data.seller.addressLines.join(' · ')}`, PAGE_LEFT, ly, {
        width: 300,
      });
    ly = doc.y + 10;
    doc.fillColor(MUTED).font('Helvetica').fontSize(9).text('RECHNUNG AN', PAGE_LEFT, ly);
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(data.recipientName, PAGE_LEFT, ly + 14);
    let recipientY = ly + 30;
    for (const line of data.recipientAddressLines ?? []) {
      doc.fillColor(INK).font('Helvetica').fontSize(9).text(line, PAGE_LEFT, recipientY);
      recipientY += 13;
    }
    if (data.recipientEmail) {
      doc
        .fillColor(MUTED)
        .font('Helvetica')
        .fontSize(9)
        .text(data.recipientEmail, PAGE_LEFT, recipientY);
      recipientY += 13;
    }

    // Meta block (right), below the sender block.
    const metaX = 350;
    const metaLabelW = 105;
    const metaValW = PAGE_RIGHT - (metaX + metaLabelW);
    const meta: Array<[string, string]> = [
      ['Rechnungsnummer', data.invoiceNumber],
      ['Rechnungsdatum', data.invoiceDate],
    ];
    if (data.serviceDateLabel) meta.push(['Leistungsdatum', data.serviceDateLabel]);
    if (data.dueDate) meta.push(['Fällig bis', data.dueDate]);
    let my = Math.max(senderBottom + 12, 150);
    for (const [label, value] of meta) {
      doc
        .fillColor(MUTED)
        .font('Helvetica')
        .fontSize(9)
        .text(label, metaX, my, { width: metaLabelW });
      doc
        .fillColor(INK)
        .font('Helvetica-Bold')
        .fontSize(9)
        .text(value, metaX + metaLabelW, my, { width: metaValW, align: 'right' });
      my += 15;
    }

    // "Rechnung" title above the items table.
    let y = Math.max(recipientY + 8, my + 8);
    doc.fillColor(INK).font('Helvetica-Bold').fontSize(16).text('Rechnung', PAGE_LEFT, y);
    y = doc.y + 8;

    // Items table header
    doc.rect(PAGE_LEFT, y, PAGE_RIGHT - PAGE_LEFT, 22).fill('#f4ebdc');
    doc.fillColor(MUTED).font('Helvetica-Bold').fontSize(9);
    const headY = y + 7;
    doc.text('Bezeichnung', COL_DESC.x + 6, headY, { width: COL_DESC.w });
    doc.text('Menge', COL_QTY.x, headY, { width: COL_QTY.w, align: 'center' });
    doc.text('Einzelpreis', COL_UNIT.x, headY, { width: COL_UNIT.w, align: 'right' });
    doc.text('Betrag', COL_AMT.x, headY, { width: COL_AMT.w - 6, align: 'right' });
    y += 22;

    // Items rows
    doc.font('Helvetica').fontSize(10).fillColor(INK);
    for (const item of data.lineItems) {
      const descH = doc.heightOfString(item.label, { width: COL_DESC.w - 6 });
      const rowH = Math.max(descH, 14) + 10;
      if (y + rowH > 760) {
        doc.addPage();
        y = 50;
      }
      const ty = y + 5;
      doc.fillColor(INK).text(item.label, COL_DESC.x + 6, ty, { width: COL_DESC.w - 6 });
      doc
        .fillColor(MUTED)
        .text(item.quantity, COL_QTY.x, ty, { width: COL_QTY.w, align: 'center' });
      doc
        .fillColor(MUTED)
        .text(item.unitPrice, COL_UNIT.x, ty, { width: COL_UNIT.w, align: 'right' });
      doc
        .fillColor(INK)
        .text(item.lineTotal, COL_AMT.x, ty, { width: COL_AMT.w - 6, align: 'right' });
      y += rowH;
      doc.moveTo(PAGE_LEFT, y).lineTo(PAGE_RIGHT, y).strokeColor(RULE).lineWidth(0.5).stroke();
    }

    // Totals
    y += 8;
    const totalsLabelX = 330;
    const totalsLabelW = 120;
    const totalsValX = totalsLabelX + totalsLabelW;
    const totalsValW = PAGE_RIGHT - totalsValX;
    const drawTotal = (label: string, value: string, bold = false) => {
      doc
        .font(bold ? 'Helvetica-Bold' : 'Helvetica')
        .fontSize(bold ? 12 : 10)
        .fillColor(bold ? INK : MUTED)
        .text(label, totalsLabelX, y, { width: totalsLabelW });
      doc
        .font('Helvetica-Bold')
        .fontSize(bold ? 12 : 10)
        .fillColor(INK)
        .text(value, totalsValX, y, { width: totalsValW, align: 'right' });
      y += bold ? 22 : 16;
    };
    if (data.tax && data.taxRateLabel) {
      drawTotal('Zwischensumme (netto)', data.subtotal);
      drawTotal(`zzgl. USt. (${data.taxRateLabel})`, data.tax);
    }
    doc.moveTo(totalsLabelX, y).lineTo(PAGE_RIGHT, y).strokeColor(accent).lineWidth(1).stroke();
    y += 6;
    drawTotal('Gesamtbetrag', data.total, true);

    if (!data.tax) {
      // §19 UStG note is mandatory when no VAT is shown.
      doc
        .font('Helvetica')
        .fontSize(8)
        .fillColor(MUTED)
        .text(
          'Gemäß §19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).',
          PAGE_LEFT,
          y,
          { width: PAGE_RIGHT - PAGE_LEFT },
        );
      y = doc.y + 6;
    }

    // Payment terms
    y += 10;
    const paymentText = data.dueDate
      ? `Bitte überweisen Sie den Gesamtbetrag bis zum ${data.dueDate} (Zahlungsziel ${data.paymentTermsDays} Tage).`
      : `Bitte überweisen Sie den Gesamtbetrag innerhalb von ${data.paymentTermsDays} Tagen.`;
    doc
      .font('Helvetica')
      .fontSize(10)
      .fillColor(INK)
      .text(paymentText, PAGE_LEFT, y, {
        width: PAGE_RIGHT - PAGE_LEFT,
      });
    y = doc.y + 6;

    if (data.notes) {
      doc
        .font('Helvetica')
        .fontSize(9)
        .fillColor(MUTED)
        .text(data.notes, PAGE_LEFT, y, {
          width: PAGE_RIGHT - PAGE_LEFT,
        });
      y = doc.y;
    }

    // Payment reference (Verwendungszweck) so the transfer can be matched.
    doc
      .font('Helvetica')
      .fontSize(9)
      .fillColor(MUTED)
      .text(
        `Bitte geben Sie bei der Überweisung die Rechnungsnummer ${data.invoiceNumber} an.`,
        PAGE_LEFT,
        y,
        {
          width: PAGE_RIGHT - PAGE_LEFT,
        },
      );

    // ── Footer: legal Pflichtangaben in three columns (Impressum-style) ──
    const col1 = [
      data.seller.legalForm ? `Rechtsform: ${data.seller.legalForm}` : null,
      data.seller.managingDirectors ? `Geschäftsführer: ${data.seller.managingDirectors}` : null,
      data.seller.chamber,
    ].filter((x): x is string => Boolean(x));
    const col2 = [
      data.seller.taxNumber ? `Steuernummer: ${data.seller.taxNumber}` : null,
      data.seller.vatId ? `USt-IdNr.: ${data.seller.vatId}` : null,
      data.seller.businessId ? `Betriebsnummer: ${data.seller.businessId}` : null,
    ].filter((x): x is string => Boolean(x));
    // Bank name only (no address) — keeps the narrow footer column to one line;
    // full bank/holder detail lives in the email's Bankverbindung card.
    const col3 = [
      data.bank?.bankName ? `Bank: ${data.bank.bankName}` : null,
      data.bank?.iban ? `IBAN: ${formatIbanPdf(data.bank.iban)}` : null,
      data.bank?.bic ? `BIC: ${data.bank.bic}` : null,
    ].filter((x): x is string => Boolean(x));

    const FOOTER_TOP = 738;
    doc
      .moveTo(PAGE_LEFT, FOOTER_TOP)
      .lineTo(PAGE_RIGHT, FOOTER_TOP)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
    const colY = FOOTER_TOP + 8;
    const cols: Array<{ x: number; w: number; lines: string[] }> = [
      { x: PAGE_LEFT, w: 165, lines: col1 },
      { x: PAGE_LEFT + 170, w: 120, lines: col2 },
      { x: PAGE_LEFT + 295, w: PAGE_RIGHT - (PAGE_LEFT + 295), lines: col3 },
    ];
    doc.font('Helvetica').fontSize(7.5).fillColor(MUTED);
    for (const c of cols) {
      let cy = colY;
      for (const line of c.lines) {
        doc.text(line, c.x, cy, { width: c.w, lineBreak: false });
        cy = doc.y + 2;
      }
    }

    doc.end();
  });
}
