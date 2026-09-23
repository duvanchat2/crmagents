-- Migración INVERSA de drizzle/0002 (F2 multi-número) → deja el esquema como en 0001.
-- Uso (con la app detenida y un backup previo):
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f specs/003-kapso-transporte/rollback-0002.sql
-- Después, desplegar la versión anterior de la app (main antes de F2).
--
-- Qué conserva: todas las filas de contactos, conversaciones, mensajes, leads y
-- plantillas. meta_credentials nunca se tocó en 0002; aquí se actualiza con el
-- número PREDETERMINADO de cada organización (por si su token cambió después).
-- Qué se pierde (solo información creada con F2): los números NO predeterminados,
-- el BSUID de los contactos, el origen de los mensajes y la WABA de las plantillas.
-- Aborta sin cambios si hay datos que el esquema anterior no puede representar
-- (un contacto con varias conversaciones/leads reales o plantillas duplicadas
-- entre WABAs): hay que fusionarlos antes.

BEGIN;

DO $$
BEGIN
  IF EXISTS (
    SELECT 1 FROM "conversation" WHERE "is_test" = false
    GROUP BY "organization_id", "contact_id" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'rollback-0002: hay contactos con más de una conversación real (multi-número); fusiónalas antes';
  END IF;
  IF EXISTS (SELECT 1 FROM "lead" GROUP BY "contact_id" HAVING count(*) > 1) THEN
    RAISE EXCEPTION 'rollback-0002: hay contactos con más de un lead; fusiónalos antes';
  END IF;
  IF EXISTS (
    SELECT 1 FROM "template"
    GROUP BY "organization_id", "name", "language" HAVING count(*) > 1
  ) THEN
    RAISE EXCEPTION 'rollback-0002: hay plantillas con el mismo nombre/idioma en varias WABAs; elimina las sobrantes antes';
  END IF;
END $$;

-- 1. meta_credentials ← número predeterminado (una fila por organización).
UPDATE "meta_credentials" mc SET
  "provider" = wn."provider", "waba_id" = wn."waba_id", "phone_number_id" = wn."phone_number_id",
  "display_phone_number" = wn."display_phone_number", "verified_name" = wn."verified_name",
  "token_cipher" = wn."token_cipher", "token_iv" = wn."token_iv", "token_tag" = wn."token_tag",
  "status" = wn."status", "updated_at" = now()
FROM "whatsapp_number" wn
WHERE wn."organization_id" = mc."organization_id" AND wn."is_default" = true;

INSERT INTO "meta_credentials" ("id", "organization_id", "waba_id", "phone_number_id", "display_phone_number", "verified_name", "token_cipher", "token_iv", "token_tag", "status", "provider", "created_at", "updated_at")
SELECT 'cred_' || wn."id", wn."organization_id", wn."waba_id", wn."phone_number_id", wn."display_phone_number", wn."verified_name", wn."token_cipher", wn."token_iv", wn."token_tag", wn."status", wn."provider", wn."created_at", now()
FROM "whatsapp_number" wn
WHERE wn."is_default" = true
  AND NOT EXISTS (SELECT 1 FROM "meta_credentials" mc WHERE mc."organization_id" = wn."organization_id")
ON CONFLICT DO NOTHING;

-- 2. Índices de 0002 → índices de 0001.
DROP INDEX IF EXISTS "conversation_org_number_contact_real_uq";
DROP INDEX IF EXISTS "lead_conversation_uq";
DROP INDEX IF EXISTS "lead_org_contact_idx";
DROP INDEX IF EXISTS "template_org_waba_name_lang_uq";
DROP INDEX IF EXISTS "contact_org_wa_user_idx";
CREATE UNIQUE INDEX "conversation_org_contact_real_uq" ON "conversation" USING btree ("organization_id","contact_id") WHERE "conversation"."is_test" = false;
CREATE UNIQUE INDEX "lead_contact_uq" ON "lead" USING btree ("contact_id");
CREATE UNIQUE INDEX "template_org_name_lang_uq" ON "template" USING btree ("organization_id","name","language");

-- 3. Columnas y tabla nuevas de 0002.
ALTER TABLE "message" DROP COLUMN IF EXISTS "origin";
ALTER TABLE "template" DROP COLUMN IF EXISTS "waba_id";
ALTER TABLE "lead" DROP CONSTRAINT IF EXISTS "lead_conversation_id_conversation_id_fk";
ALTER TABLE "lead" DROP COLUMN IF EXISTS "conversation_id";
ALTER TABLE "conversation" DROP COLUMN IF EXISTS "phone_number_id";
ALTER TABLE "contact" DROP COLUMN IF EXISTS "wa_user_id";
DROP TABLE IF EXISTS "whatsapp_number";

-- 4. Registro del migrador (drizzle): 0002 vuelve a estar pendiente.
DO $$
BEGIN
  IF to_regclass('drizzle.__drizzle_migrations') IS NOT NULL THEN
    DELETE FROM drizzle.__drizzle_migrations WHERE created_at = 1790129189071;
  END IF;
END $$;

COMMIT;
