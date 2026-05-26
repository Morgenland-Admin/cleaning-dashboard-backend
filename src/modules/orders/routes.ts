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

// Human labels for emails / admin UI.
const KIND_LABEL: Record<string, string> = {
  teppichreinigung: 'Teppichreinigung',
  teppichreparatur: 'Teppichreparatur',
  polsterreinigung: 'Polsterreinigung (Vor-Ort)',
};

function orderNumberFor(id: number): string {
  // Six-digit zero-padded counter behind the year. Sequential is fine — we
  // already have a serial PK; the year prefix gives operators a quick visual.
  const year = new Date().getUTCFullYear();
  return `${year}/${String(id).padStart(6, '0')}`;
}

// ---------------------------------------------------------------------------
//  Customer status-change notifications (ALL_10)
//
//  Called from both the admin /transition route and the /cancel route. Sends
//  one email per status flip using the per-status copy registry in
//  templates.ts. Failure here is intentionally swallowed — the status flip
//  itself already succeeded; we only log so ops can alert on a backlog.
//
//  Skipped statuses (we don't email on these):
//    - pending / payment_pending: no useful info for customer yet
//    - paid: already covered by the rich orderConfirmationEmail at checkout
// ---------------------------------------------------------------------------

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
  /** Only meaningful for cancelled / refunded transitions. */
  refundCents?: number;
}

async function notifyCustomerStatusChange(args: NotifyCustomerArgs): Promise<void> {
  // Skip statuses where the customer doesn't benefit from a message OR where
  // a different (richer) template already fires.
  if (!isStatusEmailableStatus(args.toStatus)) return;
  if (args.toStatus === args.fromStatus) return; // shouldn't happen, but defensive

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

// ---------------------------------------------------------------------------
// Public storefront routes — no auth, X-Company-Slug resolves the tenant.
// Mounted at /storefront/orders.
// ---------------------------------------------------------------------------

export const ordersPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  // ---- POST /quote ---------------------------------------------------------
  // Stateless price preview. The storefront calls this on every wizard step so
  // the customer sees the up-to-date total. No DB, no Stripe.
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

  // ---- POST /checkout ------------------------------------------------------
  // Creates a DRAFT order + Stripe Checkout Session. On Stripe success we flip
  // the order to "paid" via the webhook. The client redirects to session.url.
  app.post(
    '/checkout',
    { config: { rateLimit: { max: 8, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!stripeConfigured) {
        reply.code(503).send({ error: 'Payments are not configured on this server' });
        return;
      }

      const body: CheckoutInput = checkoutSchema.parse(request.body);

      // Honeypot — silently 200 without writing anything.
      if (body.website && body.website.trim().length > 0) {
        reply.code(200).send({ ok: true, checkoutUrl: null });
        return;
      }

      // Polster requires a preferred date for the on-site appointment.
      if (body.kind === 'polsterreinigung' && !body.preferredDate) {
        reply.code(400).send({ error: 'preferredDate ist für Polsterreinigung erforderlich' });
        return;
      }

      const book = getPriceBook(request.company!.slug);
      if (!book) {
        reply.code(404).send({ error: 'Unbekannte Marke' });
        return;
      }

      // Re-run pricing server-side. Clients only submit a configuration, never
      // a price — this is the source-of-truth for what we charge.
      const quote = priceOrder(toServiceInput(body), book);
      if (quote.outOfArea || quote.lines.length === 0 || quote.totalCents <= 0) {
        reply.code(400).send({
          error: quote.outOfAreaReason ?? 'Auftrag konnte nicht berechnet werden',
        });
        return;
      }

      // Pull the company row for sender/branding + admin URL.
      const [companyRow] = await db
        .select()
        .from(company)
        .where(eq(company.slug, request.company!.slug))
        .limit(1);
      if (!companyRow) throw notFound('Company not found');

      const { orders, orderItems, orderStatusLog } = request.company!.tables;
      const publicToken = generateOrderToken();
      const pickupMode = body.kind === 'polsterreinigung' ? 'onsite' : body.pickupMode;

      // Address only for pickup / onsite — drop_off has no shipping address.
      const addressForOrder =
        body.kind === 'polsterreinigung'
          ? body.address
          : body.pickupMode === 'pickup'
            ? body.address
            : undefined;

      // PLZ + zone are derived from the priced quote, not the body, to keep
      // the engine the single source of truth.
      const pickupPlz =
        body.kind === 'polsterreinigung'
          ? body.addressPlz
          : body.pickupMode === 'pickup'
            ? body.pickupPlz
            : null;
      const pickupZone =
        pickupPlz && !quote.outOfArea
          ? (await import('../../lib/pickup-zones.js')).resolvePickupZone(pickupPlz).zone
          : null;

      const now = new Date();

      // Insert order + items + status-log atomically.
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
            preferredDate: body.preferredDate ?? null,
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

      // Build Stripe line items. We bundle the entire order into ONE Stripe
      // line item priced at totalCents — keeps the receipt clean and avoids
      // edge cases where Stripe's rounding disagrees with ours. The per-item
      // breakdown is preserved in our DB and our confirmation email.
      const stripe = getStripe();
      const appBase = env.APP_BASE_URL.replace(/\/$/, '');
      const storefrontOrigin = (companyRow.storefrontOrigin ?? appBase).replace(/\/$/, '');
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
        // 30 min checkout window — long enough for SEPA, short enough to
        // free up tokens if abandoned.
        expires_at: Math.floor(Date.now() / 1000) + 30 * 60,
        billing_address_collection: 'auto',
      });

      // Stamp the session id + flip to payment_pending.
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

  // ---- GET /:token ---------------------------------------------------------
  // Public order tracker — the link in the confirmation email points here.
  // Returns the order + status log so the customer can see "where is my carpet
  // right now" without an auth account.
  app.get('/:token', async (request, reply) => {
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

    // Strip sensitive fields the public tracker should never expose.
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
  });
};

// ---------------------------------------------------------------------------
// Stripe webhook — separate sub-plugin so we can install a buffer-keeping
// content-type parser inside an isolated Fastify scope. The parent's JSON
// parser still works for every other route.
// Mounted at /storefront/orders/webhook.
// ---------------------------------------------------------------------------

export const ordersWebhookRoutes: FastifyPluginAsync = async (app) => {
  // Replace the inherited JSON parser within this plugin scope with one that
  // keeps the raw bytes. Stripe webhook signature verification requires the
  // exact payload that was signed — JSON.stringify + re-parse changes byte
  // order and breaks the HMAC.
  app.removeContentTypeParser('application/json');
  app.addContentTypeParser('application/json', { parseAs: 'buffer' }, (_req, body, done) => {
    done(null, body); // route receives a Buffer in `request.body`
  });

  app.post('/stripe', async (request, reply) => {
    if (!stripeConfigured || !env.STRIPE_WEBHOOK_SECRET) {
      // Webhook misconfig is a 503, not 400 — Stripe will retry, which is
      // what we want until ops fix the env.
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
      // Log + return 500 so Stripe retries. The webhook handler is idempotent
      // (re-fires on a paid order are no-ops) so a retry is safe.
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

// ---------------------------------------------------------------------------
// Event dispatch — checkout.session.completed is the happy path. We also
// handle async_payment_failed (SEPA fail) and refunded to flip statuses.
// ---------------------------------------------------------------------------

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
      await markOrderRefundedByPaymentIntent(app, pi);
      return;
    }
    default:
      // Ignore other events. Keeping this default explicit prevents accidental
      // matches on future Stripe additions that look similar.
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
  // Idempotency: webhook may fire multiple times for the same session. If
  // already paid (or beyond), skip the side-effects.
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

  // Fire emails outside the tx — failure to send doesn't roll back the paid
  // state. Resend errors are logged inside sendEmail().
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
): Promise<void> {
  // Refunds can hit any tenant — we look up by stripe_payment_intent_id across
  // all known schemas. The number of tenants is small, so this is cheap.
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
    return;
  }
  app.log.warn({ paymentIntentId }, 'Refund webhook for unknown payment intent');
}

// ---------------------------------------------------------------------------
// Admin routes — list / detail / status transitions.
// Mounted at /admin/orders. Requires audience=admin (added in routes/admin.ts).
// ---------------------------------------------------------------------------

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

  // Status transition — validates against the FSM. Refund triggers a Stripe
  // refund via the API if a PaymentIntent exists.
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

    // Refund: hit Stripe before we flip DB state. If the Stripe call fails
    // we never commit the refunded status — the admin can retry.
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

    // Customer notification — fire and forget. Failure logged but doesn't
    // affect the API response (the transition itself already succeeded).
    void notifyCustomerStatusChange({
      log: request.log,
      companySlug: request.company!.slug,
      order: { ...updated, orderNumber: orderNumberFor(updated.id) },
      fromStatus: row.status as OrderStatus,
      toStatus,
    }).catch(() => null);

    return { order: { ...updated, orderNumber: orderNumberFor(updated.id) } };
  });

  // ---- Cancellation (ALL_06) --------------------------------------------
  // Two-step: GET /preview returns the decision so the UI can show the right
  // modal copy; POST /cancel applies it (refund + status flip).

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

    // Refund — clamp override to [0, total]. Skip Stripe call if zero.
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
          amount: refundCents, // omit for full refund? — explicit is safer + supports partial
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

    // Customer notification — fire-and-forget. Reuses the per-status email
    // pipeline (see notifyCustomerStatusChange in this file).
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
};
