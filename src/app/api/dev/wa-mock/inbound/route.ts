import { z } from "zod";
import { mockGuard } from "@/lib/dev-guard";
import { apiError, parseBody } from "@/lib/api";
import { getCredentialsByPhoneNumberId } from "@/server/whatsapp/credentials";
import {
  buildInboundPayload,
  deliverToWebhook,
} from "@/server/dev/wa-mock-inbound";

export const dynamic = "force-dynamic";

const schema = z.object({
  phoneNumberId: z.string().min(1),
  from: z.string().min(5),
  name: z.string().optional(),
  type: z.string().optional(),
  text: z.string().optional(),
  waMessageId: z.string().optional(),
  waUserId: z.string().optional(),
  timestamp: z.number().optional(),
});

export async function POST(req: Request) {
  const guard = mockGuard();
  if (guard) return guard;

  const body = await parseBody(req, schema);
  if (!body.ok) return body.response;

  const creds = await getCredentialsByPhoneNumberId(body.data.phoneNumberId);
  const payload = buildInboundPayload({
    ...body.data,
    wabaId: creds?.wabaId ?? "WABA-MOCK",
  });
  const res = await deliverToWebhook(payload);
  if (!res.ok) {
    return apiError(
      502,
      "webhook_error",
      `El webhook respondió ${res.status}`
    );
  }
  return Response.json({ delivered: true });
}
