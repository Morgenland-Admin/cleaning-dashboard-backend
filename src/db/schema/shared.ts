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

// Better Auth core tables. Field names follow Better Auth's expected adapter schema.
// audience gates which dashboard the user can log into; access drives
// granular RBAC inside the admin dashboard.
export const user = pgTable('user', {
  id: text('id').primaryKey(),
  // Display name (used by Better Auth) — usually "firstName lastName".
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
  // Authorization
  audience: varchar('audience', { length: 16 }).notNull().default('customer'), // admin | partner | customer
  accessLevel: varchar('access_level', { length: 32 }).notNull().default('none'), // super_admin | admin | manager | viewer | none
  isActive: boolean('is_active').notNull().default(true),
  // Lifecycle / audit
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

// Multi-address per user. Allows separate billing / service / shipping addresses.
export const address = pgTable('address', {
  id: serial('id').primaryKey(),
  userId: text('user_id')
    .notNull()
    .references(() => user.id, { onDelete: 'cascade' }),
  label: text('label'), // e.g. "Home", "Office"
  type: varchar('type', { length: 16 }).notNull().default('primary'), // primary | billing | service | shipping | other
  line1: text('line1').notNull(),
  line2: text('line2'),
  city: text('city').notNull(),
  region: text('region'), // Bundesland / state
  postalCode: varchar('postal_code', { length: 20 }).notNull(),
  country: varchar('country', { length: 2 }).notNull().default('DE'),
  isDefault: boolean('is_default').notNull().default(false),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Companies registry — source of truth for tenants. Includes branding + legal info
// so the storefronts and admin dashboard can render company-specific data.
export const company = pgTable('company', {
  slug: varchar('slug', { length: 64 }).primaryKey(),
  name: text('name').notNull(),
  legalName: text('legal_name'),
  schemaName: varchar('schema_name', { length: 64 }).notNull().unique(),
  // Contact
  email: text('email'),
  phone: varchar('phone', { length: 32 }),
  websiteUrl: text('website_url'),
  // Address
  addressLine1: text('address_line1'),
  addressLine2: text('address_line2'),
  city: text('city'),
  region: text('region'),
  postalCode: varchar('postal_code', { length: 20 }),
  country: varchar('country', { length: 2 }).default('DE'),
  // Legal (German business identifiers)
  vatId: varchar('vat_id', { length: 32 }), // USt-IdNr.
  registrationNumber: varchar('registration_number', { length: 64 }), // Handelsregisternummer
  // Branding
  logoUrl: text('logo_url'),
  primaryColor: varchar('primary_color', { length: 9 }), // #rrggbb / #rrggbbaa
  // Email sender — used as the "From" address when this brand sends customer email.
  senderEmail: text('sender_email'),
  senderName: text('sender_name'),
  // S3 top-level folder for this brand's uploads (shared bucket, one folder
  // per brand). Hyphenated; defaults to the slug if unset.
  keyPrefix: varchar('key_prefix', { length: 64 }),
  // Origin (scheme + host) of the public storefront site that submits to the
  // /storefront/* endpoints — added to the dynamic CORS allow-list.
  storefrontOrigin: text('storefront_origin'),
  // Status
  isActive: boolean('is_active').notNull().default(true),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
});

// Membership: which users have access to which companies. Per-company role
// determines what they can do within that tenant's data.
export const membership = pgTable(
  'membership',
  {
    userId: text('user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    companySlug: varchar('company_slug', { length: 64 })
      .notNull()
      .references(() => company.slug, { onDelete: 'cascade' }),
    role: varchar('role', { length: 32 }).notNull().default('viewer'), // owner | admin | manager | viewer | partner
    invitedByUserId: text('invited_by_user_id'),
    invitedAt: timestamp('invited_at', { withTimezone: true }),
    acceptedAt: timestamp('accepted_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    pk: primaryKey({ columns: [t.userId, t.companySlug] }),
  }),
);

// User preferences — keyed by user, not tenant-scoped.
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

// Web Push subscriptions — keyed per user + endpoint. A single user typically
// has one entry per device/browser. Endpoint URLs from push services (FCM,
// Mozilla, Apple) are unique so we treat them as the natural identifier.
//
// On insert conflict on endpoint we refresh the keys + lastUsedAt and re-
// attach to the user (a user can change browsers; we never want orphaned
// rows). On a 410 Gone from the push service we delete the row.
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

// ---------------------------------------------------------------------------
// Tasks — admin work queue (ALL_103).
//
// One shared table across all brands. Rows are scoped to a brand via
// `companySlug`; operators see only tasks for brands they have membership
// in (enforced by the admin route handler).
//
// Tasks are typically auto-spawned by other modules:
//   - contact.created  → kind="contact_review"
//   - inquiry.created  → kind="inquiry_review"
//   - order.disputed   → kind="dispute"  (future)
//   - review.bad       → kind="bad_review_followup"  (future)
//
// Idempotency: (companySlug, refKind, refId) is unique — the same source
// event can't spawn two tasks. Status: open | in_progress | done | dismissed.
// ---------------------------------------------------------------------------
export const tasks = pgTable(
  'tasks',
  {
    id: serial('id').primaryKey(),
    companySlug: varchar('company_slug', { length: 63 })
      .notNull()
      .references(() => company.slug, { onDelete: 'cascade' }),
    kind: varchar('kind', { length: 64 }).notNull(),
    /** Free-form reference key — usually the source table name. */
    refKind: varchar('ref_kind', { length: 64 }),
    /** ID of the source row this task refers to. Stored as int for joins. */
    refId: integer('ref_id'),
    title: text('title').notNull(),
    body: text('body'),
    status: varchar('status', { length: 16 }).notNull().default('open'),
    priority: varchar('priority', { length: 16 }).notNull().default('normal'),
    assigneeUserId: text('assignee_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    /** Soft deadline (display only). */
    dueAt: timestamp('due_at', { withTimezone: true }),
    /** Set when transitioning to done/dismissed. */
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    resolvedByUserId: text('resolved_by_user_id').references(() => user.id, {
      onDelete: 'set null',
    }),
    metadata: jsonb('metadata').default({}).notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // One task per source event — guarantees we don't double-spawn.
    refUnique: uniqueIndex('tasks_ref_unique_idx').on(t.companySlug, t.refKind, t.refId),
    // Hot path: "open tasks for brand X by created_at desc"
    openByBrand: index('tasks_brand_status_created_idx').on(t.companySlug, t.status, t.createdAt),
    // Hot path: "tasks assigned to me"
    byAssignee: index('tasks_assignee_idx').on(t.assigneeUserId, t.status),
  }),
);

// ---------------------------------------------------------------------------
// Export jobs — async data-export queue (ALL_74).
//
// One table doubles as queue + state machine + result-store. A single in-
// process worker polls every 5s for pending jobs, generates CSV (streaming
// to S3), and flips state to done. No Redis dependency.
//
// Status FSM: pending → processing → done | failed | cancelled
// Job auto-expires (and S3 object is purged by lifecycle policy) 30 days
// after completion — they contain customer PII and shouldn't linger.
// ---------------------------------------------------------------------------
// Comments on a task — small audit-friendly thread.
// Append-only by design: no edit/delete endpoints, so the resolution
// trail is trustworthy. If a wrong comment lands, add a follow-up.
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
    // Hot path: render a task's thread sorted oldest → newest.
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
    /** Who requested it — for audit + so they can fetch their own jobs. */
    requestedByUserId: text('requested_by_user_id')
      .notNull()
      .references(() => user.id, { onDelete: 'cascade' }),
    /** What to export: orders | inquiries | contacts | newsletter | partners. */
    kind: varchar('kind', { length: 32 }).notNull(),
    /** Period + brand-filter knobs serialized to JSON (validated in routes). */
    filter: jsonb('filter').default({}).notNull(),
    /** Output format: csv (default) | xlsx (future). */
    format: varchar('format', { length: 8 }).notNull().default('csv'),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    /** Populated as worker progresses — drives a progress bar in the UI. */
    rowCount: integer('row_count'),
    /** Populated on done — full S3 key including company prefix. */
    s3Key: text('s3_key'),
    sizeBytes: bigint('size_bytes', { mode: 'number' }),
    errorMessage: text('error_message'),
    startedAt: timestamp('started_at', { withTimezone: true }),
    completedAt: timestamp('completed_at', { withTimezone: true }),
    /** Hard expiry — past this we hide the download link in the UI even if S3
     *  still has the object (the lifecycle policy handles physical deletion). */
    expiresAt: timestamp('expires_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (t) => ({
    // Worker polls "next pending job, oldest first."
    pendingByCreated: index('export_jobs_pending_idx').on(t.status, t.createdAt),
    // Admin UI: my recent jobs.
    byRequester: index('export_jobs_requester_idx').on(t.requestedByUserId, t.createdAt),
  }),
);
