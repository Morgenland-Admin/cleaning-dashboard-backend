import type { FastifyPluginAsync } from 'fastify';

import { getPriceBook } from '../../lib/price-books/index.js';
import type { PriceBook } from '../../lib/price-books/types.js';

interface TierDto {
  code: string;
  label: string;
  /** Bei unit 'bracket' ist unitPriceCents immer 0 — Clients lesen `brackets`. */
  unitPriceCents: number;
  description?: string;
}

interface BracketDto {
  code: string;
  label: string;
  /** Preis je Tier-Code; `null` = "auf Anfrage". */
  pricesCents: Record<string, number | null>;
}

interface ServiceDto {
  kind: 'teppichreinigung' | 'teppichreparatur' | 'polsterreinigung' | 'teppichbodenreinigung';
  label: string;
  unit: 'qm' | 'lfdm' | 'stueck' | 'bracket';
  tiers: TierDto[];
  brackets?: BracketDto[];
  options: Record<string, unknown>;
}

interface CatalogDto {
  brand: { slug: string; name: string };
  currency: string;
  services: ServiceDto[];
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
      options: { minOrderCents: u.minOrderCents },
    });
  }

  if (book.teppichbodenCleaning) {
    const t = book.teppichbodenCleaning;
    const tierCodes = Object.keys(t.prices) as Array<keyof typeof t.prices>;
    const bracketCodes = Object.keys(t.bracketLabels) as Array<keyof typeof t.bracketLabels>;
    services.push({
      kind: 'teppichbodenreinigung',
      label: 'Teppichbodenreinigung (Vor-Ort)',
      unit: 'bracket',
      tiers: tierCodes.map((k) => ({
        code: k,
        label: t.tierLabels[k],
        unitPriceCents: 0,
        description: t.tierDescriptions[k],
      })),
      brackets: bracketCodes.map((b) => ({
        code: b,
        label: t.bracketLabels[b],
        pricesCents: Object.fromEntries(tierCodes.map((k) => [k, t.prices[k][b]])),
      })),
      options: {},
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

  app.get('/', async (request, reply) => {
    const book = getPriceBook(request.company!.slug);
    if (!book) {
      reply.code(404).send({ error: 'Unbekannte Marke' });
      return;
    }
    reply.send(buildCatalog(book));
  });
};
