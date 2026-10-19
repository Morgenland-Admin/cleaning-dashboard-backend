import type { FastifyPluginAsync } from 'fastify';
import usersRoutes from '../modules/users/routes.js';
import companiesRoutes from '../modules/companies/routes.js';
import { partnersSelfRoutes } from '../modules/partners/routes.js';
import { ordersPartnerRoutes } from '../modules/orders/partner-routes.js';
import pushRoutes from '../modules/push/routes.js';
import { partnerDocumentsSelfRoutes } from '../modules/partners/documents.js';
import { dispatchPartnerRoutes } from '../modules/dispatch/routes.js';
import { chatPartnerRoutes } from '../modules/chat/partner-routes.js';
import { reviewsPartnerRoutes } from '../modules/reviews/routes.js';

const partnerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('partner'));

  await app.register(usersRoutes, { prefix: '/users' });
  await app.register(companiesRoutes, { prefix: '/companies' });
  await app.register(partnersSelfRoutes, { prefix: '/partners' });
  await app.register(partnerDocumentsSelfRoutes, { prefix: '/partners/me/documents' });
  await app.register(ordersPartnerRoutes, { prefix: '/orders' });
  await app.register(dispatchPartnerRoutes, { prefix: '/offers' });
  await app.register(chatPartnerRoutes, { prefix: '/chat' });
  await app.register(reviewsPartnerRoutes, { prefix: '/reviews' });
  await app.register(pushRoutes, { prefix: '/push' });
};

export default partnerRoutes;
