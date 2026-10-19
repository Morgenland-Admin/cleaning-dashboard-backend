// Blog-post helpers for seo_pages rows (type=blog). Pure, so unit-tested without a database.
import { z } from 'zod';

import type { JsonLd } from './jsonld.js';

const emptyToUndefined = (v: unknown) =>
  v === '' || v === null || (typeof v === 'string' && v.trim() === '') ? undefined : v;

const text = (max: number) => z.preprocess(emptyToUndefined, z.string().trim().max(max).optional());

const httpUrl = z.preprocess(
  emptyToUndefined,
  z
    .string()
    .trim()
    .max(2000)
    .url()
    .refine((u) => /^https?:\/\//i.test(u), 'must be an http(s) URL')
    .optional(),
);

export const blogMetaSchema = z.object({
  excerpt: text(500),
  noindex: z.boolean().optional(),
  canonicalUrl: httpUrl,
  ogTitle: text(300),
  ogDescription: text(500),
  ogImage: httpUrl,
  focusKeyphrase: text(120),
  imageAlt: text(300),
  imageCaption: text(300),
});

export type BlogMeta = z.infer<typeof blogMetaSchema>;

/** Drops empty values so the stored object only carries what the author actually set. */
export function normalizeMeta(meta: BlogMeta): BlogMeta {
  const out: Record<string, unknown> = {};
  for (const [key, value] of Object.entries(meta)) {
    if (value === undefined || value === false || value === '') continue;
    out[key] = value;
  }
  return out;
}

// The focus keyphrase is editorial guidance only; it never reaches the public site.
export function publicMeta(meta: unknown): Record<string, unknown> {
  if (!meta || typeof meta !== 'object' || Array.isArray(meta)) return {};
  const { focusKeyphrase: _omit, ...rest } = meta as Record<string, unknown>;
  return rest;
}

export function htmlText(html: string | null | undefined): string {
  return (html ?? '')
    .replace(/<[^>]*>/g, ' ')
    .replace(/&nbsp;/gi, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

export type PublishRequirement = 'title' | 'body';

/** What the server itself requires before a blog post may go public (the featured image is a dashboard rule). */
export function missingForPublish(row: {
  title: string | null | undefined;
  bodyHtml: string | null | undefined;
}): PublishRequirement[] {
  const missing: PublishRequirement[] = [];
  if (!row.title?.trim()) missing.push('title');
  if (!htmlText(row.bodyHtml)) missing.push('body');
  return missing;
}

const MAX_PATH = 300;

/** First free "<path>-kopie", "<path>-kopie-2", … not in `taken`. */
export function copyPath(path: string, taken: ReadonlySet<string>): string {
  const base = `${path.replace(/-kopie(?:-\d+)?$/, '')}-kopie`.slice(0, MAX_PATH - 4);
  if (!taken.has(base)) return base;
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

/** First free "<path>-2", "<path>-3", … for a taken slug. */
export function suggestPath(path: string, taken: ReadonlySet<string>): string {
  const base = path.slice(0, MAX_PATH - 4);
  for (let n = 2; ; n++) {
    const candidate = `${base}-${n}`;
    if (!taken.has(candidate)) return candidate;
  }
}

// A copy is a new, unpublished article: it must not inherit the original's publication dates.
export function withoutPublishDates(schema: JsonLd | null): JsonLd | null {
  if (!schema) return null;
  const strip = (node: unknown) => {
    if (!node || typeof node !== 'object' || Array.isArray(node)) return node;
    const { datePublished: _p, dateModified: _m, ...rest } = node as Record<string, unknown>;
    return rest;
  };
  return Array.isArray(schema) ? schema.map(strip) : (strip(schema) as JsonLd);
}

export function escapeLike(q: string): string {
  return q.replace(/[\\%_]/g, (ch) => `\\${ch}`);
}

export function likeTerm(q: string): string {
  return `%${escapeLike(q)}%`;
}
