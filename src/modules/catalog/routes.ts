import type { FastifyPluginAsync } from 'fastify';

import { getPriceBook } from '../../lib/price-books/index.js';
import type { PriceBook } from '../../lib/price-books/types.js';

// ---------------------------------------------------------------------------
// Public storefront catalog. Returns a JSON description of the services + tiers
// the brand sells through online checkout, so storefronts can render only the
// kinds and addons their book exposes (rather than hard-coding the catalog
// client-side, which drifts from the engine).
//
// Mounted at /storefront/catalog. Tenant resolved by X-Company-Slug.
// ---------------------------------------------------------------------------

interface TierDto {
  code: string;
  label: string;
  unitPriceCents: number;
}

interface ServiceDto {
  kind: 'teppichreinigung' | 'teppichreparatur' | 'polsterreinigung';
  label: string;
  unit: 'qm' | 'lfdm' | 'stueck';
  tiers: TierDto[];
  /** Extra config the storefront wizard needs. */
  options: Record<string, unknown>;
}

interface CatalogDto {
  brand: { slug: string; name: string };
  currency: string;
  services: ServiceDto[];
  /** Carpet add-ons attach to carpetCleaning lines. */
  addons: TierDto[];
}

function buildCatalog(book: PriceBook): CatalogDto {
  const services: ServiceDto[] = [];

  if (book.carpetCleaning) {
    const c = book.carpetCleaning;
    services.push({
      kind: 'teppichreinigung',
      label: 'Teppichreinigung',
      unit: 'qm',
      tiers: (Object.keys(c.prices) as Array<keyof typeof c.prices>).map((k) => ({
        code: k,
        label: c.labels[k],
        unitPriceCents: c.prices[k],
      })),
      options: {
        minOrderCents: c.minOrderCents,
        freePickupSqmThreshold: c.freePickupSqmThreshold,
        dropOffLabel: c.dropOffLabel,
      },
    });
  }

  if (book.carpetRepair) {
    const r = book.carpetRepair;
    services.push({
      kind: 'teppichreparatur',
      label: 'Teppichreparatur',
      unit: 'lfdm',
      tiers: (Object.keys(r.prices) as Array<keyof typeof r.prices>).map((k) => ({
        code: k,
        label: r.labels[k],
        unitPriceCents: r.prices[k],
      })),
      options: { dropOffLabel: r.dropOffLabel },
    });
  }

  if (book.upholstery) {
    const u = book.upholstery;
    services.push({
      kind: 'polsterreinigung',
      label: 'Polsterreinigung (Vor-Ort)',
      unit: 'stueck',
      tiers: (Object.keys(u.prices) as Array<keyof typeof u.prices>).map((k) => ({
        code: k,
        label: u.labels[k],
        unitPriceCents: u.prices[k],
      })),
      options: {
        minOnsiteCents: u.minOnsiteCents,
        anfahrtCents: u.anfahrtCents,
      },
    });
  }

  const addons: TierDto[] = (
    Object.keys(book.addons.prices) as Array<keyof typeof book.addons.prices>
  ).map((k) => ({
    code: k,
    label: book.addons.labels[k],
    unitPriceCents: book.addons.prices[k],
  }));

  return {
    brand: { slug: book.slug, name: book.brandName },
    currency: book.currency,
    services,
    addons,
  };
}

export const catalogPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  // Cheap, deterministic — no need for tight rate limits.
  app.get('/', async (request, reply) => {
    const book = getPriceBook(request.company!.slug);
    if (!book) {
      reply.code(404).send({ error: 'Unbekannte Marke' });
      return;
    }
    reply.send(buildCatalog(book));
  });
};
