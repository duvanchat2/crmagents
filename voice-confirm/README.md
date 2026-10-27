# voice-confirm · llamada automática de confirmación de matrícula

Al terminar una venta, este servicio llama automáticamente al cliente desde el número 601 de Genix.
Un agente de voz le pide su cédula, le lee el programa, el valor y las cuotas, y le pide decir
"yo, …, acepto la compra". Toda la llamada queda grabada y el resultado llega a n8n.

> **Es un servicio aparte de Vocero CRM.** Corre en su propio VPS, no toca la app Next.js ni su
> base de datos, y no forma parte de las dependencias de runtime de Vocero (constitución, Principio II).

## Cómo funciona

```
n8n ──POST /v1/calls──▶ dispatcher ──despacho──▶ LiveKit server ──▶ agente de voz (Python)
                            ▲                                          │
                            │                                          ├─ oído:    AssemblyAI
                            │ resultado + grabación                    ├─ cerebro: Claude Haiku (OpenRouter)
                            │                                          ├─ voz:     Fish Audio / ElevenLabs
n8n ◀──webhook firmado──────┘                                          ▼
                                                     LiveKit SIP ──SIP──▶ Zadarma (601) ──▶ celular del cliente
```

1. n8n manda la venta al **dispatcher** (`POST /v1/calls`). El dispatcher valida el número,
   respeta el horario de la Ley 2300 y crea la llamada.
2. El **agente** marca por la troncal SIP de Zadarma y espera a que contesten.
3. Si contesta un buzón de voz, cuelga (`buzon`). Si contesta una persona, sigue el guion fijo.
4. Al colgar, el agente guarda `result.json` y la grabación `audio.ogg` (cliente y agente en un solo archivo).
5. El dispatcher sube la grabación a Bunny (opcional) y manda el resultado a n8n.
   Si n8n no responde, reintenta solo (30 s, 2 min, 10 min, 30 min y luego cada hora).

Zadarma autorizó por escrito usar su número con un agente de voz con IA conectado por SIP,
siempre que la duración promedio sea mayor a 20 s y se contesten más del 20 % de las llamadas.

## Lo que hay en esta carpeta

| Ruta | Qué es |
|---|---|
| `docker-compose.yml` | Redis, LiveKit server, LiveKit SIP, agente, dispatcher y Caddy (opcional, para HTTPS) |
| `config/*.tmpl` | Plantillas de configuración de LiveKit, SIP y Caddy |
| `app/voice_confirm/agent.py` | El agente de voz (LiveKit Agents) |
| `app/voice_confirm/dispatcher.py` | La API que usa n8n y la entrega de resultados |
| `app/voice_confirm/domain.py` | Guion, horario, números en letras, evaluación del resultado |
| `app/voice_confirm/trunk.py` | Crea la troncal SIP de Zadarma en LiveKit |
| `scripts/bootstrap.sh` | Instala y levanta todo en el VPS (idempotente) |
| `scripts/deploy-from-local.sh` | Copia esta carpeta al VPS por SSH y corre el bootstrap |
| `scripts/check.sh` · `scripts/test-call.sh` | Verificación y llamada de prueba |

El subagente **`voice-vps-ops`** (`.claude/agents/voice-vps-ops.md`) sigue este mismo flujo:
pídale a Claude Code "instala la llamada automática en mi VPS" y él se conecta, instala y verifica.

## Requisitos

- VPS con Ubuntu 22.04/24.04 o Debian 12, **IPv4 pública**, 2 vCPU y 4 GB de RAM como mínimo.
- Puertos abiertos hacia Internet: **5060 UDP/TCP** (SIP) y **10000-20000 UDP** (audio).
  Si el proveedor tiene firewall en su panel, ábralos ahí también.
- Zadarma: número fijo 601 y una **extensión** de la centralita con ese 601 como CallerID.
- Cuentas: AssemblyAI, OpenRouter (o Anthropic), Fish Audio (o ElevenLabs). Bunny es opcional.

## Instalación

### Opción A: con el subagente

En Claude Code, desde la raíz del repo: *"Usa voice-vps-ops para instalar la llamada automática en mi VPS"*.
Le pedirá el acceso SSH y las credenciales que falten.

### Opción B: a mano

```bash
# En su computador, desde la raíz del repo
cp voice-confirm/.env.example voice-confirm/.env      # complete las variables REEMPLAZA_...
VPS_HOST=203.0.113.10 VPS_USER=root ./voice-confirm/scripts/deploy-from-local.sh
```

O directamente en el VPS:

```bash
git clone <este repo> && cd crmagents/voice-confirm
cp .env.example .env && nano .env
sudo ./scripts/bootstrap.sh
```

`bootstrap.sh` genera las claves internas, valida que no falte nada, configura el firewall,
construye la imagen, crea la troncal de Zadarma en LiveKit y corre `check.sh`.
Si faltan variables, sale con código 2 y lista **solo los nombres**.

### Probar con un celular propio

```bash
cd /opt/genix-voice
./scripts/test-call.sh +573001234567 "Su Nombre" 1234567890
```

Antes de esto, escuche las voces en español en fish.audio (o elevenlabs.io) y elija una:
su ID va en `FISH_VOICE_ID` (o `ELEVEN_VOICE_ID`).

## Contrato con n8n

### n8n pide la llamada

`POST https://<DISPATCHER_DOMAIN>/v1/calls` (o `http://127.0.0.1:8088/v1/calls` si n8n está en el mismo VPS)

```
Authorization: Bearer <DISPATCHER_TOKEN>
Content-Type: application/json
```

```json
{
  "venta_id": "GX-000123",
  "telefono": "3001234567",
  "nombre": "Carlos Pérez",
  "cedula": "1234567890",
  "programa": "Inteligencia Artificial para Empresas",
  "contenido": "cuarenta horas de clases y certificado",
  "valor_total": 480000,
  "numero_cuotas": 6,
  "valor_cuota": 80000,
  "fecha_primera_cuota": "2026-11-05",
  "periodicidad": "mensuales",
  "asesor": "Juan"
}
```

Respuestas:

| Código | Significado |
|---|---|
| `202` | `{"call_id": "venta-GX-000123-a1b2c3", "estado": "marcando"}` |
| `409` `fuera_de_horario` | Ley 2300: L-V 7:00-19:00, sábado 8:00-15:00, sin domingos ni festivos. Reintente en horario |
| `409` `llamada_en_curso` | Ya hay una llamada en curso para esa venta |
| `422` | Datos inválidos (teléfono, cédula, valores) |
| `502` | LiveKit no respondió |

`GET /v1/calls/{call_id}` devuelve el estado mientras tanto.

### El resultado llega al webhook de n8n

`POST N8N_RESULT_WEBHOOK_URL`, con la cabecera `X-Genix-Signature: sha256=<hmac>` (HMAC-SHA256 del
cuerpo con `N8N_WEBHOOK_SECRET`).

```json
{
  "evento": "confirmacion_llamada",
  "call_id": "venta-GX-000123-a1b2c3",
  "venta_id": "GX-000123",
  "telefono": "+573001234567",
  "estado": "confirmada",
  "cedula_coincide": true,
  "confirma_condiciones": true,
  "dijo_acepto": true,
  "frase_aceptacion": "yo Carlos Pérez acepto la compra",
  "motivo_fin": "completada",
  "solicitada": "2026-10-27T15:00:01+00:00",
  "contestada": "2026-10-27T15:00:09+00:00",
  "finalizada": "2026-10-27T15:01:52+00:00",
  "grabacion": {"almacen": "bunny", "ruta": "grabaciones-confirmacion/2026/10/GX-000123-venta-GX-000123-a1b2c3.ogg"},
  "transcripcion": [{"rol": "agente", "texto": "Hola, le habla..."}, {"rol": "cliente", "texto": "uno dos tres..."}]
}
```

| `estado` | Qué hacer en n8n |
|---|---|
| `confirmada` | Activar el curso y mandar la bienvenida por WhatsApp |
| `revision` | Dijo que no a algo o la cédula no coincidió: pasar a la oficina |
| `incompleta` | Colgó antes de terminar: reintentar o pasar a la oficina |
| `no_contesta` / `ocupado` / `buzon` | Avisar por WhatsApp y reintentar (máx. 3 al día, en horario) |
| `fallida` | Error técnico: revisar el servicio (`voice-vps-ops`) |

Verificar la firma en un nodo **Code** de n8n, justo después del Webhook. El cuerpo se envía como
JSON compacto, igual al que produce `JSON.stringify`:

```js
const crypto = require('crypto');
const item = $input.first().json;
const raw = JSON.stringify(item.body);
const expected = 'sha256=' + crypto.createHmac('sha256', $env.N8N_WEBHOOK_SECRET).update(raw, 'utf8').digest('hex');
if (item.headers['x-genix-signature'] !== expected) throw new Error('Firma inválida');
return $input.all();
```

Guarde `N8N_WEBHOOK_SECRET` como variable de entorno de n8n (o en una credencial) con el mismo valor del VPS.

## Costos (300 ventas al mes, llamada de 2 minutos)

| Pieza | Por llamada | Mensual |
|---|---|---|
| Zadarma, minutos a celular (USD 0,024/min) | USD 0,048 | USD 14,40 |
| Número 601 | | USD 18 |
| AssemblyAI multilingüe (USD 0,15/h) | USD 0,005 | USD 1,50 |
| Claude Haiku 5.5 por OpenRouter | ≈ USD 0,001 | ≈ USD 0,40 |
| Fish Audio (USD 15 por millón de caracteres) | ≈ USD 0,008 | ≈ USD 2,30 |
| **Total** | **≈ USD 0,06** | **≈ USD 37** |

Las llamadas no contestadas no cuestan nada. El VPS no se cuenta (ya existe).

## Datos personales y Ley 2300

- La hoja de inscripción debe autorizar la grabación de la llamada de confirmación (Ley 1581).
  La llamada lo anuncia en su primera frase.
- El dispatcher rechaza llamadas fuera del horario permitido. Mantenga `COLOMBIA_HOLIDAYS` al día.
- Las grabaciones quedan en el VPS (`data/calls/`) y, si se configura, en Bunny. Se borran del VPS
  `LOCAL_RETENTION_DAYS` días después de entregadas.

## Desarrollo

```bash
cd voice-confirm/app
python3.11 -m venv .venv && . .venv/bin/activate
pip install -r requirements-dev.txt
pytest
```

## Lo que falta probar en el VPS real

Esto se validó con pruebas automáticas (guion, horario, números, entrega a n8n, API), pero
hay partes que solo se confirman con el VPS, Zadarma y las cuentas reales:

1. Que Zadarma acepte la troncal desde LiveKit (`pbx.zadarma.com` con usuario y clave de la extensión).
2. Que el cliente vea el 601 y que el audio pase en las dos direcciones (puertos UDP).
3. El nombre exacto del modelo en OpenRouter (`LLM_MODEL`) y que acepte `LLM_REASONING=off`.
4. La voz elegida en Fish Audio y que AssemblyAI entienda bien las cédulas dictadas.
5. La demora entre que el cliente habla y el agente responde (debe ser menor a 1,5 s).
