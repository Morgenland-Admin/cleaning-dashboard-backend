import type { FastifyPluginAsync } from 'fastify';
import { and, asc, desc, eq, isNotNull, lt, or, sql } from 'drizzle-orm';
import { z } from 'zod';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { env } from '../../config/env.js';
import { accessLevelOf, redactForViewer } from '../../lib/access.js';
import { db } from '../../db/index.js';
import { company, user } from '../../db/schema/shared.js';
import { linkCustomerByEmail } from '../../lib/customers.js';
import {
  brandInfoFromCompany,
  brandSender,
  isOwnDomainEmail,
  sendEmail,
} from '../../email/service.js';
import {
  adminInboxNotificationEmail,
  contactAckEmail,
  inquiryQuoteEmail,
} from '../../email/templates.js';
import { badRequest, notFound, parseIntId, tooManyRequests } from '../../lib/http-errors.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { formatInquiryNumber } from './number.js';
import { routeCallback } from '../../lib/geo.js';
import { metaEventContextSchema, sendMetaServerEvent } from '../../lib/meta-capi.js';
import type { FastifyBaseLogger } from 'fastify';

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
  /** Service PLZ; drives geo callback routing. */
  plz: z
    .string()
    .regex(/^\d{5}$/, 'plz must be exactly 5 digits')
    .optional(),
  callReason: z.string().max(2000).optional(),
  /** Brand-specific form fields; each storefront defines its own keys. */
  metadata: z.record(z.string().max(120), z.unknown()).optional(),
  /** S3 object keys (not URLs) from /storefront/uploads/sign; the dashboard signs short-lived GET URLs on demand. */
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
  // Present only with marketing consent; triggers the server-side Lead.
  meta: metaEventContextSchema.optional(),
});

const updateSchema = z.object({
  status: z.enum(['new', 'in_review', 'quoted', 'won', 'lost']).optional(),
  priority: z.enum(['normal', 'high']).optional(),
  email: z.string().email().max(254).nullable().optional(),
  phone: z.string().max(32).nullable().optional(),
  internalNotes: z.string().max(2000).nullable().optional(),
  quotedAmount: z
    .string()
    .regex(/^\d+(\.\d{1,2})?$/, 'quotedAmount must be numeric')
    .nullable()
    .optional(),
  metadata: z.record(z.unknown()).optional(),
});

export interface CreatedInquiry {
  id: number;
  name: string;
  email: string | null;
  phone: string | null;
  service: string | null;
  message: string;
  preferredDate: string | null;
  budget: string | null;
  plz: string | null;
  callReason: string | null;
  callbackOwner: string | null;
  assignedTo: string | null;
}

// Geo-routes by service PLZ. `human` leads are pinned to the default assignee;
// geo provenance goes under metadata.geo.
export function buildCallbackFields(
  plz: string | null | undefined,
  callReason: string | null | undefined,
) {
  const routing = routeCallback(plz);
  return {
    plz: plz ?? null,
    callReason: callReason ?? null,
    callbackOwner: routing.callbackOwner,
    assignedTo:
      routing.callbackOwner === 'human' ? (env.CALLBACK_DEFAULT_HUMAN_ASSIGNEE_ID ?? null) : null,
    geoMeta: {
      distanceKm: routing.distanceKm,
      geoStatus: routing.geoStatus,
      routedAt: new Date().toISOString(),
    },
  };
}

// Per-email hourly cap (env.INQUIRY_MAX_PER_EMAIL_PER_HOUR): backstop against feedback loops such as
// inbound mail re-ingesting our own notifications. Phone-only leads (no email) are never limited.
export async function isInquiryRateLimited(
  serviceInquiries: TenantTables['serviceInquiries'],
  email: string | null | undefined,
): Promise<boolean> {
  const addr = email?.trim().toLowerCase();
  if (!addr) return false;
  const since = new Date(Date.now() - 3_600_000).toISOString();
  const [agg] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(serviceInquiries)
    .where(
      and(
        sql`lower(${serviceInquiries.email}) = ${addr}`,
        sql`${serviceInquiries.createdAt} >= ${since}::timestamptz`,
      ),
    );
  return (agg?.count ?? 0) >= env.INQUIRY_MAX_PER_EMAIL_PER_HOUR;
}

// Fire-and-forget side-effects: ack mail, admin mail, push, dashboard task. Human leads get a flagged
// `human_callback` task, the rest `inquiry_review`. Failures are logged, never thrown.
export async function notifyInquiryCreated(
  companySlug: string,
  row: CreatedInquiry,
  log: FastifyBaseLogger,
): Promise<void> {
  const isHuman = row.callbackOwner === 'human';
  // Feedback-loop guard: an inquiry from one of our own domains is our own mail re-ingested by the inbound
  // workflow, so suppress all mail for it. The dashboard task and push still fire.
  const suppressMail = isOwnDomainEmail(row.email);
  if (suppressMail) {
    log.warn(
      { inquiryId: row.id, recipientEmail: row.email },
      'Suppressing inquiry mail — contact address is an own domain (loop guard)',
    );
  }
  try {
    const [companyRow] = await db
      .select()
      .from(company)
      .where(eq(company.slug, companySlug))
      .limit(1);
    if (companyRow && !suppressMail) {
      const brand = brandInfoFromCompany(companyRow);
      if (row.email) {
        await sendEmail({
          to: row.email,
          from: brandSender(companyRow),
          log: {
            companySlug: companyRow.slug,
            kind: 'inquiry_ack',
            refType: 'inquiry',
            refId: row.id,
          },
          apiKey: companyRow.resendApiKey ?? undefined,
          replyTo: companyRow.email ?? undefined,
          email: contactAckEmail({
            name: row.name,
            subject: row.service ?? null,
            message: row.message,
            brand,
          }),
        });
      }
      if (companyRow.email) {
        const details: Array<{ label: string; value: string }> = [
          { label: 'Anfrage-Nr.', value: formatInquiryNumber(row.id, new Date()) },
        ];
        if (row.service) details.push({ label: 'Service', value: row.service });
        if (row.preferredDate) details.push({ label: 'Wunschtermin', value: row.preferredDate });
        if (row.budget) details.push({ label: 'Budget', value: row.budget });
        if (row.phone) details.push({ label: 'Telefon', value: row.phone });
        if (row.plz) details.push({ label: 'PLZ', value: row.plz });
        if (row.callReason) details.push({ label: 'Grund des Anrufs', value: row.callReason });
        const adminUrl = `${env.APP_BASE_URL.replace(/\/$/, '')}/inquiries?id=${row.id}`;
        await sendEmail({
          to: companyRow.email,
          from: brandSender(companyRow),
          log: {
            companySlug: companyRow.slug,
            kind: 'staff_notification',
            refType: 'inquiry',
            refId: row.id,
          },
          apiKey: companyRow.resendApiKey ?? undefined,
          replyTo: row.email ?? undefined,
          email: adminInboxNotificationEmail({
            brand,
            kind: 'inquiry',
            fromName: row.name,
            fromEmail: row.email ?? '—',
            subject: row.service ?? null,
            message: row.callReason ?? row.message,
            adminUrl,
            details,
          }),
        });
      }
    }
  } catch (err) {
    log.error(
      { err, inquiryId: row.id, recipientEmail: row.email },
      'Failed to send inquiry emails',
    );
  }

  try {
    const { sendPushToBrandAdmins } = await import('../../lib/push.js');
    await sendPushToBrandAdmins(companySlug, {
      title: isHuman ? `${companySlug} · Rückruf (Hamburg)` : `${companySlug} · Service-Anfrage`,
      body: `${row.name}${row.service ? ` · ${row.service}` : ''}: ${(row.callReason || row.message || '').slice(0, 120)}`,
      url: `/inquiries?id=${row.id}`,
      tag: `inquiry:${row.id}`,
      brandSlug: companySlug,
    });
  } catch (err) {
    log.warn({ err, inquiryId: row.id }, 'push dispatch failed');
  }

  try {
    const { spawnTask } = await import('../../lib/tasks.js');
    if (isHuman) {
      const lines = [
        row.callReason ? `Grund: ${row.callReason}` : null,
        row.phone ? `Tel: ${row.phone}` : null,
        row.plz ? `PLZ: ${row.plz}` : null,
        row.message,
      ].filter(Boolean);
      await spawnTask({
        companySlug,
        kind: 'human_callback',
        refKind: 'service_inquiry',
        refId: row.id,
        title: `Rückruf (Hamburg-Umkreis) – ${row.name}`,
        body: lines.join('\n'),
        priority: 'high',
        assigneeUserId: row.assignedTo ?? undefined,
      });
    } else {
      await spawnTask({
        companySlug,
        kind: 'inquiry_review',
        refKind: 'service_inquiry',
        refId: row.id,
        title: `Anfrage von ${row.name}${row.service ? ` — ${row.service}` : ''}`,
        body: row.message,
        priority: 'high',
      });
    }
  } catch (err) {
    log.warn({ err, inquiryId: row.id }, 'task spawn failed');
  }
}

export const inquiriesPublicRoutes: FastifyPluginAsync = async (app) => {
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
      const { serviceInquiries, customers } = request.company!.tables;
      if (await isInquiryRateLimited(serviceInquiries, body.email)) {
        request.log.warn(
          { email: body.email },
          'Inquiry rejected — per-email hourly rate limit exceeded',
        );
        throw tooManyRequests(
          'Too many inquiries from this email address. Please try again later.',
        );
      }
      const customerId = await linkCustomerByEmail(db, customers, {
        email: body.email,
        name: body.name,
        phone: body.phone,
        marketingOptIn: body.consentMarketing ?? false,
      });
      const { plz, callReason, callbackOwner, assignedTo, geoMeta } = buildCallbackFields(
        body.plz,
        body.callReason,
      );
      const [row] = await db
        .insert(serviceInquiries)
        .values({
          customerId,
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
          plz,
          callReason,
          callbackOwner,
          assignedTo,
          metadata: { ...(body.metadata ?? {}), geo: geoMeta },
          attachments: body.attachments ?? [],
          consentPrivacy: body.consentPrivacy,
          consentMarketing: body.consentMarketing ?? false,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        })
        .returning();

      if (row) {
        await notifyInquiryCreated(request.company!.slug, row, request.log);

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
              customData: { content_name: body.service || 'Anfrage' },
            },
            request.log,
          );
        }
      }

      reply.code(201);
      return { ok: true, inquiry: row ? withNumber(row) : row };
    },
  );
};

const redactPii = redactForViewer;

function withNumber<T extends { id: number; createdAt: Date }>(row: T) {
  return { ...row, inquiryNumber: formatInquiryNumber(row.id, row.createdAt) };
}

export const inquiriesAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('admin'));
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', app.requireWriteAccess);

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
    const accessLevel = accessLevelOf(request);
    return {
      inquiries: page.map((r) => withNumber(redactPii(r, accessLevel))),
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
    const accessLevel = accessLevelOf(request);
    return { inquiry: row ? withNumber(redactPii(row, accessLevel)) : null };
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
    return { inquiry: row ? withNumber(row) : row };
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
    const { serviceInquiries, inquiryEmails } = request.company!.tables;

    const [inquiry] = await db
      .select()
      .from(serviceInquiries)
      .where(eq(serviceInquiries.id, id))
      .limit(1);
    if (!inquiry) throw notFound('Inquiry not found');
    if (!inquiry.email) throw badRequest('Inquiry has no email address to send a quote to');

    const [adminRow] = await db
      .select({ name: user.name })
      .from(user)
      .where(eq(user.id, adminId))
      .limit(1);
    // Internal audit trail only; the mail signs as the brand.
    const sentByName = adminRow?.name ?? null;

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
      // Render once so the exact mail sent is also persisted: the dashboard is the only record (no copy lands in the brand mailbox).
      const rendered = inquiryQuoteEmail({
        recipientName: inquiry.name,
        brand: brandInfoFromCompany(companyRow),
        quoteBody: parsed.body,
        quotedAmount: amountFormatted,
      });
      const result = await sendEmail({
        to: inquiry.email,
        from: brandSender(companyRow),
        log: {
          companySlug: companyRow.slug,
          kind: 'quote',
          refType: 'inquiry',
          refId: id,
          sentByUserId: adminId,
        },
        apiKey: companyRow.resendApiKey ?? undefined,
        replyTo: companyRow.email ?? undefined,
        email: rendered,
      });
      const emailStatus = result.skipped ? 'skipped' : result.ok ? 'sent' : 'failed';
      await db.insert(inquiryEmails).values({
        inquiryId: id,
        kind: 'quote',
        toAddress: inquiry.email,
        subject: rendered.subject,
        html: rendered.html,
        quotedAmount: amountFinal,
        status: emailStatus,
        emailMessageId: result.id ?? null,
        sentByUserId: adminId,
        sentByName,
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
    return { ok: true, inquiry: updated ? withNumber(updated) : updated };
  });

  app.get('/:id/emails', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { inquiryEmails } = request.company!.tables;
    const emails = await db
      .select()
      .from(inquiryEmails)
      .where(eq(inquiryEmails.inquiryId, id))
      .orderBy(desc(inquiryEmails.createdAt), desc(inquiryEmails.id));
    return { emails };
  });

  // Inquiries due a follow-up call: untouched, reachable by phone, privacy consent given, past the wait window
  // but not stale, under the attempt cap, not opted out. The AI must never call a lead a human should handle,
  // so this EXCLUDES human-owned leads by default (callback_owner ai, plus legacy NULLs); ?callbackOwner=ai|human filters.
  const callbackQueueSchema = z.object({
    minAgeHours: z.coerce.number().min(0).max(720).default(24),
    maxAgeDays: z.coerce.number().min(1).max(90).default(14),
    maxAttempts: z.coerce.number().int().min(1).max(10).default(3),
    limit: z.coerce.number().int().min(1).max(200).default(50),
    callbackOwner: z.enum(['ai', 'human']).optional(),
  });
  app.get('/callback-queue', async (request) => {
    const { minAgeHours, maxAgeDays, maxAttempts, limit, callbackOwner } =
      callbackQueueSchema.parse(request.query);
    const { serviceInquiries: si } = request.company!.tables;

    const now = Date.now();
    const newestCreatedAt = new Date(now - minAgeHours * 3_600_000).toISOString();
    const oldestCreatedAt = new Date(now - maxAgeDays * 86_400_000).toISOString();
    const attempts = sql<number>`coalesce((${si.metadata}->'callback'->>'attempts')::int, 0)`;

    const ownerFilter =
      callbackOwner === 'ai'
        ? sql`${si.callbackOwner} = 'ai'`
        : callbackOwner === 'human'
          ? sql`${si.callbackOwner} = 'human'`
          : sql`${si.callbackOwner} is distinct from 'human'`;

    const inquiries = await db
      .select({
        id: si.id,
        name: si.name,
        phone: si.phone,
        email: si.email,
        service: si.service,
        message: si.message,
        plz: si.plz,
        callReason: si.callReason,
        callbackOwner: si.callbackOwner,
        preferredDate: si.preferredDate,
        locale: si.locale,
        priority: si.priority,
        createdAt: si.createdAt,
        attempts,
      })
      .from(si)
      .where(
        and(
          eq(si.status, 'new'),
          eq(si.consentPrivacy, true),
          isNotNull(si.phone),
          sql`length(trim(${si.phone})) > 0`,
          sql`${si.createdAt} <= ${newestCreatedAt}::timestamptz`,
          sql`${si.createdAt} >= ${oldestCreatedAt}::timestamptz`,
          sql`${attempts} < ${maxAttempts}`,
          sql`coalesce(${si.metadata}->'callback'->>'lastOutcome', '') <> 'opted_out'`,
          ownerFilter,
        ),
      )
      .orderBy(asc(si.createdAt), asc(si.id))
      .limit(limit);

    return { inquiries };
  });

  // Human callbacks: unlike the AI queue there is no wait window or attempt cap. The assignee marks one done via PATCH /:id.
  const humanCallbackSchema = z.object({
    limit: z.coerce.number().int().min(1).max(200).default(50),
    assignedTo: z.string().min(1).max(64).optional(),
    // Not z.coerce.boolean() — "false" would coerce to true.
    includeClosed: z
      .enum(['true', 'false'])
      .transform((v) => v === 'true')
      .default('false'),
  });
  app.get('/human-callback-queue', async (request) => {
    const { limit, assignedTo, includeClosed } = humanCallbackSchema.parse(request.query);
    const { serviceInquiries: si } = request.company!.tables;
    const brand = request.company!.slug;

    const filters = [eq(si.callbackOwner, 'human')];
    if (!includeClosed) filters.push(eq(si.status, 'new'));
    if (assignedTo) filters.push(eq(si.assignedTo, assignedTo));

    const rows = await db
      .select({
        id: si.id,
        name: si.name,
        phone: si.phone,
        email: si.email,
        callReason: si.callReason,
        plz: si.plz,
        service: si.service,
        message: si.message,
        status: si.status,
        assignedTo: si.assignedTo,
        priority: si.priority,
        createdAt: si.createdAt,
      })
      .from(si)
      .where(and(...filters))
      .orderBy(asc(si.createdAt), asc(si.id))
      .limit(limit);

    return {
      inquiries: rows.map((r) => ({ ...r, brand, flag: 'Human callback – Hamburg area' })),
    };
  });

  // Records a call outcome: appends a note, bumps the attempt count, advances a still-open inquiry (reached → in_review, opted_out → lost).
  const callbackOutcomeSchema = z.object({
    outcome: z.enum(['reached', 'no_answer', 'voicemail', 'opted_out']),
    summary: z.string().min(1).max(4000),
    nextStatus: z.enum(['new', 'in_review', 'quoted', 'won', 'lost']).optional(),
  });
  app.post('/:id/callback-outcome', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = callbackOutcomeSchema.parse(request.body);
    const adminId = request.authUser!.id;
    const { serviceInquiries: si } = request.company!.tables;

    const [inquiry] = await db.select().from(si).where(eq(si.id, id)).limit(1);
    if (!inquiry) throw notFound('Inquiry not found');

    const now = new Date();
    const stamp = now.toISOString();

    const prevCb = (inquiry.metadata?.callback ?? {}) as Record<string, unknown>;
    const callback = {
      attempts: Number(prevCb.attempts ?? 0) + 1,
      lastOutcome: body.outcome,
      lastAttemptAt: stamp,
      lastSummary: body.summary,
    };

    const note = `[Callback ${body.outcome} · ${stamp}] ${body.summary}`;
    const internalNotes = inquiry.internalNotes ? `${inquiry.internalNotes}\n${note}` : note;

    // Only ever advance a still-new inquiry; never downgrade one a human moved on.
    let status = inquiry.status;
    if (body.nextStatus) {
      status = body.nextStatus;
    } else if (inquiry.status === 'new') {
      if (body.outcome === 'reached') status = 'in_review';
      else if (body.outcome === 'opted_out') status = 'lost';
    }

    const patch: Record<string, unknown> = {
      internalNotes,
      metadata: { ...(inquiry.metadata ?? {}), callback },
      status,
      updatedAt: now,
    };
    if (status === 'in_review' && !inquiry.handledByUserId) {
      patch.handledByUserId = adminId;
      patch.handledAt = now;
    }
    if (status === 'lost' && !inquiry.closedAt) patch.closedAt = now;
    // An explicit opt-out also withdraws marketing consent.
    if (body.outcome === 'opted_out') patch.consentMarketing = false;

    const [row] = await db.update(si).set(patch).where(eq(si.id, id)).returning();
    if (!row) throw notFound('Inquiry not found');
    const accessLevel = accessLevelOf(request);
    reply.code(200);
    return { ok: true, inquiry: withNumber(redactPii(row, accessLevel)) };
  });
};
