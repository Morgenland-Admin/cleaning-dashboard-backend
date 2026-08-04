/**
 * Renders a reference invoice PDF for an A4 test print, so the DIN 5008 template
 * can be measured (address field 25/45 mm, fold marks 105/210 mm, punch
 * 148.5 mm, footer 264 mm) whenever the layout is touched.
 *
 * Sender, legal footer, Bankverbindung, logo and accent colour are read from the
 * real company row and mapped through `buildInvoicePdfData` — the same path
 * production invoices take. Nothing is taken from the design mock; pass --slug
 * to test-print any brand. Only the recipient and the amounts are a fixture
 * (Kabir's CL-1428 figures: netto 2.650,00 € · USt 19 % 503,50 € · 3.153,50 €).
 *
 *   node --import tsx scripts/render-invoice-sample.ts [options]
 *
 *     --slug <slug>  company to render for (default cleanilo)
 *     --out <path>   output file (default ./invoice-sample.pdf)
 *     --no-db        read the identity from the boot seed instead of the DB
 *     --no-logo      skip the raster wordmark → exercises the drawn fallback
 *     --long         30 line items → exercises pagination + "Seite n von m"
 *     --paid         paymentMethod 'card' → paid variant, no due date
 *     --no-tax       §19 UStG Kleinunternehmer variant
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

const lineItems: InvoiceForEmail['lineItems'] = flag('--long')
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

const subtotalCents = lineItems.reduce((a, l) => a + Math.round(l.quantity * l.unitPriceCents), 0);
const taxCents = noTax ? 0 : Math.round((subtotalCents * 19) / 100);

// Neutral placeholder recipient — never a real customer.
const invoice: InvoiceForEmail = {
  id: 0,
  number: 'CL-1428',
  recipientName: 'Musterfirma GmbH',
  recipientEmail: null,
  recipientAddressLine1: 'Musterstraße 1',
  recipientAddressLine2: null,
  recipientPostalCode: '20457',
  recipientCity: 'Hamburg',
  subject: 'Teppichbodenreinigung – Premiumreinigung',
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
  notes: null,
  paymentMethod: paid ? 'card' : 'transfer',
};

/**
 * Company identity from the boot seed — the same values `db/migrate.ts` upserts
 * into the company row. Used when there's no reachable DB, so an offline test
 * print still shows our own sender / legal / bank data. It cannot reflect later
 * admin edits made via PATCH /admin/companies; the DB path (default) does.
 */
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
