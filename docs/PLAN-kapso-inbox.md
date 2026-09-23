# Plan: Kapso como transporte de WhatsApp en Vocero

> Estado: **propuesta v2 para revisión**. Solo análisis; no hay código de la app
> cambiado. Esta versión incorpora las decisiones del dueño (§0.1).
> Enmienda de la constitución que la habilita:
> [`docs/ENMIENDA-constitucion-II-kapso.md`](./ENMIENDA-constitucion-II-kapso.md).
>
> Referencias:
> - [`gokapso/whatsapp-cloud-inbox`](https://github.com/gokapso/whatsapp-cloud-inbox),
>   clonado en `/tmp/kapso-inbox-ref`, rama `main` a 2026-09-23.
> - SDK `@kapso/whatsapp-cloud-api` `0.3.0`: README y `dist/` revisados con `npm pack`.

---

## 0. Resumen

- **Kapso es solo transporte.** Los envíos salen por su proxy compatible con
  Graph (`https://api.kapso.ai/meta/whatsapp`, auth `X-API-Key`). Los eventos
  entran a Vocero por webhooks de Kapso y **se guardan en local de forma
  permanente**. La BD de Vocero sigue siendo la fuente de verdad: Vocero nunca
  lee el historial en vivo desde Kapso.
- **El cerebro es Hermes Agent** (plugin de Kapso). En modo Kapso, el agente
  interno de Vocero queda **desactivado** para conversaciones reales. Vocero
  queda como bandeja, contactos, pipeline, notas, handoff (que ahora significa
  **pausar el bot**) y Laboratorio (a futuro conectado a Hermes).
- **Modo dual** con `WHATSAPP_PROVIDER=meta|kapso`. El modo `meta` actual sigue
  funcionando sin cambios.
- Del inbox de Kapso solo se toman **componentes de UI** (multimedia, botones,
  plantillas), conservando su aviso de copyright MIT.
- **Multi-número.** Hay un contacto por teléfono, y una conversación y un lead
  por cada par (`phone_number_id`, teléfono).
- **Instancia nueva y vacía**: no se migra historial.

### 0.1 Decisiones tomadas (dueño, 2026-09-23)

| # | Decisión |
|---|---|
| D1 | Se enmienda el Principio II para admitir a Kapso como proveedor de transporte de WhatsApp, al mismo nivel que Meta. Modo dual con `WHATSAPP_PROVIDER` (`meta` \| `kapso`). |
| D2 | `KAPSO_API_KEY` es una sola por instancia y va en `.env`. |
| D3 | Un contacto por teléfono. Una conversación y un lead por (`phone_number_id` + teléfono). |
| D4 | Sin migración de historial: la instancia Kapso arranca nueva y vacía. |
| D5 | Kapso es solo transporte. La persistencia es local y permanente, y no hay lectura en vivo desde Kapso. |
| D6 | El agente es Hermes (en Kapso). El agente interno de Vocero queda desactivado. |

---

## 1. Qué se toma de Kapso (y qué no)

### 1.1 Qué hace el inbox de Kapso (resumen del análisis v1)

| Tema | Dónde (en `kapso-inbox-ref`) | Cómo |
|---|---|---|
| Cliente | `src/lib/whatsapp-client.ts` | `new WhatsAppClient({ baseUrl: 'https://api.kapso.ai/meta/whatsapp', kapsoApiKey, graphVersion: 'v24.0' })`. El SDK agrega el header `X-API-Key` (`dist/index.js`, `buildHeaders`). |
| Números | `src/lib/inbox-settings.ts` | `GET /platform/v1/whatsapp/phone_numbers?page&per_page=100` con `X-API-Key`. Devuelve `phone_number_id`, `business_account_id` (WABA), `display_phone_number` y `status`. |
| Conversaciones y mensajes | `api/conversations`, `api/messages/[conversationId]` | Lectura en vivo (`conversations.list`, `messages.listByConversation`). **No se adopta** (D5). |
| Texto | `api/messages/send` | `messages.sendText({ phoneNumberId, to, body, contextMessageId? })` |
| Multimedia | `api/messages/send`, `api/media/[mediaId]` | `media.upload` + `sendImage/Video/Audio/Document`; `media.get` + `media.download`. En el proxy, los `GET`/`DELETE` de media exigen `?phoneNumberId=`. |
| Plantillas | `api/templates/*`, `lib/template-parser.ts` | `templates.list({ businessAccountId })`, `buildTemplateSendPayload` (parámetros HEADER, BODY y BUTTON url, nombrados o posicionales) y `messages.sendTemplate`. |
| Botones | `api/messages/interactive` | `messages.sendInteractiveButtons` (1–3 botones, títulos de hasta 20 caracteres). |
| Ventana 24 h | `components/message-view.tsx:145` | Solo en el cliente, calculada desde el último `inbound`. |
| Tiempo real | `hooks/use-auto-polling.ts` | Polling cada 5 s. **No se adopta**: Vocero ya tiene SSE alimentado por webhook. |

Hallazgos del SDK que simplifican el plan:
- El proxy **replica las rutas y el esquema de respuesta de la Graph API**
  ("Responses mirror Meta's Cloud API message schema"). Por eso, para enviar,
  basta con parametrizar el cliente Graph propio de Vocero (base URL + header de
  auth). **No hace falta agregar el SDK como dependencia.**
- `@kapso/whatsapp-cloud-api/server` expone `normalizeWebhook()` y
  `verifySignature()` sobre payloads **con formato de webhook de Meta**
  (`x-hub-signature-256`). Marca los ecos de envíos del negocio con
  `kapso.source = "smb_message_echo"` y la dirección con `kapso.direction`. Si
  Kapso reenvía a Vocero ese formato, la ruta de webhook actual se reutiliza casi
  entera. Está en *pendiente de verificar* (§8).
- Meta está migrando a **BSUID** (business-scoped user IDs, `US.1349…`). Para
  usuarios con *username*, el teléfono puede dejar de llegar. Esto impacta la
  clave teléfono de D3 (ver §7).

### 1.2 Componentes de UI a portar (con aviso de copyright)

| Componente Kapso | Uso en Vocero | Notas de port |
|---|---|---|
| `src/components/media-message.tsx` | Burbuja de imagen, video, audio, documento y sticker en `components/inbox/message-thread.tsx` | La URL de la media apunta al proxy **local y autenticado** de Vocero, no al de Kapso. |
| `src/components/interactive-message-dialog.tsx` | Diálogo "enviar botones" en el composer | Los límites (3 botones, 20 caracteres) también se validan en el servidor con Zod. |
| `src/components/template-selector-dialog.tsx` + `template-parameters-dialog.tsx` | Reemplazan o amplían `components/inbox/template-sender.tsx` | Añaden parámetros de HEADER y de BUTTON url. |
| `src/lib/template-parser.ts` | Helper de UI para extraer parámetros de la plantilla | Es lógica pura, se porta tal cual. |

Adaptación necesaria: Kapso usa **Tailwind v4 + shadcn/Radix**, y Vocero usa
**Tailwind 3.4 con tema oscuro propio y sin Radix**. Los componentes se
re-estilizan con las primitivas y tokens de Vocero (acento `#25D366`), no se
copian los `components/ui/*` de shadcn. Cada archivo portado lleva en la cabecera
`Adaptado de gokapso/whatsapp-cloud-inbox — Copyright (c) 2025 Kapso — MIT`, y se
agrega `THIRD_PARTY_NOTICES.md` con el texto completo de la licencia.

---

## 2. Cómo funciona hoy Vocero (resumen del análisis v1)

- **Salida a Meta**: única frontera en `graphRequest()` (`src/lib/meta/client.ts`),
  con `${META_GRAPH_BASE_URL}/${META_GRAPH_API_VERSION}/${path}` y
  `Authorization: Bearer`. La llaman `inbox/send.ts` (texto),
  `whatsapp/templates.ts` (crear, sincronizar y enviar plantillas) y
  `whatsapp/connect.ts` (probar conexión, `subscribed_apps`).
- **Webhook** `/api/webhooks/wa/[webhookToken]`:
  1. Valida el token de la ruta y la firma `x-hub-signature-256`, si está
     configurada.
  2. Procesa en `after()`: `processMessagesValue`, enrutado por
     `metadata.phone_number_id`.
  3. Ejecuta, en este orden: `applyStatusUpdate` (monotónico) →
     `ingestInboundMessage` (contacto, conversación y `message` con dedup por
     `wa_message_id`) → `onLeadActivity` → SSE → `maybeRunAgentTurn`.
- **Tablas**:
  - `contact` (org, phone) único.
  - `conversation`: una real por contacto; guarda `handoff_*`, `ai_enabled`,
    `last_inbound_at` y `unread_count`.
  - `message` (`wa_message_id` UNIQUE).
  - `meta_credentials`: una por organización, con token cifrado.
  - `template`.
- **Pipeline**: `lead` es único por `contact_id` y se crea en la primera etapa
  `open` con el primer entrante.
- **Multi-número**: **no** soportado (`meta_credentials_org_uq`; `send.ts` usa
  "el número de la organización").

---

## 3. Mapa: archivo de Vocero → qué cambia → pieza de Kapso

| Archivo de Vocero | Qué se reemplaza o adapta | Equivalente o fuente en Kapso |
|---|---|---|
| `src/lib/meta/client.ts` | **Se adapta**: `graphRequest` recibe el "transporte" (`meta`: `graph.facebook.com` + `Bearer <token>`; `kapso`: `KAPSO_WHATSAPP_API_URL` + `X-API-Key`). Traducción de errores idéntica. Sigue siendo el **único** cliente de salida. | Proxy `api.kapso.ai/meta/whatsapp` (lo que hace el SDK en `buildHeaders`) |
| `src/lib/env.ts` | **Se adapta**: se agregan `WHATSAPP_PROVIDER`, `KAPSO_API_KEY`, `KAPSO_WHATSAPP_API_URL`, `KAPSO_API_BASE_URL` y `KAPSO_WEBHOOK_SECRET`, validadas con Zod de forma condicional al proveedor. | README del inbox |
| `src/server/whatsapp/credentials.ts` + `meta_credentials` | **Se adapta** a `whatsapp_number` (varios por organización). En `meta`, cada número guarda su token cifrado. En `kapso` no hay token por número (la key es de instancia, D2). | `inbox-settings.ts` (descubrimiento de números) |
| `src/server/whatsapp/connect.ts` | **Se adapta**: en `kapso`, "probar conexión" consulta `GET /platform/v1/whatsapp/phone_numbers`, y `subscribeAppToWaba` no aplica. En `meta` no cambia. | `fetchKapsoPhoneNumbers` |
| `components/settings/whatsapp-wizard.tsx` + `api/settings/whatsapp/*` | **Se adapta**: en `kapso`, lista los números de la cuenta y el operador marca cuáles atiende la organización y cuál es el predeterminado. Se guarda **en BD**, no en cookie. | `app/settings/page.tsx` (solo como idea de UX) |
| `app/api/webhooks/wa/[webhookToken]/route.ts` + `server/inbox/webhook.ts` | **Se reutiliza o adapta**. Si Kapso reenvía el formato de Meta, es la misma ruta con otro secreto de firma (`KAPSO_WEBHOOK_SECRET`). Si envía eventos propios de Kapso, se crea la ruta `/api/webhooks/kapso/[token]` con un normalizador a `WebhookValue`. | `normalizeWebhook`, `verifySignature` (SDK `/server`) |
| `server/inbox/ingest.ts` | **Se adapta**: la persistencia sigue **permanente**. Además ingiere **salientes ajenos** (respuestas de Hermes y ecos `smb_message_echo`) como `direction='out'` con su `origin`. La conversación y el lead se resuelven por (`phone_number_id`, teléfono). Guarda metadatos de media. **No** llama `maybeRunAgentTurn` en modo Hermes. | — |
| `server/inbox/status.ts` | **Se mantiene** (estados monotónicos desde los `statuses` del webhook de Kapso). | — |
| `server/inbox/send.ts` | **Se adapta**: envía por `conversation.phone_number_id` a través de `graphRequest` con el transporte activo. Conserva la aserción del sandbox y la ventana de 24 h en el servidor. Guarda `origin='operator'`. | `api/messages/send` (forma del payload) |
| `server/inbox/window.ts` | **Se mantiene**: solo aplica a los envíos del operador. Hermes envía por su lado. | `isWithin24HourWindow` (solo UX) |
| `server/inbox/queries.ts` | **Se mantiene** (lectura local), con filtro por número y etiqueta del número en cada conversación. | — |
| `server/whatsapp/templates.ts` | **Se adapta**: por WABA del número (`templates.waba_id`) y payload con HEADER/BODY/BUTTON (lógica de `buildTemplateSendPayload`, reescrita o portada). La creación por el proxy queda por verificar (§8). | `api/templates/*`, `template-parser.ts` |
| `server/ai/trigger.ts` / `server/ai/pipeline.ts` | **Se desactiva para conversaciones reales** cuando `AGENT_ENGINE=hermes` (el valor por defecto con `WHATSAPP_PROVIDER=kapso`): `maybeRunAgentTurn` no hace nada. `moveLeadToStage` pasa a trabajar por conversación. El Laboratorio sigue usando el pipeline en sandbox. | — (el cerebro es Hermes) |
| `server/ai/handoff.ts` + `conversation.handoff_*` / `ai_enabled` | **Se adapta**: handoff significa **pausar Hermes en esa conversación** vía la API de Kapso, y reanudar significa reactivarlo. Si Hermes escala por su cuenta, Vocero lo registra (mecanismo por verificar, §8). | — |
| `components/inbox/*` | **Se adapta** con los componentes portados (§1.2), el filtro y la etiqueta de número, y el toggle "Bot activo / Pausado". | §1.2 |
| `app/(app)/agent/page.tsx` | **Se adapta**: en modo Hermes muestra "El agente se gestiona en Kapso (Hermes)" y oculta la edición del prompt interno. | — |
| *(nuevo)* `app/api/media/[id]/route.ts` | Sirve la media **local**, con sesión y `scoped()`. | `api/media/[mediaId]` (solo como idea) |
| `app/api/dev/wa-mock/*` | **Se amplía**: el mock responde también como proxy Kapso (header `X-API-Key`, `/platform/v1/whatsapp/phone_numbers`) y emite webhooks firmados con el formato de Kapso, detrás del mismo `dev-guard`. | — |
| `server/lab/*` | **Sin cambios** por ahora. Integración con Hermes en fase futura (F7). | — |

---

## 4. Propuesta de arquitectura

```
            ┌──────────── Kapso ─────────────┐
 WhatsApp ⇄ │ proxy Graph  ·  Hermes Agent   │
            └──┬───────────────────▲─────────┘
     webhooks  │ (in, out-eco,     │ envíos del operador,
     (firma)   │  statuses)        │ pausar/reanudar Hermes
               ▼                   │
        ┌─────────── Vocero (VPS) ─┴──────────┐
        │ ingest → Postgres (fuente de verdad)│
        │ bandeja · contactos · pipeline      │
        │ notas · handoff · Laboratorio       │
        └─────────────────────────────────────┘
```

| Kapso (transporte + cerebro) | Vocero (CRM, fuente de verdad) |
|---|---|
| Entrega y recepción en WhatsApp, números y WABA, plantillas en Meta, **Hermes** (responde a los clientes) | Copia **permanente** de todos los mensajes (entrantes, del operador y de Hermes), estados, contactos, conversaciones, leads y pipeline, notas, handoff y pausa del bot, Laboratorio |

Reglas:
1. **Nada se lee en vivo de Kapso** para pintar la bandeja o el historial. Si
   Kapso cae, la bandeja sigue mostrando todo lo recibido. Solo fallan los
   envíos, y degradan con el error `meta_unavailable` existente.
2. **Toda salida pasa por `graphRequest`** (el adaptador único), también las
   llamadas de control de Hermes y las de la API de plataforma.
3. **Sandbox**: una conversación `is_test` jamás llega a Meta **ni a Kapso**. La
   aserción ocurre antes de resolver el transporte.
4. **Un solo agente respondiendo**: en modo Hermes, el agente interno no se
   ejecuta para conversaciones reales, aunque `agent_profile.enabled = true`.
   Así se evitan respuestas dobles. Se cubre con un test unitario.

---

## 5. Modelo de datos (instancia nueva, D4)

| Tabla | Cambio |
|---|---|
| `contact` | Sin cambio de clave: único (`organization_id`, `phone`), con `phone` normalizado a E.164 sin `+`. Se agrega `wa_user_id` (BSUID) nullable como identificador secundario (ver §7). |
| **`whatsapp_number`** (nueva; reemplaza a `meta_credentials`) | `id`, `organization_id`, `provider` (`meta`\|`kapso`), `phone_number_id` UNIQUE global, `waba_id`, `display_phone_number`, `verified_name`, `is_default`, `enabled`, `status`, más `token_cipher/iv/tag` **nullable** (obligatorio solo si `provider='meta'`). Se quita el único por organización. |
| `conversation` | Se agrega `phone_number_id` (NOT NULL para reales; NULL para `is_test`). El único parcial pasa a ser (`organization_id`, `contact_id`, `phone_number_id`) `WHERE is_test = false`. `handoff_at` / `handoff_reason` se interpretan como "bot en pausa" y `ai_enabled` como "Hermes activo en esta conversación". Se agrega `bot_paused_synced_at` para saber si la pausa llegó a Kapso. |
| `lead` | Se agrega `conversation_id` NOT NULL con UNIQUE. Se elimina `lead_contact_uq` y se conserva `contact_id` para los joins. `onLeadActivity(org, conversationId)`. |
| `message` | **Permanente**. Se agregan: `origin` (`contact`\|`operator`\|`hermes`\|`echo`\|`vocero_ai`\|`template`), que reemplaza a `ai_generated`; `media_id`, `media_mime`, `media_filename`, `media_caption`, `media_path` (archivo local) y `context_wa_message_id`. `wa_message_id` sigue siendo UNIQUE: es la dedup de entrantes y de ecos de salientes, incluido el eco de un envío propio que ya existe. |
| `template` | Se agrega `waba_id`. El único pasa a ser (`organization_id`, `waba_id`, `name`, `language`). |
| `meta_credentials` | Se reemplaza por `whatsapp_number`. En una instancia `meta` existente, una migración idempotente copia las filas. La tabla se elimina en F6. |

Todas llevan `organization_id NOT NULL` y se consultan con `scoped()`.

**Media** (Constitución II prohíbe S3): los binarios de media entrantes se
descargan por el proxy (`GET /{media_id}?phoneNumberId=`) al **volumen local**
(`MEDIA_DIR`, volumen Docker) durante la ingesta, en segundo plano y con
reintentos. Se sirven solo por la ruta autenticada. Queda abierta la retención
por tamaño (§9).

---

## 6. Ligar contacto ↔ conversación ↔ lead (D3)

1. **`phone_number_id` → organización**: `whatsapp_number.phone_number_id` es
   único global y el webhook se enruta con él.
2. **Teléfono → contacto**: (`org`, `normalizeWaId(from)`). Un solo normalizador
   para ingesta, búsqueda y envío, con test unitario. Resuelve el caso de México:
   se guarda el `wa_id` tal como llega (`521…`) y al enviar se aplica
   `normalizeRecipient`, que ya existe.
3. **(contacto, `phone_number_id`) → conversación**: upsert sobre el nuevo único
   parcial.
4. **conversación → lead**: `lead.conversation_id` UNIQUE, creado en la primera
   etapa `open` con el primer entrante de ese par. Un mismo teléfono que escribe
   a dos números es **un contacto, dos conversaciones y dos leads**, y cada lead
   muestra la etiqueta de su número en el pipeline.
5. **Salientes de Hermes** (eco por webhook): se ligan con la misma clave. Si
   aún no existe conversación (Hermes inicia), se crea.

---

## 7. Riesgos y licencias

### 7.1 Licencias (confirmado)

| Componente | Licencia | Uso |
|---|---|---|
| Vocero CRM | MIT, © 2026 Kevin Belier | base |
| `gokapso/whatsapp-cloud-inbox` | MIT, © 2025 Kapso | Solo componentes de UI portados, con aviso en la cabecera y en `THIRD_PARTY_NOTICES.md` |
| `@kapso/whatsapp-cloud-api` | MIT (npm `0.3.0`) | **No se instala**. Solo se usó como referencia de la forma del proxy. Si luego se usa `normalizeWebhook`, fijar la versión exacta. |

La API de Kapso y Hermes son un servicio SaaS con términos y precios propios. La
licencia MIT cubre el código, no el uso del servicio.

### 7.2 Riesgos

| Riesgo | Mitigación |
|---|---|
| Kapso guarda su propia copia de los mensajes (el proxy y el inbox la exponen). La promesa de "tus datos en tu VPS" deja de ser exclusiva. | Documentarlo en el deploy y ante el cliente final. En modo `meta` no aplica. Lo recoge la enmienda. |
| Respuesta doble (Hermes + agente interno) | `AGENT_ENGINE=hermes` fuerza el apagado para conversaciones reales, con test unitario y E2E ("entra un mensaje → Vocero no envía nada"). |
| Kapso solo admite una suscripción de webhook por número | Pendiente de verificar (§8). Alternativa: que Vocero reciba y reenvíe a Hermes (relay firmado), o al revés. Cualquiera añade un salto y un punto de fallo. |
| Pausa de Hermes no confirmada (fallo de red) | Se guarda la pausa local de inmediato, `bot_paused_synced_at` NULL significa "pendiente", hay reintentos y la UI muestra el estado real, como hoy hace la bandeja con la IA. |
| BSUID: con el tiempo el teléfono deja de llegar | Guardar `wa_user_id` desde ya. Si llega un evento sin teléfono, buscar por `wa_user_id`. Hay que revisar D3 cuando Meta lo generalice. |
| Formato del webhook de Kapso distinto al de Meta | Normalizador dedicado + fixtures reales + tests unitarios de `ingest`. |
| Ecos duplicados de envíos propios | `wa_message_id` UNIQUE: el eco de un envío que ya se guardó solo actualiza el estado. |
| Disco por media local | `MEDIA_DIR` en volumen, con límite de tamaño por archivo y retención configurable (§9). |
| Port de UI (Tailwind 4 → 3, sin Radix) | Re-estilizar con primitivas propias, sin agregar Radix salvo que haga falta (decisión en F5). |
| El Laboratorio evalúa el agente interno, no Hermes | Mostrar un aviso claro en la UI hasta F7. |
| Webhooks de plantillas (`message_template_status_update`) | Si Kapso no los reenvía, sincronizar bajo demanda (`syncTemplates`, que ya existe). |

---

## 8. Pendiente de verificar (docs o soporte de Kapso)

1. **Varias suscripciones de webhook por número**: ¿admite Kapso más de un
   destino por `phone_number_id` (o por proyecto), para que **Hermes y Vocero
   reciban eventos en paralelo sin relay**? Si no, ¿cuál es el patrón
   recomendado?
2. **Formato y firma del webhook hacia Vocero**: ¿reenvía el payload de Meta
   (`x-hub-signature-256`, que `normalizeWebhook` y `verifySignature` ya cubren)
   o eventos propios (`whatsapp.message.received`, `…sent`, etc., con otro
   header de firma)? ¿Hay reintentos? ¿Hay un id de evento para la dedup?
3. **Salientes de Hermes en el webhook**: ¿llegan los mensajes que envía Hermes
   (o `smb_message_echo`) con un campo que permita marcarlos como
   `origin='hermes'`?
4. **Pausar y reanudar Hermes por conversación** desde una API (¿`conversations.update`?,
   ¿metadata?, ¿endpoint de Hermes?). Y **cómo notifica Hermes un escalado a
   humano** (evento o webhook), para que Vocero registre el handoff.
5. **Plantillas por el proxy**: ¿se admite `POST {waba_id}/message_templates`
   (crear) y el webhook `message_template_status_update`?
6. **Media por el proxy**: subida multipart (`POST {phone_number_id}/media`),
   descarga (`?phoneNumberId=`) y caducidad de las URLs.
7. **Laboratorio ↔ Hermes (futuro)**: ¿expone Hermes un modo de prueba o sandbox
   (invocar un turno sin enviar a WhatsApp) para que el Laboratorio lo evalúe?
8. **Acciones de Hermes sobre el CRM (futuro)**: ¿puede Hermes llamar
   herramientas HTTP (mover de etapa, agregar nota) contra una API de Vocero con
   token?

---

## 9. Plan por fases (cada una desplegable por separado)

> Cada fase exige el gate `pnpm typecheck && pnpm lint && pnpm build && pnpm test`
> y el self-test E2E con mocks (Definición de Hecho reforzada), y actualiza
> `specs/`. Con `WHATSAPP_PROVIDER=meta` (valor por defecto) ninguna fase
> cambia el comportamiento actual.

**F0: decisiones y verificación** (sin código de la app)
- ✅ Decisiones D1–D6.
- Aprobar y aplicar la enmienda del Principio II (1.2.0 → 1.3.0).
- Resolver §8.1–§8.4 con la documentación o el soporte de Kapso. **Bloquean F3
  y F4.**
- Crear `specs/00X-kapso-transporte/` (spec, plan, tasks).

**F1: transporte dual** (salida)
- `graphRequest` parametrizado por transporte, con las variables `KAPSO_*`
  (placeholders `REEMPLAZA_...` en `.env` y guía en `.env.example`).
- El mock responde como proxy de Kapso.
- Envío de texto y plantillas por Kapso.
- E2E: con `WHATSAPP_PROVIDER=kapso`, operador envía → el mock recibe
  `X-API-Key` → `message` queda guardado. El sandbox sigue lanzando excepción.

**F2: multi-número y modelo de datos**
- Migraciones:
  - `whatsapp_number`, con copia idempotente desde `meta_credentials`;
  - `conversation.phone_number_id` y el nuevo único parcial;
  - `lead.conversation_id`;
  - `template.waba_id`;
  - `contact.wa_user_id`;
  - `message.origin` y columnas de media.
- Configuración → WhatsApp: en `kapso`, descubrir los números
  (`/platform/v1/whatsapp/phone_numbers`) y elegir el predeterminado; en `meta`,
  el wizard actual.
- El envío sale por el número de la conversación. La bandeja tiene filtro y
  etiqueta de número.

**F3: ingesta permanente de webhooks de Kapso** (requiere §8.1–§8.3)
- Ruta de webhook (reutilizada o nueva, según §8.2) con firma y
  `KAPSO_WEBHOOK_SECRET`.
- Entrantes, salientes de Hermes y ecos, y estados, con dedup por
  `wa_message_id`. Con cada evento: contacto, conversación, lead y SSE.
- `AGENT_ENGINE=hermes`: el agente interno queda apagado para conversaciones
  reales, y la página de Agente muestra el aviso.
- E2E: entrante firmado → aparece en la bandeja y el pipeline → Vocero no envía
  nada. Llega el eco de Hermes → se muestra como "Hermes". Un webhook repetido
  no tiene efectos.

**F4: handoff = pausa de Hermes** (requiere §8.4)
- Toggle "Bot activo / Pausado" y "Tomar conversación" → API de Kapso, con
  reintentos y estado sincronizado.
- El escalado iniciado por Hermes se registra como `handoff_reason='modelo'` o
  `'cliente'`.
- E2E: pausar → el mock registra la pausa. Fallo de red → la UI muestra
  "pendiente" y no se cuelga.

**F5: UI portada de Kapso**
- Multimedia:
  - recepción con descarga a `MEDIA_DIR` y ruta autenticada;
  - envío con subida por el proxy.
- Botones interactivos.
- Plantillas con parámetros de HEADER, BODY y BUTTON.
- Todos con aviso de copyright y `THIRD_PARTY_NOTICES.md`.

**F6: limpieza** (reducida)
- Eliminar `meta_credentials` (ya reemplazada por `whatsapp_number`) y el uso
  restante de `ai_generated`.
- Actualizar `CLAUDE.md` (mapa del código, variables, regla del sandbox "ni Meta
  ni Kapso"), `.env.example` y los documentos de deploy.
- El proveedor `meta` y su webhook **se mantienen** (modo dual).

**F7: futuro, Hermes ↔ Vocero** (fuera de este alcance)
- Laboratorio contra Hermes (§8.7).
- Herramientas de Hermes sobre el CRM (§8.8), con una API de Vocero con token y
  `scoped()`.

---

## 10. Preguntas abiertas restantes

1. **Media local**: ¿límite de tamaño y retención (p. ej. 90 días o sin
   límite)? ¿Se descarga siempre o solo al abrir la media (bajo demanda)?
2. **Laboratorio hasta F7**: ¿se deja visible con aviso ("evalúa el agente
   interno, no Hermes") o se oculta?
3. **Número predeterminado para chats nuevos** (plantilla a un contacto sin
   conversación): ¿el marcado `is_default` o que el operador elija siempre?
