# Tasks: 003-kapso-transporte

Fuente: [`docs/PLAN-kapso-inbox.md`](../../docs/PLAN-kapso-inbox.md) §9.
Estado durable del loop SDD: marcar al cerrar cada tarea (con verificación E2E).

## F0: decisiones y constitución

- [X] K001 Decisiones D1–D9 registradas en el plan
- [X] K002 Enmienda del Principio II aprobada y aplicada (constitución 1.3.0),
  propagada a CLAUDE.md
- [X] K003 P1, P2 y la firma verificados en docs.kapso.ai (§8.1)

## F1: transporte dual (salida)

- [X] K010 env: `WHATSAPP_PROVIDER`, `KAPSO_API_KEY` (obligatoria en kapso),
  `KAPSO_WHATSAPP_API_URL`, `KAPSO_GRAPH_API_VERSION`, `KAPSO_API_BASE_URL`,
  `AGENT_ENGINE`
- [X] K011 `graphRequest` con resolución de transporte + `kapsoPlatformRequest`
- [X] K012 Migración `0001`: `meta_credentials.provider` + token nullable
- [X] K013 `connectionProblem` / `handleTransportAuthError` (key rechazada vs.
  OAuth de Meta reenviado vs. token vencido)
- [X] K014 Wizard en modo Kapso (sin token, WABA autocompletada, key …last4,
  aviso por conexión de otro transporte)
- [X] K015 Motor del agente: Hermes por defecto en kapso (un solo agente)
- [X] K016 wa-mock: `X-API-Key`, auth registrada en el outbox,
  `/platform/v1/whatsapp/phone_numbers`, wamid únicos entre reinicios
- [X] K017 Unit tests (`tests/unit/kapso-transport.test.ts`, credenciales)
- [X] K018 Self-test E2E `tests/e2e/us-f1-kapso-transporte.md`: 4 escenarios,
  29/29 checks

## F2: multi-número y modelo de datos

- [ ] K020 Migraciones: `whatsapp_number`, `conversation.phone_number_id`,
  `lead.conversation_id`, `template.waba_id`, `contact.wa_user_id`,
  `message.origin` + columnas de media
- [ ] K021 Descubrimiento de números en Configuración (seleccionar y elegir el
  predeterminado)
- [ ] K022 Envío por el número de la conversación; filtro y etiqueta de número
  en la bandeja
- [ ] K023 Chat nuevo (D9): número predeterminado + selector; fuera de 24 h
  solo plantilla (UI y servidor)

## F3: ingesta de Kapso por el webhook actual

- [ ] K030 Capa de firma `X-Webhook-Signature` (`KAPSO_WEBHOOK_SECRET`)
- [ ] K031 `inbound_event` (dedup por `X-Idempotency-Key`)
- [ ] K032 Insert saliente idempotente frente a la carrera eco ↔ envío
- [ ] K033 `LAB_ENABLED=false` (D8)
- [ ] K034 Confirmar los ecos de Hermes en `kind=meta` (P3); si no llegan,
  agregar el webhook `whatsapp.message.sent`

## F4–F7

- [ ] K040 Handoff = pausa de Hermes (requiere P4)
- [ ] K050 UI portada de Kapso + multimedia (D7)
- [ ] K060 Limpieza (`meta_credentials`, `ai_generated`, docs de deploy)
- [ ] K070 Futuro: Laboratorio ↔ Hermes, herramientas de Hermes sobre el CRM
