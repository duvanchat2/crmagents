import { readFileSync } from "node:fs";
import path from "node:path";
import { describe, expect, it } from "vitest";
import { z } from "zod";
import { envSchema } from "@/lib/env";

/**
 * Paridad env.ts ↔ docker-compose.yml (Ruta B). El compose pasa las variables
 * una por una al servicio `app`: una variable nueva en env.ts que no se agregue
 * aquí NO llega al contenedor (bug de F1 con WHATSAPP_PROVIDER / KAPSO_*).
 */

/** Variables de env.ts que a propósito NO van en el compose de producción. */
const NOT_IN_COMPOSE: Record<string, string> = {
  NODE_ENV: "lo fija el Dockerfile (ENV NODE_ENV=production)",
  WA_MOCK_ENABLED: "mocks del self-test: jamás en producción",
  META_GRAPH_BASE_URL: "solo se redirige al wa-mock en el self-test",
};

/** Variables que el compose construye en vez de leerlas del .env. */
const DERIVED_IN_COMPOSE = new Set(["DATABASE_URL"]);

/** Extrae `services.app.environment` (mapa KEY: valor) sin dependencia de YAML. */
function appEnvironment(yaml: string): Map<string, string> {
  const env = new Map<string, string>();
  let inServices = false;
  let inApp = false;
  let inEnv = false;
  let envIndent = -1;
  for (const raw of yaml.split(/\r?\n/)) {
    const line = raw.replace(/\s+#.*$/, "");
    if (!line.trim() || line.trim().startsWith("#")) continue;
    const indent = line.length - line.trimStart().length;
    const text = line.trim();
    if (indent === 0) {
      inServices = text === "services:";
      inApp = inEnv = false;
      continue;
    }
    if (!inServices) continue;
    if (indent === 2) {
      inApp = text === "app:";
      inEnv = false;
      continue;
    }
    if (!inApp) continue;
    if (indent === 4) {
      inEnv = text === "environment:";
      envIndent = -1;
      continue;
    }
    if (inEnv) {
      if (envIndent === -1) envIndent = indent;
      if (indent !== envIndent) continue;
      const m = /^([A-Z0-9_]+):\s*(.*)$/.exec(text);
      if (m) env.set(m[1]!, m[2]!.trim());
    }
  }
  return env;
}

const composePath = path.resolve(import.meta.dirname, "../../docker-compose.yml");
const compose = appEnvironment(readFileSync(composePath, "utf8"));
const shape = envSchema.innerType().shape;
const keys = Object.keys(shape);

function staticDefault(schema: z.ZodTypeAny): string | undefined {
  if (schema instanceof z.ZodDefault) {
    return String(schema._def.defaultValue());
  }
  return undefined;
}

describe("paridad env.ts ↔ docker-compose.yml", () => {
  it("el parser encuentra el bloque environment del servicio app", () => {
    expect(compose.size).toBeGreaterThan(5);
    expect(compose.has("APP_BASE_URL")).toBe(true);
  });

  it("toda variable de env.ts llega al servicio app (o está excluida con motivo)", () => {
    const missing = keys.filter((k) => !compose.has(k) && !(k in NOT_IN_COMPOSE));
    expect(
      missing,
      `Agrega a docker-compose.yml → services.app.environment: ${missing.join(", ")}`
    ).toEqual([]);
  });

  it("las exclusiones siguen existiendo en env.ts y no están en el compose", () => {
    for (const k of Object.keys(NOT_IN_COMPOSE)) {
      expect(keys, `${k} ya no existe en env.ts: quítalo de NOT_IN_COMPOSE`).toContain(k);
      expect(compose.has(k), `${k} está excluida pero aparece en el compose`).toBe(false);
    }
  });

  it("cada variable usa ${VAR} o ${VAR:-default} con el mismo default de env.ts", () => {
    const problems: string[] = [];
    for (const k of keys) {
      const value = compose.get(k);
      if (value === undefined || DERIVED_IN_COMPOSE.has(k)) continue;
      const m = /^\$\{([A-Z0-9_]+)(?::-([^}]*))?\}$/.exec(value);
      if (!m || m[1] !== k) {
        problems.push(`${k}: se esperaba \${${k}} o \${${k}:-…}, hay "${value}"`);
        continue;
      }
      const expected = staticDefault(shape[k as keyof typeof shape] as z.ZodTypeAny);
      const actual = m[2];
      if (expected !== undefined && actual !== expected) {
        problems.push(`${k}: default "${actual ?? "(ninguno)"}" ≠ env.ts "${expected}"`);
      }
    }
    expect(problems).toEqual([]);
  });
});

/** Resuelve `${VAR}` / `${VAR:-default}` como docker compose con un .env dado. */
function renderCompose(dotenv: Record<string, string>): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, raw] of compose) {
    const value = raw.replace(
      /\$\{([A-Z0-9_]+)(?::-([^}]*))?\}/g,
      (_, name: string, def?: string) => dotenv[name] || def || ""
    );
    // env.ts ignora los strings vacíos (compose inyecta VAR="" en opcionales)
    if (value !== "") out[k] = value;
  }
  return out;
}

describe("lo que compose entrega al contenedor parsea con env.ts", () => {
  const base = {
    APP_BASE_URL: "https://crm.test",
    POSTGRES_PASSWORD: "x",
    BETTER_AUTH_SECRET: "secreto-de-prueba-suficiente",
    ENCRYPTION_KEY: Buffer.alloc(32, 1).toString("base64"),
    META_WEBHOOK_VERIFY_TOKEN: "verify-token-prueba",
  };

  it(".env sin variables nuevas → meta y agente derivado (instancias existentes no cambian)", () => {
    const parsed = envSchema.safeParse(renderCompose(base));
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.WHATSAPP_PROVIDER).toBe("meta");
      expect(parsed.data.AGENT_ENGINE).toBeUndefined();
    }
  });

  it(".env con kapso + key → llega el transporte y la key al contenedor", () => {
    const parsed = envSchema.safeParse(
      renderCompose({ ...base, WHATSAPP_PROVIDER: "kapso", KAPSO_API_KEY: "kk-1234" })
    );
    expect(parsed.success).toBe(true);
    if (parsed.success) {
      expect(parsed.data.WHATSAPP_PROVIDER).toBe("kapso");
      expect(parsed.data.KAPSO_API_KEY).toBe("kk-1234");
      expect(parsed.data.KAPSO_WHATSAPP_API_URL).toBe("https://api.kapso.ai/meta/whatsapp");
    }
  });

  it(".env con kapso sin key → el arranque falla con guía (no queda un envío a medias)", () => {
    const parsed = envSchema.safeParse(renderCompose({ ...base, WHATSAPP_PROVIDER: "kapso" }));
    expect(parsed.success).toBe(false);
    if (!parsed.success) {
      expect(parsed.error.issues.map((i) => i.path.join("."))).toContain("KAPSO_API_KEY");
    }
  });
});
