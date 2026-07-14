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
export const tooManyRequests = (msg = 'Too Many Requests') =>
  new HttpError(429, msg, 'TOO_MANY_REQUESTS');

export function parseIntId(value: unknown, field = 'id'): number {
  if (typeof value !== 'string' || value.length === 0) {
    throw badRequest(`Invalid ${field}`);
  }
  if (!/^\d+$/.test(value)) throw badRequest(`Invalid ${field}`);
  const n = Number(value);
  if (!Number.isSafeInteger(n) || n <= 0) throw badRequest(`Invalid ${field}`);
  return n;
}
