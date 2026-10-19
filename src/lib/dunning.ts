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
const PER_TENANT_BATCH = 100;
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

/** Best-effort, never throws. `dunningLevel` is the level being communicated (after incrementing). */
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
    log: { companySlug: companyRow.slug, kind: 'dunning', refType: 'invoice', refId: invoice.id },
    apiKey: companyRow.resendApiKey ?? undefined,
    replyTo: companyRow.email ?? undefined,
    email: dunningEmail({
      brand: {
        ...brandInfoFromCompany(companyRow),
        logoUrl: companyRow.invoiceLogoUrl ?? companyRow.logoUrl,
      },
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
    if (inv.dunningLevel >= MAX_DUNNING_LEVEL) continue;
    if (
      inv.lastDunningAt &&
      now.getTime() - inv.lastDunningAt.getTime() < DUNNING_INTERVAL_DAYS * DAY_MS
    ) {
      continue;
    }

    const nextLevel = inv.dunningLevel + 1;
    try {
      // Atomic claim so overlapping ticks cannot double-send: advance only if level and status are unchanged.
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
        // Revert the claim so the next sweep retries instead of waiting out the 7-day spacing.
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

/** pg advisory-lock key: one replica sweeps at a time. */
const DUNNING_LOCK_KEY = 7_421_002;

/** One pass over every active tenant, guarded by a session advisory lock so only one replica runs it per tick. */
export async function runDunningSweep(): Promise<void> {
  const client = await pool.connect();
  try {
    const res = await client.query<{ locked: boolean }>(
      `SELECT pg_try_advisory_lock(${DUNNING_LOCK_KEY}) AS locked`,
    );
    if (!res.rows[0]?.locked) return;
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

export function startDunningWorker(opts: { intervalMs?: number } = {}): void {
  if (workerInterval) return;
  const interval = opts.intervalMs ?? DEFAULT_INTERVAL_MS;
  const tick = (): void => {
    if (inFlight) return;
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

export async function stopDunningWorker(): Promise<void> {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
  if (inFlight) await inFlight;
}
