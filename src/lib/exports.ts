import { and, desc, eq, gte, isNotNull, lt, sql, type SQL } from 'drizzle-orm';

import { db } from '../db/index.js';
import { exportJobs, company } from '../db/schema/shared.js';
import { deleteExportObject, putExportObject } from './s3.js';
import { getTenantTables } from '../db/schema/tenant.js';

export type ExportKind = 'orders' | 'inquiries' | 'contacts' | 'newsletter';

/** Supported export filters — validated at job creation, applied at run time. */
export interface ExportFilter {
  /** Inclusive lower bound, "YYYY-MM-DD". */
  createdFrom?: string;
  /** Inclusive upper bound, "YYYY-MM-DD". */
  createdTo?: string;
  status?: string;
}

function filterConds(
  filter: ExportFilter,
  createdAtCol: Parameters<typeof gte>[0],
  statusCol: Parameters<typeof eq>[0] | null,
): SQL[] {
  const conds: SQL[] = [];
  if (filter.createdFrom)
    conds.push(gte(createdAtCol, new Date(`${filter.createdFrom}T00:00:00Z`)));
  if (filter.createdTo) {
    const end = new Date(`${filter.createdTo}T00:00:00Z`);
    end.setUTCDate(end.getUTCDate() + 1);
    conds.push(lt(createdAtCol, end));
  }
  if (filter.status && statusCol) conds.push(eq(statusCol, filter.status));
  return conds;
}

interface JobRow extends Record<string, unknown> {
  id: number;
  companySlug: string;
  kind: string;
  filter: unknown;
  format: string;
}

function csvField(v: unknown): string {
  if (v == null) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
  if (/^[=+\-@\t\r]/.test(s)) {
    s = `'${s}`;
  }
  if (s.includes(',') || s.includes('"') || s.includes('\n') || s.includes('\r')) {
    return `"${s.replace(/"/g, '""')}"`;
  }
  return s;
}

function rowsToCsv(header: string[], rows: Array<Record<string, unknown>>): string {
  const lines = [header.join(',')];
  for (const r of rows) {
    lines.push(header.map((h) => csvField(r[h])).join(','));
  }
  return lines.join('\r\n') + '\r\n';
}

async function fetchExportRows(
  schemaName: string,
  kind: ExportKind,
  filter: ExportFilter,
): Promise<{ header: string[]; rows: Array<Record<string, unknown>> }> {
  const tables = getTenantTables(schemaName);

  switch (kind) {
    case 'orders': {
      const conds = filterConds(filter, tables.orders.createdAt, tables.orders.status);
      const rows = await db
        .select()
        .from(tables.orders)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(tables.orders.createdAt));
      return {
        header: [
          'id',
          'publicToken',
          'kind',
          'status',
          'customerName',
          'customerEmail',
          'customerPhone',
          'addressLine1',
          'addressCity',
          'addressPostalCode',
          'subtotalCents',
          'pickupFeeCents',
          'totalCents',
          'currency',
          'pickupMode',
          'pickupZone',
          'preferredDate',
          'paidAt',
          'completedAt',
          'cancelledAt',
          'createdAt',
        ],
        rows: rows.map((r) => ({ ...r })),
      };
    }
    case 'inquiries': {
      const conds = filterConds(
        filter,
        tables.serviceInquiries.createdAt,
        tables.serviceInquiries.status,
      );
      const rows = await db
        .select()
        .from(tables.serviceInquiries)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(tables.serviceInquiries.createdAt));
      return {
        header: [
          'id',
          'name',
          'email',
          'phone',
          'service',
          'message',
          'status',
          'priority',
          'consentMarketing',
          'createdAt',
          'quotedAt',
          'quotedAmount',
          'closedAt',
        ],
        rows: rows.map((r) => ({ ...r })),
      };
    }
    case 'contacts': {
      const conds = filterConds(
        filter,
        tables.contactMessages.createdAt,
        tables.contactMessages.status,
      );
      const rows = await db
        .select()
        .from(tables.contactMessages)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(tables.contactMessages.createdAt));
      return {
        header: [
          'id',
          'name',
          'email',
          'phone',
          'subject',
          'message',
          'status',
          'priority',
          'consentMarketing',
          'createdAt',
          'repliedAt',
        ],
        rows: rows.map((r) => ({ ...r })),
      };
    }
    case 'newsletter': {
      // No status column — date range only.
      const conds = filterConds(filter, tables.newsletterSubscribers.createdAt, null);
      const rows = await db
        .select()
        .from(tables.newsletterSubscribers)
        .where(conds.length ? and(...conds) : undefined)
        .orderBy(desc(tables.newsletterSubscribers.createdAt));
      return {
        header: [
          'id',
          'email',
          'firstName',
          'lastName',
          'locale',
          'source',
          'confirmed',
          'confirmedAt',
          'unsubscribedAt',
          'createdAt',
        ],
        rows: rows.map((r) => ({ ...r })),
      };
    }
  }
}

async function claimNextJob(): Promise<JobRow | null> {
  return await db.transaction(async (tx) => {
    const claimed = await tx.execute<JobRow>(sql`
      WITH next_job AS (
        SELECT id FROM export_jobs
        WHERE status = 'pending'
        ORDER BY created_at ASC
        LIMIT 1
        FOR UPDATE SKIP LOCKED
      )
      UPDATE export_jobs
      SET status = 'processing', started_at = NOW()
      WHERE id = (SELECT id FROM next_job)
      RETURNING id, company_slug AS "companySlug", kind, filter, format;
    `);
    const row = claimed.rows[0] ?? null;
    return row;
  });
}

async function runJob(job: JobRow): Promise<void> {
  const [companyRow] = await db
    .select()
    .from(company)
    .where(eq(company.slug, job.companySlug))
    .limit(1);
  if (!companyRow) {
    await db
      .update(exportJobs)
      .set({
        status: 'failed',
        errorMessage: `Unknown company slug "${job.companySlug}"`,
        completedAt: new Date(),
      })
      .where(eq(exportJobs.id, job.id));
    return;
  }

  try {
    const filter = job.filter && typeof job.filter === 'object' ? (job.filter as ExportFilter) : {};
    const { header, rows } = await fetchExportRows(
      companyRow.schemaName,
      job.kind as ExportKind,
      filter,
    );
    const csv = rowsToCsv(header, rows);
    const { key, sizeBytes } = await putExportObject({
      keyPrefix: companyRow.keyPrefix ?? companyRow.slug,
      filenameBase: `${job.kind}-${job.companySlug}`,
      contentType: 'text/csv',
      body: csv,
      downloadFilename: `${job.kind}-${job.companySlug}-${new Date()
        .toISOString()
        .slice(0, 10)}.csv`,
    });

    const expires = new Date();
    expires.setUTCDate(expires.getUTCDate() + 30);

    // Don't resurrect a job that was stale-failed meanwhile; drop its S3 object.
    const finished = await db
      .update(exportJobs)
      .set({
        status: 'done',
        rowCount: rows.length,
        s3Key: key,
        sizeBytes,
        completedAt: new Date(),
        expiresAt: expires,
      })
      .where(and(eq(exportJobs.id, job.id), eq(exportJobs.status, 'processing')))
      .returning({ id: exportJobs.id });
    if (finished.length === 0) {
      try {
        await deleteExportObject(key);
      } catch (err) {
        console.error('[export-worker] orphan cleanup failed for job', job.id, err);
      }
    }
  } catch (err) {
    await db
      .update(exportJobs)
      .set({
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      })
      .where(and(eq(exportJobs.id, job.id), eq(exportJobs.status, 'processing')));
  }
}

/** Fail jobs stuck in 'processing' (worker died mid-job). */
async function failStaleJobs(): Promise<void> {
  await db.execute(sql`
    UPDATE export_jobs
    SET status = 'failed',
        error_message = 'Worker died mid-export (stale lease) — please request the export again.',
        completed_at = NOW()
    WHERE status = 'processing' AND started_at < NOW() - INTERVAL '15 minutes';
  `);
}

/** Delete S3 objects of expired exports (PII cleanup). */
async function cleanupExpiredExports(): Promise<void> {
  const expired = await db
    .select({ id: exportJobs.id, s3Key: exportJobs.s3Key })
    .from(exportJobs)
    .where(
      and(
        eq(exportJobs.status, 'done'),
        isNotNull(exportJobs.s3Key),
        lt(exportJobs.expiresAt, new Date()),
      ),
    )
    .limit(20);
  for (const job of expired) {
    try {
      if (job.s3Key) await deleteExportObject(job.s3Key);
      await db.update(exportJobs).set({ s3Key: null }).where(eq(exportJobs.id, job.id));
    } catch (err) {
      console.error('[export-worker] cleanup failed for job', job.id, err);
    }
  }
}

let workerInterval: NodeJS.Timeout | null = null;
let cleanupCounter = 0;

/** Start the polling worker. Called once at server boot. */
export function startExportWorker(opts: { intervalMs?: number } = {}): void {
  if (workerInterval) return;
  const interval = opts.intervalMs ?? 5000;
  const tick = async (): Promise<void> => {
    try {
      await failStaleJobs();
      let job = await claimNextJob();
      while (job) {
        await runJob(job);
        job = await claimNextJob();
      }
      // Cleanup ~once a minute, not every tick.
      cleanupCounter += 1;
      if (cleanupCounter >= 12) {
        cleanupCounter = 0;
        await cleanupExpiredExports();
      }
    } catch (err) {
      console.error('[export-worker]', err);
    }
  };
  void tick();
  workerInterval = setInterval(() => void tick(), interval);
  workerInterval.unref?.();
}

export function stopExportWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}
