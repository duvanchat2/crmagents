# Feature Specification: Kapso como transporte de WhatsApp (003-kapso-transporte)

**Feature Branch**: `feat/f1-transporte-kapso` (fase F1; cada fase va en su propio PR)

**Created**: 2026-09-23

**Status**: En curso (F0 ✅, F1 ✅, F2 ✅, F3–F7 pendientes)

**Input**: Reemplazar la capa de WhatsApp directa por Kapso como transporte, con
Hermes Agent (en Kapso) como cerebro y Vocero como CRM y fuente de verdad. El
análisis completo, las decisiones (D1–D9) y las fases están en
[`docs/PLAN-kapso-inbox.md`](../../docs/PLAN-kapso-inbox.md). La constitución que
lo habilita es la 1.3.0 ([enmienda](../../docs/ENMIENDA-constitucion-II-kapso.md)).

## User Stories

### US1 (F1): la instancia envía por Kapso (P1)

Como operador de una instancia configurada con `WHATSAPP_PROVIDER=kapso`, conecto
un número que ya existe en mi cuenta de Kapso **sin pegar ningún token** y
respondo desde la bandeja. El mensaje sale por el proxy de Kapso con la API key
de la instancia y queda guardado en la BD de Vocero.

**Escenarios de aceptación**

1. **Dado** `WHATSAPP_PROVIDER=kapso` y `KAPSO_API_KEY`, **cuando** abro
   Configuración → WhatsApp, **entonces** el wizard no pide token y muestra solo
   los últimos 4 caracteres de la key.
2. **Dado** un Phone Number ID que no está en mi cuenta de Kapso, **cuando**
   pruebo la conexión, **entonces** veo un error claro y no puedo guardar.
3. **Dado** un número de mi cuenta, **cuando** pruebo, **entonces** Vocero
   autocompleta la WABA que informa Kapso, y al guardar queda "Conectado vía
   Kapso".
4. **Dado** un entrante en la ventana de 24 h, **cuando** respondo desde la
   bandeja, **entonces** el envío llega al proxy con `X-API-Key` (sin `Bearer`),
   por el número conectado y con el destinatario de México normalizado, y el
   mensaje queda en `message`.
5. **Dado** el modo Kapso, **cuando** entra un mensaje con el agente interno
   encendido y la IA configurada, **entonces** Vocero **no** responde (Hermes es
   el cerebro, `AGENT_ENGINE=hermes` por defecto).

**Camino infeliz**

6. Key rechazada por Kapso → error "revisa KAPSO_API_KEY" en el wizard y en el
   envío, sin colgarse y **sin** marcar la conexión como vencida.
7. Kapso caído → "Kapso no está disponible" en el wizard y en el envío.
8. Error OAuth de Meta reenviado por Kapso (190) → guía de reconectar el número
   en app.kapso.ai, sin culpar a la key.
9. Conversación `is_test` → sigue lanzando `sandbox_violation` antes de resolver
   el transporte.

### US2 (F1): el modo Meta no cambia (P1)

Con `WHATSAPP_PROVIDER=meta` (valor por defecto) todo funciona como antes: el
wizard pide token, envía con `Bearer` y el agente interno responde. Si la
conexión guardada es de otro transporte, se avisa y los envíos se bloquean con
guía hasta reconectar.

## Requisitos (F1)

- **FR-K01**: `WHATSAPP_PROVIDER=meta|kapso` (por defecto `meta`). En modo
  `kapso`, `KAPSO_API_KEY` es obligatoria y se valida al arrancar.
- **FR-K02**: un único cliente de salida (`src/lib/meta/client.ts`) resuelve el
  transporte: Graph + `Bearer` o proxy de Kapso + `X-API-Key`.
- **FR-K03**: en `kapso`, la prueba de conexión consulta
  `GET /platform/v1/whatsapp/phone_numbers` (paginado) y no llama a
  `subscribed_apps`.
- **FR-K04**: `meta_credentials.provider` y token nullable. Una conexión de otro
  transporte, o una meta sin token, no se usa para enviar (`not_connected` con
  guía).
- **FR-K05**: `AGENT_ENGINE` (`hermes` por defecto en `kapso`, `vocero` en
  `meta`). Con `hermes`, el agente interno jamás se programa para conversaciones
  reales.
- **FR-K06**: la API key nunca llega al cliente ni a los logs; la UI muestra
  solo los últimos 4 caracteres.

### US3 (F2): varios números por organización (P1)

Como operador, conecto varios números: los descubro en Kapso o los agrego con su
token en modo Meta. Cada conversación queda ligada al número por el que llegó y
**las respuestas salen por ese mismo número**. Elijo un número predeterminado,
que se preselecciona al iniciar un chat nuevo.

- **FR-K10**: un contacto por teléfono. El teléfono pasa por el normalizador
  único (`lib/phone`), y el contacto guarda también el `business_scoped_user_id`
  (BSUID).
- **FR-K11**: una conversación y un lead por (organización + `phone_number_id`
  + teléfono).
- **FR-K12**: el envío de texto y de plantillas usa el número de la
  conversación, en modo meta y en modo kapso. Las plantillas son por WABA y solo
  se envían por números de su WABA.
- **FR-K13**: chat nuevo con el número predeterminado preseleccionado. Fuera de
  la ventana de 24 h solo se permite plantilla, y lo exigen tanto la UI como el
  servidor.
- **FR-K14**: desactivar un número conserva el número y su historial, pero deja
  de ingerir entrantes y de enviar.
- **FR-K15**: la migración no pierde datos (`meta_credentials` se copia y se
  conserva) y tiene migración inversa probada.

