import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { scoped } from "@/lib/db/tenant";
import { getWhatsappProvider, type WhatsappProvider } from "@/lib/env";
import type { MetaApiError } from "@/lib/meta/client";

export type Credentials = {
  id: string;
  organizationId: string;
  wabaId: string;
  phoneNumberId: string;
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  status: "connected" | "reconnect_required";
  /** Transporte con el que se guardó la conexión. */
  provider: "meta" | "kapso";
  /** Token del número (modo meta). NULL en conexiones kapso. */
  token: string | null;
};

type Row = typeof schema.metaCredentials.$inferSelect;

function toCredentials(row: Row): Credentials {
  return {
    id: row.id,
    organizationId: row.organizationId,
    wabaId: row.wabaId,
    phoneNumberId: row.phoneNumberId,
    displayPhoneNumber: row.displayPhoneNumber,
    verifiedName: row.verifiedName,
    status: row.status,
    provider: row.provider,
    token:
      row.tokenCipher && row.tokenIv && row.tokenTag
        ? decryptSecret({
            cipher: row.tokenCipher,
            iv: row.tokenIv,
            tag: row.tokenTag,
          })
        : null,
  };
}

/** Resuelve la conexión por phone_number_id (enrutamiento del webhook). */
export async function getCredentialsByPhoneNumberId(
  phoneNumberId: string
): Promise<Credentials | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.metaCredentials)
    .where(eq(schema.metaCredentials.phoneNumberId, phoneNumberId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

/** Resuelve la conexión por WABA ID (eventos a nivel WABA, ej. plantillas). */
export async function getCredentialsByWabaId(
  wabaId: string
): Promise<Credentials | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.metaCredentials)
    .where(eq(schema.metaCredentials.wabaId, wabaId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

export async function getCredentialsByOrg(
  organizationId: string
): Promise<Credentials | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.metaCredentials)
    .where(scoped(schema.metaCredentials.organizationId, organizationId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

export async function saveCredentials(input: {
  organizationId: string;
  wabaId: string;
  phoneNumberId: string;
  provider: "meta" | "kapso";
  /** Obligatorio en meta; en kapso no se guarda token (API key de instancia). */
  token?: string | null;
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
}): Promise<void> {
  const db = getDb();
  if (input.provider === "meta" && !input.token) {
    throw new Error("saveCredentials: el modo meta requiere token");
  }
  const enc = input.token ? encryptSecret(input.token) : null;
  const tokenColumns = {
    tokenCipher: enc?.cipher ?? null,
    tokenIv: enc?.iv ?? null,
    tokenTag: enc?.tag ?? null,
  };
  await db
    .insert(schema.metaCredentials)
    .values({
      id: newId("credentials"),
      organizationId: input.organizationId,
      wabaId: input.wabaId,
      phoneNumberId: input.phoneNumberId,
      displayPhoneNumber: input.displayPhoneNumber ?? null,
      verifiedName: input.verifiedName ?? null,
      provider: input.provider,
      ...tokenColumns,
      status: "connected",
    })
    .onConflictDoUpdate({
      target: [schema.metaCredentials.organizationId],
      set: {
        wabaId: input.wabaId,
        phoneNumberId: input.phoneNumberId,
        displayPhoneNumber: input.displayPhoneNumber ?? null,
        verifiedName: input.verifiedName ?? null,
        provider: input.provider,
        ...tokenColumns,
        status: "connected",
        updatedAt: new Date(),
      },
    });
}

/** Marca la conexión como vencida (token inválido detectado en runtime). */
export async function markReconnectRequired(
  organizationId: string
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.metaCredentials)
    .set({ status: "reconnect_required", updatedAt: new Date() })
    .where(scoped(schema.metaCredentials.organizationId, organizationId));
}

/** Últimos 4 caracteres del token para mostrar en UI (jamás el token). */
export function tokenLast4(token: string): string;
export function tokenLast4(token: string | null): string | null;
export function tokenLast4(token: string | null): string | null {
  return token ? token.slice(-4) : null;
}

export function transportLabel(provider: WhatsappProvider): string {
  return provider === "kapso" ? "Kapso" : "Meta";
}

export type ConnectionProblem = {
  code: "not_connected" | "reconnect_required";
  message: string;
};

/**
 * ¿Sirve la conexión guardada para el transporte activo? null = se puede
 * enviar. Cubre el cambio de WHATSAPP_PROVIDER en una instancia existente:
 * una conexión de otro transporte (o una meta sin token) no se usa.
 */
export function connectionProblem(
  creds: Credentials | null,
  provider: WhatsappProvider = getWhatsappProvider()
): ConnectionProblem | null {
  if (!creds) {
    return { code: "not_connected", message: "No hay número de WhatsApp conectado" };
  }
  if (creds.provider !== provider || (provider === "meta" && !creds.token)) {
    return {
      code: "not_connected",
      message:
        `La conexión guardada es de ${transportLabel(creds.provider)} pero la instancia usa ` +
        `${transportLabel(provider)}: vuelve a conectar el número en Configuración → WhatsApp`,
    };
  }
  if (creds.status === "reconnect_required") {
    return {
      code: "reconnect_required",
      message: "El token de WhatsApp expiró: reconecta el número en Configuración",
    };
  }
  return null;
}

export const KAPSO_KEY_REJECTED =
  "Kapso rechazó la API key: revisa KAPSO_API_KEY en el entorno de la instancia";

export const KAPSO_META_AUTH_FAILED =
  "Kapso no pudo autenticarse con Meta para este número: reconéctalo en app.kapso.ai";

/**
 * Traduce un error de autenticación del transporte. En meta el token del
 * número venció → se marca reconnect_required. En kapso la API key es de
 * instancia (.env): no se marca la conexión, se informa qué revisar.
 * Devuelve null si el error no es de autenticación.
 */
export async function handleTransportAuthError(
  err: MetaApiError,
  organizationId: string,
  provider: WhatsappProvider = getWhatsappProvider()
): Promise<string | null> {
  if (provider === "kapso") {
    if (err.isApiKeyError) return KAPSO_KEY_REJECTED;
    if (err.isMetaOAuthError) return KAPSO_META_AUTH_FAILED;
    return null;
  }
  if (!err.isAuthError) return null;
  await markReconnectRequired(organizationId);
  return "El token de WhatsApp expiró: reconecta el número en Configuración";
}
