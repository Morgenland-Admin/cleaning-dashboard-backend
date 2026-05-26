import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';

import { getStripe, stripeConfigured } from '../../lib/stripe.js';

const validateSchema = z.object({
  code: z
    .string()
    .trim()
    .min(2)
    .max(80)
    .regex(/^[A-Z0-9_-]+$/i, 'Code may only contain letters, digits, _, -'),
  subtotalCents: z.number().int().min(0).max(10_000_000),
});

export const voucherPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  app.post(
    '/validate',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!stripeConfigured) {
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
