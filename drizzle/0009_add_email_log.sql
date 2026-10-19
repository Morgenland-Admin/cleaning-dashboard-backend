-- Permanent, cross-brand log of every outgoing email (see shared.ts emailLog).
-- Resend keeps 30 days of logs per account and we run one account per brand,
-- so the dashboard reads this table instead.
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "resend_webhook_secret" text;
--> statement-breakpoint
CREATE TABLE IF NOT EXISTS "email_log" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_slug" varchar(63),
	"kind" varchar(32) NOT NULL,
	"to_address" text NOT NULL,
	"from_address" text NOT NULL,
	"reply_to" text,
	"subject" text NOT NULL,
	"html" text,
	"attachments" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"status" varchar(16) DEFAULT 'sending' NOT NULL,
	"error" text,
	"resend_id" text,
	"delivery_status" varchar(24),
	"delivered_at" timestamp with time zone,
	"opened_at" timestamp with time zone,
	"clicked_at" timestamp with time zone,
	"events" jsonb DEFAULT '[]'::jsonb NOT NULL,
	"ref_type" varchar(16),
	"ref_id" integer,
	"sent_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_log" ADD CONSTRAINT "email_log_company_slug_company_slug_fk" FOREIGN KEY ("company_slug") REFERENCES "public"."company"("slug") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "email_log" ADD CONSTRAINT "email_log_sent_by_user_id_user_id_fk" FOREIGN KEY ("sent_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_log_brand_created_idx" ON "email_log" ("company_slug","created_at");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_log_created_idx" ON "email_log" ("created_at");
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "email_log_resend_id_unique_idx" ON "email_log" ("resend_id");
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "email_log_ref_idx" ON "email_log" ("company_slug","ref_type","ref_id");
