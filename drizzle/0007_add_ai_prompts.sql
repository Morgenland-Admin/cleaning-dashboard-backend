CREATE TABLE IF NOT EXISTS "ai_prompts" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_slug" varchar(63) NOT NULL,
	"kind" varchar(64) NOT NULL,
	"body" text NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_prompts" ADD CONSTRAINT "ai_prompts_company_slug_company_slug_fk" FOREIGN KEY ("company_slug") REFERENCES "public"."company"("slug") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "ai_prompts" ADD CONSTRAINT "ai_prompts_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "ai_prompts_brand_kind_unique_idx" ON "ai_prompts" ("company_slug","kind");
