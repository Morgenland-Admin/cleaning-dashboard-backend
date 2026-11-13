/** Checkbox 1 at checkout (approved 2026-11-13); the order stores the text it was given. */
export const TERMS_CONSENT_TEXT =
  'Ich habe die AGB und die Widerrufsbelehrung gelesen und akzeptiere sie.';

/** Checkbox 2, § 356 Abs. 4 BGB: start before the withdrawal period ends. */
export const EARLY_START_CONSENT_TEXT =
  'Ich verlange ausdrücklich, dass CLEANILO mit der Ausführung der Dienstleistung vor Ablauf der Widerrufsfrist beginnt. Mir ist bekannt, dass ich mein Widerrufsrecht verliere, wenn die Dienstleistung vollständig erbracht ist, und dass ich bei einem Widerruf vor vollständiger Erbringung einen Betrag für die bis dahin erbrachte Leistung schulde (§ 356 Abs. 4 BGB).';

// Verbatim from the approved Rechtstexte (2026-11-13); do not reword.
const CLEANILO_BELEHRUNG = [
  '<p><strong>Widerrufsbelehrung</strong></p>',
  '<p><strong>Widerrufsrecht</strong></p>',
  '<p>Sie haben das Recht, binnen vierzehn Tagen ohne Angabe von Gründen diesen Vertrag zu widerrufen.</p>',
  '<p>Die Widerrufsfrist beträgt vierzehn Tage ab dem Tag des Vertragsabschlusses.</p>',
  '<p>Um Ihr Widerrufsrecht auszuüben, müssen Sie uns (CLEANILO Madjidian-Amiri GbR, Brook 9, 20457 Hamburg, Telefon +49 40 43218915, E-Mail info@cleanilo.de) mittels einer eindeutigen Erklärung (z. B. ein mit der Post versandter Brief oder eine E-Mail) über Ihren Entschluss, diesen Vertrag zu widerrufen, informieren. Sie können dafür das beigefügte Muster-Widerrufsformular verwenden, das jedoch nicht vorgeschrieben ist.</p>',
  '<p>Sie können Ihr Widerrufsrecht auch über die elektronische Widerrufsfunktion auf unserer Website ausüben. Die Schaltfläche „Vertrag widerrufen“ finden Sie in der Fußzeile jeder Seite sowie in Ihrem Kundenkonto unter „Mein Konto“. Nach Absenden Ihrer Widerrufserklärung über diese Funktion erhalten Sie von uns unverzüglich eine Eingangsbestätigung per E-Mail mit dem Inhalt Ihrer Erklärung sowie Datum und Uhrzeit ihres Eingangs.</p>',
  '<p>Zur Wahrung der Widerrufsfrist reicht es aus, dass Sie die Mitteilung über die Ausübung des Widerrufsrechts vor Ablauf der Widerrufsfrist absenden.</p>',
  '<p><strong>Folgen des Widerrufs</strong></p>',
  '<p>Wenn Sie diesen Vertrag widerrufen, haben wir Ihnen alle Zahlungen, die wir von Ihnen erhalten haben, einschließlich der Lieferkosten (mit Ausnahme der zusätzlichen Kosten, die sich daraus ergeben, dass Sie eine andere Art der Lieferung als die von uns angebotene, günstigste Standardlieferung gewählt haben), unverzüglich und spätestens binnen vierzehn Tagen ab dem Tag zurückzuzahlen, an dem die Mitteilung über Ihren Widerruf dieses Vertrags bei uns eingegangen ist. Für diese Rückzahlung verwenden wir dasselbe Zahlungsmittel, das Sie bei der ursprünglichen Transaktion eingesetzt haben, es sei denn, mit Ihnen wurde ausdrücklich etwas anderes vereinbart; in keinem Fall werden Ihnen wegen dieser Rückzahlung Entgelte berechnet.</p>',
  '<p>Haben Sie verlangt, dass die Dienstleistungen während der Widerrufsfrist beginnen sollen, so haben Sie uns einen angemessenen Betrag zu zahlen, der dem Anteil der bis zu dem Zeitpunkt, zu dem Sie uns von der Ausübung des Widerrufsrechts hinsichtlich dieses Vertrags unterrichten, bereits erbrachten Dienstleistungen im Vergleich zum Gesamtumfang der im Vertrag vorgesehenen Dienstleistungen entspricht.</p>',
  '<p><strong>Ende der Widerrufsbelehrung</strong></p>',
  '<p><strong>Erlöschen des Widerrufsrechts (gesonderter Hinweis, nicht Teil der Belehrung)</strong></p>',
  '<p>Das Widerrufsrecht erlischt bei einem Vertrag über die Erbringung von Dienstleistungen, wenn wir die Dienstleistung vollständig erbracht haben und mit der Ausführung erst begonnen haben, nachdem Sie dazu Ihre ausdrückliche Zustimmung gegeben und gleichzeitig Ihre Kenntnis davon bestätigt haben, dass Sie Ihr Widerrufsrecht bei vollständiger Vertragserfüllung durch uns verlieren (§ 356 Abs. 4 BGB).</p>',
].join('\n');

const CLEANILO_FORMULAR = [
  '<p><strong>Muster-Widerrufsformular</strong></p>',
  '<p>(Wenn Sie den Vertrag widerrufen wollen, dann füllen Sie bitte dieses Formular aus und senden Sie es zurück.)</p>',
  '<p>An: CLEANILO Madjidian-Amiri GbR, Brook 9, 20457 Hamburg, E-Mail: info@cleanilo.de</p>',
  '<p>Hiermit widerrufe(n) ich/wir (*) den von mir/uns (*) abgeschlossenen Vertrag über den Kauf der folgenden Waren (*) / die Erbringung der folgenden Dienstleistung (*)</p>',
  '<p>Bestellt am (*) / erhalten am (*): ______________________</p>',
  '<p>Name des/der Verbraucher(s): ______________________</p>',
  '<p>Anschrift des/der Verbraucher(s): ______________________</p>',
  '<p>Unterschrift des/der Verbraucher(s) (nur bei Mitteilung auf Papier): ______________________</p>',
  '<p>Datum: ______________________</p>',
  '<p>(*) Unzutreffendes streichen.</p>',
].join('\n');

/** Widerrufsbelehrung + "Erlöschen" note per brand (trusted HTML); null = the e-mail links to /widerruf. */
export const WIDERRUFSBELEHRUNG_HTML: Record<string, string | null> = {
  cleanilo: CLEANILO_BELEHRUNG,
};

/** Muster-Widerrufsformular per brand (trusted HTML). */
export const MUSTER_WIDERRUFSFORMULAR_HTML: Record<string, string | null> = {
  cleanilo: CLEANILO_FORMULAR,
};

/** Site name in the Widerrufsbutton hint of the confirmation e-mail. */
const WIDERRUF_SITE_LABEL: Record<string, string> = {
  cleanilo: 'cleanilo.de',
};

export interface OrderConsents {
  termsAcceptedAt?: string;
  termsText?: string;
  earlyStartAcceptedAt?: string;
  earlyStartText?: string;
}

/** { date: "11.11.2026", time: "15:04" } in Hamburg time. */
export function berlinDateTimeParts(iso: string | Date): { date: string; time: string } {
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
  return {
    date: `${get('day')}.${get('month')}.${get('year')}`,
    time: `${get('hour')}:${get('minute')}`,
  };
}

/** "11.11.2026, 15:04 Uhr" in Hamburg time. */
export function formatBerlinDateTime(iso: string | Date): string {
  const { date, time } = berlinDateTimeParts(iso);
  return `${date}, ${time} Uhr`;
}

/** Pflichtbaustein 4 of the booking confirmation (approved wording). */
export function earlyStartStatement(acceptedAt: string): string {
  return `Sie haben am ${formatBerlinDateTime(acceptedAt)} ausdrücklich verlangt, dass wir mit der Ausführung vor Ablauf der Widerrufsfrist beginnen, und bestätigt, dass Sie bei vollständiger Erbringung Ihr Widerrufsrecht verlieren.`;
}

export interface WithdrawalNotice {
  /** AGB + Widerrufsbelehrung acknowledged at checkout; absent on older orders. */
  termsAcceptedAt?: string;
  termsText: string;
  earlyStartAcceptedAt?: string;
  earlyStartText?: string;
  /** Full Widerrufsbelehrung (trusted HTML) when the brand has approved texts; otherwise a link. */
  belehrungHtml: string | null;
  formularHtml: string | null;
  belehrungUrl: string;
  agbUrl: string;
  /** The Widerrufsbutton page. */
  withdrawUrl: string;
  siteLabel: string;
}

/**
 * Legal block for the order confirmation. Brands with approved texts (CLEANILO): every order with a
 * checkout consent. Other brands: only orders with the early-start consent.
 */
export function withdrawalNoticeFor(
  metadata: Record<string, unknown> | null | undefined,
  companySlug: string,
  storefrontOrigin: string,
): WithdrawalNotice | null {
  const raw: unknown = metadata?.consents;
  const consents: OrderConsents | null = raw && typeof raw === 'object' ? raw : null;
  if (!consents) return null;
  const belehrungHtml = WIDERRUFSBELEHRUNG_HTML[companySlug] ?? null;
  if (!consents.earlyStartAcceptedAt && !(belehrungHtml && consents.termsAcceptedAt)) return null;
  const origin = storefrontOrigin.replace(/\/$/, '');
  return {
    ...(consents.termsAcceptedAt ? { termsAcceptedAt: consents.termsAcceptedAt } : {}),
    termsText: consents.termsText ?? TERMS_CONSENT_TEXT,
    ...(consents.earlyStartAcceptedAt
      ? {
          earlyStartAcceptedAt: consents.earlyStartAcceptedAt,
          earlyStartText: consents.earlyStartText ?? EARLY_START_CONSENT_TEXT,
        }
      : {}),
    belehrungHtml,
    formularHtml: MUSTER_WIDERRUFSFORMULAR_HTML[companySlug] ?? null,
    belehrungUrl: `${origin}/widerruf`,
    agbUrl: `${origin}/agb`,
    withdrawUrl: `${origin}/vertrag-widerrufen`,
    siteLabel: WIDERRUF_SITE_LABEL[companySlug] ?? origin.replace(/^https?:\/\/(www\.)?/, ''),
  };
}
