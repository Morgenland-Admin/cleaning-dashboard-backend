/**
 * Seed the HTR main-domain category pages (/leistungen/<slug>) into
 * hamburg_teppichreinigung.seo_pages so the SEO autopilot can read and PATCH
 * them through the normal /admin/seo-pages API.
 *
 *   node --import tsx scripts/import-htr-category-pages.ts --dry-run
 *   node --import tsx scripts/import-htr-category-pages.ts
 *   node --import tsx scripts/import-htr-category-pages.ts --overwrite   # re-seed from the template
 *   DOTENV_CONFIG_PATH=.env.prod node --import tsx scripts/import-htr-category-pages.ts
 *
 * Source of truth for the seed is the storefront's own template content
 * (hamburg-teppichreinigung-frontend/src/lib/leistungen-content.ts) — after the
 * seed, the DB row wins for the patchable fields and the template file only
 * serves as the fallback when the backend is unreachable. Point the loader at a
 * different checkout with HTR_FRONTEND_DIR.
 *
 * Existing rows are left alone unless --overwrite is passed, so re-running this
 * can never silently discard autopilot edits.
 */
import { eq } from 'drizzle-orm';
import path from 'node:path';
import { pathToFileURL } from 'node:url';

import { db } from '../src/db/index.ts';
import { getTenantTables } from '../src/db/schema/tenant.ts';
import { sanitizeHtml } from '../src/lib/sanitize-html.ts';

const SCHEMA = 'hamburg_teppichreinigung';
const CATEGORY = 'leistung';
const SOURCE = 'htr-category-import';

const FRONTEND_DIR =
  process.env.HTR_FRONTEND_DIR ??
  path.resolve(import.meta.dirname, '../../../hamburg-teppichreinigung-frontend');
const CONTENT_FILE = path.join(FRONTEND_DIR, 'src/lib/leistungen-content.ts');

type Leistung = {
  slug: string;
  metaTitle: string;
  metaDesc: string;
  h1: string;
  h1Emphasis: string;
  faq: Array<{ q: string; a: string }>;
  seo?: { heading: string; intro: string; more: string[] };
};

/** Escape the five XML/HTML specials so template text can't inject markup. */
function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/**
 * The template stores paragraphs in a mini-markup: *emphasis* and
 * [label](/href). Translate that to the HTML the seo_pages body_html holds.
 */
function paragraphToHtml(text: string): string {
  const html = esc(text)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) => {
      // Only site-relative links live in this content; anything else is dropped
      // back to plain text rather than guessing a scheme.
      if (!href.startsWith('/')) return label;
      return `<a href="${href}">${label}</a>`;
    })
    .replace(/\*([^*]+)\*/g, '<strong>$1</strong>');
  return `<p>${html}</p>`;
}

function buildBodyHtml(seo: NonNullable<Leistung['seo']>): string {
  return sanitizeHtml([seo.intro, ...seo.more].map(paragraphToHtml).join('\n'));
}

async function loadLeistungen(): Promise<Record<string, Leistung>> {
  const mod = (await import(pathToFileURL(CONTENT_FILE).href)) as {
    LEISTUNGEN?: Record<string, Leistung>;
  };
  if (!mod.LEISTUNGEN) throw new Error(`LEISTUNGEN export not found in ${CONTENT_FILE}`);
  return mod.LEISTUNGEN;
}

async function main(): Promise<void> {
  const dryRun = process.argv.includes('--dry-run');
  const overwrite = process.argv.includes('--overwrite');
  const { seoPages } = getTenantTables(SCHEMA);
  const leistungen = await loadLeistungen();

  const rows = Object.values(leistungen).map((l) => {
    if (!l.seo) throw new Error(`"${l.slug}" has no seo block — nothing to seed as body_html`);
    return {
      type: 'service' as const,
      path: `leistungen/${l.slug}`,
      category: CATEGORY,
      city: 'Hamburg',
      region: 'Hamburg',
      // Heading of the SEO text section; *…* is rendered highlighted.
      title: l.seo.heading,
      metaTitle: l.metaTitle,
      metaDescription: l.metaDesc,
      // The template splits the H1 into a plain and an emphasised half; the
      // single DB field keeps the emphasis as *…*.
      h1: `${l.h1} *${l.h1Emphasis}*`.trim(),
      bodyHtml: buildBodyHtml(l.seo),
      faq: l.faq.map((f) => ({ question: f.q, answer: f.a })),
      status: 'live' as const,
      source: SOURCE,
    };
  });

  console.log(`\nHTR category pages → ${SCHEMA}.seo_pages${dryRun ? '  (DRY RUN)' : ''}\n`);
  let inserted = 0;
  let updated = 0;
  let skipped = 0;

  for (const row of rows) {
    const [existing] = await db
      .select({ id: seoPages.id, status: seoPages.status, source: seoPages.source })
      .from(seoPages)
      .where(eq(seoPages.path, row.path))
      .limit(1);

    if (existing && !overwrite) {
      skipped += 1;
      console.log(`  skip    ${row.path}  (id ${existing.id}, status ${existing.status})`);
      continue;
    }
    if (dryRun) {
      console.log(
        `  ${existing ? 'update ' : 'insert '} ${row.path}  h1="${row.h1}"  faq=${row.faq.length}  body=${row.bodyHtml.length}b`,
      );
      if (existing) updated += 1;
      else inserted += 1;
      continue;
    }
    if (existing) {
      await db
        .update(seoPages)
        .set({ ...row, updatedAt: new Date() })
        .where(eq(seoPages.id, existing.id));
      updated += 1;
      console.log(`  update  ${row.path}  (id ${existing.id})`);
    } else {
      const [created] = await db.insert(seoPages).values(row).returning({ id: seoPages.id });
      inserted += 1;
      console.log(`  insert  ${row.path}  (id ${created!.id})`);
    }
  }

  console.log(
    `\n  ${rows.length} pages — inserted ${inserted}, updated ${updated}, skipped ${skipped}\n`,
  );
  if (skipped > 0 && !overwrite) {
    console.log('  (pass --overwrite to reset existing rows to the template content)\n');
  }
}

main()
  .then(() => process.exit(0))
  .catch((err) => {
    console.error(err);
    process.exit(1);
  });
