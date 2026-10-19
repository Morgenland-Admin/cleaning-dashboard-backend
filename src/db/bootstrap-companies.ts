/**
 * Boot-time identity (sender, Pflichtangaben, bank) of the three legacy brands. `db/migrate.ts`
 * upserts it into `company` on every boot, coalesced so PATCH /admin/companies edits win;
 * offline scripts read it directly.
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
  resendWebhookSecret: string | null;
  logoUrl: string | null;
  /** Wide wordmark for invoice PDF + email; falls back to logoUrl. */
  invoiceLogoUrl?: string;
  phone?: string;
  mobile?: string;
  primaryColor?: string;
  /** Invoice number prefix, e.g. 'CL' → "CL-1426". */
  invoiceNumberPrefix?: string;
  /** First dashboard-issued invoice number; seeded only while the counter is null, never resets a live one. */
  invoiceNumberStart?: number;
  /** Seed-owned (no admin UI): overwritten on every boot, unlike the coalesced fields. */
  emailSignature?: EmailSignature;
  /** Invoice/dunning identity, seeded coalesced; an undefined brand keeps its existing values. */
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
    vatId?: string; // USt-IdNr. — the only tax id shown on invoices
    businessId?: string; // Betriebsnummer
    legalForm?: string;
    managingDirectors?: string;
    chamber?: string;
  };
}

// One GbR operates all three brands. Invoices show the USt-IdNr. only, never the Steuernummer.
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
    resendWebhookSecret: env.RESEND_WEBHOOK_SECRET_CLEANILO ?? null,
    logoUrl: 'https://reinigungs-portal.com/cleanilo.png',
    invoiceLogoUrl: 'https://reinigungs-portal.com/cleanilo-invoice-logo.png',
    phone: '+49 40 432 189 15',
    mobile: '+49 177 6909604',
    primaryColor: '#1f8a4c',
    invoiceNumberPrefix: 'CL',
    invoiceNumberStart: 1426, // continues the imported series (latest 1425)
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
    resendWebhookSecret: env.RESEND_WEBHOOK_SECRET_HAMBURG ?? null,
    logoUrl: 'https://reinigungs-portal.com/hamburg-teppichreinigung.png',
    invoiceLogoUrl: 'https://reinigungs-portal.com/hamburg-teppichreinigung-invoice-logo.png',
    phone: '+49 40 432 189 19',
    primaryColor: '#bd5b3e',
    invoiceNumberPrefix: 'HT',
    invoiceNumberStart: 1426, // TODO(Kabir): confirm HTR's real starting number before first issue
    emailSignature: {
      signOff: 'Mit freundlichen Grüßen',
      signatory: 'M. Amiri',
      supportLabel: 'Supportzeiten',
      supportHours: ['Mo. – Fr.: 09:00 – 17:00 Uhr', 'Sa.: 11:00 – 17:00 Uhr'],
      phone: '+49 40 432 189 19',
      web: 'www.hamburg-teppichreinigung.de',
      webUrl: 'https://hamburg-teppichreinigung.de',
      hq: 'Zentrale: Brook 9, 20457 Hamburg',
      tagline: 'Frische Teppiche, frisches Zuhause!',
      secondaryLocation: {
        name: 'Morgenland Teppiche',
        lines: ['Brook 9', '20457 Hamburg'],
        phone: '+49 40 386 327 75',
      },
    },
    legal: {
      // Same bank account as Cleanilo, but the bare GbR name (no brand prefix).
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
    resendWebhookSecret: env.RESEND_WEBHOOK_SECRET_TRL ?? null,
    logoUrl: null,
    primaryColor: '#0f766e',
    invoiceNumberPrefix: 'TR',
    invoiceNumberStart: 1426, // TODO(Kabir): confirm TRL's real starting number before first issue
    emailSignature: {
      signOff: 'Mit freundlichen Grüßen',
      signatory: 'M. Amiri',
      supportLabel: 'Supportzeiten',
      supportHours: ['Mo. – Fr.: 09:00 – 17:00 Uhr', 'Sa.: 11:00 – 17:00 Uhr'],
      // TODO(Kabir): no TRL phone number yet; add once the nationwide number is live.
      web: 'www.teppichreinigen-lassen.de',
      webUrl: 'https://www.teppichreinigen-lassen.de',
      hq: 'Zentrale: Brook 9, 20457 Hamburg',
    },
    legal: {
      // Same bank account as Cleanilo, but the bare GbR name (no brand prefix).
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
