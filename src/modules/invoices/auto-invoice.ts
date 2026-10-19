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

export type { InvoiceSourceOrder };

/**
 * Create an invoice for a just-paid order; idempotent (webhook retries). Issues + emails at once
 * when the §14 UStG fields are present, unless the brand has `auto_issue_invoices` off (stops at draft).
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

  if (companyRow && !companyRow.autoIssueInvoices) {
    return { created: true, issued: false, invoiceId: invoice.id, number: invoice.number };
  }

  // §14 UStG mandatory fields; any missing → stays draft.
  const canIssue =
    Boolean(invoice.recipientAddressLine1) &&
    Boolean(invoice.recipientPostalCode) &&
    Boolean(invoice.recipientCity) &&
    Boolean(invoice.serviceDate);
  if (!canIssue) {
    return { created: true, issued: false, invoiceId: invoice.id, number: invoice.number };
  }

  // Number assignment and the status flip must be one transaction (gapless series).
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
    // Lost a race with a manual issue/void.
    return { created: true, issued: false, invoiceId: invoice.id, number: invoice.number };
  }

  // Best-effort: the issue stands even if the mail fails.
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
