/**
 * Reference invoice PDF for an A4 test print to measure the DIN 5008 layout (address field 25/45 mm,
 * fold marks 105/210 mm, punch 148.5 mm, footer 264 mm).
 * Identity comes from the company row (production path); only recipient and amounts are fixtures.
 *
 *   node --import tsx scripts/render-invoice-sample.ts [options]
 *
 *     --slug <slug>  company to render for (default cleanilo)
 *     --out <path>   output file (default ./invoice-sample.pdf)
 *     --no-db        read the identity from the boot seed instead of the DB
 *     --no-logo      skip the raster wordmark → exercises the drawn fallback
 *     --long         30 line items → exercises pagination + "Seite n von m"
 *     --paket        Paketrechnung: positions without prices, one package price
 *     --paid         paymentMethod 'card' → paid variant, no due date
 *     --no-tax       §19 UStG Kleinunternehmer variant
 *     --handwerker   §35a EStG labour-share block above the closing line
 *     --notes        free-text remark under the payment terms
 */
import { writeFileSync } from 'node:fs';

import { fetchInvoiceLogo, renderInvoicePdf } from '../src/lib/invoice-pdf.ts';
import { buildInvoicePdfData, type InvoiceForEmail } from '../src/modules/invoices/send-invoice.ts';
import { LEGACY_BOOTSTRAP } from '../src/db/bootstrap-companies.ts';
import type { company as companyTable } from '../src/db/schema/shared.ts';

type CompanyFull = typeof companyTable.$inferSelect;

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const slug = opt('--slug') ?? 'cleanilo';
const out = opt('--out') ?? 'invoice-sample.pdf';
const paid = flag('--paid');
const noTax = flag('--no-tax');
const paket = flag('--paket');

/** Paketrechnung fixture: positions carry no price; this net package price is the subtotal. */
const PACKAGE_NET_CENTS = 1_250_000;
const packageLineItems: InvoiceForEmail['lineItems'] = [
  {
    label:
      'Rückbau- und Vorbereitungsarbeiten in EG, OG, Zwischenräumen und Dachgeschoss gemäß Angebot',
    note: null,
    quantity: 1,
    unitPriceCents: 0,
  },
  {
    label: 'Erdgeschoss: Aufnahme und fachgerechte Entsorgung des vorhandenen Teppichbodens',
    note: null,
    quantity: 1,
    unitPriceCents: 0,
  },
  {
    label: 'Kellertreppe: Instandsetzungsarbeiten an Wänden und Stufen',
    note: null,
    quantity: 1,
    unitPriceCents: 0,
  },
  {
    label:
      'Obergeschoss: Reinigung des vorhandenen Teppichbodens sowie Ergänzung/Instandsetzung eines beschädigten Teilbereichs',
    note: null,
    quantity: 1,
    unitPriceCents: 0,
  },
  {
    label:
      'Zwischenräume/Abstellbereiche: Rückbau und Entsorgung undichter Dämm- und Abdichtungsbestandteile; Einbau neuer Dämmwolle und neuer Dampfbremse',
    note: null,
    quantity: 1,
    unitPriceCents: 0,
  },
  {
    label:
      'Dachgeschoss: vollständige Entfernung des Teppichbodens, umfassende Grundreinigung der Flächen, leichte Instandsetzung erkennbarer undichter Stellen',
    note: null,
    quantity: 1,
    unitPriceCents: 0,
  },
];

const lineItems: InvoiceForEmail['lineItems'] = paket
  ? packageLineItems
  : flag('--long')
    ? Array.from({ length: 30 }, (_, i) => ({
        label: `Teppichreinigung Position ${i + 1} – Handwäsche mit Spezialshampoo`,
        note: i % 3 === 0 ? 'Premiumreinigung' : null,
        quantity: 1,
        unitPriceCents: 8800,
      }))
    : [
        {
          label: 'Teppichbodenreinigung – Obere Etage',
          note: 'Premiumreinigung',
          quantity: 1,
          unitPriceCents: 135_000,
        },
        {
          label: 'Teppichbodenreinigung – Untere Etage',
          note: 'Premiumreinigung',
          quantity: 1,
          unitPriceCents: 130_000,
        },
      ];

const subtotalCents = paket
  ? PACKAGE_NET_CENTS
  : lineItems.reduce((a, l) => a + Math.round(l.quantity * l.unitPriceCents), 0);
const taxCents = noTax ? 0 : Math.round((subtotalCents * 19) / 100);

// Fixtures only; never a real customer.
const invoice: InvoiceForEmail = {
  id: 0,
  number: 'CL-1428',
  recipientName: 'Musterfirma GmbH',
  recipientEmail: null,
  recipientAddressLine1: 'Musterstraße 1',
  recipientAddressLine2: null,
  recipientPostalCode: '20457',
  recipientCity: 'Hamburg',
  subject: paket
    ? 'Sanierungs- und Reinigungsarbeiten – Pauschalpaket'
    : 'Teppichbodenreinigung – Premiumreinigung',
  serviceDate: '2026-08-03',
  serviceDateEnd: null,
  sentAt: new Date('2026-08-03T09:00:00Z'),
  dueAt: new Date('2026-08-10T09:00:00Z'),
  paymentTermsDays: 7,
  taxRatePercent: noTax ? 0 : 19,
  taxCents,
  subtotalCents,
  totalCents: subtotalCents + taxCents,
  lineItems,
  packageMode: paket,
  notes: flag('--notes')
    ? 'Die Randfixierung im Flur wurde nach Rücksprache nicht ausgeführt und ist nicht berechnet.'
    : null,
  paymentMethod: paid ? 'card' : 'transfer',
  // §35a: stand-in labour share (60 % of gross); operators enter the real one.
  craftsmanService: flag('--handwerker'),
  laborGrossCents: Math.round((subtotalCents + taxCents) * 0.6),
  laborVatCents: null,
  craftsmanNote: null,
};

/** Boot-seed identity for when no DB is reachable; misses later PATCH /admin/companies edits. */
function companyFromSeed(): CompanyFull {
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
    phone: cfg.phone ?? null,
    mobile: cfg.mobile ?? null,
    websiteUrl: cfg.websiteUrl,
    vatId: l?.vatId ?? null,
    registrationNumber: null,
    businessId: l?.businessId ?? null,
    legalForm: l?.legalForm ?? null,
    managingDirectors: l?.managingDirectors ?? null,
    chamber: l?.chamber ?? null,
    accountHolder: l?.accountHolder ?? null,
    iban: l?.iban ?? null,
    bic: l?.bic ?? null,
    bankName: l?.bankName ?? null,
    bankAddress: l?.bankAddress ?? null,
    primaryColor: cfg.primaryColor ?? null,
    emailSignature: cfg.emailSignature ?? null,
    logoUrl: cfg.logoUrl,
    invoiceLogoUrl: cfg.invoiceLogoUrl ?? null,
  } as unknown as CompanyFull;
}

async function loadCompany(): Promise<{ row: CompanyFull; source: string }> {
  if (flag('--no-db')) return { row: companyFromSeed(), source: 'company data from seed' };
  try {
    const [{ db, pool }, { company }, { eq }] = await Promise.all([
      import('../src/db/index.ts'),
      import('../src/db/schema/shared.ts'),
      import('drizzle-orm'),
    ]);
    const [row] = await db.select().from(company).where(eq(company.slug, slug)).limit(1);
    await pool.end();
    if (!row) throw new Error(`no company row for slug "${slug}"`);
    return { row, source: 'company data from DB' };
  } catch (err) {
    console.warn(
      `DB lookup for "${slug}" failed (${(err as Error).message}) — ` +
        'using the boot seed instead; later admin edits are not reflected.',
    );
    return { row: companyFromSeed(), source: 'company data from seed (DB unreachable)' };
  }
}

const { row: companyRow, source } = await loadCompany();
const pdfData = buildInvoicePdfData(companyRow, invoice);
if (!flag('--no-logo')) {
  pdfData.logo = (await fetchInvoiceLogo(companyRow.invoiceLogoUrl ?? companyRow.logoUrl)) ?? null;
  if (!pdfData.logo)
    console.warn('no usable raster logo for this brand — rendering the drawn fallback');
}

const pdf = await renderInvoicePdf(pdfData);
writeFileSync(out, pdf);
console.log(`wrote ${out} (${(pdf.length / 1024).toFixed(1)} kB) · ${slug} · ${source}`);
