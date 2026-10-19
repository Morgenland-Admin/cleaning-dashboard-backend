ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "storefront_aliases" jsonb DEFAULT '[]'::jsonb NOT NULL;
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "partner_portal_origin" text;
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "partner_contract_version" varchar(32);
--> statement-breakpoint
ALTER TABLE "company" ADD COLUMN IF NOT EXISTS "partner_contract_url" text;
--> statement-breakpoint
-- CLEANILO keeps the live site's canonical host (www); the apex stays allowed as an alias.
UPDATE "company" SET "storefront_origin" = 'https://www.cleanilo.de'
  WHERE "slug" = 'cleanilo' AND "storefront_origin" = 'https://cleanilo.de';
