import { Resend } from 'resend';
import { env } from '../config/env.js';
import type { BrandInfo, EmailSignature, RenderedEmail } from './templates.js';
import { logSend, type EmailLogTag } from './log.js';

const clients = new Map<string, Resend>();

/**
 * Placeholder addresses for imported customers without an email (scripts/import-cleanilo-*).
 * Never mail them; contactability comes from the address alone, so a real email re-enables sending.
 */
export const NONCONTACTABLE_EMAIL_DOMAIN = 'import.cleanilo.local';

export function isNonContactableEmail(addr: string): boolean {
  return addr.trim().toLowerCase().endsWith(`@${NONCONTACTABLE_EMAIL_DOMAIN}`);
}

/** Own brand domain or subdomain (env.OWN_EMAIL_DOMAINS); guards against self-sender feedback loops. */
export function isOwnDomainEmail(addr: string | null | undefined): boolean {
  if (!addr) return false;
  const at = addr.trim().toLowerCase();
  const sep = at.lastIndexOf('@');
  if (sep < 0) return false;
  const domain = at.slice(sep + 1);
  if (!domain) return false;
  return env.OWN_EMAIL_DOMAINS.some((d) => domain === d || domain.endsWith(`.${d}`));
}

function getResend(apiKey?: string | null): Resend | null {
  const key = apiKey || env.RESEND_API_KEY;
  if (!key) return null;
  let client = clients.get(key);
  if (!client) {
    client = new Resend(key);
    clients.set(key, client);
  }
  return client;
}

interface CompanyLike {
  name: string;
  senderEmail?: string | null;
  senderName?: string | null;
}

export function brandSender(company: CompanyLike): string {
  const email = company.senderEmail ?? env.ADMIN_FROM_EMAIL;
  const name = company.senderName ?? company.name ?? env.ADMIN_FROM_NAME;
  return formatSender(name, email);
}

export function adminSender(): string {
  return formatSender(env.ADMIN_FROM_NAME, env.ADMIN_FROM_EMAIL);
}

function formatSender(name: string, email: string): string {
  const safeName = name.replace(/[<>",;]/g, '').trim() || email;
  return `${safeName} <${email}>`;
}

export interface SendOptions {
  to: string | string[];
  from: string;
  email: RenderedEmail;
  replyTo?: string;
  apiKey?: string | null;
  attachments?: Array<{ filename: string; content: Buffer }>;
  headers?: Record<string, string>;
  log: EmailLogTag;
}

const RETRY_DELAYS_MS = [500, 2000];

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/** Send via Resend, retrying transient failures. Never throws — check `ok`. */
export async function sendEmail(opts: SendOptions): Promise<{
  ok: boolean;
  skipped?: boolean;
  id?: string;
  error?: string;
}> {
  // Every send path flows through here, so this one guard blocks placeholder addresses everywhere.
  const requested = Array.isArray(opts.to) ? opts.to : [opts.to];
  const to = requested.filter((addr) => !isNonContactableEmail(addr));
  // Every outcome, including blocked and skipped, is logged so the dashboard shows why no mail arrived.
  const record = (
    status: 'sent' | 'failed' | 'skipped' | 'blocked',
    extra: { resendId?: string; error?: string } = {},
  ) =>
    logSend({
      tag: opts.log,
      to: to.length > 0 ? to : requested,
      from: opts.from,
      replyTo: opts.replyTo,
      subject: opts.email.subject,
      html: opts.email.html,
      attachments: opts.attachments,
      status,
      ...extra,
    });

  if (to.length < requested.length) {
    const blocked = requested.filter(isNonContactableEmail);
    console.info(
      `[email] (blocked — non-contactable) recipients=${blocked.join(',')} subject="${opts.email.subject}"`,
    );
  }
  if (to.length === 0) {
    await record('blocked', { error: 'Platzhalter-Adresse — nicht zustellbar' });
    return { ok: true, skipped: true };
  }

  const resend = getResend(opts.apiKey);
  if (!resend) {
    console.info(
      `[email] (skipped — no Resend API key) to=${to.join(',')} subject="${opts.email.subject}"`,
    );
    await record('skipped', { error: 'Kein Resend-API-Key konfiguriert' });
    return { ok: true, skipped: true };
  }

  let lastError = 'unknown';
  for (let attempt = 0; attempt <= RETRY_DELAYS_MS.length; attempt += 1) {
    try {
      const res = await resend.emails.send({
        from: opts.from,
        to,
        subject: opts.email.subject,
        html: opts.email.html,
        replyTo: opts.replyTo,
        attachments: opts.attachments,
        headers: opts.headers,
        tags: [{ name: 'kind', value: opts.log.kind }],
      });
      if (!res.error) {
        await record('sent', { resendId: res.data?.id });
        return { ok: true, id: res.data?.id };
      }
      lastError = res.error.message;
      // Permanent errors are not retried.
      const name = res.error.name ?? '';
      const permanent = name === 'validation_error' || name === 'invalid_parameter';
      console.error(`[email] send failed (attempt ${attempt + 1}):`, res.error);
      if (permanent) {
        await record('failed', { error: lastError });
        return { ok: false, error: lastError };
      }
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[email] threw (attempt ${attempt + 1}):`, lastError);
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) await sleep(delay);
  }
  await record('failed', { error: lastError });
  return { ok: false, error: lastError };
}

export function brandInfoFromCompany(
  c: CompanyLike & {
    primaryColor?: string | null;
    logoUrl?: string | null;
    email?: string | null;
    phone?: string | null;
    websiteUrl?: string | null;
    legalName?: string | null;
    addressLine1?: string | null;
    addressLine2?: string | null;
    postalCode?: string | null;
    city?: string | null;
    vatId?: string | null;
    registrationNumber?: string | null;
    emailSignature?: EmailSignature | null;
  },
): BrandInfo {
  const addressLines = [
    c.addressLine1,
    c.addressLine2,
    [c.postalCode, c.city].filter(Boolean).join(' ') || null,
  ].filter((x): x is string => Boolean(x));
  return {
    name: c.name,
    domain: c.senderEmail?.split('@')[1] ?? '',
    primaryColor: c.primaryColor ?? undefined,
    logoUrl: c.logoUrl ?? null,
    email: c.email ?? null,
    phone: c.phone ?? null,
    websiteUrl: c.websiteUrl ?? null,
    legalName: c.legalName ?? null,
    addressLines,
    vatId: c.vatId ?? null,
    registrationNumber: c.registrationNumber ?? null,
    signature: c.emailSignature ?? null,
  };
}
