/**
 * Eingangsbestätigung endpoints under /admin/orders (see ./receipt.ts).
 * Preview writes nothing; send also moves the order to `picked_up`.
 */
import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';

import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { company, user } from '../../db/schema/shared.js';
import { brandInfoFromCompany, brandSender, sendEmail } from '../../email/service.js';
import { orderReceiptEmail, type RenderedEmail } from '../../email/templates.js';
import { badRequest, conflict, notFound, parseIntId } from '../../lib/http-errors.js';
import { fetchInvoiceLogo } from '../../lib/pdf-letterhead.js';
import { getPriceBook } from '../../lib/price-books/index.js';
import { formatEurFromCents } from '../../lib/pricing.js';
import { getObjectBuffer } from '../../lib/s3.js';
import { letterheadFromCompany } from '../invoices/send-invoice.js';
import { utcToBerlinSlot } from './calendly-pickup.js';
import { renderReceiptPdf } from './receipt-pdf.js';
import {
  buildReceiptLines,
  buildReceiptView,
  computeReceiptTotals,
  groupOrderItems,
  readReceiptMeta,
  receiptDraftSchema,
  receiptPaidCents,
  receiptPdfFilename,
  receiptStatusAction,
  type ReceiptDraft,
  type ReceiptMeta,
  type ReceiptSentRecord,
  type ReceiptStatusAction,
  type ReceiptTotals,
  type ReceiptView,
} from './receipt.js';
import { commissionPatch, orderNumberOf } from './routes.js';

type CompanyFull = typeof company.$inferSelect;

const draftBodySchema = z.object({ draft: receiptDraftSchema });

/** Invoices already a legal document: the order's money is frozen. */
const LOCKING_INVOICE_STATUSES = new Set(['sent', 'paid', 'overdue']);

async function loadContext(request: FastifyRequest, id: number) {
  const { orders, orderItems, invoices } = request.company!.tables;
  const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
  if (!order) throw notFound('Order not found');
  const items = await db
    .select()
    .from(orderItems)
    .where(eq(orderItems.orderId, id))
    .orderBy(asc(orderItems.id));
  const [invoice] = await db
    .select({ id: invoices.id, status: invoices.status, number: invoices.number })
    .from(invoices)
    .where(eq(invoices.orderId, id))
    .limit(1);
  return {
    order: { ...order, orderNumber: orderNumberOf(order) },
    items,
    invoice: invoice ?? null,
    meta: readReceiptMeta(order.metadata),
  };
}
type Ctx = Awaited<ReturnType<typeof loadContext>>;

function requireAction(ctx: Ctx): ReceiptStatusAction {
  const action = receiptStatusAction(ctx.order);
  if (action) return action;
  if (ctx.order.pickupMode === 'onsite')
    throw conflict('Vor-Ort-Aufträge haben keine Eingangsbestätigung.');
  throw conflict(`Im Status „${ctx.order.status}“ ist keine Eingangsbestätigung möglich.`);
}

/** Brand minimum order as checkout applies it; manual orders get none (priced by a person). */
function minOrderCentsFor(order: Ctx['order'], slug: string): number {
  if (order.source === 'manual_admin') return 0;
  const book = getPriceBook(slug);
  if (order.kind === 'teppichreinigung') return book?.carpetCleaning?.minOrderCents ?? 0;
  if (order.kind === 'polsterreinigung') return book?.upholstery?.minOrderCents ?? 0;
  return 0;
}

function dropOffLabelFor(kind: string, slug: string): string {
  const book = getPriceBook(slug);
  const label =
    kind === 'teppichreparatur'
      ? book?.carpetRepair?.dropOffLabel
      : book?.carpetCleaning?.dropOffLabel;
  return label ?? 'Abgabe in der Werkstatt';
}

function initialDraft(ctx: Ctx): ReceiptDraft {
  return {
    handover: ctx.meta?.handover ?? (ctx.order.pickupMode === 'pickup' ? 'pickup' : 'drop_off'),
    receivedAt:
      ctx.meta?.receivedAt || utcToBerlinSlot(new Date().toISOString()) || '1970-01-01T00:00',
    pickupFeeCents: ctx.order.pickupFeeCents,
    ...(ctx.meta?.note ? { note: ctx.meta.note } : {}),
    items: groupOrderItems(ctx.items),
  };
}

interface Computed {
  lines: ReturnType<typeof buildReceiptLines>['lines'];
  totals: ReceiptTotals;
  view: ReceiptView;
  moneyChanged: boolean;
}

function compute(request: FastifyRequest, ctx: Ctx, draft: ReceiptDraft): Computed {
  // Photos go into a PDF that leaves the building: only this tenant's uploads (key prefix).
  const prefix = `${request.company!.keyPrefix}/`;
  for (const it of draft.items) {
    for (const p of it.photos) {
      if (!p.key.startsWith(prefix)) throw badRequest('Foto gehört nicht zu diesem Unternehmen.');
    }
  }
  const { lines, groups } = buildReceiptLines(draft);
  const totals = computeReceiptTotals(lines, {
    pickupFeeCents: draft.pickupFeeCents,
    discountCents: ctx.order.discountCents,
    minOrderCents: minOrderCentsFor(ctx.order, request.company!.slug),
    paidCents: receiptPaidCents(ctx.order, ctx.meta),
  });
  const view = buildReceiptView({
    order: { orderNumber: ctx.order.orderNumber, voucherCode: ctx.order.voucherCode },
    draft,
    groups,
    totals,
    isUpdate: (ctx.meta?.history.length ?? 0) > 0,
    invoiceFollows: !ctx.invoice || !LOCKING_INVOICE_STATUSES.has(ctx.invoice.status),
  });
  return { lines, totals, view, moneyChanged: totals.totalCents !== ctx.order.totalCents };
}

/** Why the money is locked, or null; details/photos stay editable. */
function moneyLockReason(ctx: Ctx): string | null {
  if (ctx.order.payoutStatus === 'paid')
    return 'Der Partner wurde bereits ausgezahlt — der Auftragsbetrag kann nicht mehr geändert werden.';
  if (ctx.invoice && LOCKING_INVOICE_STATUSES.has(ctx.invoice.status))
    return `Zu diesem Auftrag ist die Rechnung${ctx.invoice.number ? ` ${ctx.invoice.number}` : ''} bereits gestellt — der Betrag kann nicht mehr geändert werden. Maße, Etikett, Zustand und Fotos lassen sich weiterhin speichern.`;
  return null;
}

async function loadCompany(slug: string): Promise<CompanyFull> {
  const [row] = await db.select().from(company).where(eq(company.slug, slug)).limit(1);
  if (!row) throw notFound('Company not found');
  return row;
}

function trackerUrlFor(companyRow: CompanyFull, publicToken: string): string {
  const base = (companyRow.storefrontOrigin ?? env.APP_BASE_URL).replace(/\/$/, '');
  return `${base}/bestellung?token=${encodeURIComponent(publicToken)}`;
}

async function renderDocuments(
  request: FastifyRequest,
  companyRow: CompanyFull,
  ctx: Ctx,
  draft: ReceiptDraft,
  view: ReceiptView,
): Promise<{ email: RenderedEmail; pdf: Buffer; filename: string }> {
  const keyPrefix = request.company!.keyPrefix;
  const keys = [...new Set(draft.items.flatMap((it) => it.photos.map((p) => p.key)))];
  const photos = new Map<string, Buffer>();
  await Promise.all(
    keys.map(async (key) => {
      const obj = await getObjectBuffer({ keyPrefix, key });
      // pdfkit embeds JPEG/PNG only; the dashboard converts photos to JPEG on upload.
      if (obj && /^image\/(jpe?g|png)$/i.test(obj.contentType ?? 'image/jpeg'))
        photos.set(key, obj.body);
    }),
  );
  const logoSrc = companyRow.invoiceLogoUrl ?? companyRow.logoUrl;
  const o = ctx.order;
  const pdf = await renderReceiptPdf({
    brandName: companyRow.name,
    logo: await fetchInvoiceLogo(logoSrc),
    ...letterheadFromCompany(companyRow),
    recipientName: o.customerName,
    recipientAddressLines: [
      o.addressLine1,
      o.addressLine2,
      [o.addressPostalCode, o.addressCity].filter(Boolean).join(' ') || null,
    ].filter((x): x is string => Boolean(x)),
    view,
    photos,
  });
  const email = orderReceiptEmail({
    ...view,
    brand: { ...brandInfoFromCompany(companyRow), logoUrl: companyRow.logoUrl },
    customerName: o.customerName,
    trackerUrl: trackerUrlFor(companyRow, o.publicToken),
  });
  return { email, pdf, filename: receiptPdfFilename(o.orderNumber, o.customerName) };
}

/** Writes the draft onto the order; status-CAS so a concurrent transition isn't overwritten. */
async function saveDraft(
  request: FastifyRequest,
  ctx: Ctx,
  draft: ReceiptDraft,
  computed: Computed,
): Promise<Ctx['order']> {
  const { orders, orderItems, orderStatusLog } = request.company!.tables;
  const adminId = request.authUser!.id;
  const order = ctx.order;
  const { totals, lines, moneyChanged } = computed;

  if (moneyChanged) {
    const lock = moneyLockReason(ctx);
    if (lock) throw conflict(lock);
  }
  const commission = moneyChanged
    ? await commissionPatch(request.company!.tables, order, totals.totalCents)
    : {};

  const now = new Date();
  const handoverChanged = draft.handover !== order.pickupMode;
  const pickupLabel = handoverChanged
    ? draft.handover === 'drop_off'
      ? dropOffLabelFor(order.kind, request.company!.slug)
      : 'Abholung'
    : order.pickupLabel;
  const nextMeta: ReceiptMeta = {
    handover: draft.handover,
    receivedAt: draft.receivedAt,
    note: draft.note?.trim() || null,
    ...(order.paidAt ? { paidCents: totals.paidCents } : {}),
    savedAt: now.toISOString(),
    savedByUserId: adminId,
    history: ctx.meta?.history ?? [],
  };
  const deltaCents = totals.totalCents - order.totalCents;

  const updated = await db.transaction(async (tx) => {
    const [u] = await tx
      .update(orders)
      .set({
        subtotalCents: totals.itemsCents,
        pickupFeeCents: totals.pickupFeeCents,
        minOrderTopUpCents: totals.minOrderTopUpCents,
        totalCents: totals.totalCents,
        pickupMode: draft.handover,
        pickupLabel,
        ...commission,
        metadata: { ...(order.metadata ?? {}), receipt: nextMeta },
        updatedAt: now,
      })
      .where(and(eq(orders.id, order.id), eq(orders.status, order.status)))
      .returning();
    if (!u) return null;
    await tx.delete(orderItems).where(eq(orderItems.orderId, order.id));
    await tx.insert(orderItems).values(
      lines.map((l) => ({
        orderId: order.id,
        code: l.code,
        label: l.label,
        quantityLabel: l.quantityLabel,
        quantity: l.quantity.toFixed(2),
        unitPriceCents: l.unitPriceCents,
        subtotalCents: l.subtotalCents,
        metadata: l.metadata,
      })),
    );
    if (moneyChanged) {
      await tx.insert(orderStatusLog).values({
        orderId: order.id,
        fromStatus: order.status,
        toStatus: order.status,
        changedByUserId: adminId,
        reason: `Korrektur (${deltaCents >= 0 ? '+' : ''}${formatEurFromCents(deltaCents)}) · Eingangsbestätigung`,
      });
    }
    return u;
  });
  if (!updated) throw conflict('Auftrag wurde zwischenzeitlich geändert — bitte neu laden.');
  return { ...updated, orderNumber: orderNumberOf(updated) };
}

function saveResult(ctx: Ctx, computed: Computed) {
  return {
    totals: computed.totals,
    deltaCents: computed.totals.totalCents - ctx.order.totalCents,
    // A draft invoice was built from the old positions.
    invoiceDraftStale: computed.moneyChanged && ctx.invoice?.status === 'draft',
  };
}

export const orderReceiptRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  // Save/send rewrite positions and mail the customer: manager+. GET stays open for viewers.
  app.addHook('preHandler', app.requireWriteAccess);

  app.get('/:id/receipt', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const ctx = await loadContext(request, id);
    return {
      draft: initialDraft(ctx),
      statusAction: receiptStatusAction(ctx.order),
      paidCents: receiptPaidCents(ctx.order, ctx.meta),
      minOrderCents: minOrderCentsFor(ctx.order, request.company!.slug),
      discountCents: ctx.order.discountCents,
      voucherCode: ctx.order.voucherCode,
      moneyLockReason: moneyLockReason(ctx),
      invoice: ctx.invoice,
      savedAt: ctx.meta?.savedAt || null,
      history: (ctx.meta?.history ?? []).map((h) => ({
        sentAt: h.sentAt,
        sentByName: h.sentByName,
        totalCents: h.totalCents,
        statusAction: h.statusAction,
      })),
    };
  });

  app.post('/:id/receipt/preview', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { draft } = draftBodySchema.parse(request.body);
    const ctx = await loadContext(request, id);
    const action = requireAction(ctx);
    const computed = compute(request, ctx, draft);
    const companyRow = await loadCompany(request.company!.slug);
    const docs = await renderDocuments(request, companyRow, ctx, draft, computed.view);
    return {
      to: ctx.order.customerEmail,
      subject: docs.email.subject,
      html: docs.email.html,
      pdfBase64: docs.pdf.toString('base64'),
      filename: docs.filename,
      statusAction: action,
      moneyLockReason: computed.moneyChanged ? moneyLockReason(ctx) : null,
      ...saveResult(ctx, computed),
    };
  });

  app.post('/:id/receipt', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { draft } = draftBodySchema.parse(request.body);
    const ctx = await loadContext(request, id);
    requireAction(ctx);
    const computed = compute(request, ctx, draft);
    const order = await saveDraft(request, ctx, draft, computed);
    return { order, ...saveResult(ctx, computed) };
  });

  app.post('/:id/receipt/send', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { draft } = draftBodySchema.parse(request.body);
    const adminId = request.authUser!.id;
    const { orders, orderStatusLog } = request.company!.tables;

    const ctx = await loadContext(request, id);
    const action = requireAction(ctx);
    const computed = compute(request, ctx, draft);
    const companyRow = await loadCompany(request.company!.slug);
    // Render before writing: a broken document must not leave a half-done send.
    const docs = await renderDocuments(request, companyRow, ctx, draft, computed.view);
    const saved = await saveDraft(request, ctx, draft, computed);

    const result = await sendEmail({
      to: saved.customerEmail,
      from: brandSender(companyRow),
      log: {
        companySlug: companyRow.slug,
        kind: 'receipt',
        refType: 'order',
        refId: id,
        sentByUserId: adminId,
      },
      apiKey: companyRow.resendApiKey ?? undefined,
      replyTo: companyRow.email ?? undefined,
      attachments: [{ filename: docs.filename, content: docs.pdf }],
      email: docs.email,
    });
    if (!result.ok) {
      request.log.error({ orderId: id, error: result.error }, 'receipt email failed');
      reply.code(502).send({
        error:
          'E-Mail konnte nicht gesendet werden. Die Änderungen sind gespeichert — bitte erneut senden.',
      });
      return;
    }

    const [adminRow] = await db
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, adminId))
      .limit(1);
    const now = new Date();
    const record: ReceiptSentRecord = {
      sentAt: now.toISOString(),
      sentByUserId: adminId,
      sentByName: adminRow?.name ?? null,
      emailMessageId: result.id ?? (result.skipped ? 'skipped' : null),
      totalCents: computed.totals.totalCents,
      statusAction: action,
      draft,
    };
    const savedMeta = readReceiptMeta(saved.metadata)!;
    const metadata = {
      ...(saved.metadata ?? {}),
      receipt: { ...savedMeta, history: [...savedMeta.history, record] },
    };

    // Send = handover: paid → accepted → picked_up, each edge logged. No generic "abgeholt" mail:
    // the receipt is that mail.
    const steps =
      action === 'advance'
        ? saved.status === 'paid'
          ? ['accepted', 'picked_up']
          : ['picked_up']
        : [];
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(orders)
        .set({
          metadata,
          updatedAt: now,
          ...(steps.length
            ? {
                status: 'picked_up',
                pickedUpAt: now,
                handledByUserId: adminId,
                ...(steps.includes('accepted') ? { acceptedAt: now } : {}),
              }
            : {}),
        })
        .where(and(eq(orders.id, id), eq(orders.status, saved.status)))
        .returning();
      if (!u) return null;
      let from = saved.status;
      for (const to of steps) {
        await tx.insert(orderStatusLog).values({
          orderId: id,
          fromStatus: from,
          toStatus: to,
          changedByUserId: adminId,
          reason: to === 'picked_up' ? 'Eingangsbestätigung gesendet' : 'Mit Eingangsbestätigung',
        });
        from = to;
      }
      if (!steps.length) {
        await tx.insert(orderStatusLog).values({
          orderId: id,
          fromStatus: saved.status,
          toStatus: saved.status,
          changedByUserId: adminId,
          reason: 'Eingangsbestätigung erneut gesendet',
        });
      }
      return u;
    });

    if (!updated) {
      // Mail is out, only the status lost a race: keep the send record; operator sets the status.
      request.log.warn({ orderId: id }, 'receipt sent but status CAS lost — history kept');
      const [u] = await db
        .update(orders)
        .set({ metadata, updatedAt: now })
        .where(eq(orders.id, id))
        .returning();
      return {
        order: u ? { ...u, orderNumber: orderNumberOf(u) } : saved,
        emailed: !result.skipped,
        statusChanged: false,
        ...saveResult(ctx, computed),
      };
    }

    return {
      order: { ...updated, orderNumber: orderNumberOf(updated) },
      emailed: !result.skipped,
      statusChanged: steps.length > 0,
      ...saveResult(ctx, computed),
    };
  });
};
