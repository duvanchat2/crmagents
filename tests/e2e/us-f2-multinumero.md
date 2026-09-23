# Guion E2E: F2 multi-número (Kapso con 2 números + actualización desde main en Meta)

> Script: `tests/e2e/f2-multinumero.mjs` (Playwright + aserciones en Postgres).
> Se corre contra `pnpm dev -p 3100` con los mocks. Variables del script:
> `E2E_BASE_URL`, `E2E_DATABASE_URL` (la misma BD que usa la app),
> `E2E_SHOTS_DIR` y `E2E_CHROMIUM`.
> El entorno base es el del guion de F1 (`us-f1-kapso-transporte.md`), incluido
> `OPENROUTER_MODEL`. El mock de Kapso reporta `kapso-pn-1` y `kapso-pn-2`,
> ambos de la WABA `kapso-waba-1`.

## 1. `kapso2`: BD nueva (migraciones 0000→0002), `WHATSAPP_PROVIDER=kapso`

1. Registro. En Configuración → WhatsApp, la tarjeta "Números de tu cuenta de
   Kapso" lista 2 números. Se conectan los 2:
   - ✅ el primero queda como **Predeterminado**;
   - ✅ los dos aparecen como "En esta organización";
   - ✅ "Hacer predeterminado" sobre PN2 deja **un solo** predeterminado en la BD.
2. El mismo teléfono de Colombia escribe a los dos números: primero como
   `+57 300 123 4567` con BSUID y después como `573001234567`.
   - ✅ **Un** contacto `573001234567`, con `wa_user_id` guardado.
   - ✅ **Dos** conversaciones (una por número) y **dos** leads, uno por
     conversación.
   - ✅ Un segundo mensaje al mismo número reutiliza la conversación y el lead.
   - ✅ Un móvil de México `5215512345678` se guarda canónico como `525512345678`.
3. Bandeja:
   - ✅ cada conversación muestra la etiqueta de su número;
   - ✅ el filtro "PN2" deja solo la conversación de PN2;
   - ✅ la cabecera del hilo dice "vía …".
4. Envío por el número de la conversación:
   - ✅ la respuesta en la conversación de PN1 sale por `kapso-pn-1`, con
     `X-API-Key` y `to=573001234567`;
   - ✅ la de PN2 sale por `kapso-pn-2`.
5. ✅ Mover la etapa desde la conversación de PN2 mueve **solo** su lead.
6. ✅ El pipeline muestra "vía {número}" en cada tarjeta.
7. ✅ Una plantilla nueva se crea en la WABA del número predeterminado, y el
   evento de estado de esa WABA la aprueba.
8. Chat nuevo (D9):
   - ✅ el número **predeterminado (PN2) viene preseleccionado**;
   - ✅ lista los contactos existentes;
   - ✅ muestra el aviso "solo plantilla";
   - ✅ con "Teléfono nuevo" `+57 310 000 0000` se abre la conversación por PN2,
     con el teléfono normalizado, **sin composer de texto libre**;
   - ✅ si se fuerza texto libre por la API, el servidor responde **409
     window_closed**;
   - ✅ la plantilla sale por PN2.
9. ✅ Dar de alta a mano `+52 1 55 1234 5678` devuelve **409 duplicado**: el
   normalizador reconoce el mismo contacto.
10. Desactivar PN1:
    - ✅ deja de ingerir entrantes;
    - ✅ el envío se bloquea con la guía "está desactivado";
    - ✅ el historial se conserva.

## 2. `legacy-null`: demo sembrada antes de conectar números

- ✅ La conversación de demo queda sin número.
- ✅ Tras conectar PN1 (la WABA la aporta Kapso), el primer entrante de ese
  teléfono **adopta** la conversación legada, sin abrir un segundo hilo, y el
  lead sigue siendo uno.

## 3. `pre-upgrade` → migración → `post-upgrade`: actualización real en modo Meta

1. `pre-upgrade`, contra **`main`** (worktree, BD migrada solo hasta 0001):
   - ✅ número meta conectado con token;
   - ✅ entrante de `5215599990000` (guardado como `521`);
   - ✅ respuesta con Bearer;
   - ✅ plantilla creada.
2. `pnpm db:migrate` (aplica 0002): ✅ conteos de 11 tablas y hash de mensajes
   idénticos antes y después.
3. `post-upgrade`, contra la app F2 en `WHATSAPP_PROVIDER=meta`:
   - ✅ login;
   - ✅ `whatsapp_number` tiene el número predeterminado con token, y
     `meta_credentials` sigue intacta;
   - ✅ Configuración muestra el número con `token …abcd`;
   - ✅ la conversación y el lead existentes quedaron ligados;
   - ✅ `origin` y `waba_id` rellenados;
   - ✅ un entrante canónico `525599990000` **reutiliza** el contacto legado
     `521` y su conversación;
   - ✅ **control positivo**: el agente interno responde;
   - ✅ el envío sale con Bearer por `meta-pn-1`, con `to` canónico.
4. Rollback (`specs/003-kapso-transporte/rollback-0002.sql`) sobre esa BD:
   - ✅ el esquema queda idéntico al de `main`;
   - ✅ la app de `main` hace login, muestra el historial completo y envía con
     Bearer.

## Regresión de F1 (`tests/e2e/f1-kapso-transporte.mjs`) contra F2

✅ `happy` 18/18, `invalid-key` 3/3, `kapso-down` 2/2 y `meta` 6/6. Ajustes al
guion por el cambio de UI y API:
- el error ahora aparece también en la tarjeta de descubrimiento (`.first()`);
- `GET /api/settings/whatsapp` devuelve `numbers[]`.

## Resultado (2026-09-23, código final)

| Escenario | Checks |
|---|---|
| kapso2 | 34/34 |
| legacy-null | 5/5 |
| pre-upgrade (main) | 4/4 |
| post-upgrade (F2, meta) | 12/12 |
| rollback + main | 3/3 |
| F1 happy / invalid-key / kapso-down / meta | 18/18 · 3/3 · 2/2 · 6/6 |

Bugs que encontró el self-test y que quedaron corregidos:
- **Chat nuevo**: si el diálogo se abría antes de que cargaran los números, el
  `<select>` mostraba el predeterminado pero el estado estaba vacío, y "Abrir
  conversación" no se habilitaba.
- **Conectar desde el descubrimiento** fallaba con 422 cuando Kapso no informaba
  la WABA en la lista.
- **Predeterminado inservible**: al cambiar de transporte (de kapso a meta), el
  predeterminado seguía siendo el número del transporte anterior.
- **Conversación legada sin número**: con el primer entrante se abría un
  segundo hilo en vez de adoptarla.
