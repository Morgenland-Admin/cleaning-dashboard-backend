import { Resend } from 'resend';
import { env } from '../config/env.js';
import type { BrandInfo, RenderedEmail } from './templates.js';

const resend = env.RESEND_API_KEY ? new Resend(env.RESEND_API_KEY) : null;

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
  // Quote the display name if it contains punctuation Resend may dislike.
  const safeName = name.replace(/[<>",;]/g, '').trim() || email;
  return `${safeName} <${email}>`;
}

export interface SendOptions {
  to: string | string[];
  from: string;
  email: RenderedEmail;
  /** Optional reply-to override (typically a brand support address). */
  replyTo?: string;
}

/**
 * Send an email via Resend. If RESEND_API_KEY isn't set, the email is logged
 * and treated as a no-op success — so newsletter / contact submissions still
 * work in local dev.
 */
export async function sendEmail(opts: SendOptions): Promise<{
  ok: boolean;
  skipped?: boolean;
  id?: string;
  error?: string;
}> {
  if (!resend) {
    console.info(
      `[email] (skipped — no RESEND_API_KEY) to=${
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
export function brandInfoFromCompany(c: CompanyLike & { primaryColor?: string | null }): BrandInfo {
  return {
    name: c.name,
    domain: c.senderEmail?.split('@')[1] ?? '',
    primaryColor: c.primaryColor ?? undefined,
  };
}
