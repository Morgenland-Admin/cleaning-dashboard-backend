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
  seller: {
    name: string;
    addressLines: string[];
    vatId?: string | null;
    registrationNumber?: string | null;
    email?: string | null;
    phone?: string | null;
  };
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

    // Header: brand name + "RECHNUNG"
    doc.fillColor(accent).font('Helvetica-Bold').fontSize(18).text(data.brandName, PAGE_LEFT, 50);
    doc
      .fillColor(MUTED)
      .font('Helvetica')
      .fontSize(20)
      .text('RECHNUNG', PAGE_LEFT, 50, { width: PAGE_RIGHT - PAGE_LEFT, align: 'right' });

    // Seller line (small, under the brand name)
    doc
      .fillColor(MUTED)
      .fontSize(8)
      .text([data.seller.name, ...data.seller.addressLines].join(' · '), PAGE_LEFT, 76, {
        width: 300,
      });

    // Recipient + meta block
    let y = 120;
    doc.fillColor(MUTED).font('Helvetica').fontSize(9).text('RECHNUNG AN', PAGE_LEFT, y);
    doc
      .fillColor(INK)
      .font('Helvetica-Bold')
      .fontSize(11)
      .text(data.recipientName, PAGE_LEFT, y + 14);
    let recipientY = y + 30;
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

    const metaX = 330;
    const metaLabelW = 110;
    const metaValW = PAGE_RIGHT - (metaX + metaLabelW);
    const meta: Array<[string, string]> = [
      ['Rechnungsnummer', data.invoiceNumber],
      ['Rechnungsdatum', data.invoiceDate],
    ];
    if (data.serviceDateLabel) meta.push(['Leistungsdatum', data.serviceDateLabel]);
    if (data.dueDate) meta.push(['Fällig bis', data.dueDate]);
    let my = y;
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
      my += 16;
    }

    y = Math.max(recipientY + 10, my + 10);

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
    }

    // Footer: seller legal block (Pflichtangaben)
    const footerLines = [
      data.seller.name,
      ...data.seller.addressLines,
      data.seller.vatId ? `USt-IdNr.: ${data.seller.vatId}` : null,
      data.seller.registrationNumber ? `Reg-Nr.: ${data.seller.registrationNumber}` : null,
      data.seller.email ? `E-Mail: ${data.seller.email}` : null,
      data.seller.phone ? `Tel.: ${data.seller.phone}` : null,
    ].filter((x): x is string => Boolean(x));
    doc
      .font('Helvetica')
      .fontSize(8)
      .fillColor(MUTED)
      .moveTo(PAGE_LEFT, 790)
      .lineTo(PAGE_RIGHT, 790)
      .strokeColor(RULE)
      .lineWidth(0.5)
      .stroke();
    doc.text(footerLines.join('  ·  '), PAGE_LEFT, 796, {
      width: PAGE_RIGHT - PAGE_LEFT,
      align: 'center',
    });

    doc.end();
  });
}
