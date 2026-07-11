ALTER TABLE "company" ADD COLUMN "tax_number" varchar(32);--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "business_id" varchar(32);--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "legal_form" varchar(64);--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "managing_directors" text;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "chamber" text;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "mobile" varchar(32);