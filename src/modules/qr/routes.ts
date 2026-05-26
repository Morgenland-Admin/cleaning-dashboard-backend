import type { FastifyPluginAsync } from 'fastify';
import QRCode from 'qrcode';
import { eq } from 'drizzle-orm';

import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import { parseIntId } from '../../lib/http-errors.js';

const QR_BASE = {
  errorCorrectionLevel: 'M' as const,
  margin: 2,
  width: 512,
  color: { dark: '#1a1a1a', light: '#ffffff' },
};

export const qrAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);

  app.get('/order/:id', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const format = (request.query as { format?: string }).format ?? 'png';

    const { orders } = request.company!.tables;
    const [row] = await db
      .select({
        id: orders.id,
        publicToken: orders.publicToken,
      })
      .from(orders)
      .where(eq(orders.id, id))
      .limit(1);
    if (!row) {
      reply.code(404).send({ error: 'Order not found' });
      return;
    }

    const [companyRow] = await db
      .select({ storefrontOrigin: company.storefrontOrigin })
      .from(company)
      .where(eq(company.slug, request.company!.slug))
      .limit(1);
    const scanBase = (companyRow?.storefrontOrigin ?? env.APP_BASE_URL).replace(/\/$/, '');
    const scanUrl = `${scanBase}/q/${row.publicToken}`;

    if (format === 'json') {
      const dataUrl = await QRCode.toDataURL(scanUrl, QR_BASE);
      reply.send({ scanUrl, qrDataUrl: dataUrl, publicToken: row.publicToken });
      return;
    }
    if (format === 'svg') {
      const svg = await QRCode.toString(scanUrl, { ...QR_BASE, type: 'svg' });
      reply.header('Content-Type', 'image/svg+xml');
      reply.send(svg);
      return;
    }

    const buf = await QRCode.toBuffer(scanUrl, QR_BASE);
    reply.header('Content-Type', 'image/png');
    reply.header('Content-Disposition', `inline; filename="order-${id}-qr.png"`);
    reply.send(buf);
  });
};

export const qrPublicRoutes: FastifyPluginAsync = async (app) => {
  app.get('/:token', async (request, reply) => {
    const token = (request.params as { token: string }).token;
    if (!token || token.length < 16 || token.length > 128) {
      reply.code(404).send({ error: 'Not found' });
      return;
    }

    const companies = await db.select().from(company);
    for (const c of companies) {
      const { getTenantTables } = await import('../../db/schema/tenant.js');
      const tables = getTenantTables(c.schemaName);
      const [row] = await db
        .select({
          id: tables.orders.id,
          status: tables.orders.status,
          customerName: tables.orders.customerName,
          kind: tables.orders.kind,
          totalCents: tables.orders.totalCents,
          createdAt: tables.orders.createdAt,
        })
        .from(tables.orders)
        .where(eq(tables.orders.publicToken, token))
        .limit(1);
      if (row) {
        const lastNameOnly = row.customerName?.split(/\s+/).slice(-1)[0] ?? '—';
        reply.send({
          brand: { slug: c.slug, name: c.name },
          order: {
            id: row.id,
            status: row.status,
            customerLastName: lastNameOnly,
            kind: row.kind,
            totalCents: row.totalCents,
            createdAt: row.createdAt,
          },
        });
        return;
      }
    }
    reply.code(404).send({ error: 'Order not found' });
  });
};

export default qrAdminRoutes;
