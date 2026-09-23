import { and, asc, desc, eq, ne } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { decryptSecret, encryptSecret } from "@/lib/crypto";
import { scoped } from "@/lib/db/tenant";
import { getWhatsappProvider, type WhatsappProvider } from "@/lib/env";
import type { MetaApiError } from "@/lib/meta/client";

/**
 * Números de WhatsApp de la organización (F2: varios por organización, tabla
 * whatsapp_number). meta_credentials queda intacta como respaldo hasta F6.
 */
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
  isDefault: boolean;
  /** false = el operador dejó de atenderlo (se conserva por el historial). */
  enabled: boolean;
};

type Row = typeof schema.whatsappNumber.$inferSelect;

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
    isDefault: row.isDefault,
    enabled: row.enabled,
  };
}

/** Etiqueta legible del número para la UI (sin secretos). */
export function numberLabel(n: {
  displayPhoneNumber: string | null;
  verifiedName: string | null;
  phoneNumberId: string;
}): string {
  return n.verifiedName ?? n.displayPhoneNumber ?? n.phoneNumberId;
}

/** Resuelve el número por phone_number_id (enrutamiento del webhook). */
export async function getCredentialsByPhoneNumberId(
  phoneNumberId: string
): Promise<Credentials | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.whatsappNumber)
    .where(eq(schema.whatsappNumber.phoneNumberId, phoneNumberId))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

/** Algún número de la WABA (eventos a nivel WABA, ej. plantillas). */
export async function getCredentialsByWabaId(
  wabaId: string
): Promise<Credentials | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.whatsappNumber)
    .where(eq(schema.whatsappNumber.wabaId, wabaId))
    .orderBy(desc(schema.whatsappNumber.isDefault))
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

/** Todos los números de la organización: predeterminado primero. */
export async function listNumbers(organizationId: string): Promise<Credentials[]> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.whatsappNumber)
    .where(scoped(schema.whatsappNumber.organizationId, organizationId))
    .orderBy(
      desc(schema.whatsappNumber.isDefault),
      asc(schema.whatsappNumber.createdAt)
    );
  return rows.map(toCredentials);
}

/** Un número de la organización por phone_number_id (null si es de otra). */
export async function getNumberForOrg(
  organizationId: string,
  phoneNumberId: string
): Promise<Credentials | null> {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.whatsappNumber)
    .where(
      scoped(
        schema.whatsappNumber.organizationId,
        organizationId,
        eq(schema.whatsappNumber.phoneNumberId, phoneNumberId)
      )
    )
    .limit(1);
  return rows[0] ? toCredentials(rows[0]) : null;
}

/**
 * Número predeterminado de la organización (chats nuevos, plantillas). Si no
 * hay uno marcado, el primero activo.
 */
export async function getDefaultNumber(
  organizationId: string
): Promise<Credentials | null> {
  const numbers = await listNumbers(organizationId);
  return (
    numbers.find((n) => n.isDefault && n.enabled) ??
    numbers.find((n) => n.enabled) ??
    null
  );
}

/** Compatibilidad: "la conexión" de la organización = su número predeterminado. */
export const getCredentialsByOrg = getDefaultNumber;

export class NumberTakenError extends Error {
  constructor() {
    super("Ese número ya está conectado a otra organización de esta instancia");
    this.name = "NumberTakenError";
  }
}

/**
 * Alta o actualización de un número de la organización (upsert por
 * phone_number_id). El primer número queda como predeterminado. Un número de
 * otra organización no se toma (NumberTakenError).
 */
export async function saveCredentials(input: {
  organizationId: string;
  wabaId: string;
  phoneNumberId: string;
  provider: "meta" | "kapso";
  /** Obligatorio en meta; en kapso no se guarda token (API key de instancia). */
  token?: string | null;
  displayPhoneNumber?: string | null;
  verifiedName?: string | null;
}): Promise<Credentials> {
  if (input.provider === "meta" && !input.token) {
    throw new Error("saveCredentials: el modo meta requiere token");
  }
  const db = getDb();
  const existing = await getCredentialsByPhoneNumberId(input.phoneNumberId);
  if (existing && existing.organizationId !== input.organizationId) {
    throw new NumberTakenError();
  }

  const enc = input.token ? encryptSecret(input.token) : null;
  const fields = {
    provider: input.provider,
    wabaId: input.wabaId,
    displayPhoneNumber: input.displayPhoneNumber ?? null,
    verifiedName: input.verifiedName ?? null,
    tokenCipher: enc?.cipher ?? null,
    tokenIv: enc?.iv ?? null,
    tokenTag: enc?.tag ?? null,
    status: "connected" as const,
    enabled: true,
  };

  if (existing) {
    await db
      .update(schema.whatsappNumber)
      .set({ ...fields, updatedAt: new Date() })
      .where(
        scoped(
          schema.whatsappNumber.organizationId,
          input.organizationId,
          eq(schema.whatsappNumber.id, existing.id)
        )
      );
  } else {
    const hasDefault = (await listNumbers(input.organizationId)).some(
      (n) => n.isDefault
    );
    await db
      .insert(schema.whatsappNumber)
      .values({
        id: newId("whatsappNumber"),
        organizationId: input.organizationId,
        phoneNumberId: input.phoneNumberId,
        ...fields,
        isDefault: !hasDefault,
      })
      .onConflictDoNothing({ target: [schema.whatsappNumber.phoneNumberId] });
  }
  const saved = await getNumberForOrg(input.organizationId, input.phoneNumberId);
  if (!saved) throw new NumberTakenError(); // carrera con otra organización
  // Si no hay un predeterminado activo DEL MISMO transporte (p. ej. la
  // instancia cambió de kapso a meta), el número recién conectado lo toma: el
  // predeterminado siempre debe poder enviar.
  const numbers = await listNumbers(input.organizationId);
  const usableDefault = numbers.some(
    (n) => n.isDefault && n.enabled && n.provider === input.provider
  );
  if (!saved.isDefault && !usableDefault) {
    await setDefaultNumber(input.organizationId, saved.id);
    return { ...saved, isDefault: true };
  }
  return saved;
}

/** Marca un número activo como predeterminado (y desmarca el anterior). */
export async function setDefaultNumber(
  organizationId: string,
  numberId: string
): Promise<boolean> {
  const db = getDb();
  return db.transaction(async (tx) => {
    const target = await tx
      .select({ id: schema.whatsappNumber.id, enabled: schema.whatsappNumber.enabled })
      .from(schema.whatsappNumber)
      .where(
        scoped(
          schema.whatsappNumber.organizationId,
          organizationId,
          eq(schema.whatsappNumber.id, numberId)
        )
      )
      .limit(1);
    if (!target[0]?.enabled) return false;
    await tx
      .update(schema.whatsappNumber)
      .set({ isDefault: false, updatedAt: new Date() })
      .where(
        scoped(
          schema.whatsappNumber.organizationId,
          organizationId,
          ne(schema.whatsappNumber.id, numberId)
        )
      );
    await tx
      .update(schema.whatsappNumber)
      .set({ isDefault: true, updatedAt: new Date() })
      .where(
        scoped(
          schema.whatsappNumber.organizationId,
          organizationId,
          eq(schema.whatsappNumber.id, numberId)
        )
      );
    return true;
  });
}

/**
 * Activa/desactiva un número. Desactivar el predeterminado pasa la marca al
 * siguiente activo. El número y su historial se conservan.
 */
export async function setNumberEnabled(
  organizationId: string,
  numberId: string,
  enabled: boolean
): Promise<boolean> {
  const db = getDb();
  const updated = await db
    .update(schema.whatsappNumber)
    .set({
      enabled,
      ...(enabled ? {} : { isDefault: false }),
      updatedAt: new Date(),
    })
    .where(
      scoped(
        schema.whatsappNumber.organizationId,
        organizationId,
        eq(schema.whatsappNumber.id, numberId)
      )
    )
    .returning({ id: schema.whatsappNumber.id });
  if (!updated[0]) return false;
  const numbers = await listNumbers(organizationId);
  if (!numbers.some((n) => n.isDefault && n.enabled)) {
    const next = numbers.find((n) => n.enabled);
    if (next) await setDefaultNumber(organizationId, next.id);
  }
  return true;
}

/** Marca el número como vencido (token inválido detectado en runtime). */
export async function markReconnectRequired(
  organizationId: string,
  phoneNumberId: string
): Promise<void> {
  const db = getDb();
  await db
    .update(schema.whatsappNumber)
    .set({ status: "reconnect_required", updatedAt: new Date() })
    .where(
      and(
        eq(schema.whatsappNumber.organizationId, organizationId),
        eq(schema.whatsappNumber.phoneNumberId, phoneNumberId)
      )
    );
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
 * ¿Sirve este número para enviar con el transporte activo? null = sí.
 * Cubre el cambio de WHATSAPP_PROVIDER en una instancia existente (un número
 * de otro transporte, o uno meta sin token, no se usa) y los desactivados.
 */
export function connectionProblem(
  creds: Credentials | null,
  provider: WhatsappProvider = getWhatsappProvider()
): ConnectionProblem | null {
  if (!creds) {
    return { code: "not_connected", message: "No hay número de WhatsApp conectado" };
  }
  if (!creds.enabled) {
    return {
      code: "not_connected",
      message: `El número ${numberLabel(creds)} está desactivado: actívalo en Configuración → WhatsApp`,
    };
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
 * número venció → se marca reconnect_required ESE número. En kapso la API key
 * es de instancia (.env): no se marca nada, se informa qué revisar.
 * Devuelve null si el error no es de autenticación.
 */
export async function handleTransportAuthError(
  err: MetaApiError,
  number: { organizationId: string; phoneNumberId: string },
  provider: WhatsappProvider = getWhatsappProvider()
): Promise<string | null> {
  if (provider === "kapso") {
    if (err.isApiKeyError) return KAPSO_KEY_REJECTED;
    if (err.isMetaOAuthError) return KAPSO_META_AUTH_FAILED;
    return null;
  }
  if (!err.isAuthError) return null;
  await markReconnectRequired(number.organizationId, number.phoneNumberId);
  return "El token de WhatsApp expiró: reconecta el número en Configuración";
}

/** DTO del número para la UI: jamás el token, solo sus últimos 4. */
export function serializeNumber(n: Credentials) {
  return {
    id: n.id,
    phoneNumberId: n.phoneNumberId,
    wabaId: n.wabaId,
    displayPhoneNumber: n.displayPhoneNumber,
    verifiedName: n.verifiedName,
    label: numberLabel(n),
    provider: n.provider,
    status: n.status,
    isDefault: n.isDefault,
    enabled: n.enabled,
    tokenLast4: tokenLast4(n.token),
    /** Motivo por el que no se puede enviar por este número (null = listo). */
    problem: connectionProblem(n)?.message ?? null,
  };
}

export type NumberDto = ReturnType<typeof serializeNumber>;
