import {
  S3Client,
  PutObjectCommand,
  GetObjectCommand,
  DeleteObjectCommand,
} from '@aws-sdk/client-s3';
import { getSignedUrl } from '@aws-sdk/s3-request-presigner';
import { nanoid } from 'nanoid';
import { env } from '../config/env.js';

const credentialsConfigured = !!(env.AWS_ACCESS_KEY_ID && env.AWS_SECRET_ACCESS_KEY);

export const s3Configured = !!(credentialsConfigured && env.S3_BUCKET);

const client = new S3Client({
  region: env.AWS_REGION,
  endpoint: env.S3_ENDPOINT,
  forcePathStyle: !!env.S3_ENDPOINT,
  requestChecksumCalculation: 'WHEN_REQUIRED',
  responseChecksumValidation: 'WHEN_REQUIRED',
  credentials: credentialsConfigured
    ? {
        accessKeyId: env.AWS_ACCESS_KEY_ID!,
        secretAccessKey: env.AWS_SECRET_ACCESS_KEY!,
      }
    : undefined,
});

function getBucket(): string {
  if (!env.S3_BUCKET) {
    throw new Error('S3_BUCKET is not configured.');
  }
  return env.S3_BUCKET;
}

export type UploadFolder = 'inquiries' | 'receipts';

function buildKey(keyPrefix: string, originalName: string, folder: UploadFolder): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const safeName =
    originalName
      .toLowerCase()
      .replace(/[^a-z0-9.\-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'file';
  return `${keyPrefix}/${folder}/${year}/${month}/${nanoid(12)}-${safeName}`;
}

const UPLOAD_EXPIRY_SECONDS = 60 * 5;
const DOWNLOAD_EXPIRY_SECONDS = 60 * 10;

// Served publicly (bucket policy / CDN) with stable, non-expiring URLs; blog images only.
const PUBLIC_PREFIX = 'public';

function buildPublicKey(keyPrefix: string, originalName: string): string {
  const now = new Date();
  const year = now.getUTCFullYear();
  const month = String(now.getUTCMonth() + 1).padStart(2, '0');
  const safeName =
    originalName
      .toLowerCase()
      .replace(/[^a-z0-9.\-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'image';
  return `${PUBLIC_PREFIX}/${keyPrefix}/blog/${year}/${month}/${nanoid(12)}-${safeName}`;
}

export function publicAssetUrl(key: string): string {
  if (env.S3_PUBLIC_BASE_URL) {
    return `${env.S3_PUBLIC_BASE_URL.replace(/\/$/, '')}/${key}`;
  }
  if (env.S3_ENDPOINT) {
    return `${env.S3_ENDPOINT.replace(/\/$/, '')}/${getBucket()}/${key}`;
  }
  return `https://${getBucket()}.s3.${env.AWS_REGION}.amazonaws.com/${key}`;
}

/** Presigned PUT for a publicly-readable image; the caller stores publicAssetUrl(key). */
export async function signPublicUpload(opts: {
  keyPrefix: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
}): Promise<{ uploadUrl: string; key: string; publicUrl: string; expiresIn: number }> {
  const bucket = getBucket();
  const key = buildPublicKey(opts.keyPrefix, opts.filename);
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: opts.contentType,
    ContentLength: opts.sizeBytes,
  });
  const uploadUrl = await getSignedUrl(client, cmd, {
    expiresIn: UPLOAD_EXPIRY_SECONDS,
    signableHeaders: new Set(['content-length', 'content-type']),
  });
  return { uploadUrl, key, publicUrl: publicAssetUrl(key), expiresIn: UPLOAD_EXPIRY_SECONDS };
}

export async function signUpload(opts: {
  keyPrefix: string;
  filename: string;
  contentType: string;
  sizeBytes: number;
  folder?: UploadFolder;
}): Promise<{ uploadUrl: string; key: string; expiresIn: number }> {
  const bucket = getBucket();
  const key = buildKey(opts.keyPrefix, opts.filename, opts.folder ?? 'inquiries');
  const cmd = new PutObjectCommand({
    Bucket: bucket,
    Key: key,
    ContentType: opts.contentType,
    ContentLength: opts.sizeBytes,
  });
  const uploadUrl = await getSignedUrl(client, cmd, {
    expiresIn: UPLOAD_EXPIRY_SECONDS,
    signableHeaders: new Set(['content-length', 'content-type']),
  });
  return { uploadUrl, key, expiresIn: UPLOAD_EXPIRY_SECONDS };
}

/** `<keyPrefix>/partners/<partnerId>/<area>/` — ownership of a partner file is its key prefix. */
export function partnerKeyPrefix(
  keyPrefix: string,
  partnerId: number,
  area: 'documents' | 'photos' | 'chat',
): string {
  return `${keyPrefix}/partners/${partnerId}/${area}/`;
}

export async function signPartnerUpload(opts: {
  keyPrefix: string;
  partnerId: number;
  area: 'documents' | 'photos' | 'chat';
  filename: string;
  contentType: string;
  sizeBytes: number;
}): Promise<{ uploadUrl: string; key: string; expiresIn: number }> {
  const safeName =
    opts.filename
      .toLowerCase()
      .replace(/[^a-z0-9.\-_]+/g, '-')
      .replace(/^-+|-+$/g, '')
      .slice(0, 80) || 'file';
  const key = `${partnerKeyPrefix(opts.keyPrefix, opts.partnerId, opts.area)}${nanoid(12)}-${safeName}`;
  const cmd = new PutObjectCommand({
    Bucket: getBucket(),
    Key: key,
    ContentType: opts.contentType,
    ContentLength: opts.sizeBytes,
  });
  const uploadUrl = await getSignedUrl(client, cmd, {
    expiresIn: UPLOAD_EXPIRY_SECONDS,
    signableHeaders: new Set(['content-length', 'content-type']),
  });
  return { uploadUrl, key, expiresIn: UPLOAD_EXPIRY_SECONDS };
}

export async function putExportObject(opts: {
  keyPrefix: string;
  filenameBase: string;
  contentType: string;
  body: Buffer | string;
  downloadFilename?: string;
}): Promise<{ key: string; sizeBytes: number }> {
  const bucket = getBucket();
  const now = new Date();
  const date = now.toISOString().slice(0, 10);
  const safe =
    opts.filenameBase
      .toLowerCase()
      .replace(/[^a-z0-9.\-_]+/g, '-')
      .slice(0, 60) || 'export';
  const ext = opts.contentType === 'text/csv' ? 'csv' : 'bin';
  const key = `${opts.keyPrefix}/exports/${safe}-${date}-${nanoid(8)}.${ext}`;
  const body = typeof opts.body === 'string' ? Buffer.from(opts.body, 'utf8') : opts.body;
  await client.send(
    new PutObjectCommand({
      Bucket: bucket,
      Key: key,
      Body: body,
      ContentType: opts.contentType,
      ContentDisposition: opts.downloadFilename
        ? `attachment; filename="${opts.downloadFilename}"`
        : undefined,
    }),
  );
  return { key, sizeBytes: body.length };
}

/** Removes an expired export (PII cleanup); only export keys are accepted. */
export async function deleteExportObject(key: string): Promise<void> {
  if (!key.includes('/exports/')) {
    throw new Error(`Refusing to delete non-export key "${key}"`);
  }
  await client.send(new DeleteObjectCommand({ Bucket: getBucket(), Key: key }));
}

export async function signObjectDownload(opts: {
  key: string;
  expiresIn?: number;
}): Promise<{ downloadUrl: string; expiresIn: number }> {
  const bucket = getBucket();
  const expiresIn = opts.expiresIn ?? DOWNLOAD_EXPIRY_SECONDS;
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: opts.key });
  const downloadUrl = await getSignedUrl(client, cmd, { expiresIn });
  return { downloadUrl, expiresIn };
}

export async function signDownload(opts: {
  keyPrefix: string;
  key: string;
}): Promise<{ downloadUrl: string; expiresIn: number }> {
  const bucket = getBucket();
  const expectedPrefix = `${opts.keyPrefix}/`;
  if (!opts.key.startsWith(expectedPrefix)) {
    throw new Error(`Key "${opts.key}" does not belong to this tenant.`);
  }
  const cmd = new GetObjectCommand({ Bucket: bucket, Key: opts.key });
  const downloadUrl = await getSignedUrl(client, cmd, { expiresIn: DOWNLOAD_EXPIRY_SECONDS });
  return { downloadUrl, expiresIn: DOWNLOAD_EXPIRY_SECONDS };
}

/** Reads a private, tenant-scoped object (size-capped); null on any failure so one missing photo never blocks the PDF. */
export async function getObjectBuffer(opts: {
  keyPrefix: string;
  key: string;
  maxBytes?: number;
}): Promise<{ body: Buffer; contentType: string | null } | null> {
  if (!s3Configured || !opts.key.startsWith(`${opts.keyPrefix}/`)) return null;
  try {
    const res = await client.send(new GetObjectCommand({ Bucket: getBucket(), Key: opts.key }));
    if (!res.Body) return null;
    if (res.ContentLength != null && res.ContentLength > (opts.maxBytes ?? 10 * 1024 * 1024))
      return null;
    const body = Buffer.from(await res.Body.transformToByteArray());
    return { body, contentType: res.ContentType ?? null };
  } catch {
    return null;
  }
}
