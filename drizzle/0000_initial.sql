CREATE SCHEMA IF NOT EXISTS "cleanilo";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "hamburg_teppichreinigung";
--> statement-breakpoint
CREATE SCHEMA IF NOT EXISTS "teppichreinigen_lassen";
--> statement-breakpoint
CREATE TABLE "account" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"account_id" text NOT NULL,
	"provider_id" text NOT NULL,
	"access_token" text,
	"refresh_token" text,
	"access_token_expires_at" timestamp with time zone,
	"refresh_token_expires_at" timestamp with time zone,
	"scope" text,
	"id_token" text,
	"password" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "address" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"label" text,
	"type" varchar(16) DEFAULT 'primary' NOT NULL,
	"line1" text NOT NULL,
	"line2" text,
	"city" text NOT NULL,
	"region" text,
	"postal_code" varchar(20) NOT NULL,
	"country" varchar(2) DEFAULT 'DE' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "company" (
	"slug" varchar(64) PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"legal_name" text,
	"schema_name" varchar(64) NOT NULL,
	"email" text,
	"phone" varchar(32),
	"website_url" text,
	"address_line1" text,
	"address_line2" text,
	"city" text,
	"region" text,
	"postal_code" varchar(20),
	"country" varchar(2) DEFAULT 'DE',
	"vat_id" varchar(32),
	"registration_number" varchar(64),
	"logo_url" text,
	"primary_color" varchar(9),
	"sender_email" text,
	"sender_name" text,
	"key_prefix" varchar(64),
	"storefront_origin" text,
	"is_active" boolean DEFAULT true NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "company_schema_name_unique" UNIQUE("schema_name")
);
--> statement-breakpoint
CREATE TABLE "export_jobs" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_slug" varchar(63) NOT NULL,
	"requested_by_user_id" text NOT NULL,
	"kind" varchar(32) NOT NULL,
	"filter" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"format" varchar(8) DEFAULT 'csv' NOT NULL,
	"status" varchar(16) DEFAULT 'pending' NOT NULL,
	"row_count" integer,
	"s3_key" text,
	"size_bytes" bigint,
	"error_message" text,
	"started_at" timestamp with time zone,
	"completed_at" timestamp with time zone,
	"expires_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "membership" (
	"user_id" text NOT NULL,
	"company_slug" varchar(64) NOT NULL,
	"role" varchar(32) DEFAULT 'viewer' NOT NULL,
	"invited_by_user_id" text,
	"invited_at" timestamp with time zone,
	"accepted_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "membership_user_id_company_slug_pk" PRIMARY KEY("user_id","company_slug")
);
--> statement-breakpoint
CREATE TABLE "push_subscriptions" (
	"id" serial PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"endpoint" text NOT NULL,
	"p256dh" text NOT NULL,
	"auth" text NOT NULL,
	"user_agent" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"last_used_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "push_subscriptions_endpoint_unique" UNIQUE("endpoint")
);
--> statement-breakpoint
CREATE TABLE "session" (
	"id" text PRIMARY KEY NOT NULL,
	"user_id" text NOT NULL,
	"token" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"ip_address" text,
	"user_agent" text,
	"active_company_slug" varchar(64),
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "session_token_unique" UNIQUE("token")
);
--> statement-breakpoint
CREATE TABLE "task_comments" (
	"id" serial PRIMARY KEY NOT NULL,
	"task_id" integer NOT NULL,
	"author_user_id" text NOT NULL,
	"body" text NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "tasks" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_slug" varchar(63) NOT NULL,
	"kind" varchar(64) NOT NULL,
	"ref_kind" varchar(64),
	"ref_id" integer,
	"title" text NOT NULL,
	"body" text,
	"status" varchar(16) DEFAULT 'open' NOT NULL,
	"priority" varchar(16) DEFAULT 'normal' NOT NULL,
	"assignee_user_id" text,
	"due_at" timestamp with time zone,
	"resolved_at" timestamp with time zone,
	"resolved_by_user_id" text,
	"metadata" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "user" (
	"id" text PRIMARY KEY NOT NULL,
	"name" text NOT NULL,
	"first_name" text,
	"last_name" text,
	"email" text NOT NULL,
	"email_verified" boolean DEFAULT false NOT NULL,
	"phone" varchar(32),
	"phone_verified" boolean DEFAULT false NOT NULL,
	"image" text,
	"date_of_birth" date,
	"gender" varchar(16),
	"locale" varchar(16) DEFAULT 'de' NOT NULL,
	"timezone" varchar(64) DEFAULT 'Europe/Berlin' NOT NULL,
	"audience" varchar(16) DEFAULT 'customer' NOT NULL,
	"access_level" varchar(32) DEFAULT 'none' NOT NULL,
	"is_active" boolean DEFAULT true NOT NULL,
	"last_login_at" timestamp with time zone,
	"invited_by_user_id" text,
	"internal_notes" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "user_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "user_settings" (
	"user_id" text PRIMARY KEY NOT NULL,
	"locale" varchar(16) DEFAULT 'de' NOT NULL,
	"theme" varchar(16) DEFAULT 'system' NOT NULL,
	"notifications_email" boolean DEFAULT true NOT NULL,
	"notifications_sms" boolean DEFAULT false NOT NULL,
	"marketing_opt_in" boolean DEFAULT false NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "verification" (
	"id" text PRIMARY KEY NOT NULL,
	"identifier" text NOT NULL,
	"value" text NOT NULL,
	"expires_at" timestamp with time zone NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cleanilo"."contact_messages" (
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
--> statement-breakpoint
CREATE TABLE "cleanilo"."contact_replies" (
	"id" serial PRIMARY KEY NOT NULL,
	"contact_message_id" integer NOT NULL,
	"body" text NOT NULL,
	"sent_by_user_id" text,
	"sent_by_name" text,
	"email_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "cleanilo"."newsletter_subscribers" (
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
	CONSTRAINT "newsletter_subscribers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "cleanilo"."partners" (
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
--> statement-breakpoint
CREATE TABLE "cleanilo"."service_inquiries" (
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
--> statement-breakpoint
CREATE TABLE "hamburg_teppichreinigung"."contact_messages" (
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
--> statement-breakpoint
CREATE TABLE "hamburg_teppichreinigung"."contact_replies" (
	"id" serial PRIMARY KEY NOT NULL,
	"contact_message_id" integer NOT NULL,
	"body" text NOT NULL,
	"sent_by_user_id" text,
	"sent_by_name" text,
	"email_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "hamburg_teppichreinigung"."newsletter_subscribers" (
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
	CONSTRAINT "newsletter_subscribers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "hamburg_teppichreinigung"."partners" (
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
--> statement-breakpoint
CREATE TABLE "hamburg_teppichreinigung"."service_inquiries" (
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
--> statement-breakpoint
CREATE TABLE "teppichreinigen_lassen"."contact_messages" (
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
--> statement-breakpoint
CREATE TABLE "teppichreinigen_lassen"."contact_replies" (
	"id" serial PRIMARY KEY NOT NULL,
	"contact_message_id" integer NOT NULL,
	"body" text NOT NULL,
	"sent_by_user_id" text,
	"sent_by_name" text,
	"email_message_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "teppichreinigen_lassen"."newsletter_subscribers" (
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
	CONSTRAINT "newsletter_subscribers_email_unique" UNIQUE("email")
);
--> statement-breakpoint
CREATE TABLE "teppichreinigen_lassen"."partners" (
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
--> statement-breakpoint
CREATE TABLE "teppichreinigen_lassen"."service_inquiries" (
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
--> statement-breakpoint
ALTER TABLE "account" ADD CONSTRAINT "account_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "address" ADD CONSTRAINT "address_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_company_slug_company_slug_fk" FOREIGN KEY ("company_slug") REFERENCES "public"."company"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "export_jobs" ADD CONSTRAINT "export_jobs_requested_by_user_id_user_id_fk" FOREIGN KEY ("requested_by_user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "membership" ADD CONSTRAINT "membership_company_slug_company_slug_fk" FOREIGN KEY ("company_slug") REFERENCES "public"."company"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "push_subscriptions" ADD CONSTRAINT "push_subscriptions_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "session" ADD CONSTRAINT "session_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_task_id_tasks_id_fk" FOREIGN KEY ("task_id") REFERENCES "public"."tasks"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "task_comments" ADD CONSTRAINT "task_comments_author_user_id_user_id_fk" FOREIGN KEY ("author_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_company_slug_company_slug_fk" FOREIGN KEY ("company_slug") REFERENCES "public"."company"("slug") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_assignee_user_id_user_id_fk" FOREIGN KEY ("assignee_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "tasks" ADD CONSTRAINT "tasks_resolved_by_user_id_user_id_fk" FOREIGN KEY ("resolved_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "user_settings" ADD CONSTRAINT "user_settings_user_id_user_id_fk" FOREIGN KEY ("user_id") REFERENCES "public"."user"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "cleanilo"."contact_replies" ADD CONSTRAINT "contact_replies_contact_message_id_contact_messages_id_fk" FOREIGN KEY ("contact_message_id") REFERENCES "cleanilo"."contact_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "hamburg_teppichreinigung"."contact_replies" ADD CONSTRAINT "contact_replies_contact_message_id_contact_messages_id_fk" FOREIGN KEY ("contact_message_id") REFERENCES "hamburg_teppichreinigung"."contact_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "teppichreinigen_lassen"."contact_replies" ADD CONSTRAINT "contact_replies_contact_message_id_contact_messages_id_fk" FOREIGN KEY ("contact_message_id") REFERENCES "teppichreinigen_lassen"."contact_messages"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "export_jobs_pending_idx" ON "export_jobs" USING btree ("status","created_at");--> statement-breakpoint
CREATE INDEX "export_jobs_requester_idx" ON "export_jobs" USING btree ("requested_by_user_id","created_at");--> statement-breakpoint
CREATE INDEX "task_comments_task_idx" ON "task_comments" USING btree ("task_id","created_at");--> statement-breakpoint
CREATE UNIQUE INDEX "tasks_ref_unique_idx" ON "tasks" USING btree ("company_slug","ref_kind","ref_id");--> statement-breakpoint
CREATE INDEX "tasks_brand_status_created_idx" ON "tasks" USING btree ("company_slug","status","created_at");--> statement-breakpoint
CREATE INDEX "tasks_assignee_idx" ON "tasks" USING btree ("assignee_user_id","status");--> statement-breakpoint
CREATE INDEX "contact_messages_created_at_idx" ON "cleanilo"."contact_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "contact_replies_contact_message_id_idx" ON "cleanilo"."contact_replies" USING btree ("contact_message_id");--> statement-breakpoint
CREATE INDEX "service_inquiries_created_at_idx" ON "cleanilo"."service_inquiries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "contact_messages_created_at_idx" ON "hamburg_teppichreinigung"."contact_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "contact_replies_contact_message_id_idx" ON "hamburg_teppichreinigung"."contact_replies" USING btree ("contact_message_id");--> statement-breakpoint
CREATE INDEX "service_inquiries_created_at_idx" ON "hamburg_teppichreinigung"."service_inquiries" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "contact_messages_created_at_idx" ON "teppichreinigen_lassen"."contact_messages" USING btree ("created_at");--> statement-breakpoint
CREATE INDEX "contact_replies_contact_message_id_idx" ON "teppichreinigen_lassen"."contact_replies" USING btree ("contact_message_id");--> statement-breakpoint
CREATE INDEX "service_inquiries_created_at_idx" ON "teppichreinigen_lassen"."service_inquiries" USING btree ("created_at");
