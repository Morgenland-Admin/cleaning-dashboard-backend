export class HttpError extends Error {
  constructor(
    public readonly statusCode: number,
    message: string,
    public readonly code?: string,
  ) {
    super(message);
  }
}

export const badRequest = (msg = 'Bad Request') => new HttpError(400, msg, 'BAD_REQUEST');
export const unauthorized = (msg = 'Unauthorized') => new HttpError(401, msg, 'UNAUTHORIZED');
export const forbidden = (msg = 'Forbidden') => new HttpError(403, msg, 'FORBIDDEN');
export const notFound = (msg = 'Not Found') => new HttpError(404, msg, 'NOT_FOUND');
export const conflict = (msg = 'Conflict') => new HttpError(409, msg, 'CONFLICT');

/**
 * Parse a positive-integer route param. Throws 400 (caught by the error
 * handler in app.ts) when the value is missing, non-numeric, negative, or
 * not a safe integer. Avoids `Number("abc") === NaN` reaching Drizzle and
 * surfacing as a leaky 500.
 */
export function parseIntId(value: unknown, field = 'id'): number {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`Invalid ${field}`);
  }
  // Strict integer match — `Number()` would accept "1.5", "1e3", etc.
  if (!/^\d+$/.test(value)) throw badRequest(`Invalid ${field}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw badRequest(`Invalid ${field}`);
  return n;
}
