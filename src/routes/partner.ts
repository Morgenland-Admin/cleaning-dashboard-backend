import type { FastifyPluginAsync } from 'fastify';
import usersRoutes from '../modules/users/routes.js';
import companiesRoutes from '../modules/companies/routes.js';
import { partnersSelfRoutes } from '../modules/partners/routes.js';

const partnerRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('partner'));

  await app.register(usersRoutes, { prefix: '/users' });
  await app.register(companiesRoutes, { prefix: '/companies' });
  await app.register(partnersSelfRoutes, { prefix: '/partners' });
};

export default partnerRoutes;
