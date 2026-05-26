/**
 * Export worker (ALL_74).
 *
 * Polls the `export_jobs` table every 5 seconds for `status='pending'` rows,
 * generates a CSV for the requested kind, uploads it to S3, and flips the
 * row to `status='done'` with `s3Key` set.
 *
 * Why a polling worker instead of a queue:
 *   - one process, no Redis/RabbitMQ to deploy
 *   - works on the same Postgres we already have
 *   - export volume is low (dozens/day at most)
 *
 * The worker is *cooperative*: only one at a time runs across processes thanks
 * to `SELECT … FOR UPDATE SKIP LOCKED` when claiming the next job. If you ever
 * scale the backend horizontally, this remains safe.
 */

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

// --- CSV utilities ---------------------------------------------------------

/** Quote a single field per RFC 4180 — handles embedded commas, quotes, CR/LF. */
function csvField(v: unknown): string {
  if (v == null) return '';
  let s: string;
  if (v instanceof Date) s = v.toISOString();
  else if (typeof v === 'object') s = JSON.stringify(v);
  else s = String(v);
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
  // CRLF — Excel friendlier, still RFC-4180.
  return lines.join('\r\n') + '\r\n';
}

// --- Per-kind generators ---------------------------------------------------

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

// --- Job lifecycle ---------------------------------------------------------

/** Claim the next pending job using SELECT … FOR UPDATE SKIP LOCKED — safe
 *  under multiple worker processes. Returns null if none. */
async function claimNextJob(): Promise<JobRow | null> {
  // Drizzle doesn't have first-class "FOR UPDATE SKIP LOCKED" sugar; the
  // cleanest path is raw SQL inside a transaction.
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
  // Resolve the company → schema mapping so we know which tenant schema to read.
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
    expires.setUTCDate(expires.getUTCDate() + 30); // 30-day retention

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

/** Start the polling worker. Called once at server boot from src/server.ts. */
export function startExportWorker(opts: { intervalMs?: number } = {}): void {
  if (workerInterval) return;
  const interval = opts.intervalMs ?? 5000;
  // Pull-loop: claim a job, run it, immediately try again until empty, then
  // wait `interval`. This keeps latency low when jobs queue up.
  const tick = async (): Promise<void> => {
    try {
      let job = await claimNextJob();
      while (job) {
        await runJob(job);
        job = await claimNextJob();
      }
    } catch (err) {
      // Don't crash the loop — log and try again next tick.

      console.error('[export-worker]', err);
    }
  };
  // Run once immediately, then on interval. The first run is async — we
  // intentionally don't await it during boot.
  void tick();
  workerInterval = setInterval(() => void tick(), interval);
  // Don't keep the event loop alive for the worker alone — server lifecycle
  // is owned by Fastify.
  workerInterval.unref?.();
}

export function stopExportWorker(): void {
  if (workerInterval) {
    clearInterval(workerInterval);
    workerInterval = null;
  }
}
