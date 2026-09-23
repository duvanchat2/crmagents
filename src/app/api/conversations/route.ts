import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { normalizePhone } from "@/lib/phone";
import { getContactById } from "@/server/contacts";
import { publish } from "@/server/events/bus";
import { getOrCreateContact, getOrCreateConversation } from "@/server/inbox/ingest";
import {
  getConversation,
  listConversations,
  serializeConversation,
} from "@/server/inbox/queries";
import { connectionProblem, getNumberForOrg } from "@/server/whatsapp/credentials";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (session, req: Request) => {
  const url = new URL(req.url);
  const sinceParam = url.searchParams.get("since");
  const since = sinceParam ? new Date(sinceParam) : undefined;
  const conversations = await listConversations(
    session.organizationId,
    since && !Number.isNaN(since.getTime()) ? since : undefined
  );
  return Response.json({ conversations });
});

const createSchema = z
  .object({
    /** Número de la instancia por el que se inicia el chat. */
    phoneNumberId: z.string().trim().min(1),
    /** Contacto existente, o bien teléfono (+ nombre) para uno nuevo. */
    contactId: z.string().trim().min(1).optional(),
    phone: z.string().trim().optional(),
    name: z.string().trim().max(120).optional(),
  })
  .refine((v) => v.contactId || v.phone, {
    message: "Indica un contacto o un teléfono",
  });

/**
 * Chat nuevo (D9): crea —o reutiliza— la conversación del par (número +
 * teléfono). Sin mensaje entrante la ventana de 24 h está cerrada, así que el
 * primer envío solo puede ser una plantilla (lo exige también el sender).
 */
export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, createSchema);
  if (!body.ok) return body.response;
  const org = session.organizationId;

  const number = await getNumberForOrg(org, body.data.phoneNumberId);
  const problem = connectionProblem(number);
  if (problem) return apiError(409, problem.code, problem.message);

  let contactId: string;
  if (body.data.contactId) {
    const contact = await getContactById(org, body.data.contactId);
    if (!contact) return apiError(404, "not_found", "Contacto no encontrado");
    contactId = contact.id;
  } else {
    const phone = normalizePhone(body.data.phone);
    if (!phone) {
      return apiError(
        422,
        "invalid",
        "Teléfono con código de país (ej. +57 300 123 4567 o 5215512345678)"
      );
    }
    const { contact } = await getOrCreateContact(org, phone, body.data.name ?? null);
    contactId = contact.id;
  }

  const conversation = await getOrCreateConversation(org, contactId, number!.phoneNumberId);
  const row = await getConversation(org, conversation.id);
  if (!row) return apiError(500, "internal", "No se pudo crear la conversación");
  const dto = serializeConversation(row.conversation, row.contact, null, null, row.number);
  publish(org, { type: "conversation.updated", data: { conversation: dto } });
  return Response.json({ conversation: dto }, { status: 201 });
});
