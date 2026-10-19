/**
 * Eingangsbestätigung as A4 PDF (email attachment + dashboard preview), same DIN 5008 letterhead
 * as the invoice (`lib/pdf-letterhead.ts`). Strings come pre-formatted from `buildReceiptView`; no I/O here.
 */
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
  type LetterheadBank,
  type LetterheadSeller,
} from '../../lib/pdf-letterhead.js';

import type { ReceiptView } from './receipt.js';

export interface ReceiptPdfData {
  brandName: string;
  accentColor: string;
  logo?: Buffer | null;
  claim?: string | null;
  seller: LetterheadSeller;
  bank?: LetterheadBank;
  recipientName: string;
  recipientCompany?: string | null;
  recipientAddressLines: string[];
  view: ReceiptView;
  /** JPEG/PNG bytes by S3 key. A photo without bytes prints as a placeholder. */
  photos: Map<string, Buffer>;
}

// Table columns (mm); "Pos." takes the first 8 mm of its description cell.
const COL_POS = { x: L, w: 7 };
const COL_DESC = { x: L + 9, w: 83 };
const COL_QTY = { x: 120, w: 16 };
const COL_UNIT = { x: 136, w: 26 };
const COL_AMT = { x: 162, w: 28 };

const PHOTO_COLS = 3;
const PHOTO_GAP = 4;
const PHOTO_W = (CONTENT_W - PHOTO_GAP * (PHOTO_COLS - 1)) / PHOTO_COLS;
const PHOTO_H = 40;
const PHOTO_CAPTION_H = 6;

export function renderReceiptPdf(data: ReceiptPdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const kit = createLetterDoc(data.accentColor);
    kit.done.then(resolve, reject);
    const { doc, accent, text, measure, rule, stack } = kit;
    const v = data.view;

    const infoRows: Array<[string, string, boolean]> = [
      ['Auftragsnummer', v.orderNumber, false],
      ['Übergabe', v.handoverLabel, false],
      ['Datum', v.receivedDate, false],
    ];
    if (v.receivedTime) infoRows.push(['Uhrzeit', `${v.receivedTime} Uhr`, false]);
    infoRows.push(['Positionen', String(v.positions.length), false]);

    drawLetterhead(kit, {
      brandName: data.brandName,
      logo: data.logo,
      claim: data.claim,
      seller: data.seller,
      recipientName: data.recipientName,
      recipientCompany: data.recipientCompany,
      recipientAddressLines: data.recipientAddressLines,
      infoTitle: 'Eingangsbestätigung',
      infoRows,
    });

    let pageNo = 1;
    let y = BODY_TOP;

    const nextPage = (repeatTableHead: boolean) => {
      drawLegalFooter(kit, data.seller, data.bank);
      doc.addPage();
      pageNo += 1;
      text(`Eingangsbestätigung · Auftrag ${v.orderNumber} · ${data.brandName}`, {
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

    function drawTableHead(top: number): number {
      const head = {
        y: top,
        font: 'headSemi' as const,
        size: 7.4,
        color: MUTED,
        tracking: 0.1,
        upper: true,
      };
      const h = text('Pos.', { ...head, x: COL_POS.x, w: COL_POS.w });
      text('Bezeichnung', { ...head, x: COL_DESC.x, w: COL_DESC.w });
      for (const [label, col] of [
        ['Menge', COL_QTY],
        ['Einzelpreis', COL_UNIT],
        ['Betrag', COL_AMT],
      ] as const) {
        text(label, { ...head, x: col.x, w: col.w, align: 'right' });
      }
      const bottom = top + h + 1.8;
      rule(L, bottom, R, 0.75, INK);
      return bottom;
    }

    y = stack(
      y,
      text(`Eingangsbestätigung · Auftrag ${v.orderNumber}`, {
        x: L,
        y,
        w: CONTENT_W,
        font: 'headBold',
        size: 16.5,
        tracking: -0.015,
      }),
    );
    y += 1.4;
    y = stack(y, text(v.confirmation, { x: L, y, w: CONTENT_W, size: 9.6, color: MUTED }));
    if (v.isUpdate) {
      y += 1;
      y = stack(
        y,
        text('Diese Fassung ersetzt die zuvor gesendete Eingangsbestätigung.', {
          x: L,
          y,
          w: CONTENT_W,
          font: 'bodySemi',
          size: 9.6,
          color: accent,
        }),
      );
    }
    y += 8;
    y = drawTableHead(y);

    for (const p of v.positions) {
      const detailText = p.details.join(' · ');
      const conditionText = p.condition ? `Zustand: ${p.condition}` : null;
      const labelH = measure(p.label, {
        x: COL_DESC.x,
        y,
        w: COL_DESC.w,
        font: 'bodySemi',
        size: 9.6,
      });
      const detailH = detailText
        ? measure(detailText, { x: COL_DESC.x, y, w: COL_DESC.w, size: 8.8 })
        : 0;
      const condH = conditionText
        ? measure(conditionText, { x: COL_DESC.x, y, w: COL_DESC.w, size: 8.8 })
        : 0;
      const addonH = p.addons.reduce(
        (acc, a) =>
          acc + 1.2 + measure(`+ ${a.label}`, { x: COL_DESC.x, y, w: COL_DESC.w, size: 9 }),
        0,
      );
      const rowH = 3.2 + Math.max(labelH + detailH + condH + addonH, 4) + 3.2;
      ensure(rowH);

      const ty = y + 3.2;
      text(String(p.pos), {
        x: COL_POS.x,
        y: ty,
        w: COL_POS.w,
        size: 9.6,
        color: MUTED,
        tnum: true,
      });
      let dy = stack(
        ty,
        text(p.label, { x: COL_DESC.x, y: ty, w: COL_DESC.w, font: 'bodySemi', size: 9.6 }),
      );
      if (detailText)
        dy = stack(
          dy,
          text(detailText, { x: COL_DESC.x, y: dy, w: COL_DESC.w, size: 8.8, color: MUTED }),
        );
      if (conditionText)
        dy = stack(
          dy,
          text(conditionText, { x: COL_DESC.x, y: dy, w: COL_DESC.w, size: 8.8, color: MUTED }),
        );
      const money = (row: number, q: string, u: string, amt: string, size: number) => {
        for (const [value, col] of [
          [q, COL_QTY],
          [u, COL_UNIT],
          [amt, COL_AMT],
        ] as const) {
          text(value, { x: col.x, y: row, w: col.w, size, align: 'right', tnum: true });
        }
      };
      money(ty, p.quantityLabel, p.unitPrice, p.lineTotal, 9.6);
      for (const a of p.addons) {
        dy += 1.2;
        const ah = text(`+ ${a.label}`, { x: COL_DESC.x, y: dy, w: COL_DESC.w, size: 9 });
        money(dy, a.quantityLabel, a.unitPrice, a.lineTotal, 9);
        dy = stack(dy, ah);
      }
      y += rowH;
      rule(L, y, R, 0.25, RULE);
    }

    const SUM_X = R - 78;
    const SUM_W = 78;
    const sumRow = (
      label: string,
      value: string,
      opts: { bold?: boolean; color?: string } = {},
    ) => {
      y += 1.9;
      const h = Math.max(
        measure(label, { x: SUM_X, y, size: 9.6 }),
        measure(value, { x: SUM_X, y, size: 9.6 }),
      );
      text(label, {
        x: SUM_X,
        y,
        size: 9.6,
        color: opts.bold ? INK : MUTED,
        font: opts.bold ? 'bodySemi' : 'body',
      });
      text(value, {
        x: SUM_X,
        y,
        w: SUM_W,
        font: opts.bold ? 'bodyBold' : 'bodyMed',
        size: 9.6,
        align: 'right',
        color: opts.color ?? INK,
        tnum: true,
      });
      y = stack(y, h) + 1.9;
    };

    // Keep the totals block together: ~9 mm per row, ~18 mm for Gesamtbetrag.
    ensure(6 + (v.summary.length + v.payment.length) * 9 + 18 + (v.payment.length ? 2 : 0), false);
    y += 6;
    v.summary.forEach((s, i) => {
      if (i > 0) rule(SUM_X, y, R, 0.25, RULE);
      sumRow(s.label, s.value);
    });
    y += 2;
    rule(SUM_X, y, R, 1.6, accent);
    y += 2.6;
    const totalValueH = measure(v.total, { x: SUM_X, y, size: 15, font: 'headBold', lh: 1 });
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
    text(v.total, {
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
    y = stack(y, totalValueH) + 1.4;
    y = stack(
      y,
      text('inkl. 19 % MwSt.', { x: SUM_X, y, w: SUM_W, size: 8, color: MUTED, align: 'right' }),
    );
    if (v.payment.length) {
      y += 2;
      v.payment.forEach((p, i) => {
        if (i > 0) rule(SUM_X, y, R, 0.25, RULE);
        sumRow(p.label, p.value, p.emphasis ? { bold: true, color: accent } : {});
      });
    }

    const NOTE_X = L + 1.6 / MM + 3.4;
    const NOTE_W = R - NOTE_X;
    if (v.note) {
      const noteH =
        measure('Hinweis', { x: NOTE_X, y, w: NOTE_W, font: 'bodySemi', size: 9.6 }) +
        measure(v.note, { x: NOTE_X, y, w: NOTE_W, size: 9.6 });
      y += 8;
      ensure(noteH, false);
      const top = y;
      y = stack(y, text('Hinweis', { x: NOTE_X, y, w: NOTE_W, font: 'bodySemi', size: 9.6 }));
      y = stack(y, text(v.note, { x: NOTE_X, y, w: NOTE_W, size: 9.6 }));
      doc
        .rect(mm(L), mm(top), 1.6, mm(y - top))
        .fillColor(accent)
        .fill();
    }

    const closing = [
      'Bitte prüfen Sie die Angaben. Sollte etwas nicht stimmen, melden Sie sich bitte bei uns.',
      v.invoiceFollows ? 'Die Rechnung erhalten Sie nach Abschluss der Arbeiten.' : null,
    ]
      .filter(Boolean)
      .join(' ');
    const closingH = measure(closing, { x: L, y, w: CONTENT_W, font: 'headMed', size: 10 });
    y += 7;
    ensure(closingH, false);
    y = stack(y, text(closing, { x: L, y, w: CONTENT_W, font: 'headMed', size: 10 }));

    const shots = v.positions.flatMap((p) =>
      p.photos.map((photo, i) => ({
        photo,
        caption: [
          `Pos. ${p.pos}`,
          p.details.find((d) => d.startsWith('Etikett')),
          p.photos.length > 1 ? `Foto ${i + 1}/${p.photos.length}` : null,
        ]
          .filter(Boolean)
          .join(' · '),
      })),
    );
    if (shots.length) {
      const cellH = PHOTO_H + PHOTO_CAPTION_H;
      y += 10;
      ensure(8 + cellH, false);
      y = stack(
        y,
        text('Fotodokumentation bei Übernahme', {
          x: L,
          y,
          w: CONTENT_W,
          font: 'headSemi',
          size: 7.4,
          color: MUTED,
          tracking: 0.1,
          upper: true,
        }),
      );
      y += 1.8;
      rule(L, y, R, 0.75, INK);
      y += 4;
      for (let i = 0; i < shots.length; i += PHOTO_COLS) {
        ensure(cellH, false);
        shots.slice(i, i + PHOTO_COLS).forEach((shot, c) => {
          const x = L + c * (PHOTO_W + PHOTO_GAP);
          doc
            .rect(mm(x), mm(y), mm(PHOTO_W), mm(PHOTO_H))
            .lineWidth(0.25)
            .strokeColor(RULE)
            .stroke();
          const bytes = data.photos.get(shot.photo.key);
          let drawn = false;
          if (bytes) {
            try {
              doc.image(bytes, mm(x + 0.5), mm(y + 0.5), {
                fit: [mm(PHOTO_W - 1), mm(PHOTO_H - 1)],
                align: 'center',
                valign: 'center',
              });
              drawn = true;
            } catch {
              drawn = false;
            }
          }
          if (!drawn)
            text('Foto nicht verfügbar', {
              x,
              y: y + PHOTO_H / 2 - 2,
              w: PHOTO_W,
              size: 8,
              color: MUTED,
              align: 'center',
            });
          text(shot.caption, { x, y: y + PHOTO_H + 1.2, w: PHOTO_W, size: 7.6, color: MUTED });
        });
        y += cellH + 3;
      }
    }

    drawLegalFooter(kit, data.seller, data.bank);
    if (pageNo > 1) stampPageNumbers(kit);
    doc.end();
  });
}
