// Self-test E2E F2 (multi-número). Guion: tests/e2e/us-f2-multinumero.md
// Uso: node tests/e2e/f2-multinumero.mjs <kapso2|legacy-null|pre-upgrade|post-upgrade>
// Requiere la app en E2E_BASE_URL (default http://localhost:3100) con los mocks
// y E2E_DATABASE_URL apuntando a la MISMA base (aserciones de datos).
import { tmpdir } from "node:os";
import { mkdirSync } from "node:fs";
import { chromium } from "playwright";
import postgres from "postgres";

const BASE = process.env.E2E_BASE_URL ?? "http://localhost:3100";
const SHOTS = process.env.E2E_SHOTS_DIR ?? `${tmpdir()}/vocero-e2e-f2`;
mkdirSync(SHOTS, { recursive: true });
const sql = postgres(process.env.E2E_DATABASE_URL ?? "postgresql://postgres:pg@127.0.0.1:5439/vocero_e2e", { max: 1 });
const scenario = process.argv[2] ?? "kapso2";
const EMAIL = "duena@e2e.test";
const PASS = "clave-e2e-segura-123";
const PN1 = "kapso-pn-1";
const PN2 = "kapso-pn-2";
const LABEL1 = "Número Kapso de prueba 1";
const LABEL2 = "Número Kapso de prueba 2";
const CO = "573001234567";

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
const TA = 'textarea[placeholder="Escribe una respuesta…"]';
const uid = () => `${Date.now()}${Math.floor(Math.random() * 1e6)}`;

async function register() {
  await page.goto(`${BASE}/register`);
  await page.fill("#name", "Dueña E2E");
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/inbox/, { timeout: 30000 });
}

async function login() {
  await page.goto(`${BASE}/login`);
  await page.fill("#email", EMAIL);
  await page.fill("#password", PASS);
  await page.click('button[type="submit"]');
  await page.waitForURL(/\/inbox/, { timeout: 30000 });
}

async function outbox() {
  return (await (await api.get(`${BASE}/api/dev/wa-mock/outbox`)).json()).outbox;
}

async function inbound(phoneNumberId, from, text, extra = {}) {
  const res = await api.post(`${BASE}/api/dev/wa-mock/inbound`, {
    data: { phoneNumberId, from, text, waMessageId: `wamid.e2e.f2.${uid()}`, ...extra },
  });
  return res;
}

async function waitOutbox(pred, ms = 10000) {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const hit = (await outbox()).find(pred);
    if (hit) return hit;
    await page.waitForTimeout(400);
  }
  return null;
}

async function openConversationById(id, lastText, param = "conversation") {
  await page.goto(`${BASE}/inbox?${param}=${id}`);
  await page.waitForSelector(TA, { timeout: 20000 }).catch(() => {});
  // 30 s: la primera carga de la bandeja en dev compila en frío
  if (lastText) await page.getByText(lastText).nth(1).waitFor({ timeout: 30000 });
  await page.waitForTimeout(800); // hidratación (SSE mantiene la red abierta)
}

async function sendFromComposer(text) {
  await page.locator(TA).click();
  await page.locator(TA).pressSequentially(text, { delay: 5 });
  await page.click('button[aria-label="Enviar"]');
  await page.waitForFunction((sel) => document.querySelector(sel)?.value === "", TA, { timeout: 15000 });
}

/** Reintenta una consulta hasta que cumpla la condición (dev compila rutas en frío). */
async function pollDb(query, ok, ms = 20000) {
  const until = Date.now() + ms;
  let rows = await query();
  while (!ok(rows) && Date.now() < until) {
    await page.waitForTimeout(400);
    rows = await query();
  }
  return rows;
}

async function conversationsByPhone(phone) {
  return sql`
    select c.id, c.phone_number_id, l.id as lead_id, l.conversation_id as lead_conv
    from conversation c join contact ct on ct.id = c.contact_id
    left join lead l on l.conversation_id = c.id
    where ct.phone = ${phone} and c.is_test = false order by c.phone_number_id`;
}

try {
  if (scenario === "kapso2") {
    await register();
    check("registro → bandeja", true);

    // 1. Descubrimiento en Kapso + conexión de 2 números
    await page.goto(`${BASE}/settings/whatsapp`);
    const avail = page.locator('[data-testid="kapso-available"]');
    await avail.waitFor({ timeout: 20000 });
    check("descubrimiento lista los 2 números de la cuenta Kapso",
      (await avail.locator("li").count()) === 2);
    await avail.locator(`li[data-phone-number-id="${PN1}"] button`).click();
    await page.locator(`[data-testid="number-row"][data-phone-number-id="${PN1}"]`).waitFor({ timeout: 15000 });
    await avail.locator(`li[data-phone-number-id="${PN2}"] button`).click();
    await page.locator(`[data-testid="number-row"][data-phone-number-id="${PN2}"]`).waitFor({ timeout: 15000 });
    const rows = page.locator('[data-testid="number-row"]');
    check("2 números conectados en la organización", (await rows.count()) === 2);
    check("el primero quedó como predeterminado",
      (await page.locator(`[data-testid="number-row"][data-phone-number-id="${PN1}"]`).getByText("Predeterminado", { exact: true }).count()) === 1);
    check("descubrimiento marca ambos como 'En esta organización'",
      (await avail.getByText("En esta organización").count()) === 2);

    // Cambiar el predeterminado a PN2 (se usará en el chat nuevo)
    await page.locator(`[data-testid="number-row"][data-phone-number-id="${PN2}"]`).getByRole("button", { name: "Hacer predeterminado" }).click();
    await page.locator(`[data-testid="number-row"][data-phone-number-id="${PN2}"]`).getByText("Predeterminado", { exact: true }).waitFor({ timeout: 10000 });
    const defaults = await pollDb(
      () => sql`select phone_number_id from whatsapp_number where is_default`,
      (rows) => rows.length === 1 && rows[0].phone_number_id === PN2
    );
    check("predeterminado cambiado a PN2 (uno solo por organización)",
      defaults.length === 1 && defaults[0].phone_number_id === PN2, JSON.stringify(defaults));
    await page.screenshot({ path: `${SHOTS}/01-dos-numeros.png`, fullPage: true });

    // 2. Mismo teléfono (Colombia, con formato) escribe a los 2 números
    await api.delete(`${BASE}/api/dev/wa-mock/outbox`).catch(() => {});
    const r1 = await inbound(PN1, "+57 300 123 4567", "hola desde el número 1", { name: "Cliente CO", waUserId: "CO.1234567890" });
    const r2 = await inbound(PN2, CO, "hola desde el número 2", { name: "Cliente CO" });
    check("entrantes aceptados", r1.ok() && r2.ok(), `${r1.status()} ${r2.status()}`);
    await page.waitForTimeout(1500);
    const contacts = await sql`select id, phone, wa_user_id from contact where phone like '57%'`;
    check("un solo contacto por teléfono (formato normalizado)", contacts.length === 1 && contacts[0].phone === CO, JSON.stringify(contacts));
    check("BSUID guardado en el contacto", contacts[0]?.wa_user_id === "CO.1234567890", contacts[0]?.wa_user_id);
    const convs = await conversationsByPhone(CO);
    check("una conversación por número (2)", convs.length === 2 && convs[0].phone_number_id === PN1 && convs[1].phone_number_id === PN2, JSON.stringify(convs.map((c) => c.phone_number_id)));
    check("un lead por conversación (2)", convs.every((c) => c.lead_id && c.lead_conv === c.id));
    const convPn1 = convs.find((c) => c.phone_number_id === PN1).id;
    const convPn2 = convs.find((c) => c.phone_number_id === PN2).id;

    // Un segundo mensaje al número 1 no crea otra conversación ni otro lead
    await inbound(PN1, CO, "otra pregunta al número 1");
    await page.waitForTimeout(1000);
    const convs2 = await conversationsByPhone(CO);
    check("mensaje repetido al mismo número reutiliza conversación y lead", convs2.length === 2);

    // México legado 521 → canónico 52
    await inbound(PN1, "5215512345678", "hola desde México", { name: "Cliente MX" });
    await page.waitForTimeout(1000);
    const mx = await sql`select phone from contact where name = 'Cliente MX'`;
    check("MX 521 se guarda canónico 52", mx[0]?.phone === "525512345678", mx[0]?.phone);

    // 3. Bandeja: filtro y etiqueta de número
    await page.goto(`${BASE}/inbox`);
    const filter = page.locator('select[aria-label="Filtrar por número"]');
    await filter.waitFor({ timeout: 15000 });
    // las conversaciones llegan aparte de los números: esperar las 3 filas
    await page.locator('[data-testid="conversation-number"]').nth(2).waitFor({ timeout: 15000 });
    check("chips de número visibles en la lista", (await page.locator('[data-testid="conversation-number"]').count()) >= 3);
    await filter.selectOption(PN2);
    await page.waitForTimeout(300);
    const chipsPn2 = await page.locator('[data-testid="conversation-number"]').allTextContents();
    check("filtro por número muestra solo las de PN2", chipsPn2.length === 1 && chipsPn2[0].includes(LABEL2), JSON.stringify(chipsPn2));
    await filter.selectOption("all");
    await page.screenshot({ path: `${SHOTS}/02-bandeja-filtro.png`, fullPage: true });

    // 4. El envío usa el número de la conversación
    await openConversationById(convPn1, "otra pregunta al número 1");
    check("cabecera del hilo muestra el número", (await page.locator('[data-testid="thread-number"]').textContent())?.includes(LABEL1));
    await sendFromComposer("respuesta por el número 1");
    const s1 = await waitOutbox((e) => e.body?.text?.body === "respuesta por el número 1");
    check("respuesta en conv. del número 1 sale por PN1 (X-API-Key)", s1?.phoneNumberId === PN1 && s1?.auth === "api-key" && s1?.to === CO, JSON.stringify(s1 && { pn: s1.phoneNumberId, auth: s1.auth, to: s1.to }));
    await openConversationById(convPn2, "hola desde el número 2");
    await sendFromComposer("respuesta por el número 2");
    const s2 = await waitOutbox((e) => e.body?.text?.body === "respuesta por el número 2");
    check("respuesta en conv. del número 2 sale por PN2", s2?.phoneNumberId === PN2, s2?.phoneNumberId);

    // 5. Panel de contacto: etapa del lead de ESTA conversación
    await page.locator('button[aria-label="Mover a Interesado"]').waitFor({ timeout: 15000 });
    const lead2 = (await sql`select id, stage_id from lead where conversation_id = ${convPn2}`)[0];
    const lead1 = (await sql`select id, stage_id from lead where conversation_id = ${convPn1}`)[0];
    const stages = await sql`select id, name from pipeline_stage order by position`;
    const target = stages.find((s) => s.name === "Interesado");
    await page.locator('button[aria-label="Mover a Interesado"]').click();
    const after2 = (
      await pollDb(
        () => sql`select stage_id from lead where id = ${lead2.id}`,
        (rows) => rows[0]?.stage_id === target.id
      )
    )[0];
    const after1 = (await sql`select stage_id from lead where id = ${lead1.id}`)[0];
    check("mover etapa desde la conv. 2 mueve SOLO su lead", after2.stage_id === target.id && after1.stage_id === lead1.stage_id);

    // 6. Pipeline: 2 tarjetas del mismo contacto, cada una con su número
    await page.goto(`${BASE}/pipeline`);
    await page.locator('[data-testid="lead-number"]').first().waitFor({ timeout: 15000 });
    const labels = await page.locator('[data-testid="lead-number"]').allTextContents();
    check("pipeline muestra el número de cada lead",
      labels.some((l) => l.includes(LABEL1)) && labels.some((l) => l.includes(LABEL2)), JSON.stringify(labels));
    await page.screenshot({ path: `${SHOTS}/03-pipeline.png`, fullPage: true });

    // 7. Plantilla aprobada en la WABA de los números
    const created = await api.post(`${BASE}/api/templates`, {
      data: { name: "seguimiento_f2", language: "es_MX", category: "UTILITY", body: "Hola {{1}}, ¿seguimos?" },
    });
    const tplData = await created.json();
    check("plantilla creada en la WABA del predeterminado", created.status() === 201 && tplData.template?.wabaId === "kapso-waba-1", JSON.stringify(tplData.template?.wabaId));
    await api.post(`${BASE}/api/dev/wa-mock/template-status`, {
      data: { wabaId: "kapso-waba-1", name: "seguimiento_f2", language: "es_MX", event: "APPROVED" },
    });
    await page.waitForTimeout(1000);
    const tplStatus = (await sql`select status from template where name = 'seguimiento_f2'`)[0]?.status;
    check("plantilla aprobada por evento de la WABA", tplStatus === "approved", tplStatus);

    // 8. Chat nuevo: predeterminado preseleccionado, solo plantilla
    await page.goto(`${BASE}/inbox`);
    await page.click('button[aria-label="Nueva conversación"]');
    const sel = page.locator("#new-chat-number");
    await sel.waitFor({ timeout: 10000 });
    await page.waitForTimeout(300);
    check("chat nuevo: el número predeterminado viene preseleccionado", (await sel.inputValue()) === PN2, await sel.inputValue());
    check("chat nuevo: aviso de solo plantilla fuera de 24 h", (await page.getByText("solo permite iniciar con una plantilla aprobada").count()) === 1);
    const dlg = page.getByRole("dialog", { name: "Nueva conversación" });
    await dlg.getByText("Cliente CO").first().waitFor({ timeout: 15000 });
    check("chat nuevo: lista los contactos existentes", true);
    await page.screenshot({ path: `${SHOTS}/04-chat-nuevo.png`, fullPage: true });
    await page.getByRole("button", { name: "Teléfono nuevo" }).click();
    await page.fill("#new-chat-phone", "+57 310 000 0000");
    await page.fill("#new-chat-name", "Nuevo CO");
    await page.getByRole("button", { name: "Abrir conversación" }).click();
    await page.getByText("La ventana de 24 horas está cerrada.").waitFor({ timeout: 15000 });
    check("chat nuevo abre en modo solo plantilla (UI)", true);
    check("no hay composer de texto libre", (await page.locator(TA).count()) === 0);
    const newConv = (await sql`select c.id, c.phone_number_id from conversation c join contact ct on ct.id = c.contact_id where ct.phone = '573100000000'`)[0];
    check("conversación nueva por el número elegido (PN2), teléfono normalizado", newConv?.phone_number_id === PN2, JSON.stringify(newConv));
    const forced = await api.post(`${BASE}/api/conversations/${newConv.id}/messages`, { data: { text: "texto libre" } });
    check("servidor rechaza texto libre fuera de 24 h (window_closed)", forced.status() === 409, `HTTP ${forced.status()}`);
    await page.selectOption("#template-select", { label: "seguimiento_f2 (es_MX)" });
    await page.fill("#template-variable", "Nuevo");
    await page.getByRole("button", { name: "Enviar plantilla" }).click();
    const tplSent = await waitOutbox((e) => e.type === "template" && e.to === "573100000000");
    check("plantilla del chat nuevo sale por PN2", tplSent?.phoneNumberId === PN2 && tplSent?.auth === "api-key", JSON.stringify(tplSent && { pn: tplSent.phoneNumberId }));
    await page.screenshot({ path: `${SHOTS}/05-plantilla-chat-nuevo.png`, fullPage: true });

    // 9. Contacto manual con otro formato del mismo teléfono → duplicado
    const dup = await api.post(`${BASE}/api/contacts`, { data: { name: "Duplicado MX", phone: "+52 1 55 1234 5678" } });
    check("alta manual normaliza y detecta el duplicado (521 ↔ 52)", dup.status() === 409, `HTTP ${dup.status()}`);

    // 10. Desactivar un número: deja de recibir y de enviar, sin borrar historial
    const pn1Id = (await sql`select id from whatsapp_number where phone_number_id = ${PN1}`)[0].id;
    await api.patch(`${BASE}/api/settings/whatsapp/numbers/${pn1Id}`, { data: { enabled: false } });
    const before = (await sql`select count(*)::int as n from message`)[0].n;
    await inbound(PN1, CO, "mensaje a número desactivado");
    await page.waitForTimeout(1000);
    const afterMsgs = (await sql`select count(*)::int as n from message`)[0].n;
    check("número desactivado no ingiere entrantes", afterMsgs === before, `${before}→${afterMsgs}`);
    const blocked = await api.post(`${BASE}/api/conversations/${convPn1}/messages`, { data: { text: "no debe salir" } });
    const blockedMsg = (await blocked.json().catch(() => ({})))?.error?.message ?? "";
    check("envío por número desactivado bloqueado con guía", blocked.status() === 409 && /desactivado/.test(blockedMsg), `${blocked.status()} ${blockedMsg}`);
    const kept = (await sql`select count(*)::int as n from message where conversation_id = ${convPn1}`)[0].n;
    check("el historial del número desactivado se conserva", kept >= 3, `mensajes=${kept}`);
    await api.patch(`${BASE}/api/settings/whatsapp/numbers/${pn1Id}`, { data: { enabled: true } });
  }

  if (scenario === "legacy-null") {
    // Demo sembrada ANTES de conectar números → conversaciones sin número.
    await register();
    const seeded = await api.post(`${BASE}/api/seed/demo`);
    check("demo sembrada sin números conectados", seeded.ok(), `HTTP ${seeded.status()}`);
    const demo = (await sql`select c.id, c.phone_number_id, ct.phone from conversation c join contact ct on ct.id = c.contact_id where c.is_test = false order by ct.phone limit 1`)[0];
    check("conversación de demo sin número (legada)", demo && demo.phone_number_id === null, JSON.stringify(demo));
    const conn = await api.put(`${BASE}/api/settings/whatsapp`, { data: { phoneNumberId: PN1, wabaId: "" } });
    check("número conectado después", conn.ok(), `HTTP ${conn.status()}`);
    await inbound(PN1, demo.phone, "escribo al número recién conectado");
    await page.waitForTimeout(1500);
    const convs = await sql`select c.id, c.phone_number_id from conversation c join contact ct on ct.id = c.contact_id where ct.phone = ${demo.phone} and c.is_test = false`;
    check("el primer entrante ADOPTA la conversación legada (sin segundo hilo)",
      convs.length === 1 && convs[0].id === demo.id && convs[0].phone_number_id === PN1, JSON.stringify(convs));
    const leads = await sql`select conversation_id from lead l join contact ct on ct.id = l.contact_id where ct.phone = ${demo.phone}`;
    check("…y su lead sigue siendo uno solo", leads.length === 1 && leads[0].conversation_id === demo.id, JSON.stringify(leads));
  }

  if (scenario === "pre-upgrade") {
    // Contra la versión de MAIN (antes de F2): instancia meta con datos reales.
    await register();
    await page.goto(`${BASE}/settings/whatsapp`);
    await page.fill("#waba-id", "WABA-META-1");
    await page.fill("#phone-number-id", "meta-pn-1");
    await page.fill("#token", "EAAG-token-meta-e2e-abcd");
    await page.getByRole("button", { name: "Probar conexión" }).click();
    await page.getByText("Token válido para").waitFor({ timeout: 15000 });
    await page.getByRole("button", { name: "Guardar conexión" }).click();
    await page.getByText("token …abcd").waitFor({ timeout: 15000 });
    check("main: número meta conectado", true);
    await inbound("meta-pn-1", "5215599990000", "hola antes de la migración", { name: "Cliente Legado" });
    await page.waitForTimeout(1500);
    const legacy = (await sql`select c.id, ct.id as ct, ct.phone from conversation c join contact ct on ct.id = c.contact_id where ct.name = 'Cliente Legado'`)[0];
    check("main: contacto legado guardado como 521", legacy?.phone === "5215599990000", legacy?.phone);
    // main no conoce ?conversation= (es de F2): se abre por contacto.
    await openConversationById(legacy.ct, "hola antes de la migración", "contact");
    await sendFromComposer("respuesta antes de la migración");
    const s = await waitOutbox((e) => e.body?.text?.body === "respuesta antes de la migración");
    check("main: respuesta enviada con Bearer", s?.auth === "bearer", s?.auth);
    const created = await api.post(`${BASE}/api/templates`, {
      data: { name: "legado_meta", language: "es_MX", category: "UTILITY", body: "Hola {{1}}" },
    });
    check("main: plantilla creada", created.status() === 201, `HTTP ${created.status()}`);
  }

  if (scenario === "post-upgrade") {
    // Misma BD tras aplicar 0002, ahora con la app F2 en modo meta.
    await login();
    check("login tras la migración", true);
    const nums = await sql`select phone_number_id, provider, is_default, token_cipher is not null as con_token from whatsapp_number`;
    check("meta_credentials migrada a whatsapp_number (predeterminado, con token)",
      nums.length === 1 && nums[0].phone_number_id === "meta-pn-1" && nums[0].is_default && nums[0].con_token, JSON.stringify(nums));
    const mc = (await sql`select count(*)::int as n from meta_credentials`)[0].n;
    check("meta_credentials se conserva intacta (respaldo)", mc === 1);
    await page.goto(`${BASE}/settings/whatsapp`);
    const row = page.locator('[data-testid="number-row"][data-phone-number-id="meta-pn-1"]');
    await row.waitFor({ timeout: 15000 });
    check("Configuración muestra el número migrado como predeterminado con token …abcd",
      (await row.getByText("Predeterminado", { exact: true }).count()) === 1 && (await row.getByText("token …abcd").count()) === 1);
    const legacy = (await sql`select c.id, c.phone_number_id, ct.phone, ct.id as ct from conversation c join contact ct on ct.id = c.contact_id where ct.name = 'Cliente Legado'`)[0];
    check("conversación existente quedó ligada al número", legacy?.phone_number_id === "meta-pn-1", legacy?.phone_number_id);
    const leadRow = (await sql`select conversation_id from lead where contact_id = ${legacy.ct}`)[0];
    check("lead existente ligado a su conversación", leadRow?.conversation_id === legacy.id);
    const origins = await sql`select origin, count(*)::int as n from message group by origin order by origin`;
    check("mensajes existentes con origin rellenado", origins.every((o) => o.origin), JSON.stringify(origins));
    const tpl = (await sql`select waba_id from template where name = 'legado_meta'`)[0];
    check("plantilla existente ligada a su WABA", tpl?.waba_id === "WABA-META-1", tpl?.waba_id);

    // Agente interno encendido para el control positivo (meta = motor vocero)
    await api.put(`${BASE}/api/agent/profile`, { data: { enabled: true } });

    // Entrante nuevo del contacto legado (llega canónico 52): NO duplica contacto ni conversación
    await inbound("meta-pn-1", "525599990000", "sigo aquí después de la migración");
    await page.waitForTimeout(1500);
    const cts = await sql`select id, phone from contact where name = 'Cliente Legado' or phone in ('525599990000','5215599990000')`;
    check("entrante canónico reutiliza el contacto legado 521 (sin duplicar)", cts.length === 1, JSON.stringify(cts));
    const cvs = await sql`select id from conversation where contact_id = ${legacy.ct} and is_test = false`;
    check("…y la misma conversación", cvs.length === 1 && cvs[0].id === legacy.id);

    // Control positivo del agente interno (meta = motor vocero)
    const aiReply = await waitOutbox((e) => e.phoneNumberId === "meta-pn-1" && e.type === "text" && /sigo aquí/.test(e.body?.text?.body ?? ""), 20000);
    check("meta: el agente interno responde (control positivo)", Boolean(aiReply), aiReply?.body?.text?.body?.slice(0, 60));

    await openConversationById(legacy.id, "sigo aquí después de la migración");
    await sendFromComposer("respuesta después de la migración");
    const s = await waitOutbox((e) => e.body?.text?.body === "respuesta después de la migración");
    check("meta: envío tras migrar sale por el número con Bearer", s?.auth === "bearer" && s?.phoneNumberId === "meta-pn-1" && s?.to === "525599990000", JSON.stringify(s && { auth: s.auth, pn: s.phoneNumberId, to: s.to }));
    await page.screenshot({ path: `${SHOTS}/06-post-upgrade-meta.png`, fullPage: true });
  }
} catch (err) {
  check(`escenario ${scenario} sin excepciones`, false, String(err).slice(0, 400));
  await page.screenshot({ path: `${SHOTS}/error-${scenario}.png`, fullPage: true }).catch(() => {});
} finally {
  await browser.close();
  await sql.end();
}
const failed = results.filter((r) => !r.ok).length;
console.log(`\n${scenario}: ${results.length - failed}/${results.length} OK`);
process.exit(failed ? 1 : 0);
