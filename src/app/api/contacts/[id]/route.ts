import { eq } from "drizzle-orm";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { scoped } from "@/lib/db/tenant";
import {
  getContactById,
  getContactStage,
  serializeContact,
} from "@/server/contacts";

export const dynamic = "force-dynamic";

type Params = { params: Promise<{ id: string }> };

export const GET = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const contact = await getContactById(session.organizationId, id);
  if (!contact) return apiError(404, "not_found", "Contacto no encontrado");
  const conversationId = new URL(req.url).searchParams.get("conversationId");
  const stageRow = await getContactStage(session.organizationId, id, conversationId);
  return Response.json({
    contact: serializeContact(contact),
    stage: stageRow
      ? {
          id: stageRow.stage.id,
          name: stageRow.stage.name,
          position: stageRow.stage.position,
          kind: stageRow.stage.kind,
        }
      : null,
    lead: stageRow ? { id: stageRow.lead.id } : null,
  });
});

const patchSchema = z.object({
  name: z.string().trim().min(1).max(120).optional(),
  notes: z.string().max(4000).nullable().optional(),
  archived: z.boolean().optional(),
});

export const PATCH = withAuth(async (session, req: Request, ctx: Params) => {
  const { id } = await ctx.params;
  const body = await parseBody(req, patchSchema);
  if (!body.ok) return body.response;

  const set: Record<string, unknown> = { updatedAt: new Date() };
  if (body.data.name !== undefined) set.name = body.data.name;
  if (body.data.notes !== undefined) set.notes = body.data.notes;
  if (body.data.archived !== undefined) {
    set.archivedAt = body.data.archived ? new Date() : null;
  }

  const db = getDb();
  const updated = await db
    .update(schema.contact)
    .set(set)
    .where(
      scoped(
        schema.contact.organizationId,
        session.organizationId,
        eq(schema.contact.id, id)
      )
    )
    .returning();
  if (!updated[0]) return apiError(404, "not_found", "Contacto no encontrado");
  return Response.json({ contact: serializeContact(updated[0]) });
});
