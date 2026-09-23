import { createHmac } from "node:crypto";
import { getEnv } from "@/lib/env";
import { mockWamid, nextN } from "@/server/dev/wa-mock-state";

/**
 * Construye un payload real de Meta y lo entrega al webhook público por
 * loopback (127.0.0.1: mismo proceso, sin salir a la red). Se firma con el
 * META_APP_SECRET real si está configurado — así el self-test ejercita la
 * capa 2 de verdad.
 */
export async function deliverToWebhook(payload: unknown): Promise<Response> {
  const env = getEnv();
  const raw = JSON.stringify(payload);
  const port = process.env.PORT ?? "3000";
  const url = `http://127.0.0.1:${port}/api/webhooks/wa/${env.META_WEBHOOK_VERIFY_TOKEN}`;

  const headers: Record<string, string> = {
    "content-type": "application/json",
  };
  if (env.META_APP_SECRET) {
    const sig = createHmac("sha256", env.META_APP_SECRET)
      .update(raw, "utf8")
      .digest("hex");
    headers["x-hub-signature-256"] = `sha256=${sig}`;
  }
  return fetch(url, { method: "POST", headers, body: raw });
}

export function buildInboundPayload(input: {
  wabaId: string;
  phoneNumberId: string;
  from: string;
  name?: string;
  type?: string;
  text?: string;
  waMessageId?: string;
  timestamp?: number;
}) {
  const type = input.type ?? "text";
  const message: Record<string, unknown> = {
    from: input.from,
    id: input.waMessageId ?? mockWamid("in", nextN()),
    timestamp: String(input.timestamp ?? Math.floor(Date.now() / 1000)),
    type,
  };
  if (type === "text") message.text = { body: input.text ?? "hola" };

  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: input.wabaId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "5215500000000",
                phone_number_id: input.phoneNumberId,
              },
              contacts: [
                {
                  profile: { name: input.name ?? "Cliente" },
                  wa_id: input.from,
                },
              ],
              messages: [message],
            },
          },
        ],
      },
    ],
  };
}

export function buildStatusPayload(input: {
  wabaId: string;
  phoneNumberId: string;
  waMessageId: string;
  status: string;
  recipientId?: string;
}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: input.wabaId,
        changes: [
          {
            field: "messages",
            value: {
              messaging_product: "whatsapp",
              metadata: {
                display_phone_number: "5215500000000",
                phone_number_id: input.phoneNumberId,
              },
              statuses: [
                {
                  id: input.waMessageId,
                  status: input.status,
                  timestamp: String(Math.floor(Date.now() / 1000)),
                  recipient_id: input.recipientId ?? "5215511111111",
                },
              ],
            },
          },
        ],
      },
    ],
  };
}

export function buildTemplateStatusPayload(input: {
  wabaId: string;
  name: string;
  language: string;
  event: "APPROVED" | "REJECTED";
  reason?: string;
  templateId?: string;
}) {
  return {
    object: "whatsapp_business_account",
    entry: [
      {
        id: input.wabaId,
        changes: [
          {
            field: "message_template_status_update",
            value: {
              event: input.event,
              message_template_id: input.templateId ?? `tplmock_${nextN()}`,
              message_template_name: input.name,
              message_template_language: input.language,
              reason: input.reason ?? null,
            },
          },
        ],
      },
    ],
  };
}
