"use client";

import { useEffect, useState } from "react";
import type { TemplateDto } from "@/lib/types";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

/**
 * Selector de plantilla aprobada para conversaciones con ventana cerrada
 * (FR-005/FR-051). Sin plantillas aprobadas muestra el estado vacío.
 */
/** Una plantilla sirve para un número si es de su WABA (o es legada sin WABA). */
export function templateFitsWaba(t: TemplateDto, wabaId: string | null): boolean {
  return !t.wabaId || !wabaId || t.wabaId === wabaId;
}

export function TemplateSender({
  conversationId,
  wabaId,
  onSent,
}: {
  conversationId: string;
  /** WABA del número de la conversación (F2): filtra las plantillas. */
  wabaId: string | null;
  onSent: () => void;
}) {
  const [templates, setTemplates] = useState<TemplateDto[] | null>(null);
  const [selectedId, setSelectedId] = useState<string>("");
  const [variable, setVariable] = useState("");
  const [sending, setSending] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    fetch("/api/templates")
      .then((r) => (r.ok ? r.json() : { templates: [] }))
      .then((d: { templates?: TemplateDto[] }) => {
        if (!cancelled) {
          setTemplates(
            (d.templates ?? []).filter(
              (t) => t.status === "approved" && templateFitsWaba(t, wabaId)
            )
          );
        }
      })
      .catch(() => {
        if (!cancelled) setTemplates([]);
      });
    return () => {
      cancelled = true;
    };
  }, [wabaId]);

  if (templates === null) {
    return <p className="text-xs text-muted-foreground">Cargando plantillas…</p>;
  }

  if (templates.length === 0) {
    return (
      <p className="text-sm text-muted-foreground">
        Aún no hay plantillas aprobadas. Créalas en{" "}
        <a href="/settings/templates" className="text-primary hover:underline">
          Configuración → Plantillas
        </a>{" "}
        y espera la aprobación de Meta.
      </p>
    );
  }

  const selected = templates.find((t) => t.id === selectedId) ?? null;
  const needsVariable = selected ? /\{\{\s*1\s*\}\}/.test(selected.body) : false;

  async function send() {
    if (!selected || sending) return;
    setSending(true);
    setError(null);
    const res = await fetch(
      `/api/conversations/${conversationId}/messages/template`,
      {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({
          templateId: selected.id,
          variable: needsVariable ? variable : undefined,
        }),
      }
    );
    setSending(false);
    if (!res.ok) {
      const data = (await res.json().catch(() => null)) as {
        error?: { message?: string };
      } | null;
      setError(data?.error?.message ?? "No se pudo enviar la plantilla");
      return;
    }
    setSelectedId("");
    setVariable("");
    onSent();
  }

  return (
    <div className="space-y-3">
      <div className="space-y-1.5">
        <Label htmlFor="template-select">Plantilla aprobada</Label>
        <select
          id="template-select"
          value={selectedId}
          onChange={(e) => setSelectedId(e.target.value)}
          className="flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
        >
          <option value="">Elige una plantilla…</option>
          {templates.map((t) => (
            <option key={t.id} value={t.id}>
              {t.name} ({t.language})
            </option>
          ))}
        </select>
      </div>
      {selected && (
        <p className="rounded-md bg-secondary/60 p-2.5 text-xs text-muted-foreground">
          {selected.body}
        </p>
      )}
      {needsVariable && (
        <div className="space-y-1.5">
          <Label htmlFor="template-variable">Valor de la variable {"{{1}}"}</Label>
          <Input
            id="template-variable"
            value={variable}
            onChange={(e) => setVariable(e.target.value)}
            placeholder="p. ej. el nombre del cliente"
          />
        </div>
      )}
      {error && <p className="text-xs text-destructive">{error}</p>}
      <Button
        onClick={() => void send()}
        disabled={!selected || sending || (needsVariable && !variable.trim())}
      >
        {sending ? "Enviando…" : "Enviar plantilla"}
      </Button>
    </div>
  );
}
