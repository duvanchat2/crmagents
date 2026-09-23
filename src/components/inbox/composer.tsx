"use client";

import { useEffect, useRef, useState } from "react";
import { Clock3, Send } from "lucide-react";
import type { ConversationDto, TemplateDto } from "@/lib/types";
import { cn } from "@/lib/utils";
import { formatRemaining } from "./helpers";
import { TemplateSender, templateFitsWaba } from "./template-sender";

export function Composer({
  conversation,
  onSend,
  onSent,
}: {
  conversation: ConversationDto;
  onSend: (text: string) => Promise<string | null>;
  onSent: () => void;
}) {
  const [text, setText] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [templates, setTemplates] = useState<TemplateDto[]>([]);
  const taRef = useRef<HTMLTextAreaElement>(null);
  // F2: las plantillas son por WABA; solo las del número de esta conversación.
  const wabaId = conversation.number?.wabaId ?? null;

  useEffect(() => {
    let cancelled = false;
    fetch("/api/templates")
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((d: { templates?: TemplateDto[] }) => {
        if (!cancelled)
          setTemplates(
            (d.templates ?? []).filter(
              (t) => t.status === "approved" && templateFitsWaba(t, wabaId)
            )
          );
      })
      .catch(() => {});
    return () => {
      cancelled = true;
    };
  }, [wabaId]);

  function autogrow() {
    const el = taRef.current;
    if (!el) return;
    el.style.height = "auto";
    el.style.height = `${Math.min(el.scrollHeight, 120)}px`;
  }

  async function submit() {
    const value = text.trim();
    if (!value || sending) return;
    setSending(true);
    setError(null);
    const err = await onSend(value);
    setSending(false);
    if (err) {
      setError(err);
      return;
    }
    setText("");
    if (taRef.current) taRef.current.style.height = "auto";
  }

  if (!conversation.windowOpen) {
    return (
      <div className="border-t bg-background px-[18px] py-3.5">
        <div className="mb-3 flex items-start gap-2 rounded-md border border-[#ece2cf] bg-[#faf7f0] p-3 text-sm text-[#8a6d3b]">
          <Clock3 className="mt-0.5 h-4 w-4 shrink-0" strokeWidth={1.7} />
          <div>
            <p className="font-medium">La ventana de 24 horas está cerrada.</p>
            <p className="opacity-80">
              WhatsApp solo permite texto libre dentro de las 24 horas
              siguientes al último mensaje del cliente. Para retomar la
              conversación, envía una plantilla aprobada.
            </p>
          </div>
        </div>
        <TemplateSender
          conversationId={conversation.id}
          wabaId={wabaId}
          onSent={onSent}
        />
      </div>
    );
  }

  return (
    <div className="border-t bg-background px-[18px] pb-3.5 pt-3">
      {templates.length > 0 && (
        <div className="mb-2.5 flex flex-wrap gap-1.5">
          {templates.slice(0, 4).map((t) => (
            <button
              key={t.id}
              className="rounded-full border bg-secondary px-3 py-1 text-xs font-medium text-text-2 transition-colors hover:border-brand-soft hover:bg-brand-tint hover:text-brand-text"
              onClick={() => {
                const firstName = conversation.contact.name.split(" ")[0] ?? "";
                setText(t.body.replace(/\{\{\s*1\s*\}\}/g, firstName));
                taRef.current?.focus();
                setTimeout(autogrow, 0);
              }}
              title={t.body}
            >
              {t.name.replace(/_/g, " ")}
            </button>
          ))}
        </div>
      )}
      <div className="flex items-end gap-2 rounded-md border bg-background px-3 py-2 transition-shadow focus-within:border-brand focus-within:ring-[3px] focus-within:ring-brand-soft">
        <textarea
          ref={taRef}
          placeholder="Escribe una respuesta…"
          value={text}
          rows={1}
          onChange={(e) => {
            setText(e.target.value);
            autogrow();
          }}
          onKeyDown={(e) => {
            if (e.key === "Enter" && !e.shiftKey) {
              e.preventDefault();
              void submit();
            }
          }}
          className="max-h-[120px] w-full resize-none bg-transparent text-sm leading-relaxed outline-none placeholder:text-text-3"
        />
        <button
          onClick={() => void submit()}
          disabled={sending || text.trim().length === 0}
          aria-label="Enviar"
          className={cn(
            "flex h-[34px] w-[34px] shrink-0 items-center justify-center rounded-[9px] bg-brand text-white transition-opacity hover:bg-brand-hover",
            (sending || !text.trim()) && "opacity-40"
          )}
        >
          <Send className="h-4 w-4" strokeWidth={1.7} />
        </button>
      </div>
      <div className="mt-1.5 flex items-center justify-between">
        {error ? <p className="text-xs text-destructive">{error}</p> : <span />}
        <p className="text-[11px] text-text-3">
          Ventana abierta · quedan {formatRemaining(conversation.windowRemainingMs)}
        </p>
      </div>
    </div>
  );
}
