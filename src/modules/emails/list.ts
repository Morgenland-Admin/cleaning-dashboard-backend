import { and, desc, eq, sql, type SQL } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { company, emailLog } from '../../db/schema/shared.js';
import { encodeCursor, keysetAfter } from '../../lib/cursor.js';

export const emailListColumns = {
  id: emailLog.id,
  companySlug: emailLog.companySlug,
  companyName: company.name,
  kind: emailLog.kind,
  toAddress: emailLog.toAddress,
  subject: emailLog.subject,
  status: emailLog.status,
  deliveryStatus: emailLog.deliveryStatus,
  deliveredAt: emailLog.deliveredAt,
  openedAt: emailLog.openedAt,
  clickedAt: emailLog.clickedAt,
  hasBody: sql<boolean>`${emailLog.html} IS NOT NULL`,
  attachmentCount: sql<number>`jsonb_array_length(${emailLog.attachments})::int`,
  refType: emailLog.refType,
  refId: emailLog.refId,
  createdAt: emailLog.createdAt,
};

/** `to_address` holds the recipients joined with ", "; this matches one of them exactly. */
export function sentToAddress(address: string): SQL {
  return sql`${address.trim().toLowerCase()} = ANY(regexp_split_to_array(lower(${emailLog.toAddress}), '\\s*,\\s*'))`;
}

/** Newest first, keyset-paged on (created_at, id). */
export async function pageEmailLog(conds: SQL[], limit: number, cursor?: string) {
  const after = keysetAfter(emailLog, emailLog.createdAt, emailLog.id, cursor);
  const where = after ? [...conds, after] : conds;
  const rows = await db
    .select(emailListColumns)
    .from(emailLog)
    .leftJoin(company, eq(emailLog.companySlug, company.slug))
    .where(where.length ? and(...where) : undefined)
    .orderBy(desc(emailLog.createdAt), desc(emailLog.id))
    .limit(limit + 1);

  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  return {
    emails: page,
    nextCursor:
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null,
  };
}
