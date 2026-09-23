import { desc, ilike, inArray, or } from "drizzle-orm";
import { normalizePhone, phoneLookupVariants } from "@/lib/phone";
import { z } from "zod";
import { apiError, parseBody, withAuth } from "@/lib/api";
import { getDb, schema } from "@/lib/db";
import { newId } from "@/lib/db/ids";
import { scoped } from "@/lib/db/tenant";
import { serializeContact } from "@/server/contacts";

export const dynamic = "force-dynamic";

export const GET = withAuth(async (session, req: Request) => {
  const url = new URL(req.url);
  const q = url.searchParams.get("q")?.trim();
  const includeArchived = url.searchParams.get("archived") === "true";

  const db = getDb();
  const rows = await db
    .select()
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        session.organizationId,
        q
          ? or(
              ilike(schema.contact.name, `%${q}%`),
              ilike(schema.contact.phone, `%${q}%`)
            )
          : undefined
      )
    )
    .orderBy(desc(schema.contact.updatedAt))
    .limit(200);

  const contacts = rows
    .filter((c) => includeArchived || !c.archivedAt)
    .map(serializeContact);
  return Response.json({ contacts });
});

const createSchema = z.object({
  name: z.string().trim().min(1).max(120),
  phone: z
    .string()
    .trim()
    .refine((v) => normalizePhone(v) !== null, {
      message: "Teléfono con código de país (ej. +57 300 123 4567 o 5215512345678)",
    }),
  notes: z.string().max(4000).optional(),
});

export const POST = withAuth(async (session, req: Request) => {
  const body = await parseBody(req, createSchema);
  if (!body.ok) return body.response;

  const db = getDb();
  // Normalizador único: el mismo teléfono en otro formato (o la forma legada
  // 521 de México) es el mismo contacto.
  const phone = normalizePhone(body.data.phone)!;
  const dup = await db
    .select({ id: schema.contact.id })
    .from(schema.contact)
    .where(
      scoped(
        schema.contact.organizationId,
        session.organizationId,
        inArray(schema.contact.phone, phoneLookupVariants(phone))
      )
    )
    .limit(1);
  if (dup[0]) {
    return apiError(409, "duplicate", "Ya existe un contacto con ese teléfono");
  }
  const inserted = await db
    .insert(schema.contact)
    .values({
      id: newId("contact"),
      organizationId: session.organizationId,
      name: body.data.name,
      phone,
      notes: body.data.notes ?? null,
    })
    .onConflictDoNothing({
      target: [schema.contact.organizationId, schema.contact.phone],
    })
    .returning();
  if (!inserted[0]) {
    return apiError(409, "duplicate", "Ya existe un contacto con ese teléfono");
  }
  return Response.json(
    { contact: serializeContact(inserted[0]) },
    { status: 201 }
  );
});
