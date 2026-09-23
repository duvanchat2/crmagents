import { beforeAll, describe, expect, it, vi } from "vitest";

/**
 * FR-040/FR-080s: el token se guarda cifrado (jamás texto plano en la fila)
 * y a la UI solo viajan los últimos 4 caracteres.
 */

const insertedRows: Record<string, unknown>[] = [];

/** Filas "guardadas" tal como las devolvería la BD (con defaults de columna). */
function storedRows() {
  return insertedRows.map((r) => ({
    status: "connected",
    enabled: true,
    createdAt: new Date(),
    updatedAt: new Date(),
    displayPhoneNumber: null,
    verifiedName: null,
    ...r,
  }));
}

/** Cadena select().from().where()[.orderBy()][.limit()] sobre las filas en memoria. */
function selectChain() {
  const done = () => Promise.resolve(storedRows());
  const tail = {
    limit: () => done(),
    orderBy: () => tail,
    then: (res: (v: unknown) => unknown, rej?: (e: unknown) => unknown) =>
      done().then(res, rej),
  };
  return { from: () => ({ where: () => tail }) };
}

vi.mock("@/lib/db", () => ({
  getDb: () => ({
    select: () => selectChain(),
    insert: () => ({
      values: (v: Record<string, unknown>) => {
        insertedRows.push(v);
        return {
          onConflictDoNothing: () => Promise.resolve(),
          onConflictDoUpdate: () => Promise.resolve(),
        };
      },
    }),
    update: () => ({ set: () => ({ where: () => Promise.resolve() }) }),
  }),
  schema: {
    whatsappNumber: {
      organizationId: "organization_id",
      phoneNumberId: "phone_number_id",
      isDefault: "is_default",
      createdAt: "created_at",
      id: "id",
    },
  },
}));

beforeAll(() => {
  process.env.APP_BASE_URL = "http://localhost:3000";
  process.env.DATABASE_URL = "postgresql://t:t@localhost:5432/t";
  process.env.BETTER_AUTH_SECRET = "secret-de-test-suficiente";
  process.env.ENCRYPTION_KEY = Buffer.alloc(32, 9).toString("base64");
  process.env.META_WEBHOOK_VERIFY_TOKEN = "verify-test";
});

describe("credenciales de WhatsApp", () => {
  it("saveCredentials cifra el token: la fila no contiene el texto plano", async () => {
    const { saveCredentials } = await import("@/server/whatsapp/credentials");
    insertedRows.length = 0;
    const token = "EAAG-token-super-secreto-abcd";
    await saveCredentials({
      organizationId: "org_1",
      wabaId: "waba1",
      phoneNumberId: "pn1",
      provider: "meta",
      token,
    });
    const row = insertedRows[0]!;
    const serialized = JSON.stringify(row);
    expect(serialized).not.toContain(token);
    expect(row.tokenCipher).toBeTruthy();
    expect(row.tokenIv).toBeTruthy();
    expect(row.tokenTag).toBeTruthy();
    // el primer número de la organización queda como predeterminado (F2)
    expect(row.isDefault).toBe(true);

    // y el cifrado es reversible con la clave de la instancia
    const { decryptSecret } = await import("@/lib/crypto");
    expect(
      decryptSecret({
        cipher: row.tokenCipher as string,
        iv: row.tokenIv as string,
        tag: row.tokenTag as string,
      })
    ).toBe(token);
  });

  it("kapso: se guarda sin token (API key de instancia) y con su proveedor", async () => {
    const { saveCredentials } = await import("@/server/whatsapp/credentials");
    insertedRows.length = 0;
    await saveCredentials({
      organizationId: "org_1",
      wabaId: "waba1",
      phoneNumberId: "pn1",
      provider: "kapso",
    });
    const row = insertedRows[0]!;
    expect(row.provider).toBe("kapso");
    expect(row.tokenCipher).toBeNull();
    expect(row.tokenIv).toBeNull();
    expect(row.tokenTag).toBeNull();
  });

  it("meta sin token se rechaza antes de escribir", async () => {
    const { saveCredentials } = await import("@/server/whatsapp/credentials");
    insertedRows.length = 0;
    await expect(
      saveCredentials({
        organizationId: "org_1",
        wabaId: "waba1",
        phoneNumberId: "pn1",
        provider: "meta",
      })
    ).rejects.toThrow(/requiere token/);
    expect(insertedRows).toHaveLength(0);
  });

  it("tokenLast4 expone solo los últimos 4 caracteres", async () => {
    const { tokenLast4 } = await import("@/server/whatsapp/credentials");
    expect(tokenLast4("EAAG-token-super-secreto-abcd")).toBe("abcd");
    expect(tokenLast4(null)).toBeNull();
  });
});
