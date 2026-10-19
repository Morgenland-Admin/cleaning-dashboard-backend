/**
 * Shared DIN 5008 Form B letterhead (fonts, fold/punch marks, logo + sender, address field, info block,
 * legal footer) for invoice and receipt PDFs; each document draws only its body. Positions in mm via `mm()`.
 */
import { readFileSync } from 'node:fs';

import PDFDocument from 'pdfkit';

/** Best-effort: undefined on any failure so a logo never blocks document generation; pdfkit only reads raster PNG/JPEG. */
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

function formatIbanPdf(iban: string): string {
  return iban
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/(.{4})/g, '$1 ')
    .trim();
}

export const INK = '#0A182D';
export const MUTED = '#5A6875';
export const RULE = '#DCE1E6';
const MARK = '#B8C0C8';
const ACCENT_FALLBACK = '#bd5b3e';

export const MM = 72 / 25.4;
export const mm = (v: number) => v * MM;
export const L = 25;
export const R = 190;
export const CONTENT_W = R - L;
const HEADER_TOP = 13.5;
const ADDR_TOP = 45;
const ADDR_W = 85;
const INFO_X = 125;
const INFO_W = R - INFO_X;
export const BODY_TOP = 100;
/**
 * Legal footer top. Deliberately above the DIN 5008 limit (272 mm): lower, the last line lands in
 * the printers' unprintable bottom strip and IBAN/BIC get cut off. Do not move down.
 */
export const FOOTER_TOP = 252;
const FOLD_1 = 105;
const FOLD_2 = 210;
const PUNCH = 148.5;
export const BODY_BOTTOM = FOOTER_TOP - 6;

// OFL fonts, vendored in src/assets/fonts.
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
export type FontKey = keyof typeof FONT_FILES;
/** Used when a TTF is missing or corrupt; layout stays intact. */
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
      // Missing font → the Helvetica fallback keeps documents renderable.
    }
  }
  fontCache = loaded;
  return loaded;
}

export interface TextOpts {
  x: number;
  y: number;
  /** Wrap width in mm; omit for a single unbreakable line. */
  w?: number;
  font?: FontKey;
  size: number;
  color?: string;
  align?: 'left' | 'center' | 'right';
  /** CSS line-height multiplier (default 1.45). */
  lh?: number;
  /** Letter spacing in em. */
  tracking?: number;
  upper?: boolean;
  tnum?: boolean;
}

export interface Run {
  text: string;
  font?: FontKey;
  color?: string;
}

export interface LetterheadSeller {
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
}

export interface LetterheadBank {
  accountHolder?: string | null;
  iban?: string | null;
  bic?: string | null;
  bankName?: string | null;
  bankAddress?: string | null;
}

export interface LetterDoc {
  doc: PDFKit.PDFDocument;
  done: Promise<Buffer>;
  accent: string;
  fontOf: (key: FontKey) => string;
  /** Horizontal hairline; `weight` in pt. */
  rule: (x1: number, y: number, x2: number, weight: number, color: string) => void;
  /** Draws a CSS-style line box (y = box top, glyphs centred via half-leading); returns the block height in mm. */
  text: (str: string, o: TextOpts) => number;
  measure: (str: string, o: TextOpts) => number;
  /** Differently-styled runs on one line; returns the height drawn (runs may wrap, one line would let the next element overlap). */
  textRuns: (runs: Run[], o: TextOpts) => number;
  stack: (y: number, h: number) => number;
}

export function createLetterDoc(accentColor: string): LetterDoc {
  const doc = new PDFDocument({ size: 'A4', margin: 0, bufferPages: true });
  const chunks: Buffer[] = [];
  const done = new Promise<Buffer>((resolve, reject) => {
    doc.on('data', (c: Buffer) => chunks.push(c));
    doc.on('end', () => resolve(Buffer.concat(chunks)));
    doc.on('error', reject);
  });

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

  const accent = /^#[0-9a-fA-F]{6}$/.test(accentColor) ? accentColor : ACCENT_FALLBACK;

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

  const text = (str: string, o: TextOpts): number => {
    const { gap, opts } = pdfOpts(o);
    const s = o.upper ? str.toUpperCase() : str;
    doc.fillColor(o.color ?? INK);
    const h = doc.heightOfString(s, opts);
    doc.text(s, mm(o.x), mm(o.y) + gap / 2, opts);
    return h / MM;
  };

  const measure = (str: string, o: TextOpts): number => {
    const { opts } = pdfOpts(o);
    return doc.heightOfString(o.upper ? str.toUpperCase() : str, opts) / MM;
  };

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

  const stack = (y: number, h: number) => y + h;

  return { doc, done, accent, fontOf, rule, text, measure, textRuns, stack };
}

export function drawLegalFooter(
  kit: LetterDoc,
  seller: LetterheadSeller,
  bank?: LetterheadBank,
): void {
  const { rule, text, textRuns, stack, accent } = kit;
  // Columns 1fr 1fr 1.15fr with 6 mm gaps.
  const unit = (CONTENT_W - 12) / 3.15;
  const cols = [
    { x: L, w: unit },
    { x: L + unit + 6, w: unit },
    { x: L + 2 * unit + 12, w: unit * 1.15 },
  ];
  rule(L, FOOTER_TOP, R, 0.25, RULE);
  const top = FOOTER_TOP + 3;

  const groups: Array<{ title: string; lines: Run[][] }> = [
    {
      title: 'Unternehmen',
      lines: [
        seller.legalForm
          ? [
              { text: 'Rechtsform: ', color: MUTED },
              { text: seller.legalForm, font: 'bodyMed', color: INK },
            ]
          : [],
        seller.managingDirectors
          ? [
              { text: 'Geschäftsführer: ', color: MUTED },
              { text: seller.managingDirectors, font: 'bodyMed', color: INK },
            ]
          : [],
        seller.chamber ? [{ text: seller.chamber, color: MUTED }] : [],
      ],
    },
    {
      // Steuernummer is deliberately absent — only the USt-IdNr. is shown.
      title: 'Steuer',
      lines: [
        seller.vatId
          ? [
              { text: 'USt-IdNr.: ', color: MUTED },
              { text: seller.vatId, font: 'bodyMed', color: INK },
            ]
          : [],
        seller.businessId
          ? [
              { text: 'Betriebsnummer: ', color: MUTED },
              { text: seller.businessId, font: 'bodyMed', color: INK },
            ]
          : [],
        seller.registrationNumber
          ? [
              { text: 'Reg-Nr.: ', color: MUTED },
              { text: seller.registrationNumber, font: 'bodyMed', color: INK },
            ]
          : [],
      ],
    },
    {
      title: 'Bankverbindung',
      lines: bank?.iban
        ? [
            bank.bankName
              ? [
                  { text: 'Bank: ', color: MUTED },
                  { text: bank.bankName, color: MUTED },
                ]
              : [],
            [
              { text: 'IBAN: ', color: MUTED },
              { text: formatIbanPdf(bank.iban), font: 'bodyMed', color: INK },
            ],
            bank.bic
              ? [
                  { text: 'BIC: ', color: MUTED },
                  { text: bank.bic, font: 'bodyMed', color: INK },
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
    y += 1.1;
    for (const line of lines) {
      y = stack(y, textRuns(line, { x: col.x, y, w: col.w, size: 7.2, lh: 1.5 }));
    }
  });
}

export interface LetterheadData {
  brandName: string;
  logo?: Buffer | null;
  /** Only for the text-logo fallback; raster logos carry their own claim. */
  claim?: string | null;
  seller: LetterheadSeller;
  recipientName: string;
  recipientCompany?: string | null;
  recipientAddressLines?: string[];
  infoTitle: string;
  /** [label, value, highlight] — highlighted values print in the accent colour. */
  infoRows: Array<[string, string, boolean]>;
}

export function drawLetterhead(kit: LetterDoc, data: LetterheadData): void {
  const { doc, rule, text, measure, textRuns, stack, accent } = kit;

  rule(0, FOLD_1, 5, 0.25, MARK);
  rule(0, FOLD_2, 5, 0.25, MARK);
  rule(0, PUNCH, 8, 0.4, MARK);

  // The raster logo carries the claim; a drawn tile + wordmark is only the fallback.
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
      // A long "web · mail" line wraps in the 65 mm block and pushes the lines below it down (pdfkit has no nowrap).
      textRuns(line, { x: INFO_X, y: sy, w: INFO_W, size: 7.9, align: 'right', color: MUTED }),
    );
  }

  // Address field: DIN lang window at 25 mm / 45 mm; no email address here.
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
  ay += 0.6;
  rule(L, ay, L + 80, 0.25, RULE);
  ay += 4.4;
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

  let iy = ADDR_TOP;
  iy = stack(
    iy,
    text(data.infoTitle, {
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
  for (const [label, value, highlight] of data.infoRows) {
    iy += 1.5;
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
      color: highlight ? accent : INK,
      tnum: true,
    });
    iy = stack(iy, h) + 1.5;
    rule(INFO_X, iy, R, 0.25, RULE);
  }
}

/** Stamps "Seite n von m" above the footer — only call when there is more than one page. */
export function stampPageNumbers(kit: LetterDoc): void {
  const range = kit.doc.bufferedPageRange();
  for (let i = 0; i < range.count; i += 1) {
    kit.doc.switchToPage(range.start + i);
    kit.text(`Seite ${i + 1} von ${range.count}`, {
      x: L,
      y: FOOTER_TOP - 5,
      w: CONTENT_W,
      size: 7,
      color: MUTED,
      align: 'right',
    });
  }
}
