import { desc, eq } from "drizzle-orm";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";

export function serializeContact(c: typeof schema.contact.$inferSelect) {
  return {
    id: c.id,
    name: c.name,
    phone: c.phone,
    waUserId: c.waUserId,
    notes: c.notes,
    archivedAt: c.archivedAt?.toISOString() ?? null,
  };
}

export async function getContactById(
  organizationId: string,
  contactId: string
) {
  const db = getDb();
  const rows = await db
    .select()
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        organizationId,
        eq(schema.contact.id, contactId)
      )
    )
    .limit(1);
  return rows[0] ?? null;
}

/**
 * Etapa del lead del contacto. Con conversationId, la del lead DE ESA
 * conversación (F2: un contacto puede tener un lead por número); sin él, la
 * del lead más reciente del contacto.
 */
export async function getContactStage(
  organizationId: string,
  contactId: string,
  conversationId?: string | null
) {
  const db = getDb();
  const rows = await db
    .select({ stage: schema.pipelineStage, lead: schema.lead })
    .from(schema.lead)
    .innerJoin(
      schema.pipelineStage,
      eq(schema.lead.stageId, schema.pipelineStage.id)
    )
    .where(
      scoped(
        schema.lead.organizationId,
        organizationId,
        eq(schema.lead.contactId, contactId),
        conversationId ? eq(schema.lead.conversationId, conversationId) : undefined
      )
    )
    .orderBy(desc(schema.lead.updatedAt))
    .limit(1);
  return rows[0] ?? null;
}
