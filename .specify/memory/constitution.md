<!--
SYNC IMPACT REPORT
==================
Versión: 1.2.0 → 1.3.0

Cambios:
  - Preámbulo: el agente de IA puede ser propio o provisto por el transporte.
  - Principio II "Soberanía / Self-Hosted" → EXPANDIDO: la dependencia 1 pasa a
    ser "Transporte de WhatsApp" con modo dual (meta | kapso, uno por instancia);
    la instancia se declara fuente de verdad; se admite el agente alojado en el
    transporte (Hermes) con garantía de un solo agente; transparencia de datos
    del modo kapso; requisitos del instalador actualizados.
  - Restricciones de Plataforma: adaptador de transporte (Meta o Kapso); sandbox
    "ni Meta ni Kapso"; KAPSO_API_KEY como secreto de instancia.
  - Principio IV: aclaración sobre ecos de salientes (sin cambio semántico).
  - Principios I, III, V, VI, VII, VIII y IX: íntegros.
  - Governance: Last Amended = 2026-09-23.

Bump: MINOR (1.2.0 → 1.3.0) — expansión material del Principio II; el modo
meta vigente sigue cumpliendo sin cambios (compatible hacia atrás).

Plantillas dependientes:
  - .specify/templates/plan-template.md — ✅ compatible (Constitution Check genérico).
  - .specify/templates/spec-template.md — ✅ compatible.
  - .specify/templates/tasks-template.md — ✅ compatible.
  - CLAUDE.md — ✅ reglas de Soberanía (transporte dual) y Sandbox ("ni Meta ni
    Kapso"); ⚠ mapa del código y variables KAPSO_* se completan con cada fase.
  - .env.example — ⚠ WHATSAPP_PROVIDER y KAPSO_* en F1; AGENT_ENGINE y
    LAB_ENABLED en F3.
  - docs de despliegue — ⚠ nota de transparencia de datos del modo kapso (F6).

TODOs diferidos: ninguno.

Historial previo: 1.1.0 → 1.2.0 (2026-07-09) — Principio II endurecido y
Principio VIII definido.
-->

# Vocero CRM Constitution

Vocero CRM es un CRM de WhatsApp con agente de IA (propio o provisto por el
proveedor de transporte), open source (MIT), self-hosted y gratuito, diseñado para que las agencias de IA lo desplieguen en el VPS de sus
clientes: una instancia = un negocio. Esta constitución define las reglas no
negociables del producto. Aplica a todas las fases del flujo de trabajo (specify,
plan, tasks, implement). Cualquier conflicto entre una decisión de implementación y
esta constitución SE RESUELVE A FAVOR de esta constitución.

## Core Principles

### I. Seguridad de Datos Primero (NO NEGOCIABLE)

La protección de datos es la primera responsabilidad del sistema, por encima de
velocidad de entrega o conveniencia de desarrollo.

- Tokens, credenciales y secretos sensibles NUNCA se exponen al cliente (navegador,
  app, respuestas de API) ni se escriben en logs, trazas o mensajes de error.
- Todo secreto se almacena cifrado en reposo. Las claves de cifrado se gestionan
  fuera del código fuente y fuera del control de versiones.
- Si el producto es multi-tenant, todo dato de un tenant está aislado de los demás:
  ninguna consulta, endpoint o tarea en segundo plano debe devolver o modificar datos
  de un tenant distinto al del solicitante. El aislamiento se aplica por defecto.

**Rationale**: Una fuga de credenciales o un cruce de datos entre clientes es un
fallo catastrófico e irreversible; prevenirlo siempre cuesta menos que remediarlo.

### II. Soberanía / Self-Hosted (ENDURECIDO)

Vocero CRM opera completo sobre la infraestructura del operador. La lista de
dependencias externas en runtime es CERRADA:

- Dependencias externas permitidas en runtime, ÚNICAMENTE:
  1. **Transporte de WhatsApp**, UNO por instancia, elegido por configuración
     (`WHATSAPP_PROVIDER`):
     a. **WhatsApp Cloud API** (Meta Graph API) directa — modo `meta`, el
        predeterminado y 100 % soberano; o
     b. **Kapso** como proxy de la Cloud API — modo `kapso`: envío de mensajes,
        recepción de eventos por webhook, descubrimiento de números/WABA y
        control (pausa/reanudación) del agente alojado en Kapso.
  2. **El proveedor LLM**, opcional, accedido EXCLUSIVAMENTE a través del adaptador
     OpenRouter-compatible (`OPENROUTER_BASE_URL` / `OPENROUTER_MODEL`). Sin token
     configurado, el producto funciona como CRM sin agente de IA propio.
- **La instancia es la fuente de verdad.** Mensajes (entrantes, salientes del
  operador y del agente), estados, contactos, conversaciones, pipeline, notas y
  handoff se persisten SIEMPRE en la base de datos propia de la instancia. El
  transporte NO es fuente de verdad: la instancia no depende de leer historial en
  vivo del proveedor para funcionar, y ante su caída solo se degradan los envíos.
- **Agente alojado en el transporte.** En modo `kapso` el agente conversacional
  puede residir en el proveedor (Hermes Agent). En ese caso el agente interno de
  Vocero NO se ejecuta sobre conversaciones reales (garantía de un solo agente
  respondiendo), y Vocero conserva el control de pausa/handoff por conversación.
- **Transparencia de datos.** El modo `kapso` implica que el proveedor retiene su
  propia copia de los mensajes; esto se documenta en la guía de despliegue para
  que la agencia lo comunique al negocio. El modo `meta` no tiene esta exposición
  adicional.
- **PROHIBIDO en v1**: almacenamiento de objetos externo (S3/R2), servicios de
  email, Stripe u otro billing, y servicios de Google. Cualquier feature que los
  requiera queda fuera del alcance de v1. (La media recibida se guarda en
  almacenamiento local de la instancia.)
- El instalador solo necesita: un VPS con Coolify o Docker, un dominio,
  credenciales de UN transporte de WhatsApp (credenciales de Meta, o una API key
  de Kapso por instancia) y (opcional) un token de OpenRouter. Nada más.
- Las funciones core —autenticación y base de datos— corren self-hosted (Better
  Auth + PostgreSQL propios de la instancia).
- Las integraciones externas permitidas se aíslan tras adaptadores dedicados
  (cliente de transporte WhatsApp propio —único punto de salida hacia Meta o
  Kapso—; adaptador LLM) para no acoplar el dominio a ellas.

**Rationale**: El producto se regala para que agencias lo desplieguen en VPS de
clientes; cada dependencia externa adicional es un costo, un punto de fallo y una
fuga de soberanía que rompe la promesa "gratis y tuyo". Kapso se admite como
alternativa de transporte —no como sustituto del CRM— porque simplifica la
conexión de números y aporta un agente gestionado, siempre que los datos del
negocio sigan viviendo en la instancia y el modo Meta directo siga disponible.

### III. Multi-Tenancy Real

El sistema sirve a organizaciones independientes desde una sola instancia lógica.
En Vocero cada instancia sirve a UN negocio, pero el modelo de datos es
multi-tenant real (organización del plugin de auth) para mantener el aislamiento
exigible y no cerrar la puerta a evoluciones.

- Cada organización (tenant) gestiona sus propios usuarios, roles y permisos.
- El identificador de tenant (`organization_id`) es un parámetro de primer nivel en
  el modelo de datos y en la capa de acceso a datos, no un campo opcional añadido a
  posteriori. Toda tabla de dominio lo lleva NOT NULL e indexado org-first.

**Rationale**: Multi-tenancy diseñado desde el inicio evita reescrituras costosas y
hace cumplible el aislamiento del Principio I.

### IV. Idempotencia en Integraciones Externas

Todo evento entrante de un sistema externo (webhooks, callbacks, notificaciones de
terceros) se procesa de forma idempotente.

- Recibir el mismo evento dos o más veces NO duplica efectos observables (mensajes
  reenviados, registros duplicados, acciones del agente repetidas).
- Cada evento entrante se identifica de forma única (p. ej. `wa_message_id` UNIQUE,
  también para los ecos de salientes que reenvía el proveedor de transporte, o la
  clave de idempotencia del proveedor, como `X-Idempotency-Key`)
  y su procesamiento se registra para detectar y descartar reintentos.

**Rationale**: Los proveedores externos reintentan entregas por diseño; sin
idempotencia, los reintentos corrompen datos y generan acciones duplicadas.

### V. Calidad Verificable Antes de "Hecho" (NO NEGOCIABLE)

Ninguna tarea se considera terminada sin pasar verificación.

- "Hecho" requiere, como mínimo: comprobación de tipos, lint y build; y tests donde
  apliquen al alcance de la tarea.
- Lo que NO se pueda verificar automáticamente se marca explícitamente como
  "pendiente de verificación humana"; no se reporta como completado sin esa marca.
- No se reporta una tarea como terminada describiendo que "debería funcionar": o pasa
  la verificación, o se declara su estado real (incluyendo fallos).

**Rationale**: La verificación automática es la única definición de "hecho" que no
depende de optimismo.

### VI. Specs Antes de Código

Ninguna feature se implementa sin una especificación previa.

- La especificación describe el comportamiento observable por el usuario, no la
  implementación.
- El orden del flujo es specify → plan → tasks → implement; el código de una feature
  no comienza antes de existir su spec.
- Correcciones triviales y cambios sin comportamiento observable nuevo (typos,
  formato, refactors internos sin cambio de contrato) están exentos.

**Rationale**: Especificar el comportamiento observable antes de codificar previene
retrabajo y mantiene alineadas todas las fases del flujo.

### VII. Trazabilidad de Decisiones

Las decisiones tomadas sin contexto suficiente se documentan para revisión humana.

- Cuando una decisión se toma con información incompleta o supuestos no confirmados,
  se registra de forma visible (en el spec, el plan, el PR o un marcador
  `NEEDS CLARIFICATION` / TODO con responsable), no se entierra en el código.
- Los supuestos que condicionan el comportamiento se hacen explícitos para que un
  humano pueda revisarlos y revertirlos.

**Rationale**: Las decisiones implícitas bajo incertidumbre son la principal fuente
de deuda oculta; hacerlas visibles permite corregirlas a tiempo.

### VIII. Foco Vertical — CRM de Conversaciones y Leads de WhatsApp

Es un CRM de conversaciones y leads de WhatsApp que las agencias despliegan para
negocios. No es plataforma de marketing masivo, ni constructor visual de flujos, ni
herramienta de scraping. Lo que no ayude a *atender, organizar y convertir
conversaciones de WhatsApp de UN negocio* se rechaza.

- El modelo de datos y los flujos MUST reflejar ese dominio: contactos que escriben
  por WhatsApp, conversaciones con ventana de 24h, leads en un pipeline, un agente
  de IA que atiende con el conocimiento del negocio y escala a humanos.
- WhatsApp Cloud API es el canal; el producto es el CRM. Features de canal que no
  sirvan a atender/organizar/convertir (broadcast masivo, scraping de números,
  flujos visuales genéricos) quedan FUERA del alcance de v1.
- Toda feature MUST servir a la agencia que despliega o al negocio que opera UNA
  instancia. Lo que solo sirva a una plataforma centralizada (billing, planes,
  multi-instancia) queda FUERA.

**Rationale**: Un foco vertical explícito mantiene el modelo de datos alineado con el
negocio real y da un criterio claro para aceptar o rechazar alcance.

### IX. Verificación de Comportamiento en Vivo (NO NEGOCIABLE)

Complementa el Principio V. TODA feature con comportamiento observable —UI web,
mensajería, API o integración externa— se verifica ejerciendo ese comportamiento como
lo haría un usuario real antes de declararse "Hecha". El gate técnico (Principio V) es
el piso, no el techo.

- **Self-test + loop por el implementador (self-improvement loop).** Tras implementar,
  quien implementa ejecuta el self-test E2E —camino feliz Y camino infeliz (degradación
  sin colgarse)— y, si algo falla, diagnostica, corrige y re-verifica él mismo hasta
  verde. No se entrega trabajo a medio verificar ni se delega la prueba funcional al
  dueño. Lo único delegable a verificación humana es lo intrínsecamente no verificable
  por herramientas (juicio visual, aprobación de un tercero), marcado explícitamente.
- **Se conduce la interfaz real.** Navegador vía Playwright para features de UI; la línea
  del canal (p. ej. una API de WhatsApp de prueba) para mensajería; llamadas a la API
  donde esa sea la superficie. No basta con tipos/lint/build, ni con que un endpoint
  devuelva 2xx, ni con inspeccionar la base de datos: se observa el resultado de cara al
  usuario.
- **Local primero, nube después.** Si el comportamiento puede reproducirse en `localhost`
  —incluyendo integraciones externas vía túnel (p. ej. ngrok + handshake del webhook desde
  el panel del proveedor)—, SHOULD probarse ahí antes de desplegar. El deploy a la nube se
  reserva para lo que el entorno local no pueda reproducir, porque desplegar consume tiempo
  y reduce la agilidad del ciclo.
- **Guardarraíles con herramientas no oficiales.** Cuando la prueba use herramientas no
  oficiales vinculadas a un número/cuenta real, MUST respetarse reglas duras: enviar solo a
  destinatarios de una allowlist, NUNCA mensajes en ráfaga (anti-flood obligatorio), y
  minimizar el volumen. La integridad de la cuenta del operador es un activo a proteger, en
  línea con el Principio I.

**Rationale**: El gate técnico no detecta que un agente "se calló", que una tarjeta no
llegó como un solo mensaje, o que un botón de UI no disparó nada — eso solo aparece
ejerciendo el flujo real. Y el valor del paso no está solo en detectar el fallo sino en
cerrarlo: el implementador itera hasta verde en vez de devolver trabajo a medias. Probar
en local primero mantiene el ciclo ágil; y sin guardarraíles duros, una prueba con
herramientas no oficiales podría provocar un baneo irreversible.

## Restricciones de Plataforma y Seguridad

Estas restricciones derivan de los Principios I y II y son verificables en revisión:

- **Gestión de secretos**: los secretos se inyectan vía configuración de entorno o un
  gestor de secretos; nunca se comprometen a control de versiones.
  La API key del transporte (`KAPSO_API_KEY`) es un secreto de instancia: vive en
  la configuración de entorno, jamás se expone al cliente ni a logs, y la UI solo
  muestra sus últimos 4 caracteres.
- **Cifrado en reposo**: credenciales y datos sensibles se almacenan cifrados; el
  almacenamiento en claro de secretos es una violación.
- **Frontera de tenant**: la capa de acceso a datos exige el identificador
  de tenant; cualquier acceso que pueda omitirlo requiere justificación explícita.
- **Aislamiento de integraciones**: las dependencias de APIs externas se acceden a
  través de adaptadores dedicados (cliente de transporte WhatsApp propio para
  Meta o Kapso, adaptador LLM OpenRouter-compatible), no dispersas por el dominio.
- **Instancia pública endurecida**: las rutas de mock/desarrollo devuelven 404
  incondicional en producción; el registro se cierra tras la primera organización
  (salvo habilitación explícita); los entornos de prueba internos (Laboratorio,
  conversaciones `is_test`) JAMÁS alcanzan un transporte real de WhatsApp —ni Meta
  ni Kapso—; la aserción ocurre antes de resolver el transporte.

## Flujo de Desarrollo y Puertas de Calidad

- **Orden del flujo**: specify → plan → tasks → implement. Cada fase consume el
  artefacto de la anterior.
- **Puerta constitucional (Constitution Check)**: el plan de cada feature evalúa el
  cumplimiento de estos principios antes de la Fase 0 y se re-evalúa tras el diseño de
  la Fase 1. Las violaciones se registran y justifican en Complexity Tracking o se
  eliminan.
- **Puerta de calidad (Definición de "Hecho")**: tipos + lint + build en verde, y
  tests donde apliquen; lo no verificable automáticamente se marca como pendiente de
  verificación humana (Principio V). Para features con comportamiento observable de cara
  al usuario, "Hecho" exige además el self-test de comportamiento en vivo ejecutado por el
  implementador, con sus guardarraíles (Principio IX).
- **Trazabilidad**: decisiones bajo incertidumbre y supuestos se documentan de forma
  visible (Principio VII), no en comentarios enterrados.

## Governance

Esta constitución es la autoridad máxima del proyecto. Prevalece sobre cualquier otra
práctica, convención o preferencia; ante un conflicto, gana la constitución.

- **Procedimiento de enmienda**: toda enmienda se propone por escrito describiendo el
  cambio y su motivación, se aprueba por el responsable del proyecto y se registra en
  el control de versiones junto con el Sync Impact Report actualizado.
- **Política de versionado** (semantic versioning de la constitución):
  - **MAJOR**: eliminación o redefinición incompatible de un principio o de la
    gobernanza.
  - **MINOR**: adición de un principio/sección nueva o expansión material.
  - **PATCH**: aclaraciones, correcciones de redacción y refinamientos no semánticos.
- **Revisión de cumplimiento**: cada PR y cada revisión de diseño verifican el
  cumplimiento de estos principios. La complejidad que viole un principio debe
  justificarse; si no, debe eliminarse.
- **Propagación**: al enmendar la constitución se revisan y, si procede, se actualizan
  las plantillas dependientes (plan, spec, tasks).

**Version**: 1.3.0 | **Ratified**: 2026-07-09 | **Last Amended**: 2026-09-23
