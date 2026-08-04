/**
 * Boot-time company identity for the three legacy brands: the sender block,
 * legal Pflichtangaben and bank details that appear on invoices, dunning letters
 * and branded mail.
 *
 * Single source of truth for that data. `db/migrate.ts` upserts it into the
 * `company` table on every boot (coalesced — an admin edit via
 * PATCH /admin/companies always wins), and offline tooling such as
 * `scripts/render-invoice-sample.ts` reads it directly so a test print shows the
 * same identity a real invoice carries.
 */
import { env } from '../config/env.js';
import { type LEGACY_COMPANY_SLUGS } from '../config/companies.js';
import type { EmailSignature } from '../email/templates.js';

export interface LegacyConfig {
  slug: string;
  name: string;
  schemaName: string;
  keyPrefix: string;
  storefrontOrigin: string;
  senderEmail: string;
  senderName: string;
  websiteUrl: string;
  resendApiKey: string | null;
  logoUrl: string | null;
  /** Wide wordmark for invoice PDF + email (coalesced; falls back to logoUrl). */
  invoiceLogoUrl?: string;
  /** Public phone (coalesced — an admin edit is never clobbered). */
  phone?: string;
  /** Public mobile shown in the invoice header (coalesced). */
  mobile?: string;
  /** Brand accent colour for emails + invoice PDF (coalesced). */
  primaryColor?: string;
  /** Invoice number prefix, e.g. 'CL' → "CL-1426" (coalesced). */
  invoiceNumberPrefix?: string;
  /**
   * First dashboard-issued invoice number. Seeded only while the counter is null
   * (coalesced), so a live counter is never reset. Cleanilo continues at 1426;
   * confirm Hamburg/TRL's real numbers before their first issue.
   */
  invoiceNumberStart?: number;
  /**
   * Rich email sign-off. Unlike legal/bank identity this is brand marketing
   * content owned by the seed, so it is OVERWRITTEN on every boot (there is no
   * admin UI for it) — edit it here and redeploy to update all mail.
   */
  emailSignature?: EmailSignature;
  /**
   * Legal + banking identity for invoices / dunning. Only seeded where we have
   * confirmed real-world data — brands left undefined keep their existing values
   * (admins fill them in via PATCH /admin/companies). Seeded fields are
   * coalesced so a later admin edit is never clobbered on the next boot.
   */
  legal?: {
    legalName: string;
    addressLine1: string;
    postalCode: string;
    city: string;
    country: string;
    accountHolder: string;
    iban: string;
    bic: string;
    bankName: string;
    bankAddress: string;
    /** German invoice Pflichtangaben (shared across the GbR's brands). */
    vatId?: string; // USt-IdNr. — the only tax id shown on invoices
    businessId?: string; // Betriebsnummer
    legalForm?: string; // Rechtsform
    managingDirectors?: string; // Geschäftsführer
    chamber?: string; // Handwerkskammer
  };
}

// The GbR that operates all three brands — one tax/registration identity.
// Invoices show the USt-IdNr. only; the Steuernummer was dropped from the
// template on Kabir's instruction (08/2026) and is no longer seeded.
const GBR_LEGAL = {
  vatId: 'DE352699047',
  businessId: '2931209889',
  legalForm: 'GbR',
  managingDirectors: 'K. Madjidian, M. Amiri',
  chamber: 'Handwerkskammer Hamburg',
} as const;

export const LEGACY_BOOTSTRAP: Record<(typeof LEGACY_COMPANY_SLUGS)[number], LegacyConfig> = {
  cleanilo: {
    slug: 'cleanilo',
    name: 'Cleanilo',
    schemaName: 'cleanilo',
    keyPrefix: 'cleanilo',
    storefrontOrigin: 'https://cleanilo.de',
    senderEmail: 'info@cleanilo.de',
    senderName: 'CLEANILO',
    websiteUrl: 'https://cleanilo.de',
    resendApiKey: env.RESEND_API_KEY_CLEANILO ?? null,
    logoUrl: 'https://reinigungs-portal.com/cleanilo.png',
    invoiceLogoUrl: 'https://reinigungs-portal.com/cleanilo-invoice-logo.png',
    phone: '+49 40 432 189 15',
    mobile: '+49 177 6909604',
    primaryColor: '#1f8a4c', // eco green — "ökologisch sauber"
    invoiceNumberPrefix: 'CL',
    invoiceNumberStart: 1426, // continues the imported series (latest was 1425)
    emailSignature: {
      signOff: 'Mit freundlichen Grüßen',
      signatory: 'M. Amiri',
      supportLabel: 'Supportzeiten',
      supportHours: ['Mo. – Fr.: 09:00 – 17:00 Uhr', 'Sa.: 11:00 – 17:00 Uhr'],
      phone: '+49 40 432 189 15',
      whatsapp: '+49 177 6909604',
      web: 'www.cleanilo.de',
      webUrl: 'https://www.cleanilo.de',
      hq: 'Zentrale: Brook 9, 20457 Hamburg-Speicherstadt',
      slogan: 'CLEANILO – EINFACH. SCHNELL. ZUVERLÄSSIG',
      secondaryLocation: {
        name: 'Morgenland Teppiche',
        lines: ['Brook 9', '20457 Hamburg-Speicherstadt'],
        phone: '+49 40 386 327 75',
      },
    },
    legal: {
      legalName: 'Cleanilo – M. Kabir Madjidian & M. Amiri GbR',
      addressLine1: 'Brook 9',
      postalCode: '20457',
      city: 'Hamburg',
      country: 'DE',
      accountHolder: 'Cleanilo – M. Kabir Madjidian & M. Amiri GbR',
      iban: 'DE91202208000043001639',
      bic: 'SXPYDEHHXXX',
      bankName: 'Banking Circle',
      bankAddress: 'Maximilianstraße 54, 80538 München, Deutschland',
      ...GBR_LEGAL,
    },
  },
  hamburg_teppichreinigung: {
    slug: 'hamburg_teppichreinigung',
    name: 'Hamburg Teppichreinigung',
    schemaName: 'hamburg_teppichreinigung',
    keyPrefix: 'hamburg-teppichreinigung',
    storefrontOrigin: 'https://hamburg-teppichreinigung.de',
    senderEmail: 'info@hamburg-teppichreinigung.de',
    senderName: 'Hamburg Teppichreinigung',
    websiteUrl: 'https://hamburg-teppichreinigung.de',
    resendApiKey: env.RESEND_API_KEY_HAMBURG ?? null,
    logoUrl: 'https://reinigungs-portal.com/hamburg-teppichreinigung.png',
    invoiceLogoUrl: 'https://reinigungs-portal.com/hamburg-teppichreinigung-invoice-logo.png',
    phone: '+49 40 432 189 19',
    primaryColor: '#bd5b3e', // warm rust/brown
    invoiceNumberPrefix: 'HT',
    invoiceNumberStart: 1426, // TODO(Kabir): confirm HTR's real starting number before first issue
    emailSignature: {
      signOff: 'Mit freundlichen Grüßen',
      signatory: 'M. Amiri',
      supportLabel: 'Supportzeiten',
      supportHours: ['Mo. – Fr.: 09:00 – 17:00 Uhr', 'Sa.: 11:00 – 17:00 Uhr'],
      phone: '+49 40 432 189 19',
      web: 'info@hamburg-teppichreinigung.de',
      hq: 'Zentrale: Brook 9, 20457 Hamburg',
      tagline: 'Frische Teppiche, frisches Zuhause!',
      secondaryLocation: {
        name: 'Morgenland Teppiche',
        lines: ['Brook 9', '20457 Hamburg'],
        phone: '+49 40 386 327 75',
      },
    },
    legal: {
      // Same GbR bank account as Cleanilo, but shown under the bare GbR name
      // (no brand prefix) on HTR invoices.
      legalName: 'M. Kabir Madjidian & M. Amiri GbR',
      addressLine1: 'Brook 9',
      postalCode: '20457',
      city: 'Hamburg',
      country: 'DE',
      accountHolder: 'M. Kabir Madjidian & M. Amiri GbR',
      iban: 'DE91202208000043001639',
      bic: 'SXPYDEHHXXX',
      bankName: 'Banking Circle',
      bankAddress: 'Maximilianstraße 54, 80538 München, Deutschland',
      ...GBR_LEGAL,
    },
  },
  teppichreinigen_lassen: {
    slug: 'teppichreinigen_lassen',
    name: 'Teppichreinigen Lassen',
    schemaName: 'teppichreinigen_lassen',
    keyPrefix: 'teppichreinigen-lassen',
    storefrontOrigin: 'https://teppichreinigen-lassen.de',
    senderEmail: 'info@teppichreinigen-lassen.de',
    senderName: 'teppichreinigen-lassen.de',
    websiteUrl: 'https://teppichreinigen-lassen.de',
    resendApiKey: env.RESEND_API_KEY_TRL ?? null,
    logoUrl: null,
    primaryColor: '#0f766e', // deep teal
    invoiceNumberPrefix: 'TR',
    invoiceNumberStart: 1426, // TODO(Kabir): confirm TRL's real starting number before first issue
    legal: {
      // Same GbR bank account, bare GbR name (no brand prefix) on TRL invoices.
      legalName: 'M. Kabir Madjidian & M. Amiri GbR',
      addressLine1: 'Brook 9',
      postalCode: '20457',
      city: 'Hamburg',
      country: 'DE',
      accountHolder: 'M. Kabir Madjidian & M. Amiri GbR',
      iban: 'DE91202208000043001639',
      bic: 'SXPYDEHHXXX',
      bankName: 'Banking Circle',
      bankAddress: 'Maximilianstraße 54, 80538 München, Deutschland',
      ...GBR_LEGAL,
    },
  },
};
