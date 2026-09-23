import { and, asc, eq, isNull, sql } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";

/**
 * Actividad de lead al recibir un mensaje (US2, F2): un lead por conversación
 * real, es decir por (organización + número + teléfono).
 * - Si la conversación ya tiene lead → se actualiza su última actividad.
 * - Si el contacto tiene un lead SIN conversación (creado antes, o migrado sin
 *   conversación) → se adopta para esta conversación en vez de duplicarlo.
 * - Si no → se crea en la primera etapa abierta del pipeline.
 */
export async function onLeadActivity(
  organizationId: string,
  conversation: { id: string; contactId: string },
  at: Date
): Promise<void> {
  const db = getDb();

  const existing = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(eq(schema.lead.conversationId, conversation.id))
    .limit(1);
  if (existing[0]) {
    await db
      .update(schema.lead)
      .set({ lastActivityAt: at, updatedAt: new Date() })
      .where(eq(schema.lead.id, existing[0].id));
    return;
  }

  const orphan = await db
    .select({ id: schema.lead.id })
    .from(schema.lead)
    .where(
      and(
        eq(schema.lead.organizationId, organizationId),
        eq(schema.lead.contactId, conversation.contactId),
        isNull(schema.lead.conversationId)
      )
    )
    .limit(1);
  if (orphan[0]) {
    await db
      .update(schema.lead)
      .set({
        conversationId: conversation.id,
        lastActivityAt: at,
        updatedAt: new Date(),
      })
      .where(eq(schema.lead.id, orphan[0].id));
    return;
  }

  const firstStage = await db
    .select({ id: schema.pipelineStage.id })
    .from(schema.pipelineStage)
    .where(
      and(
        eq(schema.pipelineStage.organizationId, organizationId),
        eq(schema.pipelineStage.kind, "open")
      )
    )
    .orderBy(asc(schema.pipelineStage.position))
    .limit(1);
  if (!firstStage[0]) return; // pipeline sin etapas abiertas: no hay dónde crear

  const maxPos = await db
    .select({ max: sql<number>`coalesce(max(${schema.lead.position}), -1)` })
    .from(schema.lead)
    .where(
      and(
        eq(schema.lead.organizationId, organizationId),
        eq(schema.lead.stageId, firstStage[0].id)
      )
    );

  await db
    .insert(schema.lead)
    .values({
      id: newId("lead"),
      organizationId,
      contactId: conversation.contactId,
      conversationId: conversation.id,
      stageId: firstStage[0].id,
      position: (maxPos[0]?.max ?? -1) + 1,
      lastActivityAt: at,
    })
    .onConflictDoNothing({ target: [schema.lead.conversationId] });
}
