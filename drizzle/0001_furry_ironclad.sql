ALTER TABLE "meta_credentials" ALTER COLUMN "token_cipher" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_credentials" ALTER COLUMN "token_iv" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_credentials" ALTER COLUMN "token_tag" DROP NOT NULL;--> statement-breakpoint
ALTER TABLE "meta_credentials" ADD COLUMN "provider" text DEFAULT 'meta' NOT NULL;