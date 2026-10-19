import type { FastifyPluginAsync } from 'fastify';
import { and, asc, desc, eq, ilike, inArray, isNull, or, sql, type SQL } from 'drizzle-orm';
import { z } from 'zod';
import { encodeCursor, keysetAfter } from '../../lib/cursor.js';
import { accessLevelOf, redactForViewer } from '../../lib/access.js';
import { db } from '../../db/index.js';
import { company, user } from '../../db/schema/shared.js';
import { linkCustomerByEmail } from '../../lib/customers.js';
import {
  brandInfoFromCompany,
  brandSender,
  isNonContactableEmail,
  sendEmail,
} from '../../email/service.js';
import { env } from '../../config/env.js';
import {
  adminInboxNotificationEmail,
  contactAckEmail,
  contactReplyEmail,
} from '../../email/templates.js';
import { badRequest, notFound, parseIntId } from '../../lib/http-errors.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { likePattern, NO_SOURCE } from '../inquiries/filters.js';
import { metaEventContextSchema, sendMetaServerEvent } from '../../lib/meta-capi.js';

const submitSchema = z.object({
  name: z.string().min(1).max(120),
  email: z.string().email().max(254),
  phone: z.string().max(32).optional(),
  subject: z.string().max(200).optional(),
  message: z.string().min(1).max(5000),
  locale: z.string().min(2).max(16).optional(),
  source: z.string().max(64).optional(),
  metadata: z.record(z.string().max(120), z.unknown()).optional(),
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
  website: z.string().max(200).optional(),
  // Present only with marketing consent; triggers the server-side Lead.
  meta: metaEventContextSchema.optional(),
});

const updateStatusSchema = z.object({
  status: z.enum(['new', 'read', 'replied', 'archived']),
});

const replySchema = z.object({
  body: z.string().min(1).max(8000),
});

export const contactPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  app.post(
    '/',
    {
      bodyLimit: 64 * 1024,
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const body = submitSchema.parse(request.body);

      if (body.website && body.website.trim().length > 0) {
        reply.code(201);
        return { ok: true, message: null };
      }

      if (body.attachments && body.attachments.length > 0) {
        const expectedPrefix = `${request.company!.keyPrefix}/`;
        const bad = body.attachments.find((a) => !a.key.startsWith(expectedPrefix));
        if (bad) {
          reply.code(400).send({ error: 'Invalid attachment key' });
          return;
        }
      }
      const { contactMessages, customers } = request.company!.tables;
      const customerId = await linkCustomerByEmail(db, customers, {
        email: body.email,
        name: body.name,
        phone: body.phone,
        marketingOptIn: body.consentMarketing ?? false,
      });
      const [row] = await db
        .insert(contactMessages)
        .values({
          customerId,
          name: body.name,
          email: body.email,
          phone: body.phone,
          subject: body.subject,
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
              log: {
                companySlug: companyRow.slug,
                kind: 'contact_ack',
                refType: 'contact',
                refId: row.id,
              },
              apiKey: companyRow.resendApiKey ?? undefined,
              replyTo: companyRow.email ?? undefined,
              email: contactAckEmail({
                name: row.name,
                subject: row.subject,
                message: row.message,
                brand,
              }),
            });
            if (companyRow.email) {
              const adminUrl = `${env.APP_BASE_URL.replace(/\/$/, '')}/contacts/${request.company!.slug}/${row.id}`;
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
                replyTo: row.email,
                email: adminInboxNotificationEmail({
                  brand,
                  kind: 'contact',
                  fromName: row.name,
                  fromEmail: row.email,
                  subject: row.subject,
                  message: row.message,
                  adminUrl,
                }),
              });
            }
          }
        } catch (err) {
          request.log.error(
            { err, contactMessageId: row.id, recipientEmail: row.email },
            'Failed to send contact emails',
          );
        }

        try {
          const { sendPushToBrandAdmins } = await import('../../lib/push.js');
          await sendPushToBrandAdmins(request.company!.slug, {
            title: `${request.company!.slug} · Kontaktanfrage`,
            body: `${row.name}: ${(row.subject || row.message || '').slice(0, 120)}`,
            url: `/contacts/${request.company!.slug}/${row.id}`,
            tag: `contact:${row.id}`,
            brandSlug: request.company!.slug,
          });
        } catch (err) {
          request.log.warn({ err, contactMessageId: row.id }, 'push dispatch failed');
        }

        try {
          const { spawnTask } = await import('../../lib/tasks.js');
          await spawnTask({
            companySlug: request.company!.slug,
            kind: 'contact_review',
            refKind: 'contact_message',
            refId: row.id,
            title: `Kontaktanfrage von ${row.name}`,
            body: (row.subject ? `Betreff: ${row.subject}\n\n` : '') + row.message,
            priority: 'normal',
          });
        } catch (err) {
          request.log.warn({ err, contactMessageId: row.id }, 'task spawn failed');
        }

        // Server-side Meta Lead, deduped against the browser Pixel via eventId.
        if (body.meta) {
          await sendMetaServerEvent(
            request.company!.slug,
            {
              eventName: 'Lead',
              eventId: body.meta.eventId,
              eventSourceUrl: body.meta.eventSourceUrl,
              fbp: body.meta.fbp,
              fbc: body.meta.fbc,
              email: row.email,
              phone: row.phone,
              clientIpAddress: request.ip,
              clientUserAgent: request.headers['user-agent'] ?? null,
              customData: { content_name: 'Kontaktformular' },
            },
            request.log,
          );
        }
      }

      reply.code(201);
      return { ok: true, message: row };
    },
  );
};

const redactPii = redactForViewer;

// `open` = not answered yet.
const CONTACT_STATUS_FILTER = ['open', 'new', 'read', 'replied', 'archived', 'all'] as const;
type ContactStatusFilter = (typeof CONTACT_STATUS_FILTER)[number];

function contactFilters(
  cm: TenantTables['contactMessages'],
  opts: { status?: ContactStatusFilter; q?: string; source?: string },
): SQL[] {
  const conds: SQL[] = [];
  if (opts.status === 'open') conds.push(inArray(cm.status, ['new', 'read']));
  else if (opts.status && opts.status !== 'all') conds.push(eq(cm.status, opts.status));
  if (opts.source === NO_SOURCE) conds.push(isNull(cm.source));
  else if (opts.source) conds.push(eq(cm.source, opts.source));
  if (opts.q) {
    const like = likePattern(opts.q);
    const parts = [
      ilike(cm.name, like),
      ilike(cm.email, like),
      ilike(cm.phone, like),
      ilike(cm.subject, like),
      ilike(cm.message, like),
    ];
    const id = /^#?(\d{1,9})$/.exec(opts.q.trim());
    if (id) parts.push(eq(cm.id, Number(id[1])));
    const search = or(...parts);
    if (search) conds.push(search);
  }
  return conds;
}

export const contactAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('admin'));
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', app.requireWriteAccess);

  const filterSchema = z.object({
    status: z.enum(CONTACT_STATUS_FILTER).optional(),
    q: z.string().trim().min(1).max(200).optional(),
    source: z.string().trim().min(1).max(64).optional(),
  });
  const listQuerySchema = filterSchema.extend({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    cursor: z.string().min(1).max(500).optional(),
  });
  app.get('/', async (request) => {
    const { limit, cursor, ...filters } = listQuerySchema.parse(request.query);
    const { contactMessages } = request.company!.tables;
    const conds = contactFilters(contactMessages, filters);
    const after = keysetAfter(
      contactMessages,
      contactMessages.createdAt,
      contactMessages.id,
      cursor,
    );
    if (after) conds.push(after);
    const rows = await db
      .select()
      .from(contactMessages)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(contactMessages.createdAt), desc(contactMessages.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    const accessLevel = accessLevelOf(request);
    return {
      messages: page.map((r) => redactPii(r, accessLevel)),
      nextCursor,
    };
  });

  // Tab counts for the list: per status under the search, per source under search + status.
  app.get('/counts', async (request) => {
    const { status, q, source } = filterSchema.parse(request.query);
    const { contactMessages: cm } = request.company!.tables;
    const statusConds = contactFilters(cm, { q, source });
    const sourceConds = contactFilters(cm, { q, status });
    const [byStatusRows, bySourceRows] = await Promise.all([
      db
        .select({ key: cm.status, n: sql<number>`count(*)::int` })
        .from(cm)
        .where(statusConds.length ? and(...statusConds) : undefined)
        .groupBy(cm.status),
      db
        .select({ key: cm.source, n: sql<number>`count(*)::int` })
        .from(cm)
        .where(sourceConds.length ? and(...sourceConds) : undefined)
        .groupBy(cm.source),
    ]);
    const byStatus = Object.fromEntries(byStatusRows.map((r) => [r.key, r.n]));
    const bySource = Object.fromEntries(bySourceRows.map((r) => [r.key ?? NO_SOURCE, r.n]));
    return { byStatus, bySource };
  });

  app.get('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { contactMessages, contactReplies } = request.company!.tables;
    const [row] = await db
      .select()
      .from(contactMessages)
      .where(eq(contactMessages.id, id))
      .limit(1);
    if (!row) return { message: null, replies: [] };
    const replies = await db
      .select()
      .from(contactReplies)
      .where(eq(contactReplies.contactMessageId, id))
      .orderBy(asc(contactReplies.createdAt));
    const accessLevel = accessLevelOf(request);
    return { message: redactPii(row, accessLevel), replies };
  });

  app.patch('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = updateStatusSchema.parse(request.body);
    const { contactMessages } = request.company!.tables;
    const [row] = await db
      .update(contactMessages)
      .set({ status: body.status, updatedAt: new Date() })
      .where(eq(contactMessages.id, id))
      .returning();
    return { message: row };
  });

  app.post('/:id/reply', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = replySchema.parse(request.body);
    const adminId = request.authUser!.id;
    const { contactMessages, contactReplies } = request.company!.tables;

    const [msg] = await db
      .select()
      .from(contactMessages)
      .where(eq(contactMessages.id, id))
      .limit(1);
    if (!msg) throw notFound('Contact message not found');
    // Imported rows can carry a placeholder address; a "reply" would be stored but never delivered.
    if (isNonContactableEmail(msg.email))
      throw badRequest('This contact has no deliverable email address');

    const [adminRow] = await db
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, adminId))
      .limit(1);
    if (!adminRow) {
      request.log.warn({ adminId }, 'Admin user row missing during contact reply');
    }
    // Internal audit trail only; the mail signs as the brand.
    const sentByName = adminRow?.name ?? null;

    const [companyRow] = await db
      .select()
      .from(company)
      .where(eq(company.slug, request.company!.slug))
      .limit(1);

    let emailMessageId: string | null = null;
    if (companyRow) {
      const result = await sendEmail({
        to: msg.email,
        from: brandSender(companyRow),
        log: {
          companySlug: companyRow.slug,
          kind: 'contact_reply',
          refType: 'contact',
          refId: msg.id,
          sentByUserId: adminId,
        },
        apiKey: companyRow.resendApiKey ?? undefined,
        replyTo: companyRow.email ?? undefined,
        email: contactReplyEmail({
          recipientName: msg.name,
          replyBody: body.body,
          originalMessage: msg.message,
          originalSubject: msg.subject,
          brand: brandInfoFromCompany(companyRow),
        }),
      });
      emailMessageId = result.id ?? (result.skipped ? 'skipped' : null);
    }

    const now = new Date();

    const { savedReply, updatedMessage } = await db.transaction(async (tx) => {
      const [savedReply] = await tx
        .insert(contactReplies)
        .values({
          contactMessageId: id,
          body: body.body,
          sentByUserId: adminId,
          sentByName,
          emailMessageId,
        })
        .returning();

      const [updatedMessage] = await tx
        .update(contactMessages)
        .set({
          status: 'replied',
          repliedAt: now,
          handledByUserId: adminId,
          handledAt: msg.handledAt ?? now,
          updatedAt: now,
        })
        .where(eq(contactMessages.id, id))
        .returning();

      return { savedReply, updatedMessage };
    });

    reply.code(201);
    return { ok: true, reply: savedReply, message: updatedMessage };
  });
};
