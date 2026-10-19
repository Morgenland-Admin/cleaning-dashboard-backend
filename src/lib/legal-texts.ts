/** Consent wording shown at checkout; the storefront shows the same text and the order stores it. */
export const TERMS_CONSENT_TEXT =
  'Ich habe die AGB und die Widerrufsbelehrung zur Kenntnis genommen.';

/** § 356 Abs. 4 BGB: start before the withdrawal period ends; right expires on full performance. */
export const EARLY_START_CONSENT_TEXT =
  'Ich verlange ausdrücklich, dass Sie vor Ablauf der Widerrufsfrist mit der Ausführung der Dienstleistung beginnen. Mir ist bekannt, dass ich mein Widerrufsrecht bei vollständiger Vertragserfüllung verliere.';

/** Widerrufsbelehrung per brand for the confirmation e-mail; null = text not delivered yet (link instead). */
export const WIDERRUFSBELEHRUNG_HTML: Record<string, string | null> = {
  cleanilo: null,
};

export interface OrderConsents {
  termsAcceptedAt?: string;
  earlyStartAcceptedAt?: string;
  earlyStartText?: string;
}

/** "11.11.2026, 15:04 Uhr" in Hamburg time. */
export function formatBerlinDateTime(iso: string | Date): string {
  const d = typeof iso === 'string' ? new Date(iso) : iso;
  const parts = new Intl.DateTimeFormat('de-DE', {
    timeZone: 'Europe/Berlin',
    day: '2-digit',
    month: '2-digit',
    year: 'numeric',
    hour: '2-digit',
    minute: '2-digit',
    hour12: false,
  }).formatToParts(d);
  const get = (t: string) => parts.find((p) => p.type === t)?.value ?? '';
  return `${get('day')}.${get('month')}.${get('year')}, ${get('hour')}:${get('minute')} Uhr`;
}

export interface WithdrawalNotice {
  earlyStartAcceptedAt: string;
  earlyStartText: string;
  /** Full Widerrufsbelehrung (trusted HTML) once delivered; otherwise the e-mail links to the page. */
  belehrungHtml: string | null;
  belehrungUrl: string;
}

/** Block for the order confirmation; null for orders without the early-start consent (e.g. HTR). */
export function withdrawalNoticeFor(
  metadata: Record<string, unknown> | null | undefined,
  companySlug: string,
  storefrontOrigin: string,
): WithdrawalNotice | null {
  const raw: unknown = metadata?.consents;
  const consents: OrderConsents | null = raw && typeof raw === 'object' ? raw : null;
  if (!consents?.earlyStartAcceptedAt) return null;
  return {
    earlyStartAcceptedAt: consents.earlyStartAcceptedAt,
    earlyStartText: consents.earlyStartText ?? EARLY_START_CONSENT_TEXT,
    belehrungHtml: WIDERRUFSBELEHRUNG_HTML[companySlug] ?? null,
    belehrungUrl: `${storefrontOrigin.replace(/\/$/, '')}/widerruf`,
  };
}
