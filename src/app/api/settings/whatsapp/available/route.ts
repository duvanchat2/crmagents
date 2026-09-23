import { apiError, withAuth } from "@/lib/api";
import { getWhatsappProvider } from "@/lib/env";
import { MetaApiError } from "@/lib/meta/client";
import { listKapsoPhoneNumbers } from "@/server/whatsapp/connect";
import {
  getCredentialsByPhoneNumberId,
  KAPSO_KEY_REJECTED,
} from "@/server/whatsapp/credentials";

export const dynamic = "force-dynamic";

/**
 * Modo kapso: números de la cuenta de Kapso de la instancia, marcando cuáles
 * ya atiende esta organización y cuáles tiene otra organización de la
 * instancia (el phone_number_id es único en la instancia).
 */
export const GET = withAuth(async (session) => {
  if (getWhatsappProvider() !== "kapso") {
    return apiError(409, "not_kapso", "El descubrimiento de números solo aplica con WHATSAPP_PROVIDER=kapso");
  }
  let remote;
  try {
    remote = await listKapsoPhoneNumbers();
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isApiKeyError) return apiError(422, "invalid_token", KAPSO_KEY_REJECTED);
      return apiError(503, "meta_unavailable", "Kapso no está disponible en este momento; intenta de nuevo");
    }
    throw err;
  }
  const numbers = await Promise.all(
    remote
      .filter((n) => n.phone_number_id)
      .map(async (n) => {
        const local = await getCredentialsByPhoneNumberId(n.phone_number_id!);
        return {
          phoneNumberId: n.phone_number_id!,
          wabaId: n.business_account_id ?? null,
          displayPhoneNumber: n.display_phone_number ?? null,
          verifiedName: n.verified_name ?? null,
          status: n.status ?? null,
          state: !local
            ? ("available" as const)
            : local.organizationId === session.organizationId
              ? ("connected" as const)
              : ("taken" as const),
        };
      })
  );
  return Response.json({ numbers });
});
