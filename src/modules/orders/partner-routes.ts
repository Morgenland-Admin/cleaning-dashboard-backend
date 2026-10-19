import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  and,
  asc,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  lt,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';
import type { AnyPgColumn } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { taskComments } from '../../db/schema/shared.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { encodeCursor, keysetAfter } from '../../lib/cursor.js';
import { badRequest, conflict, notFound, parseIntId } from '../../lib/http-errors.js';
import {
  partnerKeyPrefix,
  s3Configured,
  signObjectDownload,
  signPartnerUpload,
} from '../../lib/s3.js';
import { spawnTask } from '../../lib/tasks.js';
import { requireActivePartner, requireOwnPartner } from '../partners/lib.js';
import {
  orderNumberOf,
  PARTNER_DONE_STATUSES,
  partnerNextStatus,
  statusTimestampColumn,
  type OrderStatus,
} from './lib.js';
import { notifyCustomerStatusChange } from './routes.js';

type OrderRow = TenantTables['orders']['$inferSelect'];

const MAX_PHOTOS = 30;
const EARNINGS_ROWS = 500;
const PHOTO_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/heic', 'image/heif']);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/);

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(50),
  cursor: z.string().min(1).max(500).optional(),
  scope: z.enum(['active', 'done']).optional(),
});
const transitionSchema = z.object({
  toStatus: z.enum(['accepted', 'picked_up', 'in_cleaning', 'ready', 'delivered']),
  reason: z.string().trim().max(500).optional(),
});
const earningsQuerySchema = z.object({ from: isoDate.optional(), to: isoDate.optional() });
const signSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1).max(80),
  size: z
    .number()
    .int()
    .positive()
    .max(15 * 1024 * 1024),
});
const attachPhotoSchema = z.object({
  key: z.string().min(1).max(500),
  name: z.string().min(1).max(200),
  size: z.number().int().positive(),
  contentType: z.string().max(80).optional(),
  stage: z.enum(['before', 'after', 'other']).default('other'),
});
const reportSchema = z.object({
  category: z.enum(['customer_unreachable', 'access_problem', 'damage', 'scope_differs', 'other']),
  message: z.string().trim().min(5).max(4000),
});

const REPORT_LABEL: Record<z.infer<typeof reportSchema>['category'], string> = {
  customer_unreachable: 'Kunde nicht erreichbar',
  access_problem: 'Kein Zugang',
  damage: 'Schaden',
  scope_differs: 'Umfang weicht ab',
  other: 'Sonstiges',
};

function slotList(value: unknown): string[] {
  return Array.isArray(value) ? value.filter((s): s is string => typeof s === 'string') : [];
}

/** Allowlist: never the customer's email, order token, payment/tracking ids or internal metadata. */
export function toPartnerOrderView(row: OrderRow) {
  const meta = row.metadata ?? {};
  return {
    id: row.id,
    orderNumber: orderNumberOf(row),
    kind: row.kind,
    status: row.status,
    currency: row.currency,
    subtotalCents: row.subtotalCents,
    pickupFeeCents: row.pickupFeeCents,
    discountCents: row.discountCents,
    totalCents: row.totalCents,
    assignedAt: row.assignedAt,
    commissionCents: row.commissionCents,
    partnerPayoutCents: row.partnerPayoutCents,
    payoutStatus: row.payoutStatus,
    payoutAt: row.payoutAt,
    pickupMode: row.pickupMode,
    pickupLabel: row.pickupLabel,
    preferredDate: row.preferredDate,
    preferredSlots: slotList(meta.preferredSlots),
    confirmedSlot: typeof meta.confirmedSlot === 'string' ? meta.confirmedSlot : null,
    customerName: row.customerName,
    customerPhone: row.customerPhone,
    addressLine1: row.addressLine1,
    addressLine2: row.addressLine2,
    addressPostalCode: row.addressPostalCode,
    addressCity: row.addressCity,
    customerNotes: row.customerNotes,
    acceptedAt: row.acceptedAt,
    pickedUpAt: row.pickedUpAt,
    inCleaningAt: row.inCleaningAt,
    readyAt: row.readyAt,
    deliveredAt: row.deliveredAt,
    completedAt: row.completedAt,
    cancelledAt: row.cancelledAt,
    refundedAt: row.refundedAt,
    createdAt: row.createdAt,
    updatedAt: row.updatedAt,
  };
}

/** Mirrors isPartnerDone() in SQL. */
function scopeCondition(orders: TenantTables['orders'], scope: 'active' | 'done'): SQL {
  const done = or(
    inArray(orders.status, [...PARTNER_DONE_STATUSES]),
    and(
      eq(orders.status, 'partially_refunded'),
      or(isNotNull(orders.deliveredAt), isNotNull(orders.completedAt)),
    ),
  )!;
  return scope === 'done' ? done : sql`not (${done})`;
}

/** Start of a calendar day in Berlin, so a period never loses jobs assigned just after midnight. */
function berlinDayStart(day: string, plusDays = 0): SQL {
  return sql`((${day}::date + ${plusDays}::int)::timestamp at time zone 'Europe/Berlin')`;
}

async function ownAssignedOrder(request: FastifyRequest) {
  const id = parseIntId((request.params as { id: string }).id);
  const partner = await requireOwnPartner(request);
  const { orders } = request.company!.tables;
  const [order] = await db
    .select()
    .from(orders)
    .where(and(eq(orders.id, id), eq(orders.assignedPartnerId, partner.id)))
    .limit(1);
  if (!order) throw notFound('Order not found');
  return { order, partner };
}

/** Orders assigned to the signed-in partner: list, detail, status steps, earnings, photos, reports. */
export const ordersPartnerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', requireActivePartner);

  app.get('/', async (request) => {
    const { limit, cursor, scope } = listQuerySchema.parse(request.query);
    const partner = await requireOwnPartner(request);
    const { orders } = request.company!.tables;
    const conds: SQL[] = [eq(orders.assignedPartnerId, partner.id)];
    if (scope) conds.push(scopeCondition(orders, scope));
    const after = keysetAfter(orders, orders.createdAt, orders.id, cursor);
    if (after) conds.push(after);
    const rows = await db
      .select()
      .from(orders)
      .where(and(...conds))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    return { orders: page.map(toPartnerOrderView), nextCursor };
  });

  app.get('/earnings', async (request) => {
    const { from, to } = earningsQuerySchema.parse(request.query);
    const partner = await requireOwnPartner(request);
    const { orders } = request.company!.tables;
    const conds: SQL[] = [eq(orders.assignedPartnerId, partner.id)];
    if (from) conds.push(gte(orders.assignedAt, berlinDayStart(from)));
    if (to) conds.push(lt(orders.assignedAt, berlinDayStart(to, 1)));
    const where = and(...conds);

    // Totals cover every order in the range, not only the rows listed.
    const live = notInArray(orders.status, ['cancelled', 'refunded']);
    const sumLive = (col: AnyPgColumn, extra?: SQL) =>
      sql<number>`coalesce(sum(${col}) filter (where ${extra ? and(live, extra) : live}), 0)`.mapWith(
        Number,
      );
    const [totals] = await db
      .select({
        grossCents: sumLive(orders.totalCents),
        commissionCents: sumLive(orders.commissionCents),
        payoutCents: sumLive(orders.partnerPayoutCents),
        paidOutCents: sumLive(orders.partnerPayoutCents, eq(orders.payoutStatus, 'paid')),
        openPayoutCents: sumLive(orders.partnerPayoutCents, eq(orders.payoutStatus, 'pending')),
        orders: sql<number>`count(*) filter (where ${live})`.mapWith(Number),
      })
      .from(orders)
      .where(where);

    const rows = await db
      .select({
        id: orders.id,
        orderNumber: orders.orderNumber,
        createdAt: orders.createdAt,
        assignedAt: orders.assignedAt,
        kind: orders.kind,
        status: orders.status,
        totalCents: orders.totalCents,
        commissionCents: orders.commissionCents,
        partnerPayoutCents: orders.partnerPayoutCents,
        payoutStatus: orders.payoutStatus,
        payoutAt: orders.payoutAt,
      })
      .from(orders)
      .where(where)
      .orderBy(sql`${orders.assignedAt} desc nulls last`, desc(orders.id))
      .limit(EARNINGS_ROWS + 1);
    return {
      totals: totals!,
      orders: rows.slice(0, EARNINGS_ROWS).map((r) => ({ ...r, orderNumber: orderNumberOf(r) })),
      hasMore: rows.length > EARNINGS_ROWS,
    };
  });

  app.get('/:id', async (request) => {
    const { order } = await ownAssignedOrder(request);
    const { orderItems: i, orderStatusLog: l } = request.company!.tables;
    const [items, statusLog] = await Promise.all([
      db
        .select({
          id: i.id,
          code: i.code,
          label: i.label,
          quantityLabel: i.quantityLabel,
          quantity: i.quantity,
          unitPriceCents: i.unitPriceCents,
          subtotalCents: i.subtotalCents,
        })
        .from(i)
        .where(eq(i.orderId, order.id))
        .orderBy(asc(i.id)),
      db
        .select({
          id: l.id,
          fromStatus: l.fromStatus,
          toStatus: l.toStatus,
          createdAt: l.createdAt,
        })
        .from(l)
        .where(eq(l.orderId, order.id))
        .orderBy(desc(l.createdAt), desc(l.id)),
    ]);
    const next = partnerNextStatus(order);
    return {
      order: toPartnerOrderView(order),
      items,
      statusLog,
      allowedNextStatuses: next ? [next] : [],
    };
  });

  app.post('/:id/transition', async (request, reply) => {
    const { toStatus, reason } = transitionSchema.parse(request.body);
    const { order: row } = await ownAssignedOrder(request);
    const { orders, orderStatusLog } = request.company!.tables;
    const next = partnerNextStatus(row);
    if (next !== toStatus) {
      reply.code(409).send({
        error: 'Dieser Statuswechsel ist nicht möglich',
        code: 'TRANSITION_NOT_ALLOWED',
        allowedNextStatuses: next ? [next] : [],
      });
      return;
    }

    const now = new Date();
    const timestampCol = statusTimestampColumn(toStatus);
    const patch: Record<string, unknown> = { status: toStatus, updatedAt: now };
    if (timestampCol) patch[timestampCol] = now;

    // CAS: a concurrent admin cancel/refund wins, this becomes 409.
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(orders)
        .set(patch)
        .where(and(eq(orders.id, row.id), eq(orders.status, row.status)))
        .returning();
      if (!u) return null;
      await tx.insert(orderStatusLog).values({
        orderId: row.id,
        fromStatus: row.status,
        toStatus,
        changedByUserId: request.authUser!.id,
        reason: reason ?? 'Partner update',
      });
      return u;
    });
    if (!updated) {
      reply.code(409).send({
        error: 'Auftrag wurde zwischenzeitlich geändert — bitte neu laden.',
        code: 'ORDER_CHANGED',
      });
      return;
    }

    void notifyCustomerStatusChange({
      log: request.log,
      companySlug: request.company!.slug,
      order: { ...updated, orderNumber: orderNumberOf(updated) },
      fromStatus: row.status as OrderStatus,
      toStatus,
    }).catch(() => null);

    return { order: toPartnerOrderView(updated) };
  });

  app.get('/:id/photos', async (request) => {
    const { order } = await ownAssignedOrder(request);
    return {
      photos: await Promise.all(
        order.partnerPhotos.map(async (p, index) => ({
          index,
          name: p.name,
          stage: p.stage,
          uploadedAt: p.uploadedAt,
          url: (await signObjectDownload({ key: p.key })).downloadUrl,
        })),
      ),
    };
  });

  app.post(
    '/:id/photos/sign-upload',
    { config: { rateLimit: { max: 40, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!s3Configured) {
        reply.code(503).send({ error: 'Uploads are not configured on this server' });
        return;
      }
      const body = signSchema.parse(request.body);
      if (!PHOTO_TYPES.has(body.contentType)) {
        reply.code(415).send({ error: `Unsupported image type "${body.contentType}"` });
        return;
      }
      const { partner } = await ownAssignedOrder(request);
      const signed = await signPartnerUpload({
        keyPrefix: request.company!.keyPrefix,
        partnerId: partner.id,
        area: 'photos',
        filename: body.filename,
        contentType: body.contentType,
        sizeBytes: body.size,
      });
      reply.code(201).send(signed);
    },
  );

  app.post('/:id/photos', async (request, reply) => {
    const body = attachPhotoSchema.parse(request.body);
    const { order, partner } = await ownAssignedOrder(request);
    if (!body.key.startsWith(partnerKeyPrefix(request.company!.keyPrefix, partner.id, 'photos'))) {
      throw badRequest('Photo does not belong to this partner');
    }
    if (order.partnerPhotos.length >= MAX_PHOTOS) throw conflict(`At most ${MAX_PHOTOS} photos`);
    const { orders } = request.company!.tables;
    const entry = {
      key: body.key,
      name: body.name,
      size: body.size,
      contentType: body.contentType,
      stage: body.stage,
      uploadedAt: new Date().toISOString(),
    };
    await db
      .update(orders)
      .set({
        partnerPhotos: sql`${orders.partnerPhotos} || ${JSON.stringify([entry])}::jsonb`,
        updatedAt: new Date(),
      })
      .where(eq(orders.id, order.id));
    reply.code(201);
    return { photo: { name: entry.name, stage: entry.stage, uploadedAt: entry.uploadedAt } };
  });

  // One task per order and partner; repeat reports become comments on it.
  app.post(
    '/:id/report',
    { config: { rateLimit: { max: 10, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = reportSchema.parse(request.body);
      const { order, partner } = await ownAssignedOrder(request);
      const label = REPORT_LABEL[body.category];
      const task = await spawnTask({
        companySlug: request.company!.slug,
        kind: 'partner_report',
        refKind: `partner_report:${partner.id}`,
        refId: order.id,
        priority: body.category === 'damage' ? 'high' : 'normal',
        title: `Partner meldet: ${label} · ${orderNumberOf(order)}`,
        body: body.message,
        metadata: { orderId: order.id, partnerId: partner.id, category: body.category },
      });
      if (!task.created) {
        await db.insert(taskComments).values({
          taskId: task.id,
          authorUserId: request.authUser!.id,
          body: `${label}: ${body.message}`,
        });
      }
      reply.code(201);
      return { taskId: task.id };
    },
  );
};
