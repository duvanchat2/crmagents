import { eq } from "drizzle-orm";
import { z } from "zod";
import { mockGuard } from "@/lib/dev-guard";
import { apiError, parseBody } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import {
  getCredentialsByOrg,
  getCredentialsByPhoneNumberId,
} from "@/server/whatsapp/credentials";
import {
  buildStatusPayload,
  deliverToWebhook,
} from "@/server/dev/wa-mock-inbound";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  waMessageId: z.string().min(1),
  status: z.enum(["sent", "delivered", "read", "failed"]),
});

export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;

  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  // Resolver el número desde el mensaje (el payload real lleva metadata).
  const db = getDb();
  const rows = await db
    .select({
      organizationId: schema.message.organizationId,
      phoneNumberId: schema.conversation.phoneNumberId,
    })
    .from(schema.message)
    .innerJoin(
      schema.conversation,
      eq(schema.conversation.id, schema.message.conversationId)
    )
    .where(eq(schema.message.waMessageId, body.data.waMessageId))
    .limit(1);
  if (!rows[0]) return apiError(404, "not_found", "Mensaje no encontrado");

  // El estado llega por el número de la conversación del mensaje (F2).
  const creds = rows[0].phoneNumberId
    ? await getCredentialsByPhoneNumberId(rows[0].phoneNumberId)
    : await getCredentialsByOrg(rows[0].organizationId);
  if (!creds) return apiError(409, "not_connected", "Sin número conectado");

  const payload = buildStatusPayload({
    wabaId: creds.wabaId,
    phoneNumberId: creds.phoneNumberId,
    waMessageId: body.data.waMessageId,
    status: body.data.status,
  });
  const res = await deliverToWebhook(payload);
  return res.ok
    ? Response.json({ delivered: true })
    : apiError(502, "webhook_error", `El webhook respondió ${res.status}`);
}
