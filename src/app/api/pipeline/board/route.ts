import { and, asc, eq } from "drizzle-orm";
import { withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import { numberLabel } from "@/server/whatsapp/credentials";

export const dynamic = "force-dynamic";

/** Datos completos del kanban: etapas ordenadas + tarjetas con su contacto. */
export const GET = withAuth(async (session) => {
  const db = getDb();

  const stages = await db
    .select()
    .from(schema.pipelineStage)
    .where(scoped(schema.pipelineStage.organizationId, session.organizationId))
    .orderBy(asc(schema.pipelineStage.position));

  // F2: un lead por conversación real (número + teléfono); la tarjeta muestra
  // por qué número llegó.
  const leads = await db
    .select({
      lead: schema.lead,
      contact: schema.contact,
      conversationId: schema.conversation.id,
      number: schema.whatsappNumber,
    })
    .from(schema.lead)
    .innerJoin(schema.contact, eq(schema.lead.contactId, schema.contact.id))
    .leftJoin(
      schema.conversation,
      and(
        eq(schema.conversation.id, schema.lead.conversationId),
        eq(schema.conversation.isTest, false)
      )
    )
    .leftJoin(
      schema.whatsappNumber,
      eq(schema.whatsappNumber.phoneNumberId, schema.conversation.phoneNumberId)
    )
    .where(scoped(schema.lead.organizationId, session.organizationId))
    .orderBy(asc(schema.lead.position));

  return Response.json({
    stages: stages.map((s) => ({
      id: s.id,
      name: s.name,
      position: s.position,
      kind: s.kind,
    })),
    leads: leads.map((r) => ({
      id: r.lead.id,
      stageId: r.lead.stageId,
      position: r.lead.position,
      lastActivityAt: r.lead.lastActivityAt?.toISOString() ?? null,
      contact: {
        id: r.contact.id,
        name: r.contact.name,
        phone: r.contact.phone,
      },
      conversationId: r.conversationId,
      numberLabel: r.number ? numberLabel(r.number) : null,
    })),
  });
});
