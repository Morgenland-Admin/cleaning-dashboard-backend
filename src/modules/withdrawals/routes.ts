import type { FastifyPluginAsync } from 'fastify';
import { and, eq, sql } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import { env } from '../../config/env.js';
import { brandInfoFromCompany, brandSender, sendEmail } from '../../email/service.js';
import { adminInboxNotificationEmail, withdrawalReceiptEmail } from '../../email/templates.js';
import { formatBerlinDateTime } from '../../lib/legal-texts.js';
import { linkCustomerByEmail } from '../../lib/customers.js';

const withdrawalSchema = z.object({
  name: z.string().trim().min(1).max(120),
  email: z.string().trim().toLowerCase().email().max(254),
  orderNumber: z.string().trim().max(40).optional(),
  orderDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'orderDate must be YYYY-MM-DD')
    .optional(),
  message: z.string().trim().max(2000).optional(),
  website: z.string().max(200).optional(),
});

const germanDate = (ymd: string) => ymd.split('-').reverse().join('.');

/**
 * Widerrufsbutton (§ 356a BGB): the customer's withdrawal declaration. Stored like a contact
 * message so staff handle it in the inbox; the customer gets a timestamped receipt.
 */
export const withdrawalsPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  app.post(
    '/',
    { bodyLimit: 16 * 1024, config: { rateLimit: { max: 5, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const body = withdrawalSchema.parse(request.body);
      if (body.website && body.website.trim().length > 0) {
        reply.code(200).send({ ok: true });
        return;
      }

      const receivedAt = new Date();
      const receivedLabel = formatBerlinDateTime(receivedAt);
      const orderNumber = body.orderNumber || undefined;
      const { contactMessages, customers, orders } = request.company!.tables;

      const [order] = orderNumber
        ? await db
            .select({ id: orders.id })
            .from(orders)
            .where(
              and(
                eq(orders.orderNumber, orderNumber),
                sql`lower(${orders.customerEmail}) = ${body.email}`,
              ),
            )
            .limit(1)
        : [];

      const message = [
        `Widerrufserklärung über das Widerrufsformular, eingegangen am ${receivedLabel}.`,
        '',
        `Name: ${body.name}`,
        `E-Mail: ${body.email}`,
        orderNumber ? `Auftragsnummer: ${orderNumber}` : null,
        body.orderDate ? `Datum der Bestellung: ${germanDate(body.orderDate)}` : null,
        body.message ? `\nNachricht:\n${body.message}` : null,
      ]
        .filter((l) => l !== null)
        .join('\n');

      const customerId = await linkCustomerByEmail(db, customers, {
        email: body.email,
        name: body.name,
        marketingOptIn: false,
      });
      const [row] = await db
        .insert(contactMessages)
        .values({
          customerId,
          name: body.name,
          email: body.email,
          subject: orderNumber ? `Widerruf ${orderNumber}` : 'Widerruf',
          message,
          locale: 'de',
          source: 'widerruf',
          priority: 'high',
          metadata: {
            withdrawal: {
              receivedAt: receivedAt.toISOString(),
              ...(orderNumber ? { orderNumber } : {}),
              ...(body.orderDate ? { orderDate: body.orderDate } : {}),
              ...(order ? { orderId: order.id } : {}),
            },
          },
          consentPrivacy: true,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        })
        .returning();
      if (!row) throw new Error('Withdrawal could not be stored');

      try {
        const [companyRow] = await db
          .select()
          .from(company)
          .where(eq(company.slug, request.company!.slug))
          .limit(1);
        if (companyRow) {
          const brand = brandInfoFromCompany(companyRow);
          await sendEmail({
            to: body.email,
            from: brandSender(companyRow),
            log: {
              companySlug: companyRow.slug,
              kind: 'withdrawal_receipt',
              refType: 'contact',
              refId: row.id,
            },
            apiKey: companyRow.resendApiKey ?? undefined,
            replyTo: companyRow.email ?? undefined,
            email: withdrawalReceiptEmail({
              brand,
              name: body.name,
              email: body.email,
              receivedLabel,
              orderNumber,
              orderDate: body.orderDate ? germanDate(body.orderDate) : undefined,
            }),
          });
          if (companyRow.email) {
            await sendEmail({
              to: companyRow.email,
              from: brandSender(companyRow),
              log: {
                companySlug: companyRow.slug,
                kind: 'staff_notification',
                refType: 'contact',
                refId: row.id,
              },
              apiKey: companyRow.resendApiKey ?? undefined,
              replyTo: body.email,
              email: adminInboxNotificationEmail({
                brand,
                kind: 'contact',
                fromName: body.name,
                fromEmail: body.email,
                subject: row.subject,
                message,
                adminUrl: `${env.APP_BASE_URL.replace(/\/$/, '')}/contacts/${companyRow.slug}/${row.id}`,
              }),
            });
          }
        }
      } catch (err) {
        request.log.error({ err, contactMessageId: row.id }, 'Failed to send withdrawal e-mails');
      }

      reply
        .code(201)
        .send({ ok: true, receivedAt: receivedAt.toISOString(), reference: `W-${row.id}` });
    },
  );
};
