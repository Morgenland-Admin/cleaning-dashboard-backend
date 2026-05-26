import {
  boolean,
  date,
  index,
  integer,
  jsonb,
  numeric,
  pgSchema,
  serial,
  text,
  timestamp,
  varchar,
} from 'drizzle-orm/pg-core';

// Factory that produces an identical set of tables for a given Postgres schema.
// Each company gets its own Postgres schema; the column structure is shared.
function buildTenantTables(schemaName: string) {
  const s = pgSchema(schemaName);

  const newsletterSubscribers = s.table('newsletter_subscribers', {
    id: serial('id').primaryKey(),
    email: text('email').notNull().unique(),
    firstName: text('first_name'),
    lastName: text('last_name'),
    locale: varchar('locale', { length: 16 }).notNull().default('de'),
    source: varchar('source', { length: 64 }),
    tags: jsonb('tags').$type<string[]>().notNull().default([]),
    confirmed: boolean('confirmed').notNull().default(false),
    confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
    confirmToken: text('confirm_token'),
    confirmTokenExpiresAt: timestamp('confirm_token_expires_at', { withTimezone: true }),
    unsubscribedAt: timestamp('unsubscribed_at', { withTimezone: true }),
    lastEmailSentAt: timestamp('last_email_sent_at', { withTimezone: true }),
    ipAddress: text('ip_address'),
    userAgent: text('user_agent'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  });

  const contactMessages = s.table(
    'contact_messages',
    {
      id: serial('id').primaryKey(),
      name: text('name').notNull(),
      email: text('email').notNull(),
      phone: varchar('phone', { length: 32 }),
      subject: text('subject'),
      message: text('message').notNull(),
      locale: varchar('locale', { length: 16 }).notNull().default('de'),
      source: varchar('source', { length: 64 }),
      status: varchar('status', { length: 16 }).notNull().default('new'),
      priority: varchar('priority', { length: 16 }).notNull().default('normal'),
      consentPrivacy: boolean('consent_privacy').notNull().default(false),
      consentMarketing: boolean('consent_marketing').notNull().default(false),
      handledByUserId: text('handled_by_user_id'),
      handledAt: timestamp('handled_at', { withTimezone: true }),
      repliedAt: timestamp('replied_at', { withTimezone: true }),
      internalNotes: text('internal_notes'),
      /**
       * Brand-specific form fields. Mirrors service_inquiries.metadata — lets each
       * storefront submit arbitrary extra keys (e.g. carpet size, pickup vs on-site)
       * without a schema change. Admin UI renders unknown keys via MetadataBlock.
       */
      metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
      attachments: jsonb('attachments')
        .$type<Array<{ key: string; name: string; size: number; contentType?: string }>>()
        .notNull()
        .default([]),
      ipAddress: text('ip_address'),
      userAgent: text('user_agent'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      createdAtIdx: index('contact_messages_created_at_idx').on(table.createdAt),
    }),
  );

  /** Admin replies sent in response to a contact message. One contact_messages row → many. */
  const contactReplies = s.table(
    'contact_replies',
    {
      id: serial('id').primaryKey(),
      contactMessageId: integer('contact_message_id')
        .notNull()
        .references(() => contactMessages.id, { onDelete: 'cascade' }),
      body: text('body').notNull(),
      sentByUserId: text('sent_by_user_id'),
      sentByName: text('sent_by_name'),
      emailMessageId: text('email_message_id'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      contactMessageIdIdx: index('contact_replies_contact_message_id_idx').on(
        table.contactMessageId,
      ),
    }),
  );

  const serviceInquiries = s.table(
    'service_inquiries',
    {
      id: serial('id').primaryKey(),
      name: text('name').notNull(),
      email: text('email').notNull(),
      phone: varchar('phone', { length: 32 }),
      service: text('service'),
      propertyDetails: text('property_details'),
      preferredDate: date('preferred_date'),
      budget: varchar('budget', { length: 64 }),
      message: text('message').notNull(),
      locale: varchar('locale', { length: 16 }).notNull().default('de'),
      source: varchar('source', { length: 64 }),
      status: varchar('status', { length: 16 }).notNull().default('new'),
      priority: varchar('priority', { length: 16 }).notNull().default('normal'),
      consentPrivacy: boolean('consent_privacy').notNull().default(false),
      consentMarketing: boolean('consent_marketing').notNull().default(false),
      handledByUserId: text('handled_by_user_id'),
      handledAt: timestamp('handled_at', { withTimezone: true }),
      quotedAt: timestamp('quoted_at', { withTimezone: true }),
      quotedAmount: numeric('quoted_amount', { precision: 12, scale: 2 }),
      closedAt: timestamp('closed_at', { withTimezone: true }),
      internalNotes: text('internal_notes'),
      metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
      attachments: jsonb('attachments')
        .$type<Array<{ key: string; name: string; size: number; contentType?: string }>>()
        .notNull()
        .default([]),
      ipAddress: text('ip_address'),
      userAgent: text('user_agent'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      createdAtIdx: index('service_inquiries_created_at_idx').on(table.createdAt),
    }),
  );

  const partners = s.table('partners', {
    id: serial('id').primaryKey(),
    userId: text('user_id').notNull(),
    companyName: text('company_name'),
    legalName: text('legal_name'),
    taxId: varchar('tax_id', { length: 32 }),
    vatId: varchar('vat_id', { length: 32 }),
    registrationNumber: varchar('registration_number', { length: 64 }),
    contactEmail: text('contact_email'),
    contactPhone: varchar('contact_phone', { length: 32 }),
    websiteUrl: text('website_url'),
    addressLine1: text('address_line1'),
    addressLine2: text('address_line2'),
    city: text('city'),
    region: text('region'),
    postalCode: varchar('postal_code', { length: 20 }),
    country: varchar('country', { length: 2 }).default('DE'),
    serviceAreas: jsonb('service_areas').$type<string[]>().notNull().default([]),
    services: jsonb('services').$type<string[]>().notNull().default([]),
    iban: varchar('iban', { length: 34 }),
    bic: varchar('bic', { length: 11 }),
    commissionRate: numeric('commission_rate', { precision: 5, scale: 2 }),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedByUserId: text('approved_by_user_id'),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    internalNotes: text('internal_notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  });

  /**
   * Chat conversations between an admin and a partner. One row per partner —
   * we don't need group chats yet, so the partner's user_id is the conversation
   * key. `lastMessageAt` + `lastMessagePreview` are denormalized so the inbox
   * list can render without a per-row aggregate query.
   */
  const chatConversations = s.table(
    'chat_conversations',
    {
      id: serial('id').primaryKey(),
      partnerUserId: text('partner_user_id').notNull(),
      lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
      lastMessagePreview: text('last_message_preview'),
      /** Per-side unread counters — incremented on send, zeroed on mark-read. */
      unreadForAdmin: integer('unread_for_admin').notNull().default(0),
      unreadForPartner: integer('unread_for_partner').notNull().default(0),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      partnerUserIdx: index('chat_conversations_partner_user_id_idx').on(table.partnerUserId),
    }),
  );

  /**
   * Individual messages inside a conversation. `senderUserId` references the
   * sender (admin or partner). `readAt` is set when the recipient's chat is
   * focused on this thread — drives the "Gelesen" indicator on outgoing
   * bubbles. Attachments are S3 keys, same shape as the inquiry attachments.
   */
  const chatMessages = s.table(
    'chat_messages',
    {
      id: serial('id').primaryKey(),
      conversationId: integer('conversation_id')
        .notNull()
        .references(() => chatConversations.id, { onDelete: 'cascade' }),
      senderUserId: text('sender_user_id').notNull(),
      senderRole: varchar('sender_role', { length: 16 }).notNull(), // admin | partner
      body: text('body'),
      attachments: jsonb('attachments')
        .$type<Array<{ key: string; name: string; size: number; contentType?: string }>>()
        .notNull()
        .default([]),
      deliveredAt: timestamp('delivered_at', { withTimezone: true }),
      readAt: timestamp('read_at', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      conversationIdx: index('chat_messages_conversation_id_idx').on(table.conversationId),
      createdAtIdx: index('chat_messages_created_at_idx').on(table.createdAt),
    }),
  );

  /**
   * Paid customer orders. One row per checkout. Order details (line items)
   * live in `order_items`; lifecycle transitions are recorded in
   * `order_status_log` for auditability + ALL_10-style customer notifications.
   *
   * Status FSM (matches workflow ALL_09):
   *   pending → payment_pending → paid → accepted → picked_up
   *           → in_cleaning → ready → delivered → completed
   *   any → cancelled | refunded
   *
   * `kind` keys into the pricing engine (lib/pricing.ts) — never present a
   * kind here that the engine doesn't understand.
   */
  const orders = s.table(
    'orders',
    {
      id: serial('id').primaryKey(),
      /** URL-safe random token for the public /bestellung/[token] tracker. */
      publicToken: text('public_token').notNull().unique(),
      kind: varchar('kind', { length: 32 }).notNull(),
      status: varchar('status', { length: 24 }).notNull().default('pending'),

      // Money — all in cents, EUR, inkl. 19% MwSt. Stripe is the system of
      // record but we store snapshots so admin can render an invoice without
      // re-hitting Stripe.
      currency: varchar('currency', { length: 3 }).notNull().default('EUR'),
      subtotalCents: integer('subtotal_cents').notNull(),
      pickupFeeCents: integer('pickup_fee_cents').notNull().default(0),
      minOrderTopUpCents: integer('min_order_top_up_cents').notNull().default(0),
      totalCents: integer('total_cents').notNull(),

      // Pickup / delivery
      pickupMode: varchar('pickup_mode', { length: 16 }).notNull(), // pickup | drop_off | onsite
      pickupZone: integer('pickup_zone'),
      pickupPlz: varchar('pickup_plz', { length: 5 }),
      pickupLabel: text('pickup_label'),
      /** YYYY-MM-DD — customer's requested date (Polster) or earliest pickup. */
      preferredDate: date('preferred_date'),

      // Customer contact (no auth account — guest checkout)
      customerName: text('customer_name').notNull(),
      customerEmail: text('customer_email').notNull(),
      customerPhone: varchar('customer_phone', { length: 32 }),

      // Pickup address (Teppichreinigung / Teppichreparatur) or service
      // address (Polsterreinigung). For drop_off mode, may be null.
      addressLine1: text('address_line1'),
      addressLine2: text('address_line2'),
      addressCity: text('address_city'),
      addressPostalCode: varchar('address_postal_code', { length: 16 }),
      addressCountry: varchar('address_country', { length: 2 }).default('DE'),

      customerNotes: text('customer_notes'),
      internalNotes: text('internal_notes'),

      // Stripe linkage
      stripeSessionId: text('stripe_session_id'),
      stripePaymentIntentId: text('stripe_payment_intent_id'),

      // Lifecycle timestamps — one per status. Sparser than a log table but
      // fast to query for dashboards.
      paidAt: timestamp('paid_at', { withTimezone: true }),
      acceptedAt: timestamp('accepted_at', { withTimezone: true }),
      pickedUpAt: timestamp('picked_up_at', { withTimezone: true }),
      inCleaningAt: timestamp('in_cleaning_at', { withTimezone: true }),
      readyAt: timestamp('ready_at', { withTimezone: true }),
      deliveredAt: timestamp('delivered_at', { withTimezone: true }),
      completedAt: timestamp('completed_at', { withTimezone: true }),
      cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
      refundedAt: timestamp('refunded_at', { withTimezone: true }),

      /** Admin user who most-recently advanced the order. */
      handledByUserId: text('handled_by_user_id'),

      consentPrivacy: boolean('consent_privacy').notNull().default(false),
      consentMarketing: boolean('consent_marketing').notNull().default(false),

      locale: varchar('locale', { length: 16 }).notNull().default('de'),
      source: varchar('source', { length: 64 }),

      /** Brand-specific extras (e.g. Polster appointment window preference). */
      metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),

      ipAddress: text('ip_address'),
      userAgent: text('user_agent'),

      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      createdAtIdx: index('orders_created_at_idx').on(table.createdAt),
      statusIdx: index('orders_status_idx').on(table.status),
      stripeSessionIdx: index('orders_stripe_session_id_idx').on(table.stripeSessionId),
    }),
  );

  /**
   * Line items for an order. Stored after pricing engine ran — these are the
   * exact lines we sent to Stripe and they're what the customer + admin see
   * on the invoice. Quantity is `numeric` to support 2.5 qm / 1.5 lfdm.
   */
  const orderItems = s.table(
    'order_items',
    {
      id: serial('id').primaryKey(),
      orderId: integer('order_id')
        .notNull()
        .references(() => orders.id, { onDelete: 'cascade' }),
      /** Machine code (e.g. "carpet.orient", "addon.motten"). See pricing.ts. */
      code: varchar('code', { length: 64 }).notNull(),
      label: text('label').notNull(),
      quantityLabel: text('quantity_label').notNull(),
      quantity: numeric('quantity', { precision: 10, scale: 2 }).notNull(),
      unitPriceCents: integer('unit_price_cents').notNull(),
      subtotalCents: integer('subtotal_cents').notNull(),
      metadata: jsonb('metadata').$type<Record<string, unknown>>().notNull().default({}),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      orderIdx: index('order_items_order_id_idx').on(table.orderId),
    }),
  );

  /**
   * Append-only status transition log. Lets admin review "who moved this to
   * ready, when, and why" without scraping email history. System transitions
   * (Stripe webhook flipping pending → paid) have changedByUserId = null.
   */
  const orderStatusLog = s.table(
    'order_status_log',
    {
      id: serial('id').primaryKey(),
      orderId: integer('order_id')
        .notNull()
        .references(() => orders.id, { onDelete: 'cascade' }),
      fromStatus: varchar('from_status', { length: 24 }),
      toStatus: varchar('to_status', { length: 24 }).notNull(),
      changedByUserId: text('changed_by_user_id'),
      reason: text('reason'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      orderIdx: index('order_status_log_order_id_idx').on(table.orderId),
    }),
  );

  return {
    schema: s,
    newsletterSubscribers,
    contactMessages,
    contactReplies,
    serviceInquiries,
    partners,
    chatConversations,
    chatMessages,
    orders,
    orderItems,
    orderStatusLog,
  };
}

export type TenantTables = ReturnType<typeof buildTenantTables>;

/**
 * Dynamic accessor: returns Drizzle table bindings for any Postgres schema
 * name. Memoized so repeated lookups (e.g. per-request) reuse the same
 * objects. This is what makes admin-created companies work without a code
 * change — when a new `company` row lands in the registry with its own
 * `schemaName`, routes can resolve table bindings for it on demand.
 */
const tenantCache = new Map<string, TenantTables>();
export function getTenantTables(schemaName: string): TenantTables {
  let cached = tenantCache.get(schemaName);
  if (!cached) {
    cached = buildTenantTables(schemaName);
    tenantCache.set(schemaName, cached);
  }
  return cached;
}

// Static named exports for the three legacy schemas — kept so drizzle-kit's
// schema scanner discovers them when generating migrations. New companies
// added via the admin UI get their tables created at runtime via raw SQL
// in createTenantSchemaSql() below, not via drizzle migrations.
const _cleanilo = getTenantTables('cleanilo');
const _hamburg = getTenantTables('hamburg_teppichreinigung');
const _teppichreinigenLassen = getTenantTables('teppichreinigen_lassen');

export const cleaniloSchema = _cleanilo.schema;
export const cleaniloNewsletterSubscribers = _cleanilo.newsletterSubscribers;
export const cleaniloContactMessages = _cleanilo.contactMessages;
export const cleaniloContactReplies = _cleanilo.contactReplies;
export const cleaniloServiceInquiries = _cleanilo.serviceInquiries;
export const cleaniloPartners = _cleanilo.partners;

export const hamburgSchema = _hamburg.schema;
export const hamburgNewsletterSubscribers = _hamburg.newsletterSubscribers;
export const hamburgContactMessages = _hamburg.contactMessages;
export const hamburgContactReplies = _hamburg.contactReplies;
export const hamburgServiceInquiries = _hamburg.serviceInquiries;
export const hamburgPartners = _hamburg.partners;

export const teppichreinigenLassenSchema = _teppichreinigenLassen.schema;
export const teppichreinigenLassenNewsletterSubscribers =
  _teppichreinigenLassen.newsletterSubscribers;
export const teppichreinigenLassenContactMessages = _teppichreinigenLassen.contactMessages;
export const teppichreinigenLassenContactReplies = _teppichreinigenLassen.contactReplies;
export const teppichreinigenLassenServiceInquiries = _teppichreinigenLassen.serviceInquiries;
export const teppichreinigenLassenPartners = _teppichreinigenLassen.partners;

/**
 * SQL template that creates the per-tenant tables inside a freshly-created
 * Postgres schema. Used by POST /admin/companies to provision a new
 * tenant without requiring a drizzle migration generation step. Keep this
 * in sync with buildTenantTables() above — these are the same five tables.
 *
 * The schemaName is interpolated directly into the SQL because Postgres
 * identifiers cannot be parameterized. Callers must already have validated
 * the schema name (see `isValidSchemaName` in src/config/companies.ts).
 */
export function createTenantSchemaSql(schemaName: string): string {
  const q = `"${schemaName}"`;
  return `
CREATE SCHEMA IF NOT EXISTS ${q};

CREATE TABLE IF NOT EXISTS ${q}."newsletter_subscribers" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "first_name" text,
  "last_name" text,
  "locale" varchar(16) DEFAULT 'de' NOT NULL,
  "source" varchar(64),
  "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "confirmed" boolean DEFAULT false NOT NULL,
  "confirmed_at" timestamp with time zone,
  "confirm_token" text,
  "confirm_token_expires_at" timestamp with time zone,
  "unsubscribed_at" timestamp with time zone,
  "last_email_sent_at" timestamp with time zone,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "${schemaName}_newsletter_email_unique" UNIQUE("email")
);

CREATE TABLE IF NOT EXISTS ${q}."contact_messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "phone" varchar(32),
  "subject" text,
  "message" text NOT NULL,
  "locale" varchar(16) DEFAULT 'de' NOT NULL,
  "source" varchar(64),
  "status" varchar(16) DEFAULT 'new' NOT NULL,
  "priority" varchar(16) DEFAULT 'normal' NOT NULL,
  "consent_privacy" boolean DEFAULT false NOT NULL,
  "consent_marketing" boolean DEFAULT false NOT NULL,
  "handled_by_user_id" text,
  "handled_at" timestamp with time zone,
  "replied_at" timestamp with time zone,
  "internal_notes" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "contact_messages_created_at_idx" ON ${q}."contact_messages" ("created_at");

CREATE TABLE IF NOT EXISTS ${q}."contact_replies" (
  "id" serial PRIMARY KEY NOT NULL,
  "contact_message_id" integer NOT NULL REFERENCES ${q}."contact_messages"("id") ON DELETE CASCADE,
  "body" text NOT NULL,
  "sent_by_user_id" text,
  "sent_by_name" text,
  "email_message_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "contact_replies_contact_message_id_idx" ON ${q}."contact_replies" ("contact_message_id");

CREATE TABLE IF NOT EXISTS ${q}."service_inquiries" (
  "id" serial PRIMARY KEY NOT NULL,
  "name" text NOT NULL,
  "email" text NOT NULL,
  "phone" varchar(32),
  "service" text,
  "property_details" text,
  "preferred_date" date,
  "budget" varchar(64),
  "message" text NOT NULL,
  "locale" varchar(16) DEFAULT 'de' NOT NULL,
  "source" varchar(64),
  "status" varchar(16) DEFAULT 'new' NOT NULL,
  "priority" varchar(16) DEFAULT 'normal' NOT NULL,
  "consent_privacy" boolean DEFAULT false NOT NULL,
  "consent_marketing" boolean DEFAULT false NOT NULL,
  "handled_by_user_id" text,
  "handled_at" timestamp with time zone,
  "quoted_at" timestamp with time zone,
  "quoted_amount" numeric(12, 2),
  "closed_at" timestamp with time zone,
  "internal_notes" text,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "service_inquiries_created_at_idx" ON ${q}."service_inquiries" ("created_at");

CREATE TABLE IF NOT EXISTS ${q}."partners" (
  "id" serial PRIMARY KEY NOT NULL,
  "user_id" text NOT NULL,
  "company_name" text,
  "legal_name" text,
  "tax_id" varchar(32),
  "vat_id" varchar(32),
  "registration_number" varchar(64),
  "contact_email" text,
  "contact_phone" varchar(32),
  "website_url" text,
  "address_line1" text,
  "address_line2" text,
  "city" text,
  "region" text,
  "postal_code" varchar(20),
  "country" varchar(2) DEFAULT 'DE',
  "service_areas" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "services" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "iban" varchar(34),
  "bic" varchar(11),
  "commission_rate" numeric(5, 2),
  "status" varchar(16) DEFAULT 'pending' NOT NULL,
  "approved_at" timestamp with time zone,
  "approved_by_user_id" text,
  "suspended_at" timestamp with time zone,
  "internal_notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);

CREATE TABLE IF NOT EXISTS ${q}."chat_conversations" (
  "id" serial PRIMARY KEY NOT NULL,
  "partner_user_id" text NOT NULL,
  "last_message_at" timestamp with time zone,
  "last_message_preview" text,
  "unread_for_admin" integer DEFAULT 0 NOT NULL,
  "unread_for_partner" integer DEFAULT 0 NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "chat_conversations_partner_user_id_idx" ON ${q}."chat_conversations" ("partner_user_id");

CREATE TABLE IF NOT EXISTS ${q}."chat_messages" (
  "id" serial PRIMARY KEY NOT NULL,
  "conversation_id" integer NOT NULL REFERENCES ${q}."chat_conversations"("id") ON DELETE CASCADE,
  "sender_user_id" text NOT NULL,
  "sender_role" varchar(16) NOT NULL,
  "body" text,
  "attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "delivered_at" timestamp with time zone,
  "read_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "chat_messages_conversation_id_idx" ON ${q}."chat_messages" ("conversation_id");
CREATE INDEX IF NOT EXISTS "chat_messages_created_at_idx" ON ${q}."chat_messages" ("created_at");

CREATE TABLE IF NOT EXISTS ${q}."orders" (
  "id" serial PRIMARY KEY NOT NULL,
  "public_token" text NOT NULL,
  "kind" varchar(32) NOT NULL,
  "status" varchar(24) DEFAULT 'pending' NOT NULL,
  "currency" varchar(3) DEFAULT 'EUR' NOT NULL,
  "subtotal_cents" integer NOT NULL,
  "pickup_fee_cents" integer DEFAULT 0 NOT NULL,
  "min_order_top_up_cents" integer DEFAULT 0 NOT NULL,
  "total_cents" integer NOT NULL,
  "pickup_mode" varchar(16) NOT NULL,
  "pickup_zone" integer,
  "pickup_plz" varchar(5),
  "pickup_label" text,
  "preferred_date" date,
  "customer_name" text NOT NULL,
  "customer_email" text NOT NULL,
  "customer_phone" varchar(32),
  "address_line1" text,
  "address_line2" text,
  "address_city" text,
  "address_postal_code" varchar(16),
  "address_country" varchar(2) DEFAULT 'DE',
  "customer_notes" text,
  "internal_notes" text,
  "stripe_session_id" text,
  "stripe_payment_intent_id" text,
  "paid_at" timestamp with time zone,
  "accepted_at" timestamp with time zone,
  "picked_up_at" timestamp with time zone,
  "in_cleaning_at" timestamp with time zone,
  "ready_at" timestamp with time zone,
  "delivered_at" timestamp with time zone,
  "completed_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "refunded_at" timestamp with time zone,
  "handled_by_user_id" text,
  "consent_privacy" boolean DEFAULT false NOT NULL,
  "consent_marketing" boolean DEFAULT false NOT NULL,
  "locale" varchar(16) DEFAULT 'de' NOT NULL,
  "source" varchar(64),
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "ip_address" text,
  "user_agent" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "${schemaName}_orders_public_token_unique" UNIQUE("public_token")
);
CREATE INDEX IF NOT EXISTS "orders_created_at_idx" ON ${q}."orders" ("created_at");
CREATE INDEX IF NOT EXISTS "orders_status_idx" ON ${q}."orders" ("status");
CREATE INDEX IF NOT EXISTS "orders_stripe_session_id_idx" ON ${q}."orders" ("stripe_session_id");

CREATE TABLE IF NOT EXISTS ${q}."order_items" (
  "id" serial PRIMARY KEY NOT NULL,
  "order_id" integer NOT NULL REFERENCES ${q}."orders"("id") ON DELETE CASCADE,
  "code" varchar(64) NOT NULL,
  "label" text NOT NULL,
  "quantity_label" text NOT NULL,
  "quantity" numeric(10, 2) NOT NULL,
  "unit_price_cents" integer NOT NULL,
  "subtotal_cents" integer NOT NULL,
  "metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "order_items_order_id_idx" ON ${q}."order_items" ("order_id");

CREATE TABLE IF NOT EXISTS ${q}."order_status_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "order_id" integer NOT NULL REFERENCES ${q}."orders"("id") ON DELETE CASCADE,
  "from_status" varchar(24),
  "to_status" varchar(24) NOT NULL,
  "changed_by_user_id" text,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "order_status_log_order_id_idx" ON ${q}."order_status_log" ("order_id");
`;
}
