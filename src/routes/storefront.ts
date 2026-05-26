import type { FastifyPluginAsync } from 'fastify';
import { catalogPublicRoutes } from '../modules/catalog/routes.js';
import { newsletterPublicRoutes } from '../modules/newsletter/routes.js';
import { contactPublicRoutes } from '../modules/contact/routes.js';
import { inquiriesPublicRoutes } from '../modules/inquiries/routes.js';
import { uploadsPublicRoutes } from '../modules/uploads/routes.js';
import { invitesPublicRoutes } from '../modules/invites/routes.js';
import { ordersPublicRoutes, ordersWebhookRoutes } from '../modules/orders/routes.js';
import { qrPublicRoutes } from '../modules/qr/routes.js';
import { voucherPublicRoutes } from '../modules/voucher/routes.js';

// Storefront: public endpoints for the 3 company websites. No auth required.
// Tenant resolution is done per-route via app.resolveCompanyPublic (X-Company-Slug header).
const storefrontRoutes: FastifyPluginAsync = async (app) => {
  await app.register(catalogPublicRoutes, { prefix: '/catalog' });
  await app.register(newsletterPublicRoutes, { prefix: '/newsletter' });
  await app.register(contactPublicRoutes, { prefix: '/contact' });
  await app.register(inquiriesPublicRoutes, { prefix: '/inquiries' });
  await app.register(uploadsPublicRoutes, { prefix: '/uploads' });
  await app.register(ordersPublicRoutes, { prefix: '/orders' });
  // Stripe webhook is a separate sub-plugin so it can install a buffer-keeping
  // JSON parser without affecting any other route. Lives under /orders/webhook
  // so Stripe Dashboard config is intuitive: ".../storefront/orders/webhook/stripe".
  await app.register(ordersWebhookRoutes, { prefix: '/orders/webhook' });
  // Invites are intentionally on the storefront prefix (no X-Company-Slug)
  // so the accept page works without picking a brand first.
  await app.register(invitesPublicRoutes, { prefix: '/invites' });
  await app.register(voucherPublicRoutes, { prefix: '/voucher' });
  // QR public-scan endpoint — no X-Company-Slug because the token is the
  // global identifier. Lives at /storefront/q/:token (paired with the admin
  // /admin/qr/order/:id PNG generator).
  await app.register(qrPublicRoutes, { prefix: '/q' });
};

export default storefrontRoutes;
