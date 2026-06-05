import { Resend } from 'resend';
import { env } from '../config/env.js';
import type { BrandInfo, RenderedEmail } from './templates.js';

const clients = new Map<string, Resend>();

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
}

export async function sendEmail(opts: SendOptions): Promise<{
  ok: boolean;
  skipped?: boolean;
  id?: string;
  error?: string;
}> {
  const resend = getResend(opts.apiKey);
  if (!resend) {
    console.info(
      `[email] (skipped — no Resend API key) to=${
        Array.isArray(opts.to) ? opts.to.join(',') : opts.to
      } subject="${opts.email.subject}"`,
    );
    return { ok: true, skipped: true };
  }

  try {
    const res = await resend.emails.send({
      from: opts.from,
      to: opts.to,
      subject: opts.email.subject,
      html: opts.email.html,
      replyTo: opts.replyTo,
      attachments: opts.attachments,
    });
    if (res.error) {
      console.error('[email] send failed:', res.error);
      return { ok: false, error: res.error.message };
    }
    return { ok: true, id: res.data?.id };
  } catch (err) {
    const msg = err instanceof Error ? err.message : String(err);

    console.error('[email] threw:', msg);
    return { ok: false, error: msg };
  }
}

/** Convenience: a BrandInfo shape used by the templates, from a Company row. */
export function brandInfoFromCompany(
  c: CompanyLike & { primaryColor?: string | null; logoUrl?: string | null },
): BrandInfo {
  return {
    name: c.name,
    domain: c.senderEmail?.split('@')[1] ?? '',
    primaryColor: c.primaryColor ?? undefined,
    logoUrl: c.logoUrl ?? null,
  };
}
