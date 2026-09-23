import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import {
  listNumbers,
  serializeNumber,
  setDefaultNumber,
  setNumberEnabled,
} from "@/server/whatsapp/credentials";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

const patchSchema = z
  .object({
    isDefault: z.literal(true).optional(),
    enabled: z.boolean().optional(),
  })
  .refine((v) => v.isDefault !== undefined || v.enabled !== undefined, {
    message: "Indica isDefault o enabled",
  });

/**
 * Marca un número como predeterminado o lo activa/desactiva. Desactivar NO
 * borra el número ni su historial: deja de recibir y de enviar.
 */
export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  if (body.data.enabled !== undefined) {
    const ok = await setNumberEnabled(session.organizationId, id, body.data.enabled);
    if (!ok) return apiError(404, "not_found", "Número no encontrado");
  }
  if (body.data.isDefault) {
    const ok = await setDefaultNumber(session.organizationId, id);
    if (!ok) {
      return apiError(422, "invalid", "Solo un número activo puede ser el predeterminado");
    }
  }
  const numbers = await listNumbers(session.organizationId);
  return Response.json({ numbers: numbers.map(serializeNumber) });
});
