import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { conflict, notFound, parseIntId } from '../../lib/http-errors.js';
import { computeLoyaltyTier } from '../../lib/loyalty.js';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
  tier: z.enum(['neukunde', 'stammkunde', 'premium']).optional(),
  email: z.string().email().optional(),
});

const tagsSchema = z.array(z.string().trim().min(1).max(64)).max(50);

const updateSchema = z.object({
  email: z.string().email().max(254).optional(),
  name: z.string().max(200).nullable().optional(),
  phone: z.string().max(32).nullable().optional(),
  addressLine1: z.string().max(200).nullable().optional(),
  addressLine2: z.string().max(200).nullable().optional(),
  postalCode: z.string().max(16).nullable().optional(),
  city: z.string().max(120).nullable().optional(),
  country: z.string().length(2).nullable().optional(),
  loyaltyTier: z.enum(['neukunde', 'stammkunde', 'premium']).optional(),
  tags: tagsSchema.optional(),
  internalNotes: z.string().max(5000).nullable().optional(),
  marketingOptIn: z.boolean().optional(),
});

const createSchema = z.object({
  email: z.string().email().max(254),
  name: z.string().trim().max(200).optional(),
  phone: z.string().trim().max(32).optional(),
  addressLine1: z.string().trim().max(200).optional(),
  addressLine2: z.string().trim().max(200).optional(),
  postalCode: z.string().trim().max(16).optional(),
  city: z.string().trim().max(120).optional(),
  country: z.string().trim().length(2).optional(),
  loyaltyTier: z.enum(['neukunde', 'stammkunde', 'premium']).default('neukunde'),
  tags: tagsSchema.default([]),
  internalNotes: z.string().trim().max(5000).optional(),
  marketingOptIn: z.boolean().default(false),
});

const importSchema = z.object({
  csv: z
    .string()
    .min(8)
    .max(10 * 1024 * 1024), // 10 MB hard cap
  dryRun: z.boolean().default(false),
  marketingOptIn: z.boolean().default(false),
});

export const customersAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', app.requireAccess('super_admin', 'admin', 'manager'));

  app.get('/', async (request) => {
    const { limit, cursor, tier, email } = listQuerySchema.parse(request.query);
    const { customers } = request.company!.tables;
    const decoded = cursor ? decodeCursor(cursor) : null;
    const conds = [];
    if (tier) conds.push(eq(customers.loyaltyTier, tier));
    if (email) conds.push(eq(customers.email, email));
    if (decoded) {
      const cw = or(
        lt(customers.createdAt, sql`${decoded.createdAt}::timestamptz`),
        and(
          sql`${customers.createdAt} = ${decoded.createdAt}::timestamptz`,
          lt(customers.id, decoded.id),
        ),
      );
      if (cw) conds.push(cw);
    }
    const rows = await db
      .select()
      .from(customers)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(customers.createdAt), desc(customers.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    return { customers: page, nextCursor };
  });

  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { customers } = request.company!.tables;
    const [row] = await db
      .insert(customers)
      .values({
        email: body.email.toLowerCase(),
        name: body.name ?? null,
        phone: body.phone ?? null,
        addressLine1: body.addressLine1 ?? null,
        addressLine2: body.addressLine2 ?? null,
        postalCode: body.postalCode ?? null,
        city: body.city ?? null,
        country: body.country ?? null,
        loyaltyTier: body.loyaltyTier,
        tags: body.tags,
        internalNotes: body.internalNotes ?? null,
        marketingOptIn: body.marketingOptIn,
      })
      .onConflictDoNothing({ target: customers.email })
      .returning();
    if (!row) {
      reply.code(409).send({ error: 'A customer with this email already exists' });
      return;
    }
    reply.code(201).send({ customer: row });
  });

  app.get('/import/sample', async (_request, reply) => {
    const lines = [
      'email,first_name,last_name',
      'anna.muster@example.com,Anna,Muster',
      'thomas.beispiel@example.com,Thomas,Beispiel',
    ];
    reply.header('Content-Type', 'text/csv; charset=utf-8');
    reply.header('Content-Disposition', 'attachment; filename="customers-import-sample.csv"');
    reply.send(lines.join('\r\n') + '\r\n');
  });

  app.post('/import', { bodyLimit: 12 * 1024 * 1024 }, async (request, reply) => {
    const body = importSchema.parse(request.body);
    const { customers } = request.company!.tables;

    const { parseCsv, filterImportRows, summarise } = await import('../../lib/csv-import.js');

    let rows;
    try {
      rows = parseCsv(body.csv);
    } catch (err) {
      reply.code(400).send({
        error: err instanceof Error ? err.message : 'CSV could not be parsed',
      });
      return;
    }
    if (rows.length === 0) {
      reply.send({ summary: summarise([], 0), dryRun: body.dryRun });
      return;
    }

    const existing = await db.select({ email: customers.email }).from(customers);
    const existingEmails = new Set(existing.map((e) => e.email.toLowerCase()));

    // Customers can be any address; only invalid/duplicate/system/disposable are rejected.
    const filtered = filterImportRows(rows, { ownDomains: [], existingEmails });
    const accepted = filtered.filter((r) => !r.reject);

    let imported = 0;
    if (!body.dryRun && accepted.length > 0) {
      const BATCH = 500;
      await db.transaction(async (tx) => {
        for (let i = 0; i < accepted.length; i += BATCH) {
          const chunk = accepted.slice(i, i + BATCH);
          const inserted = await tx
            .insert(customers)
            .values(
              chunk.map((r) => ({
                email: r.email,
                name: [r.firstName, r.lastName].filter(Boolean).join(' ') || null,
                marketingOptIn: body.marketingOptIn,
              })),
            )
            .onConflictDoNothing({ target: customers.email })
            .returning({ id: customers.id });
          imported += inserted.length;
        }
      });
    }

    reply.code(body.dryRun ? 200 : 201).send({
      summary: summarise(filtered, imported),
      dryRun: body.dryRun,
    });
  });

  app.get('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { customers } = request.company!.tables;
    const [row] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
    if (!row) throw notFound('Customer not found');
    return { customer: row };
  });

  // Customer 360: profile + everything linked to this customer (by customer_id,
  // falling back to a case-insensitive email match so data shows even if a row
  // predates the backfill). Lists are capped — this is a profile, not an export.
  app.get('/:id/overview', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { customers, orders, serviceInquiries, contactMessages, newsletterSubscribers } =
      request.company!.tables;

    const [customer] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
    if (!customer) throw notFound('Customer not found');
    const email = customer.email.toLowerCase();

    const [orderRows, inquiryRows, contactRows, newsletterRow] = await Promise.all([
      db
        .select()
        .from(orders)
        .where(or(eq(orders.customerId, id), sql`lower(${orders.customerEmail}) = ${email}`))
        .orderBy(desc(orders.createdAt))
        .limit(100),
      db
        .select()
        .from(serviceInquiries)
        .where(
          or(eq(serviceInquiries.customerId, id), sql`lower(${serviceInquiries.email}) = ${email}`),
        )
        .orderBy(desc(serviceInquiries.createdAt))
        .limit(100),
      db
        .select()
        .from(contactMessages)
        .where(
          or(eq(contactMessages.customerId, id), sql`lower(${contactMessages.email}) = ${email}`),
        )
        .orderBy(desc(contactMessages.createdAt))
        .limit(100),
      db
        .select()
        .from(newsletterSubscribers)
        .where(
          or(
            eq(newsletterSubscribers.customerId, id),
            sql`lower(${newsletterSubscribers.email}) = ${email}`,
          ),
        )
        .orderBy(desc(newsletterSubscribers.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    const paidOrders = orderRows.filter((o) => o.paidAt != null);
    const newsletterStatus = newsletterRow
      ? newsletterRow.unsubscribedAt
        ? 'unsubscribed'
        : newsletterRow.confirmed
          ? 'confirmed'
          : 'pending'
      : 'none';

    const stats = {
      orders: orderRows.length,
      paidOrders: paidOrders.length,
      lifetimeSpentCents: paidOrders.reduce((sum, o) => sum + o.totalCents, 0),
      inquiries: inquiryRows.length,
      openInquiries: inquiryRows.filter((i) => i.status === 'new' || i.status === 'in_review')
        .length,
      contacts: contactRows.length,
      newsletterStatus,
    };

    return {
      customer,
      orders: orderRows,
      inquiries: inquiryRows,
      contacts: contactRows,
      newsletter: newsletterRow,
      stats,
    };
  });

  app.patch('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = updateSchema.parse(request.body);
    const { customers } = request.company!.tables;
    const patch: Record<string, unknown> = { ...body, updatedAt: new Date() };
    if (body.email !== undefined) {
      const email = body.email.trim().toLowerCase();
      const [clash] = await db
        .select({ id: customers.id })
        .from(customers)
        .where(and(sql`lower(${customers.email}) = ${email}`, ne(customers.id, id)))
        .limit(1);
      if (clash) throw conflict('A customer with this email already exists');
      patch.email = email;
    }
    const [row] = await db.update(customers).set(patch).where(eq(customers.id, id)).returning();
    if (!row) throw notFound('Customer not found');
    return { customer: row };
  });

  app.delete('/:id', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { customers } = request.company!.tables;
    await db.delete(customers).where(eq(customers.id, id));
    reply.code(204).send();
  });

  app.post('/:id/recompute-tier', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { customers } = request.company!.tables;
    const [row] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
    if (!row) throw notFound('Customer not found');
    const tier = computeLoyaltyTier(row.totalOrders, row.totalSpentCents);
    const [updated] = await db
      .update(customers)
      .set({ loyaltyTier: tier, updatedAt: new Date() })
      .where(eq(customers.id, id))
      .returning();
    return { customer: updated };
  });
};

export default customersAdminRoutes;
