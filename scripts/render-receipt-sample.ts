/**
 * Renders a sample Eingangsbestätigung (PDF + email body) through the production path, so the layout can be checked
 * without an order. Identity comes from the company row (boot seed with --no-db); only customer and positions are fixtures.
 *
 *   node --import tsx scripts/render-receipt-sample.ts [options]
 *
 *     --slug <slug>   company to render for (default hamburg_teppichreinigung)
 *     --out <base>    output base path → <base>.pdf + <base>.html (default ./receipt-sample)
 *     --no-db         read the identity from the boot seed instead of the DB
 *     --no-logo       skip the raster wordmark → exercises the drawn fallback
 *     --photo <path>  JPEG/PNG used for every fixture photo (omit → placeholders)
 *     --drop-off      handed in at the workshop instead of collected
 *     --paid          booked total already paid online → "Offener Betrag" row
 *     --update        a previous version was sent → "ersetzt" notice
 *     --many          12 positions → exercises pagination
 */
import { readFileSync, writeFileSync } from 'node:fs';

import { LEGACY_BOOTSTRAP } from '../src/db/bootstrap-companies.ts';
import type { company as companyTable } from '../src/db/schema/shared.ts';
import { brandInfoFromCompany } from '../src/email/service.ts';
import { orderReceiptEmail } from '../src/email/templates.ts';
import { fetchInvoiceLogo } from '../src/lib/pdf-letterhead.ts';
import { letterheadFromCompany } from '../src/modules/invoices/send-invoice.ts';
import {
  buildReceiptLines,
  buildReceiptView,
  computeReceiptTotals,
  receiptDraftSchema,
} from '../src/modules/orders/receipt.ts';
import { renderReceiptPdf } from '../src/modules/orders/receipt-pdf.ts';

type CompanyFull = typeof companyTable.$inferSelect;

const argv = process.argv.slice(2);
const flag = (name: string) => argv.includes(name);
const opt = (name: string) => {
  const i = argv.indexOf(name);
  return i >= 0 ? argv[i + 1] : undefined;
};

const slug = opt('--slug') ?? 'hamburg_teppichreinigung';
const outBase = (opt('--out') ?? 'receipt-sample').replace(/\.(pdf|html)$/, '');
const photoPath = opt('--photo');

const photo = (key: string) => ({ key: `sample/receipts/${key}.jpg`, name: `${key}.jpg` });

const baseItems = [
  {
    code: 'carpet.perser_premium',
    label: 'Teppichreinigung · Perser Premium',
    quantity: 6,
    unitPriceCents: 1890,
    lengthCm: 200,
    widthCm: 350,
    tagNumber: 'HT-0815',
    condition: 'Fransen an einer Schmalseite lose, Wasserfleck ca. 20 cm im Mittelfeld.',
    photos: [photo('perser-1'), photo('perser-2'), photo('perser-3')],
    addons: [
      {
        code: 'addon.impraegnierung',
        label: 'Imprägnierung (Perser Premium)',
        unitPriceCents: 400,
      },
    ],
  },
  {
    code: 'carpet.maschinell',
    label: 'Teppichreinigung · Maschinell',
    quantity: 2.5,
    quantityLabel: '2,5 m²',
    unitPriceCents: 1290,
    tagNumber: 'HT-0816',
    condition: 'Rund, Ø 180 cm. Keine Auffälligkeiten.',
    photos: [photo('rund-1')],
    addons: [],
  },
];
const items = flag('--many')
  ? Array.from({ length: 12 }, (_, i) => ({
      ...baseItems[i % 2]!,
      tagNumber: `HT-${String(900 + i)}`,
      photos: i < 4 ? [photo(`p${i}`)] : [],
    }))
  : baseItems;

const draft = receiptDraftSchema.parse({
  handover: flag('--drop-off') ? 'drop_off' : 'pickup',
  receivedAt: '2026-10-16T14:30',
  pickupFeeCents: flag('--drop-off') ? 0 : 1500,
  note: 'Der Perser wird vor der Reinigung auf Farbechtheit geprüft.',
  items,
});

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
    senderEmail: cfg.senderEmail,
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
      `DB lookup for "${slug}" failed (${(err as Error).message}) — using the boot seed instead.`,
    );
    return { row: companyFromSeed(), source: 'company data from seed (DB unreachable)' };
  }
}

const { row: companyRow, source } = await loadCompany();
const { lines, groups } = buildReceiptLines(draft);
const totals = computeReceiptTotals(lines, {
  pickupFeeCents: draft.pickupFeeCents,
  discountCents: 0,
  minOrderCents: 2500,
  // The booked 6 m² + 2,5 m² as paid online, before measuring.
  paidCents: flag('--paid') ? 11340 + 2400 + 3225 + draft.pickupFeeCents : 0,
});
const view = buildReceiptView({
  order: { orderNumber: '2026/000039', voucherCode: null },
  draft,
  groups,
  totals,
  isUpdate: flag('--update'),
  invoiceFollows: true,
});

const photos = new Map<string, Buffer>();
if (photoPath) {
  const bytes = readFileSync(photoPath);
  for (const it of draft.items) for (const p of it.photos) photos.set(p.key, bytes);
}

const pdf = await renderReceiptPdf({
  brandName: companyRow.name,
  logo: flag('--no-logo')
    ? null
    : await fetchInvoiceLogo(companyRow.invoiceLogoUrl ?? companyRow.logoUrl),
  ...letterheadFromCompany(companyRow),
  recipientName: 'Erika Mustermann',
  recipientAddressLines: draft.handover === 'pickup' ? ['Musterweg 12', '20457 Hamburg'] : [],
  view,
  photos,
});
writeFileSync(`${outBase}.pdf`, pdf);

const email = orderReceiptEmail({
  ...view,
  brand: { ...brandInfoFromCompany(companyRow), logoUrl: companyRow.logoUrl },
  customerName: 'Erika Mustermann',
  trackerUrl: 'https://example.com/bestellung?token=sample',
});
writeFileSync(`${outBase}.html`, email.html);

console.log(
  `wrote ${outBase}.pdf (${(pdf.length / 1024).toFixed(1)} kB) + ${outBase}.html · "${email.subject}" · ${slug} · ${source}`,
);
