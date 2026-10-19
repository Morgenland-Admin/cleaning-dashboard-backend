/**
 * After scripts/copy-cleanilo-legacy-files.ts: points imported CLEANILO rows at the copied files,
 * so they open in the dashboard and partner portal.
 *  - inquiries: `attachments` from the old upload keys
 *  - orders: `metadata.files` (orders have no attachment column)
 *  - old chat contact messages and partner chat messages: `attachments`
 *  - partners: old insurance/licence/… files as `partner_documents` (status pending)
 *
 * Dry run by default; `--commit` writes. Re-runnable: rows that already have files are skipped.
 *
 *   DOTENV_CONFIG_PATH=.env.prod node --import tsx scripts/link-cleanilo-legacy-files.ts [--commit]
 */
import { readFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { and, eq, sql } from 'drizzle-orm';

import { db, pool } from '../src/db/index.ts';
import { getTenantTables } from '../src/db/schema/tenant.ts';
import { legacyAttachments } from '../src/modules/legacy/partner-chat.ts';
import { destKeyOf } from './copy-cleanilo-legacy-files.ts';

const TENANT = 'cleanilo';
const SOURCE = 'import_legacy_cleanilo';
const OPS_BUCKET = 'cleanilo-admin-bucket';
const COMMIT = process.argv.includes('--commit');
const manifestArg = process.argv.indexOf('--manifest');
const MANIFEST =
  manifestArg >= 0
    ? process.argv[manifestArg + 1]!
    : path.join(
        os.homedir(),
        '.local/share/cleanilo-legacy-snapshot-2026-10-29/files-manifest.jsonl',
      );

type FileRef = { key: string; name: string; size: number; contentType?: string };

const CONTENT_TYPES: Record<string, string> = {
  pdf: 'application/pdf',
  jpg: 'image/jpeg',
  jpeg: 'image/jpeg',
  png: 'image/png',
  webp: 'image/webp',
  gif: 'image/gif',
  heic: 'image/heic',
  heif: 'image/heif',
  mp4: 'video/mp4',
  mov: 'video/quicktime',
  doc: 'application/msword',
  docx: 'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
};

// Old partner fields → new document kinds; the logo stays in the archive.
const DOCUMENT_FIELDS: Record<string, { kind: string; label: string }> = {
  liscense: { kind: 'gewerbeanmeldung', label: 'Gewerbeanmeldung' },
  insurance: { kind: 'haftpflicht', label: 'Versicherung' },
  public_liability: { kind: 'haftpflicht', label: 'Betriebshaftpflicht' },
  public_lability: { kind: 'haftpflicht', label: 'Betriebshaftpflicht' },
  company_registration: { kind: 'handelsregister', label: 'Handelsregister' },
  vat: { kind: 'sonstiges', label: 'USt-Nachweis' },
  bank_statement: { kind: 'sonstiges', label: 'Kontonachweis' },
  contract: { kind: 'sonstiges', label: 'Alter Partnervertrag' },
};

const sizes = new Map<string, number>();
for (const line of readFileSync(MANIFEST, 'utf8').split('\n')) {
  if (!line.trim()) continue;
  const m = JSON.parse(line) as { bucket: string; key: string; size: number };
  if (m.bucket === OPS_BUCKET) sizes.set(m.key, m.size);
}
const missing = new Set<string>();

/** Old upload key → file in the uploads bucket; null when the copy has no such object. */
export function fileRef(oldKey: string): FileRef | null {
  const size = sizes.get(oldKey);
  if (size == null) {
    missing.add(oldKey);
    return null;
  }
  const base = oldKey.split('/').pop() ?? oldKey;
  const name = base.replace(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}-/i, '');
  const ext = name.split('.').pop()?.toLowerCase() ?? '';
  return { key: destKeyOf(OPS_BUCKET, oldKey), name, size, contentType: CONTENT_TYPES[ext] };
}
/** Same rule as the import: business email if set, else the account email. */
const loginEmailOf = (d: Record<string, unknown>) => {
  const pick = (v: unknown) => (typeof v === 'string' ? v.trim().toLowerCase() : '');
  return pick(d.business_email) || pick(d.email);
};
const refs = (v: unknown) => legacyAttachments(v).flatMap((k) => fileRef(k) ?? []);
/** Partner document fields are `{ url: "/COMPANY_…/file" }` objects. */
const documentRefs = (v: unknown) => {
  const url = v && typeof v === 'object' ? (v as { url?: unknown }).url : v;
  return typeof url === 'string' ? refs(url.replace(/^\/+/, '')) : [];
};

async function main() {
  const T = getTenantTables(TENANT);
  const count = { inquiries: 0, orders: 0, contacts: 0, chatMessages: 0, documents: 0 };

  const inquiries = await db
    .select({ id: T.serviceInquiries.id, metadata: T.serviceInquiries.metadata })
    .from(T.serviceInquiries)
    .where(
      and(
        eq(T.serviceInquiries.source, SOURCE),
        sql`${T.serviceInquiries.attachments} = '[]'::jsonb`,
        sql`jsonb_array_length(coalesce(${T.serviceInquiries.metadata}->'legacyAttachments', '[]'::jsonb)) > 0`,
      ),
    );
  for (const row of inquiries) {
    const files = refs(row.metadata.legacyAttachments);
    if (!files.length) continue;
    count.inquiries += 1;
    if (COMMIT) {
      await db
        .update(T.serviceInquiries)
        .set({ attachments: files })
        .where(eq(T.serviceInquiries.id, row.id));
    }
  }

  const orders = await db
    .select({ id: T.orders.id, metadata: T.orders.metadata })
    .from(T.orders)
    .where(
      and(
        eq(T.orders.source, SOURCE),
        sql`not (${T.orders.metadata} ? 'files')`,
        sql`jsonb_array_length(coalesce(${T.orders.metadata}->'legacyAttachments', '[]'::jsonb)) > 0`,
      ),
    );
  for (const row of orders) {
    const files = refs(row.metadata.legacyAttachments);
    if (!files.length) continue;
    count.orders += 1;
    if (COMMIT) {
      await db
        .update(T.orders)
        .set({ metadata: sql`${T.orders.metadata} || ${JSON.stringify({ files })}::jsonb` })
        .where(eq(T.orders.id, row.id));
    }
  }

  // Old client chats were imported as one contact message per conversation.
  const legacyRows = async (table: string) =>
    db
      .select({ data: T.legacyRecords.data })
      .from(T.legacyRecords)
      .where(
        and(eq(T.legacyRecords.source, 'cleanilo_ops'), eq(T.legacyRecords.legacyTable, table)),
      );
  const clientChats = await legacyRows('admin_client_chat');
  const pairChats = await legacyRows('client_partner_chat');
  const contacts = await db
    .select({ id: T.contactMessages.id, metadata: T.contactMessages.metadata })
    .from(T.contactMessages)
    .where(
      and(
        eq(T.contactMessages.source, SOURCE),
        sql`${T.contactMessages.attachments} = '[]'::jsonb`,
        sql`${T.contactMessages.metadata}->'legacy'->>'table' in ('admin_client_chat', 'client_partner_chat')`,
      ),
    );
  for (const row of contacts) {
    const legacy = row.metadata.legacy as { table: string; id: string };
    const [, client, partner] = legacy.id.split(':');
    const messages =
      legacy.table === 'admin_client_chat'
        ? clientChats.filter((m) => String(m.data.clientPhone) === client)
        : pairChats.filter(
            (m) => String(m.data.clientPhone) === client && String(m.data.partnerPhone) === partner,
          );
    const files = messages.flatMap((m) => refs(m.data.attachment));
    if (!files.length) continue;
    count.contacts += 1;
    if (COMMIT) {
      await db
        .update(T.contactMessages)
        .set({ attachments: files })
        .where(eq(T.contactMessages.id, row.id));
    }
  }

  // Partner chat copies carry "[Anhang im alten System: <key>]" lines; turn them into real files.
  const marker = /\n?\[Anhang im alten System: ([^\]\n]+)\]/g;
  const chatMessages = await db
    .select({ id: T.chatMessages.id, body: T.chatMessages.body })
    .from(T.chatMessages)
    .where(
      and(
        sql`${T.chatMessages.attachments} = '[]'::jsonb`,
        sql`${T.chatMessages.body} like '%[Anhang im alten System:%'`,
      ),
    );
  for (const row of chatMessages) {
    const keys = [...(row.body ?? '').matchAll(marker)].map((m) => m[1]!.trim());
    const files = keys.flatMap((k) => fileRef(k) ?? []);
    if (files.length !== keys.length) continue; // keep the text if any file is missing
    count.chatMessages += 1;
    const body = (row.body ?? '').replace(marker, '').trim();
    if (COMMIT) {
      await db
        .update(T.chatMessages)
        .set({ attachments: files, body: body || null })
        .where(eq(T.chatMessages.id, row.id));
    }
  }

  // Partners created from the old system: their files become documents to review.
  const oldPartners = (await legacyRows('cleanilo_partner')).map((r) => r.data);
  const partners = await db
    .select({ id: T.partners.id, email: T.partners.contactEmail })
    .from(T.partners)
    .where(sql`${T.partners.internalNotes} like 'Aus dem alten CLEANILO-System übernommen%'`);
  for (const partner of partners) {
    const email = (partner.email ?? '').toLowerCase();
    const companies = oldPartners.filter((d) => loginEmailOf(d) === email);
    const existing = new Set(
      (
        await db
          .select({ key: T.partnerDocuments.fileKey })
          .from(T.partnerDocuments)
          .where(eq(T.partnerDocuments.partnerId, partner.id))
      ).map((d) => d.key),
    );
    for (const company of companies) {
      for (const [field, { kind, label }] of Object.entries(DOCUMENT_FIELDS)) {
        for (const file of documentRefs(company[field])) {
          if (existing.has(file.key)) continue;
          existing.add(file.key);
          count.documents += 1;
          if (COMMIT) {
            await db.insert(T.partnerDocuments).values({
              partnerId: partner.id,
              kind,
              fileKey: file.key,
              fileName: `${label} (altes System) – ${file.name}`,
              contentType: file.contentType ?? null,
              sizeBytes: file.size,
              status: 'pending',
              createdAt: new Date(String(company.updated_at ?? company.created_at ?? Date.now())),
            });
          }
        }
      }
    }
  }

  console.log(`${COMMIT ? 'Linked' : 'Would link'}:`, count);
  if (missing.size) console.log(`old keys without a copied file: ${missing.size}`);
  if (!COMMIT) console.log('Dry run only. Add --commit to write.');
}

main()
  .catch((err) => {
    console.error(err);
    process.exitCode = 1;
  })
  .finally(() => pool.end());
