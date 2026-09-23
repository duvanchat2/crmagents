// Self-test E2E F1 (transporte dual). Guion: tests/e2e/us-f1-kapso-transporte.md
// Uso: node tests/e2e/f1-kapso-transporte.mjs <happy|invalid-key|kapso-down|meta>
// Requiere la app en E2E_BASE_URL (default http://localhost:3100) con los mocks.
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const SHOTS = process.env.E2E_SHOTS_DIR ?? `${tmpdir()}/vocero-e2e-f1`;
mkdirSync(SHOTS, { recursive: true });
const scenario = process.argv[2] ?? "happy";
const EMAIL = "duena@e2e.test";
const PASS = "clave-e2e-segura-123";

const results = [];
function check(name, ok, detail = "") {
  results.push({ name, ok, detail });
  console.log(`${ok ? "✅" : "❌"} ${name}${detail ? " — " + detail : ""}`);
}

// E2E_CHROMIUM: ruta a un Chromium ya instalado si no coincide con la versión de Playwright.
const browser = await chromium.launch(
  process.env.E2E_CHROMIUM ? { executablePath: process.env.E2E_CHROMIUM } : {}
);
const ctx = await browser.newContext({ viewport: { width: 1280, height: 860 } });
const page = await ctx.newPage();
const api = page.request;

async function login() {
  await page.goto(`${BASE}/login`);
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/inbox/, { timeout: 20000 });
}

async function outbox() {
  return (await (await api.get(`${BASE}/api/dev/wa-mock/outbox`)).json()).outbox;
}

async function openConversation(name, lastText) {
  await page.goto(`${BASE}/inbox`);
  await page.getByText(name).first().click({ timeout: 15000 });
  await page.waitForSelector('textarea[placeholder="Escribe una respuesta…"]', { timeout: 15000 });
  // el hilo cargó (burbuja visible además de la vista previa de la lista)
  if (lastText) await page.getByText(lastText).nth(1).waitFor({ timeout: 15000 });
  await page.waitForTimeout(800); // hidratación (SSE mantiene la red abierta: no hay networkidle)
}

const TA = 'textarea[placeholder="Escribe una respuesta…"]';
async function sendFromComposer(text) {
  await page.locator(TA).click();
  await page.locator(TA).pressSequentially(text, { delay: 5 });
  await page.click('button[aria-label="Enviar"]');
}

try {
  if (scenario === "happy") {
    // 1. Registro de la primera organización
    await page.goto(`${BASE}/register`);
    await page.fill("#name", "Dueña E2E");
    await page.fill("#email", EMAIL);
    await page.fill("#password", PASS);
    await page.click('button[type="submit"]');
    await page.waitForURL(/\/inbox/, { timeout: 30000 });
    check("registro → bandeja", true);

    // Agente interno ENCENDIDO a propósito: en modo Hermes igual no debe responder.
    const prof = await api.put(`${BASE}/api/agent/profile`, { data: { enabled: true } });
    const profData = await (await api.get(`${BASE}/api/agent/profile`)).json();
    check(
      "agente interno encendido y con IA configurada (para probar que no responde)",
      prof.ok() && profData.profile?.enabled === true && profData.aiConfigured === true,
      JSON.stringify({ enabled: profData.profile?.enabled, aiConfigured: profData.aiConfigured })
    );

    // 2. Wizard en modo Kapso
    await page.goto(`${BASE}/settings/whatsapp`);
    await page.getByText("Esta instancia envía por Kapso").waitFor({ timeout: 15000 });
    check("wizard muestra modo Kapso con API key …9876", await page.getByText("(…9876)").count() > 0);
    check("wizard NO pide token en modo Kapso", (await page.locator("#token").count()) === 0);
    check("sin explicación de token de Meta", (await page.getByText("¿De dónde sale el token?").count()) === 0);

    await page.fill("#phone-number-id", "kapso-pn-9");
    await page.getByRole("button", { name: "Probar conexión" }).click();
    await page.getByText("no está en tu cuenta de Kapso").waitFor({ timeout: 15000 });
    check("número ausente en Kapso → error claro", true);
    check("Guardar sigue deshabilitado tras fallo", await page.getByRole("button", { name: "Guardar conexión" }).isDisabled());

    await page.fill("#phone-number-id", "kapso-pn-1");
    await page.getByRole("button", { name: "Probar conexión" }).click();
    await page.getByText("Número encontrado en Kapso: +52 55 1111 0001").waitFor({ timeout: 15000 });
    check("número de la cuenta Kapso → encontrado", true);
    check("WABA autocompletada desde Kapso", (await page.inputValue("#waba-id")) === "kapso-waba-1", await page.inputValue("#waba-id"));
    await page.screenshot({ path: `${SHOTS}/01-wizard-kapso-probado.png`, fullPage: true });

    await page.getByRole("button", { name: "Guardar conexión" }).click();
    await page.getByText("Número conectado: +52 55 1111 0001").waitFor({ timeout: 15000 });
    check("conexión guardada", await page.getByText("vía Kapso · API key …9876").count() > 0);
    await page.getByText("Modo Kapso: por ahora la instancia solo ENVÍA").waitFor();
    check("aviso de webhook en modo Kapso", true);
    await page.screenshot({ path: `${SHOTS}/02-wizard-kapso-conectado.png`, fullPage: true });

    // 3. Entrante simulado (mismo formato Meta que usará el webhook kind=meta)
    await api.delete(`${BASE}/api/dev/wa-mock/outbox`);
    const inbound = await api.post(`${BASE}/api/dev/wa-mock/inbound`, {
      data: { phoneNumberId: "kapso-pn-1", from: "5215512345678", name: "Cliente Kapso", text: "hola, quiero info" },
    });
    check("entrante simulado aceptado", inbound.ok(), `HTTP ${inbound.status()}`);
    await page.waitForTimeout(4000); // > AGENT_COALESCE_MS: el agente interno tendría tiempo de responder
    const afterInbound = await outbox();
    check("agente interno NO respondió (Hermes es el cerebro)", afterInbound.length === 0, `outbox=${afterInbound.length}`);

    // 4. El operador responde desde la bandeja → sale por el proxy de Kapso
    await openConversation("Cliente Kapso", "hola, quiero info");
    await sendFromComposer("Hola, te atiendo por Kapso");
    await page.waitForFunction((sel) => document.querySelector(sel)?.value === "", TA, { timeout: 15000 });
    check("composer se vació tras enviar (envío aceptado)", true);
    await page.getByText("Hola, te atiendo por Kapso").first().waitFor({ timeout: 15000 });
    await page.waitForTimeout(500);
    const ob = await outbox();
    const sent = ob.find((e) => e.body?.text?.body === "Hola, te atiendo por Kapso");
    check("envío llegó al proxy", Boolean(sent), `outbox=${ob.length}`);
    check("auth por X-API-Key (no Bearer)", sent?.auth === "api-key", sent?.auth);
    check("por el número conectado", sent?.phoneNumberId === "kapso-pn-1", sent?.phoneNumberId);
    check("destinatario MX normalizado (521→52)", sent?.to === "525512345678", sent?.to);
    await page.screenshot({ path: `${SHOTS}/03-bandeja-envio-kapso.png`, fullPage: true });
  }

  if (scenario === "invalid-key") {
    await login();
    await page.goto(`${BASE}/settings/whatsapp`);
    await page.fill("#phone-number-id", "kapso-pn-1");
    await page.getByRole("button", { name: "Probar conexión" }).click();
    await page.getByText("Kapso rechazó la API key").waitFor({ timeout: 15000 });
    check("wizard: key inválida → mensaje KAPSO_API_KEY", true);
    await openConversation("Cliente Kapso", "Hola, te atiendo por Kapso");
    await sendFromComposer("mensaje con key inválida");
    await page.getByText("Kapso rechazó la API key").first().waitFor({ timeout: 15000 });
    check("envío: key inválida → error visible, sin colgarse", true);
    const conn = await (await api.get(`${BASE}/api/settings/whatsapp`)).json();
    check("la conexión NO se marca reconnect_required (la key es de .env)", conn.connection?.status === "connected", conn.connection?.status);
    await page.screenshot({ path: `${SHOTS}/04-key-invalida.png`, fullPage: true });
  }

  if (scenario === "kapso-down") {
    await login();
    await page.goto(`${BASE}/settings/whatsapp`);
    await page.fill("#phone-number-id", "kapso-pn-1");
    await page.getByRole("button", { name: "Probar conexión" }).click();
    await page.getByText("Kapso no está disponible").waitFor({ timeout: 20000 });
    check("wizard: Kapso caído → degradado", true);
    await openConversation("Cliente Kapso", "Hola, te atiendo por Kapso");
    await sendFromComposer("mensaje con Kapso caído");
    await page.getByText("Kapso no está disponible").first().waitFor({ timeout: 20000 });
    check("envío: Kapso caído → error visible, sin colgarse", true);
    await page.screenshot({ path: `${SHOTS}/05-kapso-caido.png`, fullPage: true });
  }

  if (scenario === "meta") {
    await login();
    await page.goto(`${BASE}/settings/whatsapp`);
    await page.getByText("La conexión guardada es de Kapso, pero").waitFor({ timeout: 15000 });
    check("meta: aviso de conexión de otro transporte", true);
    check("meta: el wizard vuelve a pedir token", (await page.locator("#token").count()) === 1);
    await openConversation("Cliente Kapso", "Hola, te atiendo por Kapso");
    await sendFromComposer("mensaje con transporte cambiado");
    await page.getByText("es de Kapso pero la instancia usa Meta").first().waitFor({ timeout: 15000 });
    check("meta: envío bloqueado con guía (no usa la conexión Kapso)", true);

    await page.goto(`${BASE}/settings/whatsapp`);
    await page.fill("#waba-id", "WABA-META-1");
    await page.fill("#phone-number-id", "meta-pn-1");
    await page.fill("#token", "EAAG-token-meta-e2e-abcd");
    await page.getByRole("button", { name: "Probar conexión" }).click();
    await page.getByText("Token válido para").waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Guardar conexión" }).click();
    await page.getByText("token …abcd").waitFor({ timeout: 15000 });
    check("meta: reconexión con token (flujo previo intacto)", true);

    // sin DELETE del outbox: reinicia el contador del mock y repetiría wamid ya guardados
    await api.post(`${BASE}/api/dev/wa-mock/inbound`, {
      data: { phoneNumberId: "meta-pn-1", from: "5215512345678", name: "Cliente Kapso", text: "sigo aquí", waMessageId: `wamid.e2e.meta.${Date.now()}` },
    });
    // Control positivo: con meta (motor vocero) el agente interno SÍ responde,
    // así que el "no respondió" del modo Kapso no es vacuo.
    let aiReply = null;
    for (let i = 0; i < 20 && !aiReply; i++) {
      await page.waitForTimeout(1000);
      aiReply = (await outbox()).find((e) => e.phoneNumberId === "meta-pn-1" && e.type === "text");
    }
    check("meta: control positivo — el agente interno respondió", Boolean(aiReply), aiReply ? JSON.stringify(aiReply.body?.text?.body).slice(0, 80) : "sin respuesta");
    await openConversation("Cliente Kapso", "sigo aquí");
    // sin DELETE del outbox: reinicia el contador del mock y repetiría wamid ya guardados
    await sendFromComposer("respuesta por Meta");
    await page.waitForFunction((sel) => document.querySelector(sel)?.value === "", TA, { timeout: 15000 });
    await page.waitForTimeout(1000);
    const ob = await outbox();
    const sent = ob.find((e) => e.body?.text?.body === "respuesta por Meta");
    check("meta: envío con Bearer (regresión)", sent?.auth === "bearer", sent?.auth);
    await page.screenshot({ path: `${SHOTS}/06-meta-regresion.png`, fullPage: true });
  }
} catch (err) {
  check(`escenario ${scenario} sin excepciones`, false, String(err).slice(0, 300));
  await page.screenshot({ path: `${SHOTS}/error-${scenario}.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${scenario}: ${results.length - failed}/${results.length} OK`);
process.exit(failed ? 1 : 0);
