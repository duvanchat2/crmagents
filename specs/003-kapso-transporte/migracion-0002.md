# Migración 0002 (F2 multi-número): qué hace, cómo se verificó y cómo revertirla

- **Migración**: [`drizzle/0002_neat_kitty_pryde.sql`](../../drizzle/0002_neat_kitty_pryde.sql), aplicada al arrancar el contenedor, como todas.
- **Inversa**: [`rollback-0002.sql`](./rollback-0002.sql), manual y con backup previo.

## Garantías (sin pérdida de datos)

1. **`meta_credentials` no se modifica ni se borra.** Se **copia** a
   `whatsapp_number`: cada fila pasa a ser el número **predeterminado** de su
   organización, con el mismo token cifrado y el mismo estado. Se elimina recién
   en F6.
2. **Ninguna fila existente se borra ni se reescribe.** Solo se agregan columnas
   y se rellenan:

   | Columna | Se rellena con |
   |---|---|
   | `conversation.phone_number_id` | el número de la organización |
   | `lead.conversation_id` | la conversación real del contacto (había a lo sumo una) |
   | `template.waba_id` | la WABA de la organización |
   | `message.origin` | se deriva de `direction`, `ai_generated` y `type` |

   `message.origin` se agrega nullable, se rellena y **después** se marca
   NOT NULL.
3. **Los teléfonos guardados no se reescriben.** Un contacto de México legado
   (`521…`) se sigue encontrando porque el normalizador busca ambas formas
   (`phoneLookupVariants`). Esto evita choques con el UNIQUE y fusiones
   automáticas.
4. **Idempotente**: los pasos de datos usan `ON CONFLICT DO NOTHING` y
   `WHERE … IS NULL`.
5. **Índices**:
   - se reemplazan los únicos "uno por contacto" por "uno por (organización +
     número + contacto)" en conversaciones, "uno por conversación" en leads y
     "por WABA" en plantillas;
   - la conversación usa `coalesce(phone_number_id, '')` para que una
     conversación legada sin número también cuente como única;
   - `whatsapp_number` tiene a lo sumo un predeterminado por organización
     (índice único parcial).

## Verificación realizada

| Prueba | Resultado |
|---|---|
| BD sintética en estado 0001 (organización con conexión meta, otra sin número, contactos MX `521` y CO, conversación `is_test`, mensajes `in`/`out`/IA/plantilla, leads, plantilla) → aplicar 0002 | Conteos idénticos en las 8 tablas. `meta_credentials` intacta. Número copiado como predeterminado con su token. Conversaciones, leads, plantillas y `origin` rellenados. |
| Re-ejecutar los pasos de datos | Hash de las filas idéntico (idempotente) |
| **Actualización real**: `main` en un worktree (meta, registro, conexión, entrante, respuesta, plantilla) → `pnpm db:migrate` → app F2 en meta | Conteos y mensajes (hash) idénticos. E2E `post-upgrade` 12/12: login, número migrado con `token …abcd`, contacto legado `521` reutilizado por un entrante `52…` sin duplicarse, agente interno responde, envío con Bearer por el número. |
| `rollback-0002.sql` sobre esa BD ya usada por F2 | El esquema resultante es **idéntico** al de `main` (`pg_dump --schema-only`). La app de `main` sobre la BD revertida hace login, muestra el historial completo y envía con Bearer. |

## Migración inversa

```bash
# 1. Detener la app y hacer backup
pg_dump "$DATABASE_URL" > backup-antes-de-revertir.sql
# 2. Revertir el esquema (aborta sin cambios si hay datos que 0001 no puede representar)
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f specs/003-kapso-transporte/rollback-0002.sql
# 3. Desplegar la versión anterior de la app (main antes de F2)
```

El rollback **aborta sin tocar nada** si ya se usó el modo multi-número de un
modo que 0001 no puede representar:
- un contacto con dos conversaciones o dos leads reales;
- plantillas con el mismo nombre e idioma en dos WABAs.

En esos casos hay que fusionar o eliminar esos datos antes. Lo que sí se pierde
al revertir, porque solo existe desde F2:
- los números no predeterminados;
- el BSUID de los contactos;
- el `origin` de los mensajes;
- la WABA de las plantillas.
