import { mockGuard } from "@/lib/dev-guard";
import { MOCK_KAPSO_PHONE_NUMBERS } from "@/server/dev/wa-mock-state";

/**
 * Imitación de la API de plataforma de Kapso: listado paginado de números
 * (`GET /platform/v1/whatsapp/phone_numbers`). El cliente real apunta aquí
 * cuando KAPSO_API_BASE_URL = <app>/api/dev/wa-mock.
 * API key con sufijo `-invalid` → 401.
 */
export const dynamic = "force-dynamic";

export async function GET(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;
  const apiKey = req.headers.get("x-api-key") ?? "";
  if (!apiKey || apiKey.endsWith("-invalid")) {
    return Response.json({ error: "Invalid API key" }, { status: 401 });
  }
  const url = new URL(req.url);
  const perPage = Math.max(1, Number(url.searchParams.get("per_page") ?? 100) || 100);
  const page = Math.max(1, Number(url.searchParams.get("page") ?? 1) || 1);
  const totalPages = Math.max(1, Math.ceil(MOCK_KAPSO_PHONE_NUMBERS.length / perPage));
  const data = MOCK_KAPSO_PHONE_NUMBERS.slice((page - 1) * perPage, page * perPage);
  return Response.json({
    data,
    meta: {
      page,
      per_page: perPage,
      total_pages: totalPages,
      total_count: MOCK_KAPSO_PHONE_NUMBERS.length,
    },
  });
}
