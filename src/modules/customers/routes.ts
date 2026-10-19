import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import {
  and,
  asc,
  desc,
  eq,
  ilike,
  inArray,
  ne,
  or,
  sql,
  type SQL,
  type SQLWrapper,
} from 'drizzle-orm';
import type { AnyPgColumn, AnyPgTable } from 'drizzle-orm/pg-core';
import { z } from 'zod';

import { accessLevelOf, redactForViewer, redactListForViewer } from '../../lib/access.js';
import { db } from '../../db/index.js';
import { company, emailLog } from '../../db/schema/shared.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import {
  brandInfoFromCompany,
  brandSender,
  isNonContactableEmail,
  sendEmail,
} from '../../email/service.js';
import { customerMessageEmail } from '../../email/templates.js';
import { encodeCursor, keysetAfter } from '../../lib/cursor.js';
import { conflict, HttpError, notFound, parseIntId } from '../../lib/http-errors.js';
import { recomputeCustomerAggregates } from '../../lib/customer-stats.js';
import { orderNumberOf } from '../orders/lib.js';
import { pageEmailLog, sentToAddress } from '../emails/list.js';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
  tier: z.enum(['neukunde', 'stammkunde', 'premium']).optional(),
  email: z.string().email().optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

const MAX_INT4 = 2147483647;

function searchCondition(customers: CustomersTable, q: string) {
  const like = `%${q.replace(/[\\%_]/g, (ch) => `\\${ch}`)}%`;
  const parts = [
    ilike(customers.email, like),
    ilike(customers.name, like),
    ilike(customers.companyName, like),
    ilike(customers.customerNumber, like),
    ilike(customers.phone, like),
  ];
  // "3734" and "#3734" both mean the id column.
  const asId = /^#?(\d{1,10})$/.exec(q);
  if (asId && Number(asId[1]) <= MAX_INT4) parts.push(eq(customers.id, Number(asId[1])));
  return or(...parts);
}

const tagsSchema = z.array(z.string().trim().min(1).max(64)).max(50);

const optText = (max: number) =>
  z
    .string()
    .max(max)
    .transform((s) => {
      const trimmed = s.trim();
      return trimmed === '' ? null : trimmed;
    })
    .nullable()
    .optional();

const optCountry = z
  .string()
  .max(2)
  .transform((s) => {
    const trimmed = s.trim().toUpperCase();
    return trimmed === '' ? null : trimmed;
  })
  .nullable()
  .optional()
  .refine((v) => v == null || v.length === 2, {
    message: 'country must be a 2-letter ISO code',
  });

const optDate = z
  .string()
  .max(10)
  .transform((s) => {
    const trimmed = s.trim();
    return trimmed === '' ? null : trimmed;
  })
  .nullable()
  .optional()
  .refine((v) => v == null || /^\d{4}-\d{2}-\d{2}$/.test(v), {
    message: 'date must be YYYY-MM-DD',
  });

const profileShape = {
  name: optText(200),
  phone: optText(32),
  customerType: z.enum(['private', 'business']).optional(),
  salutation: z.enum(['herr', 'frau', 'divers', 'firma']).nullable().optional(),
  firstName: optText(120),
  lastName: optText(120),
  dateOfBirth: optDate,
  language: z.enum(['de', 'en']).nullable().optional(),
  preferredChannel: z.enum(['email', 'phone', 'whatsapp', 'post']).nullable().optional(),
  companyName: optText(200),
  vatId: optText(32),
  taxNumber: optText(32),
  customerNumber: optText(32),
  externalNumber: optText(64),
  jobPosition: optText(120),
  department: optText(120),
  website: optText(300),
  addressLine1: optText(200),
  addressLine2: optText(200),
  postalCode: optText(16),
  city: optText(120),
  country: optCountry,
  loyaltyTier: z.enum(['neukunde', 'stammkunde', 'premium']).optional(),
  tags: tagsSchema.optional(),
  internalNotes: optText(5000),
  marketingOptIn: z.boolean().optional(),
  defaultPaymentTermsDays: z.number().int().min(0).max(120).nullable().optional(),
} as const;

const updateSchema = z.object({
  email: z.string().email().max(254).optional(),
  ...profileShape,
});

const createSchema = z.object({
  email: z.string().email().max(254),
  ...profileShape,
  loyaltyTier: z.enum(['neukunde', 'stammkunde', 'premium']).default('neukunde'),
  tags: tagsSchema.default([]),
  marketingOptIn: z.boolean().default(false),
});

const addressSchema = z.object({
  kind: z.enum(['billing', 'service', 'shipping']).default('billing'),
  isDefault: z.boolean().default(false),
  label: optText(120),
  name: optText(200),
  company: optText(200),
  addressLine1: optText(200),
  addressLine2: optText(200),
  postalCode: optText(16),
  city: optText(120),
  country: optCountry,
  phone: optText(32),
  notes: optText(2000),
});

const addressUpdateSchema = addressSchema.partial();

const ADDRESS_MIRROR_KEYS = [
  'addressLine1',
  'addressLine2',
  'postalCode',
  'city',
  'country',
] as const;

function deriveName(input: {
  name?: string | null;
  firstName?: string | null;
  lastName?: string | null;
  companyName?: string | null;
}): string | null {
  const explicit = input.name?.trim();
  if (explicit) return explicit;
  const person = [input.firstName, input.lastName]
    .map((s) => s?.trim())
    .filter(Boolean)
    .join(' ');
  return person || input.companyName?.trim() || null;
}

function stripUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

function isCustomerNumberClash(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && (e.constraint ?? '').includes('customer_number');
}

const importSchema = z.object({
  csv: z
    .string()
    .min(8)
    .max(10 * 1024 * 1024),
  dryRun: z.boolean().default(false),
  marketingOptIn: z.boolean().default(false),
});

interface PostalFields {
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
}

type CustomerAddressesTable = TenantTables['customerAddresses'];
type CustomersTable = TenantTables['customers'];

function listAddresses(table: CustomerAddressesTable, customerId: number) {
  return db
    .select()
    .from(table)
    .where(eq(table.customerId, customerId))
    .orderBy(desc(table.isDefault), asc(table.id));
}

// The default address is mirrored onto customers.address_*; invoices, exports and emails read those.
async function mirrorAddressToCustomer(
  customers: CustomersTable,
  customerId: number,
  addr: PostalFields,
) {
  await db
    .update(customers)
    .set({
      addressLine1: addr.addressLine1,
      addressLine2: addr.addressLine2,
      postalCode: addr.postalCode,
      city: addr.city,
      country: addr.country ?? 'DE',
      updatedAt: new Date(),
    })
    .where(eq(customers.id, customerId));
}

async function upsertDefaultAddress(
  table: CustomerAddressesTable,
  customer: PostalFields & {
    id: number;
    name: string | null;
    companyName: string | null;
    phone: string | null;
  },
) {
  const postal = {
    addressLine1: customer.addressLine1,
    addressLine2: customer.addressLine2,
    postalCode: customer.postalCode,
    city: customer.city,
    country: customer.country ?? 'DE',
  };
  const [current] = await db
    .select({ id: table.id })
    .from(table)
    .where(and(eq(table.customerId, customer.id), eq(table.isDefault, true)))
    .limit(1);
  if (current) {
    await db
      .update(table)
      .set({ ...postal, updatedAt: new Date() })
      .where(eq(table.id, current.id));
    return;
  }
  if (!postal.addressLine1 && !postal.postalCode && !postal.city) return;
  await db.insert(table).values({
    ...postal,
    customerId: customer.id,
    kind: 'billing',
    isDefault: true,
    name: customer.name,
    company: customer.companyName,
    phone: customer.phone,
  });
}

type CustomerRow = TenantTables['customers']['$inferSelect'];

const pageQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(25),
  cursor: z.string().min(1).max(500).optional(),
});

const customerEmailSchema = z.object({
  subject: z.string().trim().min(1).max(200),
  body: z.string().trim().min(1).max(8000),
});

/** Linked rows: by customer_id, falling back to a case-insensitive email match for unlinked ones. */
function linkedTo(tables: TenantTables, customer: Pick<CustomerRow, 'id' | 'email'>) {
  const { orders, invoices, serviceInquiries, contactMessages } = tables;
  const email = customer.email.toLowerCase();
  return {
    orders: or(eq(orders.customerId, customer.id), sql`lower(${orders.customerEmail}) = ${email}`),
    invoices: or(
      eq(invoices.customerId, customer.id),
      sql`lower(${invoices.recipientEmail}) = ${email}`,
    ),
    inquiries: or(
      eq(serviceInquiries.customerId, customer.id),
      sql`lower(${serviceInquiries.email}) = ${email}`,
    ),
    contacts: or(
      eq(contactMessages.customerId, customer.id),
      sql`lower(${contactMessages.email}) = ${email}`,
    ),
  };
}

function customerEmailsWhere(
  slug: string,
  tables: TenantTables,
  customer: Pick<CustomerRow, 'id' | 'email'>,
): SQL {
  const link = linkedTo(tables, customer);
  const { orders, invoices, serviceInquiries, contactMessages } = tables;
  const about = (refType: string, ids: SQLWrapper) =>
    and(eq(emailLog.refType, refType), inArray(emailLog.refId, ids));
  return and(
    eq(emailLog.companySlug, slug),
    or(
      sentToAddress(customer.email),
      and(eq(emailLog.refType, 'customer'), eq(emailLog.refId, customer.id)),
      about('order', db.select({ id: orders.id }).from(orders).where(link.orders)),
      about('invoice', db.select({ id: invoices.id }).from(invoices).where(link.invoices)),
      about(
        'inquiry',
        db.select({ id: serviceInquiries.id }).from(serviceInquiries).where(link.inquiries),
      ),
      about(
        'contact',
        db.select({ id: contactMessages.id }).from(contactMessages).where(link.contacts),
      ),
    ),
  )!;
}

function afterCursor(
  table: AnyPgTable & { createdAt: AnyPgColumn; id: AnyPgColumn },
  cursor?: string,
) {
  return keysetAfter(table, table.createdAt, table.id, cursor);
}

function pageOf<T extends { createdAt: Date; id: number }>(rows: T[], limit: number) {
  const hasMore = rows.length > limit;
  const page = hasMore ? rows.slice(0, limit) : rows;
  const last = page[page.length - 1];
  const nextCursor =
    hasMore && last ? encodeCursor({ createdAt: last.createdAt.toISOString(), id: last.id }) : null;
  return { page, nextCursor };
}

async function linkedListRequest(request: FastifyRequest) {
  const id = parseIntId((request.params as { id: string }).id);
  const { limit, cursor } = pageQuerySchema.parse(request.query);
  const { customers } = request.company!.tables;
  const [customer] = await db
    .select({ id: customers.id, email: customers.email })
    .from(customers)
    .where(eq(customers.id, id))
    .limit(1);
  if (!customer) throw notFound('Customer not found');
  return { customer, limit, cursor };
}

async function loadMailContext(request: FastifyRequest, id: number) {
  const { customers } = request.company!.tables;
  const [customer] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
  if (!customer) throw notFound('Customer not found');
  // Imported placeholders are never mailed; refuse before rendering so the UI gets a clear error.
  if (isNonContactableEmail(customer.email)) {
    throw new HttpError(
      422,
      'Für diesen Kunden ist keine echte E-Mail-Adresse hinterlegt.',
      'NON_CONTACTABLE',
    );
  }
  const [companyRow] = await db
    .select()
    .from(company)
    .where(eq(company.slug, request.company!.slug))
    .limit(1);
  if (!companyRow) throw notFound('Company not found');
  return { customer, companyRow };
}

function renderCustomerEmail(
  companyRow: typeof company.$inferSelect,
  customer: CustomerRow,
  body: z.infer<typeof customerEmailSchema>,
) {
  return customerMessageEmail({
    brand: brandInfoFromCompany(companyRow),
    recipient: customer,
    subject: body.subject,
    messageBody: body.body,
  });
}

export const customersAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  // Reads open to any member (a `viewer` reads the linked orders); writes manager+.
  app.addHook('preHandler', app.requireWriteAccess);

  app.get('/', async (request) => {
    const { limit, cursor, tier, email, q } = listQuerySchema.parse(request.query);
    const { customers } = request.company!.tables;
    const conds = [];
    if (tier) conds.push(eq(customers.loyaltyTier, tier));
    if (email) conds.push(eq(customers.email, email));
    if (q) {
      const search = searchCondition(customers, q);
      if (search) conds.push(search);
    }
    const after = afterCursor(customers, cursor);
    if (after) conds.push(after);
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
    // A viewer keeps the operational record but not staff commentary.
    return { customers: redactListForViewer(page, accessLevelOf(request)), nextCursor };
  });

  app.post('/', async (request, reply) => {
    const body = createSchema.parse(request.body);
    const { customers, customerAddresses } = request.company!.tables;
    const { email, ...profile } = body;

    let row;
    try {
      [row] = await db
        .insert(customers)
        .values({
          ...stripUndefined(profile),
          email: email.toLowerCase(),
          name: deriveName(body),
        })
        .onConflictDoNothing({ target: customers.email })
        .returning();
    } catch (err) {
      if (isCustomerNumberClash(err)) throw conflict('This customer number is already in use');
      throw err;
    }
    if (!row) {
      reply.code(409).send({ error: 'A customer with this email already exists' });
      return;
    }
    // A street on the form means an address was entered: keep it as the default address row.
    if (row.addressLine1) {
      await db.insert(customerAddresses).values({
        customerId: row.id,
        kind: 'billing',
        isDefault: true,
        name: row.name,
        company: row.companyName,
        addressLine1: row.addressLine1,
        addressLine2: row.addressLine2,
        postalCode: row.postalCode,
        city: row.city,
        country: row.country ?? 'DE',
        phone: row.phone,
      });
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
    return { customer: redactForViewer(row, accessLevelOf(request)) };
  });

  // Customer 360 header: profile, addresses and uncapped stats; the linked lists page separately below.
  app.get('/:id/overview', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const tables = request.company!.tables;
    const { customers, customerAddresses, newsletterSubscribers } = tables;

    const [customer] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
    if (!customer) throw notFound('Customer not found');
    const link = linkedTo(tables, customer);
    const { orders, invoices, serviceInquiries, contactMessages } = tables;

    const [addressRows, [o], [i], [q], [c], [e], newsletterRow] = await Promise.all([
      listAddresses(customerAddresses, id),
      db
        .select({
          total: sql<number>`count(*)::int`,
          paid: sql<number>`(count(*) filter (where ${orders.paidAt} is not null))::int`,
          spent: sql<number>`coalesce(sum(greatest(${orders.totalCents} - ${orders.refundedAmountCents}, 0)) filter (where ${orders.paidAt} is not null), 0)::float8`,
        })
        .from(orders)
        .where(link.orders),
      db
        .select({
          total: sql<number>`count(*)::int`,
          // Drafts are not yet a claim on the customer; void ones never were.
          issued: sql<number>`(count(*) filter (where ${invoices.status} not in ('draft', 'void')))::int`,
          invoiced: sql<number>`coalesce(sum(${invoices.totalCents}) filter (where ${invoices.status} not in ('draft', 'void')), 0)::float8`,
          open: sql<number>`(count(*) filter (where ${invoices.status} in ('sent', 'overdue')))::int`,
          openCents: sql<number>`coalesce(sum(${invoices.totalCents}) filter (where ${invoices.status} in ('sent', 'overdue')), 0)::float8`,
          overdue: sql<number>`(count(*) filter (where ${invoices.status} = 'overdue'))::int`,
          // Only standalone invoices add turnover: an order-linked invoice bills what the order already counts.
          paidStandalone: sql<number>`coalesce(sum(${invoices.totalCents}) filter (where ${invoices.status} = 'paid' and ${invoices.orderId} is null), 0)::float8`,
        })
        .from(invoices)
        .where(link.invoices),
      db
        .select({
          total: sql<number>`count(*)::int`,
          open: sql<number>`(count(*) filter (where ${serviceInquiries.status} in ('new', 'in_review')))::int`,
        })
        .from(serviceInquiries)
        .where(link.inquiries),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(contactMessages)
        .where(link.contacts),
      db
        .select({ total: sql<number>`count(*)::int` })
        .from(emailLog)
        .where(customerEmailsWhere(request.company!.slug, tables, customer)),
      db
        .select()
        .from(newsletterSubscribers)
        .where(
          or(
            eq(newsletterSubscribers.customerId, id),
            sql`lower(${newsletterSubscribers.email}) = ${customer.email.toLowerCase()}`,
          ),
        )
        .orderBy(desc(newsletterSubscribers.createdAt))
        .limit(1)
        .then((rows) => rows[0] ?? null),
    ]);

    const newsletterStatus = newsletterRow
      ? newsletterRow.unsubscribedAt
        ? 'unsubscribed'
        : newsletterRow.confirmed
          ? 'confirmed'
          : 'pending'
      : 'none';

    const stats = {
      orders: o?.total ?? 0,
      paidOrders: o?.paid ?? 0,
      lifetimeSpentCents: Number(o?.spent ?? 0) + Number(i?.paidStandalone ?? 0),
      invoices: i?.total ?? 0,
      issuedInvoices: i?.issued ?? 0,
      invoicedCents: Number(i?.invoiced ?? 0),
      openInvoices: i?.open ?? 0,
      openInvoicedCents: Number(i?.openCents ?? 0),
      overdueInvoices: i?.overdue ?? 0,
      inquiries: q?.total ?? 0,
      openInquiries: q?.open ?? 0,
      contacts: c?.total ?? 0,
      emails: e?.total ?? 0,
      newsletterStatus,
    };

    const level = accessLevelOf(request);
    return {
      customer: redactForViewer(customer, level),
      addresses: redactListForViewer(addressRows, level),
      newsletter: newsletterRow ? redactForViewer(newsletterRow, level) : newsletterRow,
      stats,
    };
  });

  app.get('/:id/orders', async (request) => {
    const { customer, limit, cursor } = await linkedListRequest(request);
    const { orders } = request.company!.tables;
    const rows = await db
      .select()
      .from(orders)
      .where(and(linkedTo(request.company!.tables, customer).orders, afterCursor(orders, cursor)))
      .orderBy(desc(orders.createdAt), desc(orders.id))
      .limit(limit + 1);
    const { page, nextCursor } = pageOf(rows, limit);
    const level = accessLevelOf(request);
    return {
      orders: redactListForViewer(
        page.map((r) => ({ ...r, orderNumber: orderNumberOf(r) })),
        level,
      ),
      nextCursor,
    };
  });

  app.get('/:id/invoices', async (request) => {
    const { customer, limit, cursor } = await linkedListRequest(request);
    const { invoices } = request.company!.tables;
    const rows = await db
      .select()
      .from(invoices)
      .where(
        and(linkedTo(request.company!.tables, customer).invoices, afterCursor(invoices, cursor)),
      )
      .orderBy(desc(invoices.createdAt), desc(invoices.id))
      .limit(limit + 1);
    const { page, nextCursor } = pageOf(rows, limit);
    return { invoices: redactListForViewer(page, accessLevelOf(request)), nextCursor };
  });

  app.get('/:id/inquiries', async (request) => {
    const { customer, limit, cursor } = await linkedListRequest(request);
    const { serviceInquiries } = request.company!.tables;
    const rows = await db
      .select()
      .from(serviceInquiries)
      .where(
        and(
          linkedTo(request.company!.tables, customer).inquiries,
          afterCursor(serviceInquiries, cursor),
        ),
      )
      .orderBy(desc(serviceInquiries.createdAt), desc(serviceInquiries.id))
      .limit(limit + 1);
    const { page, nextCursor } = pageOf(rows, limit);
    return { inquiries: redactListForViewer(page, accessLevelOf(request)), nextCursor };
  });

  app.get('/:id/contacts', async (request) => {
    const { customer, limit, cursor } = await linkedListRequest(request);
    const { contactMessages } = request.company!.tables;
    const rows = await db
      .select()
      .from(contactMessages)
      .where(
        and(
          linkedTo(request.company!.tables, customer).contacts,
          afterCursor(contactMessages, cursor),
        ),
      )
      .orderBy(desc(contactMessages.createdAt), desc(contactMessages.id))
      .limit(limit + 1);
    const { page, nextCursor } = pageOf(rows, limit);
    return { contacts: redactListForViewer(page, accessLevelOf(request)), nextCursor };
  });

  // Everything this brand mailed to the customer's address or about one of their records.
  app.get('/:id/emails', async (request) => {
    const { customer, limit, cursor } = await linkedListRequest(request);
    const where = customerEmailsWhere(request.company!.slug, request.company!.tables, customer);
    return pageEmailLog([where], limit, cursor);
  });

  app.post('/:id/email/preview', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = customerEmailSchema.parse(request.body);
    const { customer, companyRow } = await loadMailContext(request, id);
    const email = renderCustomerEmail(companyRow, customer, body);
    return {
      to: customer.email,
      from: brandSender(companyRow),
      replyTo: companyRow.email ?? null,
      subject: email.subject,
      html: email.html,
    };
  });

  app.post('/:id/email', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = customerEmailSchema.parse(request.body);
    const { customer, companyRow } = await loadMailContext(request, id);

    const result = await sendEmail({
      to: customer.email,
      from: brandSender(companyRow),
      log: {
        companySlug: companyRow.slug,
        kind: 'customer_message',
        refType: 'customer',
        refId: customer.id,
        sentByUserId: request.authUser!.id,
      },
      apiKey: companyRow.resendApiKey ?? undefined,
      replyTo: companyRow.email ?? undefined,
      email: renderCustomerEmail(companyRow, customer, body),
    });
    if (!result.ok) {
      request.log.error({ customerId: id, error: result.error }, 'customer email failed');
      reply
        .code(502)
        .send({ error: 'E-Mail konnte nicht gesendet werden. Bitte erneut versuchen.' });
      return;
    }
    reply.code(201);
    return { ok: true, skipped: !!result.skipped };
  });

  app.patch('/:id', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = updateSchema.parse(request.body);
    const { customers, customerAddresses } = request.company!.tables;

    const [existing] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
    if (!existing) throw notFound('Customer not found');

    const patch: Record<string, unknown> = { ...stripUndefined(body), updatedAt: new Date() };
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
    if (
      body.name !== undefined ||
      body.firstName !== undefined ||
      body.lastName !== undefined ||
      body.companyName !== undefined
    ) {
      patch.name =
        deriveName({
          name: body.name ?? null,
          firstName: body.firstName !== undefined ? body.firstName : existing.firstName,
          lastName: body.lastName !== undefined ? body.lastName : existing.lastName,
          companyName: body.companyName !== undefined ? body.companyName : existing.companyName,
        }) ?? existing.name;
    }

    let row;
    try {
      [row] = await db.update(customers).set(patch).where(eq(customers.id, id)).returning();
    } catch (err) {
      if (isCustomerNumberClash(err)) throw conflict('This customer number is already in use');
      throw err;
    }
    if (!row) throw notFound('Customer not found');

    if (ADDRESS_MIRROR_KEYS.some((key) => body[key] !== undefined)) {
      await upsertDefaultAddress(customerAddresses, row);
    }
    return { customer: row };
  });

  app.delete('/:id', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { customers, customerAddresses } = request.company!.tables;
    await db.delete(customerAddresses).where(eq(customerAddresses.customerId, id));
    await db.delete(customers).where(eq(customers.id, id));
    reply.code(204).send();
  });

  app.get('/:id/addresses', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const { customers, customerAddresses } = request.company!.tables;
    const [customer] = await db
      .select({ id: customers.id })
      .from(customers)
      .where(eq(customers.id, id))
      .limit(1);
    if (!customer) throw notFound('Customer not found');
    return { addresses: await listAddresses(customerAddresses, id) };
  });

  app.post('/:id/addresses', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const body = addressSchema.parse(request.body);
    const { customers, customerAddresses } = request.company!.tables;
    const [customer] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
    if (!customer) throw notFound('Customer not found');

    const existing = await listAddresses(customerAddresses, id);
    const makeDefault = body.isDefault || existing.length === 0;

    const [row] = await db.transaction(async (tx) => {
      if (makeDefault) {
        await tx
          .update(customerAddresses)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(eq(customerAddresses.customerId, id));
      }
      return tx
        .insert(customerAddresses)
        .values({ ...stripUndefined(body), customerId: id, isDefault: makeDefault })
        .returning();
    });
    if (makeDefault && row) await mirrorAddressToCustomer(customers, id, row);
    reply.code(201).send({ address: row });
  });

  app.patch('/:id/addresses/:addressId', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const addressId = parseIntId((request.params as { addressId: string }).addressId);
    const body = addressUpdateSchema.parse(request.body);
    const { customers, customerAddresses } = request.company!.tables;

    const [current] = await db
      .select()
      .from(customerAddresses)
      .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, id)))
      .limit(1);
    if (!current) throw notFound('Address not found');

    const makeDefault = body.isDefault === true || current.isDefault;
    const [row] = await db.transaction(async (tx) => {
      if (body.isDefault === true && !current.isDefault) {
        await tx
          .update(customerAddresses)
          .set({ isDefault: false, updatedAt: new Date() })
          .where(eq(customerAddresses.customerId, id));
      }
      return (
        tx
          .update(customerAddresses)
          // The default flag is only ever cleared by promoting another address.
          .set({ ...stripUndefined(body), isDefault: makeDefault, updatedAt: new Date() })
          .where(eq(customerAddresses.id, addressId))
          .returning()
      );
    });
    if (makeDefault && row) await mirrorAddressToCustomer(customers, id, row);
    return { address: row };
  });

  app.post('/:id/addresses/:addressId/default', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const addressId = parseIntId((request.params as { addressId: string }).addressId);
    const { customers, customerAddresses } = request.company!.tables;

    const [current] = await db
      .select()
      .from(customerAddresses)
      .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, id)))
      .limit(1);
    if (!current) throw notFound('Address not found');

    await db.transaction(async (tx) => {
      await tx
        .update(customerAddresses)
        .set({ isDefault: false, updatedAt: new Date() })
        .where(eq(customerAddresses.customerId, id));
      await tx
        .update(customerAddresses)
        .set({ isDefault: true, updatedAt: new Date() })
        .where(eq(customerAddresses.id, addressId));
    });
    await mirrorAddressToCustomer(customers, id, current);
    return { addresses: await listAddresses(customerAddresses, id) };
  });

  app.delete('/:id/addresses/:addressId', async (request, reply) => {
    const id = parseIntId((request.params as { id: string }).id);
    const addressId = parseIntId((request.params as { addressId: string }).addressId);
    const { customers, customerAddresses } = request.company!.tables;

    const [current] = await db
      .select()
      .from(customerAddresses)
      .where(and(eq(customerAddresses.id, addressId), eq(customerAddresses.customerId, id)))
      .limit(1);
    if (!current) throw notFound('Address not found');

    await db.delete(customerAddresses).where(eq(customerAddresses.id, addressId));
    if (current.isDefault) {
      // Promote the oldest remaining address so a default always exists.
      const [next] = await listAddresses(customerAddresses, id);
      if (next) {
        await db
          .update(customerAddresses)
          .set({ isDefault: true, updatedAt: new Date() })
          .where(eq(customerAddresses.id, next.id));
        await mirrorAddressToCustomer(customers, id, next);
      }
    }
    reply.code(204).send();
  });

  // Rebuilds aggregates from live paid orders and paid invoices (the stored counters can drift), then re-derives the loyalty tier.
  app.post('/:id/recompute-tier', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const updated = await recomputeCustomerAggregates(request.company!.tables, id);
    if (!updated) throw notFound('Customer not found');
    return { customer: updated };
  });
};

export default customersAdminRoutes;
