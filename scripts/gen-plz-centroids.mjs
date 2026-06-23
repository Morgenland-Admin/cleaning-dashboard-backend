// Regenerates src/lib/plz-centroids.generated.ts from src/lib/data/de_plz_centroids.csv.
// Run after refreshing the dataset:  node scripts/gen-plz-centroids.mjs
//
// The build is tsc-only and does not copy non-TS assets into dist/, so the
// centroid table ships as a compiled TS module rather than a runtime-read CSV.
import { readFileSync, writeFileSync } from 'node:fs';
import { fileURLToPath } from 'node:url';
import { dirname, join } from 'node:path';

const root = join(dirname(fileURLToPath(import.meta.url)), '..');
const csvPath = join(root, 'src/lib/data/de_plz_centroids.csv');
const outPath = join(root, 'src/lib/plz-centroids.generated.ts');

const rows = readFileSync(csvPath, 'utf8').trim().split(/\r?\n/);
const header = rows.shift();
if (header.replace(/\s/g, '') !== 'plz,lat,lng') {
  throw new Error(`Unexpected CSV header: ${header}`);
}

const seen = new Set();
const lines = [];
for (const row of rows) {
  const [plz, lat, lng] = row.split(',');
  if (!/^\d{5}$/.test(plz)) throw new Error(`Bad PLZ in row: ${row}`);
  if (seen.has(plz)) throw new Error(`Duplicate PLZ: ${plz}`);
  seen.add(plz);
  const la = Number(lat);
  const ln = Number(lng);
  if (!Number.isFinite(la) || !Number.isFinite(ln)) throw new Error(`Bad coord in row: ${row}`);
  lines.push(`  "${plz}": [${la}, ${ln}],`);
}

const out = `// AUTO-GENERATED — do not edit by hand.
// Source: de_plz_centroids.csv (GeoNames/OSM-based, ~5-decimal precision).
// ${seen.size} German postal codes, one centroid per PLZ. Regenerate with
// \`node scripts/gen-plz-centroids.mjs\`; see src/lib/geo.ts for lookup + routing.
//
// Shape: PLZ (5-digit string) -> [latitude, longitude].

export const PLZ_CENTROIDS: Record<string, readonly [number, number]> = {
${lines.join('\n')}
};
`;

writeFileSync(outPath, out);
console.log(`Wrote ${seen.size} centroids to ${outPath}`);
