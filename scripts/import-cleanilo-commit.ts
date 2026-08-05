/**
 * Real writer for the CLEANILO historical import. Loaded only when the runner
 * is invoked with --commit. Writes DIRECTLY to the cleanilo tenant schema —
 * never through the live API/webhook paths — so no automation fires:
 *
 *   - orders  → status 'completed', paid/completed timestamps = invoice date,
 *               source tag `import_cleanilo_2021_26`, consentMarketing = false.
 *   - invoices→ status 'paid' (outside the dunning sweep's sent/overdue filter),
 *               original number preserved, dunningLevel 0.
 *   - customers→ no-marketing flag, tier pre-computed, b2b tag where applicable.
 *
 * Idempotent: an invoice whose original number already exists in the tenant is
 * skipped, so a re-run tops up rather than duplicating.
 */
import { and, eq } from 'drizzle-orm';

import { db } from '../src/db/index.ts';
import { company } from '../src/db/schema/shared.ts';
import { getTenantTables } from '../src/db/schema/tenant.ts';
import { generateOrderToken } from '../src/modules/orders/lib.ts';
import {
  CLEANILO_SLUG,
  IMPORT_SOURCE,
  type ImportPlan,
  type ParsedInvoice,
} from './import-cleanilo-lib.ts';

const VAT_RATE = 19;
const DAY_MS = 24 * 60 * 60 * 1000;

function netFromGross(grossCents: number): number {
  return Math.round(grossCents / (1 + VAT_RATE / 100));
}

export interface CommitResult {
  customersWritten: number;
  ordersWritten: number;
  invoicesWritten: number;
  skippedExisting: number;
}

export async function commitImport(plan: ImportPlan): Promise<CommitResult> {
  const [companyRow] = await db
    .select()
    .from(company)
    .where(eq(company.slug, CLEANILO_SLUG))
    .limit(1);
  if (!companyRow) throw new Error(`Company "${CLEANILO_SLUG}" not found — cannot import.`);

  const t = getTenantTables(companyRow.schemaName);
  const result: CommitResult = {
    customersWritten: 0,
    ordersWritten: 0,
    invoicesWritten: 0,
    skippedExisting: 0,
  };

  for (const c of plan.customers) {
    await db.transaction(async (tx) => {
      // Upsert the customer by its unique email; keep the richest fields.
      const [cust] = await tx
        .insert(t.customers)
        .values({
          email: c.email,
          name: c.name,
          phone: c.phone,
          addressLine1: c.street,
          postalCode: c.plz,
          city: c.city,
          country: c.country,
          totalOrders: c.totalOrders,
          totalSpentCents: c.totalSpentCents,
          loyaltyTier: c.tier,
          tags: c.isB2B ? ['b2b', 'import-2021-26'] : ['import-2021-26'],
          firstOrderAt: new Date(c.firstOrderAt),
          lastOrderAt: new Date(c.lastOrderAt),
          marketingOptIn: false,
          createdAt: new Date(c.firstOrderAt),
        })
        .onConflictDoUpdate({
          target: t.customers.email,
          set: {
            name: c.name,
            totalOrders: c.totalOrders,
            totalSpentCents: c.totalSpentCents,
            loyaltyTier: c.tier,
            lastOrderAt: new Date(c.lastOrderAt),
            updatedAt: new Date(),
          },
        })
        .returning({ id: t.customers.id });
      const customerId = cust!.id;
      result.customersWritten += 1;

      for (const inv of c.sourceInvoices) {
        // Idempotency: skip only an exact prior landing. Keyed on number +
        // total + recipient because the source reuses some invoice numbers for
        // different customers — number alone would wrongly drop the second one.
        const existing = await tx
          .select({ id: t.invoices.id })
          .from(t.invoices)
          .where(
            and(
              eq(t.invoices.number, inv.invoiceNumber),
              eq(t.invoices.totalCents, inv.grossCents),
              eq(t.invoices.recipientName, inv.name),
            ),
          )
          .limit(1);
        if (existing.length > 0) {
          result.skippedExisting += 1;
          continue;
        }
        await writeOrderAndInvoice(tx, t, inv, c.isB2B, customerId, {
          // Order carries the customer's email (placeholder or verified) so all
          // of a customer's orders share it; the invoice recipient stays empty
          // for placeholders — we never store a fake address on an invoice.
          customerEmail: c.email,
          invoiceRecipientEmail: c.emailIsPlaceholder ? null : c.email,
        });
        result.ordersWritten += 1;
        result.invoicesWritten += 1;
      }
    });
  }

  return result;
}

type Tx = Parameters<Parameters<typeof db.transaction>[0]>[0];
type Tables = ReturnType<typeof getTenantTables>;

async function writeOrderAndInvoice(
  tx: Tx,
  t: Tables,
  inv: ParsedInvoice,
  isB2B: boolean,
  customerId: number,
  emails: { customerEmail: string; invoiceRecipientEmail: string | null },
): Promise<void> {
  const when = new Date(inv.date);
  const gross = inv.grossCents;
  const net = netFromGross(gross);
  const tax = gross - net;
  const renumbered = inv.invoiceNumber !== inv.originalNumber;
  const noteParts = [`Historischer Import (${inv.sourceFile})`];
  if (renumbered)
    noteParts.push(`Original-Nr. ${inv.originalNumber} (wegen Doppelvergabe umnummeriert)`);
  if (inv.dateEstimated) noteParts.push('Datum im Original fehlend (Jahr geschätzt)');

  const [order] = await tx
    .insert(t.orders)
    .values({
      publicToken: generateOrderToken(),
      customerId,
      // Leave orderNumber null → derives "YYYY/000123" from id + createdAt year.
      kind: 'teppichreinigung',
      status: 'completed',
      currency: 'EUR',
      subtotalCents: gross,
      totalCents: gross,
      pickupMode: 'onsite',
      pickupLabel: 'Historischer Auftrag (Import)',
      customerName: inv.name,
      customerEmail: emails.customerEmail,
      addressLine1: inv.street,
      addressCity: inv.city,
      addressPostalCode: inv.plz,
      addressCountry: inv.country,
      paymentMode: 'after_service',
      consentPrivacy: true,
      consentMarketing: false,
      source: IMPORT_SOURCE,
      metadata: {
        historical: true,
        importedInvoiceNumber: inv.invoiceNumber,
        originalInvoiceNumber: inv.originalNumber,
        sourceFile: inv.sourceFile,
        service: inv.service,
      },
      paidAt: when,
      completedAt: when,
      createdAt: when,
      updatedAt: when,
    })
    .returning({ id: t.orders.id });
  const orderId = order!.id;

  await tx.insert(t.orderItems).values({
    orderId,
    code: 'historical',
    label: inv.service || 'Reinigungsleistung',
    quantityLabel: '1',
    quantity: '1',
    unitPriceCents: gross,
    subtotalCents: gross,
  });

  await tx.insert(t.invoices).values({
    number: inv.invoiceNumber, // original, or "<orig>-N" for a de-duped collision
    orderId,
    customerId,
    customerType: isB2B ? 'b2b' : 'b2c',
    recipientName: inv.name,
    recipientEmail: emails.invoiceRecipientEmail,
    recipientAddressLine1: inv.street,
    recipientPostalCode: inv.plz,
    recipientCity: inv.city,
    recipientCountry: inv.country,
    serviceDate: inv.dateEstimated ? null : inv.date, // no false Leistungsdatum
    status: 'paid', // NOT sent/overdue → dunning never touches it
    currency: 'EUR',
    subtotalCents: net,
    taxRatePercent: VAT_RATE,
    taxCents: tax,
    totalCents: gross,
    lineItems: [{ label: inv.service || 'Reinigungsleistung', quantity: 1, unitPriceCents: gross }],
    sentAt: when,
    paidAt: when,
    dueAt: new Date(when.getTime() + 14 * DAY_MS),
    dunningLevel: 0,
    notes: noteParts.join(' · '),
    createdAt: when,
    updatedAt: when,
  });
}
