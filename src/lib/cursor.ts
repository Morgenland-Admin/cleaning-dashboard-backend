import { and, lt, or, sql, type SQL } from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';

/**
 * Opaque keyset cursor: the last row's (createdAt, id), for `WHERE (created_at, id) < (...)
 * ORDER BY created_at DESC, id DESC` — stable even when rows share a created_at.
 */

export interface ListCursor {
  createdAt: string;
  id: number;
}

function b64urlEncode(s: string): string {
  return Buffer.from(s, 'utf8')
    .toString('base64')
    .replace(/\+/g, '-')
    .replace(/\//g, '_')
    .replace(/=+$/g, '');
}

function b64urlDecode(s: string): string {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64').toString('utf8');
}

export function encodeCursor(c: ListCursor): string {
  return b64urlEncode(JSON.stringify({ c: c.createdAt, i: c.id }));
}

export function decodeCursor(token: string): ListCursor | null {
  try {
    const data = JSON.parse(b64urlDecode(token));
    if (
      typeof data === 'object' &&
      data &&
      typeof data.c === 'string' &&
      typeof data.i === 'number'
    ) {
      return { createdAt: data.c, id: data.i };
    }
  } catch {
    // malformed token
  }
  return null;
}

/**
 * Rows after the cursor in `ORDER BY created_at DESC, id DESC`. Postgres stores microseconds but the
 * cursor only carries milliseconds, so the boundary is re-read from the cursor row itself; otherwise
 * rows inserted by one statement (CSV imports) fall out of page 2.
 */
export function keysetAfter(
  table: AnyPgTable,
  createdAt: AnyPgColumn,
  id: AnyPgColumn,
  cursor: string | undefined,
): SQL | undefined {
  const decoded = cursor ? decodeCursor(cursor) : null;
  if (!decoded) return undefined;
  const boundary = sql`coalesce((select ${createdAt} from ${table} where ${id} = ${decoded.id}), ${decoded.createdAt}::timestamptz)`;
  return or(lt(createdAt, boundary), and(sql`${createdAt} = ${boundary}`, lt(id, decoded.id)));
}
