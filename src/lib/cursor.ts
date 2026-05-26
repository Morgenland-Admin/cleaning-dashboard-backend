/**
 * Stable opaque cursor for list pagination. Encodes the last row's
 * (createdAt, id) tuple so the next page can do
 *   WHERE (created_at, id) < ($cursorCreatedAt, $cursorId)
 *   ORDER BY created_at DESC, id DESC
 * — which is stable even when many rows share the same created_at second.
 *
 * Format: base64url(JSON.stringify({ c: ISO, i: number })). Encoded so it
 * looks like a single opaque token to clients; decoded server-side.
 */

export interface ListCursor {
  /** ISO 8601 timestamp of the last row on the previous page. */
  createdAt: string;
  /** Primary key of the last row. */
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
    // fallthrough
  }
  return null;
}
