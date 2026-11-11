import type { FastifyPluginAsync } from 'fastify';
import { and, asc, eq, sql } from 'drizzle-orm';

import { db } from '../../db/index.js';
import { brandMaterialDrafts, user } from '../../db/schema/shared.js';
import { HttpError } from '../../lib/http-errors.js';
import { deleteDraftQuerySchema, MAX_DATA_CHARS, upsertDraftSchema } from './schema.js';

// Marketing-Materialien edits, shared by all staff of a brand. Viewers read; writes manager+.

const draftColumns = {
  templatePath: brandMaterialDrafts.templatePath,
  data: brandMaterialDrafts.data,
  updatedAt: brandMaterialDrafts.updatedAt,
  updatedByName: user.name,
};

const selectDrafts = () =>
  db
    .select(draftColumns)
    .from(brandMaterialDrafts)
    .leftJoin(user, eq(brandMaterialDrafts.updatedByUserId, user.id));

export const brandMaterialsAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', app.requireWriteAccess);

  app.get('/', async (request) => {
    const drafts = await selectDrafts()
      .where(eq(brandMaterialDrafts.companySlug, request.company!.slug))
      .orderBy(asc(brandMaterialDrafts.templatePath));
    return { drafts };
  });

  // PATCH, not PUT: the frontend request helper has no PUT.
  app.patch('/', async (request, reply) => {
    const body = upsertDraftSchema.parse(request.body);
    if (JSON.stringify(body.data).length > MAX_DATA_CHARS) {
      throw new HttpError(400, 'Draft is too large', 'TOO_LARGE');
    }
    const slug = request.company!.slug;
    const userId = request.authUser?.id ?? null;
    const now = new Date();

    // Conditional on the version the client saw. Without one, only a missing row is written:
    // overwriting a row the client never loaded would drop a colleague's work.
    const [saved] = await db
      .insert(brandMaterialDrafts)
      .values({
        companySlug: slug,
        templatePath: body.templatePath,
        data: body.data,
        updatedByUserId: userId,
      })
      .onConflictDoUpdate({
        target: [brandMaterialDrafts.companySlug, brandMaterialDrafts.templatePath],
        set: { data: body.data, updatedByUserId: userId, updatedAt: now },
        setWhere: body.expectedUpdatedAt
          ? sql`date_trunc('milliseconds', ${brandMaterialDrafts.updatedAt}) = ${body.expectedUpdatedAt}::timestamptz`
          : sql`false`,
      })
      .returning({ id: brandMaterialDrafts.id });

    const where = and(
      eq(brandMaterialDrafts.companySlug, slug),
      eq(brandMaterialDrafts.templatePath, body.templatePath),
    );
    const [draft] = await selectDrafts().where(where).limit(1);
    if (!saved) {
      reply.code(409).send({
        error: 'Draft was changed by someone else',
        code: 'STALE',
        updatedAt: draft?.updatedAt ?? null,
      });
      return;
    }
    return { draft };
  });

  // Idempotent: deleting a draft that doesn't exist is still ok.
  app.delete('/', async (request) => {
    const { templatePath } = deleteDraftQuerySchema.parse(request.query);
    await db
      .delete(brandMaterialDrafts)
      .where(
        and(
          eq(brandMaterialDrafts.companySlug, request.company!.slug),
          eq(brandMaterialDrafts.templatePath, templatePath),
        ),
      );
    return { ok: true };
  });
};

export default brandMaterialsAdminRoutes;
