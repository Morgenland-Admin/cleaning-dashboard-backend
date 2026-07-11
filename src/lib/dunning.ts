import { and, asc, eq, inArray, lt } from 'drizzle-orm';

import { db, pool } from '../db/index.js';
import { company } from '../db/schema/shared.js';
import { getTenantTables } from '../db/schema/tenant.js';
import { brandInfoFromCompany, brandSender, sendEmail } from '../email/service.js';
import { dunningEmail } from '../email/templates.js';
import { formatEurFromCents } from './pricing.js';

type CompanyRow = typeof company.$inferSelect;

/** Stop automated dunning after this level — beyond it goes to manual/inkasso. */
const MAX_DUNNING_LEVEL = 3;
/** Minimum days between two automated dunning steps for the same invoice. */
const DUNNING_INTERVAL_DAYS = 7;
/** Invoices examined per tenant per sweep — keeps a single tick bounded. */
const PER_TENANT_BATCH = 100;
/** Default sweep cadence. Per-invoice spacing makes a tighter interval harmless. */
const DEFAULT_INTERVAL_MS = 6 * 60 * 60 * 1000;
const DAY_MS = 24 * 60 * 60 * 1000;

interface DunnableInvoice {
  id: number;
  number: string | null;
  recipientName: string;
  recipientEmail: string | null;
  sentAt: Date | null;
  dueAt: Date | null;
  totalCents: number;
  dunningLevel: number;
}

/**
 * Render and send a dunning notice for one invoice from the brand's own sender.
 * Best-effort — never throws. `dunningLevel` should be the level being
 * communicated (i.e. the value *after* incrementing).
 */
export async function sendDunningEmail(
  companyRow: CompanyRow,
  invoice: DunnableInvoice,
): Promise<{ ok: boolean; skipped: boolean }> {
  if (!invoice.recipientEmail) return { ok: false, skipped: true };

  const fmtDate = (d: Date) =>
    d.toLocaleDateString('de-DE', { day: '2-digit', month: '2-digit', year: 'numeric' });
  const now = new Date();
  const daysOverdue = invoice.dueAt
    ? Math.max(0, Math.floor((now.getTime() - invoice.dueAt.getTime()) / DAY_MS))
    : 0;
  const addressLines = [
    companyRow.addressLine1,
    companyRow.addressLine2,
    [companyRow.postalCode, companyRow.city].filter(Boolean).join(' ') || null,
  ].filter((x): x is string => Boolean(x));

  const result = await sendEmail({
    to: invoice.recipientEmail,
    from: brandSender(companyRow),
    apiKey: companyRow.resendApiKey ?? undefined,
    replyTo: companyRow.email ?? undefined,
    email: dunningEmail({
      brand: brandInfoFromCompany(companyRow),
      recipientName: invoice.recipientName,
      invoiceNumber: invoice.number ?? `#${invoice.id}`,
      invoiceDateFormatted: invoice.sentAt ? fmtDate(invoice.sentAt) : null,
      dueDateFormatted: invoice.dueAt ? fmtDate(invoice.dueAt) : null,
      totalFormatted: formatEurFromCents(invoice.totalCents),
      dunningLevel: invoice.dunningLevel,
      daysOverdue,
      seller: {
        name: companyRow.legalName ?? companyRow.name,
        addressLines,
        vatId: companyRow.vatId,
        email: companyRow.email,
        phone: companyRow.phone,
      },
      bank: {
        accountHolder: companyRow.accountHolder ?? companyRow.legalName ?? companyRow.name,
        iban: companyRow.iban,
        bic: companyRow.bic,
        bankName: companyRow.bankName,
        bankAddress: companyRow.bankAddress,
      },
    }),
  });
  return { ok: result.ok && !result.skipped, skipped: result.skipped ?? false };
}

/** Escalate dunning for all overdue invoices of a single tenant. */
async function sweepTenant(companyRow: CompanyRow): Promise<void> {
  const { invoices, invoiceStatusLog } = getTenantTables(companyRow.schemaName);
  const now = new Date();

  const candidates = await db
    .select()
    .from(invoices)
    .where(and(inArray(invoices.status, ['sent', 'overdue']), lt(invoices.dueAt, now)))
    .orderBy(asc(invoices.dueAt))
    .limit(PER_TENANT_BATCH);

  for (const inv of candidates) {
    if (inv.dunningLevel >= MAX_DUNNING_LEVEL) continue; // capped — manual from here
    if (
      inv.lastDunningAt &&
      now.getTime() - inv.lastDunningAt.getTime() < DUNNING_INTERVAL_DAYS * DAY_MS
    ) {
      continue; // too soon for the next step
    }

    const nextLevel = inv.dunningLevel + 1;
    // One bad invoice must not abort the rest of the tenant's batch.
    try {
      // Atomic claim guards against overlapping ticks: only advance if the level
      // and status are still what we read.
      const [updated] = await db
        .update(invoices)
        .set({ dunningLevel: nextLevel, lastDunningAt: now, status: 'overdue', updatedAt: now })
        .where(
          and(
            eq(invoices.id, inv.id),
            eq(invoices.dunningLevel, inv.dunningLevel),
            inArray(invoices.status, ['sent', 'overdue']),
          ),
        )
        .returning();
      if (!updated) continue;

      await db.insert(invoiceStatusLog).values({
        invoiceId: inv.id,
        fromStatus: inv.status,
        toStatus: 'overdue',
        changedByUserId: null,
        reason: `Mahnstufe ${nextLevel} (automatisch)`,
      });

      const res = await sendDunningEmail(companyRow, updated);
      if (!res.ok && !res.skipped) {
        // Don't burn the step: revert the claim so the next sweep retries it
        // (rather than silently skipping for the 7-day spacing window).
        await db
          .update(invoices)
          .set({ dunningLevel: inv.dunningLevel, lastDunningAt: inv.lastDunningAt, updatedAt: now })
          .where(eq(invoices.id, inv.id));
        console.error(`[dunning-worker] email failed company=${companyRow.slug} invoice=${inv.id}`);
      }
    } catch (err) {
      console.error(`[dunning-worker] invoice ${inv.id} failed`, err);
    }
  }
}

/** Shared pg advisory-lock key so only one replica sweeps at a time. */
const DUNNING_LOCK_KEY = 7_421_002;

/**
 * One full pass over every active tenant. Guarded by a session-level advisory
 * lock so that with multiple replicas only one runs the sweep per tick — the
 * others skip cleanly. Exported for tests / manual runs.
 */
export async function runDunningSweep(): Promise<void> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${DUNNING_LOCK_KEY}) AS locked`,
    );
    if (!res.rows[0]?.locked) return; // another replica is sweeping
    try {
      const companies = await db.select().from(company).where(eq(company.isActive, true));
      for (const c of companies) {
        try {
          await sweepTenant(c);
        } catch (err) {
          console.error('[dunning-worker] tenant sweep failed', c.slug, err);
        }
      }
    } finally {
      await client.query(`SELECT pg_advisory_unlock(${DUNNING_LOCK_KEY})`);
    }
  } finally {
    client.release();
  }
}

let workerInterval: NodeJS.Timeout | null = null;
let inFlight: Promise<void> | null = null;

/** Start the daily overdue/dunning sweep. Called once at server boot. */
export function startDunningWorker(opts: { intervalMs?: number } = {}): void {
  if (workerInterval) return;
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const tick = (): void => {
    if (inFlight) return; // never overlap sweeps
    inFlight = runDunningSweep()
      .catch((err) => console.error('[dunning-worker]', err))
      .finally(() => {
        inFlight = null;
      });
  };
  tick();
  workerInterval = setInterval(tick, interval);
  workerInterval.unref?.();
}

/** Stop the worker and wait for any in-flight sweep to finish (drain). */
export async function stopDunningWorker(): Promise<void> {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  if (inFlight) await inFlight;
}
