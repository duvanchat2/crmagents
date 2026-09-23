import { and, eq, inArray, isNull, sql } from "drizzle-orm";
import { normalizePhone, phoneLookupVariants } from "@/lib/phone";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { publish } from "@/server/events/bus";
import { getCredentialsByPhoneNumberId } from "@/server/whatsapp/credentials";
import type { WebhookValue } from "@/server/inbox/webhook";
import { applyStatusUpdate } from "@/server/inbox/status";
import { onLeadActivity } from "@/server/inbox/lead-activity";
import { maybeRunAgentTurn } from "@/server/ai/trigger";

/** Tipos de contenido soportados; el resto se ignora sin error. */
const SUPPORTED_TYPES = new Set([
  "text",
  "image",
  "audio",
  "video",
  "document",
  "sticker",
  "location",
  "contacts",
]);

/**
 * Contacto único por teléfono (normalizador único de lib/phone). Busca también
 * la forma legada guardada antes de F2 (México `521…`) para no duplicarlo, y
 * guarda el BSUID (business_scoped_user_id) si llega y aún no lo tenía.
 */
export async function getOrCreateContact(
  organizationId: string,
  rawPhone: string,
  name?: string | null,
  waUserId?: string | null
) {
  const db = getDb();
  const phone = normalizePhone(rawPhone) ?? rawPhone.trim();

  const found = await db
    .select()
    .from(schema.contact)
    .where(
      and(
        eq(schema.contact.organizationId, organizationId),
        inArray(schema.contact.phone, phoneLookupVariants(phone))
      )
    )
    .limit(1);
  let existing = found[0];
  const isNew = false;

  if (!existing) {
    const inserted = await db
      .insert(schema.contact)
      .values({
        id: newId("contact"),
        organizationId,
        phone,
        waUserId: waUserId ?? null,
        name: name?.trim() || phone,
      })
      .onConflictDoNothing({
        target: [schema.contact.organizationId, schema.contact.phone],
      })
      .returning();
    if (inserted[0]) return { contact: inserted[0], isNew: true };
    const raced = await db
      .select()
      .from(schema.contact)
      .where(
        and(
          eq(schema.contact.organizationId, organizationId),
          eq(schema.contact.phone, phone)
        )
      )
      .limit(1);
    existing = raced[0];
  }
  if (!existing) throw new Error("contacto no encontrado tras upsert");

  // Reactivar si estaba archivado (el nombre editado por el operador se
  // respeta) y completar el BSUID si faltaba.
  const patch: Partial<typeof schema.contact.$inferInsert> = {};
  if (existing.archivedAt) patch.archivedAt = null;
  if (waUserId && !existing.waUserId) patch.waUserId = waUserId;
  if (Object.keys(patch).length > 0) {
    await db
      .update(schema.contact)
      .set({ ...patch, updatedAt: new Date() })
      .where(eq(schema.contact.id, existing.id));
    existing = { ...existing, ...patch } as typeof existing;
  }
  return { contact: existing, isNew };
}

/**
 * Conversación real única por (organización + número + contacto). Las de
 * prueba del Laboratorio no compiten (índice parcial is_test = false).
 * Una conversación legada SIN número (demo sembrada antes de conectar, u
 * organización sin conexión al migrar) se ADOPTA con el primer mensaje de
 * ese número en vez de abrir un segundo hilo para el mismo contacto.
 */
export async function getOrCreateConversation(
  organizationId: string,
  contactId: string,
  phoneNumberId: string
) {
  const db = getDb();
  const byNumber = and(
    eq(schema.conversation.organizationId, organizationId),
    eq(schema.conversation.contactId, contactId),
    eq(schema.conversation.phoneNumberId, phoneNumberId),
    eq(schema.conversation.isTest, false)
  );

  const existing = await db.select().from(schema.conversation).where(byNumber).limit(1);
  if (existing[0]) return existing[0];

  const adopted = await db
    .update(schema.conversation)
    .set({ phoneNumberId, updatedAt: new Date() })
    .where(
      and(
        eq(schema.conversation.organizationId, organizationId),
        eq(schema.conversation.contactId, contactId),
        isNull(schema.conversation.phoneNumberId),
        eq(schema.conversation.isTest, false)
      )
    )
    .returning();
  if (adopted[0]) return adopted[0];

  const inserted = await db
    .insert(schema.conversation)
    .values({
      id: newId("conversation"),
      organizationId,
      contactId,
      phoneNumberId,
    })
    .onConflictDoNothing()
    .returning();
  if (inserted[0]) return inserted[0];

  const raced = await db.select().from(schema.conversation).where(byNumber).limit(1);
  if (!raced[0]) throw new Error("conversación no encontrada tras upsert");
  return raced[0];
}

/**
 * Procesa el `value` de un cambio `messages` del webhook: mensajes entrantes
 * (idempotentes por wa_message_id) y actualizaciones de estado.
 */
export async function processMessagesValue(value: WebhookValue): Promise<void> {
  const phoneNumberId = value.metadata?.phone_number_id;
  if (!phoneNumberId) return;

  const credentials = await getCredentialsByPhoneNumberId(phoneNumberId);
  if (credentials && !credentials.enabled) {
    console.warn(
      `[webhook] evento para un número desactivado (${phoneNumberId}): actívalo en Configuración → WhatsApp`
    );
    return;
  }
  if (!credentials) {
    // Caso típico: webhook/override configurado ANTES de guardar la conexión
    // en el wizard — el evento llega pero no hay a qué organización enrutarlo.
    console.warn(
      `[webhook] evento para phone_number_id desconocido (${phoneNumberId}): ` +
        "guarda la conexión en Configuración → WhatsApp para recibir mensajes"
    );
    return;
  }

  const organizationId = credentials.organizationId;

  for (const status of value.statuses ?? []) {
    await applyStatusUpdate(organizationId, status);
  }

  for (const msg of value.messages ?? []) {
    if (!SUPPORTED_TYPES.has(msg.type)) continue; // reacciones, etc.: ignorar
    const waContact = value.contacts?.find((c) => c.wa_id === msg.from);
    await ingestInboundMessage({
      organizationId,
      phoneNumberId,
      from: msg.from,
      waUserId: msg.from_user_id ?? waContact?.user_id ?? null,
      profileName: waContact?.profile?.name ?? null,
      waMessageId: msg.id,
      type: msg.type,
      text: msg.text?.body ?? null,
      timestamp: msg.timestamp,
    });
  }
}

export async function ingestInboundMessage(input: {
  organizationId: string;
  /** Número de la instancia que recibió el mensaje. */
  phoneNumberId: string;
  from: string;
  waUserId?: string | null;
  profileName: string | null;
  waMessageId: string;
  type: string;
  text: string | null;
  timestamp: string;
}): Promise<void> {
  const db = getDb();
  const { organizationId } = input;

  const { contact } = await getOrCreateContact(
    organizationId,
    input.from,
    input.profileName,
    input.waUserId
  );
  const conversation = await getOrCreateConversation(
    organizationId,
    contact.id,
    input.phoneNumberId
  );

  const waTimestamp = toDate(input.timestamp);

  // Idempotencia dura: mismo wa_message_id → sin efectos adicionales.
  const inserted = await db
    .insert(schema.message)
    .values({
      id: newId("message"),
      organizationId,
      conversationId: conversation.id,
      waMessageId: input.waMessageId,
      direction: "in",
      origin: "contact",
      type: input.type,
      text: input.text,
      status: "delivered",
      waTimestamp,
    })
    .onConflictDoNothing({ target: [schema.message.waMessageId] })
    .returning();
  const message = inserted[0];
  if (!message) return; // duplicado

  await db
    .update(schema.conversation)
    .set({
      lastInboundAt: waTimestamp,
      lastMessageAt: waTimestamp,
      unreadCount: sql`${schema.conversation.unreadCount} + 1`,
      updatedAt: new Date(),
    })
    .where(eq(schema.conversation.id, conversation.id));

  await onLeadActivity(organizationId, conversation, waTimestamp);

  publish(organizationId, {
    type: "message.new",
    data: { conversationId: conversation.id, message: serializeMessage(message) },
  });
  publish(organizationId, {
    type: "conversation.updated",
    data: { conversation: { id: conversation.id } },
  });

  await maybeRunAgentTurn(conversation.id);
}

function toDate(timestamp: string): Date {
  const n = Number(timestamp);
  if (Number.isFinite(n) && n > 0) return new Date(n * 1000);
  return new Date();
}

export function serializeMessage(m: typeof schema.message.$inferSelect) {
  return {
    id: m.id,
    conversationId: m.conversationId,
    direction: m.direction,
    type: m.type,
    text: m.text,
    status: m.status,
    aiGenerated: m.aiGenerated,
    origin: m.origin,
    createdAt: (m.waTimestamp ?? m.createdAt).toISOString(),
  };
}
