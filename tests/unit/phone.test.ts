import { describe, expect, it } from "vitest";
import { normalizePhone } from "@/lib/phone";
import { normalizeRecipient } from "@/lib/meta/client";

describe("normalizePhone (normalizador único)", () => {
  it("México: móvil legado 521 + 10 dígitos → 52 + 10 dígitos", () => {
    expect(normalizePhone("5215512345678")).toBe("525512345678");
    expect(normalizePhone("+52 1 55 1234 5678")).toBe("525512345678");
    expect(normalizePhone("(+52) 1-55-1234-5678")).toBe("525512345678");
  });

  it("México ya canónico y fijos quedan intactos", () => {
    expect(normalizePhone("525512345678")).toBe("525512345678");
    expect(normalizePhone("+52 55 1234 5678")).toBe("525512345678");
  });

  it("Colombia 57: se limpia el formato y se conserva el número", () => {
    expect(normalizePhone("573001234567")).toBe("573001234567");
    expect(normalizePhone("+57 300 123 4567")).toBe("573001234567");
    expect(normalizePhone("+57 (300) 123-4567")).toBe("573001234567");
    expect(normalizePhone("0057 300 123 4567")).toBe("573001234567");
  });

  it("Colombia no se confunde con la regla de México", () => {
    // 57 + 10 dígitos que empiezan en 1 no es el patrón 521 de México
    expect(normalizePhone("571123456789")).toBe("571123456789");
  });

  it("otros países quedan intactos", () => {
    expect(normalizePhone("+1 (415) 555-2671")).toBe("14155552671");
    expect(normalizePhone("5491122334455")).toBe("5491122334455");
  });

  it("inválidos → null (vacío, muy corto, muy largo, sin dígitos)", () => {
    expect(normalizePhone("")).toBeNull();
    expect(normalizePhone(null)).toBeNull();
    expect(normalizePhone("abc")).toBeNull();
    expect(normalizePhone("521123")).toBeNull();
    expect(normalizePhone("1234567890123456")).toBeNull();
  });

  it("es idempotente", () => {
    for (const raw of ["5215512345678", "+57 300 123 4567", "14155552671"]) {
      const once = normalizePhone(raw)!;
      expect(normalizePhone(once)).toBe(once);
    }
  });

  it("el envío usa el mismo normalizador (normalizeRecipient delega)", () => {
    expect(normalizeRecipient("5215512345678")).toBe("525512345678");
    expect(normalizeRecipient("573001234567")).toBe("573001234567");
  });
});

describe("phoneLookupVariants (contactos legados sin reescribir)", () => {
  it("México canónico también busca la forma legada 521", async () => {
    const { phoneLookupVariants } = await import("@/lib/phone");
    expect(phoneLookupVariants("525512345678")).toEqual(["525512345678", "5215512345678"]);
  });

  it("Colombia y otros: solo la forma canónica", async () => {
    const { phoneLookupVariants } = await import("@/lib/phone");
    expect(phoneLookupVariants("573001234567")).toEqual(["573001234567"]);
    expect(phoneLookupVariants("14155552671")).toEqual(["14155552671"]);
  });
});
