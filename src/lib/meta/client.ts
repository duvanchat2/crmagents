import { getEnv, type WhatsappProvider } from "@/lib/env";

/**
 * Cliente propio del transporte de WhatsApp (Cloud API).
 * Única frontera de salida (Constitución II): todo request pasa por
 * graphRequest / kapsoPlatformRequest. El transporte lo fija WHATSAPP_PROVIDER:
 *  - meta:  Graph API directa, `Authorization: Bearer <token del número>`.
 *  - kapso: proxy de Kapso con las mismas rutas y respuestas de Graph,
 *           `X-API-Key: <KAPSO_API_KEY>` (clave de instancia; el token no aplica).
 * En self-test, las URLs base apuntan al wa-mock.
 */

export class MetaApiError extends Error {
  status: number;
  code: number | null;
  type: string | null;
  details: unknown;

  constructor(
    message: string,
    opts: { status: number; code?: number | null; type?: string | null; details?: unknown }
  ) {
    super(message);
    this.name = "MetaApiError";
    this.status = opts.status;
    this.code = opts.code ?? null;
    this.type = opts.type ?? null;
    this.details = opts.details;
  }

  /**
   * API key de Kapso rechazada (modo kapso): 401 o 403 del proxy que NO sea un
   * error OAuth de Meta reenviado (ese es del token que Kapso guarda del número).
   */
  get isApiKeyError(): boolean {
    return (
      (this.status === 401 || this.status === 403) && !this.isMetaOAuthError
    );
  }

  /** Error OAuth con la forma de Meta (code 190 / OAuthException). */
  get isMetaOAuthError(): boolean {
    return this.code === 190 || this.type === "OAuthException";
  }

  /** Token vencido/revocado → la conexión requiere re-autenticación. */
  get isAuthError(): boolean {
    return (
      this.status === 401 || this.code === 190 || this.type === "OAuthException"
    );
  }
}

type Transport = {
  provider: WhatsappProvider;
  baseUrl: string;
  headers: Record<string, string>;
};

/** Resuelve URL base y auth del transporte activo. */
export function resolveTransport(token?: string | null): Transport {
  const env = getEnv();
  if (env.WHATSAPP_PROVIDER === "kapso") {
    return {
      provider: "kapso",
      baseUrl: `${trimSlash(env.KAPSO_WHATSAPP_API_URL)}/${env.KAPSO_GRAPH_API_VERSION}`,
      headers: { "X-API-Key": env.KAPSO_API_KEY ?? "" },
    };
  }
  if (!token) {
    // Error de programación: los llamadores validan la conexión antes.
    throw new Error("graphRequest en modo meta requiere el token del número");
  }
  return {
    provider: "meta",
    baseUrl: `${trimSlash(env.META_GRAPH_BASE_URL)}/${env.META_GRAPH_API_VERSION}`,
    headers: { Authorization: `Bearer ${token}` },
  };
}

export async function graphRequest<T>(
  path: string,
  opts: {
    method?: "GET" | "POST" | "DELETE";
    /** Token del número (modo meta). Se ignora en modo kapso. */
    token?: string | null;
    body?: unknown;
  }
): Promise<T> {
  const transport = resolveTransport(opts.token);
  return sendRequest<T>(`${transport.baseUrl}/${path}`, transport, opts);
}

/**
 * API de plataforma de Kapso (`/platform/v1/...`): descubrimiento de números y
 * webhooks. Solo existe en modo kapso.
 */
export async function kapsoPlatformRequest<T>(
  path: string,
  opts: { method?: "GET" | "POST" | "DELETE"; body?: unknown } = {}
): Promise<T> {
  const env = getEnv();
  if (env.WHATSAPP_PROVIDER !== "kapso") {
    throw new Error("kapsoPlatformRequest solo aplica con WHATSAPP_PROVIDER=kapso");
  }
  const transport: Transport = {
    provider: "kapso",
    baseUrl: `${trimSlash(env.KAPSO_API_BASE_URL)}/platform/v1`,
    headers: { "X-API-Key": env.KAPSO_API_KEY ?? "" },
  };
  return sendRequest<T>(`${transport.baseUrl}/${path.replace(/^\//, "")}`, transport, opts);
}

async function sendRequest<T>(
  url: string,
  transport: Transport,
  opts: { method?: "GET" | "POST" | "DELETE"; body?: unknown }
): Promise<T> {
  const providerName = transport.provider === "kapso" ? "Kapso" : "Meta";
  let res: Response;
  try {
    res = await fetch(url, {
      method: opts.method ?? "GET",
      headers: {
        ...transport.headers,
        ...(opts.body !== undefined
          ? { "Content-Type": "application/json" }
          : {}),
      },
      body: opts.body !== undefined ? JSON.stringify(opts.body) : undefined,
    });
  } catch (cause) {
    throw new MetaApiError(`No se pudo contactar la API de ${providerName}`, {
      status: 0,
      details: cause,
    });
  }

  const text = await res.text();
  let json: unknown = null;
  try {
    json = text ? JSON.parse(text) : null;
  } catch {
    // respuesta no-JSON: se conserva el texto crudo en details
  }

  if (!res.ok) {
    const err = (json as { error?: { message?: string; code?: number; type?: string } | string })
      ?.error;
    const detail = typeof err === "string" ? { message: err } : err;
    throw new MetaApiError(detail?.message ?? `${providerName} respondió ${res.status}`, {
      status: res.status,
      code: detail?.code ?? null,
      type: detail?.type ?? null,
      details: json ?? text,
    });
  }
  return json as T;
}

function trimSlash(url: string): string {
  return url.replace(/\/+$/, "");
}

/**
 * Normaliza el destinatario para el envío. Números móviles de México llegan
 * de Meta como `521` + 10 dígitos (13 en total); enviar con ese `1` extra
 * produce el error 131030 — se envía como `52` + 10 dígitos.
 * El wa_id almacenado NO se modifica; esto aplica solo al enviar.
 */
export function normalizeRecipient(waId: string): string {
  if (/^521\d{10}$/.test(waId)) {
    return `52${waId.slice(3)}`;
  }
  return waId;
}
