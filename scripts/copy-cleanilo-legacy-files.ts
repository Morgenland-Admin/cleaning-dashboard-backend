/**
 * Copies every object of the retired CLEANILO buckets into the uploads bucket under
 * `cleanilo/legacy/<bucket>/<original key>` (server-side copy, nothing passes through this machine).
 * Writes a manifest (bucket, key, size, destKey) next to the legacy snapshot.
 *
 * Uses only the temporary key in .env.legacy-s3; the target bucket comes from S3_BUCKET in the
 * env file (DOTENV_CONFIG_PATH). Dry run by default; `--commit` copies. Re-runnable: objects that
 * already exist with the same size are skipped.
 *
 *   DOTENV_CONFIG_PATH=.env.prod node --import tsx scripts/copy-cleanilo-legacy-files.ts [--commit]
 */
import 'dotenv/config';
import { mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { pathToFileURL } from 'node:url';
import {
  CopyObjectCommand,
  HeadObjectCommand,
  ListObjectsV2Command,
  S3Client,
  type _Object,
} from '@aws-sdk/client-s3';

export const SOURCE_BUCKETS = [
  'cleanilo',
  'cleanilo-admin-bucket',
  'cleanilo-next-js-bucket',
  'assets-for-email-template-cleanilo',
];
export const LEGACY_PREFIX = 'cleanilo/legacy';
const MAX_COPY_BYTES = 5 * 1024 ** 3; // single CopyObject limit
const CONCURRENCY = 16;
const COMMIT = process.argv.includes('--commit');
const MANIFEST_DIR = path.join(os.homedir(), '.local/share/cleanilo-legacy-snapshot-2026-10-29');

export const destKeyOf = (bucket: string, key: string) => `${LEGACY_PREFIX}/${bucket}/${key}`;

function legacyKey() {
  const file = path.resolve(import.meta.dirname, '../.env.legacy-s3');
  const vals = Object.fromEntries(
    readFileSync(file, 'utf8')
      .split('\n')
      .filter((l) => /^[A-Z0-9_]+=/.test(l))
      .map((l) => {
        const i = l.indexOf('=');
        return [
          l.slice(0, i),
          l
            .slice(i + 1)
            .trim()
            .replace(/^['"]|['"]$/g, ''),
        ];
      }),
  );
  if (!vals.LEGACY_S3_ACCESS_KEY_ID || !vals.LEGACY_S3_SECRET_ACCESS_KEY) {
    throw new Error(
      'Fill LEGACY_S3_ACCESS_KEY_ID and LEGACY_S3_SECRET_ACCESS_KEY in .env.legacy-s3',
    );
  }
  return {
    region: vals.LEGACY_S3_REGION || 'eu-central-1',
    credentials: {
      accessKeyId: vals.LEGACY_S3_ACCESS_KEY_ID,
      secretAccessKey: vals.LEGACY_S3_SECRET_ACCESS_KEY,
    },
  };
}

async function listAll(s3: S3Client, bucket: string): Promise<_Object[]> {
  const out: _Object[] = [];
  let token: string | undefined;
  do {
    const r = await s3.send(new ListObjectsV2Command({ Bucket: bucket, ContinuationToken: token }));
    out.push(...(r.Contents ?? []));
    token = r.IsTruncated ? r.NextContinuationToken : undefined;
  } while (token);
  return out;
}

async function pool<T>(items: T[], n: number, fn: (item: T) => Promise<void>) {
  let i = 0;
  await Promise.all(
    Array.from({ length: n }, async () => {
      while (i < items.length) await fn(items[i++]!);
    }),
  );
}

const mb = (bytes: number) => `${(bytes / 1024 / 1024).toFixed(1)} MB`;

async function main() {
  const target = process.env.S3_BUCKET;
  if (!target) throw new Error('S3_BUCKET is not set (use DOTENV_CONFIG_PATH=.env.prod)');
  const s3 = new S3Client(legacyKey());

  const manifest: Array<{ bucket: string; key: string; size: number; destKey: string }> = [];
  for (const bucket of SOURCE_BUCKETS) {
    const objects = (await listAll(s3, bucket)).filter((o) => o.Key && !o.Key.endsWith('/'));
    const bytes = objects.reduce((sum, o) => sum + (o.Size ?? 0), 0);
    console.log(`${bucket}: ${objects.length} files, ${mb(bytes)}`);
    for (const o of objects) {
      manifest.push({ bucket, key: o.Key!, size: o.Size ?? 0, destKey: destKeyOf(bucket, o.Key!) });
    }
  }
  const total = manifest.reduce((sum, m) => sum + m.size, 0);
  console.log(`total: ${manifest.length} files, ${mb(total)} → s3://${target}/${LEGACY_PREFIX}/`);

  mkdirSync(MANIFEST_DIR, { recursive: true, mode: 0o700 });
  const manifestFile = path.join(MANIFEST_DIR, 'files-manifest.jsonl');
  writeFileSync(manifestFile, manifest.map((m) => JSON.stringify(m)).join('\n') + '\n', {
    mode: 0o600,
  });
  console.log(`manifest: ${manifestFile}`);
  if (!COMMIT) {
    console.log('Dry run only. Add --commit to copy.');
    return;
  }

  let copied = 0;
  let skipped = 0;
  const failed: string[] = [];
  await pool(manifest, CONCURRENCY, async (m) => {
    try {
      const head = await s3
        .send(new HeadObjectCommand({ Bucket: target, Key: m.destKey }))
        .catch(() => null);
      if (head && head.ContentLength === m.size) {
        skipped += 1;
        return;
      }
      if (m.size > MAX_COPY_BYTES) throw new Error('larger than 5 GB');
      await s3.send(
        new CopyObjectCommand({
          Bucket: target,
          Key: m.destKey,
          CopySource: `${m.bucket}/${m.key.split('/').map(encodeURIComponent).join('/')}`,
          MetadataDirective: 'COPY',
        }),
      );
      copied += 1;
      if ((copied + skipped) % 500 === 0) console.log(`  … ${copied + skipped}/${manifest.length}`);
    } catch (err) {
      failed.push(
        `${m.bucket}/${m.key}: ${err instanceof Error ? err.name || err.message : String(err)}`,
      );
    }
  });
  console.log(`copied ${copied}, already present ${skipped}, failed ${failed.length}`);
  for (const f of failed.slice(0, 20)) console.log(`  failed: ${f}`);
  if (failed.length) process.exitCode = 1;
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch((err) => {
    console.error(err instanceof Error ? err.message : err);
    process.exitCode = 1;
  });
}
