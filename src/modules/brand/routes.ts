import type { FastifyPluginAsync } from 'fastify';

import { loadCompanyFull } from '../partners/lib.js';

/** Public identity of a brand (theming + Impressum basics) for its storefront and partner portal. */
export const brandPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  app.get('/', async (request, reply) => {
    const c = await loadCompanyFull(request.company!.slug);
    if (!c) {
      reply.code(404).send({ error: 'Unknown brand' });
      return;
    }
    reply.header('cache-control', 'public, max-age=300');
    return {
      brand: {
        slug: c.slug,
        name: c.name,
        logoUrl: c.logoUrl,
        primaryColor: c.primaryColor,
        email: c.email,
        phone: c.phone,
        websiteUrl: c.websiteUrl,
        storefrontOrigin: c.storefrontOrigin,
        partnerPortalOrigin: c.partnerPortalOrigin,
        legal: {
          legalName: c.legalName,
          addressLine1: c.addressLine1,
          postalCode: c.postalCode,
          city: c.city,
          vatId: c.vatId,
          managingDirectors: c.managingDirectors,
        },
      },
    };
  });
};
