import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { and, desc, eq, gte, ilike, isNotNull, isNull, or, sql } from 'drizzle-orm';
import { encodeCursor, keysetAfter } from '../../lib/cursor.js';
import { z } from 'zod';
import { env } from '../../config/env.js';
import { accessLevelOf, redactListForViewer } from '../../lib/access.js';
import { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import { linkCustomerByEmail } from '../../lib/customers.js';
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
  website: z.string().max(200).optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
  status: z.enum(['confirmed', 'pending', 'unsubscribed']).optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

const CONFIRM_TOKEN_TTL_MS = 24 * 60 * 60 * 1000;

function likeTerm(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
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
    /** HTML-escaped before injection. */
    heading: string;
    /** Trusted pre-rendered HTML; the caller must escape any user-controlled segments. */
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

export const newsletterPublicRoutes: FastifyPluginAsync = async (app) => {
  // The unsubscribe form and RFC 8058 clients POST urlencoded bodies; the token is in the query string,
  // so the body is accepted and discarded.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, _body, done) => done(null, {}),
  );

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
      if (body.website && body.website.trim().length > 0) {
        reply.code(201);
        return { ok: true, subscriber: null };
      }
      const { newsletterSubscribers, customers } = request.company!.tables;

      const confirmToken = randomConfirmToken();
      const confirmTokenExpiresAt = new Date(Date.now() + CONFIRM_TOKEN_TTL_MS);

      // Marketing opt-in is set on confirm (double opt-in), not here.
      const customerId = await linkCustomerByEmail(db, customers, {
        email: body.email,
        name: [body.firstName, body.lastName].filter(Boolean).join(' ') || null,
      });

      const [row] = await db
        .insert(newsletterSubscribers)
        .values({
          email: body.email,
          customerId,
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
          const result = await sendEmail({
            to: row.email,
            from: brandSender(companyRow),
            log: { companySlug: slug, kind: 'newsletter_confirm' },
            apiKey: companyRow.resendApiKey ?? undefined,
            replyTo: companyRow.email ?? undefined,
            // RFC 8058 one-click unsubscribe (Gmail/Yahoo bulk-sender rules).
            headers: {
              'List-Unsubscribe': `<${unsubscribeUrl}>`,
              'List-Unsubscribe-Post': 'List-Unsubscribe=One-Click',
            },
            email: newsletterConfirmEmail({
              firstName: row.firstName,
              brand: brandInfoFromCompany(companyRow),
              confirmUrl,
              unsubscribeUrl,
            }),
          });
          if (!result.ok) {
            request.log.error(
              { error: result.error, subscriberId: row.id },
              'Failed to send newsletter confirm email',
            );
          }
        }
      }

      reply.code(201);
      return { ok: true, subscriber: row ?? null };
    },
  );

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
          bodyHtml: '<p>Bitte melden Sie sich erneut zum Newsletter an.</p>',
          status: 400,
        });
      }

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
          bodyHtml: '<p>Bitte melden Sie sich erneut an, um einen neuen Link zu erhalten.</p>',
          status: 410,
        });
      }
      if (!row.confirmed) {
        await db.transaction(async (tx) => {
          await tx
            .update(tables.newsletterSubscribers)
            .set({
              confirmed: true,
              confirmedAt: now,
              confirmToken: null,
              confirmTokenExpiresAt: null,
              updatedAt: now,
            })
            .where(eq(tables.newsletterSubscribers.id, row.id));
          if (row.customerId) {
            await tx
              .update(tables.customers)
              .set({ marketingOptIn: true, updatedAt: now })
              .where(eq(tables.customers.id, row.customerId));
          }
        });
      }
      const unsubscribeUrl = `${apiBaseUrl()}/storefront/newsletter/unsubscribe?token=${encodeURIComponent(
        signUnsubscribeToken({ id: row.id, slug: companyRow.slug }),
      )}`;
      const safeName = escapeHtml(companyRow.name);
      return renderHtmlPage(reply, {
        title: 'Bestätigt',
        heading: `Newsletter bestätigt · ${companyRow.name}`,
        bodyHtml: `<p>Vielen Dank! Sie erhalten künftig den Newsletter von <strong>${safeName}</strong>.</p>
        <p style="margin-top:24px;font-size:12px;color:#6b5b48;">Sie möchten den Newsletter doch nicht erhalten? <a href="${escapeHtml(unsubscribeUrl)}" style="color:#6b5b48;">Hier abmelden</a>.</p>`,
      });
    },
  );

  const unsubscribeQuerySchema = z.object({
    token: z.string().min(8).max(500),
  });

  /** Confirmation page only: mail scanners prefetch GETs, so the POST does the work. */
  app.get(
    '/unsubscribe',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const q = unsubscribeQuerySchema.safeParse(request.query);
      const payload = q.success ? verifyUnsubscribeToken(q.data.token) : null;
      if (!q.success || !payload) {
        return renderHtmlPage(reply, {
          title: 'Ungültiger Link',
          heading: 'Ungültiger Abmelde-Link',
          bodyHtml: '<p>Bitte verwenden Sie den Link aus der letzten Newsletter-E-Mail.</p>',
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
      const safeName = escapeHtml(companyRow.name);
      const action = `${apiBaseUrl()}/storefront/newsletter/unsubscribe?token=${encodeURIComponent(q.data.token)}`;
      return renderHtmlPage(reply, {
        title: 'Abmelden',
        heading: `Newsletter abmelden · ${companyRow.name}`,
        bodyHtml: `<p>Möchten Sie keinen Newsletter mehr von <strong>${safeName}</strong> erhalten?</p>
        <form method="post" action="${escapeHtml(action)}" style="margin-top:16px;">
          <button type="submit" style="background:#bd5b3e;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-size:14px;cursor:pointer;">Jetzt abmelden</button>
        </form>`,
      });
    },
  );

  /** Also serves RFC 8058 one-click POSTs. */
  app.post(
    '/unsubscribe',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const q = unsubscribeQuerySchema.safeParse(request.query);
      const payload = q.success ? verifyUnsubscribeToken(q.data.token) : null;
      if (!q.success || !payload) {
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
      await db.transaction(async (tx) => {
        const [sub] = await tx
          .update(tables.newsletterSubscribers)
          .set({ unsubscribedAt: now, updatedAt: now })
          .where(eq(tables.newsletterSubscribers.id, payload.id))
          .returning({ customerId: tables.newsletterSubscribers.customerId });
        // Unsubscribing withdraws the marketing consent on the customer record too.
        if (sub?.customerId) {
          await tx
            .update(tables.customers)
            .set({ marketingOptIn: false, updatedAt: now })
            .where(eq(tables.customers.id, sub.customerId));
        }
      });
      const safeName = escapeHtml(companyRow.name);
      // The brand's website, not APP_BASE_URL (that is the admin dashboard).
      const site = companyRow.storefrontOrigin ?? companyRow.websiteUrl;
      return renderHtmlPage(reply, {
        title: 'Abgemeldet',
        heading: `Sie sind abgemeldet · ${companyRow.name}`,
        bodyHtml: `<p>Wir senden Ihnen keinen Newsletter mehr von <strong>${safeName}</strong>.</p>
        <p style="margin-top:8px;font-size:12px;color:#6b5b48;">War das ein Versehen? Sie können sich jederzeit ${site ? `auf ${escapeHtml(site)}` : 'auf unserer Website'} wieder anmelden.</p>`,
      });
    },
  );
};

export const newsletterAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('admin'));
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', app.requireWriteAccess);

  app.get('/', async (request) => {
    const { limit, cursor, status, q } = listQuerySchema.parse(request.query);
    const subs = request.company!.tables.newsletterSubscribers;
    const statusOf = {
      unsubscribed: isNotNull(subs.unsubscribedAt),
      confirmed: and(isNull(subs.unsubscribedAt), eq(subs.confirmed, true))!,
      pending: and(isNull(subs.unsubscribedAt), eq(subs.confirmed, false))!,
    };
    const search = q
      ? or(
          ilike(subs.email, likeTerm(q)),
          ilike(subs.firstName, likeTerm(q)),
          ilike(subs.lastName, likeTerm(q)),
        )
      : undefined;
    const after = keysetAfter(subs, subs.createdAt, subs.id, cursor);
    const [rows, counts] = await Promise.all([
      db
        .select()
        .from(subs)
        .where(and(search, status ? statusOf[status] : undefined, after))
        .orderBy(desc(subs.createdAt), desc(subs.id))
        .limit(limit + 1),
      // Tab counts for the current search; only the first page needs them.
      cursor
        ? null
        : db
            .select({
              all: sql<number>`count(*)::int`,
              confirmed: sql<number>`(count(*) filter (where ${statusOf.confirmed}))::int`,
              pending: sql<number>`(count(*) filter (where ${statusOf.pending}))::int`,
              unsubscribed: sql<number>`(count(*) filter (where ${statusOf.unsubscribed}))::int`,
            })
            .from(subs)
            .where(search)
            .then((r) => r[0] ?? null),
    ]);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    // Subscriber rows carry the signup IP/user-agent; redacted for viewers.
    return {
      subscribers: redactListForViewer(page, accessLevelOf(request)),
      nextCursor,
      counts,
    };
  });

  app.delete('/:id', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { newsletterSubscribers } = request.company!.tables;
    await db.delete(newsletterSubscribers).where(eq(newsletterSubscribers.id, id));
    reply.code(204).send();
  });

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

  const importSchema = z.object({
    csv: z
      .string()
      .min(8)
      .max(10 * 1024 * 1024),
    dryRun: z.boolean().default(false),
    tag: z.string().trim().max(64).optional(),
    source: z.string().trim().max(64).default('csv-import'),
    // UWG §7: the sender must prove consent. Rows import as confirmed only when the admin attests
    // proof exists, otherwise they must double-opt-in.
    attestConsent: z.boolean().default(false),
  });

  app.post('/import', { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const body = importSchema.parse(request.body);
    const { newsletterSubscribers } = request.company!.tables;

    const { parseCsv, filterImportRows, summarise } = await import('../../lib/csv-import.js');

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

    const existing = await db
      .select({ email: newsletterSubscribers.email })
      .from(newsletterSubscribers);
    const existingEmails = new Set(existing.map((e) => e.email.toLowerCase()));

    const filtered = filterImportRows(rows, { ownDomains, existingEmails });
    const accepted = filtered.filter((r) => !r.reject);

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
                source: body.attestConsent ? `${body.source} (consent attested)` : body.source,
                tags,
                confirmed: body.attestConsent,
                confirmedAt: body.attestConsent ? now : null,
                ipAddress: request.ip,
                userAgent: request.headers['user-agent'] ?? null,
              })),
            )
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
      consentAttested: body.attestConsent,
      note: body.attestConsent
        ? 'Importiert als bestätigt — Einwilligungsnachweise müssen vorliegen (UWG §7).'
        : 'Importiert als UNBESTÄTIGT — Empfänger erhalten erst nach Double-Opt-in Newsletter.',
    });
  });
};
