import {
  bigint,
  boolean,
  date,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  serial,
  text,
  timestamp,
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

import type { EmailSignature } from '../../email/templates.js';

export const user = pgTable('user', {
  id: text('id').primaryKey(),
  name: text('name').notNull(),
  firstName: text('first_name'),
  lastName: text('last_name'),
  email: text('email').notNull().unique(),
  emailVerified: boolean('email_verified').notNull().default(false),
  phone: varchar('phone', { length: 32 }),
  phoneVerified: boolean('phone_verified').notNull().default(false),
  image: text('image'),
  dateOfBirth: date('date_of_birth'),
  gender: varchar('gender', { length: 16 }),
  locale: varchar('locale', { length: 16 }).notNull().default('de'),
  timezone: varchar('timezone', { length: 64 }).notNull().default('Europe/Berlin'),
  audience: varchar('audience', { length: 16 }).notNull().default('customer'),
  accessLevel: varchar('access_level', { length: 32 }).notNull().default('none'),
  isActive: boolean('is_active').notNull().default(true),
  lastLoginAt: timestamp('last_login_at', { withTimezone: true }),
  invitedByUserId: text('invited_by_user_id'),
  internalNotes: text('internal_notes'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const session = pgTable('session', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  token: text('token').notNull().unique(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  ipAddress: text('ip_address'),
  userAgent: text('user_agent'),
  activeCompanySlug: varchar('active_company_slug', { length: 64 }),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const account = pgTable('account', {
  id: text('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  accountId: text('account_id').notNull(),
  providerId: text('provider_id').notNull(),
  accessToken: text('access_token'),
  refreshToken: text('refresh_token'),
  accessTokenExpiresAt: timestamp('access_token_expires_at', { withTimezone: true }),
  refreshTokenExpiresAt: timestamp('refresh_token_expires_at', { withTimezone: true }),
  scope: text('scope'),
  idToken: text('id_token'),
  password: text('password'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const verification = pgTable('verification', {
  id: text('id').primaryKey(),
  identifier: text('identifier').notNull(),
  value: text('value').notNull(),
  expiresAt: timestamp('expires_at', { withTimezone: true }).notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const address = pgTable('address', {
  id: serial('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  label: text('label'),
  type: varchar('type', { length: 16 }).notNull().default('primary'),
  line1: text('line1').notNull(),
  line2: text('line2'),
  city: text('city').notNull(),
  region: text('region'),
  postalCode: varchar('postal_code', { length: 20 }).notNull(),
  country: varchar('country', { length: 2 }).notNull().default('DE'),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const company = pgTable('company', {
  slug: varchar('slug', { length: 64 }).primaryKey(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  schemaName: varchar('schema_name', { length: 64 }).notNull().unique(),
  email: text('email'),
  phone: varchar('phone', { length: 32 }),
  websiteUrl: text('website_url'),
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  region: text('region'),
  postalCode: varchar('postal_code', { length: 20 }),
  country: varchar('country', { length: 2 }).default('DE'),
  vatId: varchar('vat_id', { length: 32 }),
  registrationNumber: varchar('registration_number', { length: 64 }),
  taxNumber: varchar('tax_number', { length: 32 }), // Steuernummer; not printed on invoices
  businessId: varchar('business_id', { length: 32 }), // Betriebsnummer
  legalForm: varchar('legal_form', { length: 64 }), // Rechtsform, e.g. GbR
  managingDirectors: text('managing_directors'), // Geschäftsführer / Inhaber
  chamber: text('chamber'),
  mobile: varchar('mobile', { length: 32 }),
  accountHolder: text('account_holder'),
  iban: varchar('iban', { length: 34 }),
  bic: varchar('bic', { length: 11 }),
  bankName: text('bank_name'),
  bankAddress: text('bank_address'),
  // Per-brand counter "<prefix>-<n>" (e.g. "CL-1426"), bumped atomically at issue (modules/invoices/number.ts).
  // Nullable so the boot seed can coalesce a start value without resetting a live counter.
  invoiceNumberPrefix: varchar('invoice_number_prefix', { length: 8 }),
  invoiceNumberNext: integer('invoice_number_next'),
  emailSignature: jsonb('email_signature').$type<EmailSignature>(),
  logoUrl: text('logo_url'),
  // Wide wordmark for invoice PDF + email header; falls back to logoUrl (square avatar).
  invoiceLogoUrl: text('invoice_logo_url'),
  primaryColor: varchar('primary_color', { length: 9 }),
  senderEmail: text('sender_email'),
  senderName: text('sender_name'),
  resendApiKey: text('resend_api_key'),
  // Signing secret of this brand's Resend webhook; never returned over the API.
  resendWebhookSecret: text('resend_webhook_secret'),
  keyPrefix: varchar('key_prefix', { length: 64 }),
  storefrontOrigin: text('storefront_origin'),
  // Off = a paid order's automatic invoice stays a draft so an operator can add positions
  // agreed after booking, then finalise (modules/invoices/from-order.ts).
  autoIssueInvoices: boolean('auto_issue_invoices').notNull().default(true),
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const membership = pgTable(
  'membership',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    companySlug: varchar('company_slug', { length: 64 })
      .notNull()
      .references(() => company.slug, { onDelete: 'cascade' }),
    role: varchar('role', { length: 32 }).notNull().default('viewer'),
    invitedByUserId: text('invited_by_user_id'),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.companySlug] }),
  }),
);

export const userSettings = pgTable('user_settings', {
  userId: text('user_id')
    .primaryKey()
    .references(() => user.id, { onDelete: 'cascade' }),
  locale: varchar('locale', { length: 16 }).notNull().default('de'),
  theme: varchar('theme', { length: 16 }).notNull().default('system'),
  notificationsEmail: boolean('notifications_email').notNull().default(true),
  notificationsSms: boolean('notifications_sms').notNull().default(false),
  marketingOptIn: boolean('marketing_opt_in').notNull().default(false),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

export const pushSubscriptions = pgTable('push_subscriptions', {
  id: serial('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  endpoint: text('endpoint').notNull().unique(),
  p256dh: text('p256dh').notNull(),
  auth: text('auth').notNull(),
  userAgent: text('user_agent'),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  lastUsedAt: timestamp('last_used_at', { withTimezone: true }).notNull().defaultNow(),
});

export const tasks = pgTable(
  'tasks',
  {
    id: serial('id').primaryKey(),
    companySlug: varchar('company_slug', { length: 63 })
      .notNull()
      .references(() => company.slug, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 64 }).notNull(),
    refKind: varchar('ref_kind', { length: 64 }),
    refId: integer('ref_id'),
    title: text('title').notNull(),
    body: text('body'),
    status: varchar('status', { length: 16 }).notNull().default('open'),
    priority: varchar('priority', { length: 16 }).notNull().default('normal'),
    assigneeUserId: text('assignee_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    dueAt: timestamp('due_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByUserId: text('resolved_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    refUnique: uniqueIndex('tasks_ref_unique_idx').on(t.companySlug, t.refKind, t.refId),
    openByBrand: index('tasks_brand_status_created_idx').on(t.companySlug, t.status, t.createdAt),
    byAssignee: index('tasks_assignee_idx').on(t.assigneeUserId, t.status),
  }),
);

export const taskComments = pgTable(
  'task_comments',
  {
    id: serial('id').primaryKey(),
    taskId: integer('task_id')
      .notNull()
      .references(() => tasks.id, { onDelete: 'cascade' }),
    authorUserId: text('author_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'set null' }),
    body: text('body').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    byTask: index('task_comments_task_idx').on(t.taskId, t.createdAt),
  }),
);

export const exportJobs = pgTable(
  'export_jobs',
  {
    id: serial('id').primaryKey(),
    companySlug: varchar('company_slug', { length: 63 })
      .notNull()
      .references(() => company.slug, { onDelete: 'cascade' }),
    requestedByUserId: text('requested_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 32 }).notNull(),
    filter: jsonb('filter').default({}).notNull(),
    format: varchar('format', { length: 8 }).notNull().default('csv'),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    rowCount: integer('row_count'),
    s3Key: text('s3_key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pendingByCreated: index('export_jobs_pending_idx').on(t.status, t.createdAt),
    byRequester: index('export_jobs_requester_idx').on(t.requestedByUserId, t.createdAt),
  }),
);

/** Per-brand "✦ Claude" prompt overrides; no row = code default. Output-format rules are appended server-side, not stored. */
export const aiPrompts = pgTable(
  'ai_prompts',
  {
    id: serial('id').primaryKey(),
    companySlug: varchar('company_slug', { length: 63 })
      .notNull()
      .references(() => company.slug, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 64 }).notNull(),
    body: text('body').notNull(),
    updatedByUserId: text('updated_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    brandKindUnique: uniqueIndex('ai_prompts_brand_kind_unique_idx').on(t.companySlug, t.kind),
  }),
);

/** One Resend webhook event as kept on an `email_log` row. */
export interface EmailLogEvent {
  /** Resend event type without the "email." prefix, e.g. "delivered". */
  type: string;
  /** ISO 8601, as reported by Resend. */
  at: string;
  /** Bounce / failure / suppression reason, or the clicked link. */
  detail?: string;
}

/**
 * One row per send, written by `sendEmail`; delivery columns come from the Resend webhook
 * (modules/emails/webhook.ts). Permanent record: Resend keeps only 30 days, per brand account.
 */
export const emailLog = pgTable(
  'email_log',
  {
    id: serial('id').primaryKey(),
    // Null = platform mail that belongs to no brand (password reset).
    companySlug: varchar('company_slug', { length: 63 }).references(() => company.slug, {
      onDelete: 'set null',
    }),
    kind: varchar('kind', { length: 32 }).notNull(),
    toAddress: text('to_address').notNull(),
    fromAddress: text('from_address').notNull(),
    replyTo: text('reply_to'),
    subject: text('subject').notNull(),
    // Body as sent; null for mail carrying a live secret (reset, invite, opt-in link), see email/log.ts.
    html: text('html'),
    attachments: jsonb('attachments')
      .$type<Array<{ filename: string; size: number }>>()
      .notNull()
      .default([]),
    // 'sending' | 'sent' | 'failed' | 'skipped' (no Resend key) | 'blocked' (placeholder address).
    status: varchar('status', { length: 16 }).notNull().default('sending'),
    error: text('error'),
    resendId: text('resend_id'),
    // Latest Resend state: 'sent' | 'delivered' | 'delivery_delayed' | 'bounced' | 'complained' | 'failed' | 'suppressed'.
    deliveryStatus: varchar('delivery_status', { length: 24 }),
    deliveredAt: timestamp('delivered_at', { withTimezone: true }),
    openedAt: timestamp('opened_at', { withTimezone: true }),
    clickedAt: timestamp('clicked_at', { withTimezone: true }),
    events: jsonb('events').$type<EmailLogEvent[]>().notNull().default([]),
    // Subject row in the brand's tenant schema: 'order' | 'invoice' | 'inquiry' | 'contact' | 'task'.
    refType: varchar('ref_type', { length: 16 }),
    refId: integer('ref_id'),
    sentByUserId: text('sent_by_user_id').references(() => user.id, { onDelete: 'set null' }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    brandCreatedIdx: index('email_log_brand_created_idx').on(t.companySlug, t.createdAt),
    createdIdx: index('email_log_created_idx').on(t.createdAt),
    resendIdUnique: uniqueIndex('email_log_resend_id_unique_idx').on(t.resendId),
    refIdx: index('email_log_ref_idx').on(t.companySlug, t.refType, t.refId),
  }),
);
