import { desc, eq, sql } from 'drizzle-orm';

import { db } from '../db/index.js';
import { exportJobs, company } from '../db/schema/shared.js';
import { putExportObject } from './s3.js';
import { getTenantTables } from '../db/schema/tenant.js';

export type ExportKind = 'orders' | 'inquiries' | 'contacts' | 'newsletter';

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
): Promise<{ header: string[]; rows: Array<Record<string, unknown>> }> {
  const tables = getTenantTables(schemaName);

  switch (kind) {
    case 'orders': {
      const rows = await db.select().from(tables.orders).orderBy(desc(tables.orders.createdAt));
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
      const rows = await db
        .select()
        .from(tables.serviceInquiries)
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
      const rows = await db
        .select()
        .from(tables.contactMessages)
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
      const rows = await db
        .select()
        .from(tables.newsletterSubscribers)
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
    const { header, rows } = await fetchExportRows(companyRow.schemaName, job.kind as ExportKind);
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

    await db
      .update(exportJobs)
      .set({
        status: 'done',
        rowCount: rows.length,
        s3Key: key,
        sizeBytes,
        completedAt: new Date(),
        expiresAt: expires,
      })
      .where(eq(exportJobs.id, job.id));
  } catch (err) {
    await db
      .update(exportJobs)
      .set({
        status: 'failed',
        errorMessage: err instanceof Error ? err.message : String(err),
        completedAt: new Date(),
      })
      .where(eq(exportJobs.id, job.id));
  }
}

let workerInterval: NodeJS.Timeout | null = null;

/** Start the polling worker. Called once at server boot. */
export function startExportWorker(opts: { intervalMs?: number } = {}): void {
  if (workerInterval) return;
  const interval = opts.intervalMs ?? 5000;
  const tick = async (): Promise<void> => {
    try {
      let job = await claimNextJob();
      while (job) {
        await runJob(job);
        job = await claimNextJob();
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
