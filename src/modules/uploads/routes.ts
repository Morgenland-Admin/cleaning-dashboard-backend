import type { FastifyPluginAsync } from 'fastify';
import { z } from 'zod';
import { s3Configured, signDownload, signPublicUpload, signUpload } from '../../lib/s3.js';

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

export const uploadsPublicRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.resolveCompanyPublic);

  app.post(
    '/sign',
    {
      config: {
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

export const uploadsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);

  app.post(
    '/sign-upload',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      // Viewers are read-only.
      preHandler: app.requireAccess('super_admin', 'admin', 'manager'),
    },
    async (request, reply) => {
      if (!s3Configured) {
        reply.code(503).send({ error: 'Uploads are not configured on this server' });
        return;
      }
      const body = signSchema.parse(request.body);
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

  // Presign a publicly-readable image upload (e.g. a blog featured image). Returns
  // a stable public URL the caller stores in the article's schemaJsonld.image.
  app.post(
    '/sign-public-image',
    {
      config: { rateLimit: { max: 30, timeWindow: '1 minute' } },
      preHandler: app.requireAccess('super_admin', 'admin', 'manager'),
    },
    async (request, reply) => {
      if (!s3Configured) {
        reply.code(503).send({ error: 'Uploads are not configured on this server' });
        return;
      }
      const body = signSchema.parse(request.body);
      if (!ALLOWED_TYPES.has(body.contentType)) {
        reply.code(415).send({
          error: `Unsupported image type "${body.contentType}". Allowed: ${[...ALLOWED_TYPES].join(', ')}`,
        });
        return;
      }
      const { uploadUrl, key, publicUrl, expiresIn } = await signPublicUpload({
        keyPrefix: request.company!.keyPrefix,
        filename: body.filename,
        contentType: body.contentType,
        sizeBytes: body.size,
      });
      reply.code(201).send({ uploadUrl, key, publicUrl, expiresIn });
    },
  );

  app.get('/sign-download', async (request, reply) => {
    if (!s3Configured) {
      reply.code(503).send({ error: 'Uploads are not configured on this server' });
      return;
    }
    const { key } = downloadQuerySchema.parse(request.query);
    try {
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
