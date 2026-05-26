import { createHmac, randomBytes, timingSafeEqual } from 'node:crypto';
import { env } from '../config/env.js';

function b64urlEncode(buf: Buffer): string {
  return buf.toString('base64').replace(/\+/g, '-').replace(/\//g, '_').replace(/=+$/g, '');
}

function b64urlDecode(s: string): Buffer {
  const pad = s.length % 4 === 0 ? '' : '='.repeat(4 - (s.length % 4));
  return Buffer.from(s.replace(/-/g, '+').replace(/_/g, '/') + pad, 'base64');
}

function hmac(payload: string): Buffer {
  return createHmac('sha256', env.BETTER_AUTH_SECRET).update(payload).digest();
}

export interface UnsubPayload {
  id: number;
  slug: string;
}

export function signUnsubscribeToken(payload: UnsubPayload): string {
  const json = JSON.stringify(payload);
  const payloadEncoded = b64urlEncode(Buffer.from(json, 'utf8'));
  const sig = b64urlEncode(hmac(payloadEncoded));
  return `${payloadEncoded}.${sig}`;
}

export function verifyUnsubscribeToken(token: string): UnsubPayload | null {
  const parts = token.split('.');
  if (parts.length !== 2) return null;
  const payloadEncoded = parts[0];
  const sig = parts[1];
  if (!payloadEncoded || !sig) return null;
  const expected = hmac(payloadEncoded);
  const provided = b64urlDecode(sig);
  if (expected.length !== provided.length) return null;
  if (!timingSafeEqual(expected, provided)) return null;
  try {
    const data = JSON.parse(b64urlDecode(payloadEncoded).toString('utf8'));
    if (
      typeof data === 'object' &&
      data &&
      typeof data.id === 'number' &&
      typeof data.slug === 'string'
    ) {
      return data as UnsubPayload;
    }
  } catch {
    // fallthrough
  }
  return null;
}

/** Random URL-safe token for double-opt-in confirmation. */
export function randomConfirmToken(): string {
  return b64urlEncode(randomBytes(24));
}
