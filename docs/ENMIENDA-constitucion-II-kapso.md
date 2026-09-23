# Propuesta de enmienda de la constitución: Principio II y Kapso como transporte

> **Estado**: borrador para aprobación del responsable del proyecto
> (Governance → "Procedimiento de enmienda").
> **Destino**: `.specify/memory/constitution.md`. Todavía **no** se ha aplicado:
> se aplica en F0 del [plan](./PLAN-kapso-inbox.md), una vez aprobada.
> **Versión**: 1.2.0 → **1.3.0** (MINOR: expansión material del Principio II,
> sin eliminar ni redefinir de forma incompatible ningún principio).

---

## 1. Motivación

El dueño decidió (plan, decisiones D1–D6) operar la instancia con **Kapso** como
proveedor de transporte de WhatsApp y con **Hermes Agent** (plugin de Kapso) como
cerebro conversacional. Hoy el Principio II solo permite dos dependencias
externas en runtime: Meta Cloud API y el proveedor LLM opcional. Por eso la
integración está bloqueada.

La enmienda busca:
- admitir a Kapso **solo como transporte**, a la par de Meta, en modo dual
  (`WHATSAPP_PROVIDER=meta|kapso`);
- que la instancia siga siendo la **fuente de verdad**: mensajes, contactos y
  estado del CRM se persisten siempre en la BD propia;
- permitir que el agente conversacional viva en el proveedor de transporte
  (Hermes), manteniendo el control de pausa y handoff en Vocero;
- dejar el modo `meta` intacto como opción 100 % soberana.

## 2. Cambios propuestos

### 2.1 Descripción del producto (preámbulo)

**Antes**
> Vocero CRM es un CRM de WhatsApp con agente de IA, open source (MIT), self-hosted y
> gratuito, […]

**Después**
> Vocero CRM es un CRM de WhatsApp con agente de IA (propio o provisto por el
> proveedor de transporte), open source (MIT), self-hosted y gratuito, […]

### 2.2 Principio II: texto completo propuesto

```markdown
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
```

### 2.3 Restricciones de Plataforma y Seguridad

**Aislamiento de integraciones.** Antes:
> las dependencias de APIs externas se acceden a través de adaptadores dedicados
> (cliente Graph API propio, adaptador LLM OpenRouter-compatible), no dispersas por
> el dominio.

Después:
> las dependencias de APIs externas se acceden a través de adaptadores dedicados
> (cliente de transporte WhatsApp propio para Meta o Kapso, adaptador LLM
> OpenRouter-compatible), no dispersas por el dominio.

**Instancia pública endurecida.** Se reemplaza la frase final:
> […] los entornos de prueba internos JAMÁS alcanzan la API real de WhatsApp.

por:
> […] los entornos de prueba internos (Laboratorio, conversaciones `is_test`)
> JAMÁS alcanzan un transporte real de WhatsApp —ni Meta ni Kapso—; la aserción
> ocurre antes de resolver el transporte.

**Gestión de secretos.** Se añade una viñeta:
> - La API key del transporte (`KAPSO_API_KEY`) es un secreto de instancia: vive en
>   la configuración de entorno, jamás se expone al cliente ni a logs, y la UI solo
>   muestra sus últimos 4 caracteres.

### 2.4 Principio IV: aclaración (sin cambio semántico)

Se añade al ejemplo de identificación única:
> (p. ej. `wa_message_id` UNIQUE, también para los ecos de salientes que reenvía
> el proveedor de transporte)

### 2.5 Principios sin cambios

I, III, V, VI, VII, VIII y IX quedan íntegros. En el IX, la "línea del canal"
de la verificación en vivo se ejerce con el mock del transporte activo.

## 3. Sync Impact Report (para el encabezado de la constitución)

```text
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
  - Governance: Last Amended = <fecha de aprobación>.

Bump: MINOR (1.2.0 → 1.3.0) — expansión material del Principio II; el modo
meta vigente sigue cumpliendo sin cambios (compatible hacia atrás).

Plantillas dependientes:
  - .specify/templates/plan-template.md — ✅ compatible (Constitution Check genérico).
  - .specify/templates/spec-template.md — ✅ compatible.
  - .specify/templates/tasks-template.md — ✅ compatible.
  - CLAUDE.md — ⚠ actualizar: regla de Soberanía (transporte dual), regla del
    Sandbox ("ni Meta ni Kapso"), mapa del código y variables KAPSO_*.
  - .env.example — ⚠ añadir WHATSAPP_PROVIDER, AGENT_ENGINE y KAPSO_* con guía.
  - docs de despliegue — ⚠ nota de transparencia de datos del modo kapso.

TODOs diferidos: ninguno.
```

## 4. Aprobación

- [ ] Aprobado por el responsable del proyecto (fecha: ____)
- [ ] Aplicada a `.specify/memory/constitution.md` con el Sync Impact Report
      actualizado (`/speckit-constitution`)
- [ ] Propagada a `CLAUDE.md`, `.env.example` y los documentos de deploy
