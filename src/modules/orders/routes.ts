import type { FastifyPluginAsync, FastifyInstance } from 'fastify';
import { and, desc, eq, inArray, isNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import type Stripe from 'stripe';

import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { company, user } from '../../db/schema/shared.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { brandInfoFromCompany, brandSender, sendEmail } from '../../email/service.js';
import {
  isStatusEmailableStatus,
  newOrderAdminEmail,
  appointmentConfirmedEmail,
  orderConfirmationEmail,
  orderMessageEmail,
  orderStatusUpdateEmail,
  paymentRequestEmail,
} from '../../email/templates.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { linkCustomerByEmail } from '../../lib/customers.js';
import { badRequest, conflict, notFound, parseIntId } from '../../lib/http-errors.js';
import { computeCommission, parseCommissionRate } from '../../lib/commission.js';
import { computeLoyaltyTier } from '../../lib/loyalty.js';
import { captureException } from '../../lib/observability.js';
import { fireN8nWebhook } from '../../lib/n8n.js';
import { sendMetaServerEvent, type MetaEventContext } from '../../lib/meta-capi.js';
import { spawnTask } from '../../lib/tasks.js';
import { formatEurFromCents, priceOrder } from '../../lib/pricing.js';
import { getPriceBook } from '../../lib/price-books/index.js';
import { getStripe, stripeConfigured } from '../../lib/stripe.js';
import {
  paypalConfigured,
  createPayPalOrder,
  capturePayPalOrder,
  verifyPayPalWebhook,
} from '../../lib/paypal.js';
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

/** "YYYY/000123" from the creation year — never the current year. */
function formatOrderNumber(id: number, createdAt: Date): string {
  return `${createdAt.getUTCFullYear()}/${String(id).padStart(6, '0')}`;
}

/** Persisted order number; createdAt-based fallback for legacy rows. */
function orderNumberOf(row: {
  id: number;
  orderNumber?: string | null;
  createdAt?: Date | null;
}): string {
  if (row.orderNumber) return row.orderNumber;
  return formatOrderNumber(row.id, row.createdAt ?? new Date());
}

/** Per-brand card-statement suffix (Stripe: alnum + space, 22-char limit). */
function statementSuffix(companyName: string): string | undefined {
  const cleaned = companyName
    .toUpperCase()
    .replace(/[^A-Z0-9 ]/g, '')
    .trim()
    .slice(0, 12)
    .trim();
  return cleaned.length >= 2 ? cleaned : undefined;
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
      const body: CheckoutInput = checkoutSchema.parse(request.body);
      const provider: 'stripe' | 'paypal' = body.provider === 'paypal' ? 'paypal' : 'stripe';

      // After-service bookings are confirmed without an upfront charge; an admin
      // sends a Stripe link later, so they still validate against the Stripe config.
      const providerReady = provider === 'paypal' ? paypalConfigured : stripeConfigured;
      if (!providerReady) {
        reply.code(503).send({ error: 'Payments are not configured on this server' });
        return;
      }

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

      const appBase = env.APP_BASE_URL.replace(/\/$/, '');
      const storefrontOrigin = (companyRow.storefrontOrigin ?? appBase).replace(/\/$/, '');
      const paymentMode = body.paymentMode ?? 'upfront';
      const isAfterService = paymentMode === 'after_service';

      // Validate everything fallible BEFORE the insert — no orphaned rows.
      let discounts: Array<{ promotion_code: string }> | undefined;
      if (!isAfterService) {
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
        if (body.voucherCode && provider === 'paypal') {
          // Vouchers are Stripe promotion codes; PayPal-direct can't redeem them yet.
          reply
            .code(400)
            .send({ error: 'Gutscheine sind bei PayPal-Zahlung derzeit nicht verfügbar.' });
          return;
        }
        if (body.voucherCode) {
          const code = body.voucherCode.toUpperCase();
          const promo = await getStripe().promotionCodes.list({ code, active: true, limit: 1 });
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
      }

      const { orders, orderItems, orderStatusLog, customers } = request.company!.tables;
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

      const orderRow = await db.transaction(async (tx) => {
        const customerId = await linkCustomerByEmail(tx, customers, {
          email: body.customer.email,
          name: body.customer.name,
          phone: body.customer.phone ?? null,
          marketingOptIn: body.consentMarketing ?? false,
        });
        const inserted = await tx
          .insert(orders)
          .values({
            publicToken,
            customerId,
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
            metadata: {
              ...(body.preferredSlots && body.preferredSlots.length > 0
                ? { preferredSlots: body.preferredSlots }
                : {}),
              // Read by finalizePaidOrder for the Purchase event; kept private.
              ...(body.meta ? { meta: body.meta } : {}),
            },
            customerName: body.customer.name,
            customerEmail: body.customer.email.trim().toLowerCase(),
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

        // Stamp the order number from the creation year so it never drifts.
        const stampedNumber = formatOrderNumber(order.id, order.createdAt);
        await tx.update(orders).set({ orderNumber: stampedNumber }).where(eq(orders.id, order.id));
        order.orderNumber = stampedNumber;

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

      // --- Pay-after-service: no Stripe checkout, just confirm the booking. ---
      if (isAfterService) {
        try {
          const brand = brandInfoFromCompany(companyRow);
          const orderNumber = orderNumberOf(orderRow);
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

        // After-service orders skip the payment webhook — push fires here.
        try {
          const { sendPushToBrandAdmins } = await import('../../lib/push.js');
          await sendPushToBrandAdmins(request.company!.slug, {
            title: `${companyRow.name} · Neuer Auftrag (Zahlung nach Leistung)`,
            body: `${orderNumberOf(orderRow)} · ${body.customer.name} · ${formatEurFromCents(quote.totalCents)}`,
            url: `/auftraege?id=${orderRow.id}`,
            tag: `order:${orderRow.id}`,
            brandSlug: request.company!.slug,
          });
        } catch (err) {
          request.log.warn({ err, orderId: orderRow.id }, 'push dispatch failed for new order');
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

      // --- PayPal (native Orders v2): money settles directly in the PayPal account. ---
      if (provider === 'paypal') {
        let paypalOrder;
        try {
          paypalOrder = await createPayPalOrder({
            amountCents: quote.totalCents,
            referenceId: publicToken,
            // invoiceId maps the capture/webhook back to this order AND makes PayPal
            // itself reject an accidental double-pay for the same order.
            invoiceId: `${request.company!.slug}_${orderRow.id}`,
            description: `${companyRow.name} · ${KIND_LABEL[body.kind] ?? body.kind} · ${orderNumberOf(orderRow)}`,
            brandName: companyRow.name,
            idempotencyKey: `pp_create_${request.company!.slug}_${orderRow.id}`,
          });
        } catch (err) {
          request.log.error({ err, orderId: orderRow.id }, 'PayPal order creation failed');
          await markOrderCancelled(
            app,
            request.company!.slug,
            orderRow.id,
            'PayPal-Bestellung konnte nicht erstellt werden',
          );
          reply.code(502).send({
            error:
              'Die PayPal-Zahlung konnte nicht gestartet werden. Bitte versuchen Sie es erneut.',
          });
          return;
        }

        await db.transaction(async (tx) => {
          await tx
            .update(orders)
            .set({
              paymentProvider: 'paypal',
              paypalOrderId: paypalOrder.id,
              status: 'payment_pending',
              updatedAt: now,
            })
            .where(eq(orders.id, orderRow.id));
          await tx.insert(orderStatusLog).values({
            orderId: orderRow.id,
            fromStatus: 'pending',
            toStatus: 'payment_pending',
            reason: 'PayPal order created',
          });
        });

        reply.code(201).send({
          ok: true,
          orderId: orderRow.id,
          publicToken,
          provider: 'paypal',
          paypalOrderId: paypalOrder.id,
          checkoutUrl: null,
          sessionId: null,
        });
        return;
      }

      const stripe = getStripe();

      const suffix = statementSuffix(companyRow.name);
      let session: Stripe.Checkout.Session;
      try {
        session = await stripe.checkout.sessions.create(
          {
            mode: 'payment',
            // PayPal is handled by the native Orders v2 flow (lib/paypal.ts) so the
            // money lands in the PayPal account — not routed through Stripe here.
            payment_method_types: ['card', 'amazon_pay', 'link'],
            currency: 'eur',
            line_items: [
              {
                quantity: 1,
                price_data: {
                  currency: 'eur',
                  unit_amount: quote.totalCents,
                  product_data: {
                    name: `${companyRow.name} · ${KIND_LABEL[body.kind] ?? body.kind}`,
                    description: `Auftrag ${orderNumberOf(orderRow)}`,
                  },
                  tax_behavior: 'inclusive',
                },
              },
            ],
            ...(discounts ? { discounts } : {}),
            ...(suffix ? { payment_intent_data: { statement_descriptor_suffix: suffix } } : {}),
            customer_email: body.customer.email.trim().toLowerCase(),
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
          },
          { idempotencyKey: `checkout_${request.company!.slug}_${orderRow.id}` },
        );
      } catch (err) {
        // Don't strand the fresh row as an orphaned 'pending' order.
        request.log.error({ err, orderId: orderRow.id }, 'Stripe session creation failed');
        await markOrderCancelled(
          app,
          request.company!.slug,
          orderRow.id,
          'Stripe Checkout Session konnte nicht erstellt werden',
        );
        reply.code(502).send({
          error: 'Die Zahlung konnte nicht gestartet werden. Bitte versuchen Sie es erneut.',
        });
        return;
      }

      await db.transaction(async (tx) => {
        await tx
          .update(orders)
          .set({
            stripeSessionId: session.id,
            voucherCode: body.voucherCode ? body.voucherCode.toUpperCase() : null,
            status: 'payment_pending',
            updatedAt: now,
          })
          .where(eq(orders.id, orderRow.id));
        await tx.insert(orderStatusLog).values({
          orderId: orderRow.id,
          fromStatus: 'pending',
          toStatus: 'payment_pending',
          reason: 'Stripe Checkout Session created',
        });
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
        paypalOrderId: _po,
        paypalCaptureId: _pc,
        ...safe
      } = row;
      // Dispute + Meta fbp/fbc are internal; expose only the Purchase eventId
      // so the success page can fire a deduped browser Purchase.
      const { dispute: _dispute, meta: _meta, ...publicMeta } = safe.metadata ?? {};
      const metaPurchaseEventId =
        (safe.metadata as { meta?: { eventId?: string } } | null)?.meta?.eventId ?? null;
      reply.send({
        order: {
          ...safe,
          metadata: publicMeta,
          metaPurchaseEventId,
          orderNumber: orderNumberOf(row),
        },
        items,
        statusLog: log,
      });
    },
  );

  // Capture a PayPal order after the buyer approves it in the PayPal popup.
  // Called by the storefront's onApprove handler. Idempotent: finalizePaidOrder
  // and the PAYMENT.CAPTURE.COMPLETED webhook both no-op once the order is paid.
  app.post(
    '/:token/paypal/capture',
    { config: { rateLimit: { max: 12, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!paypalConfigured) {
        reply.code(503).send({ error: 'PayPal is not configured on this server' });
        return;
      }
      const token = (request.params as { token: string }).token;
      if (typeof token !== 'string' || token.length < 8 || token.length > 64) {
        reply.code(400).send({ error: 'Invalid token' });
        return;
      }
      const { orders } = request.company!.tables;
      const [row] = await db.select().from(orders).where(eq(orders.publicToken, token)).limit(1);
      if (!row) {
        reply.code(404).send({ error: 'Order not found' });
        return;
      }
      if (row.paymentProvider !== 'paypal' || !row.paypalOrderId) {
        reply.code(400).send({ error: 'Order is not a PayPal order' });
        return;
      }
      // Already finalized (capture retried, or the webhook beat us here) — succeed idempotently.
      if (row.status !== 'pending' && row.status !== 'payment_pending') {
        reply.code(200).send({ ok: true, status: row.status, publicToken: token });
        return;
      }

      let capture;
      try {
        capture = await capturePayPalOrder(
          row.paypalOrderId,
          `pp_capture_${request.company!.slug}_${row.id}`,
        );
      } catch (err) {
        request.log.error({ err, orderId: row.id }, 'PayPal capture failed');
        reply.code(502).send({ error: 'Die PayPal-Zahlung konnte nicht abgeschlossen werden.' });
        return;
      }

      // Only a COMPLETED capture means money was received. A PENDING or declined
      // capture must NOT mark the order paid — the webhook finalizes it if it later clears.
      if (capture.captureStatus !== 'COMPLETED') {
        request.log.warn(
          { orderId: row.id, orderStatus: capture.status, captureStatus: capture.captureStatus },
          'PayPal capture not COMPLETED — order left payment_pending',
        );
        reply.code(402).send({
          error: 'PayPal-Zahlung nicht abgeschlossen',
          status: capture.captureStatus ?? capture.status,
        });
        return;
      }

      await markOrderPaidPayPal(app, request.company!.slug, row.id, {
        amountCents: capture.amountCents,
        status: capture.status,
        orderId: row.paypalOrderId,
        captureId: capture.captureId,
      });

      reply.code(200).send({ ok: true, status: 'paid', publicToken: token });
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

  // Native PayPal webhook (PAYMENT.CAPTURE.* etc). Backstop to the synchronous
  // capture endpoint — reconciles the order if the buyer's browser dropped off.
  app.post('/paypal', async (request, reply) => {
    if (!paypalConfigured || !env.PAYPAL_WEBHOOK_ID) {
      reply.code(503).send({ error: 'PayPal webhook not configured' });
      return;
    }
    const raw = Buffer.isBuffer(request.body)
      ? request.body.toString('utf8')
      : typeof request.body === 'string'
        ? request.body
        : JSON.stringify(request.body ?? {});
    const h = request.headers;
    const verified = await verifyPayPalWebhook(
      {
        transmissionId: h['paypal-transmission-id'] as string | undefined,
        transmissionTime: h['paypal-transmission-time'] as string | undefined,
        transmissionSig: h['paypal-transmission-sig'] as string | undefined,
        certUrl: h['paypal-cert-url'] as string | undefined,
        authAlgo: h['paypal-auth-algo'] as string | undefined,
      },
      raw,
    );
    if (!verified) {
      request.log.warn('PayPal webhook signature verification failed');
      reply.code(400).send({ error: 'Invalid signature' });
      return;
    }

    let event: PayPalWebhookEvent;
    try {
      event = JSON.parse(raw) as PayPalWebhookEvent;
    } catch {
      reply.code(400).send({ error: 'Invalid JSON' });
      return;
    }

    try {
      await handlePayPalEvent(app, event);
    } catch (err) {
      request.log.error({ err, eventType: event.event_type }, 'PayPal webhook handler failed');
      captureException(err, { eventType: event.event_type, eventId: event.id });
      reply.code(500).send({ error: 'Webhook handler failed' });
      return;
    }

    reply.code(200).send({ received: true });
  });
};

interface PayPalWebhookEvent {
  id?: string;
  event_type?: string;
  resource?: {
    id?: string;
    invoice_id?: string;
    status?: string;
    amount?: { value?: string; currency_code?: string };
    supplementary_data?: { related_ids?: { order_id?: string; capture_id?: string } };
    links?: { href?: string; rel?: string }[];
  };
}

/** invoice_id is `${companySlug}_${orderId}` — parse it back to route the event. */
function parsePayPalInvoiceId(
  invoiceId: string | undefined,
): { companySlug: string; orderId: number } | null {
  if (typeof invoiceId !== 'string') return null;
  const idx = invoiceId.lastIndexOf('_');
  if (idx <= 0) return null;
  const companySlug = invoiceId.slice(0, idx);
  const orderId = Number(invoiceId.slice(idx + 1));
  if (!companySlug || !Number.isInteger(orderId)) return null;
  return { companySlug, orderId };
}

/** Resolve the parent capture id of a refund resource from its `up` link. */
function paypalCaptureIdFromRefund(resource: PayPalWebhookEvent['resource']): string | null {
  const fromData = resource?.supplementary_data?.related_ids?.capture_id;
  if (fromData) return fromData;
  const up = resource?.links?.find((l) => l.rel === 'up')?.href;
  const seg = up?.split('/').pop()?.split('?')[0];
  return seg && seg.length > 0 ? seg : null;
}

async function handlePayPalEvent(app: FastifyInstance, event: PayPalWebhookEvent): Promise<void> {
  const resource = event.resource ?? {};
  switch (event.event_type) {
    case 'PAYMENT.CAPTURE.COMPLETED': {
      const ref = parsePayPalInvoiceId(resource.invoice_id);
      if (!ref) {
        app.log.warn(
          { captureId: resource.id },
          'PayPal capture completed but invoice_id did not map to an order',
        );
        return;
      }
      const amountCents =
        resource.amount?.value != null ? Math.round(parseFloat(resource.amount.value) * 100) : null;
      await markOrderPaidPayPal(app, ref.companySlug, ref.orderId, {
        amountCents,
        status: 'COMPLETED',
        orderId: resource.supplementary_data?.related_ids?.order_id || null,
        captureId: typeof resource.id === 'string' ? resource.id : null,
      });
      return;
    }
    case 'PAYMENT.CAPTURE.DENIED':
    case 'PAYMENT.CAPTURE.DECLINED': {
      const ref = parsePayPalInvoiceId(resource.invoice_id);
      if (!ref) return;
      await markOrderCancelled(app, ref.companySlug, ref.orderId, `PayPal ${event.event_type}`);
      return;
    }
    case 'PAYMENT.CAPTURE.REFUNDED':
    case 'PAYMENT.CAPTURE.REVERSED': {
      const refundedCents =
        resource.amount?.value != null ? Math.round(parseFloat(resource.amount.value) * 100) : null;
      const captureId = paypalCaptureIdFromRefund(resource);
      const ref = parsePayPalInvoiceId(resource.invoice_id);
      const located = ref
        ? await markOrderRefundedPayPal(
            app,
            ref.companySlug,
            ref.orderId,
            refundedCents,
            event.event_type,
          )
        : captureId
          ? await markOrderRefundedByPayPalCapture(app, captureId, refundedCents, event.event_type)
          : false;
      if (!located) {
        app.log.error(
          { refundId: resource.id, captureId, eventType: event.event_type },
          'PayPal refund/reversal could not be mapped to an order — reconcile manually',
        );
      }
      return;
    }
    default:
      app.log.info({ eventType: event.event_type }, 'Unhandled PayPal webhook event');
  }
}

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
    case 'checkout.session.expired': {
      const session = event.data.object;
      const companySlug = session.metadata?.companySlug;
      const orderIdStr = session.metadata?.orderId;
      if (!companySlug || !orderIdStr) return;
      // An expired after-service payment link must not cancel a running order.
      if (session.metadata?.afterService === '1') {
        app.log.info(
          { orderId: orderIdStr, companySlug },
          'After-service payment link expired — order untouched',
        );
        return;
      }
      await markOrderCancelled(
        app,
        companySlug,
        Number(orderIdStr),
        'Stripe Checkout Session abgelaufen (Zahlung nicht abgeschlossen)',
      );
      return;
    }
    case 'customer.subscription.updated':
    case 'customer.subscription.deleted': {
      await syncSubscriptionFromStripe(app, event.data.object);
      return;
    }
    case 'charge.dispute.created': {
      const dispute = event.data.object;
      const pi =
        typeof dispute.payment_intent === 'string'
          ? dispute.payment_intent
          : (dispute.payment_intent?.id ?? null);
      if (!pi) return;
      await markOrderDisputedByPaymentIntent(app, pi, dispute);
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

/** Mirror Stripe subscription status locally — never show 'active' for a dead sub. */
async function syncSubscriptionFromStripe(
  app: FastifyInstance,
  sub: Stripe.Subscription,
): Promise<void> {
  const statusMap: Record<string, string> = {
    active: 'active',
    trialing: 'active',
    paused: 'paused',
    past_due: 'past_due',
    unpaid: 'past_due',
    incomplete: 'past_due',
    incomplete_expired: 'cancelled',
    canceled: 'cancelled',
  };
  const localStatus = statusMap[sub.status] ?? sub.status;
  const now = new Date();
  const { loadAllActiveCompanies } = await import('../../lib/company-loader.js');
  const { getTenantTables } = await import('../../db/schema/tenant.js');
  for (const c of await loadAllActiveCompanies()) {
    const tables = getTenantTables(c.schemaName);
    const [row] = await db
      .select()
      .from(tables.subscriptions)
      .where(eq(tables.subscriptions.stripeSubscriptionId, sub.id))
      .limit(1);
    if (!row) continue;
    if (row.status === localStatus) return;
    await db
      .update(tables.subscriptions)
      .set({
        status: localStatus,
        ...(localStatus === 'cancelled' && !row.cancelledAt ? { cancelledAt: now } : {}),
        ...(localStatus === 'paused' && !row.pausedAt ? { pausedAt: now } : {}),
        ...(localStatus === 'active' ? { pausedAt: null } : {}),
        updatedAt: now,
      })
      .where(eq(tables.subscriptions.id, row.id));
    app.log.info(
      { subscriptionId: row.id, companySlug: c.slug, stripeStatus: sub.status, localStatus },
      'Subscription synced from Stripe webhook',
    );
    return;
  }
  app.log.warn({ stripeSubscriptionId: sub.id }, 'Subscription webhook for unknown subscription');
}

/** Flag the affected order when a chargeback/dispute is opened. */
async function markOrderDisputedByPaymentIntent(
  app: FastifyInstance,
  paymentIntentId: string,
  dispute: Stripe.Dispute,
): Promise<void> {
  const { loadAllActiveCompanies } = await import('../../lib/company-loader.js');
  const { getTenantTables } = await import('../../db/schema/tenant.js');
  for (const c of await loadAllActiveCompanies()) {
    const tables = getTenantTables(c.schemaName);
    const [order] = await db
      .select()
      .from(tables.orders)
      .where(eq(tables.orders.stripePaymentIntentId, paymentIntentId))
      .limit(1);
    if (!order) continue;
    const now = new Date();
    const meta = order.metadata ?? {};
    await db.transaction(async (tx) => {
      await tx
        .update(tables.orders)
        .set({
          metadata: {
            ...meta,
            dispute: { id: dispute.id, reason: dispute.reason, openedAt: now.toISOString() },
          },
          updatedAt: now,
        })
        .where(eq(tables.orders.id, order.id));
      await tx.insert(tables.orderStatusLog).values({
        orderId: order.id,
        fromStatus: order.status,
        toStatus: order.status,
        reason: `Stripe-Zahlungsstreit (Chargeback) eröffnet · ${dispute.reason}`,
      });
    });
    app.log.error(
      { orderId: order.id, companySlug: c.slug, disputeId: dispute.id, reason: dispute.reason },
      'Chargeback opened for order',
    );
    try {
      const { sendPushToBrandAdmins } = await import('../../lib/push.js');
      await sendPushToBrandAdmins(c.slug, {
        title: `${c.name} · Chargeback eröffnet`,
        body: `${orderNumberOf(order)} · ${order.customerName} · ${formatEurFromCents(dispute.amount ?? order.totalCents)}`,
        url: `/auftraege?id=${order.id}`,
        tag: `dispute:${order.id}`,
        brandSlug: c.slug,
      });
    } catch (err) {
      app.log.warn({ err, orderId: order.id }, 'push dispatch failed for dispute');
    }
    return;
  }
  app.log.warn({ paymentIntentId }, 'Dispute webhook for unknown payment intent');
}

/** Provider-agnostic snapshot of a completed payment, fed into finalizePaidOrder. */
interface PaidInfo {
  provider: 'stripe' | 'paypal';
  /** Free-text shown in the order status log, e.g. 'paid' or 'PayPal capture COMPLETED'. */
  statusLabel: string;
  /** Amount actually charged, in cents (null if the provider didn't report it). */
  amountTotalCents: number | null;
  discountCents: number;
  stripePaymentIntentId?: string | null;
  paypalOrderId?: string | null;
  paypalCaptureId?: string | null;
}

/** Thin Stripe adapter — keeps the webhook call site unchanged. */
async function markOrderPaid(
  app: FastifyInstance,
  companySlug: string,
  orderId: number,
  session: Stripe.Checkout.Session,
): Promise<void> {
  await finalizePaidOrder(app, companySlug, orderId, {
    provider: 'stripe',
    statusLabel: session.payment_status,
    amountTotalCents: typeof session.amount_total === 'number' ? session.amount_total : null,
    discountCents: session.total_details?.amount_discount ?? 0,
    stripePaymentIntentId:
      typeof session.payment_intent === 'string' ? session.payment_intent : null,
  });
}

/** PayPal adapter — runs the same onboarding as a Stripe payment. */
async function markOrderPaidPayPal(
  app: FastifyInstance,
  companySlug: string,
  orderId: number,
  capture: {
    amountCents: number | null;
    status: string;
    orderId: string | null;
    captureId: string | null;
  },
): Promise<void> {
  await finalizePaidOrder(app, companySlug, orderId, {
    provider: 'paypal',
    statusLabel: `PayPal capture ${capture.status}`,
    amountTotalCents: capture.amountCents,
    discountCents: 0,
    paypalOrderId: capture.orderId,
    paypalCaptureId: capture.captureId,
  });
}

async function finalizePaidOrder(
  app: FastifyInstance,
  companySlug: string,
  orderId: number,
  paid: PaidInfo,
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
    app.log.warn({ orderId, companySlug, provider: paid.provider }, 'Payment for unknown order');
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

  const now = new Date();
  // Payment-identifying columns, keyed by provider. paypalOrderId is set at order
  // creation, so only overwrite it when this event actually carries a value.
  const providerCols =
    paid.provider === 'paypal'
      ? {
          paymentProvider: 'paypal' as const,
          ...(paid.paypalOrderId ? { paypalOrderId: paid.paypalOrderId } : {}),
          paypalCaptureId: paid.paypalCaptureId ?? null,
        }
      : {
          paymentProvider: 'stripe' as const,
          stripePaymentIntentId: paid.stripePaymentIntentId ?? null,
        };

  if (order.status === 'cancelled' || order.status === 'refunded') {
    // Payment landed after cancellation — record loudly, never silent-drop money.
    app.log.error(
      { orderId, companySlug, status: order.status, provider: paid.provider },
      'Payment received on a cancelled order — refund required',
    );
    await db
      .update(tables.orders)
      .set({ ...providerCols, updatedAt: now })
      .where(eq(tables.orders.id, orderId));
    await db.insert(tables.orderStatusLog).values({
      orderId,
      fromStatus: order.status,
      toStatus: order.status,
      reason: '⚠ Zahlung auf stornierten Auftrag eingegangen — Rückerstattung erforderlich',
    });
    return;
  }

  const amountTotal = paid.amountTotalCents;
  const discountCents = paid.discountCents;
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
        ...providerCols,
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
          ? `${paid.statusLabel} · Rabatt ${formatEurFromCents(discountCents)}`
          : paid.statusLabel,
    });
    return true;
  });
  if (!claimed) return;
  order.totalCents = paidTotal;

  await aggregateCustomerOnPaid(app, tables, order, paidTotal, now);

  // Server-side Meta Purchase, deduped via the eventId stored at checkout. The
  // claimed status-claim above guarantees this runs once per order.
  try {
    const metaCtx = (order.metadata as { meta?: MetaEventContext } | null)?.meta;
    if (metaCtx?.eventId) {
      await sendMetaServerEvent(
        companySlug,
        {
          eventName: 'Purchase',
          eventId: metaCtx.eventId,
          eventSourceUrl: metaCtx.eventSourceUrl,
          fbp: metaCtx.fbp,
          fbc: metaCtx.fbc,
          email: order.customerEmail,
          phone: order.customerPhone,
          clientIpAddress: order.ipAddress,
          clientUserAgent: order.userAgent,
          customData: { currency: order.currency || 'EUR', value: order.totalCents / 100 },
        },
        app.log,
      );
    }
  } catch (err) {
    app.log.warn({ err, orderId }, 'Meta Purchase CAPI dispatch failed');
  }

  // Auto-create the draft invoice for this paid order (idempotent, best-effort).
  // Replaces the n8n ALL_12 creator; a mail/render failure never blocks it.
  try {
    const { autoCreateInvoiceForPaidOrder } = await import('../invoices/auto-invoice.js');
    const res = await autoCreateInvoiceForPaidOrder(tables, order, companySlug, app.log);
    if (res.created) {
      app.log.info(
        {
          orderId,
          invoiceId: res.invoiceId,
          number: res.number,
          issued: res.issued,
          emailed: res.emailed,
        },
        'Auto-created invoice for paid order',
      );
    }
  } catch (err) {
    app.log.error({ err, orderId, companySlug }, 'Failed to auto-create invoice for paid order');
  }

  try {
    const items = await db
      .select()
      .from(tables.orderItems)
      .where(eq(tables.orderItems.orderId, orderId));

    const brand = brandInfoFromCompany(companyRow);
    const orderNumber = orderNumberOf(order);
    const trackerUrl = `${(companyRow.storefrontOrigin ?? env.APP_BASE_URL).replace(/\/$/, '')}/bestellung?token=${encodeURIComponent(order.publicToken)}`;
    const fulfillmentNote =
      order.pickupMode === 'drop_off'
        ? 'Sie können Ihren Teppich nach Voranmeldung in unserer Werkstatt in der Hamburg-Speicherstadt abgeben.'
        : order.pickupMode === 'onsite'
          ? 'Wir melden uns innerhalb eines Werktages, um den Vor-Ort-Termin zu bestätigen.'
          : 'Unser Fahrer holt Ihren Teppich ab. Wir melden uns mit dem genauen Termin.';

    const confirmRes = await sendEmail({
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
    if (!confirmRes.ok) {
      // Surface in the order's status log, not just a log line.
      app.log.error(
        { orderId, error: confirmRes.error },
        'Order confirmation email failed to send',
      );
      await db.insert(tables.orderStatusLog).values({
        orderId,
        fromStatus: 'paid',
        toStatus: 'paid',
        reason: '⚠ Bestätigungs-E-Mail an Kunden fehlgeschlagen — bitte manuell senden',
      });
    }

    if (companyRow.email) {
      const adminUrl = `${env.APP_BASE_URL.replace(/\/$/, '')}/auftraege?id=${orderId}`;
      const adminRes = await sendEmail({
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
      if (!adminRes.ok) {
        app.log.error({ orderId, error: adminRes.error }, 'New-order admin email failed to send');
      }
    }
  } catch (err) {
    app.log.error({ err, orderId }, 'Failed to send order confirmation emails');
  }

  try {
    const { sendPushToBrandAdmins } = await import('../../lib/push.js');
    await sendPushToBrandAdmins(companySlug, {
      title: `${companyRow.name} · Neuer Auftrag`,
      body: `${orderNumberOf(order)} · ${order.customerName} · ${formatEurFromCents(order.totalCents)}`,
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
    // Normalize so "Max@Web.de" and "max@web.de" aggregate into one customer.
    const email = order.customerEmail.trim().toLowerCase();
    const [cust] = await db
      .insert(customers)
      .values({
        email,
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
          // Customer may already exist (linked at order creation) — keep the
          // earliest firstOrderAt instead of leaving it null.
          firstOrderAt: sql`coalesce(${customers.firstOrderAt}, ${now})`,
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
  if (order.status === 'cancelled' || order.status === 'refunded') {
    // Payment on a cancelled order — record loudly, skip loyalty aggregation.
    app.log.error(
      { orderId, companySlug, status: order.status },
      'Payment received on a cancelled order — refund required',
    );
    const now = new Date();
    // Single transaction so the money-claim and its audit note can't diverge
    // if the process dies between them — this is exactly the case where the
    // "refund required" note must not be lost.
    await db.transaction(async (tx) => {
      const claimedRows = await tx
        .update(tables.orders)
        .set({
          paidAt: now,
          paymentMethod: 'credit_card',
          stripePaymentIntentId:
            typeof session.payment_intent === 'string' ? session.payment_intent : null,
          updatedAt: now,
        })
        .where(and(eq(tables.orders.id, orderId), isNull(tables.orders.paidAt)))
        .returning({ id: tables.orders.id });
      // Log only on a successful claim so webhook retries don't duplicate it.
      if (claimedRows.length > 0) {
        await tx.insert(tables.orderStatusLog).values({
          orderId,
          fromStatus: order.status,
          toStatus: order.status,
          reason: '⚠ Zahlung auf stornierten Auftrag eingegangen — Rückerstattung erforderlich',
        });
      }
    });
    return;
  }

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
    const now = new Date();
    const fromStatus = order.status as OrderStatus;
    const refundedTotal = refundAmountCents ?? order.totalCents;
    if (refundedTotal <= order.refundedAmountCents) return;
    if (order.status === 'refunded' || order.status === 'cancelled') {
      // Status already terminal — just record the refunded amount.
      await db
        .update(tables.orders)
        .set({
          refundedAmountCents: refundedTotal,
          ...(order.refundedAt ? {} : { refundedAt: now }),
          updatedAt: now,
        })
        .where(eq(tables.orders.id, order.id));
      return;
    }
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
        orderNumber: orderNumberOf(order),
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

/** Apply a PayPal refund/reversal to an order by company + id. Returns false if not found. */
async function markOrderRefundedPayPal(
  app: FastifyInstance,
  companySlug: string,
  orderId: number,
  refundedCents: number | null,
  label: string | undefined,
): Promise<boolean> {
  const { getTenantTables } = await import('../../db/schema/tenant.js');
  const { loadCompany } = await import('../../lib/company-loader.js');
  const companyRow = await loadCompany(companySlug);
  if (!companyRow) return false;
  const tables = getTenantTables(companyRow.schemaName);
  const [order] = await db
    .select()
    .from(tables.orders)
    .where(eq(tables.orders.id, orderId))
    .limit(1);
  if (!order) return false;

  const now = new Date();
  const fromStatus = order.status as OrderStatus;
  const refundedTotal = refundedCents ?? order.totalCents;
  if (refundedTotal <= order.refundedAmountCents) return true;

  if (order.status === 'refunded' || order.status === 'cancelled') {
    await db
      .update(tables.orders)
      .set({
        refundedAmountCents: refundedTotal,
        ...(order.refundedAt ? {} : { refundedAt: now }),
        updatedAt: now,
      })
      .where(eq(tables.orders.id, order.id));
    return true;
  }

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
      reason: `PayPal ${label ?? 'Erstattung'} · ${formatEurFromCents(refundedTotal)}`,
    });
  });
  void notifyCustomerStatusChange({
    log: app.log,
    companySlug,
    order: {
      id: order.id,
      orderNumber: orderNumberOf(order),
      customerName: order.customerName,
      customerEmail: order.customerEmail,
      publicToken: order.publicToken,
    },
    fromStatus,
    toStatus,
    refundCents: refundedTotal,
  }).catch(() => null);
  return true;
}

/** Locate an order by PayPal capture id across tenant schemas, then apply the refund. */
async function markOrderRefundedByPayPalCapture(
  app: FastifyInstance,
  captureId: string,
  refundedCents: number | null,
  label: string | undefined,
): Promise<boolean> {
  const { loadAllActiveCompanies } = await import('../../lib/company-loader.js');
  const { getTenantTables } = await import('../../db/schema/tenant.js');
  for (const c of await loadAllActiveCompanies()) {
    const tables = getTenantTables(c.schemaName);
    const [order] = await db
      .select({ id: tables.orders.id })
      .from(tables.orders)
      .where(eq(tables.orders.paypalCaptureId, captureId))
      .limit(1);
    if (!order) continue;
    return markOrderRefundedPayPal(app, c.slug, order.id, refundedCents, label);
  }
  return false;
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

const PRIVILEGED_LEVELS = new Set(['manager', 'admin', 'super_admin']);

/** Viewers don't see IP/UA, internal notes, or payment-processor IDs. */
function redactOrderPii<
  T extends {
    ipAddress?: unknown;
    userAgent?: unknown;
    internalNotes?: unknown;
    stripeSessionId?: unknown;
    stripePaymentIntentId?: unknown;
    paypalOrderId?: unknown;
    paypalCaptureId?: unknown;
  },
>(row: T, accessLevel: string | undefined): T {
  if (accessLevel && PRIVILEGED_LEVELS.has(accessLevel)) return row;
  return {
    ...row,
    ipAddress: null,
    userAgent: null,
    internalNotes: null,
    stripeSessionId: null,
    stripePaymentIntentId: null,
    paypalOrderId: null,
    paypalCaptureId: null,
  };
}

function accessLevelOf(request: { authUser: unknown }): string | undefined {
  return (request.authUser as { accessLevel?: string } | null)?.accessLevel;
}

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
    const accessLevel = accessLevelOf(request);
    return {
      orders: page.map((r) => redactOrderPii({ ...r, orderNumber: orderNumberOf(r) }, accessLevel)),
      nextCursor,
    };
  });

  // Admin-created order (phone booking, walk-in). No payment is taken here: it's
  // created as an offline `after_service`/`accepted` order, then settled later via
  // the existing payment-link / record-payment / transition actions.
  const createOrderSchema = z.object({
    kind: z.enum([
      'teppichreinigung',
      'teppichreparatur',
      'polsterreinigung',
      'teppichbodenreinigung',
    ]),
    customer: z.object({
      name: z.string().min(1).max(120),
      email: z.string().email().max(254),
      phone: z.string().max(32).optional(),
    }),
    items: z
      .array(
        z.object({
          code: z.string().max(64).optional(),
          label: z.string().min(1).max(200),
          quantityLabel: z.string().min(1).max(80),
          quantity: z.number().positive().max(100_000),
          unitPriceCents: z.number().int().min(0).max(100_000_000),
        }),
      )
      .min(1)
      .max(50),
    pickupMode: z.enum(['pickup', 'drop_off', 'onsite']).default('drop_off'),
    address: z
      .object({
        line1: z.string().min(1).max(200),
        line2: z.string().max(200).optional(),
        city: z.string().min(1).max(120),
        postalCode: z.string().regex(/^\d{5}$/, 'postalCode must be 5 digits'),
        country: z.string().length(2).optional(),
      })
      .optional(),
    preferredDate: z
      .string()
      .regex(/^\d{4}-\d{2}-\d{2}$/, 'preferredDate must be YYYY-MM-DD')
      .optional(),
    customerNotes: z.string().max(2000).optional(),
    internalNotes: z.string().max(4000).optional(),
  });

  app.post('/', async (request, reply) => {
    const callerLevel = accessLevelOf(request);
    if (!callerLevel || !PRIVILEGED_LEVELS.has(callerLevel)) {
      reply.code(403).send({ error: 'Nur Manager/Admin dürfen Aufträge anlegen.' });
      return;
    }
    const body = createOrderSchema.parse(request.body);
    const adminId = request.authUser!.id;
    const { orders, orderItems, orderStatusLog, customers } = request.company!.tables;

    // Total is recomputed from the line items server-side — never trusted from the client.
    const lines = body.items.map((it) => ({
      code: it.code ?? 'manual',
      label: it.label,
      quantityLabel: it.quantityLabel,
      quantity: it.quantity,
      unitPriceCents: it.unitPriceCents,
      subtotalCents: Math.round(it.quantity * it.unitPriceCents),
    }));
    const totalCents = lines.reduce((sum, l) => sum + l.subtotalCents, 0);
    const publicToken = generateOrderToken();
    const now = new Date();

    const orderRow = await db.transaction(async (tx) => {
      const customerId = await linkCustomerByEmail(tx, customers, {
        email: body.customer.email,
        name: body.customer.name,
        phone: body.customer.phone ?? null,
        marketingOptIn: false,
      });
      const inserted = await tx
        .insert(orders)
        .values({
          publicToken,
          customerId,
          kind: body.kind,
          status: 'accepted',
          paymentMode: 'after_service',
          acceptedAt: now,
          currency: 'EUR',
          subtotalCents: totalCents,
          pickupFeeCents: 0,
          totalCents,
          pickupMode: body.pickupMode,
          preferredDate: body.preferredDate ?? null,
          customerName: body.customer.name,
          customerEmail: body.customer.email.trim().toLowerCase(),
          customerPhone: body.customer.phone ?? null,
          addressLine1: body.address?.line1 ?? null,
          addressLine2: body.address?.line2 ?? null,
          addressCity: body.address?.city ?? null,
          addressPostalCode: body.address?.postalCode ?? null,
          addressCountry: body.address?.country ?? 'DE',
          customerNotes: body.customerNotes ?? null,
          internalNotes: body.internalNotes ?? null,
          consentPrivacy: true,
          consentMarketing: false,
          locale: 'de',
          source: 'manual_admin',
          handledByUserId: adminId,
        })
        .returning();
      const order = inserted[0];
      if (!order) throw new Error('Failed to insert order row');

      const stampedNumber = formatOrderNumber(order.id, order.createdAt);
      await tx.update(orders).set({ orderNumber: stampedNumber }).where(eq(orders.id, order.id));
      order.orderNumber = stampedNumber;

      await tx.insert(orderItems).values(
        lines.map((l) => ({
          orderId: order.id,
          code: l.code,
          label: l.label,
          quantityLabel: l.quantityLabel,
          quantity: l.quantity.toFixed(2),
          unitPriceCents: l.unitPriceCents,
          subtotalCents: l.subtotalCents,
        })),
      );

      await tx.insert(orderStatusLog).values({
        orderId: order.id,
        fromStatus: null,
        toStatus: 'accepted',
        changedByUserId: adminId,
        reason: 'Manuell erstellt',
      });
      return order;
    });

    reply.code(201);
    return { order: { ...orderRow, orderNumber: orderNumberOf(orderRow) } };
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
      order: redactOrderPii({ ...row, orderNumber: orderNumberOf(row) }, accessLevelOf(request)),
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

    // Advancing an order's status is an operational write — viewers are read-only.
    const callerLevel = accessLevelOf(request);
    if (!callerLevel || !PRIVILEGED_LEVELS.has(callerLevel)) {
      reply.code(403).send({ error: 'Nur Manager/Admin dürfen den Auftragsstatus ändern.' });
      return;
    }

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
      const lvl = accessLevelOf(request);
      if (!lvl || !PRIVILEGED_LEVELS.has(lvl)) {
        reply.code(403).send({ error: 'Nur Manager/Admin dürfen Rückerstattungen ausführen.' });
        return;
      }
      if (row.paymentProvider === 'paypal') {
        reply.code(400).send({
          error:
            'PayPal-Zahlung — bitte direkt in PayPal erstatten. Eine Stripe-Rückerstattung ist nicht möglich.',
        });
        return;
      }
      if (!row.stripePaymentIntentId) {
        reply.code(400).send({ error: 'Order has no payment intent — cannot refund via Stripe' });
        return;
      }
      if (!stripeConfigured) {
        reply.code(503).send({ error: 'Stripe not configured on this server' });
        return;
      }
      try {
        await getStripe().refunds.create(
          { payment_intent: row.stripePaymentIntentId },
          { idempotencyKey: `refund_full_${request.company!.slug}_${id}` },
        );
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
    if (toStatus === 'refunded') patch.refundedAmountCents = row.totalCents;

    // CAS on the validated status — concurrent transitions can't bypass the FSM.
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(orders)
        .set(patch)
        .where(and(eq(orders.id, id), eq(orders.status, row.status)))
        .returning();
      if (!u) return null;
      await tx.insert(orderStatusLog).values({
        orderId: id,
        fromStatus: row.status,
        toStatus,
        changedByUserId: adminId,
        reason: reason ?? null,
      });
      return u;
    });
    if (!updated) {
      if (toStatus === 'refunded') {
        // Refund already issued; the charge.refunded webhook reconciles the row.
        request.log.error(
          { orderId: id },
          'Refund issued but status CAS lost a concurrent transition — webhook will reconcile',
        );
      }
      reply.code(409).send({
        error: 'Auftrag wurde zwischenzeitlich geändert — bitte neu laden.',
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

    return { order: { ...updated, orderNumber: orderNumberOf(updated) } };
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
    // Claim on paidAt IS NULL — double-submits can't aggregate loyalty twice.
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(orders)
        .set({ paidAt: now, paymentMethod: method, handledByUserId: adminId, updatedAt: now })
        .where(and(eq(orders.id, id), isNull(orders.paidAt)))
        .returning();
      if (!u) return null;
      await tx.insert(orderStatusLog).values({
        orderId: id,
        fromStatus: row.status,
        toStatus: row.status,
        changedByUserId: adminId,
        reason: `Zahlung erhalten · ${methodLabel}`,
      });
      return u;
    });
    if (!updated) {
      reply.code(409).send({ error: 'Auftrag ist bereits als bezahlt markiert.' });
      return;
    }

    await aggregateCustomerOnPaid(app, request.company!.tables, row, updated.totalCents, now);

    return { order: { ...updated, orderNumber: orderNumberOf(updated) } };
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
    const orderNumber = orderNumberOf(row);

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
      ...(statementSuffix(companyRow.name)
        ? { payment_intent_data: { statement_descriptor_suffix: statementSuffix(companyRow.name) } }
        : {}),
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
      refundedAmountCents: row.refundedAmountCents ?? 0,
      paidAt: row.paidAt ?? null,
      preferredDate: row.preferredDate ? new Date(row.preferredDate) : null,
      confirmedSlot:
        typeof (row.metadata ?? {}).confirmedSlot === 'string'
          ? ((row.metadata as { confirmedSlot: string }).confirmedSlot ?? null)
          : null,
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
      refundedAmountCents: row.refundedAmountCents ?? 0,
      paidAt: row.paidAt ?? null,
      preferredDate: row.preferredDate ? new Date(row.preferredDate) : null,
      confirmedSlot:
        typeof (row.metadata ?? {}).confirmedSlot === 'string'
          ? ((row.metadata as { confirmedSlot: string }).confirmedSlot ?? null)
          : null,
      now,
    });

    if (!decision.allowed) {
      reply.code(409).send({ error: decision.message, decision });
      return;
    }
    if (!canTransition(row.status as OrderStatus, 'cancelled')) {
      reply.code(409).send({
        error: `Cannot transition from ${row.status} to cancelled`,
        allowedNextStatuses: allowedNextStatuses(row.status as OrderStatus),
      });
      return;
    }

    // Cap at what has not been refunded yet — never at the raw total.
    const refundCents = Math.min(
      decision.maxRefundCents,
      Math.max(0, body.refundCentsOverride ?? decision.suggestedRefundCents),
    );

    if (refundCents > 0) {
      const lvl = accessLevelOf(request);
      if (!lvl || !PRIVILEGED_LEVELS.has(lvl)) {
        reply.code(403).send({ error: 'Nur Manager/Admin dürfen Rückerstattungen ausführen.' });
        return;
      }
      if (row.paymentProvider === 'paypal') {
        reply.code(400).send({
          error:
            'PayPal-Zahlung — bitte direkt in PayPal erstatten. Stornieren Sie hier ohne Rückerstattungsbetrag.',
        });
        return;
      }
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
        // One idempotency key per order: same-amount retries dedupe, different amounts reject.
        await getStripe().refunds.create(
          {
            payment_intent: row.stripePaymentIntentId,
            amount: refundCents,
          },
          { idempotencyKey: `cancel_${request.company!.slug}_${id}` },
        );
      } catch (err) {
        request.log.error({ err, orderId: id, refundCents }, 'Stripe refund failed');
        reply.code(502).send({ error: 'Stripe refund failed' });
        return;
      }
    }

    // CAS on the evaluated status — concurrent updates become a 409.
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(orders)
        .set({
          status: 'cancelled',
          cancelledAt: now,
          updatedAt: now,
          handledByUserId: adminId,
          ...(refundCents > 0
            ? { refundedAmountCents: (row.refundedAmountCents ?? 0) + refundCents }
            : {}),
        })
        .where(and(eq(orders.id, id), eq(orders.status, row.status)))
        .returning();
      if (!u) return null;
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
    if (!updated) {
      if (refundCents > 0) {
        request.log.error(
          { orderId: id, refundCents },
          'Refund issued but cancel CAS lost a concurrent update — webhook will reconcile',
        );
      }
      reply.code(409).send({
        error: 'Auftrag wurde zwischenzeitlich geändert — bitte neu laden.',
      });
      return;
    }

    // Expire the open session so the customer can't pay after cancellation.
    if (row.status === 'payment_pending' && row.stripeSessionId && stripeConfigured) {
      try {
        await getStripe().checkout.sessions.expire(row.stripeSessionId);
      } catch (err) {
        // Already expired/completed — markOrderPaid guards late payments.
        request.log.warn({ err, orderId: id }, 'Could not expire Stripe session on cancel');
      }
    }

    void notifyCustomerStatusChange({
      log: request.log,
      companySlug: request.company!.slug,
      order: { ...updated, orderNumber: orderNumberOf(updated) },
      fromStatus: row.status as OrderStatus,
      toStatus: 'cancelled',
      refundCents,
    }).catch(() => null);

    // Notify n8n on cancel (ALL_06), fire-and-forget.
    void fireN8nWebhook(
      env.N8N_CANCEL_WEBHOOK_URL,
      {
        event: 'order.cancelled',
        companySlug: request.company!.slug,
        orderId: updated.id,
        orderNumber: orderNumberOf(updated),
        publicToken: updated.publicToken,
        fromStatus: row.status,
        toStatus: 'cancelled',
        refundCents,
        reason: body.reason ?? null,
        reasonCode: decision.reasonCode,
        customerName: updated.customerName,
        customerEmail: updated.customerEmail,
        customerPhone: updated.customerPhone,
        cancelledAt: now.toISOString(),
      },
      request.log,
    );

    spawnTask({
      companySlug: request.company!.slug,
      kind: 'order_cancellation',
      refKind: 'order',
      refId: updated.id,
      title: `Stornierung: ${orderNumberOf(updated)}`,
      body: [
        `Kunde: ${updated.customerName}`,
        `Rückerstattung: ${formatEurFromCents(refundCents)}`,
        body.reason ? `Grund: ${body.reason}` : null,
      ]
        .filter(Boolean)
        .join('\n'),
      priority: 'normal',
      metadata: { refundCents, reasonCode: decision.reasonCode },
    }).catch((err) =>
      request.log.warn({ err, orderId: updated.id }, 'cancellation task spawn failed'),
    );

    return {
      order: { ...updated, orderNumber: orderNumberOf(updated) },
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
    return { order: { ...updated, orderNumber: orderNumberOf(updated) } };
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
            orderNumber: orderNumberOf(row),
            trackerUrl,
            appointmentFormatted: formatSlotDe(slot),
          }),
        });
      }
    } catch (err) {
      request.log.error({ err, orderId: id }, 'appointment confirmation email failed');
    }

    return { order: { ...updated, orderNumber: orderNumberOf(updated) } };
  });

  // Operator proposes up to 3 pickup/appointment times directly from the panel
  // (independent of whatever the booking carried). These become the
  // `preferredSlots` the operator then confirms one of via /confirm-appointment.
  app.post('/:id/propose-slots', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { slots } = z
      .object({
        slots: z
          .array(z.string().regex(/^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}$/))
          .min(1)
          .max(3),
      })
      .parse(request.body);
    const { orders } = request.company!.tables;

    const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!row) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }

    const meta = row.metadata ?? {};
    const [updated] = await db
      .update(orders)
      .set({
        // Mirror the booking path: earliest proposed slot seeds the Wunschtermin.
        preferredDate: row.preferredDate ?? slots[0]!.slice(0, 10),
        metadata: { ...meta, preferredSlots: slots },
        updatedAt: new Date(),
      })
      .where(eq(orders.id, id))
      .returning();
    if (!updated) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }
    return { order: { ...updated, orderNumber: orderNumberOf(updated) } };
  });

  // Free-form operator message to the customer about an order — the
  // "✦ Claude compose + send" box on the panel. Sent under the order's OWN
  // brand (brand separation holds here); logged to metadata.messages (no DDL).
  app.post('/:id/message', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { body } = z.object({ body: z.string().trim().min(1).max(8000) }).parse(request.body);
    const { orders } = request.company!.tables;
    const adminId = request.authUser!.id;
    const companySlug = request.company!.slug;

    const [row] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
    if (!row) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }

    const [adminRow] = await db
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, adminId))
      .limit(1);
    const sentByName = adminRow?.name ?? null;

    const [companyRow] = await db
      .select()
      .from(company)
      .where(eq(company.slug, companySlug))
      .limit(1);
    if (!companyRow) {
      reply.code(500).send({ error: 'Company not found' });
      return;
    }

    const trackerUrl = `${(companyRow.storefrontOrigin ?? env.APP_BASE_URL).replace(/\/$/, '')}/bestellung?token=${encodeURIComponent(row.publicToken)}`;
    const result = await sendEmail({
      to: row.customerEmail,
      from: brandSender(companyRow),
      apiKey: companyRow.resendApiKey ?? undefined,
      replyTo: companyRow.email ?? undefined,
      email: orderMessageEmail({
        brand: brandInfoFromCompany(companyRow),
        customerName: row.customerName,
        orderNumber: orderNumberOf(row),
        messageBody: body,
        signedBy: sentByName,
        trackerUrl,
      }),
    });
    if (!result.ok) {
      request.log.error({ orderId: id, error: result.error }, 'order message email failed');
      reply
        .code(502)
        .send({ error: 'E-Mail konnte nicht gesendet werden. Bitte erneut versuchen.' });
      return;
    }

    const meta = (row.metadata ?? {}) as { messages?: unknown[] };
    const messages = Array.isArray(meta.messages) ? meta.messages : [];
    messages.push({
      body,
      sentByUserId: adminId,
      sentByName,
      sentAt: new Date().toISOString(),
      emailMessageId: result.id ?? (result.skipped ? 'skipped' : null),
    });
    const [updated] = await db
      .update(orders)
      .set({ metadata: { ...meta, messages }, updatedAt: new Date() })
      .where(eq(orders.id, id))
      .returning();

    reply.code(201);
    return { order: { ...(updated ?? row), orderNumber: orderNumberOf(updated ?? row) } };
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
        order: { ...row, orderNumber: orderNumberOf(row) },
        stripe: { sessionStatus: session.status, paymentStatus: session.payment_status },
        action: 'noop',
      });
      return;
    }

    if (paid) {
      await markOrderPaid(app, companySlug, id, session);
      const [updated] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
      reply.send({
        order: updated ? { ...updated, orderNumber: orderNumberOf(updated) } : null,
        stripe: { sessionStatus: session.status, paymentStatus: session.payment_status },
        action: 'marked_paid',
      });
      return;
    }

    if (session.status === 'expired') {
      await markOrderCancelled(app, companySlug, id, 'Stripe session expired');
      const [updated] = await db.select().from(orders).where(eq(orders.id, id)).limit(1);
      reply.send({
        order: updated ? { ...updated, orderNumber: orderNumberOf(updated) } : null,
        stripe: { sessionStatus: session.status, paymentStatus: session.payment_status },
        action: 'marked_cancelled',
      });
      return;
    }

    reply.send({
      order: { ...row, orderNumber: orderNumberOf(row) },
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

    try {
      const { sendPushToUser } = await import('../../lib/push.js');
      await sendPushToUser(partner.userId, {
        title: `${request.company!.name} · Neuer Auftrag zugewiesen`,
        body: `${orderNumberOf(updated!)} · ${KIND_LABEL[order.kind] ?? order.kind} · Auszahlung ${formatEurFromCents(split.partnerPayoutCents)}`,
        url: `/partner/auftraege?id=${id}`,
        tag: `assign:${id}`,
        brandSlug: request.company!.slug,
      });
    } catch (err) {
      request.log.warn({ err, orderId: id }, 'assignment push dispatch failed');
    }

    const payoutReady = partner.payoutsEnabled && partner.stripeConnectStatus === 'active';
    return {
      order: { ...updated, orderNumber: orderNumberOf(updated!) },
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
    return { order: { ...updated, orderNumber: orderNumberOf(updated!) } };
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
      // PayPal-direct orders funded the PayPal account, not the Stripe balance — there
      // is no charge to transfer from. Partner must be paid manually via PayPal.
      if (order.paymentProvider === 'paypal') {
        throw badRequest(
          'Dieser Auftrag wurde über PayPal bezahlt — eine Stripe-Connect-Auszahlung ist nicht möglich. Bitte den Partner manuell über PayPal auszahlen.',
        );
      }
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
        order: { ...updated, orderNumber: orderNumberOf(updated!) },
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
      order: { ...updated, orderNumber: orderNumberOf(updated) },
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
      order: { ...updated, orderNumber: orderNumberOf(updated) },
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
      const accessLevel = accessLevelOf(request);
      return rows.map((r) =>
        redactOrderPii(
          {
            ...r,
            orderNumber: orderNumberOf(r),
            companySlug: c.slug,
            companyName: c.name,
          },
          accessLevel,
        ),
      );
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
    // Dispute details are internal — strip them from the partner view too.
    const { dispute: _dispute, ...partnerMeta } = (safe.metadata ?? {}) as Record<string, unknown>;
    return {
      ...safe,
      metadata: partnerMeta,
      orderNumber: orderNumberOf({
        id: Number(row.id),
        orderNumber: row.orderNumber as string | null | undefined,
        createdAt: row.createdAt as Date | null | undefined,
      }),
    };
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

    // CAS: a concurrent admin cancel/refund wins, this becomes 409.
    const updated = await db.transaction(async (tx) => {
      const [u] = await tx
        .update(orders)
        .set(patch)
        .where(and(eq(orders.id, id), eq(orders.status, row.status)))
        .returning();
      if (!u) return null;
      await tx.insert(orderStatusLog).values({
        orderId: id,
        fromStatus: row.status,
        toStatus,
        changedByUserId: userId,
        reason: reason ?? 'Partner update',
      });
      return u;
    });
    if (!updated) {
      reply.code(409).send({
        error: 'Auftrag wurde zwischenzeitlich geändert — bitte neu laden.',
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

    reply.send({ order: toPartnerView(updated) });
  });
};
