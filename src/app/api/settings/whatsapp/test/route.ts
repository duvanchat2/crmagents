import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getWhatsappProvider } from "@/lib/env";
import { testConnection } from "@/server/whatsapp/connect";

export const dynamic = "force-dynamic";

const bodySchema = z.object({
  phoneNumberId: z.string().trim().min(1),
  /** Obligatorio en meta; en kapso se ignora (API key de instancia). */
  token: z.string().trim().min(1).optional(),
});

/** Prueba de conexión: valida el número en el transporte activo, NO guarda (FR-040). */
export const POST = withAuth(async (_session, req: Request) => {
  const body = await parseBody(req, bodySchema);
  if (!body.ok) return body.response;

  const token = getWhatsappProvider() === "meta" ? body.data.token : undefined;
  const check = await testConnection(body.data.phoneNumberId, token);
  if (!check.ok) {
    const status = check.code === "meta_unavailable" ? 503 : 422;
    return apiError(status, check.code, check.message);
  }
  return Response.json({
    ok: true,
    displayPhoneNumber: check.displayPhoneNumber,
    verifiedName: check.verifiedName,
    wabaId: check.wabaId,
  });
});
