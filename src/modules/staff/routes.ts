import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { and, asc, desc, eq, ilike, inArray, max, or, sql } from 'drizzle-orm';
import { nanoid } from 'nanoid';
import { z } from 'zod';
import { auth } from '../../auth/index.js';
import { db } from '../../db/index.js';
import {
  account,
  company,
  membership,
  session,
  user,
  userSettings,
} from '../../db/schema/shared.js';
import { accessLevelOf } from '../../lib/access.js';
import { badRequest, conflict, forbidden, notFound } from '../../lib/http-errors.js';

const ACCESS_LEVELS = ['super_admin', 'admin', 'manager', 'seo', 'viewer'] as const;
type StaffAccessLevel = (typeof ACCESS_LEVELS)[number];

const ROLE_FOR_LEVEL: Record<StaffAccessLevel, string> = {
  super_admin: 'owner',
  admin: 'admin',
  manager: 'manager',
  seo: 'viewer',
  viewer: 'viewer',
};

const name = z.string().trim().min(1).max(120);
const optionalText = (len: number) =>
  z
    .string()
    .trim()
    .max(len)
    .nullable()
    .optional()
    .transform((v) => (v === '' ? null : v));

const createSchema = z.object({
  // better-auth lowercases on sign-in lookup, so a mixed-case row could never log in.
  email: z
    .string()
    .trim()
    .email()
    .max(254)
    .transform((e) => e.toLowerCase()),
  firstName: name,
  lastName: name,
  phone: optionalText(32),
  password: z.string().min(8).max(128),
  accessLevel: z.enum(ACCESS_LEVELS),
  companySlugs: z.array(z.string().min(1).max(64)).min(1).max(50),
  internalNotes: optionalText(2000),
});

const updateSchema = z.object({
  firstName: name.optional(),
  lastName: name.optional(),
  phone: optionalText(32),
  accessLevel: z.enum(ACCESS_LEVELS).optional(),
  isActive: z.boolean().optional(),
  companySlugs: z.array(z.string().min(1).max(64)).min(1).max(50).optional(),
  internalNotes: optionalText(2000),
});

const passwordSchema = z.object({ password: z.string().min(8).max(128) });

const listQuery = z.object({
  q: z.string().trim().max(120).optional(),
  status: z.enum(['active', 'inactive', 'all']).default('active'),
  accessLevel: z.enum(ACCESS_LEVELS).optional(),
});

const staffColumns = {
  id: user.id,
  name: user.name,
  firstName: user.firstName,
  lastName: user.lastName,
  email: user.email,
  phone: user.phone,
  accessLevel: user.accessLevel,
  isActive: user.isActive,
  invitedByUserId: user.invitedByUserId,
  internalNotes: user.internalNotes,
  createdAt: user.createdAt,
  updatedAt: user.updatedAt,
};

function isSuperAdmin(request: FastifyRequest): boolean {
  return accessLevelOf(request) === 'super_admin';
}

/** Brands the caller may grant or revoke: every brand for a super_admin, else their own memberships. */
async function assignableBrands(request: FastifyRequest) {
  if (isSuperAdmin(request)) {
    return db
      .select({ slug: company.slug, name: company.name })
      .from(company)
      .orderBy(asc(company.name));
  }
  return db
    .select({ slug: company.slug, name: company.name })
    .from(membership)
    .innerJoin(company, eq(company.slug, membership.companySlug))
    .where(eq(membership.userId, request.authUser!.id))
    .orderBy(asc(company.name));
}

async function loadStaff(id: string) {
  const [row] = await db
    .select(staffColumns)
    .from(user)
    .where(and(eq(user.id, id), eq(user.audience, 'admin')))
    .limit(1);
  if (!row) throw notFound('User not found');
  return row;
}

/** Only a super_admin may touch a super_admin account or hand out that level. */
function assertMayManage(request: FastifyRequest, targetLevel: string, nextLevel?: string) {
  if (isSuperAdmin(request)) return;
  if (targetLevel === 'super_admin' || nextLevel === 'super_admin') {
    throw forbidden('Only a super admin may manage super admin accounts');
  }
}

async function brandAccess(userId: string) {
  return db
    .select({
      companySlug: membership.companySlug,
      companyName: company.name,
      role: membership.role,
      acceptedAt: membership.acceptedAt,
    })
    .from(membership)
    .innerJoin(company, eq(company.slug, membership.companySlug))
    .where(eq(membership.userId, userId))
    .orderBy(asc(company.name));
}

export const staffAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireAccess('super_admin', 'admin'));

  app.get('/', async (request) => {
    const q = listQuery.parse(request.query);
    const conditions = [eq(user.audience, 'admin')];
    if (q.status !== 'all') conditions.push(eq(user.isActive, q.status === 'active'));
    if (q.accessLevel) conditions.push(eq(user.accessLevel, q.accessLevel));
    if (q.q) {
      const like = `%${q.q.replace(/[\\%_]/g, (c) => `\\${c}`)}%`;
      conditions.push(or(ilike(user.name, like), ilike(user.email, like))!);
    }

    const lastSeen = db
      .select({
        userId: session.userId,
        lastSignInAt: max(session.createdAt).as('last_sign_in_at'),
        lastActiveAt: max(session.updatedAt).as('last_active_at'),
      })
      .from(session)
      .groupBy(session.userId)
      .as('last_seen');

    const rows = await db
      .select({
        id: user.id,
        name: user.name,
        email: user.email,
        accessLevel: user.accessLevel,
        isActive: user.isActive,
        createdAt: user.createdAt,
        lastSignInAt: lastSeen.lastSignInAt,
        lastActiveAt: lastSeen.lastActiveAt,
      })
      .from(user)
      .leftJoin(lastSeen, eq(lastSeen.userId, user.id))
      .where(and(...conditions))
      .orderBy(asc(sql`lower(${user.name})`))
      .limit(500);

    const ids = rows.map((r) => r.id);
    const brands = ids.length
      ? await db
          .select({ userId: membership.userId, companySlug: membership.companySlug })
          .from(membership)
          .where(inArray(membership.userId, ids))
      : [];
    const brandsByUser = new Map<string, string[]>();
    for (const b of brands) {
      const list = brandsByUser.get(b.userId) ?? [];
      list.push(b.companySlug);
      brandsByUser.set(b.userId, list);
    }

    const [counts] = await db
      .select({
        active: sql<number>`count(*) filter (where ${user.isActive})::int`,
        inactive: sql<number>`count(*) filter (where not ${user.isActive})::int`,
      })
      .from(user)
      .where(eq(user.audience, 'admin'));

    return {
      users: rows.map((r) => ({ ...r, companySlugs: (brandsByUser.get(r.id) ?? []).sort() })),
      counts: counts ?? { active: 0, inactive: 0 },
    };
  });

  app.get('/brands', async (request) => ({ brands: await assignableBrands(request) }));

  app.get('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const row = await loadStaff(id);
    const [memberships, sessions] = await Promise.all([
      brandAccess(id),
      db
        .select({
          id: session.id,
          createdAt: session.createdAt,
          updatedAt: session.updatedAt,
          expiresAt: session.expiresAt,
          ipAddress: session.ipAddress,
          userAgent: session.userAgent,
        })
        .from(session)
        .where(and(eq(session.userId, id), sql`${session.expiresAt} > now()`))
        .orderBy(desc(session.updatedAt))
        .limit(20),
    ]);
    const [credential] = await db
      .select({ id: account.id })
      .from(account)
      .where(and(eq(account.userId, id), eq(account.providerId, 'credential')))
      .limit(1);
    let invitedBy: { id: string; name: string } | null = null;
    if (row.invitedByUserId) {
      const [inviter] = await db
        .select({ id: user.id, name: user.name })
        .from(user)
        .where(eq(user.id, row.invitedByUserId))
        .limit(1);
      invitedBy = inviter ?? null;
    }
    return {
      user: { ...row, hasPassword: !!credential, invitedBy },
      memberships,
      sessions,
      isSelf: id === request.authUser!.id,
    };
  });

  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    assertMayManage(request, body.accessLevel);

    const allowed = new Set((await assignableBrands(request)).map((b) => b.slug));
    const slugs = [...new Set(body.companySlugs)];
    if (slugs.some((s) => !allowed.has(s)))
      throw forbidden('You cannot grant access to that brand');

    const [existing] = await db
      .select({ id: user.id })
      .from(user)
      .where(eq(user.email, body.email))
      .limit(1);
    if (existing) throw conflict('A user with this email already exists');

    const id = nanoid();
    const hashed = await auth.$context.then((ctx) => ctx.password.hash(body.password));
    const role = ROLE_FOR_LEVEL[body.accessLevel];
    await db.transaction(async (tx) => {
      await tx.insert(user).values({
        id,
        name: `${body.firstName} ${body.lastName}`,
        email: body.email,
        firstName: body.firstName,
        lastName: body.lastName,
        phone: body.phone ?? null,
        audience: 'admin',
        accessLevel: body.accessLevel,
        emailVerified: true,
        isActive: true,
        invitedByUserId: request.authUser!.id,
        internalNotes: body.internalNotes ?? null,
      });
      await tx.insert(account).values({
        id: nanoid(),
        userId: id,
        providerId: 'credential',
        accountId: id,
        password: hashed,
      });
      await tx.insert(userSettings).values({ userId: id }).onConflictDoNothing();
      await tx.insert(membership).values(
        slugs.map((slug) => ({
          userId: id,
          companySlug: slug,
          role,
          invitedByUserId: request.authUser!.id,
          invitedAt: new Date(),
          acceptedAt: new Date(),
        })),
      );
    });

    reply.code(201);
    return { user: await loadStaff(id) };
  });

  app.patch('/:id', async (request) => {
    const { id } = request.params as { id: string };
    const body = updateSchema.parse(request.body);
    const target = await loadStaff(id);
    assertMayManage(request, target.accessLevel, body.accessLevel);

    const nextLevel = (body.accessLevel ?? target.accessLevel) as StaffAccessLevel;
    const role = ROLE_FOR_LEVEL[nextLevel] ?? 'viewer';
    const allowed = new Set((await assignableBrands(request)).map((b) => b.slug));
    const current = (await brandAccess(id)).map((m) => m.companySlug);
    let toAdd: string[] = [];
    let toRemove: string[] = [];
    if (body.companySlugs) {
      const wanted = new Set(body.companySlugs);
      toAdd = [...wanted].filter((s) => !current.includes(s));
      toRemove = current.filter((s) => !wanted.has(s));
      if ([...toAdd, ...toRemove].some((s) => !allowed.has(s))) {
        throw forbidden('You cannot change access to that brand');
      }
      if (current.length - toRemove.length + toAdd.length === 0) {
        throw badRequest('A user needs at least one brand');
      }
    }

    // Self-lockout guard: nobody demotes, disables or un-brands their own account.
    if (
      id === request.authUser!.id &&
      ((body.accessLevel !== undefined && body.accessLevel !== target.accessLevel) ||
        (body.isActive !== undefined && body.isActive !== target.isActive) ||
        toAdd.length > 0 ||
        toRemove.length > 0)
    ) {
      throw badRequest('You cannot change your own access');
    }

    const patch: Partial<typeof user.$inferInsert> = { updatedAt: new Date() };
    if (body.firstName !== undefined) patch.firstName = body.firstName;
    if (body.lastName !== undefined) patch.lastName = body.lastName;
    if (body.firstName !== undefined || body.lastName !== undefined) {
      patch.name =
        `${body.firstName ?? target.firstName ?? ''} ${body.lastName ?? target.lastName ?? ''}`.trim();
    }
    if (body.phone !== undefined) patch.phone = body.phone;
    if (body.internalNotes !== undefined) patch.internalNotes = body.internalNotes;
    if (body.accessLevel !== undefined) patch.accessLevel = body.accessLevel;
    if (body.isActive !== undefined) patch.isActive = body.isActive;

    await db.transaction(async (tx) => {
      await tx.update(user).set(patch).where(eq(user.id, id));
      if (body.accessLevel !== undefined && body.accessLevel !== target.accessLevel) {
        await tx.update(membership).set({ role }).where(eq(membership.userId, id));
      }
      if (toRemove.length) {
        await tx
          .delete(membership)
          .where(and(eq(membership.userId, id), inArray(membership.companySlug, toRemove)));
      }
      if (toAdd.length) {
        const now = new Date();
        await tx.insert(membership).values(
          toAdd.map((slug) => ({
            userId: id,
            companySlug: slug,
            role,
            invitedByUserId: request.authUser!.id,
            invitedAt: now,
            acceptedAt: now,
          })),
        );
      }
      if (body.isActive === false) await tx.delete(session).where(eq(session.userId, id));
    });

    return { user: await loadStaff(id) };
  });

  app.post('/:id/password', async (request) => {
    const { id } = request.params as { id: string };
    const body = passwordSchema.parse(request.body);
    const target = await loadStaff(id);
    assertMayManage(request, target.accessLevel);
    if (id === request.authUser!.id)
      throw badRequest('Use your profile to change your own password');

    const hashed = await auth.$context.then((ctx) => ctx.password.hash(body.password));
    await db.transaction(async (tx) => {
      const updated = await tx
        .update(account)
        .set({ password: hashed, updatedAt: new Date() })
        .where(and(eq(account.userId, id), eq(account.providerId, 'credential')))
        .returning({ id: account.id });
      if (updated.length === 0) {
        await tx.insert(account).values({
          id: nanoid(),
          userId: id,
          providerId: 'credential',
          accountId: id,
          password: hashed,
        });
      }
      await tx.delete(session).where(eq(session.userId, id));
    });
    return { ok: true };
  });

  app.post('/:id/reset-email', async (request) => {
    const { id } = request.params as { id: string };
    const target = await loadStaff(id);
    assertMayManage(request, target.accessLevel);
    if (!target.isActive) throw badRequest('User is deactivated');
    await auth.api.requestPasswordReset({ body: { email: target.email } });
    return { ok: true };
  });

  app.post('/:id/sign-out', async (request) => {
    const { id } = request.params as { id: string };
    const target = await loadStaff(id);
    assertMayManage(request, target.accessLevel);
    if (id === request.authUser!.id) throw badRequest('Use the account menu to sign yourself out');
    const removed = await db
      .delete(session)
      .where(eq(session.userId, id))
      .returning({ id: session.id });
    return { ok: true, revoked: removed.length };
  });
};
