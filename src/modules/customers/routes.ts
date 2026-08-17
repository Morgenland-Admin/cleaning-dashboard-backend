import type { FastifyPluginAsync } from 'fastify';
import { and, asc, desc, eq, ilike, lt, ne, or, sql } from 'drizzle-orm';
import { z } from 'zod';

import { accessLevelOf, redactForViewer, redactListForViewer } from '../../lib/access.js';
import { db } from '../../db/index.js';
import type { TenantTables } from '../../db/schema/tenant.js';
import { decodeCursor, encodeCursor } from '../../lib/cursor.js';
import { conflict, notFound, parseIntId } from '../../lib/http-errors.js';
import { recomputeCustomerAggregates } from '../../lib/customer-stats.js';

const listQuerySchema = z.object({
  limit: z.coerce.number().int().min(1).max(200).default(50),
  cursor: z.string().min(1).max(500).optional(),
  tier: z.enum(['neukunde', 'stammkunde', 'premium']).optional(),
  email: z.string().email().optional(),
  q: z.string().trim().min(1).max(200).optional(),
});

/** Largest value a Postgres int4 id can hold — bigger digit runs can't be an id. */
const MAX_INT4 = 2147483647;

/**
 * Free-text list filter: matches id, email, name, company, customer number and
 * phone. Runs in SQL rather than on the loaded page so searching for "#3734"
 * finds that customer even when it sits thousands of rows deep.
 */
function searchCondition(customers: CustomersTable, q: string) {
  // LIKE metacharacters are escaped so a literal "%" doesn't match everything.
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

/**
 * Optional text field: trims, and treats an empty string as "cleared" (null) so
 * the form can blank a field without sending an explicit null.
 */
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

/** Person, company and billing fields shared by create and update. */
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

/** Fields of a customer that are mirrored onto its default address row. */
const ADDRESS_MIRROR_KEYS = [
  'addressLine1',
  'addressLine2',
  'postalCode',
  'city',
  'country',
] as const;

/**
 * Display name of a contact. An explicitly supplied name always wins; otherwise
 * it is derived from the person fields, falling back to the company — so a
 * business contact without a named person still shows up as the company.
 */
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

/** Drop keys the request did not send so a PATCH never nulls untouched columns. */
function stripUndefined<T extends Record<string, unknown>>(obj: T): Record<string, unknown> {
  return Object.fromEntries(Object.entries(obj).filter(([, v]) => v !== undefined));
}

/** True for a Postgres unique-violation on the customer_number index. */
function isCustomerNumberClash(err: unknown): boolean {
  const e = err as { code?: string; constraint?: string } | null;
  return e?.code === '23505' && (e.constraint ?? '').includes('customer_number');
}

const importSchema = z.object({
  csv: z
    .string()
    .min(8)
    .max(10 * 1024 * 1024), // 10 MB hard cap
  dryRun: z.boolean().default(false),
  marketingOptIn: z.boolean().default(false),
});

/** Postal fields shared by a customer row and one of its address rows. */
interface PostalFields {
  addressLine1: string | null;
  addressLine2: string | null;
  postalCode: string | null;
  city: string | null;
  country: string | null;
}

type CustomerAddressesTable = TenantTables['customerAddresses'];
type CustomersTable = TenantTables['customers'];

/** Default address first, then oldest to newest. */
function listAddresses(table: CustomerAddressesTable, customerId: number) {
  return db
    .select()
    .from(table)
    .where(eq(table.customerId, customerId))
    .orderBy(desc(table.isDefault), asc(table.id));
}

/** Copy a default address onto the flat customers.address_* mirror columns. */
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

/**
 * Push the address edited on the customer form into the default address row —
 * updating it when one exists, otherwise creating it. Keeps the Addresses tab
 * and the customer form from disagreeing about the primary address.
 */
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

export const customersAdminRoutes: FastifyPluginAsync = async (app) => {
  app.addHook('preHandler', app.requireCompany);
  // Writes need manager+; reads stay open to any member of the brand. A `viewer`
  // already reads the orders these customers belong to — blocking the customer
  // record itself just left that role with dangling references.
  app.addHook('preHandler', app.requireWriteAccess);

  app.get('/', async (request) => {
    const { limit, cursor, tier, email, q } = listQuerySchema.parse(request.query);
    const { customers } = request.company!.tables;
    const decoded = cursor ? decodeCursor(cursor) : null;
    const conds = [];
    if (tier) conds.push(eq(customers.loyaltyTier, tier));
    if (email) conds.push(eq(customers.email, email));
    if (q) {
      const search = searchCondition(customers, q);
      if (search) conds.push(search);
    }
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
    // A street on the form means the operator entered an address — keep it as the
    // customer's default address row so the Addresses tab is never empty.
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

  // Customer 360: profile + everything linked to this customer (by customer_id,
  // falling back to a case-insensitive email match so data shows even if a row
  // predates the backfill). Lists are capped — this is a profile, not an export.
  app.get('/:id/overview', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const {
      customers,
      customerAddresses,
      orders,
      invoices,
      serviceInquiries,
      contactMessages,
      newsletterSubscribers,
    } = request.company!.tables;

    const [customer] = await db.select().from(customers).where(eq(customers.id, id)).limit(1);
    if (!customer) throw notFound('Customer not found');
    const email = customer.email.toLowerCase();

    const [addressRows, orderRows, invoiceRows, inquiryRows, contactRows, newsletterRow] =
      await Promise.all([
        listAddresses(customerAddresses, id),
        db
          .select()
          .from(orders)
          .where(or(eq(orders.customerId, id), sql`lower(${orders.customerEmail}) = ${email}`))
          .orderBy(desc(orders.createdAt))
          .limit(100),
        db
          .select()
          .from(invoices)
          .where(or(eq(invoices.customerId, id), sql`lower(${invoices.recipientEmail}) = ${email}`))
          .orderBy(desc(invoices.createdAt))
          .limit(100),
        db
          .select()
          .from(serviceInquiries)
          .where(
            or(
              eq(serviceInquiries.customerId, id),
              sql`lower(${serviceInquiries.email}) = ${email}`,
            ),
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
    // Refunds come off the turnover, per order row.
    const orderSpentCents = paidOrders.reduce(
      (sum, o) => sum + Math.max(o.totalCents - o.refundedAmountCents, 0),
      0,
    );
    // Drafts are not yet a claim on the customer; void ones never were.
    const issuedInvoices = invoiceRows.filter((i) => i.status !== 'draft' && i.status !== 'void');
    const openInvoices = issuedInvoices.filter(
      (i) => i.status === 'sent' || i.status === 'overdue',
    );
    // Money actually received via invoices. An invoice tied to an order bills
    // what that order already counts, so only standalone ones add turnover.
    const paidInvoiceSpentCents = invoiceRows
      .filter((i) => i.status === 'paid' && i.orderId == null)
      .reduce((sum, i) => sum + i.totalCents, 0);
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
      lifetimeSpentCents: orderSpentCents + paidInvoiceSpentCents,
      invoices: invoiceRows.length,
      /** Issued (non-draft, non-void) invoices — what the customer was billed. */
      issuedInvoices: issuedInvoices.length,
      invoicedCents: issuedInvoices.reduce((sum, i) => sum + i.totalCents, 0),
      openInvoices: openInvoices.length,
      openInvoicedCents: openInvoices.reduce((sum, i) => sum + i.totalCents, 0),
      overdueInvoices: openInvoices.filter((i) => i.status === 'overdue').length,
      inquiries: inquiryRows.length,
      openInquiries: inquiryRows.filter((i) => i.status === 'new' || i.status === 'in_review')
        .length,
      contacts: contactRows.length,
      newsletterStatus,
    };

    // Customer 360 pulls rows from five tables that all carry staff notes and
    // submission forensics. Redact each collection, not just the profile —
    // otherwise this endpoint becomes the way around the per-module rules.
    const level = accessLevelOf(request);
    return {
      customer: redactForViewer(customer, level),
      addresses: redactListForViewer(addressRows, level),
      orders: redactListForViewer(orderRows, level),
      invoices: redactListForViewer(invoiceRows, level),
      inquiries: redactListForViewer(inquiryRows, level),
      contacts: redactListForViewer(contactRows, level),
      newsletter: newsletterRow ? redactForViewer(newsletterRow, level) : newsletterRow,
      stats,
    };
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
    // Recompute the display name whenever a name part changes, so the lists and
    // invoices never drift from the person/company fields.
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

  // --- Addresses -------------------------------------------------------------
  // An ERP contact keeps several addresses (invoice, pickup/service, shipping).
  // One is the default; it is mirrored onto the flat customers.address_* columns
  // that invoices, exports and emails read.

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
    // The very first address is always the default — otherwise nothing would be.
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

  /**
   * Rebuild the stored aggregates (orders, turnover, first/last order) from the
   * live paid orders and paid invoices, then re-derive the loyalty tier. Reading
   * the counters instead would keep any historic drift — e.g. a customer billed
   * through hand-written invoices only, whose counters were never touched.
   */
  app.post('/:id/recompute-tier', async (request) => {
    const id = parseIntId((request.params as { id: string }).id);
    const updated = await recomputeCustomerAggregates(request.company!.tables, id);
    if (!updated) throw notFound('Customer not found');
    return { customer: updated };
  });
};

export default customersAdminRoutes;
