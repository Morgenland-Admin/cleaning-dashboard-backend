import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, gt, inArray, isNull, lte, notInArray, or } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { partnerOfferEmail } from '../../email/templates.js';
import { computeCommission, type CommissionSplit } from '../../lib/commission.js';
import { loadCompany, partnerPortalBase } from '../../lib/company-loader.js';
import { haversineKm } from '../../lib/geo.js';
import { badRequest, conflict, HttpError, notFound, parseIntId } from '../../lib/http-errors.js';
import { formatEurFromCents } from '../../lib/pricing.js';
import { signObjectDownload } from '../../lib/s3.js';
import { assignOrderToPartner, resolveCommissionRate } from '../orders/assign.js';
import { KIND_LABEL, orderNumberOf } from '../orders/lib.js';
import { notifyCustomerStatusChange } from '../orders/routes.js';
import {
  brandForMail,
  loadCompanyFull,
  mailPartner,
  partnerById,
  requireActivePartner,
  requireOwnPartner,
  type PartnerRow,
} from '../partners/lib.js';
import {
  inquiryJobView,
  inquiryTarget,
  matchPartners,
  orderJobView,
  orderTarget,
  withdrawSiblingOffers,
  type DispatchTarget,
  type InquiryRow,
  type OfferRow,
  type OrderRow,
} from './lib.js';

const CLOSED_ORDER = ['cancelled', 'refunded', 'completed'];
const CLOSED_INQUIRY = ['won', 'lost'];

const createOfferSchema = z.object({
  partnerId: z.number().int().positive(),
  expiresInHours: z.number().int().min(1).max(168).default(24),
  note: z.string().trim().max(2000).optional(),
});

const acceptSchema = z.object({
  proposedPriceCents: z.number().int().min(0).max(100_000_000).optional(),
  partnerNote: z.string().trim().max(2000).optional(),
});
const declineSchema = z.object({ reason: z.string().trim().max(1000).optional() });
const partnerListSchema = z.object({ scope: z.enum(['open', 'history']).default('open') });

function berlinDateTime(d: Date): string {
  return d.toLocaleString('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
  });
}

async function pushAdmins(request: FastifyRequest, title: string, body: string, url: string) {
  try {
    const { sendPushToBrandAdmins } = await import('../../lib/push.js');
    await sendPushToBrandAdmins(request.company!.slug, {
      title: `${request.company!.name} · ${title}`,
      body,
      url,
      brandSlug: request.company!.slug,
    });
  } catch (err) {
    request.log.warn({ err }, 'dispatch admin push failed');
  }
}

async function payoutEstimate(
  request: FastifyRequest,
  partner: PartnerRow,
  order: OrderRow,
): Promise<number> {
  const rate = await resolveCommissionRate(request.company!.tables, partner, order.kind);
  return computeCommission(order.totalCents, rate).partnerPayoutCents;
}

type OfferMoney = Pick<CommissionSplit, 'commissionCents' | 'partnerPayoutCents'>;

/** The stored split once the order is this partner's, else the estimate at today's rate. */
function offerMoney(request: FastifyRequest, partner: PartnerRow) {
  const rates = new Map<string, Promise<number | null>>();
  return async (order: OrderRow): Promise<OfferMoney> => {
    if (
      order.assignedPartnerId === partner.id &&
      order.partnerPayoutCents != null &&
      order.commissionCents != null
    ) {
      return {
        commissionCents: order.commissionCents,
        partnerPayoutCents: order.partnerPayoutCents,
      };
    }
    let rate = rates.get(order.kind);
    if (!rate) {
      rate = resolveCommissionRate(request.company!.tables, partner, order.kind);
      rates.set(order.kind, rate);
    }
    return computeCommission(order.totalCents, await rate);
  };
}

/** The sweep runs every few minutes; a lapsed offer reads as expired right away. */
function partnerOfferView(offer: OfferRow, now: Date) {
  const lapsed = offer.status === 'offered' && offer.expiresAt <= now;
  return { ...offer, status: lapsed ? 'expired' : offer.status, createdByUserId: undefined };
}

const offerClosed = () => new HttpError(409, 'Angebot ist nicht mehr offen', 'OFFER_CLOSED');

async function createOffer(
  request: FastifyRequest,
  target: { order?: OrderRow; inquiry?: InquiryRow },
  dispatch: DispatchTarget,
): Promise<OfferRow> {
  const body = createOfferSchema.parse(request.body);
  const tables = request.company!.tables;
  const o = tables.partnerOffers;
  const partner = await partnerById(tables, body.partnerId);
  if (!partner) throw notFound('Partner not found');
  if (partner.status !== 'active') throw badRequest('Partner is not active');

  const existing = await db
    .select({ id: o.id })
    .from(o)
    .where(
      and(
        eq(o.partnerId, partner.id),
        eq(o.status, 'offered'),
        target.order ? eq(o.orderId, target.order.id) : eq(o.inquiryId, target.inquiry!.id),
      ),
    )
    .limit(1);
  if (existing.length > 0) throw conflict('This partner already has an open offer for this job');

  const distanceKm =
    dispatch.coords && partner.lat != null && partner.lng != null
      ? Math.round(haversineKm(dispatch.coords, { lat: partner.lat, lng: partner.lng }) * 10) / 10
      : null;
  const expiresAt = new Date(Date.now() + body.expiresInHours * 3_600_000);
  const [offer] = await db
    .insert(o)
    .values({
      partnerId: partner.id,
      orderId: target.order?.id ?? null,
      inquiryId: target.inquiry?.id ?? null,
      note: body.note,
      expiresAt,
      distanceKm,
      createdByUserId: request.authUser!.id,
    })
    .returning();

  const label = target.order
    ? (KIND_LABEL[target.order.kind] ?? target.order.kind)
    : (target.inquiry!.service ?? 'Anfrage');
  const location = [dispatch.plz, target.order?.addressCity].filter(Boolean).join(' ') || 'k. A.';
  const payout = target.order ? await payoutEstimate(request, partner, target.order) : null;
  try {
    const { sendPushToUser } = await import('../../lib/push.js');
    await sendPushToUser(partner.userId, {
      title: `${request.company!.name} · Neue Auftragsanfrage`,
      body: `${label} · ${location}`,
      url: `/angebote/${offer!.id}`,
      tag: `offer:${offer!.id}`,
      brandSlug: request.company!.slug,
    });
  } catch (err) {
    request.log.warn({ err }, 'offer push failed');
  }
  const companyRow = await loadCompanyFull(request.company!.slug);
  if (companyRow) {
    const date = target.order?.preferredDate ?? target.inquiry?.preferredDate ?? null;
    void mailPartner({
      companyRow,
      partner,
      kind: 'partner_offer',
      refType: target.order ? 'order' : 'inquiry',
      refId: target.order?.id ?? target.inquiry!.id,
      sentByUserId: request.authUser!.id,
      email: partnerOfferEmail({
        brand: brandForMail(companyRow),
        partnerName: partner.companyName,
        jobLabel: label,
        location,
        dateLine: date ? new Date(date).toLocaleDateString('de-DE') : null,
        payoutLine: payout != null ? formatEurFromCents(payout) : null,
        needsPrice: !target.order,
        expiresAtLabel: berlinDateTime(expiresAt),
        offerUrl: `${partnerPortalBase(companyRow) ?? ''}/angebote/${offer!.id}`,
      }),
    });
  }
  return offer!;
}

async function offersFor(request: FastifyRequest, where: { orderId?: number; inquiryId?: number }) {
  const { partnerOffers: o, partners: p } = request.company!.tables;
  return db
    .select({
      offer: o,
      partnerCompanyName: p.companyName,
    })
    .from(o)
    .innerJoin(p, eq(p.id, o.partnerId))
    .where(where.orderId != null ? eq(o.orderId, where.orderId) : eq(o.inquiryId, where.inquiryId!))
    .orderBy(desc(o.createdAt));
}

export const dispatchAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', app.requireWriteAccess);

  async function loadOrder(request: FastifyRequest): Promise<OrderRow> {
    const id = parseIntId((request.params as { id: string }).id);
    const { orders } = request.company!.tables;
    const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!row) throw notFound('Order not found');
    return row;
  }
  async function loadInquiry(request: FastifyRequest): Promise<InquiryRow> {
    const id = parseIntId((request.params as { id: string }).id);
    const { serviceInquiries } = request.company!.tables;
    const [row] = await db
      .select()
      .from(serviceInquiries)
      .where(eq(serviceInquiries.id, id))
      .limit(1);
    if (!row) throw notFound('Inquiry not found');
    return row;
  }
  async function contractVersion(request: FastifyRequest) {
    return (await loadCompany(request.company!.slug))?.partnerContractVersion ?? null;
  }

  app.get('/orders/:id/partner-matches', async (request) => {
    const order = await loadOrder(request);
    const target = await orderTarget(request.company!.tables, order);
    const matches = await matchPartners(
      request.company!.tables,
      target,
      await contractVersion(request),
    );
    return { target: { plz: target.plz, serviceSlugs: target.serviceSlugs }, matches };
  });

  app.get('/inquiries/:id/partner-matches', async (request) => {
    const inquiry = await loadInquiry(request);
    const target = await inquiryTarget(request.company!.tables, inquiry);
    const matches = await matchPartners(
      request.company!.tables,
      target,
      await contractVersion(request),
    );
    return { target: { plz: target.plz, serviceSlugs: target.serviceSlugs }, matches };
  });

  app.get('/orders/:id/offers', async (request) => {
    const order = await loadOrder(request);
    return { offers: await offersFor(request, { orderId: order.id }) };
  });

  app.get('/inquiries/:id/offers', async (request) => {
    const inquiry = await loadInquiry(request);
    return { offers: await offersFor(request, { inquiryId: inquiry.id }) };
  });

  app.post('/orders/:id/offers', async (request, reply) => {
    const order = await loadOrder(request);
    if (CLOSED_ORDER.includes(order.status)) throw conflict(`Order is ${order.status}`);
    if (order.assignedPartnerId) throw conflict('Order is already assigned — unassign it first');
    const target = await orderTarget(request.company!.tables, order);
    const offer = await createOffer(request, { order }, target);
    reply.code(201);
    return { offer };
  });

  app.post('/inquiries/:id/offers', async (request, reply) => {
    const inquiry = await loadInquiry(request);
    if (CLOSED_INQUIRY.includes(inquiry.status)) throw conflict(`Inquiry is ${inquiry.status}`);
    const target = await inquiryTarget(request.company!.tables, inquiry);
    const offer = await createOffer(request, { inquiry }, target);
    reply.code(201);
    return { offer };
  });

  app.post('/partner-offers/:offerId/withdraw', async (request) => {
    const offerId = parseIntId((request.params as { offerId: string }).offerId, 'offerId');
    const { partnerOffers: o } = request.company!.tables;
    const now = new Date();
    const [row] = await db
      .update(o)
      .set({ status: 'withdrawn', respondedAt: now, updatedAt: now })
      .where(and(eq(o.id, offerId), eq(o.status, 'offered')))
      .returning();
    if (!row) throw conflict('Offer not found or no longer open');
    return { offer: row };
  });
};

export const dispatchPartnerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', requireActivePartner);

  app.get('/', async (request) => {
    const { scope } = partnerListSchema.parse(request.query);
    const partner = await requireOwnPartner(request);
    const tables = request.company!.tables;
    const o = tables.partnerOffers;
    const now = new Date();
    const where =
      scope === 'open'
        ? and(eq(o.partnerId, partner.id), eq(o.status, 'offered'), gt(o.expiresAt, now))
        : and(
            eq(o.partnerId, partner.id),
            or(
              inArray(o.status, ['accepted', 'declined', 'expired', 'withdrawn']),
              and(eq(o.status, 'offered'), lte(o.expiresAt, now)),
            ),
          );
    const offers = await db
      .select()
      .from(o)
      .where(where)
      .orderBy(scope === 'open' ? asc(o.expiresAt) : desc(o.updatedAt))
      .limit(100);

    const orderIds = offers.map((x) => x.orderId).filter((x): x is number => x != null);
    const inquiryIds = offers.map((x) => x.inquiryId).filter((x): x is number => x != null);
    const [orders, inquiries] = await Promise.all([
      orderIds.length
        ? db.select().from(tables.orders).where(inArray(tables.orders.id, orderIds))
        : Promise.resolve([] as OrderRow[]),
      inquiryIds.length
        ? db
            .select()
            .from(tables.serviceInquiries)
            .where(inArray(tables.serviceInquiries.id, inquiryIds))
        : Promise.resolve([] as InquiryRow[]),
    ]);
    const orderBy = new Map(orders.map((r) => [r.id, r]));
    const inquiryBy = new Map(inquiries.map((r) => [r.id, r]));
    const moneyOf = offerMoney(request, partner);
    return {
      offers: await Promise.all(
        offers.map(async (offer) => {
          const order = offer.orderId != null ? orderBy.get(offer.orderId) : undefined;
          const inquiry = offer.inquiryId != null ? inquiryBy.get(offer.inquiryId) : undefined;
          const money = order ? await moneyOf(order) : null;
          return {
            ...partnerOfferView(offer, now),
            job: order ? orderJobView(order, []) : inquiry ? inquiryJobView(inquiry) : null,
            payoutCents: money?.partnerPayoutCents ?? null,
            commissionCents: money?.commissionCents ?? null,
          };
        }),
      ),
    };
  });

  app.get('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const partner = await requireOwnPartner(request);
    const tables = request.company!.tables;
    const [offer] = await db
      .select()
      .from(tables.partnerOffers)
      .where(and(eq(tables.partnerOffers.id, id), eq(tables.partnerOffers.partnerId, partner.id)))
      .limit(1);
    if (!offer) throw notFound('Offer not found');

    if (offer.orderId != null) {
      const [order] = await db
        .select()
        .from(tables.orders)
        .where(eq(tables.orders.id, offer.orderId))
        .limit(1);
      if (!order) throw notFound('Order not found');
      const items = await db
        .select({ label: tables.orderItems.label, quantityLabel: tables.orderItems.quantityLabel })
        .from(tables.orderItems)
        .where(eq(tables.orderItems.orderId, order.id))
        .orderBy(asc(tables.orderItems.id));
      const money = await offerMoney(request, partner)(order);
      return {
        offer: partnerOfferView(offer, new Date()),
        job: orderJobView(order, items),
        payoutCents: money.partnerPayoutCents,
        commissionCents: money.commissionCents,
        // Only while the order is still theirs; an unassigned order would 404 in the portal.
        orderId:
          offer.status === 'accepted' && order.assignedPartnerId === partner.id ? order.id : null,
      };
    }

    const [inquiry] = await db
      .select()
      .from(tables.serviceInquiries)
      .where(eq(tables.serviceInquiries.id, offer.inquiryId!))
      .limit(1);
    if (!inquiry) throw notFound('Inquiry not found');
    // Job photos only (customer uploads under the brand prefix); links expire after 10 minutes.
    const attachments = await Promise.all(
      inquiry.attachments.map(async (a) => ({
        name: a.name,
        contentType: a.contentType,
        url: (await signObjectDownload({ key: a.key })).downloadUrl,
      })),
    );
    return {
      offer: partnerOfferView(offer, new Date()),
      job: { ...inquiryJobView(inquiry), attachments },
      payoutCents: null,
      commissionCents: null,
      orderId: null,
    };
  });

  app.post('/:id/accept', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = acceptSchema.parse(request.body ?? {});
    const partner = await requireOwnPartner(request);
    const tables = request.company!.tables;
    const o = tables.partnerOffers;
    const now = new Date();

    const [claimed] = await db
      .update(o)
      .set({
        status: 'accepted',
        respondedAt: now,
        proposedPriceCents: body.proposedPriceCents ?? null,
        partnerNote: body.partnerNote ?? null,
        updatedAt: now,
      })
      .where(
        and(
          eq(o.id, id),
          eq(o.partnerId, partner.id),
          eq(o.status, 'offered'),
          gt(o.expiresAt, now),
        ),
      )
      .returning();
    if (!claimed) throw offerClosed();

    const lose = async (reason: string) => {
      await db
        .update(o)
        .set({ status: 'withdrawn', declineReason: reason, updatedAt: new Date() })
        .where(eq(o.id, claimed.id));
      reply.code(409).send({ error: reason, code: 'JOB_TAKEN' });
    };

    if (claimed.orderId != null) {
      const [order] = await db
        .select()
        .from(tables.orders)
        .where(eq(tables.orders.id, claimed.orderId))
        .limit(1);
      const result = order
        ? await assignOrderToPartner(tables, order, partner, { onlyIfUnassigned: true })
        : null;
      if (!result) return lose('Auftrag ist nicht mehr verfügbar');
      await withdrawSiblingOffers(tables, { orderId: order!.id }, claimed.id);
      // A paid order moves to `accepted` so the partner can take it through fulfilment.
      if (result.order.status === 'paid') {
        const accepted = await db.transaction(async (tx) => {
          const [u] = await tx
            .update(tables.orders)
            .set({ status: 'accepted', acceptedAt: now, updatedAt: now })
            .where(and(eq(tables.orders.id, order!.id), eq(tables.orders.status, 'paid')))
            .returning();
          if (!u) return null;
          await tx.insert(tables.orderStatusLog).values({
            orderId: u.id,
            fromStatus: 'paid',
            toStatus: 'accepted',
            changedByUserId: request.authUser!.id,
            reason: 'Partner hat den Auftrag angenommen',
          });
          return u;
        });
        if (accepted) {
          void notifyCustomerStatusChange({
            log: request.log,
            companySlug: request.company!.slug,
            order: { ...accepted, orderNumber: orderNumberOf(accepted) },
            fromStatus: 'paid',
            toStatus: 'accepted',
          }).catch(() => null);
        }
      }
      void pushAdmins(
        request,
        'Auftrag angenommen',
        `${partner.companyName ?? 'Partner'} · ${orderNumberOf(result.order)}`,
        `/auftraege/${order!.id}`,
      );
      return { offer: claimed, orderId: order!.id };
    }

    const inq = tables.serviceInquiries;
    const [taken] = await db
      .update(inq)
      .set({ assignedPartnerId: partner.id, updatedAt: now })
      .where(
        and(
          eq(inq.id, claimed.inquiryId!),
          notInArray(inq.status, CLOSED_INQUIRY),
          or(isNull(inq.assignedPartnerId), eq(inq.assignedPartnerId, partner.id)),
        ),
      )
      .returning({ id: inq.id });
    if (!taken) return lose('Anfrage ist nicht mehr verfügbar');
    await withdrawSiblingOffers(tables, { inquiryId: taken.id }, claimed.id);
    const price =
      body.proposedPriceCents != null ? ` · ${formatEurFromCents(body.proposedPriceCents)}` : '';
    void pushAdmins(
      request,
      'Anfrage angenommen',
      `${partner.companyName ?? 'Partner'}${price}`,
      `/inquiries/${request.company!.slug}/${taken.id}`,
    );
    return { offer: claimed, orderId: null };
  });

  app.post('/:id/decline', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { reason } = declineSchema.parse(request.body ?? {});
    const partner = await requireOwnPartner(request);
    const o = request.company!.tables.partnerOffers;
    const now = new Date();
    const [row] = await db
      .update(o)
      .set({ status: 'declined', declineReason: reason ?? null, respondedAt: now, updatedAt: now })
      .where(
        and(
          eq(o.id, id),
          eq(o.partnerId, partner.id),
          eq(o.status, 'offered'),
          gt(o.expiresAt, now),
        ),
      )
      .returning();
    if (!row) throw offerClosed();
    void pushAdmins(
      request,
      'Angebot abgelehnt',
      `${partner.companyName ?? 'Partner'}${reason ? ` · ${reason}` : ''}`,
      row.orderId != null
        ? `/auftraege/${row.orderId}`
        : `/inquiries/${request.company!.slug}/${row.inquiryId}`,
    );
    return { offer: row };
  });
};
