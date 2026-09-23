import { eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { graphRequest, MetaApiError, normalizeRecipient } from "@/lib/meta/client";
import { publish } from "@/server/events/bus";
import { getWhatsappProvider } from "@/lib/env";
import {
  connectionProblem,
  getDefaultNumber,
  getNumberForOrg,
  handleTransportAuthError,
  transportLabel,
  type Credentials,
} from "@/server/whatsapp/credentials";
import { isWindowOpen } from "@/server/inbox/window";
import { serializeMessage } from "@/server/inbox/ingest";

/** Error tipado del envío; `code` mapea a HTTP en la capa de API. */
export class SendError extends Error {
  code:
    | "sandbox_violation"
    | "not_connected"
    | "reconnect_required"
    | "window_closed"
    | "meta_error"
    | "meta_unavailable";

  constructor(code: SendError["code"], message: string) {
    super(message);
    this.name = "SendError";
    this.code = code;
  }
}

type SendResult = { messageId: string };

/**
 * Envía un mensaje de texto libre por WhatsApp.
 *
 * ASERCIÓN DURA (FR-031): una conversación de prueba del Laboratorio jamás
 * llega a la API real — se lanza ANTES de tocar credenciales o red.
 */
export async function sendText(input: {
  conversationId: string;
  organizationId: string;
  text: string;
  aiGenerated?: boolean;
}): Promise<SendResult> {
  const db = getDb();

  const rows = await db
    .select({
      conversation: schema.conversation,
      contact: schema.contact,
    })
    .from(schema.conversation)
    .innerJoin(
      schema.contact,
      eq(schema.conversation.contactId, schema.contact.id)
    )
    .where(eq(schema.conversation.id, input.conversationId))
    .limit(1);
  const row = rows[0];
  if (!row || row.conversation.organizationId !== input.organizationId) {
    throw new SendError("meta_error", "Conversación no encontrada");
  }

  if (row.conversation.isTest) {
    throw new SendError(
      "sandbox_violation",
      "Conversación de prueba del Laboratorio: el envío real está prohibido"
    );
  }

  if (!isWindowOpen(row.conversation.lastInboundAt)) {
    throw new SendError(
      "window_closed",
      "La ventana de 24 horas está cerrada; usa una plantilla aprobada"
    );
  }

  // Sale por el número de la conversación (F2), en meta y en kapso.
  const credentials = await getSendableCredentials(
    input.organizationId,
    row.conversation.phoneNumberId
  );

  const waMessageId = await callGraphSend(credentials, {
    messaging_product: "whatsapp",
    to: normalizeRecipient(row.contact.phone),
    type: "text",
    text: { body: input.text },
  });

  const inserted = await db
    .insert(schema.message)
    .values({
      id: newId("message"),
      organizationId: input.organizationId,
      conversationId: input.conversationId,
      waMessageId,
      direction: "out",
      origin: input.aiGenerated ? "vocero_ai" : "operator",
      type: "text",
      text: input.text,
      status: "pending",
      aiGenerated: input.aiGenerated ?? false,
    })
    .returning();
  const message = inserted[0]!;

  await db
    .update(schema.conversation)
    .set({ lastMessageAt: new Date(), updatedAt: new Date() })
    .where(eq(schema.conversation.id, input.conversationId));

  publish(input.organizationId, {
    type: "message.new",
    data: {
      conversationId: input.conversationId,
      message: serializeMessage(message),
    },
  });

  return { messageId: message.id };
}

/**
 * Número listo para enviar por el transporte activo, o SendError con el
 * motivo (sin número, desactivado, transporte distinto, token vencido).
 * Con phoneNumberId usa ESE número de la organización (el de la
 * conversación); sin él (conversación legada sin número), el predeterminado.
 */
export async function getSendableCredentials(
  organizationId: string,
  phoneNumberId?: string | null
): Promise<Credentials> {
  const credentials = phoneNumberId
    ? await getNumberForOrg(organizationId, phoneNumberId)
    : await getDefaultNumber(organizationId);
  const problem = connectionProblem(credentials);
  if (problem) throw new SendError(problem.code, problem.message);
  return credentials!;
}

/** Llama a /messages del transporte activo y traduce sus errores a SendError. */
export async function callGraphSend(
  credentials: Credentials,
  payload: unknown
): Promise<string> {
  try {
    const res = await graphRequest<{ messages?: { id: string }[] }>(
      `${credentials.phoneNumberId}/messages`,
      { method: "POST", token: credentials.token, body: payload }
    );
    const id = res.messages?.[0]?.id;
    if (!id) throw new SendError("meta_error", "El transporte no devolvió ID de mensaje");
    return id;
  } catch (err) {
    if (err instanceof MetaApiError) {
      const authMessage = await handleTransportAuthError(err, credentials);
      if (authMessage) throw new SendError("reconnect_required", authMessage);
      if (err.status === 0 || err.status >= 500) {
        throw new SendError(
          "meta_unavailable",
          `${transportLabel(getWhatsappProvider())} no está disponible ahora`
        );
      }
      throw new SendError("meta_error", err.message);
    }
    throw err;
  }
}
