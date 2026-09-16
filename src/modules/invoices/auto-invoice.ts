import { and, eq } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { company } from '../../db/schema/shared.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { createInvoiceDraftForOrder, type InvoiceSourceOrder } from './from-order.js';
import { nextInvoiceNumber } from './number.js';
import { sendInvoiceEmail } from './send-invoice.js';

interface MinimalLogger {
  error(obj: unknown, msg?: string): void;
}

/** Re-exported for callers that still import the row shape from here. */
export type { InvoiceSourceOrder };

/**
 * Create an invoice for a just-paid order. Idempotent (safe on webhook retries):
 * net/USt are backed out of the paid gross so the total matches to the cent.
 *
 * When the §14-UStG fields are present (address + Leistungsdatum) it also issues
 * + emails immediately (replacing n8n ALL_12) — unless the brand has
 * `auto_issue_invoices` switched off, in which case it deliberately stops at the
 * draft so an operator can still add positions agreed after the booking (a
 * repair, say) and finalise one invoice by hand.
 */
export async function autoCreateInvoiceForPaidOrder(
  tables: TenantTables,
  order: InvoiceSourceOrder,
  companySlug: string,
  log?: MinimalLogger,
): Promise<{
  created: boolean;
  issued?: boolean;
  emailed?: boolean;
  invoiceId?: number;
  number?: string | null;
}> {
  const { invoices, invoiceStatusLog } = tables;

  const draft = await createInvoiceDraftForOrder(tables, order, {
    reason: 'Automatisch erstellt (Zahlung eingegangen)',
  });
  if (!draft.created || !draft.invoice) {
    return { created: false, invoiceId: draft.invoiceId };
  }
  const invoice = draft.invoice as typeof invoices.$inferSelect;

  const [companyRow] = await db
    .select()
    .from(company)
    .where(eq(company.slug, companySlug))
    .limit(1);

  // Brand opted out of automatic issuing — leave it editable.
  if (companyRow && !companyRow.autoIssueInvoices) {
    return { created: true, issued: false, invoiceId: invoice.id, number: invoice.number };
  }

  // §14 UStG mandatory fields for issuing. Missing any → leave as draft.
  const canIssue =
    Boolean(invoice.recipientAddressLine1) &&
    Boolean(invoice.recipientPostalCode) &&
    Boolean(invoice.recipientCity) &&
    Boolean(invoice.serviceDate);
  if (!canIssue) {
    return { created: true, issued: false, invoiceId: invoice.id, number: invoice.number };
  }

  // Issue: draft → sent, assign the gapless number + stamp dueAt — atomically.
  const now = new Date();
  const dueAt = new Date(now.getTime() + invoice.paymentTermsDays * 24 * 60 * 60 * 1000);
  const issued = await db.transaction(async (tx) => {
    const number = await nextInvoiceNumber(tx, companySlug);
    const [r] = await tx
      .update(invoices)
      .set({ status: 'sent', number, sentAt: now, dueAt, updatedAt: now })
      .where(and(eq(invoices.id, invoice.id), eq(invoices.status, 'draft')))
      .returning();
    if (!r) return null;
    await tx.insert(invoiceStatusLog).values({
      invoiceId: r.id,
      fromStatus: 'draft',
      toStatus: 'sent',
      changedByUserId: null,
      reason: 'Rechnung ausgestellt & versendet (automatisch)',
    });
    return r;
  });
  if (!issued) {
    // Someone issued/voided it between create and issue — leave as is.
    return { created: true, issued: false, invoiceId: invoice.id, number: invoice.number };
  }

  // Email from the brand's sender. Best-effort — issue stands even if mail fails.
  let emailed = false;
  try {
    if (companyRow) {
      const res = await sendInvoiceEmail(companyRow, issued, log);
      emailed = res.ok;
    }
  } catch (err) {
    log?.error({ err, invoiceId: issued.id }, 'Failed to send auto-issued invoice email');
  }

  return { created: true, issued: true, emailed, invoiceId: issued.id, number: issued.number };
}
