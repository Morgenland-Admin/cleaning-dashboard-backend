import type { FastifyPluginAsync, FastifyInstance } from 'fastify';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type Stripe from 'stripe';

import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import { brandInfoFromCompany, brandSender, sendEmail } from '../../email/service.js';
import {
  isStatusEmailableStatus,
  newOrderAdminEmail,
  appointmentConfirmedEmail,
  orderConfirmationEmail,
  orderStatusUpdateEmail,
} from '../../email/templates.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { notFound, parseIntId } from '../../lib/http-errors.js';
import { formatEurFromCents, priceOrder } from '../../lib/pricing.js';
import { getPriceBook } from '../../lib/price-books/index.js';
import { getStripe, stripeConfigured } from '../../lib/stripe.js';
import {
  allowedNextStatuses,
  canTransition,
  generateOrderToken,
  type OrderStatus,
  statusTimestampColumn,
} from './lib.js';
import {
  checkoutSchema,
  quoteSchema,
  toServiceInput,
  type CheckoutInput,
} from './pricing-input.js';
import { evaluateCancellation, type CancellationDecision } from './cancellation.js';

const KIND_LABEL: Record<string, string> = {
  teppichreinigung: 'Teppichreinigung',
  teppichreparatur: 'Teppichreparatur',
  polsterreinigung: 'Polsterreinigung (Vor-Ort)',
  teppichbodenreinigung: 'Teppichbodenreinigung (Vor-Ort)',
};

function orderNumberFor(id: number): string {
  const year = new Date().getUTCFullYear();
  return `${year}/${String(id).padStart(6, '0')}`;
}

/** "YYYY-MM-DDTHH:mm" → "DD.MM.YYYY · HH:mm Uhr" for German display. */
function formatSlotDe(slot: string): string {
  const [d, t] = slot.split('T');
  const [y, m, day] = (d ?? '').split('-');
  if (!y || !m || !day) return slot;
  return `${day}.${m}.${y}${t ? ` · ${t} Uhr` : ''}`;
}

interface NotifyCustomerArgs {
  log: { error: (obj: object, msg?: string) => void };
  companySlug: string;
  order: {
    id: number;
    orderNumber: string;
    customerName: string;
    customerEmail: string;
    publicToken: string;
  };
  fromStatus: OrderStatus;
  toStatus: OrderStatus;
  refundCents?: number;
}

async function notifyCustomerStatusChange(args: NotifyCustomerArgs): Promise<void> {
  if (!isStatusEmailableStatus(args.toStatus)) return;
  if (args.toStatus === args.fromStatus) return;

  try {
    const [companyRow] = await db
      .select()
      .from(company)
      .where(eq(company.slug, args.companySlug))
      .limit(1);
    if (!companyRow) return;

    const brand = brandInfoFromCompany(companyRow);
    const trackerUrl = `${(companyRow.storefrontOrigin ?? env.APP_BASE_URL).replace(/\/$/, '')}/bestellung?token=${encodeURIComponent(args.order.publicToken)}`;

    await sendEmail({
      to: args.order.customerEmail,
      from: brandSender(companyRow),
      replyTo: companyRow.email ?? undefined,
      email: orderStatusUpdateEmail({
        brand,
        customerName: args.order.customerName,
        orderNumber: args.order.orderNumber,
        trackerUrl,
        toStatus: args.toStatus,
        refundFormatted:
          args.refundCents && args.refundCents > 0 ? formatEurFromCents(args.refundCents) : null,
      }),
    });
  } catch (err) {
    args.log.error(
      { err, orderId: args.order.id, toStatus: args.toStatus },
      'status notification failed',
    );
  }
}

export const ordersPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  app.post(
    '/quote',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const parsed = quoteSchema.parse(request.body);
      const book = getPriceBook(request.company!.slug);
      if (!book) {
        reply.code(404).send({ error: 'Unbekannte Marke' });
        return;
      }
      const quote = priceOrder(toServiceInput(parsed), book);
      reply.send({
        ok: !quote.outOfArea,
        quote,
      });
    },
  );

  app.post(
    '/checkout',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!stripeConfigured) {
        reply.code(503).send({ error: 'Payments are not configured on this server' });
        return;
      }

      const body: CheckoutInput = checkoutSchema.parse(request.body);

      if (body.website && body.website.trim().length > 0) {
        reply.code(200).send({ ok: true, checkoutUrl: null });
        return;
      }

      if (
        (body.kind === 'polsterreinigung' || body.kind === 'teppichbodenreinigung') &&
        (!body.preferredSlots || body.preferredSlots.length === 0)
      ) {
        reply
          .code(400)
          .send({ error: 'Mindestens ein Wunschtermin ist für den Vor-Ort-Service erforderlich' });
        return;
      }

      const book = getPriceBook(request.company!.slug);
      if (!book) {
        reply.code(404).send({ error: 'Unbekannte Marke' });
        return;
      }

      const quote = priceOrder(toServiceInput(body), book);
      if (quote.outOfArea || quote.lines.length === 0 || quote.totalCents <= 0) {
        reply.code(400).send({
          error: quote.outOfAreaReason ?? 'Auftrag konnte nicht berechnet werden',
        });
        return;
      }

      const [companyRow] = await db
        .select()
        .from(company)
        .where(eq(company.slug, request.company!.slug))
        .limit(1);
      if (!companyRow) throw notFound('Company not found');

      const { orders, orderItems, orderStatusLog } = request.company!.tables;
      const publicToken = generateOrderToken();
      const pickupMode =
        body.kind === 'polsterreinigung' || body.kind === 'teppichbodenreinigung'
          ? 'onsite'
          : body.pickupMode;

      const addressForOrder =
        body.kind === 'polsterreinigung' || body.kind === 'teppichbodenreinigung'
          ? body.address
          : body.pickupMode === 'pickup'
            ? body.address
            : undefined;

      const pickupPlz =
        body.kind === 'polsterreinigung' || body.kind === 'teppichbodenreinigung'
          ? body.addressPlz
          : body.pickupMode === 'pickup'
            ? body.pickupPlz
            : null;
      const pickupCoords =
        body.kind === 'polsterreinigung' || body.kind === 'teppichbodenreinigung'
          ? body.addressCoords
          : body.pickupMode === 'pickup'
            ? body.pickupCoords
            : undefined;
      const pickupZone =
        pickupPlz && !quote.outOfArea
          ? (await import('../../lib/pickup-zones.js')).resolvePickupZone(pickupPlz, pickupCoords)
              .zone
          : null;

      const now = new Date();

      const orderRow = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(orders)
          .values({
            publicToken,
            kind: body.kind,
            status: 'pending',
            currency: 'EUR',
            subtotalCents: quote.subtotalCents,
            pickupFeeCents: quote.pickupFeeCents,
            minOrderTopUpCents: quote.minOrderTopUpCents,
            totalCents: quote.totalCents,
            pickupMode,
            pickupZone: pickupZone ?? null,
            pickupPlz: pickupPlz ?? null,
            pickupLabel: quote.pickupLabel,
            preferredDate: body.preferredSlots?.[0]?.slice(0, 10) ?? body.preferredDate ?? null,
            metadata:
              body.preferredSlots && body.preferredSlots.length > 0
                ? { preferredSlots: body.preferredSlots }
                : {},
            customerName: body.customer.name,
            customerEmail: body.customer.email,
            customerPhone: body.customer.phone ?? null,
            addressLine1: addressForOrder?.line1 ?? null,
            addressLine2: addressForOrder?.line2 ?? null,
            addressCity: addressForOrder?.city ?? null,
            addressPostalCode: addressForOrder?.postalCode ?? null,
            addressCountry: addressForOrder?.country ?? 'DE',
            customerNotes: body.customerNotes ?? null,
            consentPrivacy: body.consentPrivacy,
            consentMarketing: body.consentMarketing ?? false,
            locale: 'de',
            source: body.source ?? null,
            ipAddress: request.ip,
            userAgent: request.headers['user-agent'] ?? null,
          })
          .returning();
        const order = inserted[0];
        if (!order) throw new Error('Failed to insert order row');

        const linesToInsert = quote.lines.map((l) => ({
          orderId: order.id,
          code: l.code,
          label: l.label,
          quantityLabel: l.quantityLabel,
          quantity: l.quantity.toFixed(2),
          unitPriceCents: l.unitPriceCents,
          subtotalCents: l.subtotalCents,
        }));
        if (linesToInsert.length > 0) {
          await tx.insert(orderItems).values(linesToInsert);
        }

        await tx.insert(orderStatusLog).values({
          orderId: order.id,
          fromStatus: null,
          toStatus: 'pending',
          reason: 'Order created',
        });
        return order;
      });

      const stripe = getStripe();
      const appBase = env.APP_BASE_URL.replace(/\/$/, '');
      const storefrontOrigin = (companyRow.storefrontOrigin ?? appBase).replace(/\/$/, '');

      if (
        env.NODE_ENV === 'production' &&
        /^https?:\/\/(localhost|127\.0\.0\.1)/i.test(storefrontOrigin)
      ) {
        request.log.error(
          { storefrontOrigin, companySlug: request.company!.slug },
          'Refusing to create Stripe session — storefrontOrigin resolves to localhost in production',
        );
        reply.code(503).send({
          error: 'Checkout temporarily unavailable. Please contact us if this persists.',
        });
        return;
      }
      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card', 'klarna', 'sepa_debit'],
        currency: 'eur',
        line_items: [
          {
            quantity: 1,
            price_data: {
              currency: 'eur',
              unit_amount: quote.totalCents,
              product_data: {
                name: `${companyRow.name} · ${KIND_LABEL[body.kind] ?? body.kind}`,
                description: `Auftrag ${orderNumberFor(orderRow.id)}`,
              },
              tax_behavior: 'inclusive',
            },
          },
        ],
        customer_email: body.customer.email,
        client_reference_id: String(orderRow.id),
        metadata: {
          orderId: String(orderRow.id),
          companySlug: request.company!.slug,
          publicToken,
          kind: body.kind,
        },
        success_url: `${storefrontOrigin}/buchung/erfolg?token=${publicToken}&session_id={CHECKOUT_SESSION_ID}`,
        cancel_url: `${storefrontOrigin}/buchung/storno?token=${publicToken}`,
        locale: 'de',
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        billing_address_collection: 'auto',
      });

      await db
        .update(orders)
        .set({
          stripeSessionId: session.id,
          status: 'payment_pending',
          updatedAt: now,
        })
        .where(eq(orders.id, orderRow.id));
      await db.insert(orderStatusLog).values({
        orderId: orderRow.id,
        fromStatus: 'pending',
        toStatus: 'payment_pending',
        reason: 'Stripe Checkout Session created',
      });

      reply.code(201).send({
        ok: true,
        orderId: orderRow.id,
        publicToken,
        checkoutUrl: session.url,
        sessionId: session.id,
      });
    },
  );

  app.get(
    '/:token',
    { config: { rateLimit: { max: 120, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const token = (request.params as { token: string }).token;
      if (typeof token !== 'string' || token.length < 8 || token.length > 64) {
        reply.code(400).send({ error: 'Invalid token' });
        return;
      }
      const { orders, orderItems, orderStatusLog } = request.company!.tables;
      const [row] = await db.select().from(orders).where(eq(orders.publicToken, token)).limit(1);
      if (!row) {
        reply.code(404).send({ error: 'Order not found' });
        return;
      }
      const items = await db.select().from(orderItems).where(eq(orderItems.orderId, row.id));
      const log = await db
        .select()
        .from(orderStatusLog)
        .where(eq(orderStatusLog.orderId, row.id))
        .orderBy(desc(orderStatusLog.createdAt));

      const {
        ipAddress: _i,
        userAgent: _u,
        internalNotes: _n,
        stripeSessionId: _s,
        stripePaymentIntentId: _p,
        ...safe
      } = row;
      reply.send({
        order: { ...safe, orderNumber: orderNumberFor(row.id) },
        items,
        statusLog: log,
      });
    },
  );
};

export const ordersWebhookRoutes: FastifyPluginAsync = async (app) => {
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body);
  });

  app.post('/stripe', async (request, reply) => {
    if (!stripeConfigured || !env.STRIPE_WEBHOOK_SECRET) {
      reply.code(503).send({ error: 'Stripe webhook not configured' });
      return;
    }

    const sig = request.headers['stripe-signature'];
    if (typeof sig !== 'string') {
      reply.code(400).send({ error: 'Missing stripe-signature' });
      return;
    }

    const stripe = getStripe();
    let event: Stripe.Event;
    try {
      event = stripe.webhooks.constructEvent(
        request.body as Buffer,
        sig,
        env.STRIPE_WEBHOOK_SECRET,
      );
    } catch (err) {
      request.log.warn({ err }, 'Stripe webhook signature verification failed');
      reply.code(400).send({ error: 'Invalid signature' });
      return;
    }

    try {
      await handleStripeEvent(app, event);
    } catch (err) {
      request.log.error(
        { err, eventType: event.type, eventId: event.id },
        'Stripe webhook handler failed',
      );
      reply.code(500).send({ error: 'Webhook handler failed' });
      return;
    }

    reply.code(200).send({ received: true });
  });
};

async function handleStripeEvent(app: FastifyInstance, event: Stripe.Event): Promise<void> {
  switch (event.type) {
    case 'checkout.session.completed':
    case 'checkout.session.async_payment_succeeded': {
      const session = event.data.object;
      const companySlug = session.metadata?.companySlug;
      const orderIdStr = session.metadata?.orderId;
      if (!companySlug || !orderIdStr) {
        app.log.warn({ sessionId: session.id }, 'Checkout session missing metadata');
        return;
      }
      const orderId = Number(orderIdStr);
      if (!Number.isInteger(orderId)) return;
      const ok =
        session.payment_status === 'paid' || session.payment_status === 'no_payment_required';
      if (!ok) {
        app.log.info(
          { orderId, status: session.payment_status },
          'Checkout completed but not paid yet',
        );
        return;
      }
      await markOrderPaid(app, companySlug, orderId, session);
      return;
    }
    case 'checkout.session.async_payment_failed': {
      const session = event.data.object;
      const companySlug = session.metadata?.companySlug;
      const orderIdStr = session.metadata?.orderId;
      if (!companySlug || !orderIdStr) return;
      await markOrderCancelled(app, companySlug, Number(orderIdStr), 'SEPA payment failed');
      return;
    }
    case 'charge.refunded': {
      const charge = event.data.object;
      const pi = typeof charge.payment_intent === 'string' ? charge.payment_intent : null;
      if (!pi) return;
      const refundAmount =
        typeof charge.amount_refunded === 'number' ? charge.amount_refunded : undefined;
      await markOrderRefundedByPaymentIntent(app, pi, refundAmount);
      return;
    }
    default:
      return;
  }
}

async function markOrderPaid(
  app: FastifyInstance,
  companySlug: string,
  orderId: number,
  session: Stripe.Checkout.Session,
): Promise<void> {
  const { getTenantTables } = await import('../../db/schema/tenant.js');
  const { loadCompany } = await import('../../lib/company-loader.js');
  const companyRow = await loadCompany(companySlug);
  if (!companyRow) return;
  const tables = getTenantTables(companyRow.schemaName);

  const [order] = await db
    .select()
    .from(tables.orders)
    .where(eq(tables.orders.id, orderId))
    .limit(1);
  if (!order) {
    app.log.warn({ orderId, companySlug }, 'Stripe webhook for unknown order');
    return;
  }

  const isAlreadyAdvanced =
    order.status === 'paid' ||
    order.status === 'accepted' ||
    order.status === 'picked_up' ||
    order.status === 'in_cleaning' ||
    order.status === 'ready' ||
    order.status === 'delivered' ||
    order.status === 'completed';
  if (isAlreadyAdvanced) return;

  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : null;
  const now = new Date();

  await db.transaction(async (tx) => {
    await tx
      .update(tables.orders)
      .set({
        status: 'paid',
        paidAt: now,
        stripePaymentIntentId: paymentIntentId,
        updatedAt: now,
      })
      .where(eq(tables.orders.id, orderId));
    await tx.insert(tables.orderStatusLog).values({
      orderId,
      fromStatus: order.status,
      toStatus: 'paid',
      reason: `Stripe ${session.payment_status}`,
    });
  });

  try {
    const items = await db
      .select()
      .from(tables.orderItems)
      .where(eq(tables.orderItems.orderId, orderId));

    const brand = brandInfoFromCompany(companyRow);
    const orderNumber = orderNumberFor(orderId);
    const trackerUrl = `${(companyRow.storefrontOrigin ?? env.APP_BASE_URL).replace(/\/$/, '')}/bestellung?token=${encodeURIComponent(order.publicToken)}`;
    const fulfillmentNote =
      order.pickupMode === 'drop_off'
        ? 'Sie können Ihren Teppich nach Voranmeldung in unserer Werkstatt in der Hamburg-Speicherstadt abgeben.'
        : order.pickupMode === 'onsite'
          ? 'Wir melden uns innerhalb eines Werktages, um den Vor-Ort-Termin zu bestätigen.'
          : 'Unser Fahrer holt Ihren Teppich ab. Wir melden uns mit dem genauen Termin.';

    await sendEmail({
      to: order.customerEmail,
      from: brandSender(companyRow),
      replyTo: companyRow.email ?? undefined,
      email: orderConfirmationEmail({
        brand,
        customerName: order.customerName,
        orderNumber,
        trackerUrl,
        totalFormatted: formatEurFromCents(order.totalCents),
        lines: items.map((i) => ({
          label: i.label,
          quantityLabel: i.quantityLabel,
          subtotalFormatted: formatEurFromCents(i.subtotalCents),
        })),
        pickupLabel: order.pickupLabel,
        pickupFeeFormatted:
          order.pickupFeeCents > 0 ? formatEurFromCents(order.pickupFeeCents) : null,
        fulfillmentNote,
      }),
    });

    if (companyRow.email) {
      const adminUrl = `${env.APP_BASE_URL.replace(/\/$/, '')}/auftraege?id=${orderId}`;
      await sendEmail({
        to: companyRow.email,
        from: brandSender(companyRow),
        replyTo: order.customerEmail,
        email: newOrderAdminEmail({
          brand,
          orderNumber,
          customerName: order.customerName,
          customerEmail: order.customerEmail,
          customerPhone: order.customerPhone,
          kindLabel: KIND_LABEL[order.kind] ?? order.kind,
          totalFormatted: formatEurFromCents(order.totalCents),
          pickupLabel: order.pickupLabel,
          preferredDate: order.preferredDate ?? null,
          adminUrl,
        }),
      });
    }
  } catch (err) {
    app.log.error({ err, orderId }, 'Failed to send order confirmation emails');
  }

  try {
    const { sendPushToBrandAdmins } = await import('../../lib/push.js');
    await sendPushToBrandAdmins(companySlug, {
      title: `${companyRow.name} · Neuer Auftrag`,
      body: `${orderNumberFor(orderId)} · ${order.customerName} · ${formatEurFromCents(order.totalCents)}`,
      url: `/auftraege?id=${orderId}`,
      tag: `order:${orderId}`,
      brandSlug: companySlug,
    });
  } catch (err) {
    app.log.warn({ err, orderId }, 'push dispatch failed for new paid order');
  }
}

async function markOrderCancelled(
  app: FastifyInstance,
  companySlug: string,
  orderId: number,
  reason: string,
): Promise<void> {
  const { getTenantTables } = await import('../../db/schema/tenant.js');
  const { loadCompany } = await import('../../lib/company-loader.js');
  const companyRow = await loadCompany(companySlug);
  if (!companyRow) return;
  const tables = getTenantTables(companyRow.schemaName);
  const [order] = await db
    .select()
    .from(tables.orders)
    .where(eq(tables.orders.id, orderId))
    .limit(1);
  if (!order) return;
  if (order.status === 'cancelled' || order.status === 'refunded') return;
  const paidStatuses: OrderStatus[] = [
    'paid',
    'accepted',
    'picked_up',
    'in_cleaning',
    'ready',
    'delivered',
    'completed',
  ];
  if (paidStatuses.includes(order.status as OrderStatus)) {
    app.log.warn(
      { orderId, currentStatus: order.status, reason },
      'Refusing to cancel an already-paid order from webhook — admin must refund manually',
    );
    return;
  }
  const now = new Date();
  await db.transaction(async (tx) => {
    await tx
      .update(tables.orders)
      .set({ status: 'cancelled', cancelledAt: now, updatedAt: now })
      .where(eq(tables.orders.id, orderId));
    await tx.insert(tables.orderStatusLog).values({
      orderId,
      fromStatus: order.status,
      toStatus: 'cancelled',
      reason,
    });
  });
}

async function markOrderRefundedByPaymentIntent(
  app: FastifyInstance,
  paymentIntentId: string,
  refundAmountCents?: number,
): Promise<void> {
  const { loadAllActiveCompanies } = await import('../../lib/company-loader.js');
  const { getTenantTables } = await import('../../db/schema/tenant.js');
  const companies = await loadAllActiveCompanies();
  for (const c of companies) {
    const tables = getTenantTables(c.schemaName);
    const [order] = await db
      .select()
      .from(tables.orders)
      .where(eq(tables.orders.stripePaymentIntentId, paymentIntentId))
      .limit(1);
    if (!order) continue;
    if (order.status === 'refunded') return;
    const now = new Date();
    const fromStatus = order.status as OrderStatus;
    await db.transaction(async (tx) => {
      await tx
        .update(tables.orders)
        .set({ status: 'refunded', refundedAt: now, updatedAt: now })
        .where(eq(tables.orders.id, order.id));
      await tx.insert(tables.orderStatusLog).values({
        orderId: order.id,
        fromStatus: order.status,
        toStatus: 'refunded',
        reason: 'Stripe charge.refunded',
      });
    });
    void notifyCustomerStatusChange({
      log: app.log,
      companySlug: c.slug,
      order: {
        id: order.id,
        orderNumber: orderNumberFor(order.id),
        customerName: order.customerName,
        customerEmail: order.customerEmail,
        publicToken: order.publicToken,
      },
      fromStatus,
      toStatus: 'refunded',
      refundCents: refundAmountCents,
    }).catch(() => null);
    return;
  }
  app.log.warn({ paymentIntentId }, 'Refund webhook for unknown payment intent');
}

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
  status: z
    .enum([
      'pending',
      'payment_pending',
      'paid',
      'accepted',
      'picked_up',
      'in_cleaning',
      'ready',
      'delivered',
      'completed',
      'cancelled',
      'refunded',
    ])
    .optional(),
});

const transitionSchema = z.object({
  toStatus: z.enum([
    'accepted',
    'picked_up',
    'in_cleaning',
    'ready',
    'delivered',
    'completed',
    'cancelled',
    'refunded',
  ]),
  reason: z.string().trim().max(500).optional(),
});

const updateInternalNotesSchema = z.object({
  internalNotes: z.string().trim().max(4000).nullable(),
});

export const ordersAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);

  app.get('/', async (request) => {
    const { limit, cursor, status } = listQuerySchema.parse(request.query);
    const { orders } = request.company!.tables;
    const decoded = cursor ? decodeCursor(cursor) : null;
    const cursorWhere = decoded
      ? or(
          lt(orders.createdAt, sql`${decoded.createdAt}::timestamptz`),
          and(
            sql`${orders.createdAt} = ${decoded.createdAt}::timestamptz`,
            lt(orders.id, decoded.id),
          ),
        )
      : undefined;
    const where = status
      ? cursorWhere
        ? and(cursorWhere, eq(orders.status, status))
        : eq(orders.status, status)
      : cursorWhere;

    const rows = await db
      .select()
      .from(orders)
      .where(where)
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    return {
      orders: page.map((r) => ({ ...r, orderNumber: orderNumberFor(r.id) })),
      nextCursor,
    };
  });

  app.get('/:id', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { orders, orderItems, orderStatusLog } = request.company!.tables;
    const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!row) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, id));
    const log = await db
      .select()
      .from(orderStatusLog)
      .where(eq(orderStatusLog.orderId, id))
      .orderBy(desc(orderStatusLog.createdAt));
    return {
      order: { ...row, orderNumber: orderNumberFor(row.id) },
      items,
      statusLog: log,
      allowedNextStatuses: allowedNextStatuses(row.status as OrderStatus),
    };
  });

  app.post('/:id/transition', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { toStatus, reason } = transitionSchema.parse(request.body);
    const { orders, orderStatusLog } = request.company!.tables;
    const adminId = request.authUser!.id;
    const now = new Date();

    const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!row) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }
    if (!canTransition(row.status as OrderStatus, toStatus)) {
      reply.code(409).send({
        error: `Cannot transition from ${row.status} to ${toStatus}`,
        allowedNextStatuses: allowedNextStatuses(row.status as OrderStatus),
      });
      return;
    }

    if (toStatus === 'refunded') {
      if (!row.stripePaymentIntentId) {
        reply.code(400).send({ error: 'Order has no payment intent — cannot refund via Stripe' });
        return;
      }
      if (!stripeConfigured) {
        reply.code(503).send({ error: 'Stripe not configured on this server' });
        return;
      }
      try {
        await getStripe().refunds.create({ payment_intent: row.stripePaymentIntentId });
      } catch (err) {
        request.log.error({ err, orderId: id }, 'Stripe refund failed');
        reply.code(502).send({ error: 'Stripe refund failed' });
        return;
      }
    }

    const timestampCol = statusTimestampColumn(toStatus);
    const patch: Record<string, unknown> = {
      status: toStatus,
      updatedAt: now,
      handledByUserId: adminId,
    };
    if (timestampCol) patch[timestampCol] = now;

    const updated = await db.transaction(async (tx) => {
      const [u] = await tx.update(orders).set(patch).where(eq(orders.id, id)).returning();
      if (!u) throw new Error('Order row vanished mid-transition');
      await tx.insert(orderStatusLog).values({
        orderId: id,
        fromStatus: row.status,
        toStatus,
        changedByUserId: adminId,
        reason: reason ?? null,
      });
      return u;
    });

    void notifyCustomerStatusChange({
      log: request.log,
      companySlug: request.company!.slug,
      order: { ...updated, orderNumber: orderNumberFor(updated.id) },
      fromStatus: row.status as OrderStatus,
      toStatus,
    }).catch(() => null);

    return { order: { ...updated, orderNumber: orderNumberFor(updated.id) } };
  });

  app.get('/:id/cancel-preview', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { orders } = request.company!.tables;
    const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!row) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }
    const decision = evaluateCancellation({
      status: row.status as OrderStatus,
      totalCents: row.totalCents ?? 0,
      paidAt: row.paidAt ?? null,
      preferredDate: row.preferredDate ? new Date(row.preferredDate) : null,
      now: new Date(),
    });
    reply.send({ decision });
  });

  const cancelSchema = z.object({
    /** Operator's note — required when overriding suggested refund. */
    reason: z.string().trim().max(2000).optional(),
    /** Override the rule-engine's suggested refund. Capped at order total. */
    refundCentsOverride: z.number().int().min(0).optional(),
  });

  app.post('/:id/cancel', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = cancelSchema.parse(request.body);
    const { orders, orderStatusLog } = request.company!.tables;
    const adminId = request.authUser!.id;
    const now = new Date();

    const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!row) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }

    const decision: CancellationDecision = evaluateCancellation({
      status: row.status as OrderStatus,
      totalCents: row.totalCents ?? 0,
      paidAt: row.paidAt ?? null,
      preferredDate: row.preferredDate ? new Date(row.preferredDate) : null,
      now,
    });

    if (!decision.allowed) {
      reply.code(409).send({ error: decision.message, decision });
      return;
    }

    const refundCents = Math.min(
      row.totalCents ?? 0,
      Math.max(0, body.refundCentsOverride ?? decision.suggestedRefundCents),
    );

    if (refundCents > 0) {
      if (!row.stripePaymentIntentId) {
        reply.code(400).send({
          error:
            'Order has no payment intent — refund amount must be 0 (not-yet-paid) or handled manually.',
        });
        return;
      }
      if (!stripeConfigured) {
        reply.code(503).send({ error: 'Stripe not configured on this server' });
        return;
      }
      try {
        await getStripe().refunds.create({
          payment_intent: row.stripePaymentIntentId,
          amount: refundCents,
        });
      } catch (err) {
        request.log.error({ err, orderId: id, refundCents }, 'Stripe refund failed');
        reply.code(502).send({ error: 'Stripe refund failed' });
        return;
      }
    }

    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(orders)
        .set({
          status: 'cancelled',
          cancelledAt: now,
          updatedAt: now,
          handledByUserId: adminId,
        })
        .where(eq(orders.id, id))
        .returning();
      if (!u) throw new Error('Order row vanished mid-cancel');
      await tx.insert(orderStatusLog).values({
        orderId: id,
        fromStatus: row.status,
        toStatus: 'cancelled',
        changedByUserId: adminId,
        reason: [
          body.reason,
          `Refund: ${(refundCents / 100).toFixed(2)} EUR`,
          `Rule: ${decision.reasonCode}`,
        ]
          .filter(Boolean)
          .join(' · '),
      });
      return u;
    });

    void notifyCustomerStatusChange({
      log: request.log,
      companySlug: request.company!.slug,
      order: { ...updated, orderNumber: orderNumberFor(updated.id) },
      fromStatus: row.status as OrderStatus,
      toStatus: 'cancelled',
      refundCents,
    }).catch(() => null);

    return {
      order: { ...updated, orderNumber: orderNumberFor(updated.id) },
      decision,
      refundCents,
    };
  });

  app.patch('/:id/notes', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { internalNotes } = updateInternalNotesSchema.parse(request.body);
    const { orders } = request.company!.tables;
    const [updated] = await db
      .update(orders)
      .set({ internalNotes, updatedAt: new Date() })
      .where(eq(orders.id, id))
      .returning();
    if (!updated) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }
    return { order: { ...updated, orderNumber: orderNumberFor(updated.id) } };
  });
  app.post('/:id/confirm-appointment', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { slot } = z
      .object({ slot: z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/) })
      .parse(request.body);
    const { orders } = request.company!.tables;
    const companySlug = request.company!.slug;

    const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!row) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }

    const meta = row.metadata ?? {};
    const [updated] = await db
      .update(orders)
      .set({
        preferredDate: slot.slice(0, 10),
        metadata: { ...meta, confirmedSlot: slot },
        updatedAt: new Date(),
      })
      .where(eq(orders.id, id))
      .returning();
    if (!updated) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }

    try {
      const [companyRow] = await db
        .select()
        .from(company)
        .where(eq(company.slug, companySlug))
        .limit(1);
      if (companyRow) {
        const trackerUrl = `${(companyRow.storefrontOrigin ?? env.APP_BASE_URL).replace(/\/$/, '')}/bestellung?token=${encodeURIComponent(row.publicToken)}`;
        await sendEmail({
          to: row.customerEmail,
          from: brandSender(companyRow),
          replyTo: companyRow.email ?? undefined,
          email: appointmentConfirmedEmail({
            brand: brandInfoFromCompany(companyRow),
            customerName: row.customerName,
            orderNumber: orderNumberFor(row.id),
            trackerUrl,
            appointmentFormatted: formatSlotDe(slot),
          }),
        });
      }
    } catch (err) {
      request.log.error({ err, orderId: id }, 'appointment confirmation email failed');
    }

    return { order: { ...updated, orderNumber: orderNumberFor(updated.id) } };
  });
  app.post('/:id/sync-stripe', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { orders } = request.company!.tables;
    const companySlug = request.company!.slug;

    const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!row) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }

    if (!stripeConfigured) {
      reply.code(503).send({ error: 'Stripe not configured on this server' });
      return;
    }
    if (!row.stripeSessionId) {
      reply.code(400).send({
        error: 'Order has no Stripe session — it was likely cancelled before checkout could start.',
      });
      return;
    }

    let session: Stripe.Checkout.Session;
    try {
      session = await getStripe().checkout.sessions.retrieve(row.stripeSessionId);
    } catch (err) {
      request.log.error({ err, orderId: id }, 'Stripe session retrieve failed');
      reply.code(502).send({ error: 'Could not reach Stripe' });
      return;
    }

    const paid =
      session.payment_status === 'paid' || session.payment_status === 'no_payment_required';

    const terminalStatuses: OrderStatus[] = [
      'paid',
      'accepted',
      'picked_up',
      'in_cleaning',
      'ready',
      'delivered',
      'completed',
      'cancelled',
      'refunded',
    ];
    if (terminalStatuses.includes(row.status as OrderStatus)) {
      reply.send({
        order: { ...row, orderNumber: orderNumberFor(row.id) },
        stripe: { sessionStatus: session.status, paymentStatus: session.payment_status },
        action: 'noop',
      });
      return;
    }

    if (paid) {
      await markOrderPaid(app, companySlug, id, session);
      const [updated] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
      reply.send({
        order: updated ? { ...updated, orderNumber: orderNumberFor(updated.id) } : null,
        stripe: { sessionStatus: session.status, paymentStatus: session.payment_status },
        action: 'marked_paid',
      });
      return;
    }

    if (session.status === 'expired') {
      await markOrderCancelled(app, companySlug, id, 'Stripe session expired');
      const [updated] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
      reply.send({
        order: updated ? { ...updated, orderNumber: orderNumberFor(updated.id) } : null,
        stripe: { sessionStatus: session.status, paymentStatus: session.payment_status },
        action: 'marked_cancelled',
      });
      return;
    }

    reply.send({
      order: { ...row, orderNumber: orderNumberFor(row.id) },
      stripe: { sessionStatus: session.status, paymentStatus: session.payment_status },
      action: 'still_pending',
    });
  });
};

const crossListQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  status: z
    .enum([
      'pending',
      'payment_pending',
      'paid',
      'accepted',
      'picked_up',
      'in_cleaning',
      'ready',
      'delivered',
      'completed',
      'cancelled',
      'refunded',
    ])
    .optional(),
});

export const ordersAdminCrossRoutes: FastifyPluginAsync = async (app) => {
  app.get('/orders/all', async (request) => {
    const { limit, status } = crossListQuerySchema.parse(request.query);
    const { loadAllActiveCompanies } = await import('../../lib/company-loader.js');
    const { getTenantTables } = await import('../../db/schema/tenant.js');
    const companies = await loadAllActiveCompanies();

    type EnrichedOrder = Awaited<ReturnType<typeof fetchOrdersForCompany>>[number];
    async function fetchOrdersForCompany(c: (typeof companies)[number]) {
      const tables = getTenantTables(c.schemaName);
      const where = status ? eq(tables.orders.status, status) : undefined;
      const rows = await db
        .select()
        .from(tables.orders)
        .where(where)
        .orderBy(desc(tables.orders.createdAt), desc(tables.orders.id))
        .limit(limit);
      return rows.map((r) => ({
        ...r,
        orderNumber: orderNumberFor(r.id),
        companySlug: c.slug,
        companyName: c.name,
      }));
    }

    const perCompany = await Promise.all(companies.map(fetchOrdersForCompany));
    const all: EnrichedOrder[] = perCompany.flat();
    all.sort((a, b) => {
      const t = b.createdAt.getTime() - a.createdAt.getTime();
      if (t !== 0) return t;
      return b.id - a.id;
    });
    return {
      orders: all.slice(0, limit),
      nextCursor: null,
    };
  });
};
