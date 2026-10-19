/**
 * Eingangsbestätigung: confirms we have the customer's carpets (`pickup` or `drop_off`), sent before
 * the work; the invoice comes after. Edits overwrite the order's positions (the invoice is built from
 * them); every sent version is frozen in `orders.metadata.receipt.history`.
 * Pure (no DB/I-O) so the money maths is unit-tested. State is JSONB, so no tenant DDL.
 */
import { z } from 'zod';

import { formatEurFromCents, formatSqm } from '../../lib/pricing.js';

export const RECEIPT_MAX_PHOTOS_PER_ITEM = 6;
export const RECEIPT_MAX_PHOTOS = 24;

/** Sending from these statuses moves the order to `picked_up` (paid → accepted first). */
const ADVANCE_FROM: readonly string[] = ['paid', 'accepted'];
/** Carpets already with us: sending again is a corrected version. */
const RESEND_IN: readonly string[] = ['picked_up', 'in_cleaning', 'ready'];

export type ReceiptStatusAction = 'advance' | 'resend';

/** What a send does to the order; null when no receipt applies (on-site job, unpaid/delivered/dead order). */
export function receiptStatusAction(order: {
  status: string;
  pickupMode: string;
}): ReceiptStatusAction | null {
  if (order.pickupMode === 'onsite') return null;
  if (ADVANCE_FROM.includes(order.status)) return 'advance';
  if (RESEND_IN.includes(order.status)) return 'resend';
  return null;
}

const slotRegex = /^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/;

const photoSchema = z.object({
  key: z.string().min(1).max(500),
  name: z.string().max(200).optional(),
  contentType: z.string().max(80).optional(),
  size: z.number().int().nonnegative().optional(),
});
export type ReceiptPhoto = z.infer<typeof photoSchema>;

const addonSchema = z.object({
  code: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(200),
  unitPriceCents: z.number().int().min(0).max(100_000_000),
});

const itemSchema = z.object({
  code: z.string().min(1).max(64),
  label: z.string().trim().min(1).max(200),
  /** Ignored when both dimensions are given — the area is computed from them. */
  quantity: z.number().positive().max(100_000),
  quantityLabel: z.string().trim().max(80).optional(),
  unitPriceCents: z.number().int().min(0).max(100_000_000),
  lengthCm: z.number().min(1).max(5000).optional(),
  widthCm: z.number().min(1).max(5000).optional(),
  tagNumber: z.string().trim().max(40).optional(),
  condition: z.string().trim().max(1000).optional(),
  photos: z.array(photoSchema).max(RECEIPT_MAX_PHOTOS_PER_ITEM).default([]),
  addons: z.array(addonSchema).max(5).default([]),
});

export const receiptDraftSchema = z
  .object({
    handover: z.enum(['pickup', 'drop_off']),
    /** Berlin wall clock. */
    receivedAt: z.string().regex(slotRegex, 'receivedAt must be YYYY-MM-DDTHH:mm'),
    pickupFeeCents: z.number().int().min(0).max(10_000_000),
    note: z.string().trim().max(2000).optional(),
    items: z.array(itemSchema).min(1).max(30),
  })
  .superRefine((d, ctx) => {
    const photos = d.items.reduce((n, it) => n + it.photos.length, 0);
    if (photos > RECEIPT_MAX_PHOTOS) {
      ctx.addIssue({
        code: z.ZodIssueCode.custom,
        message: `Höchstens ${RECEIPT_MAX_PHOTOS} Fotos pro Eingangsbestätigung.`,
        path: ['items'],
      });
    }
  });

export type ReceiptDraft = z.infer<typeof receiptDraftSchema>;
export type ReceiptDraftItem = ReceiptDraft['items'][number];

/** One frozen send, so a later correction never rewrites what the customer got. */
export interface ReceiptSentRecord {
  sentAt: string;
  sentByUserId: string;
  sentByName: string | null;
  emailMessageId: string | null;
  totalCents: number;
  statusAction: ReceiptStatusAction;
  draft: ReceiptDraft;
}

export interface ReceiptMeta {
  handover: ReceiptDraft['handover'];
  receivedAt: string;
  note: string | null;
  /** Amount paid when the receipt first changed the total; captured once, as `totalCents` no longer shows it. */
  paidCents?: number;
  savedAt: string;
  savedByUserId: string;
  history: ReceiptSentRecord[];
}

export function readReceiptMeta(metadata: unknown): ReceiptMeta | null {
  if (!metadata || typeof metadata !== 'object') return null;
  const r = (metadata as { receipt?: unknown }).receipt;
  if (!r || typeof r !== 'object') return null;
  const meta = r as Partial<ReceiptMeta>;
  return {
    handover: meta.handover === 'pickup' ? 'pickup' : 'drop_off',
    receivedAt: typeof meta.receivedAt === 'string' ? meta.receivedAt : '',
    note: typeof meta.note === 'string' ? meta.note : null,
    ...(typeof meta.paidCents === 'number' ? { paidCents: meta.paidCents } : {}),
    savedAt: typeof meta.savedAt === 'string' ? meta.savedAt : '',
    savedByUserId: typeof meta.savedByUserId === 'string' ? meta.savedByUserId : '',
    history: Array.isArray(meta.history) ? meta.history : [],
  };
}

export function receiptPaidCents(
  order: { paidAt: Date | string | null; totalCents: number },
  meta: ReceiptMeta | null,
): number {
  if (!order.paidAt) return 0;
  return meta?.paidCents ?? order.totalCents;
}

function isAddonLine(code: string, metadata: Record<string, unknown> | null | undefined): boolean {
  return code.startsWith('addon.') || metadata?.addon === true;
}

const num = (v: unknown): number | undefined =>
  typeof v === 'number' && Number.isFinite(v) && v > 0 ? v : undefined;
const str = (v: unknown): string | undefined =>
  typeof v === 'string' && v.trim() ? v.trim() : undefined;

function photosOf(v: unknown): ReceiptPhoto[] {
  if (!Array.isArray(v)) return [];
  return v
    .filter(
      (p: unknown): p is ReceiptPhoto =>
        !!p && typeof p === 'object' && typeof (p as { key?: unknown }).key === 'string',
    )
    .map((p) => ({
      key: p.key,
      ...(typeof p.name === 'string' ? { name: p.name } : {}),
      ...(typeof p.contentType === 'string' ? { contentType: p.contentType } : {}),
      ...(typeof p.size === 'number' ? { size: p.size } : {}),
    }));
}

/**
 * An `addon.*` line folds into the preceding carpet only when the areas agree: folding makes the
 * extra follow the carpet's measured size on save.
 */
export function groupOrderItems(
  items: Array<{
    code: string;
    label: string;
    quantityLabel: string;
    quantity: string | number;
    unitPriceCents: number;
    metadata: Record<string, unknown> | null;
  }>,
): ReceiptDraftItem[] {
  const out: ReceiptDraftItem[] = [];
  for (const it of items) {
    const meta = it.metadata ?? {};
    const quantity = Number(it.quantity);
    const prev = out[out.length - 1];
    if (isAddonLine(it.code, meta) && prev && prev.quantity === quantity) {
      prev.addons.push({ code: it.code, label: it.label, unitPriceCents: it.unitPriceCents });
      continue;
    }
    const lengthCm = num(meta.lengthCm);
    const widthCm = num(meta.widthCm);
    out.push({
      code: it.code,
      label: it.label,
      quantity,
      quantityLabel: it.quantityLabel,
      unitPriceCents: it.unitPriceCents,
      ...(lengthCm && widthCm ? { lengthCm, widthCm } : {}),
      ...(str(meta.tagNumber) ? { tagNumber: str(meta.tagNumber) } : {}),
      ...(str(meta.condition) ? { condition: str(meta.condition) } : {}),
      photos: photosOf(meta.photos),
      addons: [],
    });
  }
  return out;
}

/** cm × cm → m², 2 decimals, min 0.01. */
export function areaSqm(lengthCm: number, widthCm: number): number {
  return Math.max(0.01, Math.round((lengthCm * widthCm) / 100) / 100);
}

function formatQuantity(q: number): string {
  return q.toLocaleString('de-DE', { maximumFractionDigits: 2 });
}

export interface ReceiptLine {
  code: string;
  label: string;
  quantityLabel: string;
  quantity: number;
  unitPriceCents: number;
  subtotalCents: number;
  metadata: Record<string, unknown>;
}

export interface ReceiptGroup {
  item: ReceiptDraftItem;
  main: ReceiptLine;
  addons: ReceiptLine[];
}

/** Dimensions win over a typed quantity (measured pieces are priced by area); extras take the piece's area. */
export function buildReceiptLines(draft: ReceiptDraft): {
  lines: ReceiptLine[];
  groups: ReceiptGroup[];
} {
  const lines: ReceiptLine[] = [];
  const groups: ReceiptGroup[] = [];
  for (const it of draft.items) {
    const measured = it.lengthCm != null && it.widthCm != null;
    const quantity = measured ? areaSqm(it.lengthCm!, it.widthCm!) : it.quantity;
    const quantityLabel = measured
      ? `${formatSqm(quantity)} m²`
      : it.quantityLabel?.trim() || formatQuantity(quantity);
    const metadata: Record<string, unknown> = {};
    if (measured) {
      metadata.lengthCm = it.lengthCm;
      metadata.widthCm = it.widthCm;
    }
    if (it.tagNumber) metadata.tagNumber = it.tagNumber;
    if (it.condition) metadata.condition = it.condition;
    if (it.photos.length) metadata.photos = it.photos;
    const main: ReceiptLine = {
      code: it.code,
      label: it.label,
      quantityLabel,
      quantity,
      unitPriceCents: it.unitPriceCents,
      subtotalCents: Math.round(quantity * it.unitPriceCents),
      metadata,
    };
    const addons = it.addons.map<ReceiptLine>((a) => ({
      code: a.code,
      label: a.label,
      quantityLabel,
      quantity,
      unitPriceCents: a.unitPriceCents,
      subtotalCents: Math.round(quantity * a.unitPriceCents),
      metadata: { addon: true },
    }));
    lines.push(main, ...addons);
    groups.push({ item: it, main, addons });
  }
  return { lines, groups };
}

export interface ReceiptTotals {
  itemsCents: number;
  pickupFeeCents: number;
  minOrderTopUpCents: number;
  discountCents: number;
  totalCents: number;
  paidCents: number;
  /** total − paid: > 0 owed, < 0 in the customer's favour; 0 when unpaid. */
  balanceCents: number;
}

/**
 * Same arithmetic as checkout: min-order top-up on the gross before the voucher, voucher last,
 * so an unchanged re-save keeps the charged total.
 */
export function computeReceiptTotals(
  lines: ReceiptLine[],
  opts: { pickupFeeCents: number; discountCents: number; minOrderCents: number; paidCents: number },
): ReceiptTotals {
  const itemsCents = lines.reduce((a, l) => a + l.subtotalCents, 0);
  const grossBeforeMin = itemsCents + opts.pickupFeeCents;
  const minOrderTopUpCents =
    grossBeforeMin < opts.minOrderCents ? opts.minOrderCents - grossBeforeMin : 0;
  const totalCents = Math.max(0, grossBeforeMin + minOrderTopUpCents - opts.discountCents);
  return {
    itemsCents,
    pickupFeeCents: opts.pickupFeeCents,
    minOrderTopUpCents,
    discountCents: opts.discountCents,
    totalCents,
    paidCents: opts.paidCents,
    balanceCents: opts.paidCents > 0 ? totalCents - opts.paidCents : 0,
  };
}

export interface ReceiptViewPosition {
  pos: number;
  label: string;
  details: string[];
  condition: string | null;
  quantityLabel: string;
  unitPrice: string;
  lineTotal: string;
  addons: Array<{ label: string; quantityLabel: string; unitPrice: string; lineTotal: string }>;
  photos: ReceiptPhoto[];
}

export interface ReceiptView {
  orderNumber: string;
  handover: ReceiptDraft['handover'];
  handoverLabel: string;
  receivedDate: string;
  receivedTime: string;
  /** One sentence, no greeting. */
  confirmation: string;
  isUpdate: boolean;
  positions: ReceiptViewPosition[];
  summary: Array<{ label: string; value: string }>;
  totalLabel: string;
  total: string;
  payment: Array<{ label: string; value: string; emphasis: boolean }>;
  note: string | null;
  photoCount: number;
  invoiceFollows: boolean;
}

function slotParts(slot: string): { date: string; time: string } {
  const m = /^(\d{4})-(\d{2})-(\d{2})T(\d{2}:\d{2})$/.exec(slot);
  if (!m) return { date: slot, time: '' };
  return { date: `${m[3]}.${m[2]}.${m[1]}`, time: m[4]! };
}

export const HANDOVER_LABEL: Record<ReceiptDraft['handover'], string> = {
  pickup: 'Abholung bei Ihnen',
  drop_off: 'Abgabe in der Werkstatt',
};

export function buildReceiptView(input: {
  order: { orderNumber: string; voucherCode: string | null };
  draft: ReceiptDraft;
  groups: ReceiptGroup[];
  totals: ReceiptTotals;
  isUpdate: boolean;
  invoiceFollows: boolean;
}): ReceiptView {
  const { draft, groups, totals } = input;
  const { date, time } = slotParts(draft.receivedAt);
  const piece = groups.length === 1 ? 'Ihren Teppich' : 'Ihre Teppiche';
  const when = time ? `am ${date} um ${time} Uhr` : `am ${date}`;
  const confirmation =
    draft.handover === 'pickup'
      ? `Hiermit bestätigen wir, dass wir ${piece} ${when} bei Ihnen abgeholt haben.`
      : `Hiermit bestätigen wir, dass Sie uns ${piece} ${when} in unserer Werkstatt übergeben haben.`;

  const positions = groups.map<ReceiptViewPosition>((g, i) => {
    const details: string[] = [];
    if (g.item.lengthCm != null && g.item.widthCm != null)
      details.push(
        `Maße: ${formatQuantity(g.item.lengthCm)} × ${formatQuantity(g.item.widthCm)} cm`,
      );
    if (g.item.tagNumber) details.push(`Etikett-Nr.: ${g.item.tagNumber}`);
    return {
      pos: i + 1,
      label: g.main.label,
      details,
      condition: g.item.condition ?? null,
      quantityLabel: g.main.quantityLabel,
      unitPrice: formatEurFromCents(g.main.unitPriceCents),
      lineTotal: formatEurFromCents(g.main.subtotalCents),
      addons: g.addons.map((a) => ({
        label: a.label,
        quantityLabel: a.quantityLabel,
        unitPrice: formatEurFromCents(a.unitPriceCents),
        lineTotal: formatEurFromCents(a.subtotalCents),
      })),
      photos: g.item.photos,
    };
  });

  const summary: ReceiptView['summary'] = [
    { label: 'Summe Positionen', value: formatEurFromCents(totals.itemsCents) },
  ];
  if (totals.pickupFeeCents > 0)
    summary.push({ label: 'Abholung', value: formatEurFromCents(totals.pickupFeeCents) });
  if (totals.minOrderTopUpCents > 0)
    summary.push({
      label: 'Mindestbestellwert-Aufschlag',
      value: formatEurFromCents(totals.minOrderTopUpCents),
    });
  if (totals.discountCents > 0)
    summary.push({
      label: input.order.voucherCode ? `Rabatt (${input.order.voucherCode})` : 'Rabatt',
      value: `−${formatEurFromCents(totals.discountCents)}`,
    });

  const payment: ReceiptView['payment'] = [];
  if (totals.paidCents > 0) {
    payment.push({
      label: 'Bereits bezahlt',
      value: formatEurFromCents(totals.paidCents),
      emphasis: false,
    });
    if (totals.balanceCents > 0)
      payment.push({
        label: 'Offener Betrag',
        value: formatEurFromCents(totals.balanceCents),
        emphasis: true,
      });
    else if (totals.balanceCents < 0)
      payment.push({
        label: 'Differenz zu Ihren Gunsten',
        value: formatEurFromCents(-totals.balanceCents),
        emphasis: true,
      });
  }

  return {
    orderNumber: input.order.orderNumber,
    handover: draft.handover,
    handoverLabel: HANDOVER_LABEL[draft.handover],
    receivedDate: date,
    receivedTime: time,
    confirmation,
    isUpdate: input.isUpdate,
    positions,
    summary,
    totalLabel: 'Gesamtbetrag (inkl. 19 % MwSt.)',
    total: formatEurFromCents(totals.totalCents),
    payment,
    note: draft.note?.trim() || null,
    photoCount: draft.items.reduce((n, it) => n + it.photos.length, 0),
    invoiceFollows: input.invoiceFollows,
  };
}

export function receiptPdfFilename(orderNumber: string, customerName: string): string {
  const namePart = customerName
    .trim()
    .replace(/[äÄ]/g, 'ae')
    .replace(/[öÖ]/g, 'oe')
    .replace(/[üÜ]/g, 'ue')
    .replace(/ß/g, 'ss')
    .replace(/[^A-Za-z0-9]+/g, '-')
    .replace(/^-+|-+$/g, '')
    .slice(0, 60)
    .replace(/-+$/g, '');
  const base = [orderNumber.replace(/\//g, '-'), 'Eingangsbestaetigung', namePart]
    .filter(Boolean)
    .join('-');
  return `${base.replace(/[^\w.-]+/g, '_')}.pdf`;
}
