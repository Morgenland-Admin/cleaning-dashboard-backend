import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { getStripe, stripeConfigured } from '../../lib/stripe.js';

// ---------------------------------------------------------------------------
//  Voucher validation (ALL_77).
//
//  Storefront endpoint. Validates a customer-entered code against the brand's
//  Stripe Coupons (each brand uses its own Stripe account, so the lookup is
//  scoped to the request's company via the existing Stripe client config —
//  which today is the platform's single account, but the response is
//  intentionally minimal so we can scope to a Connect account later).
//
//  No DB writes. Returns:
//    - valid: true + discountCents
//    - valid: false + reasonCode (not_found | expired | redeemed | inactive)
//
//  Rate limit: 20/min/IP — generous for legitimate UX (typo, paste, retry)
//  but cuts code-stuffing attacks.
// ---------------------------------------------------------------------------

const validateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[A-Z0-9_-]+$/i, 'Code may only contain letters, digits, _, -'),
  /** Total cents before discount — used to convert percent-off into a cents value. */
  subtotalCents: z.number().int().min(0).max(10_000_000),
});

export const voucherPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  app.post(
    '/validate',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!stripeConfigured) {
        // Without Stripe we can't validate — treat as no-vouchers-available.
        // 200 + valid:false keeps the client UX consistent (no error toast).
        reply.send({
          valid: false,
          reasonCode: 'inactive',
          message: 'Gutscheine sind aktuell nicht verfügbar.',
        });
        return;
      }
      const body = validateSchema.parse(request.body);
      const code = body.code.toUpperCase();

      try {
        // We allow both Promotion Codes (customer-facing strings) AND raw
        // Coupon IDs. Promotion Codes are the better UX — they decouple the
        // user-typed string from the underlying coupon.
        const promo = await getStripe().promotionCodes.list({
          code,
          active: true,
          limit: 1,
        });
        const promoCode = promo.data[0];

        if (!promoCode) {
          reply.send({
            valid: false,
            reasonCode: 'not_found',
            message: 'Gutscheincode unbekannt.',
          });
          return;
        }

        if (promoCode.expires_at && promoCode.expires_at * 1000 < Date.now()) {
          reply.send({
            valid: false,
            reasonCode: 'expired',
            message: 'Gutschein ist abgelaufen.',
          });
          return;
        }

        if (
          promoCode.max_redemptions != null &&
          promoCode.times_redeemed >= promoCode.max_redemptions
        ) {
          reply.send({
            valid: false,
            reasonCode: 'redeemed',
            message: 'Gutschein wurde bereits maximal eingelöst.',
          });
          return;
        }

        // PromotionCode → promotion.coupon can be a string id (un-expanded)
        // or the full Coupon object. We always need the full object; if it's
        // just an id, fetch it explicitly. This is the only case where
        // we make a second Stripe call.
        let coupon = promoCode.promotion.coupon;
        if (coupon == null) {
          reply.send({
            valid: false,
            reasonCode: 'inactive',
            message: 'Gutschein ist nicht mehr aktiv.',
          });
          return;
        }
        if (typeof coupon === 'string') {
          coupon = await getStripe().coupons.retrieve(coupon);
        }

        let discountCents = 0;
        if (typeof coupon.amount_off === 'number') {
          // amount_off is in the currency's smallest unit (cents for EUR).
          discountCents = Math.min(coupon.amount_off, body.subtotalCents);
        } else if (typeof coupon.percent_off === 'number') {
          discountCents = Math.floor((body.subtotalCents * coupon.percent_off) / 100);
        }
        if (discountCents <= 0) {
          reply.send({
            valid: false,
            reasonCode: 'inactive',
            message: 'Gutschein bringt aktuell keinen Vorteil.',
          });
          return;
        }

        reply.send({
          valid: true,
          discountCents,
          code,
          // Echo the promo-code id so the checkout endpoint can apply it
          // server-side without a second Stripe round-trip.
          promotionCodeId: promoCode.id,
          message:
            typeof coupon !== 'string' && typeof coupon.percent_off === 'number'
              ? `${coupon.percent_off}% Rabatt`
              : `Rabatt: ${(discountCents / 100).toLocaleString('de-DE', {
                  style: 'currency',
                  currency: 'EUR',
                })}`,
        });
      } catch (err) {
        // Stripe lookup failed (network, auth) — fail-closed so we never
        // grant a discount we can't validate.
        request.log.error({ err, code }, 'voucher lookup failed');
        reply.code(502).send({
          valid: false,
          reasonCode: 'lookup_failed',
          message: 'Gutschein konnte nicht überprüft werden — bitte später erneut versuchen.',
        });
      }
    },
  );
};

export default voucherPublicRoutes;
