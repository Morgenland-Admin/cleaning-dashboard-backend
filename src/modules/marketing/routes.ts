import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { and, eq, isNull, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import { getTenantTables } from '../../db/schema/tenant.js';
import { verifyMarketingOptOutToken } from '../../lib/token.js';
import { escapeHtml, renderHtmlPage } from '../newsletter/routes.js';

const querySchema = z.object({
  t: z.string().min(8).max(500),
  channel: z.enum(['email', 'sms']),
});

const CHANNEL_LABEL = { email: 'Werbe-E-Mails', sms: 'Werbe-SMS' } as const;

async function resolve(query: unknown) {
  const q = querySchema.safeParse(query);
  const payload = q.success ? verifyMarketingOptOutToken(q.data.t) : null;
  if (!q.success || !payload) return null;
  const [companyRow] = await db
    .select()
    .from(company)
    .where(eq(company.slug, payload.slug))
    .limit(1);
  if (!companyRow) return null;
  return { ...q.data, customerId: payload.customerId, companyRow };
}

function invalidLink(reply: FastifyReply) {
  return renderHtmlPage(reply, {
    title: 'Ungültiger Link',
    heading: 'Ungültiger Abmelde-Link',
    bodyHtml:
      '<p>Der Link konnte nicht verifiziert werden. Bitte verwenden Sie den vollständigen Link aus unserer Nachricht.</p>',
    status: 400,
  });
}

/** Per-channel marketing opt-out (e-mail / SMS) from a signed link; sets customers.*_marketing_opt_out_at. */
export const marketingPublicRoutes: FastifyPluginAsync = async (app) => {
  // RFC 8058 one-click POSTs send an urlencoded body; the token is in the query string.
  app.addContentTypeParser(
    'application/x-www-form-urlencoded',
    { parseAs: 'string' },
    (_req, _body, done) => done(null, {}),
  );

  // Confirmation page only: mail scanners prefetch GETs, so the POST does the work.
  app.get(
    '/unsubscribe',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const r = await resolve(request.query);
      if (!r) return invalidLink(reply);
      const qs = new URLSearchParams({ t: r.t, channel: r.channel }).toString();
      return renderHtmlPage(reply, {
        title: 'Abmelden',
        heading: `${CHANNEL_LABEL[r.channel]} abbestellen · ${r.companyRow.name}`,
        bodyHtml: `<p>Möchten Sie keine ${CHANNEL_LABEL[r.channel]} mehr von <strong>${escapeHtml(r.companyRow.name)}</strong> erhalten?</p>
        <form method="post" action="?${escapeHtml(qs)}" style="margin-top:16px;">
          <button type="submit" style="background:#bd5b3e;color:#fff;border:0;border-radius:8px;padding:12px 24px;font-size:14px;cursor:pointer;">Jetzt abmelden</button>
        </form>`,
      });
    },
  );

  app.post(
    '/unsubscribe',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      const r = await resolve(request.query);
      if (!r) return invalidLink(reply);
      const t = getTenantTables(r.companyRow.schemaName);
      const now = new Date();
      await db.transaction(async (tx) => {
        if (r.channel === 'email') {
          await tx
            .update(t.customers)
            .set({
              emailMarketingOptOutAt: sql`coalesce(${t.customers.emailMarketingOptOutAt}, ${now})`,
              marketingOptIn: false,
              updatedAt: now,
            })
            .where(eq(t.customers.id, r.customerId));
          // Opting out of marketing e-mail also ends the newsletter.
          await tx
            .update(t.newsletterSubscribers)
            .set({ unsubscribedAt: now, updatedAt: now })
            .where(
              and(
                eq(t.newsletterSubscribers.customerId, r.customerId),
                isNull(t.newsletterSubscribers.unsubscribedAt),
              ),
            );
        } else {
          await tx
            .update(t.customers)
            .set({
              smsMarketingOptOutAt: sql`coalesce(${t.customers.smsMarketingOptOutAt}, ${now})`,
              updatedAt: now,
            })
            .where(eq(t.customers.id, r.customerId));
        }
      });
      return renderHtmlPage(reply, {
        title: 'Abgemeldet',
        heading: `Sie sind abgemeldet · ${r.companyRow.name}`,
        bodyHtml: `<p>Wir senden Ihnen keine ${CHANNEL_LABEL[r.channel]} mehr von <strong>${escapeHtml(r.companyRow.name)}</strong>. Nachrichten zu Ihren Aufträgen erhalten Sie weiterhin.</p>`,
      });
    },
  );
};
