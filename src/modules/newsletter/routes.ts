import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { and, desc, eq, gte, lt, or, sql } from 'drizzle-orm';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import { brandInfoFromCompany, brandSender, sendEmail } from '../../email/service.js';
import { newsletterConfirmEmail } from '../../email/templates.js';
import { parseIntId } from '../../lib/http-errors.js';
import {
  randomConfirmToken,
  signUnsubscribeToken,
  verifyUnsubscribeToken,
} from '../../lib/token.js';

const subscribeSchema = z.object({
  email: z.string().email().max(254),
  firstName: z.string().trim().min(1).max(120).optional(),
  lastName: z.string().trim().min(1).max(120).optional(),
  locale: z.string().min(2).max(16).optional(),
  source: z.string().max(64).optional(),
  tags: z.array(z.string().max(64)).max(20).optional(),
  consentMarketing: z.literal(true, {
    errorMap: () => ({ message: 'Marketing consent is required to subscribe' }),
  }),
  /**
   * Honeypot: hidden field rendered off-screen on the storefront. Real users
   * never see it; bots fill every input. Any non-empty value silently treats
   * the submission as success without persisting.
   */
  website: z.string().max(200).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
});

const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000; // 24 h

function appBaseUrl(): string {
  return env.APP_BASE_URL.replace(/\/$/, '');
}

function apiBaseUrl(): string {
  return env.BETTER_AUTH_URL.replace(/\/$/, '');
}

function escapeHtml(input: string): string {
  return input
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function renderHtmlPage(
  reply: FastifyReply,
  opts: {
    title: string;
    /** Heading text — will be HTML-escaped before injection. */
    heading: string;
    /** Pre-rendered, already-trusted HTML for the body. Caller is responsible
     * for escaping any user-controlled segments before passing them here. */
    bodyHtml: string;
    status?: number;
  },
) {
  reply.status(opts.status ?? 200);
  reply.header('Content-Type', 'text/html; charset=utf-8');
  reply.send(`<!DOCTYPE html>
<html lang="de"><head><meta charset="utf-8"/><meta name="viewport" content="width=device-width,initial-scale=1"/><title>${escapeHtml(opts.title)}</title>
<style>body{margin:0;background:#f4ebdc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,sans-serif;color:#2d2419;display:flex;align-items:center;justify-content:center;min-height:100vh;padding:24px}main{max-width:480px;background:#fefaf0;border:1px solid #e2d3b6;border-radius:16px;padding:32px;text-align:center}h1{margin:0 0 12px;font-size:20px}p{margin:0 0 12px;font-size:14px;line-height:1.6}</style>
</head><body><main><h1>${escapeHtml(opts.heading)}</h1>${opts.bodyHtml}</main></body></html>`);
}

// Public submit — used by all 3 storefronts. Tenant resolved via X-Company-Slug.
export const newsletterPublicRoutes: FastifyPluginAsync = async (app) => {
  app.post(
    '/subscribe',
    {
      preHandler: app.resolveCompanyPublic,
      config: {
        rateLimit: { max: 5, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      const body = subscribeSchema.parse(request.body);
      // Honeypot: bot detected — pretend success, never persist.
      if (body.website && body.website.trim().length > 0) {
        reply.code(201);
        return { ok: true, subscriber: null };
      }
      const { newsletterSubscribers } = request.company!.tables;

      const confirmToken = randomConfirmToken();
      const confirmTokenExpiresAt = new Date(Date.now() + CONFIRM_TOKEN_TTL_MS);

      const [row] = await db
        .insert(newsletterSubscribers)
        .values({
          email: body.email,
          firstName: body.firstName,
          lastName: body.lastName,
          locale: body.locale ?? 'de',
          source: body.source,
          tags: body.tags ?? [],
          confirmed: false,
          confirmToken,
          confirmTokenExpiresAt,
          ipAddress: request.ip,
          userAgent: request.headers['user-agent'] ?? null,
        })
        .onConflictDoNothing({ target: newsletterSubscribers.email })
        .returning();

      // If onConflict skipped (email already exists), short-circuit success:
      // never reveal whether the address was already subscribed (enumeration
      // defense + spec-compliant: re-confirming is a no-op).
      if (row) {
        const [companyRow] = await db
          .select()
          .from(company)
          .where(eq(company.slug, request.company!.slug))
          .limit(1);
        if (companyRow) {
          const slug = request.company!.slug;
          const apiBase = apiBaseUrl();
          const confirmUrl = `${apiBase}/storefront/newsletter/confirm?slug=${encodeURIComponent(slug)}&token=${encodeURIComponent(confirmToken)}`;
          const unsubscribeUrl = `${apiBase}/storefront/newsletter/unsubscribe?token=${encodeURIComponent(signUnsubscribeToken({ id: row.id, slug }))}`;
          try {
            await sendEmail({
              to: row.email,
              from: brandSender(companyRow),
              replyTo: companyRow.email ?? undefined,
              email: newsletterConfirmEmail({
                firstName: row.firstName,
                brand: brandInfoFromCompany(companyRow),
                confirmUrl,
                unsubscribeUrl,
              }),
            });
          } catch (err) {
            request.log.error(
              { err, subscriberId: row.id, recipientEmail: row.email },
              'Failed to send newsletter confirm email',
            );
          }
        }
      }

      reply.code(201);
      return { ok: true, subscriber: row ?? null };
    },
  );

  // Double-opt-in confirmation. Single-click GET so the user can confirm from
  // the email without an extra POST step. Idempotent: re-clicking does nothing.
  const confirmQuerySchema = z.object({
    slug: z.string().min(1).max(64),
    token: z.string().min(8).max(200),
  });
  app.get(
    '/confirm',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const q = confirmQuerySchema.safeParse(request.query);
      if (!q.success) {
        return renderHtmlPage(reply, {
          title: 'Ungültiger Link',
          heading: 'Ungültiger Bestätigungs-Link',
          bodyHtml: '<p>Bitte fordere eine neue Anmeldung an.</p>',
          status: 400,
        });
      }
      // Resolve company via the URL slug (no X-Company-Slug header from email clients).
      const [companyRow] = await db
        .select()
        .from(company)
        .where(eq(company.slug, q.data.slug))
        .limit(1);
      if (!companyRow) {
        return renderHtmlPage(reply, {
          title: 'Unbekannt',
          heading: 'Marke nicht gefunden',
          bodyHtml: '<p>Diese Anmeldung gehört zu keiner aktiven Marke.</p>',
          status: 404,
        });
      }
      // Look up the row via the tenant table for this slug.
      const tenant = await import('../../db/schema/tenant.js');
      const tables = tenant.getTenantTables(companyRow.schemaName);
      const now = new Date();
      const [row] = await db
        .select()
        .from(tables.newsletterSubscribers)
        .where(
          and(
            eq(tables.newsletterSubscribers.confirmToken, q.data.token),
            gte(tables.newsletterSubscribers.confirmTokenExpiresAt, now),
          ),
        )
        .limit(1);
      if (!row) {
        return renderHtmlPage(reply, {
          title: 'Abgelaufen',
          heading: 'Bestätigungs-Link ungültig oder abgelaufen',
          bodyHtml: '<p>Bitte melde dich erneut an, um einen neuen Link zu erhalten.</p>',
          status: 410,
        });
      }
      if (!row.confirmed) {
        await db
          .update(tables.newsletterSubscribers)
          .set({
            confirmed: true,
            confirmedAt: now,
            confirmToken: null,
            confirmTokenExpiresAt: null,
            updatedAt: now,
          })
          .where(eq(tables.newsletterSubscribers.id, row.id));
      }
      const unsubscribeUrl = `${apiBaseUrl()}/storefront/newsletter/unsubscribe?token=${encodeURIComponent(
        signUnsubscribeToken({ id: row.id, slug: companyRow.slug }),
      )}`;
      const safeName = escapeHtml(companyRow.name);
      return renderHtmlPage(reply, {
        title: 'Bestätigt',
        heading: `Newsletter bestätigt · ${companyRow.name}`,
        bodyHtml: `<p>Danke! Du erhältst künftig den Newsletter von <strong>${safeName}</strong>.</p>
        <p style="margin-top:24px;font-size:12px;color:#6b5b48;">Du möchtest doch nicht? <a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b5b48;">Hier abmelden</a>.</p>`,
      });
    },
  );

  // One-click unsubscribe — required under §7 UWG / GDPR Art. 21. Stateless
  // HMAC token; no DB lookup needed beyond the action itself.
  const unsubscribeQuerySchema = z.object({
    token: z.string().min(8).max(500),
  });
  app.get(
    '/unsubscribe',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const q = unsubscribeQuerySchema.safeParse(request.query);
      if (!q.success) {
        return renderHtmlPage(reply, {
          title: 'Ungültiger Link',
          heading: 'Ungültiger Abmelde-Link',
          bodyHtml: '<p>Bitte verwende den Link aus der letzten Newsletter-Mail.</p>',
          status: 400,
        });
      }
      const payload = verifyUnsubscribeToken(q.data.token);
      if (!payload) {
        return renderHtmlPage(reply, {
          title: 'Ungültig',
          heading: 'Abmelde-Link ungültig',
          bodyHtml: '<p>Der Link konnte nicht verifiziert werden.</p>',
          status: 400,
        });
      }
      const [companyRow] = await db
        .select()
        .from(company)
        .where(eq(company.slug, payload.slug))
        .limit(1);
      if (!companyRow) {
        return renderHtmlPage(reply, {
          title: 'Unbekannt',
          heading: 'Marke nicht gefunden',
          bodyHtml: '<p>Diese Anmeldung gehört zu keiner aktiven Marke.</p>',
          status: 404,
        });
      }
      const tenant = await import('../../db/schema/tenant.js');
      const tables = tenant.getTenantTables(companyRow.schemaName);
      const now = new Date();
      await db
        .update(tables.newsletterSubscribers)
        .set({ unsubscribedAt: now, updatedAt: now })
        .where(eq(tables.newsletterSubscribers.id, payload.id));
      const safeName = escapeHtml(companyRow.name);
      return renderHtmlPage(reply, {
        title: 'Abgemeldet',
        heading: `Du bist abgemeldet · ${companyRow.name}`,
        bodyHtml: `<p>Wir senden dir keine weiteren Newsletter mehr von <strong>${safeName}</strong>.</p>
        <p style="margin-top:8px;font-size:12px;color:#6b5b48;">War das ein Versehen? Du kannst dich jederzeit auf ${escapeHtml(appBaseUrl())} wieder anmelden.</p>`,
      });
    },
  );
};

// Admin-only — list / delete subscribers per active company.
export const newsletterAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('admin'));
  app.addHook('preHandler', app.requireCompany);

  app.get('/', async (request) => {
    const { limit, cursor } = listQuerySchema.parse(request.query);
    const { newsletterSubscribers } = request.company!.tables;
    const decoded = cursor ? decodeCursor(cursor) : null;
    const where = decoded
      ? or(
          lt(newsletterSubscribers.createdAt, sql`${decoded.createdAt}::timestamptz`),
          and(
            sql`${newsletterSubscribers.createdAt} = ${decoded.createdAt}::timestamptz`,
            lt(newsletterSubscribers.id, decoded.id),
          ),
        )
      : undefined;
    const rows = await db
      .select()
      .from(newsletterSubscribers)
      .where(where)
      .orderBy(desc(newsletterSubscribers.createdAt), desc(newsletterSubscribers.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    return { subscribers: page, nextCursor };
  });

  app.delete('/:id', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { newsletterSubscribers } = request.company!.tables;
    await db.delete(newsletterSubscribers).where(eq(newsletterSubscribers.id, id));
    reply.code(204).send();
  });

  // ---- Sample CSV --------------------------------------------------------
  // Tiny template the admin can download to see the expected column shape.
  // Helps operators format Mailchimp / Excel exports correctly the first time.
  app.get('/import/sample', async (_request, reply) => {
    const lines = [
      'email,first_name,last_name',
      'anna.muster@example.com,Anna,Muster',
      'thomas.beispiel@example.com,Thomas,Beispiel',
    ];
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="newsletter-import-sample.csv"');
    reply.send(lines.join('\r\n') + '\r\n');
  });

  // ---- POST /import (ALL_68) ---------------------------------------------
  // Accepts a JSON body { csv: "header\nrow\nrow..." } — small payloads
  // (typically under 1 MB; the route lifts the per-route body limit).
  // Returns a detailed summary so the UI can show "imported X, skipped Y by
  // reason Z" without a second round-trip.
  const importSchema = z.object({
    csv: z
      .string()
      .min(8)
      .max(10 * 1024 * 1024), // 10 MB hard cap
    /** When true: only return what *would* import, write nothing to DB. */
    dryRun: z.boolean().default(false),
    /** Default tag to attach to every new subscriber. */
    tag: z.string().trim().max(64).optional(),
    /** Source label stored on each row — defaults to "csv-import". */
    source: z.string().trim().max(64).default('csv-import'),
  });

  app.post(
    '/import',
    { bodyLimit: 12 * 1024 * 1024 }, // headroom over the schema's 10 MB
    async (request, reply) => {
      const body = importSchema.parse(request.body);
      const { newsletterSubscribers } = request.company!.tables;

      const { parseCsv, filterImportRows, summarise } = await import('../../lib/csv-import.js');

      // 1. Parse — bail with a 400 if the file is unrecognisable
      let rows;
      try {
        rows = parseCsv(body.csv);
      } catch (err) {
        reply.code(400).send({
          error: err instanceof Error ? err.message : 'CSV could not be parsed',
        });
        return;
      }
      if (rows.length === 0) {
        reply.send({
          summary: summarise([], 0),
          message: 'Datei enthält keine Datenzeilen.',
        });
        return;
      }

      // 2. Build the filter context — own brand domain + already-known emails
      const [companyRow] = await db
        .select()
        .from(company)
        .where(eq(company.slug, request.company!.slug))
        .limit(1);
      const ownDomains: string[] = [];
      if (companyRow?.email) ownDomains.push(companyRow.email.split('@')[1]!.toLowerCase());
      if (companyRow?.senderEmail)
        ownDomains.push(companyRow.senderEmail.split('@')[1]!.toLowerCase());
      try {
        if (companyRow?.websiteUrl) {
          ownDomains.push(new URL(companyRow.websiteUrl).hostname.toLowerCase());
        }
      } catch {
        /* malformed URL — ignore */
      }

      // Load existing emails in one query (PII stays in-tenant).
      const existing = await db
        .select({ email: newsletterSubscribers.email })
        .from(newsletterSubscribers);
      const existingEmails = new Set(existing.map((e) => e.email.toLowerCase()));

      const filtered = filterImportRows(rows, { ownDomains, existingEmails });
      const accepted = filtered.filter((r) => !r.reject);

      // 3. Insert — batched, single transaction. 500/batch keeps each
      //    statement well under Postgres' wire-protocol limits.
      let imported = 0;
      if (!body.dryRun && accepted.length > 0) {
        const BATCH = 500;
        const now = new Date();
        const tags = body.tag ? [body.tag] : [];
        await db.transaction(async (tx) => {
          for (let i = 0; i < accepted.length; i += BATCH) {
            const chunk = accepted.slice(i, i + BATCH);
            const inserted = await tx
              .insert(newsletterSubscribers)
              .values(
                chunk.map((r) => ({
                  email: r.email,
                  firstName: r.firstName ?? null,
                  lastName: r.lastName ?? null,
                  locale: 'de',
                  source: body.source,
                  tags,
                  confirmed: true,
                  confirmedAt: now,
                  ipAddress: request.ip,
                  userAgent: request.headers['user-agent'] ?? null,
                })),
              )
              // Defensive: if a row races in between the dedup scan and the
              // insert (unlikely with a single admin operator, but cheap),
              // skip rather than error the whole batch.
              .onConflictDoNothing({
                target: newsletterSubscribers.email,
              })
              .returning({ id: newsletterSubscribers.id });
            imported += inserted.length;
          }
        });
      }

      reply.code(body.dryRun ? 200 : 201).send({
        summary: summarise(filtered, imported),
        dryRun: body.dryRun,
      });
    },
  );
};
