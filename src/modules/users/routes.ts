import type { FastifyPluginAsync } from 'fastify';
import { and, asc, eq } from 'drizzle-orm';
import { z } from 'zod';
import { db } from '../../db/index.js';
import { address, company, membership, user, userSettings } from '../../db/schema/shared.js';
import { notFound, parseIntId } from '../../lib/http-errors.js';

const updateProfileSchema = z.object({
  name: z.string().min(1).max(120).optional(),
  firstName: z.string().max(120).nullable().optional(),
  lastName: z.string().max(120).nullable().optional(),
  phone: z.string().max(32).nullable().optional(),
  image: z.string().url().nullable().optional(),
  locale: z.string().min(2).max(16).optional(),
  timezone: z.string().min(1).max(64).optional(),
  dateOfBirth: z
    .string()
    .regex(/^\d{4}-\d{2}-\d{2}$/, 'dateOfBirth must be YYYY-MM-DD')
    .nullable()
    .optional(),
  gender: z.enum(['male', 'female', 'diverse', 'prefer_not_to_say']).nullable().optional(),
});

const updateSettingsSchema = z.object({
  locale: z.string().min(2).max(16).optional(),
  theme: z.enum(['system', 'light', 'dark']).optional(),
  notificationsEmail: z.boolean().optional(),
  notificationsSms: z.boolean().optional(),
  marketingOptIn: z.boolean().optional(),
});

const addressBaseSchema = z.object({
  label: z.string().max(120).nullable().optional(),
  type: z.enum(['primary', 'billing', 'service', 'shipping', 'other']).optional(),
  line1: z.string().min(1).max(200),
  line2: z.string().max(200).nullable().optional(),
  city: z.string().min(1).max(120),
  region: z.string().max(120).nullable().optional(),
  postalCode: z.string().min(1).max(20),
  country: z.string().length(2).optional(),
  isDefault: z.boolean().optional(),
});

const updateAddressSchema = addressBaseSchema.partial();

const usersRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAuth);

  app.get('/me', async (request) => {
    const id = request.authUser!.id;
    const [row] = await db.select().from(user).where(eq(user.id, id)).limit(1);
    if (!row) throw notFound('User not found');
    const { internalNotes: _internal, ...safe } = row;
    return { user: safe };
  });

  app.patch('/me', async (request) => {
    const id = request.authUser!.id;
    const body = updateProfileSchema.parse(request.body);
    const patch: Record<string, unknown> = { ...body, updatedAt: new Date() };

    if (body.name === undefined && (body.firstName !== undefined || body.lastName !== undefined)) {
      const [existing] = await db.select().from(user).where(eq(user.id, id)).limit(1);
      if (existing) {
        const first = body.firstName ?? existing.firstName ?? '';
        const last = body.lastName ?? existing.lastName ?? '';
        const composed = `${first} ${last}`.trim();
        if (composed) patch.name = composed;
      }
    }

    const [updated] = await db.update(user).set(patch).where(eq(user.id, id)).returning();
    if (!updated) throw notFound('User not found');
    const { internalNotes: _internal, ...safe } = updated;
    return { user: safe };
  });

  app.get('/me/memberships', async (request) => {
    const id = request.authUser!.id;
    const rows = await db
      .select({
        companySlug: membership.companySlug,
        role: membership.role,
        companyName: company.name,
        acceptedAt: membership.acceptedAt,
      })
      .from(membership)
      .leftJoin(company, eq(company.slug, membership.companySlug))
      .where(eq(membership.userId, id))
      .orderBy(asc(company.name));
    return { memberships: rows };
  });

  app.get('/me/addresses', async (request) => {
    const id = request.authUser!.id;
    const rows = await db
      .select()
      .from(address)
      .where(eq(address.userId, id))
      .orderBy(asc(address.id));
    return { addresses: rows };
  });

  app.post('/me/addresses', async (request, reply) => {
    const id = request.authUser!.id;
    const body = addressBaseSchema.parse(request.body);

    if (body.isDefault) {
      await db
        .update(address)
        .set({ isDefault: false })
        .where(and(eq(address.userId, id), eq(address.type, body.type ?? 'primary')));
    }
    const [row] = await db
      .insert(address)
      .values({ userId: id, ...body })
      .returning();
    reply.code(201);
    return { address: row };
  });

  app.patch('/me/addresses/:id', async (request) => {
    const userId = request.authUser!.id;
    const addrId = parseIntId((request.params as { id: string }).id);
    const body = updateAddressSchema.parse(request.body);
    if (body.isDefault) {
      const [existing] = await db
        .select()
        .from(address)
        .where(and(eq(address.id, addrId), eq(address.userId, userId)))
        .limit(1);
      if (!existing) throw notFound('Address not found');
      await db
        .update(address)
        .set({ isDefault: false })
        .where(and(eq(address.userId, userId), eq(address.type, body.type ?? existing.type)));
    }
    const [row] = await db
      .update(address)
      .set({ ...body, updatedAt: new Date() })
      .where(and(eq(address.id, addrId), eq(address.userId, userId)))
      .returning();
    if (!row) throw notFound('Address not found');
    return { address: row };
  });

  app.delete('/me/addresses/:id', async (request, reply) => {
    const userId = request.authUser!.id;
    const addrId = parseIntId((request.params as { id: string }).id);
    const result = await db
      .delete(address)
      .where(and(eq(address.id, addrId), eq(address.userId, userId)))
      .returning();
    if (result.length === 0) throw notFound('Address not found');
    reply.code(204);
    return null;
  });

  app.get('/me/settings', async (request) => {
    const id = request.authUser!.id;
    const [row] = await db.select().from(userSettings).where(eq(userSettings.userId, id)).limit(1);
    if (row) return { settings: row };
    const [created] = await db.insert(userSettings).values({ userId: id }).returning();
    return { settings: created };
  });

  app.patch('/me/settings', async (request) => {
    const id = request.authUser!.id;
    const body = updateSettingsSchema.parse(request.body);
    const [updated] = await db
      .insert(userSettings)
      .values({ userId: id, ...body })
      .onConflictDoUpdate({
        target: userSettings.userId,
        set: { ...body, updatedAt: new Date() },
      })
      .returning();
    return { settings: updated };
  });
};

export default usersRoutes;
