import type { FastifyPluginAsync } from 'fastify';
import usersRoutes from '../modules/users/routes.js';
import companiesRoutes from '../modules/companies/routes.js';
import { partnersSelfRoutes } from '../modules/partners/routes.js';
import { ordersPartnerRoutes } from '../modules/orders/routes.js';
import pushRoutes from '../modules/push/routes.js';

const partnerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('partner'));

  await app.register(usersRoutes, { prefix: '/users' });
  await app.register(companiesRoutes, { prefix: '/companies' });
  await app.register(partnersSelfRoutes, { prefix: '/partners' });
  await app.register(ordersPartnerRoutes, { prefix: '/orders' });
  // PWA push: chat messages + order assignments reach partner devices.
  await app.register(pushRoutes, { prefix: '/push' });
};

export default partnerRoutes;
