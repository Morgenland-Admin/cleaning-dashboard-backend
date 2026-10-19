import { and, gt, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';

import { decodeCursor } from '../../lib/cursor.js';

const MAX_INT4 = 2147483647;

/** Source filter value for rows without a source (plain web-form submissions). */
export const NO_SOURCE = '_none';

export function likePattern(q: string): string {
  return `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
}

/** "123", "#123" and "ANF-2026-000123" all address the row id. */
export function inquiryIdFromQuery(q: string): number | null {
  const m = /^(?:#|ANF-\d{4}-)?0*(\d{1,10})$/i.exec(q.trim());
  if (!m) return null;
  const id = Number(m[1]);
  return id > 0 && id <= MAX_INT4 ? id : null;
}

/** `keysetAfter` for `ORDER BY created_at ASC, id ASC`; the boundary is re-read from the cursor row (µs precision). */
export function keysetAfterAsc(
  table: AnyPgTable,
  createdAt: AnyPgColumn,
  id: AnyPgColumn,
  cursor: string | undefined,
): SQL | undefined {
  const decoded = cursor ? decodeCursor(cursor) : null;
  if (!decoded) return undefined;
  const boundary = sql`coalesce((select ${createdAt} from ${table} where ${id} = ${decoded.id}), ${decoded.createdAt}::timestamptz)`;
  return or(gt(createdAt, boundary), and(sql`${createdAt} = ${boundary}`, gt(id, decoded.id)));
}
