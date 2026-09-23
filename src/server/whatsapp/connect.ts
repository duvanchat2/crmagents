import { getWhatsappProvider } from "@/lib/env";
import {
  graphRequest,
  kapsoPlatformRequest,
  MetaApiError,
} from "@/lib/meta/client";
import {
  KAPSO_KEY_REJECTED,
  KAPSO_META_AUTH_FAILED,
} from "@/server/whatsapp/credentials";

export type ConnectionCheck =
  | {
      ok: true;
      displayPhoneNumber: string;
      verifiedName: string | null;
      /** WABA del número según el transporte (Kapso lo informa; Meta no en este GET). */
      wabaId: string | null;
    }
  | {
      ok: false;
      code: "invalid_token" | "meta_unavailable" | "meta_error" | "number_not_found";
      message: string;
    };

type KapsoPhoneNumber = {
  phone_number_id?: string;
  business_account_id?: string;
  display_phone_number?: string;
  display_name?: string;
  verified_name?: string;
  status?: string;
};

type KapsoPhoneNumbersPage = {
  data?: KapsoPhoneNumber[];
  meta?: { total_pages?: number };
};

/** Tope defensivo de páginas al listar números de Kapso (100 por página). */
const KAPSO_MAX_PAGES = 20;

/**
 * Números de WhatsApp de la cuenta de Kapso (API de plataforma, paginada).
 * Misma fuente que usa el inbox de referencia de Kapso.
 */
export async function listKapsoPhoneNumbers(): Promise<KapsoPhoneNumber[]> {
  const all: KapsoPhoneNumber[] = [];
  let page = 1;
  let totalPages = 1;
  do {
    const res = await kapsoPlatformRequest<KapsoPhoneNumbersPage>(
      `whatsapp/phone_numbers?page=${page}&per_page=100`
    );
    all.push(...(res.data ?? []));
    totalPages = res.meta?.total_pages ?? 1;
    page += 1;
  } while (page <= totalPages && page <= KAPSO_MAX_PAGES);
  return all;
}

/**
 * Modo kapso: el número debe existir en la cuenta de Kapso de la instancia
 * (la API key es de instancia; no hay token por número).
 */
async function testKapsoConnection(phoneNumberId: string): Promise<ConnectionCheck> {
  try {
    const numbers = await listKapsoPhoneNumbers();
    const match = numbers.find((n) => n.phone_number_id === phoneNumberId);
    if (!match) {
      return {
        ok: false,
        code: "number_not_found",
        message:
          "Ese Phone Number ID no está en tu cuenta de Kapso: conéctalo primero en app.kapso.ai o revisa el ID",
      };
    }
    return {
      ok: true,
      displayPhoneNumber:
        match.display_phone_number ?? match.display_name ?? phoneNumberId,
      verifiedName: match.verified_name ?? null,
      wabaId: match.business_account_id ?? null,
    };
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isApiKeyError) {
        return { ok: false, code: "invalid_token", message: KAPSO_KEY_REJECTED };
      }
      if (err.isMetaOAuthError) {
        return { ok: false, code: "invalid_token", message: KAPSO_META_AUTH_FAILED };
      }
      if (err.status === 0 || err.status >= 500) {
        return {
          ok: false,
          code: "meta_unavailable",
          message: "Kapso no está disponible en este momento; intenta de nuevo",
        };
      }
      return { ok: false, code: "meta_error", message: err.message };
    }
    throw err;
  }
}

/**
 * Valida la conexión SIN persistir nada (FR-040).
 * meta: token↔número con un GET del número en la Graph API.
 * kapso: el número existe en la cuenta de Kapso (el token no aplica).
 */
export async function testConnection(
  phoneNumberId: string,
  token?: string | null
): Promise<ConnectionCheck> {
  if (getWhatsappProvider() === "kapso") {
    return testKapsoConnection(phoneNumberId);
  }
  if (!token) {
    return { ok: false, code: "invalid_token", message: "Falta el token de acceso" };
  }
  try {
    const res = await graphRequest<{
      display_phone_number?: string;
      verified_name?: string;
      id: string;
    }>(`${phoneNumberId}?fields=display_phone_number,verified_name`, {
      token,
    });
    if (!res.display_phone_number) {
      return {
        ok: false,
        code: "meta_error",
        message:
          "Meta no devolvió el número: verifica que el Phone Number ID sea correcto",
      };
    }
    return {
      ok: true,
      displayPhoneNumber: res.display_phone_number,
      verifiedName: res.verified_name ?? null,
      wabaId: null,
    };
  } catch (err) {
    if (err instanceof MetaApiError) {
      if (err.isAuthError) {
        return {
          ok: false,
          code: "invalid_token",
          message:
            "El token no es válido o expiró. Verifica que corresponde a este número (modo directo: token de usuario del sistema; modo agencia: token entregado por tu backend).",
        };
      }
      if (err.status === 0 || err.status >= 500) {
        return {
          ok: false,
          code: "meta_unavailable",
          message: "Meta no está disponible en este momento; intenta de nuevo",
        };
      }
      return { ok: false, code: "meta_error", message: err.message };
    }
    throw err;
  }
}

/**
 * Suscribe la app a la WABA tras guardar (necesario para recibir webhooks en
 * modo directo). Best-effort: en modo agencia el override lo configura el
 * backend de la agencia y esta llamada puede no aplicar.
 */
export async function subscribeAppToWaba(
  wabaId: string,
  token: string | null
): Promise<void> {
  // En kapso la suscripción de la app a la WABA la gestiona Kapso; los eventos
  // llegan por webhooks registrados por número (F3).
  if (getWhatsappProvider() === "kapso" || !token) return;
  try {
    await graphRequest(`${wabaId}/subscribed_apps`, {
      method: "POST",
      token,
    });
  } catch (err) {
    console.warn(
      "[connect] subscribed_apps falló (esperado en modo agencia):",
      err instanceof Error ? err.message : err
    );
  }
}
