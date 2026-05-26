import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { s3Configured, signDownload, signUpload } from '../../lib/s3.js';

const MAX_BYTES = 10 * 1024 * 1024; // 10 MB
const ALLOWED_TYPES = new Set([
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

const signSchema = z.object({
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1).max(80),
  size: z.number().int().positive().max(MAX_BYTES),
});

/**
 * Storefront: anonymous endpoint that returns a presigned PUT URL so the
 * visitor's browser can upload directly to S3 (no proxying through us).
 * The resulting key is later included in the inquiry submission.
 */
export const uploadsPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  app.post(
    '/sign',
    {
      config: {
        // A typical inquiry attaches 1–3 photos. Anonymous + S3 cost means we
        // keep this tight; 4/min/IP covers normal use and blocks scripted abuse.
        rateLimit: { max: 4, timeWindow: '1 minute' },
      },
    },
    async (request, reply) => {
      if (!s3Configured) {
        reply.code(503).send({ error: 'Uploads are not configured on this server' });
        return;
      }
      const body = signSchema.parse(request.body);
      if (!ALLOWED_TYPES.has(body.contentType)) {
        reply.code(415).send({
          error: `Unsupported file type "${body.contentType}". Allowed: ${[...ALLOWED_TYPES].join(', ')}`,
        });
        return;
      }
      const { uploadUrl, key, expiresIn } = await signUpload({
        keyPrefix: request.company!.keyPrefix,
        filename: body.filename,
        contentType: body.contentType,
        sizeBytes: body.size,
      });
      reply.code(201).send({ uploadUrl, key, expiresIn });
    },
  );
};

const downloadQuerySchema = z.object({
  key: z.string().min(1).max(500),
});

/**
 * Admin: session-gated. Returns a short-lived presigned GET URL so the
 * dashboard can render the uploaded image without making the bucket public.
 */
export const uploadsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);

  // Mirror of the storefront /sign endpoint but session-gated — used by the
  // admin chat composer (and any future admin upload UI). Same size + type
  // guards because the underlying S3 layout is shared.
  app.post(
    '/sign-upload',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
    },
    async (request, reply) => {
      if (!s3Configured) {
        reply.code(503).send({ error: 'Uploads are not configured on this server' });
        return;
      }
      const body = signSchema.parse(request.body);
      // Chat attachments aren't limited to images, but we restrict to a
      // documented allowlist (images, PDFs, common office files, plain text).
      // Anything else must be added here explicitly — safer than a denylist.
      const ADMIN_ALLOWED_TYPES = new Set([
        'image/jpeg',
        'image/png',
        'image/webp',
        'image/heic',
        'image/heif',
        'image/gif',
        'application/pdf',
        'application/msword',
        'application/vnd.openxmlformats-officedocument.wordprocessingml.document',
        'application/vnd.ms-excel',
        'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet',
        'text/plain',
        'text/csv',
      ]);
      if (!ADMIN_ALLOWED_TYPES.has(body.contentType)) {
        reply.code(415).send({ error: `Disallowed file type "${body.contentType}"` });
        return;
      }
      const { uploadUrl, key, expiresIn } = await signUpload({
        keyPrefix: request.company!.keyPrefix,
        filename: body.filename,
        contentType: body.contentType,
        sizeBytes: body.size,
      });
      reply.code(201).send({ uploadUrl, key, expiresIn });
    },
  );

  app.get('/sign-download', async (request, reply) => {
    if (!s3Configured) {
      reply.code(503).send({ error: 'Uploads are not configured on this server' });
      return;
    }
    const { key } = downloadQuerySchema.parse(request.query);
    try {
      // Keys live under one folder per company. `signDownload` enforces that
      // the requested key actually belongs to `request.company.slug`, so a
      // user can't sign URLs for another tenant's files even if they
      // fabricate a key string.
      const { downloadUrl, expiresIn } = await signDownload({
        keyPrefix: request.company!.keyPrefix,
        key,
      });
      reply.send({ downloadUrl, expiresIn });
    } catch (err) {
      const message = err instanceof Error ? err.message : 'Cannot sign download';
      reply.code(403).send({ error: message });
    }
  });
};
