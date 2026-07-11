import { sql } from 'drizzle-orm';
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
  uniqueIndex,
  varchar,
} from 'drizzle-orm/pg-core';

function buildTenantTables(schemaName: string) {
  const s = pgSchema(schemaName);

  const newsletterSubscribers = s.table('newsletter_subscribers', {
    id: serial('id').primaryKey(),
    email: text('email').notNull().unique(),
    customerId: integer('customer_id'),
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
      customerId: integer('customer_id'),
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
      customerId: integer('customer_id'),
      name: text('name').notNull(),
      // Nullable: voice-AI phone leads often have no email (phone is the contact).
      email: text('email'),
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
      // Service PLZ (where the cleaning happens) — drives geo callback routing.
      plz: varchar('plz', { length: 5 }),
      // Free-text "Grund des Anrufs" captured by the inbound voice-AI.
      callReason: text('call_reason'),
      // Geo routing: 'human' (within radius of Hamburg) | 'ai' (warm-callback
      // queue). Null on legacy rows created before routing existed.
      callbackOwner: varchar('callback_owner', { length: 8 }),
      // User who owns a human callback. A plain user pointer (not a "Kabir"
      // flag) so leads can be distributed across reps without a schema change.
      assignedTo: text('assigned_to'),
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
      callbackOwnerIdx: index('service_inquiries_callback_owner_idx').on(table.callbackOwner),
    }),
  );

  // Log of emails sent to a lead from the dashboard (currently quotes/offers).
  // Mail goes out via Resend, which never lands a copy in the brand mailbox, so
  // this table is the in-app system of record. We persist the rendered HTML so
  // the operator can preview exactly what the customer received.
  const inquiryEmails = s.table(
    'inquiry_emails',
    {
      id: serial('id').primaryKey(),
      inquiryId: integer('inquiry_id')
        .notNull()
        .references(() => serviceInquiries.id, { onDelete: 'cascade' }),
      kind: varchar('kind', { length: 24 }).notNull().default('quote'),
      toAddress: text('to_address').notNull(),
      subject: text('subject').notNull(),
      html: text('html').notNull(),
      quotedAmount: numeric('quoted_amount', { precision: 12, scale: 2 }),
      // 'sent' | 'skipped' (no Resend key) | 'failed'
      status: varchar('status', { length: 16 }).notNull().default('sent'),
      emailMessageId: text('email_message_id'),
      sentByUserId: text('sent_by_user_id'),
      sentByName: text('sent_by_name'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      inquiryIdIdx: index('inquiry_emails_inquiry_id_idx').on(table.inquiryId),
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
    stripeConnectId: text('stripe_connect_id'),
    stripeConnectStatus: varchar('stripe_connect_status', { length: 16 }).notNull().default('none'),
    chargesEnabled: boolean('charges_enabled').notNull().default(false),
    payoutsEnabled: boolean('payouts_enabled').notNull().default(false),
    tier: varchar('tier', { length: 16 }).notNull().default('basic'),
    monthlyFeeCents: integer('monthly_fee_cents').notNull().default(0),
    rating: numeric('rating', { precision: 3, scale: 2 }),
    ratingCount: integer('rating_count').notNull().default(0),
    score: integer('score'),
    status: varchar('status', { length: 16 }).notNull().default('pending'),
    approvedAt: timestamp('approved_at', { withTimezone: true }),
    approvedByUserId: text('approved_by_user_id'),
    suspendedAt: timestamp('suspended_at', { withTimezone: true }),
    internalNotes: text('internal_notes'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
  });

  const chatConversations = s.table(
    'chat_conversations',
    {
      id: serial('id').primaryKey(),
      partnerUserId: text('partner_user_id').notNull(),
      lastMessageAt: timestamp('last_message_at', { withTimezone: true }),
      lastMessagePreview: text('last_message_preview'),
      unreadForAdmin: integer('unread_for_admin').notNull().default(0),
      unreadForPartner: integer('unread_for_partner').notNull().default(0),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      partnerUserIdx: index('chat_conversations_partner_user_id_idx').on(table.partnerUserId),
    }),
  );

  const chatMessages = s.table(
    'chat_messages',
    {
      id: serial('id').primaryKey(),
      conversationId: integer('conversation_id')
        .notNull()
        .references(() => chatConversations.id, { onDelete: 'cascade' }),
      senderUserId: text('sender_user_id').notNull(),
      senderRole: varchar('sender_role', { length: 16 }).notNull(),
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

  const orders = s.table(
    'orders',
    {
      id: serial('id').primaryKey(),
      publicToken: text('public_token').notNull().unique(),
      customerId: integer('customer_id'),
      /** Customer-facing "YYYY/000123", stamped at creation (year never drifts). */
      orderNumber: varchar('order_number', { length: 20 }),
      kind: varchar('kind', { length: 32 }).notNull(),
      status: varchar('status', { length: 24 }).notNull().default('pending'),

      currency: varchar('currency', { length: 3 }).notNull().default('EUR'),
      subtotalCents: integer('subtotal_cents').notNull(),
      pickupFeeCents: integer('pickup_fee_cents').notNull().default(0),
      minOrderTopUpCents: integer('min_order_top_up_cents').notNull().default(0),
      discountCents: integer('discount_cents').notNull().default(0),
      voucherCode: text('voucher_code'),
      totalCents: integer('total_cents').notNull(),
      refundedAmountCents: integer('refunded_amount_cents').notNull().default(0),

      assignedPartnerId: integer('assigned_partner_id'),
      assignedAt: timestamp('assigned_at', { withTimezone: true }),
      commissionCents: integer('commission_cents'),
      partnerPayoutCents: integer('partner_payout_cents'),
      payoutStatus: varchar('payout_status', { length: 16 }).notNull().default('none'),
      stripeTransferId: text('stripe_transfer_id'),
      payoutAt: timestamp('payout_at', { withTimezone: true }),

      pickupMode: varchar('pickup_mode', { length: 16 }).notNull(),
      pickupZone: integer('pickup_zone'),
      pickupPlz: varchar('pickup_plz', { length: 5 }),
      pickupLabel: text('pickup_label'),
      preferredDate: date('preferred_date'),

      customerName: text('customer_name').notNull(),
      customerEmail: text('customer_email').notNull(),
      customerPhone: varchar('customer_phone', { length: 32 }),

      addressLine1: text('address_line1'),
      addressLine2: text('address_line2'),
      addressCity: text('address_city'),
      addressPostalCode: varchar('address_postal_code', { length: 16 }),
      addressCountry: varchar('address_country', { length: 2 }).default('DE'),

      customerNotes: text('customer_notes'),
      internalNotes: text('internal_notes'),

      stripeSessionId: text('stripe_session_id'),
      stripePaymentIntentId: text('stripe_payment_intent_id'),

      paymentProvider: varchar('payment_provider', { length: 16 }).notNull().default('stripe'),
      paypalOrderId: text('paypal_order_id'),
      paypalCaptureId: text('paypal_capture_id'),

      paymentMode: varchar('payment_mode', { length: 16 }).notNull().default('upfront'),
      paymentMethod: varchar('payment_method', { length: 24 }),

      paidAt: timestamp('paid_at', { withTimezone: true }),
      acceptedAt: timestamp('accepted_at', { withTimezone: true }),
      pickedUpAt: timestamp('picked_up_at', { withTimezone: true }),
      inCleaningAt: timestamp('in_cleaning_at', { withTimezone: true }),
      readyAt: timestamp('ready_at', { withTimezone: true }),
      deliveredAt: timestamp('delivered_at', { withTimezone: true }),
      completedAt: timestamp('completed_at', { withTimezone: true }),
      cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
      refundedAt: timestamp('refunded_at', { withTimezone: true }),

      handledByUserId: text('handled_by_user_id'),

      consentPrivacy: boolean('consent_privacy').notNull().default(false),
      consentMarketing: boolean('consent_marketing').notNull().default(false),

      locale: varchar('locale', { length: 16 }).notNull().default('de'),
      source: varchar('source', { length: 64 }),

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
      stripePaymentIntentIdx: index('orders_stripe_payment_intent_idx').on(
        table.stripePaymentIntentId,
      ),
      paypalOrderIdx: index('orders_paypal_order_id_idx').on(table.paypalOrderId),
      stripeTransferIdx: index('orders_stripe_transfer_idx').on(table.stripeTransferId),
      assignedPartnerIdx: index('orders_assigned_partner_idx').on(table.assignedPartnerId),
    }),
  );

  const orderItems = s.table(
    'order_items',
    {
      id: serial('id').primaryKey(),
      orderId: integer('order_id')
        .notNull()
        .references(() => orders.id, { onDelete: 'cascade' }),
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

  const customers = s.table(
    'customers',
    {
      id: serial('id').primaryKey(),
      email: text('email').notNull().unique(),
      name: text('name'),
      phone: varchar('phone', { length: 32 }),
      addressLine1: text('address_line1'),
      addressLine2: text('address_line2'),
      postalCode: varchar('postal_code', { length: 16 }),
      city: text('city'),
      country: varchar('country', { length: 2 }).default('DE'),
      totalOrders: integer('total_orders').notNull().default(0),
      totalSpentCents: integer('total_spent_cents').notNull().default(0),
      loyaltyTier: varchar('loyalty_tier', { length: 16 }).notNull().default('neukunde'),
      tags: jsonb('tags').$type<string[]>().notNull().default([]),
      internalNotes: text('internal_notes'),
      firstOrderAt: timestamp('first_order_at', { withTimezone: true }),
      lastOrderAt: timestamp('last_order_at', { withTimezone: true }),
      marketingOptIn: boolean('marketing_opt_in').notNull().default(false),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      tierIdx: index('customers_loyalty_tier_idx').on(table.loyaltyTier),
    }),
  );

  const reviews = s.table(
    'reviews',
    {
      id: serial('id').primaryKey(),
      orderId: integer('order_id'),
      partnerId: integer('partner_id'),
      customerEmail: text('customer_email'),
      customerName: text('customer_name'),
      rating: integer('rating').notNull(),
      comment: text('comment'),
      photos: jsonb('photos').$type<string[]>().notNull().default([]),
      status: varchar('status', { length: 16 }).notNull().default('new'),
      partnerResponse: text('partner_response'),
      respondedAt: timestamp('responded_at', { withTimezone: true }),
      flagged: boolean('flagged').notNull().default(false),
      flagReason: text('flag_reason'),
      source: varchar('source', { length: 32 }),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      statusIdx: index('reviews_status_idx').on(table.status),
      partnerIdx: index('reviews_partner_idx').on(table.partnerId),
    }),
  );

  const subscriptions = s.table(
    'subscriptions',
    {
      id: serial('id').primaryKey(),
      customerEmail: text('customer_email').notNull(),
      customerName: text('customer_name'),
      planName: text('plan_name').notNull(),
      monthlyPriceCents: integer('monthly_price_cents').notNull().default(0),
      intervalMonths: integer('interval_months').notNull().default(1),
      stripeSubscriptionId: text('stripe_subscription_id'),
      status: varchar('status', { length: 16 }).notNull().default('active'),
      servicesIncluded: jsonb('services_included').$type<string[]>().notNull().default([]),
      nextServiceDate: date('next_service_date'),
      pausedAt: timestamp('paused_at', { withTimezone: true }),
      cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      statusIdx: index('subscriptions_status_idx').on(table.status),
      emailIdx: index('subscriptions_email_idx').on(table.customerEmail),
    }),
  );

  const invoices = s.table(
    'invoices',
    {
      id: serial('id').primaryKey(),
      number: varchar('number', { length: 64 }),
      orderId: integer('order_id'),
      partnerId: integer('partner_id'),
      customerType: varchar('customer_type', { length: 8 }).notNull().default('b2c'),
      recipientName: text('recipient_name').notNull(),
      recipientEmail: text('recipient_email'),
      // §14 UStG: recipient postal address is mandatory on invoices > 250 EUR.
      recipientAddressLine1: text('recipient_address_line1'),
      recipientAddressLine2: text('recipient_address_line2'),
      recipientPostalCode: varchar('recipient_postal_code', { length: 16 }),
      recipientCity: text('recipient_city'),
      recipientCountry: varchar('recipient_country', { length: 2 }).default('DE'),
      // §14 UStG: Leistungsdatum / Leistungszeitraum.
      serviceDate: date('service_date'),
      serviceDateEnd: date('service_date_end'),
      status: varchar('status', { length: 16 }).notNull().default('draft'),
      currency: varchar('currency', { length: 3 }).notNull().default('EUR'),
      subtotalCents: integer('subtotal_cents').notNull().default(0),
      /** VAT rate in percent (0 | 7 | 19). */
      taxRatePercent: integer('tax_rate_percent').notNull().default(19),
      taxCents: integer('tax_cents').notNull().default(0),
      totalCents: integer('total_cents').notNull().default(0),
      lineItems: jsonb('line_items')
        .$type<Array<{ label: string; quantity: number; unitPriceCents: number }>>()
        .notNull()
        .default([]),
      paymentTermsDays: integer('payment_terms_days').notNull().default(7),
      /** How the invoice is settled: 'transfer' (default) | 'card' | 'cash'. */
      paymentMethod: varchar('payment_method', { length: 16 }).notNull().default('transfer'),
      dueAt: timestamp('due_at', { withTimezone: true }),
      sentAt: timestamp('sent_at', { withTimezone: true }),
      paidAt: timestamp('paid_at', { withTimezone: true }),
      dunningLevel: integer('dunning_level').notNull().default(0),
      lastDunningAt: timestamp('last_dunning_at', { withTimezone: true }),
      odooInvoiceId: text('odoo_invoice_id'),
      notes: text('notes'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      statusIdx: index('invoices_status_idx').on(table.status),
      dueIdx: index('invoices_due_idx').on(table.dueAt),
      statusDueIdx: index('invoices_status_due_idx').on(table.status, table.dueAt),
      orderIdUnique: uniqueIndex('invoices_order_id_unique')
        .on(table.orderId)
        .where(sql`${table.orderId} IS NOT NULL`),
      numberUnique: uniqueIndex('invoices_number_unique')
        .on(table.number)
        .where(sql`${table.number} IS NOT NULL`),
    }),
  );

  // GoBD: append-only audit trail of invoice state changes.
  const invoiceStatusLog = s.table(
    'invoice_status_log',
    {
      id: serial('id').primaryKey(),
      invoiceId: integer('invoice_id')
        .notNull()
        .references(() => invoices.id, { onDelete: 'cascade' }),
      fromStatus: varchar('from_status', { length: 16 }),
      toStatus: varchar('to_status', { length: 16 }).notNull(),
      changedByUserId: text('changed_by_user_id'),
      reason: text('reason'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      invoiceIdx: index('invoice_status_log_invoice_id_idx').on(table.invoiceId),
    }),
  );

  // Gapless per-year invoice number sequence (one counter row per year, per
  // tenant). Incremented at ISSUE time so abandoned drafts never burn a number.
  const invoiceCounters = s.table('invoice_counters', {
    year: integer('year').primaryKey(),
    nextValue: integer('next_value').notNull().default(0),
  });

  const cityStatus = s.table(
    'city_status',
    {
      id: serial('id').primaryKey(),
      city: text('city').notNull(),
      plzPrefix: varchar('plz_prefix', { length: 5 }).notNull(),
      status: varchar('status', { length: 16 }).notNull().default('locked'),
      partnerCount: integer('partner_count').notNull().default(0),
      activePartnerCount: integer('active_partner_count').notNull().default(0),
      orderCount30d: integer('order_count_30d').notNull().default(0),
      ordersPerPartner: numeric('orders_per_partner', { precision: 8, scale: 2 }),
      seoPageGenerated: boolean('seo_page_generated').notNull().default(false),
      googleAdsActive: boolean('google_ads_active').notNull().default(false),
      lastStatusChange: timestamp('last_status_change', { withTimezone: true }),
      notes: text('notes'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      plzUnique: uniqueIndex('city_status_plz_unique').on(table.plzPrefix),
    }),
  );

  const priceAdjustments = s.table(
    'price_adjustments',
    {
      id: serial('id').primaryKey(),
      scope: varchar('scope', { length: 16 }).notNull().default('global'),
      scopeKey: varchar('scope_key', { length: 64 }),
      adjustmentPercent: numeric('adjustment_percent', { precision: 5, scale: 2 }).notNull(),
      reason: text('reason'),
      active: boolean('active').notNull().default(true),
      validFrom: timestamp('valid_from', { withTimezone: true }),
      validTo: timestamp('valid_to', { withTimezone: true }),
      createdByUserId: text('created_by_user_id'),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      activeIdx: index('price_adjustments_active_idx').on(table.active),
    }),
  );

  const seoPages = s.table(
    'seo_pages',
    {
      id: serial('id').primaryKey(),
      type: varchar('type', { length: 16 }).notNull().default('service'),
      path: text('path').notNull().unique(),
      category: varchar('category', { length: 64 }),
      city: text('city'),
      region: text('region'),
      title: text('title'),
      metaTitle: text('meta_title'),
      metaDescription: text('meta_description'),
      h1: text('h1'),
      bodyHtml: text('body_html'),
      schemaJsonld: jsonb('schema_jsonld').$type<Record<string, unknown> | unknown[]>(),
      faq: jsonb('faq').$type<Array<{ question: string; answer: string }>>().notNull().default([]),
      status: varchar('status', { length: 16 }).notNull().default('draft'), // draft | live | protected
      gscPosition: numeric('gsc_position', { precision: 5, scale: 2 }),
      source: varchar('source', { length: 64 }),
      createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
      updatedAt: timestamp('updated_at', { withTimezone: true }).notNull().defaultNow(),
    },
    (table) => ({
      pathUnique: uniqueIndex('seo_pages_path_unique').on(table.path),
      statusTypeIdx: index('seo_pages_status_type_idx').on(table.status, table.type),
    }),
  );

  return {
    schema: s,
    newsletterSubscribers,
    contactMessages,
    contactReplies,
    serviceInquiries,
    inquiryEmails,
    partners,
    chatConversations,
    chatMessages,
    orders,
    orderItems,
    orderStatusLog,
    customers,
    reviews,
    subscriptions,
    invoices,
    invoiceStatusLog,
    invoiceCounters,
    cityStatus,
    priceAdjustments,
    seoPages,
  };
}

export type TenantTables = ReturnType<typeof buildTenantTables>;

/** Memoized accessor — admin-created companies resolve their tables at runtime. */
const tenantCache = new Map<string, TenantTables>();
export function getTenantTables(schemaName: string): TenantTables {
  let cached = tenantCache.get(schemaName);
  if (!cached) {
    cached = buildTenantTables(schemaName);
    tenantCache.set(schemaName, cached);
  }
  return cached;
}

const _cleanilo = getTenantTables('cleanilo');
const _hamburg = getTenantTables('hamburg_teppichreinigung');
const _teppichreinigenLassen = getTenantTables('teppichreinigen_lassen');

export const cleaniloSchema = _cleanilo.schema;
export const cleaniloNewsletterSubscribers = _cleanilo.newsletterSubscribers;
export const cleaniloContactMessages = _cleanilo.contactMessages;
export const cleaniloContactReplies = _cleanilo.contactReplies;
export const cleaniloServiceInquiries = _cleanilo.serviceInquiries;
export const cleaniloInquiryEmails = _cleanilo.inquiryEmails;
export const cleaniloPartners = _cleanilo.partners;

export const hamburgSchema = _hamburg.schema;
export const hamburgNewsletterSubscribers = _hamburg.newsletterSubscribers;
export const hamburgContactMessages = _hamburg.contactMessages;
export const hamburgContactReplies = _hamburg.contactReplies;
export const hamburgServiceInquiries = _hamburg.serviceInquiries;
export const hamburgInquiryEmails = _hamburg.inquiryEmails;
export const hamburgPartners = _hamburg.partners;

export const teppichreinigenLassenSchema = _teppichreinigenLassen.schema;
export const teppichreinigenLassenNewsletterSubscribers =
  _teppichreinigenLassen.newsletterSubscribers;
export const teppichreinigenLassenContactMessages = _teppichreinigenLassen.contactMessages;
export const teppichreinigenLassenContactReplies = _teppichreinigenLassen.contactReplies;
export const teppichreinigenLassenServiceInquiries = _teppichreinigenLassen.serviceInquiries;
export const teppichreinigenLassenInquiryEmails = _teppichreinigenLassen.inquiryEmails;
export const teppichreinigenLassenPartners = _teppichreinigenLassen.partners;

export function createTenantSchemaSql(schemaName: string): string {
  const q = `"${schemaName}"`;
  return `
CREATE SCHEMA IF NOT EXISTS ${q};

CREATE TABLE IF NOT EXISTS ${q}."newsletter_subscribers" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "customer_id" integer,
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
  "customer_id" integer,
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
  "customer_id" integer,
  "name" text NOT NULL,
  "email" text,
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
  "plz" varchar(5),
  "call_reason" text,
  "callback_owner" varchar(8),
  "assigned_to" text,
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

CREATE TABLE IF NOT EXISTS ${q}."inquiry_emails" (
  "id" serial PRIMARY KEY NOT NULL,
  "inquiry_id" integer NOT NULL REFERENCES ${q}."service_inquiries"("id") ON DELETE CASCADE,
  "kind" varchar(24) DEFAULT 'quote' NOT NULL,
  "to_address" text NOT NULL,
  "subject" text NOT NULL,
  "html" text NOT NULL,
  "quoted_amount" numeric(12, 2),
  "status" varchar(16) DEFAULT 'sent' NOT NULL,
  "email_message_id" text,
  "sent_by_user_id" text,
  "sent_by_name" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "inquiry_emails_inquiry_id_idx" ON ${q}."inquiry_emails" ("inquiry_id");

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
  "stripe_connect_id" text,
  "stripe_connect_status" varchar(16) DEFAULT 'none' NOT NULL,
  "charges_enabled" boolean DEFAULT false NOT NULL,
  "payouts_enabled" boolean DEFAULT false NOT NULL,
  "tier" varchar(16) DEFAULT 'basic' NOT NULL,
  "monthly_fee_cents" integer DEFAULT 0 NOT NULL,
  "rating" numeric(3, 2),
  "rating_count" integer DEFAULT 0 NOT NULL,
  "score" integer,
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
  "customer_id" integer,
  "order_number" varchar(20),
  "kind" varchar(32) NOT NULL,
  "status" varchar(24) DEFAULT 'pending' NOT NULL,
  "currency" varchar(3) DEFAULT 'EUR' NOT NULL,
  "subtotal_cents" integer NOT NULL,
  "pickup_fee_cents" integer DEFAULT 0 NOT NULL,
  "min_order_top_up_cents" integer DEFAULT 0 NOT NULL,
  "discount_cents" integer DEFAULT 0 NOT NULL,
  "voucher_code" text,
  "total_cents" integer NOT NULL,
  "refunded_amount_cents" integer DEFAULT 0 NOT NULL,
  "assigned_partner_id" integer,
  "assigned_at" timestamp with time zone,
  "commission_cents" integer,
  "partner_payout_cents" integer,
  "payout_status" varchar(16) DEFAULT 'none' NOT NULL,
  "stripe_transfer_id" text,
  "payout_at" timestamp with time zone,
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
  "payment_provider" varchar(16) DEFAULT 'stripe' NOT NULL,
  "paypal_order_id" text,
  "paypal_capture_id" text,
  "payment_mode" varchar(16) DEFAULT 'upfront' NOT NULL,
  "payment_method" varchar(24),
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
CREATE INDEX IF NOT EXISTS "orders_stripe_payment_intent_idx" ON ${q}."orders" ("stripe_payment_intent_id");

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

-- Self-healing adds for schemas predating these columns (idempotent).
ALTER TABLE ${q}."partners" ADD COLUMN IF NOT EXISTS "stripe_connect_id" text;
ALTER TABLE ${q}."partners" ADD COLUMN IF NOT EXISTS "stripe_connect_status" varchar(16) DEFAULT 'none' NOT NULL;
ALTER TABLE ${q}."partners" ADD COLUMN IF NOT EXISTS "charges_enabled" boolean DEFAULT false NOT NULL;
ALTER TABLE ${q}."partners" ADD COLUMN IF NOT EXISTS "payouts_enabled" boolean DEFAULT false NOT NULL;

ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "discount_cents" integer DEFAULT 0 NOT NULL;
ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "voucher_code" text;
ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "refunded_amount_cents" integer DEFAULT 0 NOT NULL;
ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "assigned_partner_id" integer;
ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "assigned_at" timestamp with time zone;
ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "commission_cents" integer;
ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "partner_payout_cents" integer;
ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "payout_status" varchar(16) DEFAULT 'none' NOT NULL;
ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "stripe_transfer_id" text;
ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "payout_at" timestamp with time zone;
ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "payment_mode" varchar(16) DEFAULT 'upfront' NOT NULL;
ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "payment_method" varchar(24);
ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "payment_provider" varchar(16) DEFAULT 'stripe' NOT NULL;
ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "paypal_order_id" text;
ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "paypal_capture_id" text;
CREATE INDEX IF NOT EXISTS "orders_assigned_partner_idx" ON ${q}."orders" ("assigned_partner_id");
-- Keep AFTER the stripe_transfer_id ALTER above or the batch aborts on legacy schemas.
CREATE INDEX IF NOT EXISTS "orders_stripe_transfer_idx" ON ${q}."orders" ("stripe_transfer_id");
-- Keep AFTER the paypal_order_id ALTER above (same legacy-schema ordering rule).
CREATE INDEX IF NOT EXISTS "orders_paypal_order_id_idx" ON ${q}."orders" ("paypal_order_id");

-- Backfill order numbers from the creation year; greatest() avoids lpad truncation.
ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "order_number" varchar(20);
UPDATE ${q}."orders"
  SET "order_number" = to_char("created_at" AT TIME ZONE 'UTC', 'YYYY') || '/' || lpad("id"::text, greatest(6, length("id"::text)), '0')
  WHERE "order_number" IS NULL;

ALTER TABLE ${q}."partners" ADD COLUMN IF NOT EXISTS "tier" varchar(16) DEFAULT 'basic' NOT NULL;
ALTER TABLE ${q}."partners" ADD COLUMN IF NOT EXISTS "monthly_fee_cents" integer DEFAULT 0 NOT NULL;
ALTER TABLE ${q}."partners" ADD COLUMN IF NOT EXISTS "rating" numeric(3, 2);
ALTER TABLE ${q}."partners" ADD COLUMN IF NOT EXISTS "rating_count" integer DEFAULT 0 NOT NULL;
ALTER TABLE ${q}."partners" ADD COLUMN IF NOT EXISTS "score" integer;

CREATE TABLE IF NOT EXISTS ${q}."customers" (
  "id" serial PRIMARY KEY NOT NULL,
  "email" text NOT NULL,
  "name" text,
  "phone" varchar(32),
  "address_line1" text,
  "address_line2" text,
  "postal_code" varchar(16),
  "city" text,
  "country" varchar(2) DEFAULT 'DE',
  "total_orders" integer DEFAULT 0 NOT NULL,
  "total_spent_cents" integer DEFAULT 0 NOT NULL,
  "loyalty_tier" varchar(16) DEFAULT 'neukunde' NOT NULL,
  "tags" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "internal_notes" text,
  "first_order_at" timestamp with time zone,
  "last_order_at" timestamp with time zone,
  "marketing_opt_in" boolean DEFAULT false NOT NULL,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "${schemaName}_customers_email_unique" UNIQUE("email")
);
CREATE INDEX IF NOT EXISTS "customers_loyalty_tier_idx" ON ${q}."customers" ("loyalty_tier");

CREATE TABLE IF NOT EXISTS ${q}."reviews" (
  "id" serial PRIMARY KEY NOT NULL,
  "order_id" integer,
  "partner_id" integer,
  "customer_email" text,
  "customer_name" text,
  "rating" integer NOT NULL,
  "comment" text,
  "photos" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" varchar(16) DEFAULT 'new' NOT NULL,
  "partner_response" text,
  "responded_at" timestamp with time zone,
  "flagged" boolean DEFAULT false NOT NULL,
  "flag_reason" text,
  "source" varchar(32),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "reviews_status_idx" ON ${q}."reviews" ("status");
CREATE INDEX IF NOT EXISTS "reviews_partner_idx" ON ${q}."reviews" ("partner_id");

CREATE TABLE IF NOT EXISTS ${q}."subscriptions" (
  "id" serial PRIMARY KEY NOT NULL,
  "customer_email" text NOT NULL,
  "customer_name" text,
  "plan_name" text NOT NULL,
  "monthly_price_cents" integer DEFAULT 0 NOT NULL,
  "interval_months" integer DEFAULT 1 NOT NULL,
  "stripe_subscription_id" text,
  "status" varchar(16) DEFAULT 'active' NOT NULL,
  "services_included" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "next_service_date" date,
  "paused_at" timestamp with time zone,
  "cancelled_at" timestamp with time zone,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "subscriptions_status_idx" ON ${q}."subscriptions" ("status");
CREATE INDEX IF NOT EXISTS "subscriptions_email_idx" ON ${q}."subscriptions" ("customer_email");

CREATE TABLE IF NOT EXISTS ${q}."invoices" (
  "id" serial PRIMARY KEY NOT NULL,
  "number" varchar(64),
  "order_id" integer,
  "partner_id" integer,
  "customer_type" varchar(8) DEFAULT 'b2c' NOT NULL,
  "recipient_name" text NOT NULL,
  "recipient_email" text,
  "recipient_address_line1" text,
  "recipient_address_line2" text,
  "recipient_postal_code" varchar(16),
  "recipient_city" text,
  "recipient_country" varchar(2) DEFAULT 'DE',
  "service_date" date,
  "service_date_end" date,
  "status" varchar(16) DEFAULT 'draft' NOT NULL,
  "currency" varchar(3) DEFAULT 'EUR' NOT NULL,
  "subtotal_cents" integer DEFAULT 0 NOT NULL,
  "tax_rate_percent" integer DEFAULT 19 NOT NULL,
  "tax_cents" integer DEFAULT 0 NOT NULL,
  "total_cents" integer DEFAULT 0 NOT NULL,
  "line_items" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "payment_terms_days" integer DEFAULT 7 NOT NULL,
  "payment_method" varchar(16) DEFAULT 'transfer' NOT NULL,
  "due_at" timestamp with time zone,
  "sent_at" timestamp with time zone,
  "paid_at" timestamp with time zone,
  "dunning_level" integer DEFAULT 0 NOT NULL,
  "last_dunning_at" timestamp with time zone,
  "odoo_invoice_id" text,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "invoices_status_idx" ON ${q}."invoices" ("status");
CREATE INDEX IF NOT EXISTS "invoices_due_idx" ON ${q}."invoices" ("due_at");
-- One invoice per order (manual invoices may have a null order_id → partial).
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_order_id_unique" ON ${q}."invoices" ("order_id") WHERE "order_id" IS NOT NULL;
-- Invoice numbers must be unique once assigned (drafts stay null until issued).
CREATE UNIQUE INDEX IF NOT EXISTS "invoices_number_unique" ON ${q}."invoices" ("number") WHERE "number" IS NOT NULL;
-- Dunning sweep filters status + due_at together.
CREATE INDEX IF NOT EXISTS "invoices_status_due_idx" ON ${q}."invoices" ("status", "due_at");

-- Gapless per-year invoice number sequence.
CREATE TABLE IF NOT EXISTS ${q}."invoice_counters" (
  "year" integer PRIMARY KEY NOT NULL,
  "next_value" integer DEFAULT 0 NOT NULL
);

-- §14 UStG fields for schemas predating these columns.
ALTER TABLE ${q}."invoices" ADD COLUMN IF NOT EXISTS "recipient_address_line1" text;
ALTER TABLE ${q}."invoices" ADD COLUMN IF NOT EXISTS "recipient_address_line2" text;
ALTER TABLE ${q}."invoices" ADD COLUMN IF NOT EXISTS "recipient_postal_code" varchar(16);
ALTER TABLE ${q}."invoices" ADD COLUMN IF NOT EXISTS "recipient_city" text;
ALTER TABLE ${q}."invoices" ADD COLUMN IF NOT EXISTS "recipient_country" varchar(2) DEFAULT 'DE';
ALTER TABLE ${q}."invoices" ADD COLUMN IF NOT EXISTS "service_date" date;
ALTER TABLE ${q}."invoices" ADD COLUMN IF NOT EXISTS "service_date_end" date;
ALTER TABLE ${q}."invoices" ADD COLUMN IF NOT EXISTS "tax_rate_percent" integer DEFAULT 19 NOT NULL;
ALTER TABLE ${q}."invoices" ADD COLUMN IF NOT EXISTS "payment_method" varchar(16) DEFAULT 'transfer' NOT NULL;

CREATE TABLE IF NOT EXISTS ${q}."invoice_status_log" (
  "id" serial PRIMARY KEY NOT NULL,
  "invoice_id" integer NOT NULL REFERENCES ${q}."invoices"("id") ON DELETE CASCADE,
  "from_status" varchar(16),
  "to_status" varchar(16) NOT NULL,
  "changed_by_user_id" text,
  "reason" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "invoice_status_log_invoice_id_idx" ON ${q}."invoice_status_log" ("invoice_id");

CREATE TABLE IF NOT EXISTS ${q}."city_status" (
  "id" serial PRIMARY KEY NOT NULL,
  "city" text NOT NULL,
  "plz_prefix" varchar(5) NOT NULL,
  "status" varchar(16) DEFAULT 'locked' NOT NULL,
  "partner_count" integer DEFAULT 0 NOT NULL,
  "active_partner_count" integer DEFAULT 0 NOT NULL,
  "order_count_30d" integer DEFAULT 0 NOT NULL,
  "orders_per_partner" numeric(8, 2),
  "seo_page_generated" boolean DEFAULT false NOT NULL,
  "google_ads_active" boolean DEFAULT false NOT NULL,
  "last_status_change" timestamp with time zone,
  "notes" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "${schemaName}_city_status_plz_unique" UNIQUE("plz_prefix")
);

CREATE TABLE IF NOT EXISTS ${q}."price_adjustments" (
  "id" serial PRIMARY KEY NOT NULL,
  "scope" varchar(16) DEFAULT 'global' NOT NULL,
  "scope_key" varchar(64),
  "adjustment_percent" numeric(5, 2) NOT NULL,
  "reason" text,
  "active" boolean DEFAULT true NOT NULL,
  "valid_from" timestamp with time zone,
  "valid_to" timestamp with time zone,
  "created_by_user_id" text,
  "created_at" timestamp with time zone DEFAULT now() NOT NULL
);
CREATE INDEX IF NOT EXISTS "price_adjustments_active_idx" ON ${q}."price_adjustments" ("active");

CREATE TABLE IF NOT EXISTS ${q}."seo_pages" (
  "id" serial PRIMARY KEY NOT NULL,
  "type" varchar(16) DEFAULT 'service' NOT NULL,
  "path" text NOT NULL,
  "category" varchar(64),
  "city" text,
  "region" text,
  "title" text,
  "meta_title" text,
  "meta_description" text,
  "h1" text,
  "body_html" text,
  "schema_jsonld" jsonb,
  "faq" jsonb DEFAULT '[]'::jsonb NOT NULL,
  "status" varchar(16) DEFAULT 'draft' NOT NULL,
  "gsc_position" numeric(5, 2),
  "source" varchar(64),
  "created_at" timestamp with time zone DEFAULT now() NOT NULL,
  "updated_at" timestamp with time zone DEFAULT now() NOT NULL,
  CONSTRAINT "${schemaName}_seo_pages_path_unique" UNIQUE("path")
);
CREATE INDEX IF NOT EXISTS "seo_pages_status_type_idx" ON ${q}."seo_pages" ("status", "type");
ALTER TABLE ${q}."seo_pages" ADD COLUMN IF NOT EXISTS "category" varchar(64);
CREATE INDEX IF NOT EXISTS "seo_pages_category_idx" ON ${q}."seo_pages" ("category");

-- ── Customer 360: richer profile + customer_id links across source tables ──
-- Self-healing for schemas predating these columns (idempotent).
ALTER TABLE ${q}."customers" ADD COLUMN IF NOT EXISTS "address_line1" text;
ALTER TABLE ${q}."customers" ADD COLUMN IF NOT EXISTS "address_line2" text;
ALTER TABLE ${q}."customers" ADD COLUMN IF NOT EXISTS "postal_code" varchar(16);
ALTER TABLE ${q}."customers" ADD COLUMN IF NOT EXISTS "city" text;
ALTER TABLE ${q}."customers" ADD COLUMN IF NOT EXISTS "country" varchar(2) DEFAULT 'DE';
ALTER TABLE ${q}."customers" ADD COLUMN IF NOT EXISTS "tags" jsonb DEFAULT '[]'::jsonb NOT NULL;
ALTER TABLE ${q}."customers" ADD COLUMN IF NOT EXISTS "internal_notes" text;

ALTER TABLE ${q}."orders" ADD COLUMN IF NOT EXISTS "customer_id" integer;
ALTER TABLE ${q}."service_inquiries" ADD COLUMN IF NOT EXISTS "customer_id" integer;
ALTER TABLE ${q}."contact_messages" ADD COLUMN IF NOT EXISTS "customer_id" integer;
ALTER TABLE ${q}."newsletter_subscribers" ADD COLUMN IF NOT EXISTS "customer_id" integer;
-- Indexes AFTER the ALTERs above or the batch aborts on legacy schemas.
CREATE INDEX IF NOT EXISTS "orders_customer_id_idx" ON ${q}."orders" ("customer_id");
CREATE INDEX IF NOT EXISTS "service_inquiries_customer_id_idx" ON ${q}."service_inquiries" ("customer_id");
CREATE INDEX IF NOT EXISTS "contact_messages_customer_id_idx" ON ${q}."contact_messages" ("customer_id");
CREATE INDEX IF NOT EXISTS "newsletter_subscribers_customer_id_idx" ON ${q}."newsletter_subscribers" ("customer_id");

-- ── Voice-AI / callback geo-routing: service PLZ, call reason, human|ai split ──
-- Self-healing for schemas predating these columns (idempotent).
ALTER TABLE ${q}."service_inquiries" ADD COLUMN IF NOT EXISTS "plz" varchar(5);
ALTER TABLE ${q}."service_inquiries" ADD COLUMN IF NOT EXISTS "call_reason" text;
ALTER TABLE ${q}."service_inquiries" ADD COLUMN IF NOT EXISTS "callback_owner" varchar(8);
ALTER TABLE ${q}."service_inquiries" ADD COLUMN IF NOT EXISTS "assigned_to" text;
-- Phone leads (voice-AI) have no email; relax the legacy NOT NULL constraint.
ALTER TABLE ${q}."service_inquiries" ALTER COLUMN "email" DROP NOT NULL;
-- Index AFTER the ALTER above or the batch aborts on legacy schemas.
CREATE INDEX IF NOT EXISTS "service_inquiries_callback_owner_idx" ON ${q}."service_inquiries" ("callback_owner");

-- Backfill: every email across the source tables becomes a customer (lower-cased,
-- de-duplicated). ON CONFLICT keeps the existing row — never overwrites manual edits.
INSERT INTO ${q}."customers" ("email", "name", "phone")
  SELECT lower("customer_email"), max("customer_name"), max("customer_phone")
  FROM ${q}."orders"
  WHERE "customer_email" IS NOT NULL AND "customer_email" <> ''
  GROUP BY lower("customer_email")
  ON CONFLICT ("email") DO NOTHING;
INSERT INTO ${q}."customers" ("email", "name", "phone")
  SELECT lower("email"), max("name"), max("phone")
  FROM ${q}."service_inquiries"
  WHERE "email" IS NOT NULL AND "email" <> ''
  GROUP BY lower("email")
  ON CONFLICT ("email") DO NOTHING;
INSERT INTO ${q}."customers" ("email", "name", "phone")
  SELECT lower("email"), max("name"), max("phone")
  FROM ${q}."contact_messages"
  WHERE "email" IS NOT NULL AND "email" <> ''
  GROUP BY lower("email")
  ON CONFLICT ("email") DO NOTHING;
INSERT INTO ${q}."customers" ("email", "name", "marketing_opt_in")
  SELECT lower("email"),
         max(nullif(trim(concat_ws(' ', "first_name", "last_name")), '')),
         bool_or("confirmed" AND "unsubscribed_at" IS NULL)
  FROM ${q}."newsletter_subscribers"
  WHERE "email" IS NOT NULL AND "email" <> ''
  GROUP BY lower("email")
  ON CONFLICT ("email") DO NOTHING;

-- Link source rows back to their customer (only fills NULLs — cheap on re-run).
UPDATE ${q}."orders" o SET "customer_id" = c."id"
  FROM ${q}."customers" c
  WHERE o."customer_id" IS NULL AND lower(o."customer_email") = lower(c."email");
UPDATE ${q}."service_inquiries" s SET "customer_id" = c."id"
  FROM ${q}."customers" c
  WHERE s."customer_id" IS NULL AND lower(s."email") = lower(c."email");
UPDATE ${q}."contact_messages" m SET "customer_id" = c."id"
  FROM ${q}."customers" c
  WHERE m."customer_id" IS NULL AND lower(m."email") = lower(c."email");
UPDATE ${q}."newsletter_subscribers" n SET "customer_id" = c."id"
  FROM ${q}."customers" c
  WHERE n."customer_id" IS NULL AND lower(n."email") = lower(c."email");
`;
}
