import { withAuth } from "@/lib/api";
import { listNumbers, serializeNumber } from "@/server/whatsapp/credentials";

export const dynamic = "force-dynamic";

/** Números activos de la organización para la bandeja (filtro y chat nuevo). */
export const GET = withAuth(async (session) => {
  const numbers = await listNumbers(session.organizationId);
  return Response.json({
    numbers: numbers.filter((n) => n.enabled).map(serializeNumber),
  });
});
