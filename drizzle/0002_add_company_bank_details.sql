ALTER TABLE "company" ADD COLUMN "account_holder" text;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "iban" varchar(34);--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "bic" varchar(11);--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "bank_name" text;--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN "bank_address" text;
