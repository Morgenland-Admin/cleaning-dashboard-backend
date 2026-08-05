/**
 * Renders a German "Rechnung" PDF for an invoice using pdfkit (pure JS, no
 * headless browser). Returns a Buffer ready to attach to a Resend email.
 *
 * Layout implements the CLEANILO invoice template (Kabir, 08/2026) to DIN 5008
 * Form B: address field 25 mm from the left / 45 mm from the top, fold marks at
 * 105 mm and 210 mm, punch mark at 148.5 mm, legal footer at 264 mm. Every
 * position below is expressed in millimetres via `mm()` so the printed sheet can
 * be measured against the spec with a ruler.
 *
 * The template is brand-neutral: logo, accent colour, sender, legal footer and
 * bank block all come from the company row, so CLEANILO, Hamburg
 * Teppichreinigung and TRL share one renderer.
 *
 * Mirrors the data shown in `invoiceEmail` so the PDF and the HTML body match.
 * Strings are pre-formatted (German EUR / dates) by the caller.
 *
 * Placeholders of the automation template ("CL-1428 Rechnung - Vorlage.html")
 * map 1:1 onto this data, which `buildInvoicePdfData` fills from the invoice +
 * company row — automations set the invoice fields, never the strings:
 *
 *   {{RECHNUNGSNUMMER}}   invoiceNumber      ← invoices.number (assigned at issue)
 *   {{RECHNUNGSDATUM}}    invoiceDate        ← invoices.sent_at
 *   {{LEISTUNGSDATUM}}    serviceDateLabel   ← invoices.service_date [+ _end]
 *   {{FAELLIG_BIS}}       dueDate            ← invoices.due_at
 *   {{ZAHLUNGSZIEL_TAGE}} paymentTermsDays   ← invoices.payment_terms_days
 *   {{KUNDE_FIRMA}}       recipientCompany   ← invoices.recipient_company (B2B)
 *   {{KUNDE_NAME}}        recipientName      ← invoices.recipient_name
 *   {{KUNDE_USTID}}       recipientVatId     ← invoices.recipient_vat_id (B2B)
 *   {{KUNDE_STRASSE}}     recipientAddressLines[0] ← recipient_address_line1 [+2]
 *   {{KUNDE_PLZ_ORT}}     recipientAddressLines[1] ← recipient_postal_code + _city
 *   {{BETREFF}}           subject            ← invoices.subject
 *   {{POSn_TITEL}}        lineItems[n].label     ← invoices.line_items[n].label
 *   {{POSn_ZUSATZ}}       lineItems[n].note      ← invoices.line_items[n].note
 *   {{POSn_MENGE}}        lineItems[n].quantity  ← …quantity
 *   {{POSn_EP}}           lineItems[n].unitPrice ← …unitPriceCents
 *   {{POSn_BETRAG}}       lineItems[n].lineTotal ← quantity × unitPriceCents
 *   {{NETTO}}             subtotal           ← invoices.subtotal_cents
 *   {{UST_SATZ}}          taxRateLabel       ← invoices.tax_rate_percent
 *   {{UST_BETRAG}}        tax                ← invoices.tax_cents
 *   {{GESAMT}}            total              ← invoices.total_cents
 *   {{HANDWERKERLEISTUNG}} craftsmanNote     ← invoices.craftsman_note (§35a EStG)
 *   {{BEMERKUNG}}         notes              ← invoices.notes
 *
 * The closing thank-you line is fixed for all brands (`INVOICE_THANK_YOU`).
 *
 * The sender, legal footer and Bankverbindung are not placeholders — they are
 * read from the company row so every brand stays correct without editing here.
 */
import { readFileSync } from 'node:fs';

import PDFDocument from 'pdfkit';

import { INVOICE_THANK_YOU } from './invoice-text.js';

export interface InvoicePdfData {
  brandName: string;
  invoiceNumber: string;
  invoiceDate: string;
  dueDate: string | null;
  paymentTermsDays: number;
  /** Betreff line under the "Rechnung Nr. …" headline ({{BETREFF}}). */
  subject?: string | null;
  recipientName: string;
  /** B2B: company line printed above the recipient name in the address field. */
  recipientCompany?: string | null;
  /** B2B: USt-IdNr. of the recipient, printed in the information block. */
  recipientVatId?: string | null;
  /** §14 UStG: recipient postal address lines (street, "PLZ Ort", country). */
  recipientAddressLines?: string[];
  /** §14 UStG: pre-formatted Leistungsdatum or "von – bis" Leistungszeitraum. */
  serviceDateLabel?: string | null;
  lineItems: Array<{
    label: string;
    /** Optional second line under the label ({{POSn_ZUSATZ}}), e.g. "Premiumreinigung". */
    note?: string | null;
    quantity: string;
    unitPrice: string;
    lineTotal: string;
    /** Package/section header line — rendered bold to group the items below it. */
    isPackage?: boolean;
  }>;
  subtotal: string;
  tax: string | null;
  taxRateLabel: string | null;
  total: string;
  /**
   * §35a EStG block, printed above the closing line. Pre-composed and frozen on
   * the invoice row (`craftsman_note`) so a reissue reproduces it verbatim.
   */
  craftsmanNote?: string | null;
  /** Free-text remark for this one invoice, printed under the payment terms. */
  notes?: string | null;
  /** 'transfer' (default) shows bank + due date; 'card'/'cash' show "paid". */
  paymentMethod?: string | null;
  accentColor: string;
  /** Optional raster brand logo (PNG/JPEG) drawn top-left; falls back to text. */
  logo?: Buffer | null;
  /** Claim under the wordmark — only used by the text fallback (raster logos carry their own). */
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
    // German Pflichtangaben for the legal footer.
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

// ── Design tokens (CLEANILO invoice template) ─────────────────────────────
const INK = '#0A182D';
const MUTED = '#5A6875';
const RULE = '#DCE1E6';
const MARK = '#B8C0C8'; // fold / punch marks
const PAY_BAR = '#FFBF00'; // accent bar next to the payment terms
const ACCENT_FALLBACK = '#bd5b3e';

// ── Geometry, all millimetres (DIN 5008 Form B) ───────────────────────────
const MM = 72 / 25.4;
const mm = (v: number) => v * MM;
const L = 25; // left type area
const R = 190; // right type area (210 − 20)
const CONTENT_W = R - L; // 165
const HEADER_TOP = 13.5;
const ADDR_TOP = 45;
const ADDR_W = 85;
const INFO_X = 125;
const INFO_W = R - INFO_X; // 65
const BODY_TOP = 100;
const FOOTER_TOP = 264;
const FOLD_1 = 105;
const FOLD_2 = 210;
const PUNCH = 148.5;
/** Last y a body element may occupy before it has to move to the next page. */
const BODY_BOTTOM = FOOTER_TOP - 6;

// Item table columns (x / width in mm) — 16 + 26 + 28 numeric, rest description.
const COL_DESC = { x: L, w: 92 }; // 95 mm cell, 3 mm gutter before "Menge"
const COL_QTY = { x: 120, w: 16 };
const COL_UNIT = { x: 136, w: 26 };
const COL_AMT = { x: 162, w: 28 };

// ── Embedded fonts (OFL, vendored in src/assets/fonts) ────────────────────
const FONT_DIR = new URL('../assets/fonts/', import.meta.url);
const FONT_FILES = {
  body: 'Cabin-Regular.ttf',
  bodyMed: 'Cabin-Medium.ttf',
  bodySemi: 'Cabin-SemiBold.ttf',
  bodyBold: 'Cabin-Bold.ttf',
  headMed: 'Urbanist-Medium.ttf',
  headSemi: 'Urbanist-SemiBold.ttf',
  headBold: 'Urbanist-Bold.ttf',
} as const;
type FontKey = keyof typeof FONT_FILES;
/** Used when a TTF is missing (e.g. assets not copied) — layout stays intact. */
const FONT_FALLBACK: Record<FontKey, string> = {
  body: 'Helvetica',
  bodyMed: 'Helvetica',
  bodySemi: 'Helvetica-Bold',
  bodyBold: 'Helvetica-Bold',
  headMed: 'Helvetica',
  headSemi: 'Helvetica-Bold',
  headBold: 'Helvetica-Bold',
};

let fontCache: Partial<Record<FontKey, Buffer>> | undefined;
function loadFonts(): Partial<Record<FontKey, Buffer>> {
  if (fontCache) return fontCache;
  const loaded: Partial<Record<FontKey, Buffer>> = {};
  for (const [key, file] of Object.entries(FONT_FILES) as Array<[FontKey, string]>) {
    try {
      loaded[key] = readFileSync(new URL(file, FONT_DIR));
    } catch {
      // Missing font → the Helvetica fallback keeps invoices renderable.
    }
  }
  fontCache = loaded;
  return loaded;
}

interface TextOpts {
  x: number;
  y: number;
  /** Wrap width in mm; omit for a single unbreakable line. */
  w?: number;
  font?: FontKey;
  size: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
  /** CSS line-height multiplier (the template's body default is 1.45). */
  lh?: number;
  /** Letter spacing in em, as in the CSS (`.1em`). */
  tracking?: number;
  upper?: boolean;
  /** Tabular figures for money / quantity columns. */
  tnum?: boolean;
}

interface Run {
  text: string;
  font?: FontKey;
  color?: string;
}

export function renderInvoicePdf(data: InvoicePdfData): Promise<Buffer> {
  return new Promise((resolve, reject) => {
    const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
    const chunks: Buffer[] = [];
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);

    const fonts = loadFonts();
    const registered = new Set<FontKey>();
    for (const [key, buf] of Object.entries(fonts) as Array<[FontKey, Buffer]>) {
      try {
        doc.registerFont(key, buf);
        registered.add(key);
      } catch {
        // Corrupt font file → fall back for that weight only.
      }
    }
    const fontOf = (key: FontKey) => (registered.has(key) ? key : FONT_FALLBACK[key]);

    const accent = /^#[0-9a-fA-F]{6}$/.test(data.accentColor) ? data.accentColor : ACCENT_FALLBACK;
    const paid = data.paymentMethod === 'card' || data.paymentMethod === 'cash';

    // ── Primitives ────────────────────────────────────────────────────────
    /** Horizontal hairline. `weight` is in pt, matching the CSS border widths. */
    const rule = (x1: number, y: number, x2: number, weight: number, color: string) =>
      doc.moveTo(mm(x1), mm(y)).lineTo(mm(x2), mm(y)).lineWidth(weight).strokeColor(color).stroke();

    const pdfOpts = (o: TextOpts) => {
      const lh = o.lh ?? 1.45;
      doc.font(fontOf(o.font ?? 'body')).fontSize(o.size);
      const boxH = o.size * lh;
      const gap = boxH - doc.currentLineHeight(false);
      return {
        gap,
        boxH,
        opts: {
          width: o.w != null ? mm(o.w) : undefined,
          align: o.align ?? 'left',
          characterSpacing: o.tracking ? o.tracking * o.size : 0,
          lineBreak: o.w != null,
          lineGap: gap,
          ...(o.tnum ? { features: ['tnum' as const] } : {}),
        },
      };
    };

    /**
     * Draws text as a CSS line box: `y` is the top of the box, glyphs are
     * centred inside it via half-leading. Returns the block height in mm so
     * callers can stack elements exactly like the HTML template does.
     */
    const text = (str: string, o: TextOpts): number => {
      const { gap, opts } = pdfOpts(o);
      const s = o.upper ? str.toUpperCase() : str;
      doc.fillColor(o.color ?? INK);
      const h = doc.heightOfString(s, opts);
      doc.text(s, mm(o.x), mm(o.y) + gap / 2, opts);
      return h / MM;
    };

    /** Measures `text()` without drawing (for row-height maths). */
    const measure = (str: string, o: TextOpts): number => {
      const { opts } = pdfOpts(o);
      return doc.heightOfString(o.upper ? str.toUpperCase() : str, opts) / MM;
    };

    /**
     * A line built from differently-styled runs (e.g. "IBAN: <bold>"). Returns
     * the height actually drawn — runs may wrap to several lines, and reporting
     * one line would let the next element overlap them.
     */
    const textRuns = (runs: Run[], o: TextOpts): number => {
      const parts = runs.filter((r) => r.text);
      if (!parts.length) return 0;
      const { gap, opts } = pdfOpts(o);
      const y = mm(o.y) + gap / 2;
      parts.forEach((run, i) => {
        const runOpts = { ...opts, continued: i < parts.length - 1 };
        doc.font(fontOf(run.font ?? o.font ?? 'body')).fontSize(o.size);
        doc.fillColor(run.color ?? o.color ?? INK);
        if (i === 0) doc.text(run.text, mm(o.x), y, runOpts);
        else doc.text(run.text, runOpts);
      });
      // pdfkit advances doc.y past the whole (possibly wrapped) chain.
      return (doc.y - y) / MM;
    };

    /** Bottom edge of a text block, given its top and height. */
    const stack = (y: number, h: number) => y + h;

    // ── Legal footer (drawn on every page) ────────────────────────────────
    const footerCols = () => {
      // CSS grid 1fr 1fr 1.15fr with 6 mm gaps across the 165 mm type area.
      const unit = (CONTENT_W - 12) / 3.15;
      return [
        { x: L, w: unit },
        { x: L + unit + 6, w: unit },
        { x: L + 2 * unit + 12, w: unit * 1.15 },
      ];
    };

    const drawFooter = () => {
      const cols = footerCols();
      rule(L, FOOTER_TOP, R, 0.25, RULE);
      const top = FOOTER_TOP + 3;

      const groups: Array<{ title: string; lines: Run[][] }> = [
        {
          title: 'Unternehmen',
          lines: [
            data.seller.legalForm
              ? [
                  { text: 'Rechtsform: ', color: MUTED },
                  { text: data.seller.legalForm, font: 'bodyMed', color: INK },
                ]
              : [],
            data.seller.managingDirectors
              ? [
                  { text: 'Geschäftsführer: ', color: MUTED },
                  { text: data.seller.managingDirectors, font: 'bodyMed', color: INK },
                ]
              : [],
            data.seller.chamber ? [{ text: data.seller.chamber, color: MUTED }] : [],
          ],
        },
        {
          // Steuernummer is deliberately absent — only the USt-IdNr. is shown.
          title: 'Steuer',
          lines: [
            data.seller.vatId
              ? [
                  { text: 'USt-IdNr.: ', color: MUTED },
                  { text: data.seller.vatId, font: 'bodyMed', color: INK },
                ]
              : [],
            data.seller.businessId
              ? [
                  { text: 'Betriebsnummer: ', color: MUTED },
                  { text: data.seller.businessId, font: 'bodyMed', color: INK },
                ]
              : [],
            data.seller.registrationNumber
              ? [
                  { text: 'Reg-Nr.: ', color: MUTED },
                  { text: data.seller.registrationNumber, font: 'bodyMed', color: INK },
                ]
              : [],
          ],
        },
        {
          title: 'Bankverbindung',
          lines: data.bank?.iban
            ? [
                data.bank.bankName
                  ? [
                      { text: 'Bank: ', color: MUTED },
                      { text: data.bank.bankName, color: MUTED },
                    ]
                  : [],
                [
                  { text: 'IBAN: ', color: MUTED },
                  { text: formatIbanPdf(data.bank.iban), font: 'bodyMed', color: INK },
                ],
                data.bank.bic
                  ? [
                      { text: 'BIC: ', color: MUTED },
                      { text: data.bank.bic, font: 'bodyMed', color: INK },
                    ]
                  : [],
              ]
            : [],
        },
      ];

      groups.forEach((group, i) => {
        const col = cols[i]!;
        const lines = group.lines.filter((l) => l.length);
        if (!lines.length) return;
        let y = top;
        y = stack(
          y,
          text(group.title, {
            x: col.x,
            y,
            w: col.w,
            font: 'headSemi',
            size: 6.8,
            color: accent,
            tracking: 0.1,
            upper: true,
          }),
        );
        y += 1.1; // CSS margin-bottom on the column head
        for (const line of lines) {
          y = stack(y, textRuns(line, { x: col.x, y, w: col.w, size: 7.2, lh: 1.5 }));
        }
      });
    };

    // ── Page 1: fold + punch marks, header, address, info block ───────────
    rule(0, FOLD_1, 5, 0.25, MARK);
    rule(0, FOLD_2, 5, 0.25, MARK);
    rule(0, PUNCH, 8, 0.4, MARK);

    // Logo: the official raster wordmark (it already carries the claim). Falls
    // back to a drawn tile + wordmark only when no usable image is available.
    let logoDrawn = false;
    if (data.logo) {
      try {
        doc.image(data.logo, mm(L), mm(HEADER_TOP), { fit: [mm(70), mm(12.4)] });
        logoDrawn = true;
      } catch {
        logoDrawn = false;
      }
    }
    if (!logoDrawn) {
      const tile = 8.2;
      doc.roundedRect(mm(L), mm(HEADER_TOP), mm(tile), mm(tile), mm(2.4)).fillColor(accent).fill();
      const initialH = 12.5 / MM;
      text(data.brandName.slice(0, 1).toUpperCase(), {
        x: L,
        y: HEADER_TOP + (tile - initialH) / 2,
        w: tile,
        font: 'headBold',
        size: 12.5,
        color: '#ffffff',
        align: 'center',
        lh: 1,
      });
      const markH = (19 * 1.45) / MM;
      text(data.brandName, {
        x: L + tile + 2.4,
        y: HEADER_TOP + (tile - markH) / 2,
        font: 'headBold',
        size: 19,
        tracking: -0.02,
      });
      if (data.claim)
        text(data.claim, {
          x: L + 10.6,
          y: HEADER_TOP + tile + 1.6,
          w: CONTENT_W - 10.6,
          font: 'headMed',
          size: 7.4,
          color: accent,
          tracking: 0.11,
          upper: true,
        });
    }

    // Sender block, right-aligned against the 190 mm type edge.
    const senderLines: Run[][] = [[{ text: data.brandName.toUpperCase(), font: 'bodySemi' }]];
    if (data.seller.name && data.seller.name !== data.brandName)
      senderLines.push([{ text: data.seller.name, color: MUTED }]);
    const [addr0, ...addrRest] = data.seller.addressLines;
    if (addr0) senderLines.push([{ text: `Zentrale: ${addr0}`, color: MUTED }]);
    for (const a of addrRest) senderLines.push([{ text: a, color: MUTED }]);
    if (data.seller.phone) senderLines.push([{ text: `Tel.: ${data.seller.phone}`, color: MUTED }]);
    if (data.seller.mobile)
      senderLines.push([{ text: `Mobil: ${data.seller.mobile}`, color: MUTED }]);
    const contact = [data.seller.website, data.seller.email].filter(Boolean).join(' · ');
    if (contact) senderLines.push([{ text: contact, color: MUTED }]);
    if (data.seller.businessId)
      senderLines.push([{ text: `Betriebsnummer: ${data.seller.businessId}`, color: MUTED }]);
    let sy = HEADER_TOP;
    for (const line of senderLines) {
      sy = stack(
        sy,
        // A long "web · mail" line wraps inside the 65 mm block and pushes the
        // following lines down (the template's nowrap has no pdfkit equivalent).
        textRuns(line, { x: INFO_X, y: sy, w: INFO_W, size: 7.9, align: 'right', color: MUTED }),
      );
    }

    // Address field — 25 mm / 45 mm, DIN lang window. No email address here.
    let ay = ADDR_TOP;
    ay = stack(
      ay,
      text(`${data.brandName} · ${data.seller.addressLines.join(' · ')}`, {
        x: L,
        y: ay,
        w: 80,
        size: 6.6,
        color: MUTED,
        tracking: 0.01,
      }),
    );
    ay += 0.6; // CSS padding-bottom on the return line
    rule(L, ay, L + 80, 0.25, RULE);
    ay += 4.4; // CSS margin-top on the address block
    // DIN 5008: company line first, then the person, then the street.
    if (data.recipientCompany) {
      ay = stack(
        ay,
        text(data.recipientCompany, {
          x: L,
          y: ay,
          w: ADDR_W,
          font: 'bodySemi',
          size: 10.4,
          lh: 1.5,
        }),
      );
    }
    ay = stack(
      ay,
      text(data.recipientName, {
        x: L,
        y: ay,
        w: ADDR_W,
        font: data.recipientCompany ? 'body' : 'bodySemi',
        size: 10.4,
        lh: 1.5,
      }),
    );
    for (const line of data.recipientAddressLines ?? []) {
      ay = stack(ay, text(line, { x: L, y: ay, w: ADDR_W, size: 10.4, lh: 1.5 }));
    }

    // Information block (right of the address field).
    let iy = ADDR_TOP;
    iy = stack(
      iy,
      text('Rechnung', {
        x: INFO_X,
        y: iy,
        w: INFO_W,
        font: 'headSemi',
        size: 7.2,
        color: accent,
        tracking: 0.12,
        upper: true,
      }),
    );
    iy += 1.4;
    rule(INFO_X, iy, R, 1, accent);
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
    // B2B: the recipient's USt-IdNr. belongs on the invoice, not in the DIN
    // address window — it rides along with the other invoice metadata.
    if (data.recipientVatId) infoRows.push(['USt-IdNr. Kunde', data.recipientVatId, false]);
    if (data.dueDate && !paid) infoRows.push(['Fällig bis', data.dueDate, true]);
    for (const [label, value, due] of infoRows) {
      iy += 1.5; // CSS padding-top
      const h = Math.max(
        measure(label, { x: INFO_X, y: iy, size: 8.8 }),
        measure(value, { x: INFO_X, y: iy, size: 8.8 }),
      );
      text(label, { x: INFO_X, y: iy, size: 8.8, color: MUTED });
      text(value, {
        x: INFO_X,
        y: iy,
        w: INFO_W,
        font: 'bodySemi',
        size: 8.8,
        align: 'right',
        color: due ? accent : INK,
        tnum: true,
      });
      iy = stack(iy, h) + 1.5; // CSS padding-bottom
      rule(INFO_X, iy, R, 0.25, RULE);
    }

    // ── Body ──────────────────────────────────────────────────────────────
    let pageNo = 1;
    let y = BODY_TOP;

    /**
     * Starts a continuation page: compact header, plus the table head when more
     * item rows follow (a totals-only page must not carry an empty head).
     */
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
    /** Moves to a new page when `need` mm would run into the footer. */
    const ensure = (need: number, repeatTableHead = true) => {
      if (y + need > BODY_BOTTOM) nextPage(repeatTableHead);
    };

    function drawTableHead(top: number): number {
      const h = text('Bezeichnung', {
        x: COL_DESC.x,
        y: top,
        w: COL_DESC.w,
        font: 'headSemi',
        size: 7.4,
        color: MUTED,
        tracking: 0.1,
        upper: true,
      });
      for (const [label, col] of [
        ['Menge', COL_QTY],
        ['Einzelpreis', COL_UNIT],
        ['Betrag', COL_AMT],
      ] as Array<[string, { x: number; w: number }]>) {
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
      const bottom = top + h + 1.8; // CSS padding-bottom on th
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
    y += 9; // CSS margin-top on the table
    y = drawTableHead(y);

    for (const item of data.lineItems) {
      // Template weight for a position title is 600; package headers go to 700.
      const titleFont: FontKey = item.isPackage ? 'bodyBold' : 'bodySemi';
      const titleH = measure(item.label, {
        x: COL_DESC.x,
        y,
        w: COL_DESC.w,
        font: titleFont,
        size: 9.6,
      });
      const noteH = item.note
        ? measure(item.note, { x: COL_DESC.x, y, w: COL_DESC.w, size: 8.8 })
        : 0;
      const rowH = 3.2 + Math.max(titleH + noteH, 4) + 3.2;
      ensure(rowH);
      const ty = y + 3.2; // CSS padding-top on td
      let dy = ty;
      dy = stack(
        dy,
        text(item.label, {
          x: COL_DESC.x,
          y: dy,
          w: COL_DESC.w,
          font: titleFont,
          size: 9.6,
        }),
      );
      if (item.note)
        text(item.note, { x: COL_DESC.x, y: dy, w: COL_DESC.w, size: 8.8, color: MUTED });
      for (const [value, col, bold] of [
        [item.quantity, COL_QTY, false],
        [item.unitPrice, COL_UNIT, false],
        [item.lineTotal, COL_AMT, item.isPackage ?? false],
      ] as Array<[string, { x: number; w: number }, boolean]>) {
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

    // Totals — 78 mm block flush right.
    const SUM_X = R - 78;
    const SUM_W = 78;
    const sumRows: Array<[string, string]> = [];
    if (data.tax && data.taxRateLabel) {
      sumRows.push(['Zwischensumme (netto)', data.subtotal]);
      sumRows.push([`zzgl. USt. (${data.taxRateLabel})`, data.tax]);
    }
    // Keep the totals + payment terms together on one page.
    ensure(6 + sumRows.length * 13.5 + 30, false);
    y += 6; // CSS margin-top on .sums
    sumRows.forEach(([label, value], i) => {
      if (i > 0) rule(SUM_X, y, R, 0.25, RULE);
      y += 1.9; // CSS padding-top
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
      y = stack(y, h) + 1.9; // CSS padding-bottom
    });

    y += 2; // CSS margin-top on .total
    rule(SUM_X, y, R, 1.6, accent);
    y += 2.6; // CSS padding-top
    // Baseline-align the 10.5 pt label with the 15 pt amount by matching the
    // bottom of their line boxes (same family → visually identical baselines).
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

    // Payment terms, with the accent bar on the left.
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
    y += 9; // CSS margin-top on .pay

    // Closing group: payment terms → §35a block → remark → thank-you. Measured
    // up front and moved to the next page as a whole, so the yellow bar, the
    // deductible-labour sentence and the closing line never get torn apart.
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
      if (i > 0) y += 1.1; // CSS margin between paragraphs
      y = stack(y, textRuns(runs, { x: PAY_X, y, w: PAY_W, size: 9.6 }));
    });
    doc
      .rect(mm(L), mm(payTop), 1.6, mm(y - payTop))
      .fillColor(PAY_BAR)
      .fill();

    // §35a EStG: the labour share the customer may deduct. Printed verbatim as
    // stored on the invoice, in body ink — the customer forwards it to their
    // tax office, so it must not read as a footnote.
    if (data.craftsmanNote) {
      y += 6;
      ensure(craftH - 6, false);
      y = stack(y, text(data.craftsmanNote, { x: L, y, w: CONTENT_W, size: 9 }));
    }

    // Case-by-case remark for this one invoice.
    if (data.notes) {
      y += 4;
      ensure(notesH - 4, false);
      y = stack(y, text(data.notes, { x: L, y, w: CONTENT_W, size: 8.8, color: MUTED }));
    }

    y += 6; // CSS margin-top on .thx
    ensure(thxH - 6, false);
    text(INVOICE_THANK_YOU, {
      x: L,
      y,
      w: CONTENT_W,
      font: 'headMed',
      size: 10,
    });

    drawFooter();

    // "Seite n von m" — only meaningful once the invoice spills over one page.
    if (pageNo > 1) {
      const range = doc.bufferedPageRange();
      for (let i = 0; i < range.count; i += 1) {
        doc.switchToPage(range.start + i);
        text(`Seite ${i + 1} von ${range.count}`, {
          x: L,
          y: FOOTER_TOP - 5,
          w: CONTENT_W,
          size: 7,
          color: MUTED,
          align: 'right',
        });
      }
    }

    doc.end();
  });
}
