/**
 * Renders the operator-composed customer mails to HTML for per-brand sign-off; nothing is sent.
 * Identity comes from the company row (production path), recipient and body are fixtures.
 * node --import tsx scripts/render-email-sample.ts [--slug <slug>] [--out <dir, default ./email-samples>] [--no-db: boot seed instead of DB]
 */
import { mkdirSync, writeFileSync } from 'node:fs';
import { join } from 'node:path';

import { LEGACY_BOOTSTRAP } from '../src/db/bootstrap-companies.ts';
import { brandInfoFromCompany } from '../src/email/service.ts';
import {
  contactReplyEmail,
  inquiryQuoteEmail,
  orderMessageEmail,
  pickupSchedulingLinkEmail,
} from '../src/email/templates.ts';
import type { company as companyTable } from '../src/db/schema/shared.ts';

type CompanyFull = typeof companyTable.$inferSelect;

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const only = opt('--slug');
const outDir = opt('--out') ?? 'email-samples';
const slugs = only ? [only] : Object.keys(LEGACY_BOOTSTRAP);

/** Boot-seed identity for when no DB is reachable; misses later PATCH /admin/companies edits. */
function companyFromSeed(slug: string): CompanyFull {
  const cfg = LEGACY_BOOTSTRAP[slug as keyof typeof LEGACY_BOOTSTRAP];
  if (!cfg)
    throw new Error(`unknown slug "${slug}" — known: ${Object.keys(LEGACY_BOOTSTRAP).join(', ')}`);
  const l = cfg.legal;
  return {
    slug: cfg.slug,
    name: cfg.name,
    legalName: l?.legalName ?? null,
    addressLine1: l?.addressLine1 ?? null,
    addressLine2: null,
    postalCode: l?.postalCode ?? null,
    city: l?.city ?? null,
    country: l?.country ?? 'DE',
    email: cfg.senderEmail,
    senderEmail: cfg.senderEmail,
    senderName: cfg.senderName,
    phone: cfg.phone ?? null,
    mobile: cfg.mobile ?? null,
    websiteUrl: cfg.websiteUrl,
    vatId: l?.vatId ?? null,
    registrationNumber: null,
    primaryColor: cfg.primaryColor ?? null,
    emailSignature: cfg.emailSignature ?? null,
    invoiceNumberPrefix: cfg.invoiceNumberPrefix ?? null,
    logoUrl: cfg.logoUrl,
  } as unknown as CompanyFull;
}

async function loadCompanies(): Promise<Array<{ row: CompanyFull; source: string }>> {
  if (flag('--no-db')) return slugs.map((s) => ({ row: companyFromSeed(s), source: 'seed' }));
  try {
    const [{ db, pool }, { company }, { inArray }] = await Promise.all([
      import('../src/db/index.ts'),
      import('../src/db/schema/shared.ts'),
      import('drizzle-orm'),
    ]);
    const rows = await db.select().from(company).where(inArray(company.slug, slugs));
    await pool.end();
    const found = new Map(rows.map((r) => [r.slug, r]));
    return slugs.map((s) => {
      const row = found.get(s);
      return row ? { row, source: 'DB' } : { row: companyFromSeed(s), source: 'seed (no DB row)' };
    });
  } catch (err) {
    console.warn(
      `DB lookup failed (${(err as Error).message}) — using the boot seed instead; ` +
        'later admin edits are not reflected.',
    );
    return slugs.map((s) => ({ row: companyFromSeed(s), source: 'seed (DB unreachable)' }));
  }
}

// Fixtures only; never a real customer.
const RECIPIENT = 'Frau Beispiel';

mkdirSync(outDir, { recursive: true });

for (const { row, source } of await loadCompanies()) {
  const brand = brandInfoFromCompany(row);
  const mails = {
    'order-message': orderMessageEmail({
      brand,
      customerName: RECIPIENT,
      orderNumber: `${row.invoiceNumberPrefix ?? 'XX'}-1001`,
      messageBody:
        'Ihr Teppich ist fertig gereinigt und kann ab morgen abgeholt werden.\n\nBitte bringen Sie den Abholschein mit.',
      trackerUrl: 'https://example.test/bestellung?token=beispiel',
    }),
    'contact-reply': contactReplyEmail({
      brand,
      recipientName: RECIPIENT,
      replyBody:
        'vielen Dank für Ihre Nachricht. Eine Grundreinigung dauert bei uns 3–5 Werktage.\n\nGern reservieren wir einen Termin für Sie.',
      originalMessage: 'Wie lange dauert eine Grundreinigung?',
      originalSubject: 'Frage zur Reinigungsdauer',
    }),
    'pickup-scheduling-link': pickupSchedulingLinkEmail({
      brand,
      customerName: RECIPIENT,
      orderNumber: `${row.invoiceNumberPrefix ?? 'XX'}-1001`,
      // Booking page is CLEANILO for every brand; the mail stays per-brand.
      bookingUrl: 'https://calendly.com/cleanilo/besichtigung/beispiel',
    }),
    'inquiry-quote': inquiryQuoteEmail({
      brand,
      recipientName: RECIPIENT,
      quoteBody: 'Reinigung von 2 Teppichen (je 2 × 3 m), Abholung und Lieferung inklusive.',
      quotedAmount: '180,00 €',
    }),
  };

  for (const [kind, mail] of Object.entries(mails)) {
    const file = join(outDir, `${row.slug}-${kind}.html`);
    writeFileSync(file, mail.html);
    console.log(`wrote ${file} · ${source} · subject: ${mail.subject}`);
  }
  const signatory = brand.signature?.signatory ?? '(derived from company fields)';
  console.log(`  ↳ ${row.slug} signs as: ${signatory}\n`);
}
