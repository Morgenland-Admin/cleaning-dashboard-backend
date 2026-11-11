CREATE TABLE IF NOT EXISTS "brand_material_drafts" (
	"id" serial PRIMARY KEY NOT NULL,
	"company_slug" varchar(63) NOT NULL,
	"template_path" varchar(160) NOT NULL,
	"data" jsonb DEFAULT '{}'::jsonb NOT NULL,
	"updated_by_user_id" text,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brand_material_drafts" ADD CONSTRAINT "brand_material_drafts_company_slug_company_slug_fk" FOREIGN KEY ("company_slug") REFERENCES "public"."company"("slug") ON DELETE cascade ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
DO $$ BEGIN
 ALTER TABLE "brand_material_drafts" ADD CONSTRAINT "brand_material_drafts_updated_by_user_id_user_id_fk" FOREIGN KEY ("updated_by_user_id") REFERENCES "public"."user"("id") ON DELETE set null ON UPDATE no action;
EXCEPTION
 WHEN duplicate_object THEN null;
END $$;
--> statement-breakpoint
CREATE UNIQUE INDEX IF NOT EXISTS "brand_material_drafts_brand_path_unique_idx" ON "brand_material_drafts" ("company_slug","template_path");
