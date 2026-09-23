/**
 * Estado en memoria del harness wa-mock (solo dev/test). Vive en globalThis
 * porque Next recarga módulos en dev; una instancia = un proceso, así que el
 * outbox en memoria es suficiente para las aserciones del self-test.
 */

export type OutboxEntry = {
  n: number;
  phoneNumberId: string;
  to: string;
  type: string;
  body: unknown;
  /** Cómo se autenticó el envío: Bearer (Meta) o X-API-Key (proxy Kapso). */
  auth: "bearer" | "api-key" | "none";
  at: string;
};

/** Números que el mock de Kapso reporta en /platform/v1/whatsapp/phone_numbers. */
export const MOCK_KAPSO_PHONE_NUMBERS = [
  {
    id: "kpn_mock_1",
    phone_number_id: "kapso-pn-1",
    business_account_id: "kapso-waba-1",
    display_phone_number: "+52 55 1111 0001",
    verified_name: "Número Kapso de prueba 1",
    status: "CONNECTED",
  },
  {
    id: "kpn_mock_2",
    phone_number_id: "kapso-pn-2",
    business_account_id: "kapso-waba-1",
    display_phone_number: "+52 55 1111 0002",
    verified_name: "Número Kapso de prueba 2",
    status: "CONNECTED",
  },
];

export type MockTemplate = {
  id: string;
  name: string;
  language: string;
  category: string;
  status: "PENDING" | "APPROVED" | "REJECTED";
  body: string;
};

type WaMockState = {
  outbox: OutboxEntry[];
  templates: MockTemplate[];
  counter: number;
};

const globalForMock = globalThis as unknown as { __waMockState?: WaMockState };

export function getWaMockState(): WaMockState {
  if (!globalForMock.__waMockState) {
    globalForMock.__waMockState = { outbox: [], templates: [], counter: 0 };
  }
  return globalForMock.__waMockState;
}

export function resetWaMockState(): void {
  globalForMock.__waMockState = { outbox: [], templates: [], counter: 0 };
}

export function nextN(): number {
  return ++getWaMockState().counter;
}

/**
 * Sufijo del proceso: el estado vive en memoria y el contador vuelve a 1 en
 * cada arranque, pero los wamid persisten en la BD (UNIQUE). Como en WhatsApp
 * real, los ids del mock deben ser únicos también entre reinicios.
 */
const BOOT_ID = Date.now().toString(36);

export function mockWamid(direction: "in" | "out", n: number): string {
  return `wamid.mock.${direction}.${n}.${BOOT_ID}`;
}
