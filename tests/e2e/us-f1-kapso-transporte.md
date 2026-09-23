# Guion E2E — F1: transporte dual (Kapso | Meta)

> Script: `tests/e2e/f1-kapso-transporte.mjs` (Playwright). Se corre contra
> `pnpm dev -p 3100` con los mocks, reiniciando el servidor entre escenarios
> porque el transporte se fija por entorno. Variables del script: `E2E_BASE_URL`,
> `E2E_SHOTS_DIR` (capturas) y `E2E_CHROMIUM` (Chromium ya instalado).

## Entorno base (todos los escenarios)

```
WA_MOCK_ENABLED=true
APP_BASE_URL=http://localhost:3100
META_GRAPH_BASE_URL=http://localhost:3100/api/dev/wa-mock/graph
KAPSO_WHATSAPP_API_URL=http://localhost:3100/api/dev/wa-mock/graph
KAPSO_API_BASE_URL=http://localhost:3100/api/dev/wa-mock
OPENROUTER_BASE_URL=http://localhost:3100/api/dev/ai-mock
OPENROUTER_API_TOKEN=test-token
OPENROUTER_MODEL=mock/modelo-e2e     # sin modelo el agente no corre y el control positivo sería vacuo
AGENT_COALESCE_MS=500
```

El mock de Kapso reporta los números `kapso-pn-1` y `kapso-pn-2` (WABA
`kapso-waba-1`). Una API key con sufijo `-invalid` recibe un 401.

## 1. `happy`: BD vacía, `WHATSAPP_PROVIDER=kapso`, `KAPSO_API_KEY=e2e-kapso-key-9876`

1. Registro de la primera organización → bandeja.
2. Se enciende el agente interno a propósito (IA configurada).
3. `/settings/whatsapp`:
   - ✅ modo Kapso, key `…9876`;
   - ✅ **sin** campo de token ni explicación de token de Meta.
4. `kapso-pn-9` → Probar. ✅ "no está en tu cuenta de Kapso", y Guardar sigue
   deshabilitado.
5. `kapso-pn-1` → Probar:
   - ✅ "Número encontrado en Kapso: +52 55 1111 0001";
   - ✅ WABA autocompletada `kapso-waba-1`.
6. Guardar:
   - ✅ "Conectado · vía Kapso · API key …9876";
   - ✅ aviso "por ahora la instancia solo ENVÍA por Kapso".
7. Entrante simulado (`/api/dev/wa-mock/inbound`, formato Meta como el futuro
   webhook `kind=meta`) y espera de 4 s. ✅ **outbox vacío**: el agente interno
   no respondió (Hermes).
8. El operador responde desde la bandeja:
   - ✅ el composer se vacía;
   - ✅ el outbox registra `auth: "api-key"`, `phoneNumberId: kapso-pn-1` y
     `to: 525512345678` (521 → 52);
   - ✅ la fila `message` `out` queda guardada con el wamid del proxy.

## 2. `invalid-key`: `KAPSO_API_KEY=e2e-kapso-key-invalid`

- ✅ Wizard: "Kapso rechazó la API key: revisa KAPSO_API_KEY".
- ✅ Envío desde la bandeja: el mismo error queda visible y no se cuelga.
- ✅ La conexión **no** pasa a `reconnect_required`, porque la key vive en `.env`.

## 3. `kapso-down`: `KAPSO_*_URL` → `127.0.0.1:3999` (nada escucha ahí)

- ✅ Wizard y envío: "Kapso no está disponible", degradado y sin colgarse.

## 4. `meta`: `WHATSAPP_PROVIDER=meta` (regresión)

1. ✅ Aviso "La conexión guardada es de Kapso, pero esta instancia usa Meta", y
   el wizard vuelve a pedir token.
2. ✅ Envío bloqueado con guía ("es de Kapso pero la instancia usa Meta").
3. ✅ Reconexión con token: "Token válido…" → guardado con `token …abcd`.
4. ✅ **Control positivo**: tras un entrante, el agente interno **sí** responde
   (motor `vocero`). Esto demuestra que el paso 1.7 no es vacuo.
5. ✅ El envío del operador sale con `auth: "bearer"`.

## Resultado (2026-09-23)

| Escenario | Checks |
|---|---|
| happy | 18/18 |
| invalid-key | 3/3 |
| kapso-down | 2/2 |
| meta | 6/6 |

Hallazgos durante el self-test, ya corregidos:
- Los wamid del mock se repetían tras reiniciar el servidor (contador en
  memoria) y chocaban con el UNIQUE. Ahora llevan un sufijo por arranque.
- Riesgo real anotado para F3: si el eco de un envío propio llega antes que la
  fila saliente, el insert del envío debe ser idempotente.
