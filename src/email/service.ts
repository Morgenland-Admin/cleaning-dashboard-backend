import { Resend } from 'resend';
import { env } from '../config/env.js';
import type { BrandInfo, EmailSignature, RenderedEmail } from './templates.js';

const clients = new Map<string, Resend>();

/**
 * Domain used for synthetic placeholder addresses on imported customers that
 * have no real email (see scripts/import-cleanilo-*). These are non-routable
 * and must never receive mail — transactional, dunning, review or newsletter.
 * Contactability is derived purely from the address, so replacing a placeholder
 * with a real email automatically re-enables sending (no flag to clear).
 */
export const NONCONTACTABLE_EMAIL_DOMAIN = 'import.cleanilo.local';

/** True if `addr` is a synthetic placeholder that must never be emailed. */
export function isNonContactableEmail(addr: string): boolean {
  return addr.trim().toLowerCase().endsWith(`@${NONCONTACTABLE_EMAIL_DOMAIN}`);
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

/** Build the RFC-5322 "From" header for a given company (brand). */
export function brandSender(company: CompanyLike): string {
  const email = company.senderEmail ?? env.ADMIN_FROM_EMAIL;
  const name = company.senderName ?? company.name ?? env.ADMIN_FROM_NAME;
  return formatSender(name, email);
}

/** Build the "From" for system / admin emails. */
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
  /** Optional file attachments (e.g. an invoice PDF). */
  attachments?: Array<{ filename: string; content: Buffer }>;
  /** Extra SMTP headers, e.g. List-Unsubscribe for newsletter mail. */
  headers?: Record<string, string>;
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
  // Hard-block synthetic placeholder addresses at the source. This is the single
  // choke point every send path (transactional, dunning, review, newsletter) flows
  // through, so one guard covers them all.
  const requested = Array.isArray(opts.to) ? opts.to : [opts.to];
  const to = requested.filter((addr) => !isNonContactableEmail(addr));
  if (to.length < requested.length) {
    const blocked = requested.filter(isNonContactableEmail);
    console.info(
      `[email] (blocked — non-contactable) recipients=${blocked.join(',')} subject="${opts.email.subject}"`,
    );
  }
  if (to.length === 0) {
    return { ok: true, skipped: true };
  }

  const resend = getResend(opts.apiKey);
  if (!resend) {
    console.info(
      `[email] (skipped — no Resend API key) to=${to.join(',')} subject="${opts.email.subject}"`,
    );
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
      });
      if (!res.error) {
        return { ok: true, id: res.data?.id };
      }
      lastError = res.error.message;
      // Permanent errors (bad recipient, invalid payload) — don't retry.
      const name = res.error.name ?? '';
      const permanent = name === 'validation_error' || name === 'invalid_parameter';
      console.error(`[email] send failed (attempt ${attempt + 1}):`, res.error);
      if (permanent) return { ok: false, error: lastError };
    } catch (err) {
      lastError = err instanceof Error ? err.message : String(err);
      console.error(`[email] threw (attempt ${attempt + 1}):`, lastError);
    }
    const delay = RETRY_DELAYS_MS[attempt];
    if (delay !== undefined) await sleep(delay);
  }
  return { ok: false, error: lastError };
}

/** Convenience: a BrandInfo shape used by the templates, from a Company row. */
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
