import { sql, type SQL } from 'drizzle-orm';

import { isNonContactableEmail } from '../email/service.js';

import type { AnyPgColumn } from 'drizzle-orm/pg-core';

// Rows written by a data import (source `import_…`, e.g. old CLEANILO history) are history, never new work.
export const IMPORT_SOURCE_PREFIX = 'import_';

export function isImportedSource(source: string | null | undefined): boolean {
  return !!source && source.startsWith(IMPORT_SOURCE_PREFIX);
}

export function notImported(source: AnyPgColumn): SQL {
  return sql`not starts_with(coalesce(${source}, ''), ${IMPORT_SOURCE_PREFIX})`;
}

export type InquiryChannel = 'phone' | 'email' | 'web';

/** How an inquiry arrived: voice-AI phone lead, inbound e-mail, or a web form (everything else). */
export function inquiryChannelOf(source: string | null | undefined): InquiryChannel {
  const s = (source ?? '').toLowerCase();
  if (s.includes('phone')) return 'phone';
  if (s.includes('mail')) return 'email';
  return 'web';
}

export function inquiryChannelSql(source: AnyPgColumn): SQL<InquiryChannel> {
  return sql<InquiryChannel>`case when ${source} ilike '%phone%' then 'phone' when ${source} ilike '%mail%' then 'email' else 'web' end`;
}

/** Name, else phone, else a real e-mail; '' lets the client show its own placeholder. */
export function senderLabel(
  name: string | null | undefined,
  phone: string | null | undefined,
  email: string | null | undefined,
): string {
  const n = name?.trim();
  if (n) return n;
  const p = phone?.trim();
  if (p) return p;
  const e = email?.trim();
  return e && !isNonContactableEmail(e) ? e : '';
}
