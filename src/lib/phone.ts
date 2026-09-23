/**
 * Normalizador ÚNICO de teléfonos de WhatsApp (F2). Toda entrada de teléfono
 * —webhook (`wa_id`), alta manual de contactos, envío— pasa por aquí, así el
 * contacto es único por teléfono sin importar el formato de origen.
 *
 * Forma canónica: solo dígitos, con código de país, sin `+` (como el `wa_id`
 * de Meta). No adivina el país: un número sin código de país no se completa.
 *
 * Reglas por país:
 * - México (52): los móviles legados llegan como `521` + 10 dígitos; la forma
 *   canónica es `52` + 10 dígitos (enviar con el `1` produce el error 131030).
 * - Colombia (57) y el resto: se conservan tal cual tras limpiar el formato.
 */

const MIN_DIGITS = 8;
const MAX_DIGITS = 15; // E.164

export function normalizePhone(raw: string | null | undefined): string | null {
  if (!raw) return null;
  let digits = raw.trim().replace(/\D+/g, "");
  // Prefijo internacional marcado desde fuera (00 + código de país).
  if (!raw.trim().startsWith("+") && digits.startsWith("00")) {
    digits = digits.slice(2);
  }
  if (digits.length < MIN_DIGITS || digits.length > MAX_DIGITS) return null;
  const mx = /^521(\d{10})$/.exec(digits);
  if (mx) return `52${mx[1]}`;
  return digits;
}

/** Igual que normalizePhone pero lanza si el teléfono es inválido. */
export function requirePhone(raw: string): string {
  const phone = normalizePhone(raw);
  if (!phone) {
    throw new Error(`Teléfono inválido: se esperan ${MIN_DIGITS}–${MAX_DIGITS} dígitos con código de país`);
  }
  return phone;
}

/**
 * Formas con las que un teléfono canónico puede estar ya guardado. La
 * migración 0002 NO reescribe teléfonos existentes: un contacto de México
 * creado antes de F2 puede seguir como `521…`. Las búsquedas prueban ambas
 * formas para no duplicar el contacto.
 */
export function phoneLookupVariants(canonical: string): string[] {
  const mx = /^52(\d{10})$/.exec(canonical);
  return mx ? [canonical, `521${mx[1]}`] : [canonical];
}
