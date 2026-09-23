import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getEnv, getWhatsappProvider } from "@/lib/env";
import {
  listNumbers,
  NumberTakenError,
  saveCredentials,
  serializeNumber,
  tokenLast4,
} from "@/server/whatsapp/credentials";
import { subscribeAppToWaba, testConnection } from "@/server/whatsapp/connect";

export const dynamic = "force-dynamic";

/** Transporte activo + últimos 4 de la API key de Kapso (jamás la key). */
function transportInfo() {
  const provider = getWhatsappProvider();
  const key = getEnv().KAPSO_API_KEY;
  return {
    provider,
    apiKeyLast4: provider === "kapso" && key ? tokenLast4(key) : null,
  };
}

/** Números de la organización (F2: varios; el predeterminado primero). */
export const GET = withAuth(async (session) => {
  const numbers = await listNumbers(session.organizationId);
  return Response.json({
    ...transportInfo(),
    numbers: numbers.map(serializeNumber),
  });
});

const putSchema = z.object({
  /** En kapso puede venir vacío: la WABA real la informa Kapso al validar. */
  wabaId: z.string().trim().optional(),
  phoneNumberId: z.string().trim().min(1),
  /** Obligatorio en meta; en kapso se ignora (API key de instancia). */
  token: z.string().trim().min(1).optional(),
});

/**
 * Agrega (o reconecta) un número: re-valida contra el transporte, cifra el
 * token (meta) y lo guarda. El primero de la organización queda predeterminado.
 */
export const PUT = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, putSchema);
  if (!body.ok) return body.response;

  const provider = getWhatsappProvider();
  const token = provider === "meta" ? body.data.token : undefined;
  if (provider === "meta" && !token) {
    return apiError(422, "invalid_token", "Falta el token de acceso");
  }

  const check = await testConnection(body.data.phoneNumberId, token);
  if (!check.ok) {
    const status = check.code === "meta_unavailable" ? 503 : 422;
    return apiError(status, check.code, check.message);
  }

  const wabaId = check.wabaId || body.data.wabaId; // Kapso informa la WABA real
  if (!wabaId) {
    return apiError(422, "invalid", "Falta el WABA ID (ID de la cuenta de WhatsApp Business)");
  }
  let saved;
  try {
    saved = await saveCredentials({
      organizationId: session.organizationId,
      wabaId,
      phoneNumberId: body.data.phoneNumberId,
      provider,
      token: token ?? null,
      displayPhoneNumber: check.displayPhoneNumber,
      verifiedName: check.verifiedName,
    });
  } catch (err) {
    if (err instanceof NumberTakenError) {
      return apiError(409, "number_taken", err.message);
    }
    throw err;
  }

  // Best-effort: necesaria en modo directo; el modo agencia usa su override.
  await subscribeAppToWaba(wabaId, token ?? null);

  return Response.json({
    ok: true,
    displayPhoneNumber: check.displayPhoneNumber,
    number: serializeNumber(saved),
  });
});
