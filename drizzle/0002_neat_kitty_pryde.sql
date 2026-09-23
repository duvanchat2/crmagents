-- F2 (multi-número). Migración SIN pérdida de datos:
--   * meta_credentials NO se toca (respaldo hasta F6): se COPIA a whatsapp_number.
--   * No se borra ni reescribe ninguna fila existente; solo se agregan columnas
--     y se rellenan (backfill). Los teléfonos guardados NO se reescriben.
--   * Todos los pasos de datos son idempotentes (ON CONFLICT / WHERE ... IS NULL).
-- Migración inversa: ver specs/003-kapso-transporte/migracion-0002.md
CREATE TABLE "whatsapp_number" (
	"id" text PRIMARY KEY NOT NULL,
	"organization_id" text NOT NULL,
	"provider" text NOT NULL,
	"phone_number_id" text NOT NULL,
	"waba_id" text NOT NULL,
	"display_phone_number" text,
	"verified_name" text,
	"token_cipher" text,
	"token_iv" text,
	"token_tag" text,
	"status" text DEFAULT 'connected' NOT NULL,
	"is_default" boolean DEFAULT false NOT NULL,
	"enabled" boolean DEFAULT true NOT NULL,
	"created_at" timestamp DEFAULT now() NOT NULL,
	"updated_at" timestamp DEFAULT now() NOT NULL
);
--> statement-breakpoint
DROP INDEX "conversation_org_contact_real_uq";--> statement-breakpoint
DROP INDEX "lead_contact_uq";--> statement-breakpoint
DROP INDEX "template_org_name_lang_uq";--> statement-breakpoint
ALTER TABLE "contact" ADD COLUMN "wa_user_id" text;--> statement-breakpoint
ALTER TABLE "conversation" ADD COLUMN "phone_number_id" text;--> statement-breakpoint
ALTER TABLE "lead" ADD COLUMN "conversation_id" text;--> statement-breakpoint
ALTER TABLE "message" ADD COLUMN "origin" text;--> statement-breakpoint
ALTER TABLE "template" ADD COLUMN "waba_id" text;--> statement-breakpoint
ALTER TABLE "whatsapp_number" ADD CONSTRAINT "whatsapp_number_organization_id_organization_id_fk" FOREIGN KEY ("organization_id") REFERENCES "public"."organization"("id") ON DELETE cascade ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_number_phone_uq" ON "whatsapp_number" USING btree ("phone_number_id");--> statement-breakpoint
CREATE UNIQUE INDEX "whatsapp_number_org_default_uq" ON "whatsapp_number" USING btree ("organization_id") WHERE "whatsapp_number"."is_default" = true;--> statement-breakpoint
CREATE INDEX "whatsapp_number_org_idx" ON "whatsapp_number" USING btree ("organization_id");--> statement-breakpoint
CREATE INDEX "whatsapp_number_waba_idx" ON "whatsapp_number" USING btree ("waba_id");--> statement-breakpoint
ALTER TABLE "lead" ADD CONSTRAINT "lead_conversation_id_conversation_id_fk" FOREIGN KEY ("conversation_id") REFERENCES "public"."conversation"("id") ON DELETE set null ON UPDATE no action;--> statement-breakpoint
CREATE INDEX "contact_org_wa_user_idx" ON "contact" USING btree ("organization_id","wa_user_id");--> statement-breakpoint
CREATE UNIQUE INDEX "conversation_org_number_contact_real_uq" ON "conversation" USING btree ("organization_id",coalesce("phone_number_id", ''),"contact_id") WHERE "conversation"."is_test" = false;--> statement-breakpoint
CREATE UNIQUE INDEX "lead_conversation_uq" ON "lead" USING btree ("conversation_id");--> statement-breakpoint
CREATE INDEX "lead_org_contact_idx" ON "lead" USING btree ("organization_id","contact_id");--> statement-breakpoint
CREATE UNIQUE INDEX "template_org_waba_name_lang_uq" ON "template" USING btree ("organization_id","waba_id","name","language");--> statement-breakpoint
-- [datos 1] Copia la conexión existente: cada fila de meta_credentials pasa a
-- ser el número predeterminado de su organización (conserva token y estado).
INSERT INTO "whatsapp_number" ("id", "organization_id", "provider", "phone_number_id", "waba_id", "display_phone_number", "verified_name", "token_cipher", "token_iv", "token_tag", "status", "is_default", "enabled", "created_at", "updated_at")
SELECT 'wn_' || mc."id", mc."organization_id", mc."provider", mc."phone_number_id", mc."waba_id", mc."display_phone_number", mc."verified_name", mc."token_cipher", mc."token_iv", mc."token_tag", mc."status", true, true, mc."created_at", mc."updated_at"
FROM "meta_credentials" mc
ON CONFLICT ("phone_number_id") DO NOTHING;--> statement-breakpoint
-- [datos 2] Conversaciones reales existentes → el número (único) de su organización.
UPDATE "conversation" c SET "phone_number_id" = mc."phone_number_id"
FROM "meta_credentials" mc
WHERE mc."organization_id" = c."organization_id" AND c."is_test" = false AND c."phone_number_id" IS NULL;--> statement-breakpoint
-- [datos 3] Cada lead se liga a la conversación real de su contacto (antes había
-- a lo sumo una por contacto, así que lead_conversation_uq se cumple).
UPDATE "lead" l SET "conversation_id" = c."id"
FROM "conversation" c
WHERE c."contact_id" = l."contact_id" AND c."organization_id" = l."organization_id" AND c."is_test" = false AND l."conversation_id" IS NULL;--> statement-breakpoint
-- [datos 4] Plantillas existentes → la WABA de su organización.
UPDATE "template" t SET "waba_id" = mc."waba_id"
FROM "meta_credentials" mc
WHERE mc."organization_id" = t."organization_id" AND t."waba_id" IS NULL;--> statement-breakpoint
-- [datos 5] Origen de los mensajes existentes, derivado de lo que ya se guardaba.
UPDATE "message" SET "origin" = CASE
  WHEN "direction" = 'in' THEN 'contact'
  WHEN "ai_generated" THEN 'vocero_ai'
  WHEN "type" = 'template' THEN 'template'
  ELSE 'operator'
END
WHERE "origin" IS NULL;--> statement-breakpoint
ALTER TABLE "message" ALTER COLUMN "origin" SET NOT NULL;
