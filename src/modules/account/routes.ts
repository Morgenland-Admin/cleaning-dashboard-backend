import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { and, desc, eq, inArray, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import { env } from '../../config/env.js';
import { brandInfoFromCompany, brandSender, sendEmail } from '../../email/service.js';
import { customerLoginEmail } from '../../email/templates.js';
import { signCustomerToken, verifyCustomerToken } from '../../lib/token.js';
import { orderNumberOf } from '../orders/lib.js';

const LOGIN_TTL_SECONDS = 30 * 60;
const SESSION_TTL_SECONDS = 30 * 24 * 60 * 60;
const MAX_ORDERS = 100;

const loginLinkSchema = z.object({
  email: z.string().trim().toLowerCase().email().max(254),
  website: z.string().max(200).optional(),
});
const sessionSchema = z.object({ token: z.string().min(20).max(1024) });

function sessionEmail(request: FastifyRequest): string | null {
  const header = request.headers.authorization;
  if (!header?.startsWith('Bearer ')) return null;
  return verifyCustomerToken(header.slice(7), request.company!.slug, 'session')?.email ?? null;
}

/** Passwordless customer area: e-mail link → session token → the orders placed with that address. */
export const accountPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  // Always answers ok so the response never reveals whether an address has orders.
  app.post(
    '/login-link',
    { config: { rateLimit: { max: 3, timeWindow: '5 minutes' } } },
    async (request, reply) => {
      const body = loginLinkSchema.parse(request.body);
      if (body.website && body.website.trim().length > 0) {
        reply.send({ ok: true });
        return;
      }
      const slug = request.company!.slug;
      const { orders } = request.company!.tables;
      const [hit] = await db
        .select({ id: orders.id })
        .from(orders)
        .where(sql`lower(${orders.customerEmail}) = ${body.email}`)
        .limit(1);
      if (hit) {
        const [companyRow] = await db.select().from(company).where(eq(company.slug, slug)).limit(1);
        if (companyRow) {
          const origin = (companyRow.storefrontOrigin ?? env.APP_BASE_URL).replace(/\/$/, '');
          const token = signCustomerToken(body.email, slug, 'login', LOGIN_TTL_SECONDS);
          await sendEmail({
            to: body.email,
            from: brandSender(companyRow),
            log: { companySlug: slug, kind: 'customer_login' },
            apiKey: companyRow.resendApiKey ?? undefined,
            replyTo: companyRow.email ?? undefined,
            email: customerLoginEmail({
              brand: brandInfoFromCompany(companyRow),
              loginUrl: `${origin}/konto?t=${token}`,
              validMinutes: LOGIN_TTL_SECONDS / 60,
            }),
          });
        }
      }
      reply.send({ ok: true });
    },
  );

  app.post(
    '/session',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const { token } = sessionSchema.parse(request.body);
      const login = verifyCustomerToken(token, request.company!.slug, 'login');
      if (!login) {
        reply.code(401).send({ error: 'Link ungültig oder abgelaufen' });
        return;
      }
      reply.send({
        sessionToken: signCustomerToken(
          login.email,
          request.company!.slug,
          'session',
          SESSION_TTL_SECONDS,
        ),
        email: login.email,
        expiresInSeconds: SESSION_TTL_SECONDS,
      });
    },
  );

  app.get(
    '/orders',
    { config: { rateLimit: { max: 60, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const email = sessionEmail(request);
      if (!email) {
        reply.code(401).send({ error: 'Nicht angemeldet' });
        return;
      }
      const { orders, orderItems } = request.company!.tables;
      const rows = await db
        .select()
        .from(orders)
        .where(
          and(
            sql`lower(${orders.customerEmail}) = ${email}`,
            // Abandoned checkouts never became an order for the customer.
            sql`not (${orders.status} in ('pending', 'payment_pending') and ${orders.paymentMode} = 'upfront')`,
          ),
        )
        .orderBy(desc(orders.createdAt))
        .limit(MAX_ORDERS);
      const items = rows.length
        ? await db
            .select({ orderId: orderItems.orderId, label: orderItems.label })
            .from(orderItems)
            .where(
              inArray(
                orderItems.orderId,
                rows.map((r) => r.id),
              ),
            )
            .orderBy(orderItems.id)
        : [];
      const labels = new Map<number, string[]>();
      for (const it of items) labels.set(it.orderId, [...(labels.get(it.orderId) ?? []), it.label]);

      reply.header('Cache-Control', 'no-store').send({
        email,
        orders: rows.map((r) => ({
          orderNumber: orderNumberOf(r),
          publicToken: r.publicToken,
          kind: r.kind,
          status: r.status,
          totalCents: r.totalCents,
          currency: r.currency,
          createdAt: r.createdAt,
          preferredDate: r.preferredDate,
          paidAt: r.paidAt,
          completedAt: r.completedAt,
          paymentMode: r.paymentMode,
          itemLabels: labels.get(r.id) ?? [],
        })),
      });
    },
  );
};
