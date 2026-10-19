import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { partnerDocumentReviewedEmail } from '../../email/templates.js';
import { partnerPortalBase } from '../../lib/company-loader.js';
import { badRequest, conflict, forbidden, notFound, parseIntId } from '../../lib/http-errors.js';
import { PARTNER_DOCUMENT_KINDS } from '../../lib/partner-verification.js';
import {
  partnerKeyPrefix,
  s3Configured,
  signObjectDownload,
  signPartnerUpload,
} from '../../lib/s3.js';
import {
  brandForMail,
  loadCompanyFull,
  mailPartner,
  partnerById,
  requireOwnPartner,
} from './lib.js';

const MAX_BYTES = 15 * 1024 * 1024;
const DOCUMENT_TYPES = new Set([
  'application/pdf',
  'image/jpeg',
  'image/png',
  'image/webp',
  'image/heic',
  'image/heif',
]);

export const DOCUMENT_LABEL: Record<string, string> = {
  gewerbeanmeldung: 'Gewerbeanmeldung',
  haftpflicht: 'Betriebshaftpflichtversicherung',
  handelsregister: 'Handelsregisterauszug',
  ausweis: 'Ausweis der Inhaberin / des Inhabers',
  qualifikation: 'Qualifikationsnachweis',
  sonstiges: 'Sonstiges Dokument',
};

const kindSchema = z.enum(PARTNER_DOCUMENT_KINDS);
const isoDate = z.string().regex(/^\d{4}-\d{2}-\d{2}$/, 'YYYY-MM-DD');

const signSchema = z.object({
  kind: kindSchema,
  filename: z.string().min(1).max(200),
  contentType: z.string().min(1).max(80),
  size: z.number().int().positive().max(MAX_BYTES),
});

const attachSchema = z.object({
  kind: kindSchema,
  key: z.string().min(1).max(500),
  fileName: z.string().min(1).max(200),
  contentType: z.string().max(80),
  size: z.number().int().positive().max(MAX_BYTES),
  expiresAt: isoDate.nullable().optional(),
});

const reviewSchema = z
  .object({
    status: z.enum(['approved', 'rejected']),
    rejectionReason: z.string().trim().max(1000).optional(),
    expiresAt: isoDate.nullable().optional(),
  })
  .refine((v) => v.status === 'approved' || !!v.rejectionReason, {
    message: 'rejectionReason is required when rejecting',
  });

export const partnerDocumentsSelfRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);

  app.get('/', async (request) => {
    const partner = await requireOwnPartner(request);
    const { partnerDocuments: d } = request.company!.tables;
    const rows = await db
      .select({
        id: d.id,
        kind: d.kind,
        fileName: d.fileName,
        contentType: d.contentType,
        sizeBytes: d.sizeBytes,
        status: d.status,
        rejectionReason: d.rejectionReason,
        expiresAt: d.expiresAt,
        reviewedAt: d.reviewedAt,
        createdAt: d.createdAt,
      })
      .from(d)
      .where(eq(d.partnerId, partner.id))
      .orderBy(desc(d.createdAt));
    return { documents: rows };
  });

  app.post(
    '/sign-upload',
    { config: { rateLimit: { max: 20, timeWindow: '1 minute' } } },
    async (request, reply) => {
      if (!s3Configured) {
        reply.code(503).send({ error: 'Uploads sind derzeit nicht möglich.' });
        return;
      }
      const body = signSchema.parse(request.body);
      if (!DOCUMENT_TYPES.has(body.contentType)) {
        reply.code(415).send({ error: 'Dieser Dateityp wird nicht unterstützt.' });
        return;
      }
      const partner = await requireOwnPartner(request);
      const signed = await signPartnerUpload({
        keyPrefix: request.company!.keyPrefix,
        partnerId: partner.id,
        area: 'documents',
        filename: body.filename,
        contentType: body.contentType,
        sizeBytes: body.size,
      });
      reply.code(201).send(signed);
    },
  );

  app.post('/', async (request, reply) => {
    const body = attachSchema.parse(request.body);
    const partner = await requireOwnPartner(request);
    if (partner.status === 'suspended' || partner.status === 'rejected') {
      throw forbidden('Partnerkonto ist gesperrt');
    }
    if (
      !body.key.startsWith(partnerKeyPrefix(request.company!.keyPrefix, partner.id, 'documents'))
    ) {
      throw badRequest('Die Datei gehört nicht zu Ihrem Partnerkonto.');
    }
    const { partnerDocuments } = request.company!.tables;
    const [row] = await db
      .insert(partnerDocuments)
      .values({
        partnerId: partner.id,
        kind: body.kind,
        fileKey: body.key,
        fileName: body.fileName,
        contentType: body.contentType,
        sizeBytes: body.size,
        expiresAt: body.expiresAt ?? null,
        uploadedByUserId: request.authUser!.id,
      })
      .returning();

    try {
      const { sendPushToBrandAdmins } = await import('../../lib/push.js');
      await sendPushToBrandAdmins(request.company!.slug, {
        title: `${request.company!.name} · Neuer Partner-Nachweis`,
        body: `${partner.companyName ?? 'Partner'} · ${DOCUMENT_LABEL[body.kind] ?? body.kind}`,
        url: `/partner/${partner.id}`,
        tag: `partner-doc:${row!.id}`,
        brandSlug: request.company!.slug,
      });
    } catch (err) {
      request.log.warn({ err }, 'partner document push failed');
    }

    reply.code(201);
    return { document: { ...row, fileKey: undefined } };
  });

  app.get('/:docId/download', async (request) => {
    const docId = parseIntId((request.params as { docId: string }).docId, 'docId');
    const partner = await requireOwnPartner(request);
    const { partnerDocuments: d } = request.company!.tables;
    const [doc] = await db
      .select()
      .from(d)
      .where(and(eq(d.id, docId), eq(d.partnerId, partner.id)))
      .limit(1);
    if (!doc) throw notFound('Document not found');
    return signObjectDownload({ key: doc.fileKey });
  });

  // Approved documents stay as evidence; only pending/rejected ones can be withdrawn.
  app.delete('/:docId', async (request, reply) => {
    const docId = parseIntId((request.params as { docId: string }).docId, 'docId');
    const partner = await requireOwnPartner(request);
    const { partnerDocuments: d } = request.company!.tables;
    const [deleted] = await db
      .delete(d)
      .where(
        and(
          eq(d.id, docId),
          eq(d.partnerId, partner.id),
          inArray(d.status, ['pending', 'rejected']),
        ),
      )
      .returning({ id: d.id });
    if (!deleted)
      throw conflict('Das Dokument ist bereits geprüft und kann nicht zurückgezogen werden.');
    reply.code(204).send();
  });
};

export const partnerDocumentsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', app.requireWriteAccess);

  app.get('/:id/documents', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { partnerDocuments: d } = request.company!.tables;
    const rows = await db.select().from(d).where(eq(d.partnerId, id)).orderBy(desc(d.createdAt));
    return { documents: rows };
  });

  app.get('/:id/documents/:docId/download', async (request) => {
    const params = request.params as { id: string; docId: string };
    const id = parseIntId(params.id);
    const docId = parseIntId(params.docId, 'docId');
    const { partnerDocuments: d } = request.company!.tables;
    const [doc] = await db
      .select()
      .from(d)
      .where(and(eq(d.id, docId), eq(d.partnerId, id)))
      .limit(1);
    if (!doc) throw notFound('Document not found');
    return signObjectDownload({ key: doc.fileKey });
  });

  app.post('/:id/documents/:docId/review', async (request) => {
    const params = request.params as { id: string; docId: string };
    const id = parseIntId(params.id);
    const docId = parseIntId(params.docId, 'docId');
    const body = reviewSchema.parse(request.body);
    const tables = request.company!.tables;
    const { partnerDocuments: d } = tables;
    const now = new Date();
    const [doc] = await db
      .update(d)
      .set({
        status: body.status,
        rejectionReason: body.status === 'rejected' ? body.rejectionReason : null,
        ...(body.expiresAt !== undefined ? { expiresAt: body.expiresAt } : {}),
        reviewedByUserId: request.authUser!.id,
        reviewedAt: now,
        updatedAt: now,
      })
      .where(and(eq(d.id, docId), eq(d.partnerId, id)))
      .returning();
    if (!doc) throw notFound('Document not found');

    const partner = await partnerById(tables, id);
    const companyRow = await loadCompanyFull(request.company!.slug);
    if (partner && companyRow) {
      const base = partnerPortalBase(companyRow);
      void mailPartner({
        companyRow,
        partner,
        kind: 'partner_document',
        sentByUserId: request.authUser!.id,
        email: partnerDocumentReviewedEmail({
          brand: brandForMail(companyRow),
          partnerName: partner.companyName,
          documentLabel: DOCUMENT_LABEL[doc.kind] ?? doc.kind,
          approved: body.status === 'approved',
          reason: doc.rejectionReason,
          documentsUrl: `${base ?? ''}/dokumente`,
        }),
      });
    }
    return { document: doc };
  });
};
