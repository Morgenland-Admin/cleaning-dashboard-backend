import type { FastifyPluginAsync } from 'fastify';
import { eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { generateText, isAiConfigured, AnthropicError } from '../../lib/anthropic.js';
import { notFound } from '../../lib/http-errors.js';

// "✦ Claude" text assistant: one endpoint drafts/refines operator text.
// The source record is loaded server-side by refId (never trust the client);
// output is returned, never persisted.

const KINDS = ['contact_reply', 'review_response', 'inquiry_note'] as const;
type AssistKind = (typeof KINDS)[number];

const assistSchema = z.object({
  kind: z.enum(KINDS),
  // Id of the contact / review / inquiry to ground the draft on.
  refId: z.number().int().positive(),
  current: z.string().max(8000).optional(), // current draft (refine instead of restart)
  instruction: z.string().max(2000).optional(), // free-text steering, takes priority
  fresh: z.boolean().optional(), // ignore `current`, write from scratch
});

interface PromptParts {
  system: string;
  context: string;
}

const line = (label: string, value: string | number | null | undefined): string | null =>
  value === null || value === undefined || value === '' ? null : `${label}: ${value}`;

const SHARED_RULES = [
  'Schreibe auf Deutsch, per Sie, höflich und professionell.',
  'Gib ausschließlich den fertigen Text zurück — keine Einleitung, keine Erklärung, keine Anführungszeichen, kein Markdown.',
  'Erfinde keine Preise, Termine oder Zusagen, die nicht vorgegeben sind.',
].join(' ');

// System prompt + grounding context for a kind, from its loaded row.
async function buildPrompt(
  kind: AssistKind,
  refId: number,
  brand: string,
  tables: TenantTables,
): Promise<PromptParts> {
  switch (kind) {
    case 'contact_reply': {
      const [msg] = await db
        .select()
        .from(tables.contactMessages)
        .where(eq(tables.contactMessages.id, refId))
        .limit(1);
      if (!msg) throw notFound('Contact message not found');
      const context = [
        line('Name', msg.name),
        line('Betreff', msg.subject),
        line('Nachricht des Kunden', msg.message),
      ]
        .filter(Boolean)
        .join('\n');
      return {
        system:
          `Du bist im Kundenservice-Team von ${brand}, einem deutschen Reinigungsunternehmen. ` +
          `Verfasse eine hilfreiche, freundliche E-Mail-Antwort auf die Kontaktanfrage. ` +
          `Gehe auf das Anliegen ein, biete den nächsten Schritt an und halte dich kurz. ` +
          `Keine Betreffzeile, keine Grußformel-Signatur mit Platzhaltern. ${SHARED_RULES}`,
        context,
      };
    }
    case 'review_response': {
      const [review] = await db
        .select()
        .from(tables.reviews)
        .where(eq(tables.reviews.id, refId))
        .limit(1);
      if (!review) throw notFound('Review not found');
      const context = [
        line('Name', review.customerName),
        line('Bewertung (Sterne)', `${review.rating}/5`),
        line('Kommentar des Kunden', review.comment),
      ]
        .filter(Boolean)
        .join('\n');
      return {
        system:
          `Du antwortest im Namen von ${brand}, einem deutschen Reinigungsunternehmen, ` +
          `öffentlich auf eine Kundenbewertung. Bedanke dich, gehe konkret auf das Feedback ein ` +
          `und bleibe wertschätzend. Bei Kritik: ernst nehmen, Lösung/Kontakt anbieten, nicht rechtfertigen. ` +
          `Halte die Antwort knapp (2–4 Sätze). ${SHARED_RULES}`,
        context,
      };
    }
    case 'inquiry_note': {
      const [inq] = await db
        .select()
        .from(tables.serviceInquiries)
        .where(eq(tables.serviceInquiries.id, refId))
        .limit(1);
      if (!inq) throw notFound('Inquiry not found');
      const context = [
        line('Name', inq.name),
        line('Service', inq.service),
        line('Objekt/Details', inq.propertyDetails),
        line('Wunschtermin', inq.preferredDate),
        line('Budget', inq.budget),
        line('PLZ', inq.plz),
        line('Grund des Anrufs', inq.callReason),
        line('Nachricht', inq.message),
      ]
        .filter(Boolean)
        .join('\n');
      return {
        system:
          `Du unterstützt das Vertriebsteam von ${brand}, einem deutschen Reinigungsunternehmen. ` +
          `Schreibe eine kompakte interne Notiz zu dieser Anfrage: kurze Einschätzung, offene Punkte ` +
          `und ein konkreter nächster Schritt (z. B. Rückruf, Angebot, fehlende Infos). ` +
          `Stichpunkte sind erlaubt. Dies ist eine interne Notiz, kein Kundentext. ${SHARED_RULES}`,
        context,
      };
    }
  }
}

export const aiAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAudience('admin'));
  app.addHook('preHandler', app.requireCompany);

  // Bounded: this hits a paid API. Admin-gated, so the cap is generous.
  app.post(
    '/assist',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!isAiConfigured()) {
        reply.code(503);
        return { error: 'KI-Textassistent ist nicht konfiguriert (ANTHROPIC_API_KEY fehlt).' };
      }

      const body = assistSchema.parse(request.body);
      const { system, context } = await buildPrompt(
        body.kind,
        body.refId,
        request.company!.name,
        request.company!.tables,
      );

      const useCurrent = !body.fresh && body.current && body.current.trim().length > 0;
      const user = [
        context,
        useCurrent ? `\nAktueller Entwurf (verbessern, nicht neu beginnen):\n${body.current}` : '',
        body.instruction
          ? `\nAnweisung (hat Vorrang): ${body.instruction}`
          : useCurrent
            ? '\nAnweisung: Verbessere den aktuellen Entwurf.'
            : '\nAnweisung: Verfasse den Text.',
      ]
        .filter(Boolean)
        .join('\n');

      try {
        const text = await generateText({ system, user });
        return { text };
      } catch (err) {
        if (err instanceof AnthropicError) {
          request.log.error({ err, kind: body.kind }, 'Anthropic assist failed');
          reply.code(502);
          return { error: 'Claude konnte gerade nicht antworten. Bitte erneut versuchen.' };
        }
        throw err;
      }
    },
  );
};
