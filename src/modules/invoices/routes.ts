import type { FastifyPluginAsync } from 'fastify';
import { and, desc, eq, inArray, lt, lte, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { db } from '../../db/index.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { notFound, parseIntId } from '../../lib/http-errors.js';

const lineItemSchema = z.object({
  label: z.string().min(1).max(200),
  quantity: z.number().min(0).max(100000),
  unitPriceCents: z.number().int().min(0).max(100_000_000),
});

const createSchema = z.object({
  orderId: z.number().int().positive().optional(),
  partnerId: z.number().int().positive().optional(),
  customerType: z.enum(['b2c', 'b2b']).default('b2c'),
  recipientName: z.string().min(1).max(200),
  recipientEmail: z.string().email().optional(),
  lineItems: z.array(lineItemSchema).min(1).max(100),
  taxCents: z.number().int().min(0).max(100_000_000).default(0),
  paymentTermsDays: z.number().int().min(0).max(120).default(14),
  notes: z.string().max(2000).optional(),
});

const updateSchema = z.object({
  status: z.enum(['draft', 'sent', 'paid', 'overdue', 'void']).optional(),
  odooInvoiceId: z.string().max(255).nullable().optional(),
  notes: z.string().max(2000).nullable().optional(),
  recipientEmail: z.string().email().nullable().optional(),
});

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
  status: z.enum(['draft', 'sent', 'paid', 'overdue', 'void']).optional(),
  customerType: z.enum(['b2c', 'b2b']).optional(),
  overdue: z.coerce.boolean().optional(),
});

function invoiceNumber(id: number): string {
  const year = new Date().getUTCFullYear();
  return `INV-${year}-${String(id).padStart(6, '0')}`;
}

export const invoicesAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  app.addHook('preHandler', app.requireAccess('super_admin', 'admin', 'manager'));

  app.get('/', async (request) => {
    const { limit, cursor, status, customerType, overdue } = listQuerySchema.parse(request.query);
    const { invoices } = request.company!.tables;
    const decoded = cursor ? decodeCursor(cursor) : null;
    const conds = [];
    if (status) conds.push(eq(invoices.status, status));
    if (customerType) conds.push(eq(invoices.customerType, customerType));
    if (overdue) {
      conds.push(inArray(invoices.status, ['sent', 'overdue']));
      conds.push(lte(invoices.dueAt, sql`now()`));
    }
    if (decoded) {
      const cw = or(
        lt(invoices.createdAt, sql`${decoded.createdAt}::timestamptz`),
        and(
          sql`${invoices.createdAt} = ${decoded.createdAt}::timestamptz`,
          lt(invoices.id, decoded.id),
        ),
      );
      if (cw) conds.push(cw);
    }
    const rows = await db
      .select()
      .from(invoices)
      .where(conds.length ? and(...conds) : undefined)
      .orderBy(desc(invoices.createdAt), desc(invoices.id))
      .limit(limit + 1);
    const hasMore = rows.length > limit;
    const page = hasMore ? rows.slice(0, limit) : rows;
    const last = page[page.length - 1];
    const nextCursor =
      hasMore && last
        ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id })
        : null;
    return { invoices: page, nextCursor };
  });

  app.get('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices } = request.company!.tables;
    const [row] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!row) throw notFound('Invoice not found');
    return { invoice: row };
  });

  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { invoices } = request.company!.tables;
    const subtotalCents = body.lineItems.reduce(
      (a, l) => a + Math.round(l.quantity * l.unitPriceCents),
      0,
    );
    const totalCents = subtotalCents + body.taxCents;
    const invoice = await db.transaction(async (tx) => {
      const [row] = await tx
        .insert(invoices)
        .values({
          orderId: body.orderId,
          partnerId: body.partnerId,
          customerType: body.customerType,
          recipientName: body.recipientName,
          recipientEmail: body.recipientEmail,
          lineItems: body.lineItems,
          subtotalCents,
          taxCents: body.taxCents,
          totalCents,
          paymentTermsDays: body.paymentTermsDays,
          notes: body.notes,
          status: 'draft',
        })
        .returning();
      const [withNumber] = await tx
        .update(invoices)
        .set({ number: invoiceNumber(row!.id) })
        .where(eq(invoices.id, row!.id))
        .returning();
      return withNumber!;
    });
    reply.code(201).send({ invoice });
  });

  app.patch('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = updateSchema.parse(request.body);
    const { invoices } = request.company!.tables;
    const set: Record<string, unknown> = { ...body, updatedAt: new Date() };
    if (body.status === 'paid') set.paidAt = new Date();
    const [row] = await db.update(invoices).set(set).where(eq(invoices.id, id)).returning();
    if (!row) throw notFound('Invoice not found');
    return { invoice: row };
  });

  app.post('/:id/send', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices } = request.company!.tables;
    const [current] = await db.select().from(invoices).where(eq(invoices.id, id)).limit(1);
    if (!current) throw notFound('Invoice not found');
    const now = new Date();
    const dueAt = new Date(now.getTime() + current.paymentTermsDays * 24 * 60 * 60 * 1000);
    const [row] = await db
      .update(invoices)
      .set({ status: 'sent', sentAt: now, dueAt, updatedAt: now })
      .where(eq(invoices.id, id))
      .returning();
    return { invoice: row };
  });

  app.post('/:id/mark-paid', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices } = request.company!.tables;
    const now = new Date();
    const [row] = await db
      .update(invoices)
      .set({ status: 'paid', paidAt: now, updatedAt: now })
      .where(eq(invoices.id, id))
      .returning();
    if (!row) throw notFound('Invoice not found');
    return { invoice: row };
  });

  app.post('/:id/dunning', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { invoices } = request.company!.tables;
    const now = new Date();
    const [row] = await db
      .update(invoices)
      .set({
        dunningLevel: sql`${invoices.dunningLevel} + 1`,
        lastDunningAt: now,
        status: 'overdue',
        updatedAt: now,
      })
      .where(eq(invoices.id, id))
      .returning();
    if (!row) throw notFound('Invoice not found');
    return { invoice: row };
  });
};

export default invoicesAdminRoutes;
