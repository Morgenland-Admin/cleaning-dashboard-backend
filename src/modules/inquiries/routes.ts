import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { company, user } from '../../db/schema/shared.js';
import { brandInfoFromCompany, brandSender, sendEmail } from '../../email/service.js';
import {
  adminInboxNotificationEmail,
  contactAckEmail,
  inquiryQuoteEmail,
} from '../../email/templates.js';
import { notFound, parseIntId } from '../../lib/http-errors.js';

const submitSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(254),
  phone: z.string().max(32).optional(),
  service: z.string().max(200).optional(),
  propertyDetails: z.string().max(2000).optional(),
  preferredDate: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'preferredDate must be YYYY-MM-DD')
    .optional(),
  budget: z.string().max(64).optional(),
  message: z.string().min(1).max(5000),
  locale: z.string().min(2).max(16).optional(),
  source: z.string().max(64).optional(),
  /**
   * Brand-specific form fields. Each storefront defines its own keys
   * (e.g. carpet material, square meters, pickup vs on-site).
   */
  metadata: z.record(z.string().max(120), z.unknown()).optional(),
  /**
   * S3 object references for files uploaded via /storefront/uploads/sign.
   * Each entry holds the key (not a URL) — the admin dashboard signs a
   * short-lived GET URL on demand to render the image.
   */
  attachments: z
    .array(
      z.object({
        key: z.string().min(1).max(500),
        name: z.string().min(1).max(200),
        size: z.number().int().nonnegative(),
        contentType: z.string().max(80).optional(),
      }),
    )
    .max(10)
    .optional(),
  consentPrivacy: z.literal(true, {
    errorMap: () => ({ message: 'Privacy consent is required' }),
  }),
  consentMarketing: z.boolean().optional(),
  /** Honeypot — must stay empty. */
  website: z.string().max(200).optional(),
});

const updateSchema = z.object({
  status: z.enum(['new', 'in_review', 'quoted', 'won', 'lost']).optional(),
  priority: z.enum(['normal', 'high']).optional(),
  internalNotes: z.string().max(2000).nullable().optional(),
  quotedAmount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, 'quotedAmount must be numeric')
    .nullable()
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

export const inquiriesPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  app.post(
    '/',
    {
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const body = submitSchema.parse(request.body);
      if (body.website && body.website.trim().length > 0) {
        reply.code(201);
        return { ok: true, inquiry: null };
      }
      if (body.attachments && body.attachments.length > 0) {
        const expectedPrefix = `${request.company!.keyPrefix}/`;
        const bad = body.attachments.find((a) => !a.key.startsWith(expectedPrefix));
        if (bad) {
          reply.code(400).send({ error: 'Invalid attachment key' });
          return;
        }
      }
      const { serviceInquiries } = request.company!.tables;
      const [row] = await db
        .insert(serviceInquiries)
        .values({
          name: body.name,
          email: body.email,
          phone: body.phone,
          service: body.service,
          propertyDetails: body.propertyDetails,
          preferredDate: body.preferredDate,
          budget: body.budget,
          message: body.message,
          locale: body.locale ?? 'de',
          source: body.source,
          metadata: body.metadata ?? {},
          attachments: body.attachments ?? [],
          consentPrivacy: body.consentPrivacy,
          consentMarketing: body.consentMarketing ?? false,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        })
        .returning();

      if (row) {
        try {
          const [companyRow] = await db
            .select()
            .from(company)
            .where(eq(company.slug, request.company!.slug))
            .limit(1);
          if (companyRow) {
            const brand = brandInfoFromCompany(companyRow);
            await sendEmail({
              to: row.email,
              from: brandSender(companyRow),
              replyTo: companyRow.email ?? undefined,
              email: contactAckEmail({
                name: row.name,
                subject: row.service ?? null,
                message: row.message,
                brand,
              }),
            });
            if (companyRow.email) {
              const details: Array<{ label: string; value: string }> = [];
              if (row.service) details.push({ label: 'Service', value: row.service });
              if (row.preferredDate)
                details.push({ label: 'Wunschtermin', value: row.preferredDate });
              if (row.budget) details.push({ label: 'Budget', value: row.budget });
              if (row.phone) details.push({ label: 'Telefon', value: row.phone });
              const adminUrl = `${env.APP_BASE_URL.replace(/\/$/, '')}/inquiries?id=${row.id}`;
              await sendEmail({
                to: companyRow.email,
                from: brandSender(companyRow),
                replyTo: row.email,
                email: adminInboxNotificationEmail({
                  brand,
                  kind: 'inquiry',
                  fromName: row.name,
                  fromEmail: row.email,
                  subject: row.service ?? null,
                  message: row.message,
                  adminUrl,
                  details,
                }),
              });
            }
          }
        } catch (err) {
          request.log.error(
            { err, inquiryId: row.id, recipientEmail: row.email },
            'Failed to send inquiry emails',
          );
        }

        try {
          const { sendPushToBrandAdmins } = await import('../../lib/push.js');
          await sendPushToBrandAdmins(request.company!.slug, {
            title: `${request.company!.slug} · Service-Anfrage`,
            body: `${row.name}${row.service ? ` · ${row.service}` : ''}: ${(row.message || '').slice(0, 120)}`,
            url: `/inquiries?id=${row.id}`,
            tag: `inquiry:${row.id}`,
            brandSlug: request.company!.slug,
          });
        } catch (err) {
          request.log.warn({ err, inquiryId: row.id }, 'push dispatch failed');
        }

        try {
          const { spawnTask } = await import('../../lib/tasks.js');
          await spawnTask({
            companySlug: request.company!.slug,
            kind: 'inquiry_review',
            refKind: 'service_inquiry',
            refId: row.id,
            title: `Anfrage von ${row.name}${row.service ? ` — ${row.service}` : ''}`,
            body: row.message,
            priority: 'high',
          });
        } catch (err) {
          request.log.warn({ err, inquiryId: row.id }, 'task spawn failed');
        }
      }

      reply.code(201);
      return { ok: true, inquiry: row };
    },
  );
};

const PRIVILEGED_LEVELS = new Set(['manager', 'admin', 'super_admin']);

function redactPii<T extends { ipAddress?: unknown; userAgent?: unknown; internalNotes?: unknown }>(
  row: T,
  accessLevel: string | undefined,
): T {
  if (accessLevel && PRIVILEGED_LEVELS.has(accessLevel)) return row;
  return { ...row, ipAddress: null, userAgent: null, internalNotes: null };
}

export const inquiriesAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('admin'));
  app.addHook('preHandler', app.requireCompany);

  const listQuerySchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).max(500).optional(),
  });
  app.get('/', async (request) => {
    const { limit, cursor } = listQuerySchema.parse(request.query);
    const { serviceInquiries } = request.company!.tables;
    const decoded = cursor ? decodeCursor(cursor) : null;
    const where = decoded
      ? or(
          lt(serviceInquiries.createdAt, sql`${decoded.createdAt}::timestamptz`),
          and(
            sql`${serviceInquiries.createdAt} = ${decoded.createdAt}::timestamptz`,
            lt(serviceInquiries.id, decoded.id),
          ),
        )
      : undefined;
    const rows = await db
      .select()
      .from(serviceInquiries)
      .where(where)
      .orderBy(desc(serviceInquiries.createdAt), desc(serviceInquiries.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    const accessLevel = (request.authUser as { accessLevel?: string } | null)?.accessLevel;
    return {
      inquiries: page.map((r) => redactPii(r, accessLevel)),
      nextCursor,
    };
  });

  app.get('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { serviceInquiries } = request.company!.tables;
    const [row] = await db
      .select()
      .from(serviceInquiries)
      .where(eq(serviceInquiries.id, id))
      .limit(1);
    const accessLevel = (request.authUser as { accessLevel?: string } | null)?.accessLevel;
    return { inquiry: row ? redactPii(row, accessLevel) : null };
  });

  app.patch('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = updateSchema.parse(request.body);
    const adminId = request.authUser!.id;
    const { serviceInquiries } = request.company!.tables;
    const now = new Date();
    const patch: Record<string, unknown> = { ...body, updatedAt: now };
    if (body.status === 'quoted') {
      patch.quotedAt = now;
      patch.handledByUserId = adminId;
      patch.handledAt = now;
    }
    if (body.status === 'won' || body.status === 'lost') {
      patch.closedAt = now;
    }

    if (body.metadata) {
      const [cur] = await db
        .select({ metadata: serviceInquiries.metadata })
        .from(serviceInquiries)
        .where(eq(serviceInquiries.id, id))
        .limit(1);
      patch.metadata = { ...(cur?.metadata ?? {}), ...body.metadata };
    }
    const [row] = await db
      .update(serviceInquiries)
      .set(patch)
      .where(eq(serviceInquiries.id, id))
      .returning();
    return { inquiry: row };
  });

  const quoteSchema = z.object({
    body: z.string().min(1).max(8000),
    quotedAmount: z
      .string()
      .regex(/^\d+(\.\d{1,2})?$/, 'quotedAmount must be numeric')
      .nullable()
      .optional(),
  });
  app.post('/:id/quote', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const parsed = quoteSchema.parse(request.body);
    const adminId = request.authUser!.id;
    const { serviceInquiries } = request.company!.tables;

    const [inquiry] = await db
      .select()
      .from(serviceInquiries)
      .where(eq(serviceInquiries.id, id))
      .limit(1);
    if (!inquiry) throw notFound('Inquiry not found');

    const [adminRow] = await db
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, adminId))
      .limit(1);
    const signedBy = adminRow?.name ?? null;

    const [companyRow] = await db
      .select()
      .from(company)
      .where(eq(company.slug, request.company!.slug))
      .limit(1);

    const amountFinal = parsed.quotedAmount ?? inquiry.quotedAmount;
    const amountFormatted = amountFinal
      ? `${Number(amountFinal).toLocaleString('de-DE', { minimumFractionDigits: 2, maximumFractionDigits: 2 })} €`
      : null;

    if (companyRow) {
      await sendEmail({
        to: inquiry.email,
        from: brandSender(companyRow),
        replyTo: companyRow.email ?? undefined,
        email: inquiryQuoteEmail({
          recipientName: inquiry.name,
          brand: brandInfoFromCompany(companyRow),
          quoteBody: parsed.body,
          quotedAmount: amountFormatted,
          signedBy,
        }),
      });
    }

    const now = new Date();
    const [updated] = await db
      .update(serviceInquiries)
      .set({
        status: 'quoted',
        quotedAt: inquiry.quotedAt ?? now,
        quotedAmount: parsed.quotedAmount ?? inquiry.quotedAmount,
        handledByUserId: inquiry.handledByUserId ?? adminId,
        handledAt: inquiry.handledAt ?? now,
        updatedAt: now,
      })
      .where(eq(serviceInquiries.id, id))
      .returning();

    reply.code(201);
    return { ok: true, inquiry: updated };
  });
};
