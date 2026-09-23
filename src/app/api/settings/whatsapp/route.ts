import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getEnv, getWhatsappProvider } from "@/lib/env";
import {
  getCredentialsByOrg,
  saveCredentials,
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

export const GET = withAuth(async (session) => {
  const creds = await getCredentialsByOrg(session.organizationId);
  const transport = transportInfo();
  if (!creds) return Response.json({ ...transport, connection: null });
  return Response.json({
    ...transport,
    connection: {
      wabaId: creds.wabaId,
      phoneNumberId: creds.phoneNumberId,
      displayPhoneNumber: creds.displayPhoneNumber,
      verifiedName: creds.verifiedName,
      status: creds.status,
      provider: creds.provider,
      tokenLast4: tokenLast4(creds.token),
    },
  });
});

const putSchema = z.object({
  wabaId: z.string().trim().min(1),
  phoneNumberId: z.string().trim().min(1),
  /** Obligatorio en meta; en kapso se ignora (API key de instancia). */
  token: z.string().trim().min(1).optional(),
});

/** Guarda la conexión: re-valida contra el transporte, cifra y suscribe (FR-040). */
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

  await saveCredentials({
    organizationId: session.organizationId,
    // Kapso informa la WABA real del número: prevalece sobre la tecleada.
    wabaId: check.wabaId ?? body.data.wabaId,
    phoneNumberId: body.data.phoneNumberId,
    provider,
    token: token ?? null,
    displayPhoneNumber: check.displayPhoneNumber,
    verifiedName: check.verifiedName,
  });

  // Best-effort: necesaria en modo directo; el modo agencia usa su override.
  await subscribeAppToWaba(check.wabaId ?? body.data.wabaId, token ?? null);

  return Response.json({
    ok: true,
    displayPhoneNumber: check.displayPhoneNumber,
  });
});
