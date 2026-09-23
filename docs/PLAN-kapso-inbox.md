# Plan: reemplazar la capa de WhatsApp de Vocero por Kapso

> Estado: **propuesta para revisión** (solo análisis, no hay código cambiado).
> Referencia: [`gokapso/whatsapp-cloud-inbox`](https://github.com/gokapso/whatsapp-cloud-inbox)
> (clonado en `/tmp/kapso-inbox-ref`, commit de `main` a 2026-09-23) y el SDK
> `@kapso/whatsapp-cloud-api` (el repo pide `^0.1.0`; en npm la última es `0.3.0`).

---

## 0. Resumen

- Hoy Vocero habla **directo con la Graph API de Meta** (`src/lib/meta/client.ts`),
  recibe el webhook de Meta en `/api/webhooks/wa/[webhookToken]` y **guarda
  todos los mensajes en su propia tabla `message`**. Solo admite **un número por
  organización** (`meta_credentials_org_uq`).
- El inbox de Kapso **no guarda nada**: lee conversaciones y mensajes desde la
  API de Kapso en cada petición (polling cada 5 s), envía por el mismo SDK y
  descubre los números de la cuenta de Kapso con `KAPSO_API_KEY`. No tiene auth,
  base de datos ni webhooks.
- Propuesta: **Kapso pasa a ser la fuente de verdad de los mensajes; Vocero se
  queda con el CRM** (contactos, pipeline, notas, handoff, agente IA, Laboratorio).
  La migración va en 6 fases. Cada una se despliega por separado y se puede revertir.
- **Bloqueo de producto**: la Constitución II de Vocero (soberanía) tiene una
  lista cerrada de dependencias externas en runtime, y Kapso no está en ella.
  Antes de la Fase 1 hay que enmendar la constitución (ver §7.2).

---

## 1. Qué hace el inbox de Kapso (referencia)

| Tema | Dónde | Cómo |
|---|---|---|
| **Cliente de la API** | `src/lib/whatsapp-client.ts` | `new WhatsAppClient({ baseUrl: WHATSAPP_API_URL ?? 'https://api.kapso.ai/meta/whatsapp', kapsoApiKey: KAPSO_API_KEY, graphVersion: 'v24.0' })`. Es un singleton perezoso. El SDK es un **proxy compatible con Graph**: las mismas rutas de Meta, con autenticación por API key de Kapso en vez del token de Meta. |
| **API de plataforma** (fuera del SDK) | `src/lib/inbox-settings.ts` | `fetch(${KAPSO_API_BASE_URL}/platform/v1/whatsapp/phone_numbers?page=&per_page=100)` con header `X-API-Key`, paginado por `meta.total_pages` y con caché en memoria de 60 s. |
| **Listar conversaciones** | `src/app/api/conversations/route.ts` | `whatsappClient.conversations.list({ phoneNumberId, status?, limit, fields: buildKapsoFields(['contact_name','messages_count','last_message_type','last_message_text','last_inbound_at','last_outbound_at']) })`. Se llama **una vez por cada número seleccionado** (`Promise.allSettled`) y los resultados se juntan. Si falla un número, se devuelve `partialErrors` en vez de romper toda la respuesta. |
| **Listar mensajes** | `src/app/api/messages/[conversationId]/route.ts` | `whatsappClient.messages.listByConversation({ phoneNumberId, conversationId, limit, fields: buildKapsoFields(['direction','status','processing_status','has_media','media_data','media_url','content','message_type_data','flow_*','order_text',…]) })`. Luego normaliza cada `MetaMessage` + `kapso` a un DTO propio (dirección, estado, media, reacciones, respuesta citada, transcripción de audio). |
| **Enviar texto** | `src/app/api/messages/send/route.ts` | `messages.sendText({ phoneNumberId, to, body, contextMessageId? })`. |
| **Enviar multimedia** | mismo archivo | Primero `media.upload({ phoneNumberId, type, file, fileName })` y luego `sendImage` / `sendVideo` / `sendAudio` / `sendDocument` con `{ id, caption }`. El tipo sale del MIME del archivo (`application/*` → document). |
| **Descargar media** | `src/app/api/media/[mediaId]/route.ts` | `media.get` (para el mimeType) y `media.download({ auth: 'never' })`, servido como proxy con `Cache-Control: max-age=86400`. |
| **Plantillas** | `src/app/api/templates/route.ts`, `…/templates/send/route.ts`, `src/lib/template-parser.ts` | `templates.list({ businessAccountId: WABA, limit: 100 })`. El envío arma los parámetros de HEADER, BODY y BUTTON(url), sean nombrados o posicionales, con `buildTemplateSendPayload(...)`, y luego llama a `messages.sendTemplate({ phoneNumberId, to, template })`. |
| **Botones interactivos** | `src/app/api/messages/interactive/route.ts` | `messages.sendInteractiveButtons({ phoneNumberId, to, bodyText, header?, buttons[≤3] })`, con títulos truncados a 20 caracteres. |
| **Ventana de 24 h** | `src/components/message-view.tsx:145` | **Solo en el cliente**: toma el último mensaje `inbound`. Si pasaron menos de 24 h, el composer queda libre. Si no, o si no hay entrantes, solo se permiten plantillas. El servidor no valida nada: si alguien fuerza el envío, Meta lo rechaza. |
| **Varios números** | `src/lib/inbox-settings.ts`, `src/app/api/settings/route.ts`, `src/app/settings/page.tsx` | Descubre todos los `phone_number_id` y su `business_account_id` (WABA) desde la API de plataforma. La selección (`selectedPhoneNumberIds` + `defaultPhoneNumberId`) se guarda en una **cookie HTTP-only**. `resolvePhoneNumberContext(id?)` valida que el número esté seleccionado. `PHONE_NUMBER_ID` / `WABA_ID` en env quedan solo como respaldo de un número. |
| **Tiempo real** | `src/hooks/use-auto-polling.ts` | Polling cada 5 s que se pausa si la pestaña está oculta. Sin webhooks ni SSE. |

Lo que el inbox de Kapso **no** tiene y Vocero sí necesita: auth y
multi-tenant, recepción de eventos en el servidor (para disparar el agente IA y
crear el lead), validación de la ventana de 24 h en el servidor, idempotencia y
el sandbox del Laboratorio.

---

## 2. Cómo funciona hoy Vocero

### 2.1 Llamadas a `graph.facebook.com`

La única salida hacia Meta es `graphRequest()` en `src/lib/meta/client.ts`
(`${META_GRAPH_BASE_URL}/${META_GRAPH_API_VERSION}/${path}`, con
`Authorization: Bearer <token>`). El base URL por defecto está en
`src/lib/env.ts:24`. La usan:

| Llamador | Endpoint Graph | Uso |
|---|---|---|
| `src/server/inbox/send.ts` → `callGraphSend` | `POST {phone_number_id}/messages` | Texto libre (humano y agente IA) |
| `src/server/whatsapp/templates.ts` → `sendTemplate` | `POST {phone_number_id}/messages` (type template) | Enviar plantilla |
| `src/server/whatsapp/templates.ts` → `createTemplate` | `POST {waba_id}/message_templates` | Crear plantilla |
| `src/server/whatsapp/templates.ts` → `syncTemplates` | `GET {waba_id}/message_templates` | Sincronizar estado |
| `src/server/whatsapp/connect.ts` → `testConnection` | `GET {phone_number_id}?fields=display_phone_number,verified_name` | Wizard de conexión |
| `src/server/whatsapp/connect.ts` → `subscribeAppToWaba` | `POST {waba_id}/subscribed_apps` | Suscribir webhook |

`normalizeRecipient()` quita el `1` de los móviles de México (`521…` → `52…`)
al enviar.

### 2.2 Ingesta del webhook `/api/webhooks/wa/[webhookToken]`

1. `route.ts`: capa 1 = el segmento de la URL es `META_WEBHOOK_VERIFY_TOKEN`
   (si no coincide, 404). Capa 2 = firma `x-hub-signature-256`, solo si existe
   `META_APP_SECRET`. Responde 200 de inmediato y procesa en `after()`.
2. `field=messages` → `processMessagesValue()` (`src/server/inbox/ingest.ts`):
   - enruta a la organización por `metadata.phone_number_id` con
     `getCredentialsByPhoneNumberId`;
   - `statuses[]` → `applyStatusUpdate()` (`status.ts`, estados monotónicos);
   - `messages[]` → `ingestInboundMessage()`: `getOrCreateContact(org, from)` →
     `getOrCreateConversation(org, contactId)` → `INSERT message … ON CONFLICT
     (wa_message_id) DO NOTHING` (idempotencia) → actualiza `lastInboundAt`,
     `lastMessageAt` y `unreadCount` → `onLeadActivity()` → SSE
     `message.new` y `conversation.updated` → `maybeRunAgentTurn()`.
3. `field=message_template_status_update` → `processTemplateStatusValue()`.

Hoy solo guarda `text.body`. Los demás tipos soportados (image, audio…) se
guardan sin contenido ni media.

### 2.3 Tablas de conversaciones y mensajes (`src/lib/db/schema.ts`)

- `conversation`: `organization_id`, `contact_id`, `is_test`, `ai_enabled`,
  `handoff_at`, `handoff_reason`, `last_inbound_at`, `last_message_at`,
  `unread_count`. Índice único parcial `(org, contact) WHERE is_test = false`,
  es decir, **una conversación real por contacto**.
- `message`: `conversation_id`, `wa_message_id` UNIQUE, `direction`, `type`,
  `text`, `status`, `error`, `ai_generated`, `wa_timestamp`.
- `meta_credentials`: `waba_id`, `phone_number_id` (único global), token cifrado
  AES-GCM, `status`. Índice **único por organización**.
- `template`: copia local de las plantillas (`wa_template_id`, `status`).

Leen o escriben `message`: `inbox/ingest.ts`, `inbox/send.ts`, `inbox/status.ts`,
`inbox/queries.ts`, `ai/pipeline.ts` (historial de 20 mensajes + registro de
salientes), `lab/runner.ts`, `seed/demo.ts`, `whatsapp/templates.ts` y
`api/dev/wa-mock/status`.

### 2.4 Cómo se liga un contacto al pipeline

`contact` es único por `(organization_id, phone)`, donde `phone` es el `wa_id`
que manda Meta. `lead` es único por `contact_id` y apunta a una `pipeline_stage`.
Con el **primer mensaje entrante**, `onLeadActivity()` crea el lead en la primera
etapa `open`. Con los siguientes solo actualiza `last_activity_at`. El agente IA
mueve de etapa (`moveLeadToStage`) y agrega notas en `contact.notes`. El handoff
vive en `conversation.handoff_*`.

### 2.5 ¿Una organización soporta varios números?

**No.** `meta_credentials_org_uq` impone una fila por organización.
`getCredentialsByOrg()` devuelve un solo número, `send.ts` y `templates.ts`
envían siempre por ese, `conversation` no tiene columna de número y el wizard de
Configuración → WhatsApp maneja un solo número. Lo único que ya está preparado
es el enrutamiento del webhook por `phone_number_id` (índice único global).

---

## 3. Mapa: archivo de Vocero → qué se hace → pieza de Kapso

| Archivo de Vocero | Qué se reemplaza o adapta | Pieza equivalente en Kapso |
|---|---|---|
| `src/lib/meta/client.ts` (`graphRequest`, `MetaApiError`) | **Se reemplaza** por un adaptador `src/lib/kapso/client.ts` que envuelve `WhatsAppClient`. Se conserva la traducción de errores (auth → `reconnect_required`, 5xx → `meta_unavailable`). `normalizeRecipient` se queda. | `src/lib/whatsapp-client.ts` + `@kapso/whatsapp-cloud-api` |
| `src/lib/env.ts` (`META_GRAPH_BASE_URL`, `META_GRAPH_API_VERSION`) | **Se adapta**: `KAPSO_API_KEY`, `KAPSO_WHATSAPP_API_URL` (por defecto `https://api.kapso.ai/meta/whatsapp`), `KAPSO_API_BASE_URL`, `KAPSO_WEBHOOK_SECRET`. | variables de `README.md` |
| `src/server/whatsapp/credentials.ts` + tabla `meta_credentials` | **Se reemplaza** por `whatsapp_number` (varios por organización) sin token de Meta. La API key de Kapso va en env o cifrada por organización. | `src/lib/inbox-settings.ts` (`fetchKapsoPhoneNumbers`, `resolvePhoneNumberContext`) |
| `src/server/whatsapp/connect.ts` (`testConnection`, `subscribeAppToWaba`) | **Se elimina o adapta**: los números se conectan en app.kapso.ai. "Probar conexión" pasa a ser listar números. `subscribed_apps` ya no aplica. | `GET /platform/v1/whatsapp/phone_numbers` |
| `src/components/settings/whatsapp-wizard.tsx` + `api/settings/whatsapp/*` | **Se adapta** a un selector de números con número por defecto, guardado **en BD por organización** (no en cookie). | `src/app/settings/page.tsx`, `api/settings`, `api/phone-numbers` |
| `src/app/api/webhooks/wa/[webhookToken]/route.ts` + `src/server/inbox/webhook.ts` | **Se reemplaza** por `/api/webhooks/kapso/[token]` con verificación de firma HMAC de Kapso. En el repo de referencia **no hay equivalente** (hace polling). | Webhooks de plataforma de Kapso *(no están en el repo de referencia: validar en la doc de Kapso los nombres de evento, p. ej. `whatsapp.message.received`, y el header de firma)* |
| `src/server/inbox/ingest.ts` | **Se adapta**: deja de insertar el cuerpo en `message`. Conserva `getOrCreateContact`, `getOrCreateConversation`, `onLeadActivity`, SSE y `maybeRunAgentTurn`. La idempotencia pasa a una tabla de dedup de eventos. | — (lógica propia de CRM) |
| `src/server/inbox/status.ts` | **Se elimina** para conversaciones reales: el estado viene en `kapso.status` de cada mensaje. | campo `status` en `messages.listByConversation` |
| `src/server/inbox/send.ts` (`sendText`, `callGraphSend`) | **Se adapta**: `messages.sendText` con `phoneNumberId` = número de la conversación. **Mantener** la aserción del sandbox (`is_test` → excepción) y la validación de 24 h en el servidor. | `api/messages/send/route.ts` |
| *(no existe)* envío de multimedia | **Nuevo**: `media.upload` + `sendImage/Video/Audio/Document`. | `api/messages/send/route.ts` |
| *(no existe)* ver media | **Nuevo**: proxy autenticado y con scope de organización. | `api/media/[mediaId]/route.ts` |
| *(no existe)* botones | **Nuevo** (opcional): `sendInteractiveButtons`. También sirve como acción del agente IA en `ai/actions.ts`. | `api/messages/interactive/route.ts`, `interactive-message-dialog.tsx` |
| `src/server/inbox/window.ts` | **Se mantiene** (validación en el servidor). `last_inbound_at` se alimenta del webhook de Kapso o del campo `last_inbound_at` de la conversación de Kapso. | `isWithin24HourWindow` (solo cliente), para la UX |
| `src/server/inbox/queries.ts` (`listConversations`, `listMessages`) | **Se adapta**: la lista combina CRM local (contacto, etapa, handoff, `ai_enabled`, no leídos) con la vista previa y la última actividad de Kapso. `listMessages` lee de Kapso. | `api/conversations/route.ts`, `api/messages/[conversationId]/route.ts` (con sus normalizadores) |
| `src/server/whatsapp/templates.ts` (`syncTemplates`, `sendTemplate`, `createTemplate`) | **Se adapta**: `templates.list({ businessAccountId })` por WABA; el envío con `buildTemplateSendPayload` + `messages.sendTemplate`. La creación queda en el panel de Kapso o de Meta, o por el SDK si lo expone (a verificar). | `api/templates/*`, `lib/template-parser.ts`, `template-*-dialog.tsx` |
| `src/server/whatsapp/template-events.ts` | **Se adapta** a eventos de Kapso (si existen) o se reemplaza por sincronizar al abrir la pantalla. | — |
| `src/server/ai/pipeline.ts` | **Se adapta**: el historial de conversaciones reales viene de `messages.listByConversation`, que devuelve lo más reciente primero, así que se invierte. Los salientes van por `sendText`. El Laboratorio (`is_test`) sigue leyendo la BD local. | `messages.listByConversation` |
| `src/server/lab/runner.ts` | **Sin cambios** (sigue usando la tabla `message` local). | — |
| `src/components/inbox/*` (`message-thread`, `composer`, `template-sender`, `conversation-list`) | **Se adapta**: burbujas de media, estado, respuesta citada, reacciones, filtro por número, selector de número al iniciar chat. Se puede portar UI de Kapso (MIT). | `message-view.tsx`, `media-message.tsx`, `conversation-list.tsx` |
| `src/components/use-events.ts` + `/api/events` (SSE) | **Se mantiene**. El evento lo dispara ahora el webhook de Kapso. Como respaldo, el refetch con `since=` o un poll. | `hooks/use-auto-polling.ts` (respaldo) |
| `src/app/api/dev/wa-mock/*`, `src/server/dev/wa-mock-*.ts` | **Se adapta** a un `kapso-mock` (mismo gate `dev-guard`) que imite las rutas `/meta/whatsapp/v24.0/...`, `/platform/v1/whatsapp/phone_numbers` y el webhook firmado, para que el self-test E2E siga sin red. | — |
| `src/server/seed/demo.ts` | **Se adapta**: la demo sigue en la BD local (conversaciones marcadas como demo o `is_test`). | — |

---

## 4. Propuesta: Kapso guarda los mensajes, Vocero es solo CRM

### 4.1 Reparto de responsabilidades

| Kapso (fuente de verdad) | Vocero (CRM) |
|---|---|
| Mensajes (texto, media, plantillas, interactivos), estados de entrega, media, conversaciones de WhatsApp, números y WABA, plantillas | Organizaciones y usuarios, contactos, leads y pipeline, notas, handoff, `ai_enabled`, no leídos, agente IA, KB, Laboratorio, marca |

### 4.2 Cambios en tablas

| Tabla | Qué pasa |
|---|---|
| `message` | **Se queda solo para el Laboratorio y la demo** (`is_test`). Las conversaciones reales ya no guardan cuerpo. Se puede renombrar a `lab_message` en una fase posterior. Los mensajes reales históricos se conservan en solo lectura o se exportan (Kapso **no** tiene el historial previo a la migración). |
| `meta_credentials` | **Sobra**. Se reemplaza por `whatsapp_number` (ver §5) y se elimina tras la fase de corte. |
| `conversation` | **Cambia**: se agregan `phone_number_id` (FK lógica a `whatsapp_number`) y `kapso_conversation_id`. Se sustituye el único parcial por `(org, contact, phone_number_id) WHERE is_test = false`. Se conservan `ai_enabled`, `handoff_*`, `last_inbound_at` (cache para la validación de 24 h en el servidor y para el agente), `last_message_at` y `unread_count`. |
| `contact` | Sin cambios de esquema. `phone` se normaliza a E.164 sin `+` (igual que `wa_id`). |
| `lead`, `pipeline_stage`, `agent_profile`, `kb_entry`, `agent_test_*` | Sin cambios. |
| `template` | **Pasa a ser caché opcional** (o se elimina) porque la lista viene de Kapso por WABA. Si se conserva, se agrega `waba_id`. |
| **Nueva** `whatsapp_number` | `id`, `organization_id`, `phone_number_id` (UNIQUE global), `waba_id`, `display_phone_number`, `verified_name`, `is_default`, `enabled`, timestamps. |
| **Nueva** `inbound_event` | `organization_id`, `wa_message_id` UNIQUE, `received_at`. Sirve para deduplicar webhooks de Kapso (Constitución IV) sin guardar cuerpos. Purgable a los 30 días. |

Todas las tablas nuevas llevan `organization_id NOT NULL` y se consultan con
`scoped()` (Constitución III).

---

## 5. Ligar contacto de Vocero ↔ conversación de Kapso

**Clave natural**: `(organization_id, phone_number_id, contact.phone)`.

1. **Número → organización**: `whatsapp_number.phone_number_id` (único global)
   resuelve la organización, igual que hoy lo hace `getCredentialsByPhoneNumberId`.
2. **Teléfono → contacto**: `contact (organization_id, phone)`, con `phone` =
   `wa_id` normalizado (solo dígitos, E.164 sin `+`). La conversación de Kapso
   trae `phoneNumber`, que se normaliza igual. **Ojo México**: Meta entrega `521…`
   y Kapso podría entregar `52…`. Hay que usar un solo normalizador
   (`normalizeWaId`) para ingesta, búsqueda y envío, y cubrirlo con un test.
3. **Conversación**: `conversation (org, contact_id, phone_number_id)` guarda
   `kapso_conversation_id` como caché. Se resuelve así:
   - con el webhook entrante, el evento trae el id de la conversación de Kapso y
     se hace upsert;
   - al abrir un contacto sin `kapso_conversation_id`,
     `conversations.list({ phoneNumberId })` filtrando por teléfono (verificar si
     el SDK admite filtro por `phone_number`; si no, se pagina);
   - Kapso puede cerrar una conversación y abrir otra (`status: active|ended`).
     El `kapso_conversation_id` se actualiza y el historial se lee de todas las
     conversaciones de ese teléfono con ese número (o por
     `whatsapp_conversation_id`).
4. **Pipeline**: no cambia. Se sigue ligando por `contact_id`, así que **un
   contacto que escribe a dos números de la misma organización es un solo lead**
   con dos conversaciones. Es una decisión de producto; la alternativa sería un
   lead por número.

---

## 6. Soporte multi-número: qué hay que cambiar

1. **Esquema**: eliminar `meta_credentials_org_uq`, crear `whatsapp_number`,
   agregar `conversation.phone_number_id` y cambiar el único parcial (§4.2).
2. **Descubrimiento**: `GET /platform/v1/whatsapp/phone_numbers` (paginado),
   como `fetchKapsoPhoneNumbers`. El operador elige en Configuración qué números
   atiende la organización y cuál es el por defecto. La selección va **en BD**,
   no en cookie como en Kapso. Si una instancia sirve a varias organizaciones con
   una sola API key, hay que impedir que dos organizaciones reclamen el mismo
   `phone_number_id` (lo garantiza el UNIQUE global).
3. **Envío**: `sendText`, `sendTemplate` y media usan `conversation.phone_number_id`,
   nunca "el número de la organización". Para chats nuevos (plantilla a un
   contacto sin conversación) se usa el número por defecto o uno elegido en la UI.
4. **Plantillas**: son por WABA. `templates.list({ businessAccountId: number.waba_id })`.
   La UI filtra por el WABA del número de la conversación.
5. **Bandeja**: filtro por número y una etiqueta del número en cada conversación
   (`inboxDisplayName` en Kapso). La lista de conversaciones sale de la BD local
   (rápida y con datos de CRM) y se completa con Kapso, sin llamar a Kapso N veces
   por cada carga.
6. **Agente IA**: se configura por organización (sin cambios). Opcionalmente se
   puede apagar por número (`whatsapp_number.ai_enabled`) en una fase futura.
7. **Webhook**: se enruta por `phone_number_id` del evento → `whatsapp_number`
   → organización.

---

## 7. Riesgos y licencias

### 7.1 Licencias (confirmado)

| Componente | Licencia | Fuente |
|---|---|---|
| Vocero CRM (este repo) | **MIT**, © 2026 Kevin Belier | `LICENSE` |
| `gokapso/whatsapp-cloud-inbox` | **MIT**, © 2025 Kapso | `LICENSE` del repo clonado |
| `@kapso/whatsapp-cloud-api` (SDK) | **MIT** (`npm view` → `license = 'MIT'`, repo `gokapso/whatsapp-cloud-api-js`) | registro npm |

Son compatibles. Si se copia código o UI del inbox de Kapso hay que conservar su
aviso de copyright, por ejemplo en `THIRD_PARTY_NOTICES.md` o en la cabecera de
los archivos portados. **El servicio Kapso (api.kapso.ai) es un SaaS con sus
propios términos y precios**: la licencia MIT cubre el código, no el uso de la
API.

### 7.2 Riesgos

| Riesgo | Impacto | Mitigación |
|---|---|---|
| **Constitución II (soberanía)**: Kapso es un servicio externo que no está en la lista cerrada. Además los mensajes pasan a vivir fuera del VPS del cliente. | Bloqueante hasta decidir | Enmendar la constitución (`/speckit-constitution`): agregar "Kapso como proxy del canal WhatsApp" a la lista, con adaptador dedicado. **Decisión del dueño.** Alternativa: un modo dual con adaptador `WhatsAppProvider` (`meta` \| `kapso`) elegido por env, que mantiene el modo 100 % self-hosted. |
| Dependencia de un proveedor, costos y disponibilidad de Kapso | Si Kapso cae, no hay bandeja ni historial | Guardar en Vocero la vista previa y los timestamps (lista de conversaciones sin Kapso); mostrar un error degradado en el hilo; aplicar la regla del CLAUDE.md "un hipo del proveedor nunca tumba el turno" también en el agente. |
| La referencia **no tiene webhooks** (polling) | El agente IA y la creación de leads necesitan un evento en el servidor | Usar los webhooks de Kapso (verificar la doc: eventos, firma y reintentos) con dedup en `inbound_event`. Respaldo: un poll in-process por número cada N s, detrás de un flag. |
| Seguridad de la API key de Kapso | Con ella se puede enviar por **todos** los números de la cuenta | Guardarla cifrada (AES-256-GCM, `lib/crypto`), mostrar solo los últimos 4 y no mandarla nunca al cliente. El proxy de media debe tener auth y scope de organización (en la referencia `/api/media` es público). |
| La referencia **no tiene auth** y usa cookie para la configuración | Si se copian las rutas tal cual, quedan abiertas | Portar solo la lógica y la UI. Todas las rutas pasan por la sesión de Better Auth + `scoped()`. |
| SDK en `0.x` (el repo usa `^0.1.0`, npm tiene `0.3.0`) | Cambios incompatibles | Fijar la versión exacta y encapsular el SDK en `src/lib/kapso/` (un solo punto de contacto). |
| Historial previo | Kapso no tiene los mensajes que Vocero ya guardó | Mantener la tabla `message` en solo lectura para conversaciones "legacy" o exportarla. No borrarla hasta que el dueño lo apruebe. |
| Normalización de teléfono (MX `521`/`52`) | Contactos duplicados | Un solo normalizador + test unitario + migración de datos idempotente. |
| Límites de la API y latencia al leer mensajes en vivo | UI lenta, 429 | Caché corto por conversación, paginación (`limit ≤ 100`) y lista de conversaciones desde la BD local. |
| Sandbox del Laboratorio | Riesgo de que un `is_test` llegue a la red | La aserción `sandbox_violation` se mantiene **antes** de cualquier llamada al adaptador de Kapso, con un test unitario que lo cubra. |
| Self-test E2E (Definición de Hecho) | Hoy depende del wa-mock de Graph | Un `kapso-mock` bajo `src/app/api/dev/` con el gate `dev-guard` (404 en producción). |

---

## 8. Plan por fases (cada una desplegable y reversible por separado)

> Cada fase cumple el gate `pnpm typecheck && pnpm lint && pnpm build && pnpm test`
> más el self-test E2E con mocks (Definición de Hecho reforzada), y actualiza
> `specs/` (spec, plan, tasks).

**Fase 0: decisión y spec** (sin código de la app)
- El dueño decide sobre la enmienda de la Constitución II (§7.2) y sobre si hay
  un lead por contacto o por número (§5.4).
- Crear `specs/00X-kapso-inbox/` (spec, plan, tasks) a partir de este documento.
- Verificar en la doc de Kapso: eventos de webhook y firma, filtro de
  conversaciones por teléfono, y si el SDK permite crear plantillas.

**Fase 1: adaptador de proveedor detrás de un flag** (sin cambio visible)
- `src/lib/whatsapp/provider.ts` con la interfaz (`sendText`, `sendTemplate`,
  `listTemplates`, `testConnection`), implementada con `meta` (el código actual)
  y con `kapso` (SDK). Se elige con `WHATSAPP_PROVIDER=meta|kapso` (por defecto
  `meta`).
- Env nuevas (`KAPSO_API_KEY`, …) como placeholder `REEMPLAZA_...` en `.env`,
  con su guía.
- Se crea `kapso-mock`.
- Rollback: `WHATSAPP_PROVIDER=meta`.

**Fase 2: números en BD (multi-número listo, todavía con uno solo)**
- Migración: crear `whatsapp_number`, copiar desde `meta_credentials`, agregar
  `conversation.phone_number_id` (backfill con el único número) y crear el nuevo
  índice único.
- Pantalla de Configuración → WhatsApp: descubrir números de Kapso y elegir el
  por defecto.
- `send.ts` y `templates.ts` envían por `conversation.phone_number_id`.
- Rollback: las columnas son aditivas; `meta_credentials` se queda intacta.

**Fase 3: ingesta desde webhooks de Kapso**
- `/api/webhooks/kapso/[token]` con firma, dedup en `inbound_event` y
  procesamiento en `after()`. Reutiliza `getOrCreateContact`,
  `getOrCreateConversation`, `onLeadActivity`, SSE y `maybeRunAgentTurn`.
- **Doble escritura temporal**: se sigue guardando el cuerpo en `message`, para
  poder comparar y revertir.
- El webhook de Meta se deja activo, desactivado por flag.
- E2E: mensaje entrante por el mock → lead creado → responde el agente IA.

**Fase 4: lectura de mensajes desde Kapso** (Kapso pasa a ser la fuente de verdad)
- `listMessages` y el historial del agente (`ai/pipeline.ts`) leen de
  `messages.listByConversation` para conversaciones reales. El Laboratorio y la
  demo siguen en local.
- Se portan los normalizadores de mensajes de Kapso (media, reacciones,
  respuesta citada, transcripción).
- Se deja de guardar el cuerpo de los mensajes reales (se apaga la doble
  escritura con un flag).
- Rollback: el flag vuelve a leer de la BD local (hay doble escritura hasta aquí).

**Fase 5: funciones nuevas en la bandeja**
- Envío y visualización de multimedia (proxy de media autenticado), botones
  interactivos (también como acción del agente), plantillas con parámetros de
  header y botón (`buildTemplateSendPayload`).
- Filtro por número en la bandeja y selector de número para chats nuevos.
  Aquí ya se pueden activar varios números en producción.

**Fase 6: limpieza**
- Quitar `src/lib/meta/client.ts`, el webhook de Meta, `status.ts`,
  `meta_credentials`, `template-events.ts` y el wa-mock de Graph. Esto solo se
  hace si el dueño elige "solo Kapso"; si elige modo dual, se conserva el
  proveedor `meta`.
- Renombrar `message` a `lab_message` o archivar los mensajes legacy (con
  aprobación, porque es irreversible).
- Actualizar CLAUDE.md (mapa del código y variables), `.env.example` y la
  documentación de deploy.

---

## 9. Preguntas abiertas para el dueño

1. ¿Se aprueba enmendar la Constitución II para permitir Kapso? ¿Solo Kapso o
   modo dual Meta/Kapso?
2. ¿Una API key de Kapso por instancia (env) o una por organización (en BD y
   cifrada)?
3. Un contacto que escribe a dos números: ¿un lead o uno por número?
4. Mensajes históricos ya guardados en Vocero: ¿conservarlos en solo lectura,
   exportarlos o descartarlos tras el corte?
