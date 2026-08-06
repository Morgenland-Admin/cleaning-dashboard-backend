/**
 * Plain HTML email templates. Kept inline (no react-email dep) so we can ship
 * fast. Each template returns `{ subject, html }`. Brand-themed templates take
 * a `brand` parameter for naming and accent color; system templates are
 * unbranded "Reinigungs-Portal" mail.
 */
import { INVOICE_THANK_YOU } from '../lib/invoice-text.js';

export interface BrandInfo {
  /** Human-readable brand name shown in the email header + signature. */
  name: string;
  /** Public-facing domain shown in the footer. */
  domain: string;
  /** Optional accent colour for the header bar. Defaults to rust. */
  primaryColor?: string;
  /** Optional absolute logo URL shown in the header. */
  logoUrl?: string | null;
  /** Public contact email for the signature block (company.email). */
  email?: string | null;
  /** Public phone for the signature block (company.phone). */
  phone?: string | null;
  /** Public website for the signature block (company.websiteUrl). */
  websiteUrl?: string | null;
  /** Registered legal entity for the formal footer (company.legalName). */
  legalName?: string | null;
  /** Postal address lines for the formal footer (street, "PLZ Ort"). */
  addressLines?: string[];
  /** USt-IdNr. shown in the formal footer. */
  vatId?: string | null;
  /** Handelsregister / registration number shown in the formal footer. */
  registrationNumber?: string | null;
  /** Rich, per-brand email sign-off (support hours, HQ, review CTA, …). */
  signature?: EmailSignature | null;
}

/**
 * Rich per-brand email signature rendered under operator-sent / customer-facing
 * mail. Every field is optional so a brand can fill in as much as it wants; an
 * unset field is simply skipped. Stored as JSONB on the company row.
 */
export interface EmailSignature {
  /** Closing line, e.g. "Mit freundlichen Grüßen". */
  signOff?: string | null;
  /** Person signing off, e.g. "M. Amiri". Shown instead of the operator name. */
  signatory?: string | null;
  /** Heading above the opening hours, e.g. "Supportzeiten" / "Support:". */
  supportLabel?: string | null;
  /** Opening-hours lines, e.g. ["Mo. – Fr.: 09:00 – 17:00 Uhr", "Sa.: …"]. */
  supportHours?: string[];
  phone?: string | null;
  whatsapp?: string | null;
  /** Display text for the web/contact line, e.g. "www.cleanilo.de". */
  web?: string | null;
  /** Optional href for `web` (else auto-linked if it looks like a URL). */
  webUrl?: string | null;
  /** Head-office line, e.g. "Zentrale: Brook 9, 20457 Hamburg-Speicherstadt". */
  hq?: string | null;
  /** Warm tagline, e.g. "Frische Teppiche, frisches Zuhause!". */
  tagline?: string | null;
  /** Brand slogan in caps, e.g. "CLEANILO – EINFACH. SCHNELL. ZUVERLÄSSIG". */
  slogan?: string | null;
  /** Secondary drop-off point ("Weitere Annahmestelle"). */
  secondaryLocation?: { name?: string | null; lines?: string[]; phone?: string | null } | null;
  /** Review call-to-action link. */
  reviewUrl?: string | null;
  reviewLabel?: string | null;
}

/** Seller bank details rendered as the "Bankverbindung" block on payment mail. */
export interface BankInfo {
  accountHolder?: string | null;
  iban?: string | null;
  bic?: string | null;
  bankName?: string | null;
  bankAddress?: string | null;
}

/** Email clients (Gmail, Outlook) don't render SVG — only allow raster logos. */
function emailSafeLogo(url?: string | null): string | null {
  if (!url) return null;
  return /^https?:\/\/.+\.(png|jpe?g|gif|webp)(\?.*)?$/i.test(url) ? url : null;
}

const ADMIN_BRAND: BrandInfo = {
  name: 'Reinigungs-Portal',
  domain: 'reinigungs-portal.com',
  primaryColor: '#bd5b3e',
};

function escapeHtml(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

function nl2br(s: string): string {
  return escapeHtml(s).replace(/\n/g, '<br />');
}

function layout(opts: {
  brand: BrandInfo;
  preheader: string;
  contentHtml: string;
  footerNote?: string;
}): string {
  const accent = opts.brand.primaryColor ?? '#bd5b3e';
  const logo = emailSafeLogo(opts.brand.logoUrl);
  const header = logo
    ? `<img src="${escapeHtml(logo)}" alt="${escapeHtml(opts.brand.name)}" height="36" style="display:block;height:36px;max-height:36px;width:auto;border:0;outline:none;text-decoration:none;" />`
    : `<div style="font-size:11px;letter-spacing:2px;text-transform:uppercase;color:${accent};font-weight:700;">
                  ${escapeHtml(opts.brand.name)}
                </div>`;
  return `<!DOCTYPE html>
<html lang="de">
  <head>
    <meta charset="UTF-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1.0" />
    <title>${escapeHtml(opts.brand.name)}</title>
  </head>
  <body style="margin:0;padding:0;background:#f4ebdc;font-family:-apple-system,BlinkMacSystemFont,'Segoe UI',Roboto,Helvetica,Arial,sans-serif;color:#2d2419;line-height:1.55;">
    <span style="display:none!important;visibility:hidden;opacity:0;color:transparent;height:0;width:0;font-size:1px;mso-hide:all;">${escapeHtml(opts.preheader)}</span>
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="background:#f4ebdc;padding:32px 16px;">
      <tr>
        <td align="center">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;width:100%;background:#fefaf0;border-radius:16px;overflow:hidden;border:1px solid #e2d3b6;">
            <tr>
              <td style="padding:24px 32px 20px;border-bottom:1px solid #e2d3b6;">
                ${header}
              </td>
            </tr>
            <tr>
              <td style="padding:24px 32px 32px;font-size:15px;color:#2d2419;">
                ${opts.contentHtml}
              </td>
            </tr>
          </table>
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="560" style="max-width:560px;width:100%;margin-top:16px;">
            <tr>
              <td style="padding:0 32px;font-size:11px;color:#6b5b48;text-align:center;line-height:1.6;">
                ${opts.footerNote ? '<div style="margin-bottom:10px;">' + escapeHtml(opts.footerNote) + '</div>' : ''}
                ${legalFooter(opts.brand, accent)}
              </td>
            </tr>
          </table>
        </td>
      </tr>
    </table>
  </body>
</html>`;
}

function button(href: string, label: string, accent = '#bd5b3e'): string {
  return `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:24px 0;">
    <tr>
      <td style="background:${accent};border-radius:10px;">
        <a href="${escapeHtml(href)}" style="display:inline-block;padding:12px 24px;color:#fefaf0;text-decoration:none;font-weight:600;font-size:14px;">
          ${escapeHtml(label)}
        </a>
      </td>
    </tr>
  </table>`;
}

/** Strip scheme + trailing slash for a clean, clickable website label. */
function displayHost(url: string): string {
  return url.replace(/^https?:\/\//i, '').replace(/\/+$/, '');
}

/** Group an IBAN into readable blocks of four ("DE91 2022 0800 0043 …"). */
function formatIban(iban: string): string {
  return iban
    .replace(/\s+/g, '')
    .toUpperCase()
    .replace(/(.{4})/g, '$1 ')
    .trim();
}

/**
 * Formal company footer shown on every branded email. Renders the registered
 * legal entity, postal address, VAT / registration number and public contact —
 * the identity a business email is expected to carry. Falls back gracefully to
 * just "Name · domain" when the extended fields aren't set (e.g. system mail or
 * a brand an admin hasn't fully filled in yet).
 */
function legalFooter(brand: BrandInfo, accent: string): string {
  const identity = brand.legalName && brand.legalName !== brand.name ? brand.legalName : brand.name;
  const addr = (brand.addressLines ?? []).filter(Boolean).join(' · ');
  const line1 = [escapeHtml(identity), addr ? escapeHtml(addr) : ''].filter(Boolean).join(' · ');

  const idBits: string[] = [];
  if (brand.vatId) idBits.push(`USt-IdNr. ${escapeHtml(brand.vatId)}`);
  if (brand.registrationNumber) idBits.push(`Reg-Nr. ${escapeHtml(brand.registrationNumber)}`);
  if (brand.phone) idBits.push(`Tel. ${escapeHtml(brand.phone)}`);
  if (brand.email) {
    idBits.push(
      `<a href="mailto:${escapeHtml(brand.email)}" style="color:#6b5b48;text-decoration:none;">${escapeHtml(brand.email)}</a>`,
    );
  }

  const site = brand.websiteUrl || (brand.domain ? `https://${brand.domain}` : null);
  const brandLine = site
    ? `<a href="${escapeHtml(site)}" style="color:${accent};text-decoration:none;font-weight:600;">${escapeHtml(displayHost(site))}</a>`
    : `<span style="font-weight:600;">${escapeHtml(brand.domain || brand.name)}</span>`;

  return `
    ${line1 ? `<div style="color:#5b4b38;">${line1}</div>` : ''}
    ${idBits.length ? `<div style="margin-top:2px;">${idBits.join(' · ')}</div>` : ''}
    <div style="margin-top:8px;">${brandLine}</div>`;
}

/**
 * "Bankverbindung" payment card for invoice + dunning mail — the seller's bank
 * account with a monospace IBAN, plus the invoice number as Verwendungszweck so
 * the customer can pay by transfer without hunting for the details. Renders
 * nothing when no account is configured.
 */
function bankTransferBlock(opts: {
  accent: string;
  bank: BankInfo;
  reference?: string | null;
  amount?: string | null;
}): string {
  // No IBAN → nothing to pay into; skip the block entirely.
  if (!opts.bank.iban) return '';
  const accent = opts.accent;
  const MONO = "font-family:'SFMono-Regular',Consolas,'Liberation Mono',Menlo,monospace;";
  const LABEL =
    'padding:7px 18px 7px 0;font-size:10px;font-weight:600;letter-spacing:0.8px;text-transform:uppercase;color:#93826a;white-space:nowrap;vertical-align:middle;';
  const VAL = 'padding:7px 0;font-size:14px;color:#2d2419;line-height:1.4;vertical-align:middle;';

  const line = (label: string, value: string, valStyle = ''): string =>
    `<tr><td style="${LABEL}">${label}</td><td style="${VAL}${valStyle}">${value}</td></tr>`;

  const account: string[] = [];
  if (opts.bank.accountHolder)
    account.push(
      line(
        'Kontoinhaber',
        `<span style="font-weight:600;">${escapeHtml(opts.bank.accountHolder)}</span>`,
      ),
    );
  account.push(
    line(
      'IBAN',
      escapeHtml(formatIban(opts.bank.iban)),
      `${MONO}font-size:15px;letter-spacing:0.6px;font-weight:600;`,
    ),
  );
  if (opts.bank.bic) account.push(line('BIC', escapeHtml(opts.bank.bic), MONO));
  if (opts.bank.bankName) account.push(line('Bank', escapeHtml(opts.bank.bankName)));

  const payment: string[] = [];
  if (opts.reference)
    payment.push(line('Verwendungszweck', escapeHtml(opts.reference), `${MONO}font-weight:600;`));
  if (opts.amount)
    payment.push(
      line('Betrag', escapeHtml(opts.amount), `font-size:17px;font-weight:700;color:${accent};`),
    );

  const divider = payment.length
    ? `<tr><td colspan="2" style="padding:8px 0 2px;"><div style="height:1px;background:#e6d6b8;line-height:1px;font-size:0;">&nbsp;</div></td></tr>`
    : '';

  return `
    <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:22px 0 0;background:#faf3e3;border:1px solid #e6d6b8;border-radius:12px;">
      <tr>
        <td style="padding:15px 20px 3px;border-bottom:1px solid #efe4cc;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            <tr>
              <td style="font-size:11px;font-weight:700;letter-spacing:1.2px;text-transform:uppercase;color:${accent};padding-bottom:12px;">Bankverbindung</td>
              <td align="right" style="font-size:11px;color:#93826a;padding-bottom:12px;">Zahlung per Überweisung</td>
            </tr>
          </table>
        </td>
      </tr>
      <tr>
        <td style="padding:8px 20px 16px;">
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%">
            ${account.join('')}
            ${divider}
            ${payment.join('')}
          </table>
        </td>
      </tr>
    </table>`;
}

/**
 * Sign-off for a brand that has no `email_signature` configured yet, derived
 * from its own public company fields. Exists so a newly created company still
 * signs as itself — the dashboard operator's login name must never end up in
 * customer-facing mail.
 */
function derivedSignature(brand: BrandInfo): EmailSignature {
  const site = brand.websiteUrl || (brand.domain ? `https://${brand.domain}` : null);
  const address = brand.addressLines?.length ? brand.addressLines.join(', ') : null;
  return {
    signOff: 'Mit freundlichen Grüßen',
    signatory: `Ihr Team von ${brand.name}`,
    phone: brand.phone ?? null,
    web: site ? displayHost(site) : (brand.email ?? null),
    webUrl: site,
    hq: address ? `Zentrale: ${address}` : null,
  };
}

/**
 * Shared branded sign-off for operator-sent / conversational mail (contact
 * reply, quote, order message). Renders the brand's configured `signature`
 * (closing, signatory, support hours, contacts, HQ, tagline, secondary
 * drop-off, review CTA); a brand without one gets the same block derived from
 * its company fields. The operator who hit send is never named — the mail
 * speaks for the brand, signed by its configured signatory (e.g. "M. Amiri").
 */
function signatureBlock(brand: BrandInfo): string {
  const accent = brand.primaryColor ?? '#bd5b3e';
  const sig = brand.signature ?? derivedSignature(brand);

  const parts: string[] = [];
  parts.push(
    `<div style="font-size:14px;color:#2d2419;">${escapeHtml(sig.signOff ?? 'Mit freundlichen Grüßen')}</div>`,
  );
  parts.push(
    `<div style="margin-top:2px;font-size:15px;font-weight:700;color:#2d2419;">${escapeHtml(
      sig.signatory ?? brand.name,
    )}</div>`,
  );

  // Support hours + contact channels + HQ, one muted block.
  const contact: string[] = [];
  if (sig.supportLabel)
    contact.push(
      `<div style="font-weight:600;color:#2d2419;">${escapeHtml(sig.supportLabel)}</div>`,
    );
  for (const h of sig.supportHours ?? []) contact.push(`<div>${escapeHtml(h)}</div>`);
  const chan: string[] = [];
  if (sig.phone) chan.push(`Tel.: ${escapeHtml(sig.phone)}`);
  if (sig.whatsapp) chan.push(`WhatsApp: ${escapeHtml(sig.whatsapp)}`);
  if (sig.web) {
    const href = sig.webUrl
      ? sig.webUrl
      : /@/.test(sig.web)
        ? `mailto:${sig.web}`
        : `https://${sig.web.replace(/^https?:\/\//i, '')}`;
    chan.push(
      `Web: <a href="${escapeHtml(href)}" style="color:${accent};text-decoration:none;">${escapeHtml(sig.web)}</a>`,
    );
  }
  for (const c of chan) contact.push(`<div>${c}</div>`);
  if (sig.hq) contact.push(`<div style="margin-top:8px;">${escapeHtml(sig.hq)}</div>`);
  if (contact.length)
    parts.push(
      `<div style="margin-top:14px;font-size:12.5px;color:#6b5b48;line-height:1.7;">${contact.join('')}</div>`,
    );

  if (sig.tagline)
    parts.push(
      `<div style="margin-top:14px;font-size:13px;font-style:italic;color:${accent};">${escapeHtml(sig.tagline)}</div>`,
    );
  if (sig.slogan)
    parts.push(
      `<div style="margin-top:6px;font-size:11px;font-weight:700;letter-spacing:1px;text-transform:uppercase;color:#93826a;">${escapeHtml(sig.slogan)}</div>`,
    );

  const loc = sig.secondaryLocation;
  if (loc && (loc.name || loc.lines?.length)) {
    const locLines: string[] = [
      `<div style="font-weight:600;color:#2d2419;">Weitere Annahmestelle</div>`,
    ];
    if (loc.name) locLines.push(`<div>${escapeHtml(loc.name)}</div>`);
    for (const l of loc.lines ?? []) locLines.push(`<div>${escapeHtml(l)}</div>`);
    if (loc.phone) locLines.push(`<div>Tel.: ${escapeHtml(loc.phone)}</div>`);
    parts.push(
      `<div style="margin-top:14px;font-size:12.5px;color:#6b5b48;line-height:1.6;">${locLines.join('')}</div>`,
    );
  }

  if (sig.reviewUrl)
    parts.push(
      `<div style="margin-top:16px;"><a href="${escapeHtml(sig.reviewUrl)}" style="display:inline-block;font-size:13px;font-weight:600;color:${accent};text-decoration:none;">👉 ${escapeHtml(
        sig.reviewLabel ?? 'Jetzt Bewertung abgeben',
      )}</a></div>`,
    );

  return `<div style="margin:24px 0 0;padding-top:16px;border-top:1px solid #e2d3b6;">${parts.join('')}</div>`;
}

export interface RenderedEmail {
  subject: string;
  html: string;
}

export function resetPasswordEmail(opts: {
  name?: string | null;
  resetUrl: string;
}): RenderedEmail {
  const greeting = opts.name ? `Hallo ${escapeHtml(opts.name)},` : 'Hallo,';
  return {
    subject: 'Passwort zurücksetzen · Reinigungs-Portal',
    html: layout({
      brand: ADMIN_BRAND,
      preheader: 'Setze dein Passwort über den Link in dieser E-Mail neu.',
      contentHtml: `
        <p style="margin:0 0 16px;">${greeting}</p>
        <p style="margin:0 0 8px;">
          du hast eine Passwort-Zurücksetzung für das Reinigungs-Portal angefordert.
        </p>
        <p style="margin:0 0 8px;">
          Klicke auf den Button, um ein neues Passwort zu setzen. Der Link ist
          aus Sicherheitsgründen 1&nbsp;Stunde gültig.
        </p>
        ${button(opts.resetUrl, 'Passwort zurücksetzen')}
        <p style="margin:0 0 6px;font-size:12px;color:#6b5b48;">
          Funktioniert der Button nicht? Kopiere diesen Link in deinen Browser:
        </p>
        <p style="margin:0 0 16px;font-size:12px;color:#6b5b48;word-break:break-all;">
          <a href="${escapeHtml(opts.resetUrl)}" style="color:#6b5b48;">${escapeHtml(opts.resetUrl)}</a>
        </p>
        <p style="margin:24px 0 0;font-size:12px;color:#6b5b48;">
          Hast du diese E-Mail nicht angefordert, kannst du sie ignorieren — dein Passwort bleibt unverändert.
        </p>
      `,
      footerNote: 'Diese E-Mail wurde automatisch versendet.',
    }),
  };
}

export function passwordChangedEmail(opts: { name?: string | null }): RenderedEmail {
  const greeting = opts.name ? `Hallo ${escapeHtml(opts.name)},` : 'Hallo,';
  return {
    subject: 'Passwort geändert · Reinigungs-Portal',
    html: layout({
      brand: ADMIN_BRAND,
      preheader: 'Dein Reinigungs-Portal-Passwort wurde soeben geändert.',
      contentHtml: `
        <p style="margin:0 0 16px;">${greeting}</p>
        <p style="margin:0 0 8px;">
          dein Passwort für das Reinigungs-Portal wurde soeben geändert.
        </p>
        <p style="margin:0 0 8px;">
          Falls du das warst, ist alles in Ordnung — du musst nichts weiter tun.
        </p>
        <p style="margin:16px 0 0;font-size:13px;color:#2d2419;">
          Warst du das <strong>nicht</strong>, melde dich umgehend bei einem
          Workspace-Admin — der Zugang sollte sofort gesperrt werden.
        </p>
      `,
      footerNote: 'Diese Bestätigung wurde automatisch versendet.',
    }),
  };
}

export function inviteEmail(opts: {
  inviterName: string;
  inviteUrl: string;
  brandName?: string | null;
}): RenderedEmail {
  const brandPhrase = opts.brandName ? ` für <strong>${escapeHtml(opts.brandName)}</strong>` : '';
  return {
    subject: 'Einladung in das Reinigungs-Portal',
    html: layout({
      brand: ADMIN_BRAND,
      preheader: `${escapeHtml(opts.inviterName)} lädt dich in die Admin-Konsole ein.`,
      contentHtml: `
        <p style="margin:0 0 16px;">Hallo,</p>
        <p style="margin:0 0 8px;">
          <strong>${escapeHtml(opts.inviterName)}</strong> hat dich in das Reinigungs-Portal${brandPhrase} eingeladen.
        </p>
        <p style="margin:0 0 8px;">
          Klicke auf den Button, um dein Konto einzurichten. Die Einladung ist 7&nbsp;Tage gültig.
        </p>
        ${button(opts.inviteUrl, 'Einladung annehmen')}
        <p style="margin:0 0 6px;font-size:12px;color:#6b5b48;">
          Funktioniert der Button nicht? Kopiere diesen Link in deinen Browser:
        </p>
        <p style="margin:0;font-size:12px;color:#6b5b48;word-break:break-all;">
          <a href="${escapeHtml(opts.inviteUrl)}" style="color:#6b5b48;">${escapeHtml(opts.inviteUrl)}</a>
        </p>
      `,
    }),
  };
}

/**
 * Double-opt-in confirmation request. Sent immediately after the user submits
 * the signup form. Until they click "Bestätigen", the row stays in confirmed:false
 * state and we never send them marketing. Required under §7 UWG for DE.
 */
export function newsletterConfirmEmail(opts: {
  firstName?: string | null;
  brand: BrandInfo;
  confirmUrl: string;
  unsubscribeUrl: string;
}): RenderedEmail {
  const greeting = opts.firstName ? `Hallo ${escapeHtml(opts.firstName)},` : 'Hallo,';
  const accent = opts.brand.primaryColor ?? '#bd5b3e';
  return {
    subject: `Bitte bestätigen Sie Ihre Newsletter-Anmeldung · ${opts.brand.name}`,
    html: layout({
      brand: opts.brand,
      preheader: `Bitte bestätigen Sie Ihre Anmeldung beim Newsletter von ${opts.brand.name}.`,
      contentHtml: `
        <p style="margin:0 0 16px;">${greeting}</p>
        <p style="margin:0 0 8px;">
          danke für Ihr Interesse am Newsletter von <strong>${escapeHtml(opts.brand.name)}</strong>.
          Bitte bestätigen Sie kurz, dass Sie wirklich Nachrichten von uns erhalten möchten.
        </p>
        ${button(opts.confirmUrl, 'Anmeldung bestätigen', accent)}
        <p style="margin:0 0 6px;font-size:12px;color:#6b5b48;">
          Funktioniert der Button nicht? Kopieren Sie diesen Link in Ihren Browser:
        </p>
        <p style="margin:0 0 16px;font-size:12px;color:#6b5b48;word-break:break-all;">
          <a href="${escapeHtml(opts.confirmUrl)}" style="color:#6b5b48;">${escapeHtml(opts.confirmUrl)}</a>
        </p>
        <p style="margin:24px 0 0;font-size:12px;color:#6b5b48;">
          Haben Sie diese Anmeldung nicht angefordert, können Sie diese E-Mail einfach ignorieren —
          oder sich direkt
          <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#6b5b48;text-decoration:underline;">austragen</a>.
        </p>
      `,
      footerNote: `Anmeldung über ${opts.brand.domain}. · <a href="${escapeHtml(opts.unsubscribeUrl)}" style="color:#6b5b48;">Abmelden</a>`,
    }),
  };
}

/** Internal admin notification when a new contact / inquiry comes in. */
export function adminInboxNotificationEmail(opts: {
  brand: BrandInfo;
  kind: 'contact' | 'inquiry';
  /** Submitter name/email so the admin can react without opening the dashboard. */
  fromName: string;
  fromEmail: string;
  subject?: string | null;
  message: string;
  /** Deep-link into the admin dashboard for the new row. */
  adminUrl: string;
  /** Optional extras shown as a key/value list (used for inquiry-specific fields). */
  details?: Array<{ label: string; value: string }>;
}): RenderedEmail {
  const kindLabel = opts.kind === 'contact' ? 'Kontaktanfrage' : 'Service-Anfrage';
  const accent = opts.brand.primaryColor ?? '#bd5b3e';
  const detailsHtml = opts.details?.length
    ? `<table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin:12px 0 0;font-size:13px;">
        ${opts.details
          .map(
            (d) => `
          <tr>
            <td style="padding:2px 12px 2px 0;color:#6b5b48;">${escapeHtml(d.label)}</td>
            <td style="padding:2px 0;color:#2d2419;">${escapeHtml(d.value)}</td>
          </tr>`,
          )
          .join('')}
      </table>`
    : '';
  return {
    subject: `Neue ${kindLabel} · ${opts.brand.name}`,
    html: layout({
      brand: opts.brand,
      preheader: `Neue ${kindLabel} von ${opts.fromName}.`,
      contentHtml: `
        <p style="margin:0 0 12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:${accent};font-weight:700;">
          Neue ${kindLabel}
        </p>
        <p style="margin:0 0 8px;"><strong>${escapeHtml(opts.fromName)}</strong> &lt;${escapeHtml(opts.fromEmail)}&gt;</p>
        ${
          opts.subject
            ? `<p style="margin:8px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;">Betreff</p>
        <p style="margin:0 0 8px;font-weight:600;">${escapeHtml(opts.subject)}</p>`
            : ''
        }
        ${detailsHtml}
        <p style="margin:16px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;">Nachricht</p>
        <div style="margin:0;padding:12px 16px;background:#f4ebdc;border:1px solid #e2d3b6;border-radius:8px;font-size:14px;color:#2d2419;white-space:pre-wrap;">${nl2br(opts.message)}</div>
        ${button(opts.adminUrl, 'Im Dashboard öffnen', accent)}
      `,
      footerNote: `Interne Benachrichtigung — gesendet an die hinterlegte Brand-Adresse von ${opts.brand.name}.`,
    }),
  };
}

/** Sent when the admin marks an inquiry "quoted" and chooses to email the quote. */
export function inquiryQuoteEmail(opts: {
  recipientName: string;
  brand: BrandInfo;
  /** Free-text quote body the admin typed. */
  quoteBody: string;
  /** Amount as already-formatted EUR string ("980,00 €"). */
  quotedAmount?: string | null;
}): RenderedEmail {
  const accent = opts.brand.primaryColor ?? '#bd5b3e';
  const amountLine = opts.quotedAmount
    ? `<p style="margin:8px 0 0;font-size:18px;font-weight:700;color:${accent};">${escapeHtml(opts.quotedAmount)}</p>`
    : '';
  const signature = signatureBlock(opts.brand);
  return {
    subject: `Ihr Angebot von ${opts.brand.name}`,
    html: layout({
      brand: opts.brand,
      preheader: `Ihr Angebot von ${opts.brand.name}.`,
      contentHtml: `
        <p style="margin:0 0 12px;">Hallo ${escapeHtml(opts.recipientName)},</p>
        <p style="margin:0 0 8px;">danke für Ihre Anfrage. Hier ist unser Angebot:</p>
        <div style="font-size:14px;line-height:1.6;color:#2d2419;white-space:pre-wrap;">${nl2br(opts.quoteBody)}</div>
        ${amountLine}
        ${signature}
      `,
      footerNote: `Sie können direkt auf diese Mail antworten, falls Sie Fragen haben.`,
    }),
  };
}

export function contactReplyEmail(opts: {
  recipientName: string;
  /** Body the admin typed — plain text; newlines are preserved as <br>. */
  replyBody: string;
  /** Optional reference to the original message to quote at the bottom. */
  originalMessage?: string | null;
  originalSubject?: string | null;
  brand: BrandInfo;
}): RenderedEmail {
  const subjectLine = opts.originalSubject
    ? `Re: ${opts.originalSubject}`
    : `Antwort von ${opts.brand.name}`;
  const signature = signatureBlock(opts.brand);

  const quoted = opts.originalMessage
    ? `<div style="margin-top:28px;padding-top:16px;border-top:1px solid #e2d3b6;">
        <div style="font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;margin-bottom:6px;">
          Ihre ursprüngliche Nachricht
        </div>
        <div style="margin:0;padding:12px 14px;background:#f4ebdc;border:1px solid #e2d3b6;border-radius:8px;font-size:13px;color:#5b4b38;white-space:pre-wrap;">
          ${nl2br(opts.originalMessage)}
        </div>
      </div>`
    : '';

  return {
    subject: subjectLine,
    html: layout({
      brand: opts.brand,
      preheader: `Antwort auf Ihre Nachricht an ${opts.brand.name}.`,
      contentHtml: `
        <p style="margin:0 0 12px;">Hallo ${escapeHtml(opts.recipientName)},</p>
        <div style="font-size:14px;line-height:1.6;color:#2d2419;white-space:pre-wrap;">${nl2br(opts.replyBody)}</div>
        ${signature}
        ${quoted}
      `,
      footerNote: `Sie können direkt auf diese Mail antworten — wir lesen mit.`,
    }),
  };
}

/**
 * Customer-facing order confirmation email. Triggered by the Stripe webhook
 * after payment_intent.succeeded — at that point the order is paid and the
 * customer expects a receipt + status link.
 */
export function orderConfirmationEmail(opts: {
  brand: BrandInfo;
  customerName: string;
  orderNumber: string;
  trackerUrl: string;
  totalFormatted: string;
  lines: Array<{ label: string; quantityLabel: string; subtotalFormatted: string }>;
  pickupLabel?: string | null;
  pickupFeeFormatted?: string | null;
  /** "Wir holen Ihren Teppich ab" vs "Selbst-Abgabe in der Werkstatt". */
  fulfillmentNote: string;
}): RenderedEmail {
  const itemRowsHtml = opts.lines
    .map(
      (l) => `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e2d3b6;font-size:14px;">${escapeHtml(l.label)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2d3b6;font-size:13px;color:#6b5b48;white-space:nowrap;">${escapeHtml(l.quantityLabel)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2d3b6;font-size:14px;text-align:right;white-space:nowrap;">${escapeHtml(l.subtotalFormatted)}</td>
      </tr>`,
    )
    .join('');

  const pickupRow =
    opts.pickupLabel && opts.pickupFeeFormatted
      ? `<tr>
          <td colspan="2" style="padding:8px 12px;border-bottom:1px solid #e2d3b6;font-size:14px;">${escapeHtml(opts.pickupLabel)}</td>
          <td style="padding:8px 12px;border-bottom:1px solid #e2d3b6;font-size:14px;text-align:right;white-space:nowrap;">${escapeHtml(opts.pickupFeeFormatted)}</td>
        </tr>`
      : '';

  return {
    subject: `Auftragsbestätigung ${opts.orderNumber} · ${opts.brand.name}`,
    html: layout({
      brand: opts.brand,
      preheader: `Vielen Dank für Ihren Auftrag bei ${opts.brand.name}.`,
      contentHtml: `
        <p style="margin:0 0 16px;">Hallo ${escapeHtml(opts.customerName)},</p>
        <p style="margin:0 0 8px;">
          vielen Dank für Ihren Auftrag bei <strong>${escapeHtml(opts.brand.name)}</strong>.
          Wir haben Ihre Zahlung erhalten und kümmern uns ab sofort um die Bearbeitung.
        </p>
        <p style="margin:16px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;">Auftragsnummer</p>
        <p style="margin:0 0 16px;font-weight:600;font-family:monospace;">${escapeHtml(opts.orderNumber)}</p>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0;border:1px solid #e2d3b6;border-radius:8px;overflow:hidden;">
          <thead>
            <tr style="background:#f4ebdc;">
              <th align="left" style="padding:10px 12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b5b48;border-bottom:1px solid #e2d3b6;">Position</th>
              <th align="left" style="padding:10px 12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b5b48;border-bottom:1px solid #e2d3b6;">Menge</th>
              <th align="right" style="padding:10px 12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b5b48;border-bottom:1px solid #e2d3b6;">Preis</th>
            </tr>
          </thead>
          <tbody>
            ${itemRowsHtml}
            ${pickupRow}
            <tr>
              <td colspan="2" style="padding:12px;font-size:14px;font-weight:700;">Gesamt (inkl. 19 % MwSt.)</td>
              <td style="padding:12px;font-size:16px;font-weight:700;text-align:right;white-space:nowrap;">${escapeHtml(opts.totalFormatted)}</td>
            </tr>
          </tbody>
        </table>

        <p style="margin:16px 0 8px;font-size:14px;">${escapeHtml(opts.fulfillmentNote)}</p>

        ${button(opts.trackerUrl, 'Auftrag verfolgen', opts.brand.primaryColor)}

        <p style="margin:24px 0 0;font-size:12px;color:#6b5b48;">
          Bitte heben Sie diese Bestätigung als Beleg auf. Bei Fragen antworten Sie einfach auf diese E-Mail.
        </p>
      `,
      footerNote: `Auftrag bei ${opts.brand.domain} · ${opts.brand.name}.`,
    }),
  };
}

export function invoiceEmail(opts: {
  brand: BrandInfo;
  recipientName: string;
  invoiceNumber: string;
  invoiceDateFormatted: string;
  dueDateFormatted: string | null;
  paymentTermsDays: number;
  /** Betreff line, mirrors the PDF headline subject. */
  subject?: string | null;
  lineItems: Array<{
    label: string;
    /** Second line under the label, mirrors the PDF. */
    note?: string | null;
    quantityLabel: string;
    unitPriceFormatted: string;
    lineTotalFormatted: string;
  }>;
  subtotalFormatted: string;
  taxFormatted: string | null;
  taxRateLabel: string | null;
  totalFormatted: string;
  /** §35a EStG block — mirrors the PDF, printed above the closing line. */
  craftsmanNote?: string | null;
  notes?: string | null;
  seller: {
    name: string;
    addressLines: string[];
    vatId?: string | null;
    registrationNumber?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  /** Seller bank details for the Bankverbindung / payment-by-transfer block. */
  bank?: BankInfo;
  /** 'transfer' (default) shows bank + due date; 'card'/'cash' show "paid". */
  paymentMethod?: string | null;
}): RenderedEmail {
  const accent = opts.brand.primaryColor ?? '#bd5b3e';
  const paid = opts.paymentMethod === 'card' || opts.paymentMethod === 'cash';
  const itemRowsHtml = opts.lineItems
    .map(
      (l) => `<tr>
        <td style="padding:8px 12px;border-bottom:1px solid #e2d3b6;font-size:14px;">${escapeHtml(l.label)}${
          l.note
            ? `<br /><span style="font-size:12px;color:#6b5b48;">${escapeHtml(l.note)}</span>`
            : ''
        }</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2d3b6;font-size:13px;color:#6b5b48;text-align:center;white-space:nowrap;">${escapeHtml(l.quantityLabel)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2d3b6;font-size:13px;color:#6b5b48;text-align:right;white-space:nowrap;">${escapeHtml(l.unitPriceFormatted)}</td>
        <td style="padding:8px 12px;border-bottom:1px solid #e2d3b6;font-size:14px;text-align:right;white-space:nowrap;">${escapeHtml(l.lineTotalFormatted)}</td>
      </tr>`,
    )
    .join('');

  const totalsHtml =
    opts.taxFormatted && opts.taxRateLabel
      ? `<tr>
            <td colspan="3" style="padding:8px 12px;font-size:13px;color:#6b5b48;text-align:right;">Zwischensumme (netto)</td>
            <td style="padding:8px 12px;font-size:13px;text-align:right;white-space:nowrap;">${escapeHtml(opts.subtotalFormatted)}</td>
          </tr>
          <tr>
            <td colspan="3" style="padding:8px 12px;font-size:13px;color:#6b5b48;text-align:right;">zzgl. USt. (${escapeHtml(opts.taxRateLabel)})</td>
            <td style="padding:8px 12px;font-size:13px;text-align:right;white-space:nowrap;">${escapeHtml(opts.taxFormatted)}</td>
          </tr>
          <tr>
            <td colspan="3" style="padding:12px;font-size:14px;font-weight:700;text-align:right;border-top:2px solid #e2d3b6;">Gesamtbetrag</td>
            <td style="padding:12px;font-size:16px;font-weight:700;text-align:right;white-space:nowrap;border-top:2px solid #e2d3b6;">${escapeHtml(opts.totalFormatted)}</td>
          </tr>`
      : `<tr>
            <td colspan="3" style="padding:12px;font-size:14px;font-weight:700;text-align:right;border-top:2px solid #e2d3b6;">Gesamtbetrag</td>
            <td style="padding:12px;font-size:16px;font-weight:700;text-align:right;white-space:nowrap;border-top:2px solid #e2d3b6;">${escapeHtml(opts.totalFormatted)}</td>
          </tr>`;

  // Paid by card/cash → no bank block, a "paid" acknowledgement instead.
  const bankHtml =
    !paid && opts.bank
      ? bankTransferBlock({
          accent,
          bank: opts.bank,
          reference: opts.invoiceNumber,
          amount: opts.totalFormatted,
        })
      : '';
  const toAccount = bankHtml ? ' auf das unten genannte Konto' : '';
  const paymentLine = paid
    ? opts.paymentMethod === 'card'
      ? `Der Rechnungsbetrag wurde bereits per Kartenzahlung beglichen. Vielen Dank!`
      : `Der Rechnungsbetrag wurde bereits in bar beglichen. Vielen Dank!`
    : opts.dueDateFormatted
      ? `Bitte überweisen Sie den Gesamtbetrag bis zum <strong>${escapeHtml(opts.dueDateFormatted)}</strong> (Zahlungsziel ${opts.paymentTermsDays} Tage)${toAccount}.`
      : `Bitte überweisen Sie den Gesamtbetrag innerhalb von <strong>${opts.paymentTermsDays} Tagen</strong>${toAccount}.`;

  // §35a EStG: same wording as the attached PDF (frozen on the invoice row).
  const craftsmanHtml = opts.craftsmanNote
    ? `<p style="margin:16px 0 0;font-size:14px;">${escapeHtml(opts.craftsmanNote)}</p>`
    : '';

  const notesHtml = opts.notes
    ? `<p style="margin:16px 0 0;font-size:13px;color:#6b5b48;">${nl2br(opts.notes)}</p>`
    : '';

  const sellerLines = [
    `<strong>${escapeHtml(opts.seller.name)}</strong>`,
    ...opts.seller.addressLines.map(escapeHtml),
    opts.seller.vatId ? `USt-IdNr.: ${escapeHtml(opts.seller.vatId)}` : '',
    opts.seller.registrationNumber ? `Reg-Nr.: ${escapeHtml(opts.seller.registrationNumber)}` : '',
    opts.seller.email ? `E-Mail: ${escapeHtml(opts.seller.email)}` : '',
    opts.seller.phone ? `Tel.: ${escapeHtml(opts.seller.phone)}` : '',
  ]
    .filter(Boolean)
    .join('<br />');

  return {
    subject: `Rechnung ${opts.invoiceNumber} · ${opts.brand.name}`,
    html: layout({
      brand: opts.brand,
      preheader: `Ihre Rechnung ${opts.invoiceNumber} von ${opts.brand.name}.`,
      contentHtml: `
        <p style="margin:0 0 16px;">Hallo ${escapeHtml(opts.recipientName)},</p>
        <p style="margin:0 0 16px;">
          anbei erhalten Sie Ihre Rechnung von <strong>${escapeHtml(opts.brand.name)}</strong>.
        </p>
        ${
          opts.subject
            ? `<p style="margin:0 0 16px;font-size:14px;"><strong>Betreff:</strong> ${escapeHtml(opts.subject)}</p>`
            : ''
        }

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;">
          <tr>
            <td style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;padding:2px 0;">Rechnungsnummer</td>
            <td style="font-size:13px;font-family:monospace;text-align:right;padding:2px 0;">${escapeHtml(opts.invoiceNumber)}</td>
          </tr>
          <tr>
            <td style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;padding:2px 0;">Rechnungsdatum</td>
            <td style="font-size:13px;text-align:right;padding:2px 0;">${escapeHtml(opts.invoiceDateFormatted)}</td>
          </tr>
          ${
            opts.dueDateFormatted
              ? `<tr>
            <td style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;padding:2px 0;">Fällig bis</td>
            <td style="font-size:13px;text-align:right;padding:2px 0;">${escapeHtml(opts.dueDateFormatted)}</td>
          </tr>`
              : ''
          }
        </table>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0;border:1px solid #e2d3b6;border-radius:8px;overflow:hidden;">
          <thead>
            <tr style="background:#f4ebdc;">
              <th align="left" style="padding:10px 12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b5b48;border-bottom:1px solid #e2d3b6;">Bezeichnung</th>
              <th align="center" style="padding:10px 12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b5b48;border-bottom:1px solid #e2d3b6;">Menge</th>
              <th align="right" style="padding:10px 12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b5b48;border-bottom:1px solid #e2d3b6;">Einzelpreis</th>
              <th align="right" style="padding:10px 12px;font-size:11px;letter-spacing:1px;text-transform:uppercase;color:#6b5b48;border-bottom:1px solid #e2d3b6;">Betrag</th>
            </tr>
          </thead>
          <tbody>
            ${itemRowsHtml}
            ${totalsHtml}
          </tbody>
        </table>

        <p style="margin:16px 0 0;font-size:14px;">${paymentLine}</p>
        ${bankHtml}
        ${craftsmanHtml}
        ${notesHtml}
        <p style="margin:16px 0 0;font-size:14px;">${escapeHtml(INVOICE_THANK_YOU)}</p>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0 0;border-top:1px solid #e2d3b6;">
          <tr>
            <td style="padding:16px 0 0;font-size:12px;color:#6b5b48;line-height:1.6;">
              <span style="text-transform:uppercase;letter-spacing:1px;font-size:11px;">Rechnungssteller</span><br />
              ${sellerLines}
            </td>
          </tr>
        </table>

        <p style="margin:20px 0 0;font-size:12px;color:#6b5b48;">
          Bei Fragen zu dieser Rechnung antworten Sie einfach auf diese E-Mail.
        </p>
      `,
      footerNote: `Rechnung von ${opts.brand.name} · ${opts.brand.domain}.`,
    }),
  };
}

/**
 * Payment reminder / dunning notice. The tone escalates with `dunningLevel`:
 *   1 → freundliche Zahlungserinnerung
 *   2 → 1. Mahnung
 *   3+ → 2. Mahnung (letzte außergerichtliche Aufforderung)
 * Sent from the brand's own sender; references the already-issued invoice.
 */
export function dunningEmail(opts: {
  brand: BrandInfo;
  recipientName: string;
  invoiceNumber: string;
  invoiceDateFormatted: string | null;
  dueDateFormatted: string | null;
  totalFormatted: string;
  dunningLevel: number;
  daysOverdue: number;
  seller: {
    name: string;
    addressLines: string[];
    vatId?: string | null;
    email?: string | null;
    phone?: string | null;
  };
  /** Seller bank details for the Bankverbindung block. */
  bank?: BankInfo;
}): RenderedEmail {
  const accent = opts.brand.primaryColor ?? '#bd5b3e';
  const level = Math.max(1, opts.dunningLevel);
  const heading = level === 1 ? 'Zahlungserinnerung' : level === 2 ? '1. Mahnung' : '2. Mahnung';
  const intro =
    level === 1
      ? `unsere Rechnung <strong>${escapeHtml(opts.invoiceNumber)}</strong> ist noch offen. Vermutlich ist sie im Alltag untergegangen – das passiert. Wir möchten Sie daher freundlich an die Zahlung erinnern.`
      : level === 2
        ? `trotz unserer Erinnerung konnten wir zur Rechnung <strong>${escapeHtml(opts.invoiceNumber)}</strong> noch keinen Zahlungseingang feststellen. Wir bitten Sie, den offenen Betrag nun zeitnah zu begleichen.`
        : `zur Rechnung <strong>${escapeHtml(opts.invoiceNumber)}</strong> ist trotz Mahnung weiterhin kein Zahlungseingang verzeichnet. Wir fordern Sie hiermit letztmalig zur Zahlung auf, bevor wir weitere Schritte einleiten.`;

  const overdueLine =
    opts.daysOverdue > 0
      ? `Die Rechnung ist seit <strong>${opts.daysOverdue} Tagen</strong> überfällig${
          opts.dueDateFormatted ? ` (fällig war der ${escapeHtml(opts.dueDateFormatted)})` : ''
        }.`
      : opts.dueDateFormatted
        ? `Fällig war der <strong>${escapeHtml(opts.dueDateFormatted)}</strong>.`
        : '';

  const sellerLines = [
    `<strong>${escapeHtml(opts.seller.name)}</strong>`,
    ...opts.seller.addressLines.map(escapeHtml),
    opts.seller.vatId ? `USt-IdNr.: ${escapeHtml(opts.seller.vatId)}` : '',
    opts.seller.email ? `E-Mail: ${escapeHtml(opts.seller.email)}` : '',
    opts.seller.phone ? `Tel.: ${escapeHtml(opts.seller.phone)}` : '',
  ]
    .filter(Boolean)
    .join('<br />');

  const bankHtml = opts.bank
    ? bankTransferBlock({
        accent,
        bank: opts.bank,
        reference: opts.invoiceNumber,
        amount: opts.totalFormatted,
      })
    : '';
  const toAccount = bankHtml ? ' auf das unten genannte Konto' : '';

  return {
    subject: `${heading} zu Rechnung ${opts.invoiceNumber} · ${opts.brand.name}`,
    html: layout({
      brand: opts.brand,
      preheader: `${heading}: Rechnung ${opts.invoiceNumber} über ${opts.totalFormatted} ist offen.`,
      contentHtml: `
        <p style="margin:0 0 8px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;">${escapeHtml(heading)}</p>
        <p style="margin:0 0 16px;">Hallo ${escapeHtml(opts.recipientName)},</p>
        <p style="margin:0 0 16px;">${intro}</p>

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:0 0 16px;">
          <tr>
            <td style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;padding:2px 0;">Rechnungsnummer</td>
            <td style="font-size:13px;font-family:monospace;text-align:right;padding:2px 0;">${escapeHtml(opts.invoiceNumber)}</td>
          </tr>
          ${
            opts.invoiceDateFormatted
              ? `<tr>
            <td style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;padding:2px 0;">Rechnungsdatum</td>
            <td style="font-size:13px;text-align:right;padding:2px 0;">${escapeHtml(opts.invoiceDateFormatted)}</td>
          </tr>`
              : ''
          }
          <tr>
            <td style="font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;padding:6px 0 2px;">Offener Betrag</td>
            <td style="font-size:16px;font-weight:700;text-align:right;padding:6px 0 2px;white-space:nowrap;">${escapeHtml(opts.totalFormatted)}</td>
          </tr>
        </table>

        ${overdueLine ? `<p style="margin:0 0 16px;font-size:14px;">${overdueLine}</p>` : ''}

        <p style="margin:0 0 16px;font-size:14px;">
          Bitte überweisen Sie den offenen Betrag unter Angabe der Rechnungsnummer${toAccount}.
          Sollten Sie die Zahlung bereits veranlasst haben, betrachten Sie dieses Schreiben als gegenstandslos.
        </p>

        ${bankHtml}

        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:24px 0 0;border-top:1px solid #e2d3b6;">
          <tr>
            <td style="padding:16px 0 0;font-size:12px;color:#6b5b48;line-height:1.6;">
              <span style="text-transform:uppercase;letter-spacing:1px;font-size:11px;">Rechnungssteller</span><br />
              ${sellerLines}
            </td>
          </tr>
        </table>

        <p style="margin:20px 0 0;font-size:12px;color:#6b5b48;">
          Bei Fragen oder wenn Sie eine Ratenzahlung wünschen, antworten Sie einfach auf diese E-Mail.
        </p>
      `,
      footerNote: `${heading} von ${opts.brand.name} · ${opts.brand.domain}.`,
    }),
  };
}

/**
 * Internal admin notification — fires alongside the customer confirmation so
 * the operations inbox sees a new paid order without having to refresh the
 * dashboard. Mirrors adminInboxNotificationEmail for contact / inquiry.
 */
export function newOrderAdminEmail(opts: {
  brand: BrandInfo;
  orderNumber: string;
  customerName: string;
  customerEmail: string;
  customerPhone?: string | null;
  kindLabel: string;
  totalFormatted: string;
  pickupLabel?: string | null;
  preferredDate?: string | null;
  adminUrl: string;
}): RenderedEmail {
  const detailRows: Array<[string, string]> = [
    ['Service', opts.kindLabel],
    ['Kunde', opts.customerName],
    ['E-Mail', opts.customerEmail],
  ];
  if (opts.customerPhone) detailRows.push(['Telefon', opts.customerPhone]);
  if (opts.pickupLabel) detailRows.push(['Abholung / Service', opts.pickupLabel]);
  if (opts.preferredDate) detailRows.push(['Wunschtermin', opts.preferredDate]);
  detailRows.push(['Gesamt', opts.totalFormatted]);

  const rowsHtml = detailRows
    .map(
      ([k, v]) => `<tr>
        <td style="padding:6px 12px;font-size:12px;color:#6b5b48;border-bottom:1px solid #e2d3b6;white-space:nowrap;">${escapeHtml(k)}</td>
        <td style="padding:6px 12px;font-size:14px;border-bottom:1px solid #e2d3b6;">${escapeHtml(v)}</td>
      </tr>`,
    )
    .join('');

  return {
    subject: `Neuer Auftrag ${opts.orderNumber} · ${opts.brand.name}`,
    html: layout({
      brand: opts.brand,
      preheader: `Neuer bezahlter Auftrag: ${opts.customerName}, ${opts.totalFormatted}`,
      contentHtml: `
        <p style="margin:0 0 16px;font-size:14px;">
          <strong>${escapeHtml(opts.customerName)}</strong> hat soeben einen Auftrag bezahlt.
        </p>
        <table role="presentation" cellpadding="0" cellspacing="0" border="0" width="100%" style="margin:16px 0;border:1px solid #e2d3b6;border-radius:8px;overflow:hidden;">
          <tbody>${rowsHtml}</tbody>
        </table>
        ${button(opts.adminUrl, 'Im Dashboard öffnen', opts.brand.primaryColor)}
      `,
      footerNote: `${opts.brand.name} Operations · ${opts.brand.domain}`,
    }),
  };
}

export function contactAckEmail(opts: {
  name: string;
  brand: BrandInfo;
  message: string;
  subject?: string | null;
}): RenderedEmail {
  return {
    subject: `Wir haben Ihre Nachricht erhalten · ${opts.brand.name}`,
    html: layout({
      brand: opts.brand,
      preheader: `Vielen Dank für Ihre Anfrage bei ${opts.brand.name}.`,
      contentHtml: `
        <p style="margin:0 0 16px;">Hallo ${escapeHtml(opts.name)},</p>
        <p style="margin:0 0 8px;">
          vielen Dank für Ihre Nachricht an <strong>${escapeHtml(opts.brand.name)}</strong>.
          Wir melden uns in der Regel innerhalb eines Werktages bei Ihnen zurück.
        </p>
        ${
          opts.subject
            ? `<p style="margin:16px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;">Betreff</p>
        <p style="margin:0 0 12px;font-weight:600;">${escapeHtml(opts.subject)}</p>`
            : ''
        }
        <p style="margin:8px 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;">Ihre Nachricht</p>
        <div style="margin:0;padding:12px 16px;background:#f4ebdc;border:1px solid #e2d3b6;border-radius:8px;font-size:14px;color:#2d2419;white-space:pre-wrap;">${nl2br(opts.message)}</div>
        <p style="margin:24px 0 0;font-size:12px;color:#6b5b48;">
          Diese Bestätigung wurde automatisch erstellt. Sie können direkt auf
          diese Mail antworten, um Ergänzungen zu schicken.
        </p>
      `,
      footerNote: `Sie erhalten diese E-Mail, weil das Kontaktformular auf ${opts.brand.domain} ausgefüllt wurde.`,
    }),
  };
}

type StatusKey =
  | 'accepted'
  | 'picked_up'
  | 'in_cleaning'
  | 'ready'
  | 'delivered'
  | 'completed'
  | 'cancelled'
  | 'partially_refunded'
  | 'refunded';

interface StatusCopy {
  subject: string;
  headline: string;
  body: string;
  ctaLabel: string;
}

const STATUS_COPY: Record<StatusKey, StatusCopy> = {
  accepted: {
    subject: 'Wir kümmern uns um Ihren Auftrag',
    headline: 'Auftrag angenommen',
    body: 'Wir haben Ihren Auftrag angenommen und planen den nächsten Schritt. Sie werden bei jedem weiteren Statuswechsel benachrichtigt.',
    ctaLabel: 'Auftrag verfolgen',
  },
  picked_up: {
    subject: 'Ihr Teppich wurde abgeholt',
    headline: 'Abholung erfolgt',
    body: 'Wir haben Ihren Teppich erfolgreich abgeholt und transportieren ihn in unsere Werkstatt.',
    ctaLabel: 'Auftrag verfolgen',
  },
  in_cleaning: {
    subject: 'Ihr Teppich wird gereinigt',
    headline: 'In Bearbeitung',
    body: 'Unsere Werkstatt hat mit der professionellen Reinigung begonnen. Je nach Material dauert die Bearbeitung 7–14 Werktage.',
    ctaLabel: 'Auftrag verfolgen',
  },
  ready: {
    subject: 'Ihr Teppich ist fertig',
    headline: 'Bereit zur Auslieferung',
    body: 'Ihr Teppich ist gereinigt und bereit. Wir planen jetzt die Auslieferung — Sie hören in den nächsten Werktagen von uns.',
    ctaLabel: 'Auftrag verfolgen',
  },
  delivered: {
    subject: 'Ihr Teppich ist unterwegs',
    headline: 'Auslieferung erfolgt',
    body: 'Wir haben Ihren Teppich ausgeliefert. Bitte bestätigen Sie den Empfang im Auftrags-Portal, sobald alles in Ordnung ist.',
    ctaLabel: 'Empfang bestätigen',
  },
  completed: {
    subject: 'Vielen Dank — Auftrag abgeschlossen',
    headline: 'Auftrag abgeschlossen',
    body: 'Vielen Dank für Ihr Vertrauen. Wir würden uns sehr freuen, wenn Sie uns eine kurze Bewertung hinterlassen.',
    ctaLabel: 'Bewertung hinterlassen',
  },
  cancelled: {
    subject: 'Auftrag storniert',
    headline: 'Stornierung bestätigt',
    body: 'Wir haben Ihren Auftrag wie besprochen storniert. Falls Sie eine Rückerstattung erhalten, sehen Sie diese in 5–10 Werktagen auf Ihrem Konto.',
    ctaLabel: 'Auftragsdetails',
  },
  partially_refunded: {
    subject: 'Teilrückerstattung veranlasst',
    headline: 'Teilrückerstattung',
    body: 'Wir haben eine Teilrückerstattung für Ihren Auftrag veranlasst. Der Betrag erscheint in 5–10 Werktagen auf Ihrem Zahlungsmittel.',
    ctaLabel: 'Auftragsdetails',
  },
  refunded: {
    subject: 'Rückerstattung veranlasst',
    headline: 'Rückerstattung',
    body: 'Wir haben eine Rückerstattung für Ihren Auftrag veranlasst. Der Betrag erscheint in 5–10 Werktagen auf Ihrem Zahlungsmittel.',
    ctaLabel: 'Auftragsdetails',
  },
};

export function isStatusEmailableStatus(s: string): s is StatusKey {
  return s in STATUS_COPY;
}

export function orderStatusUpdateEmail(opts: {
  brand: BrandInfo;
  customerName: string;
  orderNumber: string;
  trackerUrl: string;
  toStatus: StatusKey;
  /** Only for cancelled / refunded — when > 0 we add a refund line. */
  refundFormatted?: string | null;
}): RenderedEmail {
  const copy = STATUS_COPY[opts.toStatus];

  const refundLine =
    opts.refundFormatted && opts.refundFormatted !== '0,00 €'
      ? `<p style="margin:16px 0 0;padding:12px 16px;background:#f4ebdc;border:1px solid #e2d3b6;border-radius:8px;font-size:14px;">
           <strong>Rückerstattung:</strong> ${escapeHtml(opts.refundFormatted)}
         </p>`
      : '';

  return {
    subject: `${copy.subject} · ${opts.orderNumber}`,
    html: layout({
      brand: opts.brand,
      preheader: copy.subject,
      contentHtml: `
        <p style="margin:0 0 16px;">Hallo ${escapeHtml(opts.customerName)},</p>
        <p style="margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;">${escapeHtml(copy.headline)}</p>
        <p style="margin:0 0 16px;font-size:16px;font-weight:600;">${escapeHtml(opts.brand.name)} — ${escapeHtml(opts.orderNumber)}</p>
        <p style="margin:0 0 16px;font-size:14px;">${escapeHtml(copy.body)}</p>
        ${refundLine}
        ${button(opts.trackerUrl, copy.ctaLabel, opts.brand.primaryColor)}
        <p style="margin:24px 0 0;font-size:12px;color:#6b5b48;">
          Diese E-Mail wurde automatisch zu Ihrem Auftrag erstellt. Bei Rückfragen
          antworten Sie einfach direkt.
        </p>
      `,
      footerNote: `Status-Update zu Ihrem Auftrag bei ${opts.brand.domain}.`,
    }),
  };
}

export function appointmentConfirmedEmail(opts: {
  brand: BrandInfo;
  customerName: string;
  orderNumber: string;
  trackerUrl: string;
  appointmentFormatted: string;
}): RenderedEmail {
  return {
    subject: `Termin bestätigt · ${opts.orderNumber}`,
    html: layout({
      brand: opts.brand,
      preheader: `Ihr Vor-Ort-Termin: ${opts.appointmentFormatted}`,
      contentHtml: `
        <p style="margin:0 0 16px;">Hallo ${escapeHtml(opts.customerName)},</p>
        <p style="margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;">Termin bestätigt</p>
        <p style="margin:0 0 16px;font-size:16px;font-weight:600;">${escapeHtml(opts.brand.name)} — ${escapeHtml(opts.orderNumber)}</p>
        <p style="margin:0 0 16px;font-size:14px;">wir haben Ihren Vor-Ort-Termin bestätigt:</p>
        <p style="margin:0 0 16px;padding:14px 16px;background:#f4ebdc;border:1px solid #e2d3b6;border-radius:8px;font-size:16px;font-weight:600;">${escapeHtml(opts.appointmentFormatted)}</p>
        <p style="margin:0 0 16px;font-size:14px;">Sollte der Termin nicht passen, antworten Sie einfach auf diese E-Mail oder rufen Sie uns an — wir finden eine Alternative.</p>
        ${button(opts.trackerUrl, 'Auftrag ansehen', opts.brand.primaryColor)}
        <p style="margin:24px 0 0;font-size:12px;color:#6b5b48;">Wir freuen uns auf Ihren Termin.</p>
      `,
      footerNote: `Terminbestätigung zu Ihrem Auftrag bei ${opts.brand.domain}.`,
    }),
  };
}

/**
 * Free-form operator message about an order — the "✦ Claude compose + send" box
 * on the Aufträge panel. Body is whatever the operator typed (Claude-drafted or
 * not); goes out under the order's own brand, per Sie like the other order mail.
 */
export function orderMessageEmail(opts: {
  brand: BrandInfo;
  customerName: string;
  orderNumber: string;
  /** Body the operator typed — plain text; newlines preserved as <br>. */
  messageBody: string;
  /** Optional order-tracker link surfaced as a button. */
  trackerUrl?: string | null;
}): RenderedEmail {
  const signature = signatureBlock(opts.brand);
  const trackerButton = opts.trackerUrl
    ? button(opts.trackerUrl, 'Auftrag ansehen', opts.brand.primaryColor)
    : '';

  return {
    subject: `${opts.brand.name} · Ihr Auftrag ${opts.orderNumber}`,
    html: layout({
      brand: opts.brand,
      preheader: `Nachricht zu Ihrem Auftrag ${opts.orderNumber}.`,
      contentHtml: `
        <p style="margin:0 0 12px;">Hallo ${escapeHtml(opts.customerName)},</p>
        <div style="font-size:14px;line-height:1.6;color:#2d2419;white-space:pre-wrap;">${nl2br(opts.messageBody)}</div>
        ${signature}
        ${trackerButton}
      `,
      footerNote: `Nachricht zu Ihrem Auftrag ${opts.orderNumber} bei ${opts.brand.domain}. Sie können direkt auf diese Mail antworten.`,
    }),
  };
}

export function paymentRequestEmail(opts: {
  brand: BrandInfo;
  customerName: string;
  orderNumber: string;
  totalFormatted: string;
  payUrl: string;
}): RenderedEmail {
  return {
    subject: `Zahlung für Ihren Auftrag · ${opts.orderNumber}`,
    html: layout({
      brand: opts.brand,
      preheader: `Bitte begleichen Sie Ihren Auftrag über ${opts.totalFormatted}.`,
      contentHtml: `
        <p style="margin:0 0 16px;">Hallo ${escapeHtml(opts.customerName)},</p>
        <p style="margin:0 0 4px;font-size:12px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;">Zahlung per Kreditkarte</p>
        <p style="margin:0 0 16px;font-size:16px;font-weight:600;">${escapeHtml(opts.brand.name)} — ${escapeHtml(opts.orderNumber)}</p>
        <p style="margin:0 0 16px;font-size:14px;">Ihr Service ist abgeschlossen — vielen Dank! Sie können Ihren Auftrag jetzt bequem und sicher online per Kreditkarte bezahlen.</p>
        <p style="margin:0 0 16px;padding:14px 16px;background:#f4ebdc;border:1px solid #e2d3b6;border-radius:8px;font-size:16px;font-weight:600;">Zu zahlender Betrag: ${escapeHtml(opts.totalFormatted)}</p>
        ${button(opts.payUrl, 'Jetzt sicher bezahlen', opts.brand.primaryColor)}
        <p style="margin:24px 0 0;font-size:12px;color:#6b5b48;">Die Zahlung wird sicher über Stripe abgewickelt. Bei Rückfragen antworten Sie einfach auf diese E-Mail.</p>
      `,
      footerNote: `Zahlungsaufforderung zu Ihrem Auftrag bei ${opts.brand.domain}.`,
    }),
  };
}

const PRIORITY_LABEL: Record<string, string> = {
  low: 'niedrig',
  normal: 'normal',
  high: 'hoch',
  urgent: 'dringend',
};

export function taskAssignedEmail(opts: {
  recipientName: string;
  brandName: string;
  taskTitle: string;
  taskBody: string | null;
  priority: string;
  dueAt: string | null;
  taskUrl: string;
}): RenderedEmail {
  const dueLine = opts.dueAt
    ? `<tr><td style="padding:4px 0;font-size:12px;color:#6b5b48;width:90px;">Fällig</td><td style="padding:4px 0;font-size:13px;">${escapeHtml(new Date(opts.dueAt).toLocaleString('de-DE'))}</td></tr>`
    : '';
  return {
    subject: `Aufgabe zugewiesen: ${opts.taskTitle}`,
    html: layout({
      brand: ADMIN_BRAND,
      preheader: `Neue Aufgabe in ${opts.brandName}.`,
      contentHtml: `
        <p style="margin:0 0 16px;">Hallo ${escapeHtml(opts.recipientName)},</p>
        <p style="margin:0 0 16px;">
          Dir wurde eine neue Aufgabe in <strong>${escapeHtml(opts.brandName)}</strong> zugewiesen.
        </p>

        <div style="margin:0 0 16px;padding:14px 16px;background:#f4ebdc;border:1px solid #e2d3b6;border-radius:8px;">
          <p style="margin:0 0 6px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;">Aufgabe</p>
          <p style="margin:0 0 10px;font-size:15px;font-weight:600;color:#2d2419;">${escapeHtml(opts.taskTitle)}</p>
          ${opts.taskBody ? `<p style="margin:0 0 10px;font-size:13px;color:#2d2419;white-space:pre-wrap;">${nl2br(opts.taskBody)}</p>` : ''}
          <table role="presentation" cellpadding="0" cellspacing="0" border="0" style="margin-top:6px;">
            <tr><td style="padding:4px 0;font-size:12px;color:#6b5b48;width:90px;">Marke</td><td style="padding:4px 0;font-size:13px;">${escapeHtml(opts.brandName)}</td></tr>
            <tr><td style="padding:4px 0;font-size:12px;color:#6b5b48;width:90px;">Priorität</td><td style="padding:4px 0;font-size:13px;">${escapeHtml(PRIORITY_LABEL[opts.priority] ?? opts.priority)}</td></tr>
            ${dueLine}
          </table>
        </div>

        ${button(opts.taskUrl, 'Aufgabe öffnen', ADMIN_BRAND.primaryColor)}

        <p style="margin:24px 0 0;font-size:12px;color:#6b5b48;">
          Du kannst die Aufgabe übernehmen, abschließen oder verwerfen, sobald du im Admin angemeldet bist.
        </p>
      `,
      footerNote: `Du erhältst diese E-Mail als zugewiesener Bearbeiter im Reinigungs-Portal.`,
    }),
  };
}

export function taskCommentEmail(opts: {
  recipientName: string;
  authorName: string;
  brandName: string;
  taskTitle: string;
  commentBody: string;
  taskUrl: string;
}): RenderedEmail {
  return {
    subject: `${opts.authorName} hat kommentiert: ${opts.taskTitle}`,
    html: layout({
      brand: ADMIN_BRAND,
      preheader: `Neuer Kommentar von ${opts.authorName}.`,
      contentHtml: `
        <p style="margin:0 0 16px;">Hallo ${escapeHtml(opts.recipientName)},</p>
        <p style="margin:0 0 16px;">
          <strong>${escapeHtml(opts.authorName)}</strong> hat einen Kommentar zu einer Aufgabe in
          <strong>${escapeHtml(opts.brandName)}</strong> hinzugefügt.
        </p>

        <p style="margin:0 0 4px;font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#6b5b48;">Aufgabe</p>
        <p style="margin:0 0 16px;font-size:14px;font-weight:600;color:#2d2419;">${escapeHtml(opts.taskTitle)}</p>

        <div style="margin:0 0 16px;padding:12px 16px;background:#f4ebdc;border:1px solid #e2d3b6;border-radius:8px;font-size:14px;color:#2d2419;white-space:pre-wrap;">${nl2br(opts.commentBody)}</div>

        ${button(opts.taskUrl, 'Im Portal antworten', ADMIN_BRAND.primaryColor)}
      `,
      footerNote: `Du erhältst diese E-Mail als zugewiesener Bearbeiter der Aufgabe.`,
    }),
  };
}
