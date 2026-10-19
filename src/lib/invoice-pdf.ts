/**
 * German "Rechnung" PDF (pdfkit), laid out to DIN 5008 Form B; all positions in mm via `mm()`.
 * Brand-neutral: logo, accent, sender, legal footer and bank block come from the company row.
 * Strings are pre-formatted by the caller (German EUR / dates); spacing mirrors the CL-1428 HTML template.
 */
import { INVOICE_THANK_YOU } from './invoice-text.js';
import {
  BODY_BOTTOM,
  BODY_TOP,
  CONTENT_W,
  INK,
  L,
  MM,
  MUTED,
  R,
  RULE,
  createLetterDoc,
  drawLegalFooter,
  drawLetterhead,
  mm,
  stampPageNumbers,
  type FontKey,
  type Run,
} from './pdf-letterhead.js';

export { fetchInvoiceLogo } from './pdf-letterhead.js';

export interface InvoicePdfData {
  brandName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  paymentTermsDays: number;
  subject?: string | null;
  recipientName: string;
  recipientCompany?: string | null;
  recipientVatId?: string | null;
  /** §14 UStG: street, "PLZ Ort", country. */
  recipientAddressLines?: string[];
  /** §14 UStG: Leistungsdatum, or "von – bis" for a period (the en dash selects the label). */
  serviceDateLabel?: string | null;
  lineItems: Array<{
    label: string;
    note?: string | null;
    quantity: string;
    unitPrice: string;
    lineTotal: string;
    isPackage?: boolean;
  }>;
  /** Paketrechnung: positions show scope only (no Einzelpreis/Betrag); money appears once in the totals. */
  packageMode?: boolean;
  subtotal: string;
  tax: string | null;
  taxRateLabel: string | null;
  total: string;
  /** §35a EStG block, frozen on the invoice row so a reissue reproduces it verbatim. */
  craftsmanNote?: string | null;
  notes?: string | null;
  /** 'transfer' (default) shows bank + due date; 'card'/'cash' show "paid". */
  paymentMethod?: string | null;
  accentColor: string;
  logo?: Buffer | null;
  /** Only for the text-logo fallback; raster logos carry their own claim. */
  claim?: string | null;
  seller: {
    name: string;
    addressLines: string[];
    vatId?: string | null;
    registrationNumber?: string | null;
    email?: string | null;
    phone?: string | null;
    mobile?: string | null;
    website?: string | null;
    businessId?: string | null; // Betriebsnummer
    legalForm?: string | null; // Rechtsform
    managingDirectors?: string | null; // Geschäftsführer
    chamber?: string | null; // Handwerkskammer
  };
  bank?: {
    accountHolder?: string | null;
    iban?: string | null;
    bic?: string | null;
    bankName?: string | null;
    bankAddress?: string | null;
  };
}

const PAY_BAR = '#FFBF00';

// Item table columns (x / width in mm).
const COL_DESC = { x: L, w: 92 }; // 95 mm cell, 3 mm gutter before "Menge"
const COL_QTY = { x: 120, w: 16 };
const COL_UNIT = { x: 136, w: 26 };
const COL_AMT = { x: 162, w: 28 };
// Paketrechnung: no money columns, so the description takes the width and "Menge" moves to the right edge.
const PKG_COL_DESC = { x: L, w: 131 };
const PKG_COL_QTY = { x: R - 28, w: 28 };

export function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const kit = createLetterDoc(data.accentColor);
    kit.done.then(resolve, reject);
    const { doc, accent, text, measure, textRuns, rule, stack } = kit;
    const paid = data.paymentMethod === 'card' || data.paymentMethod === 'cash';

    const drawFooter = () => drawLegalFooter(kit, data.seller, data.bank);

    const infoRows: Array<[string, string, boolean]> = [
      ['Rechnungsnummer', data.invoiceNumber, false],
      ['Rechnungsdatum', data.invoiceDate, false],
    ];
    if (data.serviceDateLabel)
      infoRows.push([
        data.serviceDateLabel.includes('–') ? 'Leistungszeitraum' : 'Leistungsdatum',
        data.serviceDateLabel,
        false,
      ]);
    // B2B: the recipient's USt-IdNr. goes in the info block, not the DIN address window.
    if (data.recipientVatId) infoRows.push(['USt-IdNr. Kunde', data.recipientVatId, false]);
    if (data.dueDate && !paid) infoRows.push(['Fällig bis', data.dueDate, true]);
    drawLetterhead(kit, {
      brandName: data.brandName,
      logo: data.logo,
      claim: data.claim,
      seller: data.seller,
      recipientName: data.recipientName,
      recipientCompany: data.recipientCompany,
      recipientAddressLines: data.recipientAddressLines,
      infoTitle: 'Rechnung',
      infoRows,
    });

    let pageNo = 1;
    let y = BODY_TOP;

    /** Continuation page; the table head repeats only if item rows follow. */
    const nextPage = (repeatTableHead: boolean) => {
      drawFooter();
      doc.addPage();
      pageNo += 1;
      text(`Rechnung Nr. ${data.invoiceNumber} · ${data.brandName}`, {
        x: L,
        y: 20,
        w: CONTENT_W,
        size: 8,
        color: MUTED,
      });
      y = 30;
      if (repeatTableHead) y = drawTableHead(y);
    };
    const ensure = (need: number, repeatTableHead = true) => {
      if (y + need > BODY_BOTTOM) nextPage(repeatTableHead);
    };

    // Paketrechnung: per-position money columns are dropped, not filled with 0,00 €.
    const pkg = data.packageMode === true;
    const colDesc = pkg ? PKG_COL_DESC : COL_DESC;
    const colQty = pkg ? PKG_COL_QTY : COL_QTY;

    function drawTableHead(top: number): number {
      const h = text('Bezeichnung', {
        x: colDesc.x,
        y: top,
        w: colDesc.w,
        font: 'headSemi',
        size: 7.4,
        color: MUTED,
        tracking: 0.1,
        upper: true,
      });
      const heads: Array<[string, { x: number; w: number }]> = pkg
        ? [['Menge', colQty]]
        : [
            ['Menge', COL_QTY],
            ['Einzelpreis', COL_UNIT],
            ['Betrag', COL_AMT],
          ];
      for (const [label, col] of heads) {
        text(label, {
          x: col.x,
          y: top,
          w: col.w,
          font: 'headSemi',
          size: 7.4,
          color: MUTED,
          tracking: 0.1,
          upper: true,
          align: 'right',
        });
      }
      const bottom = top + h + 1.8;
      rule(L, bottom, R, 0.75, INK);
      return bottom;
    }

    y = stack(
      y,
      text(`Rechnung Nr. ${data.invoiceNumber}`, {
        x: L,
        y,
        w: CONTENT_W,
        font: 'headBold',
        size: 16.5,
        tracking: -0.015,
      }),
    );
    if (data.subject) {
      y += 1.4;
      y = stack(y, text(data.subject, { x: L, y, w: CONTENT_W, size: 9.6, color: MUTED }));
    }
    y += 9;
    y = drawTableHead(y);

    for (const item of data.lineItems) {
      const titleFont: FontKey = item.isPackage ? 'bodyBold' : 'bodySemi';
      const titleH = measure(item.label, {
        x: colDesc.x,
        y,
        w: colDesc.w,
        font: titleFont,
        size: 9.6,
      });
      const noteH = item.note
        ? measure(item.note, { x: colDesc.x, y, w: colDesc.w, size: 8.8 })
        : 0;
      const rowH = 3.2 + Math.max(titleH + noteH, 4) + 3.2;
      ensure(rowH);
      const ty = y + 3.2;
      let dy = ty;
      dy = stack(
        dy,
        text(item.label, {
          x: colDesc.x,
          y: dy,
          w: colDesc.w,
          font: titleFont,
          size: 9.6,
        }),
      );
      if (item.note)
        text(item.note, { x: colDesc.x, y: dy, w: colDesc.w, size: 8.8, color: MUTED });
      const cells: Array<[string, { x: number; w: number }, boolean]> = pkg
        ? [[item.quantity, colQty, false]]
        : [
            [item.quantity, COL_QTY, false],
            [item.unitPrice, COL_UNIT, false],
            [item.lineTotal, COL_AMT, item.isPackage ?? false],
          ];
      for (const [value, col, bold] of cells) {
        text(value, {
          x: col.x,
          y: ty,
          w: col.w,
          font: bold ? 'bodyBold' : 'body',
          size: 9.6,
          align: 'right',
          tnum: true,
        });
      }
      y += rowH;
      rule(L, y, R, 0.25, RULE);
    }

    const SUM_X = R - 78;
    const SUM_W = 78;
    const sumRows: Array<[string, string]> = [];
    if (data.tax && data.taxRateLabel) {
      sumRows.push(['Zwischensumme (netto)', data.subtotal]);
      sumRows.push([`zzgl. USt. (${data.taxRateLabel})`, data.tax]);
    }
    ensure(6 + sumRows.length * 13.5 + 30, false);
    y += 6;
    sumRows.forEach(([label, value], i) => {
      if (i > 0) rule(SUM_X, y, R, 0.25, RULE);
      y += 1.9;
      const h = Math.max(
        measure(label, { x: SUM_X, y, size: 9.6 }),
        measure(value, { x: SUM_X, y, size: 9.6 }),
      );
      text(label, { x: SUM_X, y, size: 9.6, color: MUTED });
      text(value, {
        x: SUM_X,
        y,
        w: SUM_W,
        font: 'bodyMed',
        size: 9.6,
        align: 'right',
        tnum: true,
      });
      y = stack(y, h) + 1.9;
    });

    y += 2;
    rule(SUM_X, y, R, 1.6, accent);
    y += 2.6;
    // Baseline-align label and amount by matching the bottoms of their line boxes.
    const totalValueH = measure(data.total, { x: SUM_X, y, size: 15, font: 'headBold', lh: 1 });
    const totalLabelH = measure('Gesamtbetrag', {
      x: SUM_X,
      y,
      size: 10.5,
      font: 'headSemi',
      lh: 1,
    });
    text('Gesamtbetrag', {
      x: SUM_X,
      y: y + (totalValueH - totalLabelH),
      font: 'headSemi',
      size: 10.5,
      lh: 1,
    });
    text(data.total, {
      x: SUM_X,
      y,
      w: SUM_W,
      font: 'headBold',
      size: 15,
      color: accent,
      align: 'right',
      lh: 1,
      tnum: true,
    });
    y = stack(y, totalValueH);

    if (!data.tax) {
      // §19 UStG note is mandatory when no VAT is shown.
      y += 4;
      y = stack(
        y,
        text('Gemäß §19 UStG wird keine Umsatzsteuer berechnet (Kleinunternehmerregelung).', {
          x: L,
          y,
          w: CONTENT_W,
          size: 8,
          color: MUTED,
        }),
      );
    }

    const payText: Run[][] = paid
      ? [
          [
            {
              text:
                data.paymentMethod === 'card'
                  ? 'Der Rechnungsbetrag wurde per Kartenzahlung beglichen. Vielen Dank!'
                  : 'Der Rechnungsbetrag wurde in bar beglichen. Vielen Dank!',
            },
          ],
        ]
      : [
          data.dueDate
            ? [
                { text: 'Bitte überweisen Sie den Gesamtbetrag bis zum ' },
                { text: data.dueDate, font: 'bodySemi' },
                { text: ` (Zahlungsziel ${data.paymentTermsDays} Tage).` },
              ]
            : [
                {
                  text: `Bitte überweisen Sie den Gesamtbetrag innerhalb von ${data.paymentTermsDays} Tagen.`,
                },
              ],
          [
            { text: 'Bitte geben Sie bei der Überweisung die Rechnungsnummer ' },
            { text: data.invoiceNumber, font: 'bodySemi' },
            { text: ' an.' },
          ],
        ];
    const PAY_X = L + 1.6 / MM + 3.4; // border-left 1.6 pt + padding-left 3.4 mm
    const PAY_W = R - PAY_X;
    y += 9;

    // Closing group (payment terms, §35a, remark, thank-you) is measured up front and moves to the next page as a whole.
    const craftH = data.craftsmanNote
      ? 6 + measure(data.craftsmanNote, { x: L, y, w: CONTENT_W, size: 9 })
      : 0;
    const notesH = data.notes ? 4 + measure(data.notes, { x: L, y, w: CONTENT_W, size: 8.8 }) : 0;
    const thxH =
      6 + measure(INVOICE_THANK_YOU, { x: L, y, w: CONTENT_W, font: 'headMed', size: 10 });
    const payH = payText.reduce(
      (acc, runs, i) =>
        acc +
        (i > 0 ? 1.1 : 0) +
        // Run styling only changes the width marginally — close enough for pagination.
        measure(runs.map((r) => r.text).join(''), { x: PAY_X, y, w: PAY_W, size: 9.6 }),
      0,
    );
    ensure(payH + craftH + notesH + thxH, false);

    const payTop = y;
    payText.forEach((runs, i) => {
      if (i > 0) y += 1.1;
      y = stack(y, textRuns(runs, { x: PAY_X, y, w: PAY_W, size: 9.6 }));
    });
    doc
      .rect(mm(L), mm(payTop), 1.6, mm(y - payTop))
      .fillColor(PAY_BAR)
      .fill();

    // §35a EStG: printed verbatim as stored, in body ink; the customer forwards it to their tax office.
    if (data.craftsmanNote) {
      y += 6;
      ensure(craftH - 6, false);
      y = stack(y, text(data.craftsmanNote, { x: L, y, w: CONTENT_W, size: 9 }));
    }

    if (data.notes) {
      y += 4;
      ensure(notesH - 4, false);
      y = stack(y, text(data.notes, { x: L, y, w: CONTENT_W, size: 8.8, color: MUTED }));
    }

    y += 6;
    ensure(thxH - 6, false);
    text(INVOICE_THANK_YOU, {
      x: L,
      y,
      w: CONTENT_W,
      font: 'headMed',
      size: 10,
    });

    drawFooter();

    if (pageNo > 1) stampPageNumbers(kit);

    doc.end();
  });
}
