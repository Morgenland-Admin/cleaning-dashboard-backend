import type { FastifyPluginAsync, FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type Stripe from 'stripe';

import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { brandInfoFromCompany, brandSender, sendEmail } from '../../email/service.js';
import {
  isStatusEmailableStatus,
  newOrderAdminEmail,
  appointmentConfirmedEmail,
  orderConfirmationEmail,
  orderStatusUpdateEmail,
  paymentRequestEmail,
} from '../../email/templates.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { badRequest, conflict, notFound, parseIntId } from '../../lib/http-errors.js';
import { computeCommission, parseCommissionRate } from '../../lib/commission.js';
import { computeLoyaltyTier } from '../../lib/loyalty.js';
import { captureException } from '../../lib/observability.js';
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
      apiKey: companyRow.resendApiKey ?? undefined,
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
      // 'after_service' orders skip Stripe checkout entirely — they go straight
      // into the service pipeline (status 'accepted') and payment is collected
      // by an admin once the work is done (cash / EC card / credit-card link).
      const paymentMode = body.paymentMode ?? 'upfront';
      const isAfterService = paymentMode === 'after_service';

      const orderRow = await db.transaction(async (tx) => {
        const inserted = await tx
          .insert(orders)
          .values({
            publicToken,
            kind: body.kind,
            status: isAfterService ? 'accepted' : 'pending',
            paymentMode,
            acceptedAt: isAfterService ? now : null,
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
          toStatus: isAfterService ? 'accepted' : 'pending',
          reason: isAfterService ? 'Auftrag erstellt · Zahlung nach Leistung' : 'Order created',
        });
        return order;
      });

      const appBase = env.APP_BASE_URL.replace(/\/$/, '');
      const storefrontOrigin = (companyRow.storefrontOrigin ?? appBase).replace(/\/$/, '');

      // --- Pay-after-service: no Stripe checkout, just confirm the booking. ---
      if (isAfterService) {
        try {
          const brand = brandInfoFromCompany(companyRow);
          const orderNumber = orderNumberFor(orderRow.id);
          const trackerUrl = `${storefrontOrigin}/bestellung?token=${encodeURIComponent(publicToken)}`;
          const baseNote =
            pickupMode === 'drop_off'
              ? 'Sie können Ihren Teppich nach Voranmeldung in unserer Werkstatt in der Hamburg-Speicherstadt abgeben.'
              : pickupMode === 'onsite'
                ? 'Wir melden uns innerhalb eines Werktages, um den Vor-Ort-Termin zu bestätigen.'
                : 'Unser Fahrer holt Ihren Teppich ab. Wir melden uns mit dem genauen Termin.';
          const fulfillmentNote = `${baseNote} Die Bezahlung erfolgt nach erbrachter Leistung — Sie müssen jetzt nichts zahlen.`;

          await sendEmail({
            to: body.customer.email,
            from: brandSender(companyRow),
            apiKey: companyRow.resendApiKey ?? undefined,
            replyTo: companyRow.email ?? undefined,
            email: orderConfirmationEmail({
              brand,
              customerName: body.customer.name,
              orderNumber,
              trackerUrl,
              totalFormatted: formatEurFromCents(quote.totalCents),
              lines: quote.lines.map((l) => ({
                label: l.label,
                quantityLabel: l.quantityLabel,
                subtotalFormatted: formatEurFromCents(l.subtotalCents),
              })),
              pickupLabel: quote.pickupLabel,
              pickupFeeFormatted:
                quote.pickupFeeCents > 0 ? formatEurFromCents(quote.pickupFeeCents) : null,
              fulfillmentNote,
            }),
          });

          if (companyRow.email) {
            const adminUrl = `${appBase}/auftraege?id=${orderRow.id}`;
            await sendEmail({
              to: companyRow.email,
              from: brandSender(companyRow),
              apiKey: companyRow.resendApiKey ?? undefined,
              replyTo: body.customer.email,
              email: newOrderAdminEmail({
                brand,
                orderNumber,
                customerName: body.customer.name,
                customerEmail: body.customer.email,
                customerPhone: body.customer.phone ?? null,
                kindLabel: `${KIND_LABEL[body.kind] ?? body.kind} · Zahlung nach Leistung`,
                totalFormatted: formatEurFromCents(quote.totalCents),
                pickupLabel: quote.pickupLabel,
                preferredDate: body.preferredSlots?.[0]?.slice(0, 10) ?? body.preferredDate ?? null,
                adminUrl,
              }),
            });
          }
        } catch (err) {
          request.log.error(
            { err, orderId: orderRow.id },
            'after-service confirmation emails failed',
          );
        }

        reply.code(201).send({
          ok: true,
          orderId: orderRow.id,
          publicToken,
          checkoutUrl: null,
          sessionId: null,
        });
        return;
      }

      const stripe = getStripe();

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
      let discounts: Array<{ promotion_code: string }> | undefined;
      if (body.voucherCode) {
        const code = body.voucherCode.toUpperCase();
        const promo = await stripe.promotionCodes.list({ code, active: true, limit: 1 });
        const promoCode = promo.data[0];
        const stillRedeemable =
          promoCode &&
          (!promoCode.expires_at || promoCode.expires_at * 1000 > Date.now()) &&
          (promoCode.max_redemptions == null ||
            promoCode.times_redeemed < promoCode.max_redemptions);
        if (!stillRedeemable) {
          reply.code(400).send({ error: 'Gutscheincode ungültig oder abgelaufen.' });
          return;
        }
        discounts = [{ promotion_code: promoCode.id }];
      }

      const session = await stripe.checkout.sessions.create({
        mode: 'payment',
        payment_method_types: ['card', 'paypal', 'amazon_pay', 'link'],
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
        ...(discounts ? { discounts } : {}),
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
          voucherCode: body.voucherCode ? body.voucherCode.toUpperCase() : null,
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
      captureException(err, { eventType: event.type, eventId: event.id });
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
      // A payment-link for an already-running "pay after service" order: just
      // record the payment, don't run the new-order onboarding (emails sent at booking).
      if (session.metadata?.afterService === '1') {
        await markAfterServicePaid(app, companySlug, orderId, session);
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
    case 'account.updated': {
      const account = event.data.object;
      await syncPartnerConnectAccount(app, account);
      return;
    }
    case 'transfer.reversed': {
      const transfer = event.data.object;
      await markPayoutFailedByTransfer(app, transfer.id);
      return;
    }
    default:
      return;
  }
}

/** Find the partner row (across all tenant schemas) for a Connect account and sync flags. */
async function syncPartnerConnectAccount(
  app: FastifyInstance,
  account: Stripe.Account,
): Promise<void> {
  const { loadAllActiveCompanies } = await import('../../lib/company-loader.js');
  const { getTenantTables } = await import('../../db/schema/tenant.js');
  const status = account.payouts_enabled
    ? 'active'
    : account.details_submitted
      ? 'restricted'
      : 'pending';
  for (const c of await loadAllActiveCompanies()) {
    const tables = getTenantTables(c.schemaName);
    const [partner] = await db
      .select({ id: tables.partners.id })
      .from(tables.partners)
      .where(eq(tables.partners.stripeConnectId, account.id))
      .limit(1);
    if (!partner) continue;
    await db
      .update(tables.partners)
      .set({
        stripeConnectStatus: status,
        chargesEnabled: !!account.charges_enabled,
        payoutsEnabled: !!account.payouts_enabled,
        updatedAt: new Date(),
      })
      .where(eq(tables.partners.id, partner.id));
    return;
  }
}

/** Mark an order's payout failed when its Connect transfer is reversed/fails. */
async function markPayoutFailedByTransfer(app: FastifyInstance, transferId: string): Promise<void> {
  const { loadAllActiveCompanies } = await import('../../lib/company-loader.js');
  const { getTenantTables } = await import('../../db/schema/tenant.js');
  for (const c of await loadAllActiveCompanies()) {
    const tables = getTenantTables(c.schemaName);
    const [order] = await db
      .select({ id: tables.orders.id })
      .from(tables.orders)
      .where(eq(tables.orders.stripeTransferId, transferId))
      .limit(1);
    if (!order) continue;
    await db
      .update(tables.orders)
      .set({ payoutStatus: 'failed', updatedAt: new Date() })
      .where(eq(tables.orders.id, order.id));
    app.log.warn({ transferId, orderId: order.id }, 'Partner payout reversed/failed');
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

  const amountTotal = typeof session.amount_total === 'number' ? session.amount_total : null;
  const discountCents = session.total_details?.amount_discount ?? 0;
  if (amountTotal != null && amountTotal !== order.totalCents && discountCents === 0) {
    app.log.warn(
      { orderId, orderTotal: order.totalCents, amountTotal },
      'Paid amount differs from order total with no discount — investigate price drift',
    );
  }
  const paidTotal = amountTotal ?? order.totalCents;

  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .update(tables.orders)
      .set({
        status: 'paid',
        paidAt: now,
        stripePaymentIntentId: paymentIntentId,
        totalCents: paidTotal,
        discountCents,
        updatedAt: now,
      })
      .where(
        and(
          eq(tables.orders.id, orderId),
          inArray(tables.orders.status, ['pending', 'payment_pending']),
        ),
      )
      .returning({ id: tables.orders.id });
    if (rows.length === 0) return false;
    await tx.insert(tables.orderStatusLog).values({
      orderId,
      fromStatus: order.status,
      toStatus: 'paid',
      reason:
        discountCents > 0
          ? `Stripe ${session.payment_status} · Rabatt ${formatEurFromCents(discountCents)}`
          : `Stripe ${session.payment_status}`,
    });
    return true;
  });
  if (!claimed) return;
  order.totalCents = paidTotal;

  try {
    const { customers } = tables;
    const [cust] = await db
      .insert(customers)
      .values({
        email: order.customerEmail,
        name: order.customerName,
        phone: order.customerPhone,
        totalOrders: 1,
        totalSpentCents: paidTotal,
        loyaltyTier: computeLoyaltyTier(1, paidTotal),
        firstOrderAt: now,
        lastOrderAt: now,
        marketingOptIn: order.consentMarketing,
      })
      .onConflictDoUpdate({
        target: customers.email,
        set: {
          totalOrders: sql`${customers.totalOrders} + 1`,
          totalSpentCents: sql`${customers.totalSpentCents} + ${paidTotal}`,
          name: sql`coalesce(${customers.name}, ${order.customerName})`,
          phone: sql`coalesce(${customers.phone}, ${order.customerPhone})`,
          lastOrderAt: now,
          updatedAt: now,
        },
      })
      .returning();
    if (cust) {
      const tier = computeLoyaltyTier(cust.totalOrders, cust.totalSpentCents);
      if (tier !== cust.loyaltyTier) {
        await db
          .update(customers)
          .set({ loyaltyTier: tier, updatedAt: now })
          .where(eq(customers.id, cust.id));
      }
    }
  } catch (err) {
    app.log.warn({ err, orderId }, 'customer aggregate update failed');
  }

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
      apiKey: companyRow.resendApiKey ?? undefined,
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
        apiKey: companyRow.resendApiKey ?? undefined,
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

/**
 * Roll a paid order into the customers table (lifetime totals + loyalty tier).
 * Best-effort: logs and swallows errors so it never blocks a payment.
 */
async function aggregateCustomerOnPaid(
  app: FastifyInstance,
  tables: TenantTables,
  order: {
    customerEmail: string;
    customerName: string;
    customerPhone: string | null;
    consentMarketing: boolean;
  },
  paidTotal: number,
  now: Date,
): Promise<void> {
  try {
    const { customers } = tables;
    const [cust] = await db
      .insert(customers)
      .values({
        email: order.customerEmail,
        name: order.customerName,
        phone: order.customerPhone,
        totalOrders: 1,
        totalSpentCents: paidTotal,
        loyaltyTier: computeLoyaltyTier(1, paidTotal),
        firstOrderAt: now,
        lastOrderAt: now,
        marketingOptIn: order.consentMarketing,
      })
      .onConflictDoUpdate({
        target: customers.email,
        set: {
          totalOrders: sql`${customers.totalOrders} + 1`,
          totalSpentCents: sql`${customers.totalSpentCents} + ${paidTotal}`,
          name: sql`coalesce(${customers.name}, ${order.customerName})`,
          phone: sql`coalesce(${customers.phone}, ${order.customerPhone})`,
          lastOrderAt: now,
          updatedAt: now,
        },
      })
      .returning();
    if (cust) {
      const tier = computeLoyaltyTier(cust.totalOrders, cust.totalSpentCents);
      if (tier !== cust.loyaltyTier) {
        await db
          .update(customers)
          .set({ loyaltyTier: tier, updatedAt: now })
          .where(eq(customers.id, cust.id));
      }
    }
  } catch (err) {
    app.log.warn({ err }, 'customer aggregate update failed');
  }
}

/**
 * Record a credit-card payment for a "pay after service" order paid via a
 * payment link. Idempotent on paidAt. Unlike markOrderPaid it does NOT change
 * the service status (the admin drives that) and does NOT resend booking emails
 * (those were sent at checkout time).
 */
async function markAfterServicePaid(
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
    app.log.warn({ orderId, companySlug }, 'after-service webhook for unknown order');
    return;
  }
  if (order.paidAt) return; // already settled — idempotent

  const paymentIntentId =
    typeof session.payment_intent === 'string' ? session.payment_intent : null;
  const now = new Date();
  const paidTotal =
    typeof session.amount_total === 'number' ? session.amount_total : order.totalCents;

  const claimed = await db.transaction(async (tx) => {
    const rows = await tx
      .update(tables.orders)
      .set({
        paidAt: now,
        paymentMethod: 'credit_card',
        stripePaymentIntentId: paymentIntentId,
        updatedAt: now,
      })
      .where(and(eq(tables.orders.id, orderId), isNull(tables.orders.paidAt)))
      .returning({ id: tables.orders.id });
    if (rows.length === 0) return false;
    await tx.insert(tables.orderStatusLog).values({
      orderId,
      fromStatus: order.status,
      toStatus: order.status,
      reason: 'Zahlung erhalten · Kreditkarte (Online)',
    });
    return true;
  });
  if (!claimed) return;

  await aggregateCustomerOnPaid(app, tables, order, paidTotal, now);
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
    const refundedTotal = refundAmountCents ?? order.totalCents;
    if (refundedTotal <= order.refundedAmountCents) return;
    const isFull = refundedTotal >= order.totalCents;
    const toStatus: OrderStatus = isFull ? 'refunded' : 'partially_refunded';
    await db.transaction(async (tx) => {
      await tx
        .update(tables.orders)
        .set({
          status: toStatus,
          refundedAmountCents: refundedTotal,
          ...(isFull ? { refundedAt: now } : {}),
          updatedAt: now,
        })
        .where(eq(tables.orders.id, order.id));
      await tx.insert(tables.orderStatusLog).values({
        orderId: order.id,
        fromStatus: order.status,
        toStatus,
        reason: `Stripe charge.refunded · ${formatEurFromCents(refundedTotal)}`,
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
      toStatus,
      refundCents: refundedTotal,
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
      'partially_refunded',
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

  // --- Pay-after-service collection ----------------------------------------

  const recordPaymentSchema = z.object({
    /** Offline methods settled in person on handover. */
    method: z.enum(['cash', 'ec_card']),
  });

  /** Mark an after-service order paid in cash or by EC card (collected in person). */
  app.post('/:id/record-payment', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { method } = recordPaymentSchema.parse(request.body);
    const { orders, orderStatusLog } = request.company!.tables;
    const adminId = request.authUser!.id;
    const now = new Date();

    const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!row) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }
    if (row.paymentMode !== 'after_service') {
      reply.code(400).send({ error: 'Nur für Aufträge mit Zahlung nach Leistung.' });
      return;
    }
    if (row.paidAt) {
      reply.code(409).send({ error: 'Auftrag ist bereits als bezahlt markiert.' });
      return;
    }

    const methodLabel = method === 'cash' ? 'Barzahlung' : 'EC-Kartenzahlung';
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(orders)
        .set({ paidAt: now, paymentMethod: method, handledByUserId: adminId, updatedAt: now })
        .where(eq(orders.id, id))
        .returning();
      if (!u) throw new Error('Order row vanished while recording payment');
      await tx.insert(orderStatusLog).values({
        orderId: id,
        fromStatus: row.status,
        toStatus: row.status,
        changedByUserId: adminId,
        reason: `Zahlung erhalten · ${methodLabel}`,
      });
      return u;
    });

    await aggregateCustomerOnPaid(app, request.company!.tables, row, updated.totalCents, now);

    return { order: { ...updated, orderNumber: orderNumberFor(updated.id) } };
  });

  /**
   * Create a Stripe credit-card payment link for an after-service order and
   * email it to the customer. The webhook marks the order paid on completion.
   */
  app.post('/:id/payment-link', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { orders, orderStatusLog } = request.company!.tables;
    const adminId = request.authUser!.id;
    const now = new Date();

    if (!stripeConfigured) {
      reply.code(503).send({ error: 'Stripe not configured on this server' });
      return;
    }

    const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!row) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }
    if (row.paymentMode !== 'after_service') {
      reply.code(400).send({ error: 'Nur für Aufträge mit Zahlung nach Leistung.' });
      return;
    }
    if (row.paidAt) {
      reply.code(409).send({ error: 'Auftrag ist bereits als bezahlt markiert.' });
      return;
    }

    const [companyRow] = await db
      .select()
      .from(company)
      .where(eq(company.slug, request.company!.slug))
      .limit(1);
    if (!companyRow) throw notFound('Company not found');

    const appBase = env.APP_BASE_URL.replace(/\/$/, '');
    const storefrontOrigin = (companyRow.storefrontOrigin ?? appBase).replace(/\/$/, '');
    const orderNumber = orderNumberFor(row.id);

    const session = await getStripe().checkout.sessions.create({
      mode: 'payment',
      payment_method_types: ['card'],
      currency: 'eur',
      line_items: [
        {
          quantity: 1,
          price_data: {
            currency: 'eur',
            unit_amount: row.totalCents,
            product_data: {
              name: `${companyRow.name} · ${KIND_LABEL[row.kind] ?? row.kind}`,
              description: `Auftrag ${orderNumber}`,
            },
            tax_behavior: 'inclusive',
          },
        },
      ],
      customer_email: row.customerEmail,
      client_reference_id: String(row.id),
      metadata: {
        orderId: String(row.id),
        companySlug: request.company!.slug,
        publicToken: row.publicToken,
        kind: row.kind,
        afterService: '1',
      },
      success_url: `${storefrontOrigin}/buchung/erfolg?token=${row.publicToken}&session_id={CHECKOUT_SESSION_ID}`,
      cancel_url: `${storefrontOrigin}/bestellung?token=${row.publicToken}`,
      locale: 'de',
      billing_address_collection: 'auto',
    });

    await db
      .update(orders)
      .set({ stripeSessionId: session.id, updatedAt: now })
      .where(eq(orders.id, id));
    await db.insert(orderStatusLog).values({
      orderId: id,
      fromStatus: row.status,
      toStatus: row.status,
      changedByUserId: adminId,
      reason: 'Zahlungslink (Kreditkarte) erstellt & versendet',
    });

    try {
      const brand = brandInfoFromCompany(companyRow);
      await sendEmail({
        to: row.customerEmail,
        from: brandSender(companyRow),
        apiKey: companyRow.resendApiKey ?? undefined,
        replyTo: companyRow.email ?? undefined,
        email: paymentRequestEmail({
          brand,
          customerName: row.customerName,
          orderNumber,
          totalFormatted: formatEurFromCents(row.totalCents),
          payUrl: session.url ?? storefrontOrigin,
        }),
      });
    } catch (err) {
      request.log.error({ err, orderId: id }, 'payment-link email failed');
    }

    return { checkoutUrl: session.url };
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
          apiKey: companyRow.resendApiKey ?? undefined,
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
      'partially_refunded',
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

  const assignSchema = z.object({ partnerId: z.number().int().positive() });

  app.post('/:id/assign', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { partnerId } = assignSchema.parse(request.body);
    const { orders, partners } = request.company!.tables;
    const now = new Date();

    const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!order) throw notFound('Order not found');

    const [partner] = await db.select().from(partners).where(eq(partners.id, partnerId)).limit(1);
    if (!partner) throw notFound('Partner not found on this company');
    if (partner.status !== 'active') {
      throw badRequest('Partner is not active — approve them before assigning orders');
    }

    const split = computeCommission(order.totalCents, parseCommissionRate(partner.commissionRate));

    const [updated] = await db
      .update(orders)
      .set({
        assignedPartnerId: partnerId,
        assignedAt: now,
        commissionCents: split.commissionCents,
        partnerPayoutCents: split.partnerPayoutCents,
        payoutStatus: order.payoutStatus === 'paid' ? 'paid' : 'pending',
        updatedAt: now,
      })
      .where(eq(orders.id, id))
      .returning();

    const payoutReady = partner.payoutsEnabled && partner.stripeConnectStatus === 'active';
    return {
      order: { ...updated, orderNumber: orderNumberFor(updated!.id) },
      commission: split,
      payoutReady,
      warning: payoutReady
        ? null
        : 'Partner has not completed Stripe Connect onboarding — payout will fail until they do.',
    };
  });

  app.post('/:id/unassign', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { orders } = request.company!.tables;
    const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!order) throw notFound('Order not found');
    if (order.payoutStatus === 'paid') {
      throw conflict('Cannot unassign — partner has already been paid out for this order');
    }
    const [updated] = await db
      .update(orders)
      .set({
        assignedPartnerId: null,
        assignedAt: null,
        commissionCents: null,
        partnerPayoutCents: null,
        payoutStatus: 'none',
        updatedAt: new Date(),
      })
      .where(eq(orders.id, id))
      .returning();
    return { order: { ...updated, orderNumber: orderNumberFor(updated!.id) } };
  });

  app.post(
    '/:id/payout',
    { preHandler: app.requireAccess('super_admin', 'admin', 'manager') },
    async (request, reply) => {
      const id = parseIntId((request.params as { id: string }).id);
      const { orders, partners } = request.company!.tables;
      const now = new Date();

      if (!stripeConfigured) {
        reply.code(503).send({ error: 'Stripe not configured on this server' });
        return;
      }

      const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
      if (!order) throw notFound('Order not found');
      if (order.stripeTransferId || order.payoutStatus === 'paid') {
        throw conflict('Partner has already been paid out for this order');
      }
      if (!order.assignedPartnerId || order.partnerPayoutCents == null) {
        throw badRequest('Order has no assigned partner / computed payout — assign it first');
      }
      const payable: OrderStatus[] = [
        'paid',
        'accepted',
        'picked_up',
        'in_cleaning',
        'ready',
        'delivered',
        'completed',
      ];
      if (!payable.includes(order.status as OrderStatus)) {
        throw badRequest(`Order status "${order.status}" is not payable`);
      }
      if (!order.stripePaymentIntentId) {
        throw badRequest('Order has no payment intent — cannot source the transfer');
      }

      const [partner] = await db
        .select()
        .from(partners)
        .where(eq(partners.id, order.assignedPartnerId))
        .limit(1);
      if (!partner?.stripeConnectId || !partner.payoutsEnabled) {
        throw badRequest('Partner has not completed Stripe Connect onboarding');
      }

      const stripe = getStripe();
      const pi = await stripe.paymentIntents.retrieve(order.stripePaymentIntentId);
      const chargeId =
        typeof pi.latest_charge === 'string' ? pi.latest_charge : pi.latest_charge?.id;
      if (!chargeId) throw badRequest('Could not resolve the funding charge for this order');

      let transferId: string;
      try {
        const transfer = await stripe.transfers.create(
          {
            amount: order.partnerPayoutCents,
            currency: (order.currency ?? 'eur').toLowerCase(),
            destination: partner.stripeConnectId,
            source_transaction: chargeId,
            transfer_group: `order_${request.company!.slug}_${order.id}`,
            metadata: {
              companySlug: request.company!.slug,
              orderId: String(order.id),
              partnerId: String(partner.id),
            },
          },
          {
            idempotencyKey: `payout_${request.company!.slug}_${order.id}`,
          },
        );
        transferId = transfer.id;
      } catch (err) {
        request.log.error({ err, orderId: id }, 'Stripe partner transfer failed');
        await db
          .update(orders)
          .set({ payoutStatus: 'failed', updatedAt: now })
          .where(eq(orders.id, id));
        reply.code(502).send({ error: 'Stripe transfer failed' });
        return;
      }

      const [updated] = await db
        .update(orders)
        .set({ stripeTransferId: transferId, payoutStatus: 'paid', payoutAt: now, updatedAt: now })
        .where(eq(orders.id, id))
        .returning();
      return {
        order: { ...updated, orderNumber: orderNumberFor(updated!.id) },
        transferId,
        payoutCents: order.partnerPayoutCents,
      };
    },
  );

  const upsellSchema = z.object({
    code: z.string().min(1).max(64),
    label: z.string().min(1).max(200),
    quantityLabel: z.string().min(1).max(80),
    quantity: z.number().positive().max(100000),
    unitPriceCents: z.number().int().min(0).max(100_000_000),
  });
  const NON_EDITABLE: OrderStatus[] = ['cancelled', 'refunded', 'partially_refunded'];

  async function commissionPatch(
    tables: TenantTables,
    order: { assignedPartnerId: number | null; payoutStatus: string },
    newTotal: number,
  ): Promise<Record<string, number>> {
    if (!order.assignedPartnerId || order.payoutStatus === 'paid') return {};
    const [partner] = await db
      .select({ commissionRate: tables.partners.commissionRate })
      .from(tables.partners)
      .where(eq(tables.partners.id, order.assignedPartnerId))
      .limit(1);
    const split = computeCommission(newTotal, parseCommissionRate(partner?.commissionRate));
    return { commissionCents: split.commissionCents, partnerPayoutCents: split.partnerPayoutCents };
  }

  app.post('/:id/upsell', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = upsellSchema.parse(request.body);
    const tables = request.company!.tables;
    const { orders, orderItems } = tables;
    const now = new Date();

    const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!order) throw notFound('Order not found');
    if (NON_EDITABLE.includes(order.status as OrderStatus)) {
      throw badRequest(`Cannot modify an order in status "${order.status}"`);
    }
    if (order.payoutStatus === 'paid') {
      throw conflict('Partner already paid out — cannot change the order total');
    }
    const addCents = Math.round(body.quantity * body.unitPriceCents);
    const newTotal = order.totalCents + addCents;
    const commission = await commissionPatch(tables, order, newTotal);

    const updated = await db.transaction(async (tx) => {
      await tx.insert(orderItems).values({
        orderId: id,
        code: body.code,
        label: body.label,
        quantityLabel: body.quantityLabel,
        quantity: body.quantity.toFixed(2),
        unitPriceCents: body.unitPriceCents,
        subtotalCents: addCents,
        metadata: { upsell: true },
      });
      const [u] = await tx
        .update(orders)
        .set({
          subtotalCents: order.subtotalCents + addCents,
          totalCents: newTotal,
          ...commission,
          updatedAt: now,
        })
        .where(eq(orders.id, id))
        .returning();
      return u!;
    });

    return {
      order: { ...updated, orderNumber: orderNumberFor(updated.id) },
      topUpCents: addCents,
    };
  });

  const adjustSchema = z.object({
    items: z
      .array(
        z.object({
          code: z.string().min(1).max(64),
          label: z.string().min(1).max(200),
          quantityLabel: z.string().min(1).max(80),
          quantity: z.number().positive().max(100000),
          unitPriceCents: z.number().int().min(0).max(100_000_000),
        }),
      )
      .min(1)
      .max(50),
    reason: z.string().trim().max(500).optional(),
  });

  app.post('/:id/adjust', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = adjustSchema.parse(request.body);
    const { orders, orderItems, orderStatusLog } = request.company!.tables;
    const adminId = request.authUser!.id;
    const now = new Date();

    const tables = request.company!.tables;
    const [order] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!order) throw notFound('Order not found');
    if (NON_EDITABLE.includes(order.status as OrderStatus)) {
      throw badRequest(`Cannot adjust an order in status "${order.status}"`);
    }
    if (order.payoutStatus === 'paid') {
      throw conflict('Partner already paid out — cannot change the order total');
    }

    const lines = body.items.map((l) => ({
      orderId: id,
      code: l.code,
      label: l.label,
      quantityLabel: l.quantityLabel,
      quantity: l.quantity.toFixed(2),
      unitPriceCents: l.unitPriceCents,
      subtotalCents: Math.round(l.quantity * l.unitPriceCents),
    }));
    const newSubtotal = lines.reduce((a, l) => a + l.subtotalCents, 0);
    const book = getPriceBook(request.company!.slug);
    const minOrderCents =
      order.kind === 'teppichreinigung'
        ? (book?.carpetCleaning?.minOrderCents ?? 0)
        : order.kind === 'polsterreinigung'
          ? (book?.upholstery?.minOrderCents ?? 0)
          : 0;
    const grossBeforeMin = newSubtotal + order.pickupFeeCents;
    const minOrderTopUpCents = grossBeforeMin < minOrderCents ? minOrderCents - grossBeforeMin : 0;
    const newTotal = grossBeforeMin + minOrderTopUpCents;
    const deltaCents = newTotal - order.totalCents;
    const commission = await commissionPatch(tables, order, newTotal);

    const updated = await db.transaction(async (tx) => {
      await tx.delete(orderItems).where(eq(orderItems.orderId, id));
      await tx.insert(orderItems).values(lines);
      const [u] = await tx
        .update(orders)
        .set({
          subtotalCents: newSubtotal,
          minOrderTopUpCents,
          totalCents: newTotal,
          ...commission,
          updatedAt: now,
        })
        .where(eq(orders.id, id))
        .returning();
      await tx.insert(orderStatusLog).values({
        orderId: id,
        fromStatus: order.status,
        toStatus: order.status,
        changedByUserId: adminId,
        reason: `Korrektur (${deltaCents >= 0 ? '+' : ''}${formatEurFromCents(deltaCents)})${body.reason ? ` · ${body.reason}` : ''}`,
      });
      return u!;
    });

    const isPaid = order.paidAt != null;
    return {
      order: { ...updated, orderNumber: orderNumberFor(updated.id) },
      deltaCents,
      refundDueCents: isPaid && deltaCents < 0 ? -deltaCents : 0,
    };
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
      'partially_refunded',
      'refunded',
    ])
    .optional(),
});

export const ordersAdminCrossRoutes: FastifyPluginAsync = async (app) => {
  app.get('/orders/all', async (request) => {
    const { limit, status } = crossListQuerySchema.parse(request.query);
    const { loadAllActiveCompanies } = await import('../../lib/company-loader.js');
    const { getTenantTables } = await import('../../db/schema/tenant.js');
    const { membership } = await import('../../db/schema/shared.js');

    const allCompanies = await loadAllActiveCompanies();
    const isSuperAdmin =
      (request.authUser as unknown as { accessLevel?: string }).accessLevel === 'super_admin';
    let companies = allCompanies;
    if (!isSuperAdmin) {
      const mine = await db
        .select({ slug: membership.companySlug })
        .from(membership)
        .where(eq(membership.userId, request.authUser!.id));
      const allowed = new Set(mine.map((m) => m.slug));
      companies = allCompanies.filter((c) => allowed.has(c.slug));
    }

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

const partnerTransitionSchema = z.object({
  toStatus: z.enum(['picked_up', 'in_cleaning', 'ready', 'delivered']),
  reason: z.string().trim().max(500).optional(),
});

export const ordersPartnerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);

  async function resolvePartnerId(userId: string, tables: TenantTables): Promise<number | null> {
    const [p] = await db
      .select({ id: tables.partners.id })
      .from(tables.partners)
      .where(eq(tables.partners.userId, userId))
      .limit(1);
    return p?.id ?? null;
  }

  function toPartnerView(row: Record<string, unknown>) {
    const {
      customerEmail: _e,
      internalNotes: _n,
      ipAddress: _i,
      userAgent: _u,
      stripeSessionId: _s,
      stripePaymentIntentId: _p,
      stripeTransferId: _t,
      ...safe
    } = row;
    return { ...safe, orderNumber: orderNumberFor(Number(row.id)) };
  }

  app.get('/', async (request, reply) => {
    const userId = request.authUser!.id;
    const tables = request.company!.tables;
    const partnerId = await resolvePartnerId(userId, tables);
    if (!partnerId) {
      reply.send({ orders: [] });
      return;
    }
    const { limit, cursor, status } = listQuerySchema.parse(request.query);
    const { orders } = tables;
    const decoded = cursor ? decodeCursor(cursor) : null;
    const conds = [eq(orders.assignedPartnerId, partnerId)];
    if (status) conds.push(eq(orders.status, status));
    if (decoded) {
      const cursorWhere = or(
        lt(orders.createdAt, sql`${decoded.createdAt}::timestamptz`),
        and(
          sql`${orders.createdAt} = ${decoded.createdAt}::timestamptz`,
          lt(orders.id, decoded.id),
        ),
      );
      if (cursorWhere) conds.push(cursorWhere);
    }
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
    reply.send({ orders: page.map(toPartnerView), nextCursor });
  });

  app.get('/:id', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const userId = request.authUser!.id;
    const tables = request.company!.tables;
    const partnerId = await resolvePartnerId(userId, tables);
    const { orders, orderItems, orderStatusLog } = tables;
    const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!row || row.assignedPartnerId !== partnerId) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }
    const items = await db.select().from(orderItems).where(eq(orderItems.orderId, id));
    const log = await db
      .select()
      .from(orderStatusLog)
      .where(eq(orderStatusLog.orderId, id))
      .orderBy(desc(orderStatusLog.createdAt));
    reply.send({
      order: toPartnerView(row),
      items,
      statusLog: log,
      allowedNextStatuses: allowedNextStatuses(row.status as OrderStatus).filter((s) =>
        (['picked_up', 'in_cleaning', 'ready', 'delivered'] as OrderStatus[]).includes(s),
      ),
    });
  });

  app.post('/:id/transition', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { toStatus, reason } = partnerTransitionSchema.parse(request.body);
    const userId = request.authUser!.id;
    const tables = request.company!.tables;
    const partnerId = await resolvePartnerId(userId, tables);
    const { orders, orderStatusLog } = tables;
    const now = new Date();

    const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!row || row.assignedPartnerId !== partnerId) {
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

    const timestampCol = statusTimestampColumn(toStatus);
    const patch: Record<string, unknown> = { status: toStatus, updatedAt: now };
    if (timestampCol) patch[timestampCol] = now;

    const updated = await db.transaction(async (tx) => {
      const [u] = await tx.update(orders).set(patch).where(eq(orders.id, id)).returning();
      if (!u) throw new Error('Order row vanished mid-transition');
      await tx.insert(orderStatusLog).values({
        orderId: id,
        fromStatus: row.status,
        toStatus,
        changedByUserId: userId,
        reason: reason ?? 'Partner update',
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

    reply.send({ order: toPartnerView(updated) });
  });
};
