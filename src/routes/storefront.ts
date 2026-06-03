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
import { reviewsPublicRoutes } from '../modules/reviews/routes.js';

const storefrontRoutes: FastifyPluginAsync = async (app) => {
  await app.register(catalogPublicRoutes, { prefix: '/catalog' });
  await app.register(newsletterPublicRoutes, { prefix: '/newsletter' });
  await app.register(contactPublicRoutes, { prefix: '/contact' });
  await app.register(inquiriesPublicRoutes, { prefix: '/inquiries' });
  await app.register(uploadsPublicRoutes, { prefix: '/uploads' });
  await app.register(ordersPublicRoutes, { prefix: '/orders' });
  await app.register(ordersWebhookRoutes, { prefix: '/orders/webhook' });
  await app.register(invitesPublicRoutes, { prefix: '/invites' });
  await app.register(voucherPublicRoutes, { prefix: '/voucher' });
  await app.register(reviewsPublicRoutes, { prefix: '/reviews' });
  await app.register(qrPublicRoutes, { prefix: '/q' });
};

export default storefrontRoutes;
