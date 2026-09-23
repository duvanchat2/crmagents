# Plan: Kapso como transporte de WhatsApp en Vocero

> Estado: **v3 aprobada**. F0 completada (constitución 1.3.0) y F1 completada.
> Incorpora las decisiones del dueño (§0.1) y lo verificado en docs.kapso.ai (§8).
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
| D7 | Multimedia: descarga inmediata al recibir, tope de 20 MB por archivo (lo mayor se registra como no guardado, con sus metadatos), retención de 12 meses configurable y uso del volumen en las alertas. |
| D8 | El Laboratorio queda oculto con `LAB_ENABLED=false` hasta F7. |
| D9 | Chat nuevo: número predeterminado preseleccionado + selector. Fuera de la ventana de 24 h solo se permite plantilla (forzado en la UI). |

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
  entera. **Confirmado**: webhook `kind=meta` (§8.1).
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
| `app/api/webhooks/wa/[webhookToken]/route.ts` + `server/inbox/webhook.ts` | **Se reutiliza** con el webhook `kind=meta` de Kapso (payload crudo de Meta). Se agrega la capa de firma `X-Webhook-Signature` (`KAPSO_WEBHOOK_SECRET`) y la dedup por `X-Idempotency-Key` (`inbound_event`). Solo si los ecos de Hermes no llegan por `kind=meta`, se crea `/api/webhooks/kapso/[token]` para `whatsapp.message.sent`. | Webhooks por número (`POST /platform/v1/whatsapp/phone_numbers/{id}/webhooks`) |
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
| **`inbound_event`** (nueva) | `id`, `organization_id` NOT NULL (resuelta por el `phone_number_id` del payload antes de insertar; si el número es desconocido, el evento se descarta), `idempotency_key` UNIQUE (`X-Idempotency-Key`), `received_at`. Se inserta antes de procesar y se purga a los 30 días. |
| `meta_credentials` | Se reemplaza por `whatsapp_number`. En una instancia `meta` existente, una migración idempotente copia las filas. La tabla se elimina en F6. |

Todas llevan `organization_id NOT NULL` y se consultan con `scoped()`.

**Media** (Constitución II prohíbe S3): los binarios de media entrantes se
descargan por el proxy (`GET /{media_id}?phoneNumberId=`) al **volumen local**
(`MEDIA_DIR`, volumen Docker) durante la ingesta, en segundo plano y con
reintentos. Se sirven solo por la ruta autenticada. Queda abierta la retención
según D7 (20 MB por archivo, 12 meses).

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
| Firma de Kapso sin timestamp: se pueden reenviar eventos | Idempotencia obligatoria por `X-Idempotency-Key` (`inbound_event`) + `wa_message_id` UNIQUE (§8.1). |
| Pausa de Hermes no confirmada (fallo de red) | Se guarda la pausa local de inmediato, `bot_paused_synced_at` NULL significa "pendiente", hay reintentos y la UI muestra el estado real, como hoy hace la bandeja con la IA. |
| BSUID: con el tiempo el teléfono deja de llegar | Guardar `wa_user_id` desde ya. Si llega un evento sin teléfono, buscar por `wa_user_id`. Hay que revisar D3 cuando Meta lo generalice. |
| Formato del webhook de Kapso distinto al de Meta | Normalizador dedicado + fixtures reales + tests unitarios de `ingest`. |
| Ecos duplicados de envíos propios | `wa_message_id` UNIQUE: el eco de un envío que ya se guardó solo actualiza el estado. |
| Disco por media local | `MEDIA_DIR` en volumen, con límite de tamaño por archivo y retención configurable (D7, F5). |
| Port de UI (Tailwind 4 → 3, sin Radix) | Re-estilizar con primitivas propias, sin agregar Radix salvo que haga falta (decisión en F5). |
| El Laboratorio evalúa el agente interno, no Hermes | Mostrar un aviso claro en la UI hasta F7. |
| Webhooks de plantillas (`message_template_status_update`) | Si Kapso no los reenvía, sincronizar bajo demanda (`syncTemplates`, que ya existe). |

---

## 8. Verificación contra docs.kapso.ai

### 8.1 Resuelto (verificado por el dueño, 2026-09-23)

| # | Pregunta | Resultado | Impacto en el plan |
|---|---|---|---|
| P1 | ¿Varias suscripciones de webhook por número? | **Sí.** Se registran por número con `POST /platform/v1/whatsapp/phone_numbers/{id}/webhooks`, y se pueden tener varias. | Hermes conserva su webhook en formato Kapso y Vocero registra **otro** propio. No hace falta relay. |
| P2 | ¿Formato del webhook? | Hay dos tipos: **formato Kapso** (eventos, con buffering) y **`"kind": "meta"`** (payload crudo de Meta + header `X-Idempotency-Key`). | Vocero registra uno `kind=meta` hacia su ruta **actual** `/api/webhooks/wa/[token]`. Se **reutiliza la ingesta existente** (`processMessagesValue`) y F3 se reduce. |
| — | Firma | HMAC-SHA256 del body crudo en `X-Webhook-Signature`, **sin timestamp**, así que no protege contra reenvíos. | Nueva capa de firma con `KAPSO_WEBHOOK_SECRET`, más **idempotencia obligatoria** por `X-Idempotency-Key` en la tabla `inbound_event`, además del `wa_message_id` UNIQUE que ya existe. |
| — | BSUID | Confirmado: `business_scoped_user_id`. | Se mantiene `contact.wa_user_id` en el modelo (§5). |

### 8.2 Parcial

| # | Pregunta | Estado | Plan |
|---|---|---|---|
| P3 | ¿Llegan los salientes de Hermes? | Existe el evento `whatsapp.message.sent` (formato Kapso). **Falta confirmar** si el webhook `kind=meta` trae los ecos de lo que envía Hermes (`smb_message_echoes` o similar). | Primero probarlo con un número real en F3. **Si no llegan**, Vocero registra un **segundo** webhook en formato Kapso solo con `whatsapp.message.sent` hacia `/api/webhooks/kapso/[token]`, con un normalizador mínimo y dedup por `X-Idempotency-Key` y `wa_message_id`. |

### 8.3 Pendiente

4. **Pausar y reanudar Hermes por conversación** desde la API, y cómo notifica
   Hermes un escalado a humano. **Bloquea F4.**
5. **Plantillas por el proxy**: crear (`POST {waba_id}/message_templates`) y el
   webhook `message_template_status_update` en `kind=meta`. Si no están, se
   sincroniza bajo demanda con `syncTemplates`, que ya existe.
6. **Media por el proxy**: subida multipart y descarga (`?phoneNumberId=`). Se
   valida en F5 con el mock y luego con un número real.
7. **Laboratorio ↔ Hermes** (F7): ¿existe un modo de prueba de Hermes?
8. **Herramientas de Hermes sobre el CRM** (F7).

---

## 9. Plan por fases (cada una desplegable por separado)

> Cada fase exige el gate `pnpm typecheck && pnpm lint && pnpm build && pnpm test`
> y el self-test E2E con mocks (Definición de Hecho reforzada), y actualiza
> `specs/`. Con `WHATSAPP_PROVIDER=meta` (valor por defecto) ninguna fase
> cambia el comportamiento actual.

**F0: decisiones y constitución** ✅
- Decisiones D1–D9 (§0.1).
- Enmienda del Principio II **aprobada y aplicada** (constitución 1.3.0,
  propagada a `CLAUDE.md`).
- P1, P2 y la firma resueltos (§8.1).

**F1: transporte dual (salida)** ✅ (rama `feat/f1-transporte-kapso`; guion `tests/e2e/us-f1-kapso-transporte.md`, 29/29)
- `WHATSAPP_PROVIDER=meta|kapso`, `KAPSO_API_KEY`, `KAPSO_WHATSAPP_API_URL`,
  `KAPSO_API_BASE_URL`, validadas con Zod (en modo `kapso` la API key es
  obligatoria).
- `graphRequest` resuelve el transporte:
  - `meta` → `graph.facebook.com` + `Bearer <token>`;
  - `kapso` → proxy + `X-API-Key`.
  Sigue siendo el único punto de salida.
- Conexión en modo `kapso`:
  - el wizard pide WABA ID y Phone Number ID, **sin token**;
  - "probar conexión" valida que el número exista en la cuenta con
    `GET /platform/v1/whatsapp/phone_numbers`;
  - no llama a `subscribed_apps`.
- Migración mínima: `meta_credentials.provider` y columnas del token
  **nullable**. En modo `meta`, una conexión sin token da `not_connected`.
- Errores de auth en `kapso` (API key inválida): mensaje propio, sin marcar
  `reconnect_required`, porque la key vive en `.env`.
- El mock acepta `X-API-Key`, registra el tipo de auth en el outbox y expone
  `/platform/v1/whatsapp/phone_numbers`.
- E2E: con `WHATSAPP_PROVIDER=kapso`:
  - wizard sin token → conectado;
  - entrante simulado → el operador responde → el mock recibe `X-API-Key` y el
    mensaje queda guardado;
  - key `-invalid` → error claro sin colgarse;
  - una conversación `is_test` sigue lanzando excepción.

**F2: multi-número y modelo de datos**
- Migraciones:
  - `whatsapp_number` (reemplaza a `meta_credentials`, con copia idempotente);
  - `conversation.phone_number_id` y el nuevo único parcial;
  - `lead.conversation_id` UNIQUE;
  - `template.waba_id`;
  - `contact.wa_user_id` (BSUID);
  - `message.origin` y columnas de media.
- Configuración → WhatsApp (`kapso`): descubrir los números, marcar cuáles
  atiende la organización y cuál es el predeterminado.
- El envío sale por el número de la conversación. La bandeja tiene filtro y
  etiqueta de número.
- **Chat nuevo** (D9):
  - el número predeterminado viene preseleccionado, con un selector para
    cambiarlo;
  - fuera de la ventana de 24 h, o sin entrantes, **solo plantilla**. Lo fuerza
    la UI y también el servidor (`window_closed`).

**F3: ingesta de Kapso por el webhook actual** (reducida gracias a P1 y P2)
- En Kapso se registra un webhook `kind=meta` por número hacia
  `/api/webhooks/wa/[token]`. Puede hacerse desde Configuración, con
  `POST /platform/v1/whatsapp/phone_numbers/{id}/webhooks`, o a mano.
- En la ruta actual:
  - capa de firma `X-Webhook-Signature` (HMAC-SHA256, `KAPSO_WEBHOOK_SECRET`)
    en modo `kapso`;
  - tabla `inbound_event` (`idempotency_key` UNIQUE, `received_at`, purgable),
    que se inserta **antes** de procesar: si la key ya existe, se responde 200
    sin efectos.
- `processMessagesValue` sin cambios de fondo. Solo se agregan la resolución
  por (`phone_number_id`, teléfono) de F2 y el guardado de
  `business_scoped_user_id`.
- `AGENT_ENGINE=hermes` (valor por defecto con `kapso`): el agente interno no
  se ejecuta en conversaciones reales. `LAB_ENABLED=false`: el Laboratorio se
  oculta de la navegación y su API responde 404 (D8).
- **Carrera eco ↔ envío propio**: el eco de un mensaje que envió Vocero puede
  llegar **antes** de que se guarde la fila saliente. El insert del envío debe
  ser idempotente por `wa_message_id` (`ON CONFLICT` → completar la fila del
  eco), no un 500. El riesgo apareció en el self-test de F1 con ids repetidos
  del mock.
- Ecos de Hermes (P3): confirmar con un número real. Si no llegan, agregar el
  segundo webhook `whatsapp.message.sent` (§8.2).
- E2E:
  - entrante `kind=meta` firmado → aparece en la bandeja y el pipeline, y
    Vocero **no** responde;
  - el mismo `X-Idempotency-Key` repetido no tiene efectos;
  - firma inválida → 401;
  - eco de Hermes → se muestra como "Hermes".

**F4: handoff = pausa de Hermes** (requiere P4)
- Toggle "Bot activo / Pausado" y "Tomar conversación" → API de Kapso, con
  reintentos y estado sincronizado (`bot_paused_synced_at`).
- Escalado de Hermes → `handoff_reason`.

**F5: UI portada de Kapso + multimedia**
- Componentes de multimedia, botones y plantillas (HEADER, BODY, BUTTON), con
  aviso de copyright y `THIRD_PARTY_NOTICES.md`.
- Media entrante (D7):
  - descarga **inmediata** al recibir, en segundo plano con reintentos, a
    `MEDIA_DIR` (volumen local);
  - tope de **20 MB por archivo** (`MEDIA_MAX_BYTES`); lo que lo supera se
    registra con sus metadatos y `media_status='too_large'`, sin binario;
  - retención de **12 meses** configurable (`MEDIA_RETENTION_DAYS=365`), con
    purga diaria in-process;
  - **uso del volumen** reportado en `/api/health` y en las alertas del deploy.
- Media saliente: subida por el proxy.

**F6: limpieza** (reducida)
- Eliminar `meta_credentials` (ya reemplazada) y `ai_generated`.
- Actualizar `CLAUDE.md` (mapa del código y variables), `.env.example` y los
  documentos de deploy.
- El proveedor `meta` se mantiene (modo dual).

**F7: futuro, Hermes ↔ Vocero** (fuera de este alcance)
- Laboratorio contra Hermes (se reactiva `LAB_ENABLED`).
- Herramientas de Hermes sobre el CRM.
