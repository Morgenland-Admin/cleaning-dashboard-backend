/**
 * Imports the legacy CLEANILO blog (Strapi `contents`) into cleanilo.seo_pages as live type=blog rows.
 * node --import tsx scripts/import-cleanilo-blog.ts [--dry-run] [--source <contents.json>]  (DOTENV_CONFIG_PATH=.env.prod for prod)
 * Writes directly (no API, so no storefront revalidation or n8n). Insert-or-skip by path. Images are copied to the
 * public S3 prefix under deterministic keys, so a re-run never duplicates them. Slugs use the storefront's own
 * normalizeLegacyBlogSlug (CLEANILO_FRONTEND_DIR overrides the checkout) and must match docs/redirect-map.csv.
 */
import { HeadObjectCommand, PutObjectCommand, S3Client } from '@aws-sdk/client-s3';
import { eq, inArray } from 'drizzle-orm';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import sanitize from 'sanitize-html';
import { z } from 'zod';

import { env } from '../src/config/env.ts';
import { db } from '../src/db/index.ts';
import { company } from '../src/db/schema/shared.ts';
import { getTenantTables } from '../src/db/schema/tenant.ts';
import { publicAssetUrl, s3Configured } from '../src/lib/s3.ts';
import { sanitizeHtml } from '../src/lib/sanitize-html.ts';
import { missingForPublish } from '../src/modules/seo/blog.ts';

const COMPANY_SLUG = 'cleanilo';
const SOURCE = 'cleanilo-strapi-import';
const STRAPI_URL =
  'https://cleanilo-backend.dubinu.com/api/contents?populate=*&pagination[pageSize]=100';
const IMAGE_TYPES = new Set(['image/jpeg', 'image/png', 'image/webp', 'image/gif']);
const MAX_IMAGE_BYTES = 15 * 1024 * 1024;

const FRONTEND_DIR =
  process.env.CLEANILO_FRONTEND_DIR ??
  path.resolve(import.meta.dirname, '../../../cleanilo-frontend');

type LegacyUrls = {
  normalizeLegacyBlogSlug: (raw: string) => string;
  normalizePath: (pathname: string) => string;
  resolveLegacyPath: (path: string) => string | null;
};

const media = z
  .object({
    data: z
      .object({ attributes: z.object({ url: z.string().url(), mime: z.string().nullish() }) })
      .nullable(),
  })
  .nullish();

const strapiResponse = z.object({
  data: z.array(
    z.object({
      id: z.number(),
      attributes: z.object({
        title: z.string(),
        seo_url: z.string(),
        seo_text: z.string().nullish(),
        body: z.string(),
        category: z.string().nullish(),
        writer: z.string().nullish(),
        display_date: z.string().nullish(),
        createdAt: z.string(),
        updatedAt: z.string(),
        image: media,
      }),
    }),
  ),
  meta: z.object({ pagination: z.object({ total: z.number() }) }),
});

type StrapiPost = z.infer<typeof strapiResponse>['data'][number];

type PlannedImage = { sourceUrl: string; key: string; publicUrl: string };

type PlannedPost = {
  strapiId: number;
  slug: string;
  row: {
    type: 'blog';
    path: string;
    category: string | null;
    title: string;
    h1: string;
    metaDescription: string | null;
    bodyHtml: string;
    schemaJsonld: Record<string, unknown>;
    status: 'live';
    source: string;
    createdAt: Date;
    updatedAt: Date;
  };
  images: PlannedImage[];
};

type LinkStats = { internal: number; unwrapped: number; dead: Set<string> };

function argValue(name: string): string | undefined {
  const i = process.argv.indexOf(name);
  return i === -1 ? undefined : process.argv[i + 1];
}

async function loadLegacyUrls(): Promise<LegacyUrls> {
  const file = path.join(FRONTEND_DIR, 'src/lib/legacy-urls.ts');
  const mod = (await import(pathToFileURL(file).href)) as Partial<LegacyUrls>;
  if (!mod.normalizeLegacyBlogSlug || !mod.normalizePath || !mod.resolveLegacyPath) {
    throw new Error(`legacy URL helpers not exported from ${file}`);
  }
  return mod as LegacyUrls;
}

function parseCsvLine(line: string): string[] {
  const out: string[] = [];
  let cur = '';
  let quoted = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i]!;
    if (quoted) {
      if (ch === '"' && line[i + 1] === '"') {
        cur += '"';
        i++;
      } else if (ch === '"') quoted = false;
      else cur += ch;
    } else if (ch === '"') quoted = true;
    else if (ch === ',') {
      out.push(cur);
      cur = '';
    } else cur += ch;
  }
  out.push(cur);
  return out;
}

/** Blog slugs the storefront redirects /blogs/* to, and every path the new site serves. */
function loadRedirectMap(): { expectedSlugs: Set<string>; served: Set<string> } {
  const file = path.join(FRONTEND_DIR, 'docs/redirect-map.csv');
  const lines = readFileSync(file, 'utf8').split('\n').slice(1).filter(Boolean);
  const expectedSlugs = new Set<string>();
  const served = new Set<string>();
  for (const line of lines) {
    const [legacyUrl, newUrl] = parseCsvLine(line);
    if (!legacyUrl || !newUrl) throw new Error(`bad redirect-map row: ${line}`);
    const target = new URL(newUrl).pathname;
    served.add(target);
    if (!new URL(legacyUrl).pathname.toLowerCase().startsWith('/blogs/')) continue;
    if (!target.startsWith('/blog/')) throw new Error(`blog redirect to a non-blog URL: ${line}`);
    expectedSlugs.add(target.slice('/blog/'.length));
  }
  return { expectedSlugs, served };
}

async function loadStrapiPosts(): Promise<StrapiPost[]> {
  const source = argValue('--source');
  let json: unknown;
  if (source) {
    json = JSON.parse(readFileSync(source, 'utf8'));
  } else {
    const res = await fetch(STRAPI_URL, { signal: AbortSignal.timeout(60_000) });
    if (!res.ok) throw new Error(`Strapi GET → ${res.status}`);
    json = await res.json();
  }
  const parsed = strapiResponse.parse(json);
  if (parsed.data.length !== parsed.meta.pagination.total) {
    throw new Error(
      `got ${parsed.data.length} of ${parsed.meta.pagination.total} posts — raise pageSize`,
    );
  }
  return parsed.data;
}

function imageKey(keyPrefix: string, sourceUrl: string): string {
  const base = decodeURIComponent(new URL(sourceUrl).pathname.split('/').pop() ?? '');
  const safeName =
    base
      .toLowerCase()
      .replace(/[^a-z0-9.\-_]+/g, '-')
      .replace(/^-+|-+$/g, '') || 'image';
  return `public/${keyPrefix}/blog/legacy/${safeName}`;
}

// Earliest known date: the 2022-02 Strapi re-entry batch kept the real date only in display_date,
// while later display_date bumps were edits, not first publication. Noon UTC keeps the day in any timezone.
function publishedAt(post: StrapiPost['attributes']): Date {
  const created = new Date(post.createdAt);
  const shown = post.display_date;
  if (shown && /^\d{4}-\d{2}-\d{2}$/.test(shown) && shown < post.createdAt.slice(0, 10)) {
    return new Date(`${shown}T12:00:00.000Z`);
  }
  return created;
}

function planPost(
  post: StrapiPost,
  legacy: LegacyUrls,
  keyPrefix: string,
  blogSlugs: Set<string>,
  served: Set<string>,
  stats: LinkStats,
): PlannedPost {
  const a = post.attributes;
  const slug = legacy.normalizeLegacyBlogSlug(a.seo_url);
  const images = new Map<string, PlannedImage>();
  const planImage = (sourceUrl: string): string => {
    if (sourceUrl.startsWith(publicAssetUrl(`public/${keyPrefix}/`))) return sourceUrl;
    const key = imageKey(keyPrefix, sourceUrl);
    const img = { sourceUrl, key, publicUrl: publicAssetUrl(key) };
    images.set(sourceUrl, img);
    return img.publicUrl;
  };

  const rewriteHref = (href: string): string | null => {
    const m = /^https?:\/\/(?:www\.)?cleanilo\.de(?=[/?#]|$)(.*)$/i.exec(href);
    if (!m) {
      // Leftover links to editors' local WordPress installs.
      return /^https?:\/\/[^/]+\.local(?:[/:?#]|$)/i.test(href) ? null : href;
    }
    const rest = m[1] || '/';
    const cut = rest.search(/[?#]/);
    const rawPath = cut === -1 ? rest : rest.slice(0, cut);
    const suffix = cut === -1 ? '' : rest.slice(cut);
    const normalized = legacy.normalizePath(rawPath || '/');
    let target = legacy.resolveLegacyPath(normalized) ?? normalized;
    // Some posts linked a sibling post without the /blogs/ prefix (404 on the old site too).
    if (!served.has(target) && blogSlugs.has(target.slice(1))) target = `/blog${target}`;
    if (!served.has(target)) stats.dead.add(target);
    stats.internal += 1;
    return target + suffix;
  };

  // Pass 1 rewrites URLs on the raw markup; pass 2 is the shared allowlist sanitizer.
  const rewritten = sanitize(a.body, {
    allowedTags: false,
    allowedAttributes: false,
    allowVulnerableTags: true,
    transformTags: {
      '*': (tagName, attribs) => {
        // The old site stripped every inline style on render, so the copy does too.
        const { style: _style, ...rest } = attribs;
        if (tagName === 'img' && rest.src && /^https?:\/\//i.test(rest.src)) {
          rest.src = planImage(rest.src);
        }
        if (tagName === 'a' && rest.href) {
          const href = rewriteHref(rest.href);
          if (href === null) {
            stats.unwrapped += 1;
            return { tagName: 'x-unwrap', attribs: {} };
          }
          rest.href = href;
        }
        return { tagName, attribs: rest };
      },
    },
  });
  const bodyHtml = sanitizeHtml(rewritten);

  const title = a.title.trim();
  const published = publishedAt(a);
  const modified = new Date(Math.max(new Date(a.updatedAt).getTime(), published.getTime()));
  const featured = a.image?.data?.attributes.url;
  const writer = a.writer?.trim() || 'Cleanilo';
  const metaDescription = a.seo_text?.replace(/\s+/g, ' ').trim() || null;

  const missing = missingForPublish({ title, bodyHtml });
  if (missing.length) throw new Error(`"${slug}" not publishable: missing ${missing.join(', ')}`);

  return {
    strapiId: post.id,
    slug,
    row: {
      type: 'blog',
      path: `blog/${slug}`,
      category: a.category?.trim() || null,
      title,
      h1: title,
      metaDescription,
      bodyHtml,
      schemaJsonld: {
        '@context': 'https://schema.org',
        '@type': 'BlogPosting',
        headline: title,
        datePublished: published.toISOString(),
        author: { '@type': writer === 'Cleanilo' ? 'Organization' : 'Person', name: writer },
        ...(featured ? { image: planImage(featured) } : {}),
      },
      status: 'live',
      source: SOURCE,
      createdAt: published,
      updatedAt: modified,
    },
    images: [...images.values()],
  };
}

function diffSlugs(planned: PlannedPost[], expected: Set<string>): number {
  const slugs = planned.map((p) => p.slug);
  const dupes = slugs.filter((s, i) => slugs.indexOf(s) !== i);
  const unmapped = slugs.filter((s) => !expected.has(s));
  const missing = [...expected].filter((s) => !slugs.includes(s));
  console.log(
    `\n  redirect-map.csv: ${expected.size} blog targets, ${slugs.length} posts planned` +
      ` → ${dupes.length} duplicate, ${unmapped.length} not in map, ${missing.length} map targets without a post`,
  );
  for (const s of dupes) console.log(`    DUPLICATE        ${s}`);
  for (const s of unmapped) console.log(`    NOT IN MAP       ${s}`);
  for (const s of missing) console.log(`    NO POST FOR      ${s}`);
  return dupes.length + unmapped.length + missing.length;
}

const s3 = new S3Client({
  region: env.AWS_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: !!env.S3_ENDPOINT,
  credentials:
    env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY
      ? { accessKeyId: env.AWS_ACCESS_KEY_ID, secretAccessKey: env.AWS_SECRET_ACCESS_KEY }
      : undefined,
});

async function objectExists(key: string): Promise<boolean> {
  try {
    await s3.send(new HeadObjectCommand({ Bucket: env.S3_BUCKET!, Key: key }));
    return true;
  } catch (err) {
    const status = (err as { $metadata?: { httpStatusCode?: number } }).$metadata?.httpStatusCode;
    if (status === 404) return false;
    throw err;
  }
}

async function copyImage(img: PlannedImage): Promise<boolean> {
  if (await objectExists(img.key)) return false;
  const res = await fetch(img.sourceUrl, { signal: AbortSignal.timeout(60_000) });
  if (!res.ok) throw new Error(`GET ${img.sourceUrl} → ${res.status}`);
  const contentType = (res.headers.get('content-type') ?? '').split(';')[0]!.trim().toLowerCase();
  if (!IMAGE_TYPES.has(contentType)) {
    throw new Error(`${img.sourceUrl}: unexpected content-type "${contentType}"`);
  }
  const body = Buffer.from(await res.arrayBuffer());
  if (body.length > MAX_IMAGE_BYTES) throw new Error(`${img.sourceUrl}: ${body.length} bytes`);
  await s3.send(
    new PutObjectCommand({
      Bucket: env.S3_BUCKET!,
      Key: img.key,
      Body: body,
      ContentType: contentType,
      CacheControl: 'public, max-age=31536000, immutable',
    }),
  );
  return true;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');

  const [companyRow] = await db
    .select({ schemaName: company.schemaName, keyPrefix: company.keyPrefix })
    .from(company)
    .where(eq(company.slug, COMPANY_SLUG))
    .limit(1);
  if (!companyRow?.keyPrefix)
    throw new Error(`Company "${COMPANY_SLUG}" (with key_prefix) not found.`);
  if (!dryRun && !s3Configured) throw new Error('S3 is not configured — cannot copy images.');
  const { seoPages } = getTenantTables(companyRow.schemaName);

  const legacy = await loadLegacyUrls();
  const { expectedSlugs, served } = loadRedirectMap();
  const posts = await loadStrapiPosts();
  const blogSlugs = new Set(posts.map((p) => legacy.normalizeLegacyBlogSlug(p.attributes.seo_url)));

  const stats: LinkStats = { internal: 0, unwrapped: 0, dead: new Set() };
  const planned = posts.map((p) =>
    planPost(p, legacy, companyRow.keyPrefix!, blogSlugs, served, stats),
  );

  console.log(
    `\nCLEANILO legacy blog → ${companyRow.schemaName}.seo_pages${dryRun ? '  (DRY RUN)' : ''}`,
  );
  const mismatches = diffSlugs(planned, expectedSlugs);
  if (mismatches > 0) {
    console.error(`\n  ${mismatches} slug mismatch(es) — nothing written.\n`);
    process.exitCode = 1;
    return;
  }

  const existing = new Set(
    (
      await db
        .select({ path: seoPages.path })
        .from(seoPages)
        .where(
          inArray(
            seoPages.path,
            planned.map((p) => p.row.path),
          ),
        )
    ).map((r) => r.path),
  );

  console.log('');
  const copiedKeys = new Set<string>();
  let inserted = 0;
  let skipped = 0;
  let imagesCopied = 0;
  for (const post of planned) {
    const { row } = post;
    const info = `${row.createdAt.toISOString().slice(0, 10)}  img ${post.images.length}  body ${(row.bodyHtml.length / 1024).toFixed(1)} kB`;
    if (existing.has(row.path)) {
      skipped += 1;
      console.log(`  skip    ${row.path}  (exists)`);
      continue;
    }
    if (dryRun) {
      inserted += 1;
      console.log(`  insert  ${row.path}  ${info}`);
      continue;
    }
    for (const img of post.images) {
      if (copiedKeys.has(img.key)) continue;
      if (await copyImage(img)) imagesCopied += 1;
      copiedKeys.add(img.key);
    }
    const [created] = await db
      .insert(seoPages)
      .values(row)
      .onConflictDoNothing({ target: seoPages.path })
      .returning({ id: seoPages.id });
    if (created) {
      inserted += 1;
      console.log(`  insert  ${row.path}  (id ${created.id})  ${info}`);
    } else {
      skipped += 1;
      console.log(`  skip    ${row.path}  (inserted concurrently)`);
    }
  }

  const imageCount = new Set(planned.flatMap((p) => p.images.map((i) => i.key))).size;
  console.log(
    `\n  ${planned.length} posts — ${dryRun ? 'would insert' : 'inserted'} ${inserted}, skipped ${skipped}` +
      `\n  images: ${imageCount} unique${dryRun ? '' : `, ${imagesCopied} copied`} → ${publicAssetUrl(`public/${companyRow.keyPrefix}/blog/legacy/`)}` +
      `\n  links: ${stats.internal} internal rewritten to site paths, ${stats.unwrapped} dev links unwrapped`,
  );
  if (stats.dead.size) {
    console.log(`  internal link targets not in redirect-map.csv (left as is):`);
    for (const d of [...stats.dead].sort()) console.log(`    ${d}`);
  }
  console.log('');
}

main()
  .then(() => process.exit(process.exitCode ?? 0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
