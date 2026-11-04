# Decisión pendiente: CRM nuevo gestionado por Hermes — ¿qué transporte de WhatsApp?

> Documento para revisar y decidir con otro agente. Autocontenido: no hace falta
> leer el resto del repo. Fecha: 2026-11-04.

## 1. Contexto: qué cambió

Hasta ahora el trabajo fue adaptar **Vocero CRM** (este repo, `duvanchat2/crmagents`):
Next.js + Postgres, con Kapso como transporte de WhatsApp. Se hicieron las fases
F0–F2 del plan `docs/PLAN-kapso-inbox.md`. F2 (multi-número) está en el PR #5, sin
fusionar.

**Decisión nueva del dueño (2026-11-04):**

- **No se usará Vocero.** Se construye un **CRM nuevo desde cero**, en un
  **repositorio nuevo**. `crmagents` queda como referencia.
- El CRM lo **gestiona el agente Hermes** (Hermes Agent, de Nous Research). Hermes
  atiende las conversaciones y opera el CRM: crea y actualiza contactos, mueve
  leads por el pipeline y toma notas.
- Interfaz: **API/MCP para Hermes + una UI web mínima** para que las personas vean
  contactos, conversaciones y pipeline.
- El dueño propuso usar **Zernio** (zernio.com, antes "Late") **como puente que
  recibe los mensajes de Kapso y se los pasa a Hermes**.
- PR #5 (F2 de Vocero): ya no se vigila. Sigue abierto y el dueño decide si lo cierra.

## 2. Hallazgo que obliga a decidir

Se revisó la documentación pública de Zernio el 2026-11-04. La arquitectura
propuesta (**Kapso → Zernio → Hermes**) **no está soportada tal como se planteó**:

1. **Zernio no se monta sobre Kapso: es otro transporte.** Se conecta directo a
   la WhatsApp Cloud API oficial de Meta, por Embedded Signup o con un token de
   System User. En ninguna página revisada aparece una integración con Kapso, ni
   una forma de importar números gestionados por Kapso.
   - https://docs.zernio.com/platforms/whatsapp
   - https://docs.zernio.com/platforms/whatsapp/connect
2. **Ponerlos en serie sobre el mismo número probablemente rompe Kapso.** Al
   conectar por credenciales, Zernio suscribe la WABA a sus propios webhooks, y la
   documentación advierte: *"Any callback URL you had configured on this WABA
   stops receiving events at once."* Kapso dejaría de recibir los mensajes.
   **Pendiente: confirmarlo con el soporte de Zernio.**
3. **Hermes no tiene integración documentada** ni en Zernio ni en Kapso. Se
   integraría por MCP (HTTP) o por REST genérico, si Hermes soporta alguno de los
   dos. **Pendiente: confirmarlo en la documentación de Hermes.**

## 3. Qué ofrece cada uno (resumen verificado)

### Zernio

- **Entrada:** webhooks registrados con `POST /v1/webhooks/settings`.
  - Eventos: `message.received`, `message.sent`, `message.delivered`,
    `message.read`, `message.failed`, `reaction.received`,
    `whatsapp.template.status_updated`, entre otros.
  - Firma: HMAC-SHA256 en el header `X-Zernio-Signature`.
  - Deduplicación con `X-Zernio-Event-Id`.
  - Entrega *at-least-once*, hasta 7 intentos. El endpoint debe responder 2xx en
    menos de 5 s.
  - Fuente: https://docs.zernio.com/webhooks
- **Salida:**
  - Responder: `POST /v1/inbox/conversations/{id}/messages`. Texto libre solo
    dentro de la ventana de 24 h.
  - Fuera de la ventana, o para iniciar una conversación, plantilla aprobada:
    `POST /v1/inbox/conversations`.
  - Fuente: https://docs.zernio.com/platforms/whatsapp/inbox
- **MCP alojado:** `https://mcp.zernio.com/mcp` (Streamable HTTP). Acepta OAuth o
  `Authorization: Bearer <ZERNIO_API_KEY>`. Unas 50 herramientas visibles, más
  `search_tools`/`call_tool`. Está en el MCP Registry como `com.zernio/zernio`.
  - Fuente: https://docs.zernio.com/mcp
- **Auth:** `Authorization: Bearer <api_key>`.
- **Límites:** 60 req/min en el plan gratis, 600 en los planes de pago.
- **Precios** (https://zernio.com/pricing.md):
  - Mensajes enviados: los primeros 10.000/mes gratis, luego $1 por cada 10.000.
    Recibir es gratis.
  - Desde el 1 oct 2026, Meta cobra los mensajes de servicio después de 1.000
    gratis por número al mes.
  - **Ambigüedad:** la página no deja claro si WhatsApp también consume el cupo
    de 10.000 de Zernio. Verificarlo.
  - Cuentas: las 2 primeras gratis.

### Kapso (ya probado en F1/F2 de Vocero)

- Proxy de la Graph API: `https://api.kapso.ai/meta/whatsapp/v24.0/...`, con el
  header `X-API-Key`.
- Webhooks por número, en dos formatos: el de Kapso y `kind:"meta"`, este con
  `X-Idempotency-Key`. Firma en `X-Webhook-Signature`.
- Existe el evento `whatsapp.message.sent`. BSUID confirmado.
- Hay un MCP de Kapso disponible para agentes (conversaciones, contactos,
  plantillas, números, flujos). **Pendiente: confirmar** si es usable por Hermes
  fuera de Claude.
- Ventaja: ya tenemos código y E2E probados contra Kapso en `crmagents`, que
  sirven de referencia.

## 4. Opciones

> Restricción común: **un número de WhatsApp = un solo transporte.**

### A. Solo Zernio — *recomendada*

```
WhatsApp ⇄ Meta Cloud API ⇄ Zernio ──webhook──▶ CRM (guarda) ──▶ Hermes
                                ▲                    ▲
                     MCP Zernio │                    │ MCP del CRM
                                └────── Hermes ──────┘
```

- Hermes **responde por WhatsApp con el MCP de Zernio** y **gestiona el CRM con
  un MCP propio** (contactos, leads, pipeline, notas).
- El CRM es la fuente de verdad: guarda cada mensaje entrante y saliente a partir
  de los webhooks de Zernio, deduplicando por `X-Zernio-Event-Id`.
- **A favor:** menos código propio para hablar por WhatsApp (el MCP ya existe);
  un solo proveedor; precios claros.
- **En contra:**
  - Kapso queda fuera.
  - Si hay números ya conectados en Kapso, hay que migrarlos (con riesgo de
    cortar sus webhooks).
  - Dependemos de un proveedor que no hemos probado en E2E.

### B. Solo Kapso

```
WhatsApp ⇄ Meta ⇄ Kapso ──webhook──▶ CRM (guarda) ──▶ Hermes
                    ▲                    ▲
     proxy Graph API│                    │ MCP del CRM (incluye "enviar mensaje")
                    └──── CRM ◀─ Hermes ─┘
```

- No usa Zernio. El CRM expone a Hermes un MCP que también envía mensajes,
  pasando por el proxy de Kapso.
- **A favor:**
  - Experiencia previa y código de referencia probado (F1/F2).
  - Los números ya conectados en Kapso no se tocan.
- **En contra:** construimos y mantenemos nosotros el envío, las plantillas y la
  ventana de 24 h, sin MCP de mensajería listo para usar.

### C. Híbrido por número

- Cada número usa Kapso **o** Zernio, y el CRM acepta los dos webhooks.
- **A favor:** permite mantener números en Kapso y sumar otros por Zernio.
- **En contra:** dos integraciones que mantener, normalizar y probar. Solo se
  justifica si hay números que **deben** seguir en Kapso.

## 5. Preguntas para decidir

1. ¿Hay números de WhatsApp que **deben** quedarse en Kapso? Si no los hay, A es
   la opción natural. Si los hay, B o C.
2. ¿Hermes soporta un cliente MCP por HTTP (Streamable HTTP + Bearer)? ¿O solo
   herramientas locales/REST? Esto decide si sirve el MCP alojado de Zernio.
3. ¿Quién envía los mensajes: Hermes directo al transporte, o siempre a través del
   CRM? Que pase por el CRM garantiza el registro y las reglas (ventana de 24 h,
   sandbox). Que vaya directo es más simple, pero el CRM depende de los webhooks
   `message.sent` para enterarse.
4. ¿Se confirmó con Zernio si el cupo de 10.000 mensajes aplica a WhatsApp, y qué
   pasa al conectar una WABA que ya tiene otra URL de webhook?
5. ¿Nombre y dueño del repo nuevo? (p. ej., `duvanchat2/hermes-crm`).

## 6. Componentes del CRM nuevo (independientes de la opción)

- **Datos:**
  - `contact`: único por teléfono normalizado E.164, con BSUID opcional.
  - `conversation`: única por número + contacto.
  - `message`: idempotente por id del proveedor.
  - `lead` / `pipeline_stage`, `note`, `whatsapp_number`.
  - `inbound_event`: dedupe de webhooks.
- **Webhook de entrada:** verificar la firma, deduplicar, guardar y notificar a
  Hermes. Responder 2xx rápido; el trabajo pesado va después.
- **MCP del CRM para Hermes:**
  - `contacts_search` / `contacts_upsert`
  - `conversations_list` / `conversations_get`
  - `leads_move_stage`
  - `notes_add`
  - y, en la opción B, `messages_send` / `templates_send`.
- **UI mínima:** listado de contactos, vista de una conversación (solo lectura o
  con intervención humana), tablero del pipeline.
- **Reutilizable de `crmagents`** como referencia:
  - normalizador de teléfonos (`src/lib/phone.ts`, con tests de CO 57 y MX 521→52);
  - cifrado de secretos (AES-256-GCM);
  - patrón de ingesta idempotente;
  - test de paridad entre env y compose.

## 7. Recomendación actual

**Opción A (solo Zernio)**, salvo que la pregunta 1 diga que hay números atados a
Kapso. Antes de construir, confirmar las preguntas 2 y 4. Con la decisión tomada,
el siguiente paso es escribir el plan por fases del repo nuevo (arquitectura,
esquema, herramientas MCP, E2E) y revisarlo antes de escribir código.
