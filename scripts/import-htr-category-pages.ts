/**
 * Seeds the HTR /leistungen/<slug> pages into hamburg_teppichreinigung.seo_pages from the storefront's
 * leistungen-content.ts (HTR_FRONTEND_DIR overrides the checkout).
 * node --import tsx scripts/import-htr-category-pages.ts [--dry-run] [--overwrite]  (DOTENV_CONFIG_PATH=.env.prod for prod)
 * Existing rows are skipped without --overwrite, so autopilot edits are never discarded.
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

function esc(s: string): string {
  return s
    .replace(/&/g, '&amp;')
    .replace(/</g, '&lt;')
    .replace(/>/g, '&gt;')
    .replace(/"/g, '&quot;')
    .replace(/'/g, '&#39;');
}

/** Template mini-markup (*emphasis*, [label](/href)) → seo_pages body_html. */
function paragraphToHtml(text: string): string {
  const html = esc(text)
    .replace(/\[([^\]]+)\]\(([^)]+)\)/g, (_m, label: string, href: string) => {
      // Site-relative links only; anything else drops to plain text.
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
      // *…* renders highlighted.
      title: l.seo.heading,
      metaTitle: l.metaTitle,
      metaDescription: l.metaDesc,
      // The template splits the H1 in two; the single DB field keeps the emphasis as *…*.
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
