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

const KINDS = [
  'contact_reply',
  'review_response',
  'inquiry_note',
  'inquiry_quote',
  'order_message',
] as const;
type AssistKind = (typeof KINDS)[number];

const assistSchema = z.object({
  kind: z.enum(KINDS),
  // Id of the contact / review / inquiry to ground the draft on.
  refId: z.number().int().positive(),
  current: z.string().max(8000).optional(), // current draft (refine instead of restart)
  instruction: z.string().max(2000).optional(), // free-text steering, takes priority
  fresh: z.boolean().optional(), // ignore `current`, write from scratch
});

// Structured extraction: turn an inquiry's request + drafted offer text into
// offer line items. Grounded on the inquiry by refId; `current` is the offer
// text box (optional). Returns JSON, unlike the free-text /assist endpoint.
const extractItemsSchema = z.object({
  refId: z.number().int().positive(),
  current: z.string().max(8000).optional(), // offer text box, if the operator drafted one
});

// One extracted service position. Prices are filled only when the text names
// one (unitPriceGross null otherwise) — Claude is told never to invent prices.
const extractedItemSchema = z.object({
  label: z.string().trim().min(1).max(200),
  quantity: z.coerce.number().positive().max(100_000).catch(1),
  unitPriceGross: z.coerce.number().nonnegative().max(1_000_000).nullable().catch(null),
});

interface PromptParts {
  system: string;
  context: string;
}

const line = (label: string, value: string | number | null | undefined): string | null =>
  value === null || value === undefined || value === '' ? null : `${label}: ${value}`;

// Output-format + honesty rules every kind shares, independent of address form.
const OUTPUT_RULES =
  'Gib ausschließlich den fertigen Text zurück — keine Einleitung, keine Erklärung, keine Anführungszeichen, kein Markdown. ' +
  'Erfinde keine Preise, Termine oder Zusagen, die nicht vorgegeben sind.';
// Default: formal address. inquiry_quote overrides the address form (du) below.
const SHARED_RULES = `Schreibe auf Deutsch, per Sie, höflich und professionell. ${OUTPUT_RULES}`;

// Grounding context for an inquiry, shared by the quote draft and the
// structured line-item extraction below. Loaded server-side by refId.
async function loadInquiryQuoteContext(refId: number, tables: TenantTables): Promise<string> {
  const [inq] = await db
    .select()
    .from(tables.serviceInquiries)
    .where(eq(tables.serviceInquiries.id, refId))
    .limit(1);
  if (!inq) throw notFound('Inquiry not found');
  // The AI vision pipeline drops carpet/dirt details into metadata.carpet;
  // surface it so the offer can reference what was actually requested.
  const carpet = (inq.metadata as { carpet?: unknown } | null)?.carpet;
  return [
    line('Name', inq.name),
    line('Service', inq.service),
    line('Objekt/Details', inq.propertyDetails),
    line('Wunschtermin', inq.preferredDate),
    line('Budget', inq.budget),
    line('Bereits genannter Angebotsbetrag', inq.quotedAmount),
    line('PLZ', inq.plz),
    line('Nachricht des Kunden', inq.message),
    carpet ? line('Erkannte Teppich-Details', JSON.stringify(carpet)) : null,
  ]
    .filter(Boolean)
    .join('\n');
}

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
    case 'inquiry_quote': {
      const context = await loadInquiryQuoteContext(refId, tables);
      return {
        system:
          `Du bist im Vertriebsteam von ${brand}, einem deutschen Reinigungsunternehmen. ` +
          `Verfasse den Fließtext für eine Angebots-E-Mail an den Kunden — den Teil, der zwischen ` +
          `Anrede und Signatur steht. Gehe konkret auf die Anfrage ein, beschreibe die vorgeschlagene ` +
          `Leistung und nenne, falls vorgegeben, den Preis; lade zur Beauftragung ein. ` +
          `Keine Betreffzeile, keine Anrede ("Hallo …"), keine Signatur — diese ergänzt die Vorlage. ` +
          `Schreibe auf Deutsch, freundlich und per "du" (so wie die Marke ihre Kunden anspricht). ${OUTPUT_RULES}`,
        context,
      };
    }
    case 'order_message': {
      const [order] = await db
        .select()
        .from(tables.orders)
        .where(eq(tables.orders.id, refId))
        .limit(1);
      if (!order) throw notFound('Order not found');
      const items = await db
        .select()
        .from(tables.orderItems)
        .where(eq(tables.orderItems.orderId, refId));
      const meta = (order.metadata ?? {}) as { confirmedSlot?: string };
      const context = [
        line('Auftragsnummer', order.orderNumber ?? `#${order.id}`),
        line('Kunde', order.customerName),
        line('Leistung', order.kind),
        line('Status', order.status),
        line('Abholung/Adresse', order.pickupLabel),
        line('Wunschtermin', order.preferredDate),
        line('Bestätigter Termin', meta.confirmedSlot),
        items.length ? line('Positionen', items.map((it) => it.label).join(', ')) : null,
        line('Kundenmitteilung', order.customerNotes),
      ]
        .filter(Boolean)
        .join('\n');
      return {
        system:
          `Du bist im Kundenservice-Team von ${brand}, einem deutschen Reinigungsunternehmen. ` +
          `Verfasse eine kurze, freundliche E-Mail an den Kunden zu seinem laufenden Auftrag ` +
          `(z. B. Rückfrage, Statusinfo, Terminabstimmung). Gehe konkret auf den Auftrag ein und ` +
          `nenne den nächsten Schritt. Keine Betreffzeile, keine Signatur — diese ergänzt die Vorlage. ` +
          `${SHARED_RULES}`,
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

  // Extract offer line items from the inquiry request + drafted offer text.
  app.post(
    '/extract-offer-items',
    { config: { rateLimit: { max: 30, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!isAiConfigured()) {
        reply.code(503);
        return { error: 'KI-Textassistent ist nicht konfiguriert (ANTHROPIC_API_KEY fehlt).' };
      }

      const body = extractItemsSchema.parse(request.body);
      const context = await loadInquiryQuoteContext(body.refId, request.company!.tables);
      const brand = request.company!.name;

      const system =
        `Du extrahierst die angefragten Reinigungs-Leistungen als strukturierte ` +
        `Angebotspositionen für ${brand}, ein deutsches Reinigungsunternehmen. ` +
        `Gib ausschließlich ein JSON-Array zurück — kein Fließtext, keine Erklärung, kein Markdown. ` +
        `Jedes Element hat die Form {"label": string, "quantity": number, "unitPriceGross": number|null}. ` +
        `label: kurze, konkrete Leistungsbezeichnung auf Deutsch (z. B. "Teppichreinigung 200×300 cm"). ` +
        `quantity: Menge als Zahl (Standard 1). ` +
        `unitPriceGross: Bruttopreis pro Einheit in Euro, NUR wenn im Text ausdrücklich genannt; ` +
        `sonst null. Preise niemals erfinden, schätzen oder runden. ` +
        `Wenn keine Leistungen erkennbar sind, gib [] zurück. Höchstens 20 Positionen.`;

      const user = [
        context,
        body.current && body.current.trim() ? `\nAngebotstext (Entwurf):\n${body.current}` : '',
        '\nAufgabe: Extrahiere die Angebotspositionen als JSON-Array.',
      ]
        .filter(Boolean)
        .join('\n');

      try {
        const text = await generateText({ system, user });
        let parsed: unknown = null;
        try {
          parsed = JSON.parse(text);
        } catch {
          parsed = null;
        }
        const items = Array.isArray(parsed)
          ? parsed
              .flatMap((raw) => {
                const r = extractedItemSchema.safeParse(raw);
                return r.success ? [r.data] : [];
              })
              .slice(0, 20)
          : [];
        return { items };
      } catch (err) {
        if (err instanceof AnthropicError) {
          request.log.error({ err }, 'Anthropic item extraction failed');
          reply.code(502);
          return { error: 'Claude konnte gerade nicht antworten. Bitte erneut versuchen.' };
        }
        throw err;
      }
    },
  );
};
