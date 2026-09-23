import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";

/**
 * F1 — transporte dual (Constitución II v1.3.0): WHATSAPP_PROVIDER elige entre
 * Graph directa (Bearer <token del número>) y el proxy de Kapso
 * (X-API-Key de instancia), siempre por el mismo cliente único.
 */

const markReconnect = vi.fn();
const scheduleAgentTurn = vi.fn();

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    update: () => ({
      set: () => ({
        where: () => {
          markReconnect();
          return Promise.resolve();
        },
      }),
    }),
  }),
  schema: {
    whatsappNumber: {
      organizationId: "organization_id",
      phoneNumberId: "phone_number_id",
    },
  },
}));

vi.mock("@/server/ai/pipeline", () => ({ scheduleAgentTurn }));

const BASE_ENV = {
  APP_BASE_URL: "http://localhost:3000",
  DATABASE_URL: "postgresql://t:t@localhost:5432/t",
  BETTER_AUTH_SECRET: "secret-de-test-suficiente",
  ENCRYPTION_KEY: Buffer.alloc(32, 9).toString("base64"),
  META_WEBHOOK_VERIFY_TOKEN: "verify-test",
};

const TOUCHED = [
  "WHATSAPP_PROVIDER",
  "KAPSO_API_KEY",
  "KAPSO_WHATSAPP_API_URL",
  "KAPSO_API_BASE_URL",
  "KAPSO_GRAPH_API_VERSION",
  "META_GRAPH_BASE_URL",
  "AGENT_ENGINE",
  "OPENROUTER_API_TOKEN",
];

function setEnv(extra: Record<string, string>) {
  for (const k of TOUCHED) delete process.env[k];
  Object.assign(process.env, BASE_ENV, extra);
  vi.resetModules(); // getEnv() está memoizado por módulo
}

type FetchCall = { url: string; headers: Record<string, string> };
let calls: FetchCall[] = [];

function stubFetch(respond: (url: string) => Response) {
  calls = [];
  vi.stubGlobal(
    "fetch",
    vi.fn(async (url: string, init?: RequestInit) => {
      calls.push({ url, headers: (init?.headers ?? {}) as Record<string, string> });
      return respond(url);
    })
  );
}

const KAPSO = {
  WHATSAPP_PROVIDER: "kapso",
  KAPSO_API_KEY: "kapso-key-1234",
  KAPSO_WHATSAPP_API_URL: "https://proxy.test/meta/whatsapp/",
  KAPSO_API_BASE_URL: "https://kapso.test",
};

beforeEach(() => {
  markReconnect.mockReset();
  scheduleAgentTurn.mockReset();
});

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("graphRequest: resolución del transporte", () => {
  it("meta: Graph directa con Bearer del número, sin X-API-Key", async () => {
    setEnv({ META_GRAPH_BASE_URL: "https://graph.test" });
    stubFetch(() => Response.json({ messages: [{ id: "wamid.1" }] }));
    const { graphRequest } = await import("@/lib/meta/client");

    await graphRequest("pn1/messages", { method: "POST", token: "tok-abc", body: {} });

    expect(calls[0]!.url).toBe("https://graph.test/v25.0/pn1/messages");
    expect(calls[0]!.headers.Authorization).toBe("Bearer tok-abc");
    expect(calls[0]!.headers["X-API-Key"]).toBeUndefined();
  });

  it("kapso: proxy + versión de Kapso + X-API-Key; el token del número se ignora", async () => {
    setEnv(KAPSO);
    stubFetch(() => Response.json({ messages: [{ id: "wamid.2" }] }));
    const { graphRequest } = await import("@/lib/meta/client");

    await graphRequest("pn1/messages", { method: "POST", token: "tok-ignorado", body: {} });

    expect(calls[0]!.url).toBe("https://proxy.test/meta/whatsapp/v24.0/pn1/messages");
    expect(calls[0]!.headers["X-API-Key"]).toBe("kapso-key-1234");
    expect(calls[0]!.headers.Authorization).toBeUndefined();
  });

  it("meta sin token: error de programación antes de tocar la red", async () => {
    setEnv({});
    stubFetch(() => Response.json({}));
    const { graphRequest } = await import("@/lib/meta/client");

    await expect(graphRequest("pn1", { token: null })).rejects.toThrow(/requiere el token/);
    expect(calls).toHaveLength(0);
  });

  it("kapsoPlatformRequest apunta a /platform/v1 con X-API-Key", async () => {
    setEnv(KAPSO);
    stubFetch(() => Response.json({ data: [] }));
    const { kapsoPlatformRequest } = await import("@/lib/meta/client");

    await kapsoPlatformRequest("whatsapp/phone_numbers?page=1&per_page=100");

    expect(calls[0]!.url).toBe(
      "https://kapso.test/platform/v1/whatsapp/phone_numbers?page=1&per_page=100"
    );
    expect(calls[0]!.headers["X-API-Key"]).toBe("kapso-key-1234");
  });

  it("error de Kapso con `error` string se traduce a MetaApiError con su mensaje", async () => {
    setEnv(KAPSO);
    stubFetch(() => Response.json({ error: "Invalid API key" }, { status: 401 }));
    const { graphRequest, MetaApiError } = await import("@/lib/meta/client");

    const err = await graphRequest("pn1", {}).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(MetaApiError);
    expect((err as InstanceType<typeof MetaApiError>).message).toBe("Invalid API key");
    expect((err as InstanceType<typeof MetaApiError>).isApiKeyError).toBe(true);
  });
});

describe("validación del entorno", () => {
  it("WHATSAPP_PROVIDER=kapso sin KAPSO_API_KEY falla con guía", async () => {
    setEnv({ WHATSAPP_PROVIDER: "kapso" });
    const { getEnv } = await import("@/lib/env");
    expect(() => getEnv()).toThrow(/KAPSO_API_KEY/);
  });

  it("default: meta y agente interno", async () => {
    setEnv({});
    const { getWhatsappProvider, getAgentEngine } = await import("@/lib/env");
    expect(getWhatsappProvider()).toBe("meta");
    expect(getAgentEngine()).toBe("vocero");
  });

  it("kapso: el motor por defecto es Hermes", async () => {
    setEnv(KAPSO);
    const { getAgentEngine } = await import("@/lib/env");
    expect(getAgentEngine()).toBe("hermes");
  });
});

describe("connectionProblem", () => {
  const base = {
    id: "c1",
    organizationId: "org_1",
    wabaId: "w1",
    phoneNumberId: "pn1",
    displayPhoneNumber: null,
    verifiedName: null,
    status: "connected" as const,
    isDefault: true,
    enabled: true,
  };

  it("sin conexión → not_connected", async () => {
    setEnv({});
    const { connectionProblem } = await import("@/server/whatsapp/credentials");
    expect(connectionProblem(null, "meta")?.code).toBe("not_connected");
  });

  it("conexión meta con instancia en kapso → not_connected con guía", async () => {
    setEnv({});
    const { connectionProblem } = await import("@/server/whatsapp/credentials");
    const p = connectionProblem({ ...base, provider: "meta", token: "t" }, "kapso");
    expect(p?.code).toBe("not_connected");
    expect(p?.message).toMatch(/es de Meta pero la instancia usa Kapso/);
  });

  it("meta sin token → not_connected (nunca llega a graphRequest)", async () => {
    setEnv({});
    const { connectionProblem } = await import("@/server/whatsapp/credentials");
    expect(
      connectionProblem({ ...base, provider: "meta", token: null }, "meta")?.code
    ).toBe("not_connected");
  });

  it("kapso sin token es válida", async () => {
    setEnv({});
    const { connectionProblem } = await import("@/server/whatsapp/credentials");
    expect(connectionProblem({ ...base, provider: "kapso", token: null }, "kapso")).toBeNull();
  });

  it("número desactivado → not_connected con guía (F2)", async () => {
    setEnv({});
    const { connectionProblem } = await import("@/server/whatsapp/credentials");
    const p = connectionProblem(
      { ...base, provider: "kapso", token: null, enabled: false, verifiedName: "Sucursal Norte" },
      "kapso"
    );
    expect(p?.code).toBe("not_connected");
    expect(p?.message).toMatch(/Sucursal Norte está desactivado/);
  });

  it("reconnect_required se respeta", async () => {
    setEnv({});
    const { connectionProblem } = await import("@/server/whatsapp/credentials");
    expect(
      connectionProblem(
        { ...base, status: "reconnect_required", provider: "meta", token: "t" },
        "meta"
      )?.code
    ).toBe("reconnect_required");
  });
});

const NUM = { organizationId: "org_1", phoneNumberId: "pn1" };

describe("handleTransportAuthError", () => {
  it("kapso: key rechazada → mensaje de KAPSO_API_KEY y NO marca la conexión", async () => {
    setEnv(KAPSO);
    const { MetaApiError } = await import("@/lib/meta/client");
    const { handleTransportAuthError, KAPSO_KEY_REJECTED } = await import(
      "@/server/whatsapp/credentials"
    );
    const msg = await handleTransportAuthError(
      new MetaApiError("x", { status: 403 }),
      NUM,
      "kapso"
    );
    expect(msg).toBe(KAPSO_KEY_REJECTED);
    expect(markReconnect).not.toHaveBeenCalled();
  });

  it("kapso: OAuth de Meta reenviado (190) → guía de reconectar en Kapso, no culpa a la key", async () => {
    setEnv(KAPSO);
    const { MetaApiError } = await import("@/lib/meta/client");
    const { handleTransportAuthError, KAPSO_META_AUTH_FAILED } = await import(
      "@/server/whatsapp/credentials"
    );
    const err = new MetaApiError("x", { status: 401, code: 190, type: "OAuthException" });
    expect(err.isApiKeyError).toBe(false);
    expect(await handleTransportAuthError(err, NUM, "kapso")).toBe(KAPSO_META_AUTH_FAILED);
    expect(markReconnect).not.toHaveBeenCalled();
  });

  it("meta: token vencido → marca reconnect_required", async () => {
    setEnv({});
    const { MetaApiError } = await import("@/lib/meta/client");
    const { handleTransportAuthError } = await import("@/server/whatsapp/credentials");
    const msg = await handleTransportAuthError(
      new MetaApiError("x", { status: 400, code: 190 }),
      NUM,
      "meta"
    );
    expect(msg).toMatch(/expiró/);
    expect(markReconnect).toHaveBeenCalledTimes(1);
  });

  it("un 500 no es de auth en ningún modo", async () => {
    setEnv({});
    const { MetaApiError } = await import("@/lib/meta/client");
    const { handleTransportAuthError } = await import("@/server/whatsapp/credentials");
    const err = new MetaApiError("x", { status: 500 });
    expect(await handleTransportAuthError(err, NUM, "meta")).toBeNull();
    expect(await handleTransportAuthError(err, NUM, "kapso")).toBeNull();
  });
});

describe("testConnection en modo kapso (API de plataforma)", () => {
  const numbersPage = (page: number) =>
    Response.json({
      data:
        page === 1
          ? [{ phone_number_id: "pn-a", business_account_id: "waba-a", display_phone_number: "+52 1" }]
          : [{ phone_number_id: "pn-b", business_account_id: "waba-b", display_phone_number: "+52 2", verified_name: "B" }],
      meta: { total_pages: 2 },
    });

  it("encuentra el número (paginando) y devuelve su WABA", async () => {
    setEnv(KAPSO);
    stubFetch((url) => numbersPage(new URL(url).searchParams.get("page") === "2" ? 2 : 1));
    const { testConnection } = await import("@/server/whatsapp/connect");

    const res = await testConnection("pn-b");
    expect(res).toEqual({
      ok: true,
      displayPhoneNumber: "+52 2",
      verifiedName: "B",
      wabaId: "waba-b",
    });
    expect(calls).toHaveLength(2);
  });

  it("número ausente → number_not_found", async () => {
    setEnv(KAPSO);
    stubFetch((url) => numbersPage(new URL(url).searchParams.get("page") === "2" ? 2 : 1));
    const { testConnection } = await import("@/server/whatsapp/connect");
    const res = await testConnection("pn-z");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("number_not_found");
  });

  it("key inválida → invalid_token con guía de KAPSO_API_KEY", async () => {
    setEnv(KAPSO);
    stubFetch(() => Response.json({ error: "Invalid API key" }, { status: 401 }));
    const { testConnection } = await import("@/server/whatsapp/connect");
    const res = await testConnection("pn-a");
    expect(res.ok).toBe(false);
    if (!res.ok) {
      expect(res.code).toBe("invalid_token");
      expect(res.message).toMatch(/KAPSO_API_KEY/);
    }
  });

  it("Kapso caído → meta_unavailable (degrada, no lanza)", async () => {
    setEnv(KAPSO);
    vi.stubGlobal("fetch", vi.fn(async () => Promise.reject(new Error("ECONNREFUSED"))));
    const { testConnection } = await import("@/server/whatsapp/connect");
    const res = await testConnection("pn-a");
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.code).toBe("meta_unavailable");
  });
});

describe("un solo agente respondiendo", () => {
  it("kapso (Hermes por defecto): el agente interno NO se programa", async () => {
    setEnv({ ...KAPSO, OPENROUTER_API_TOKEN: "tok" });
    const { maybeRunAgentTurn } = await import("@/server/ai/trigger");
    await maybeRunAgentTurn("cv_1");
    expect(scheduleAgentTurn).not.toHaveBeenCalled();
  });

  it("kapso con AGENT_ENGINE=vocero explícito: el agente interno sí corre", async () => {
    setEnv({ ...KAPSO, OPENROUTER_API_TOKEN: "tok", AGENT_ENGINE: "vocero" });
    const { maybeRunAgentTurn } = await import("@/server/ai/trigger");
    await maybeRunAgentTurn("cv_1");
    expect(scheduleAgentTurn).toHaveBeenCalledWith("cv_1");
  });

  it("meta (default): sin cambios, el agente interno corre", async () => {
    setEnv({ OPENROUTER_API_TOKEN: "tok" });
    const { maybeRunAgentTurn } = await import("@/server/ai/trigger");
    await maybeRunAgentTurn("cv_1");
    expect(scheduleAgentTurn).toHaveBeenCalledWith("cv_1");
  });
});
