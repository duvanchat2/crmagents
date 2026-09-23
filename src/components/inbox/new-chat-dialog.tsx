"use client";

import { useEffect, useState } from "react";
import { Clock3, X } from "lucide-react";
import type { ContactDto, ConversationDto } from "@/lib/types";
import { cn } from "@/lib/utils";
import { Button } from "@/components/ui/button";
import { Input } from "@/components/ui/input";
import { Label } from "@/components/ui/label";

export type InboxNumber = {
  phoneNumberId: string;
  label: string;
  displayPhoneNumber: string | null;
  wabaId: string;
  isDefault: boolean;
  /** Motivo por el que no se puede enviar por este número (null = listo). */
  problem: string | null;
};

/**
 * Chat nuevo (D9): el número predeterminado viene preseleccionado y se puede
 * cambiar. Sin un mensaje del cliente la ventana de 24 h está cerrada, así que
 * la conversación se abre en modo "solo plantilla" (lo exige también el server).
 */
export function NewChatDialog({
  numbers,
  onClose,
  onCreated,
}: {
  /** null = todavía cargando. */
  numbers: InboxNumber[] | null;
  onClose: () => void;
  onCreated: (conversation: ConversationDto) => void;
}) {
  const loadingNumbers = numbers === null;
  const all = numbers ?? [];
  const usable = all.filter((n) => !n.problem);
  const initial = usable.find((n) => n.isDefault) ?? usable[0] ?? null;
  const [phoneNumberId, setPhoneNumberId] = useState(initial?.phoneNumberId ?? "");
  // Si el diálogo se abrió antes de que llegaran los números, adopta el
  // predeterminado en cuanto llegan (el <select> no debe mostrar un valor que
  // el estado no tiene).
  useEffect(() => {
    if (!phoneNumberId && initial) setPhoneNumberId(initial.phoneNumberId);
  }, [phoneNumberId, initial]);
  const [mode, setMode] = useState<"existing" | "new">("existing");
  const [query, setQuery] = useState("");
  // null = buscando (no mostrar "Sin resultados" antes de la primera respuesta)
  const [contacts, setContacts] = useState<ContactDto[] | null>(null);
  const [contactId, setContactId] = useState<string | null>(null);
  const [phone, setPhone] = useState("");
  const [name, setName] = useState("");
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  useEffect(() => {
    if (mode !== "existing") return;
    let cancelled = false;
    const q = query.trim();
    const t = setTimeout(() => {
      fetch(`/api/contacts${q ? `?q=${encodeURIComponent(q)}` : ""}`)
        .then((r) => (r.ok ? r.json() : { contacts: [] }))
        .then((d: { contacts?: ContactDto[] }) => {
          if (!cancelled) setContacts((d.contacts ?? []).slice(0, 8));
        })
        .catch(() => {
          if (!cancelled) setContacts([]);
        });
    }, 200);
    return () => {
      cancelled = true;
      clearTimeout(t);
    };
  }, [query, mode]);

  const canSubmit =
    Boolean(phoneNumberId) &&
    (mode === "existing" ? Boolean(contactId) : phone.trim().length > 0);

  async function submit() {
    if (!canSubmit || saving) return;
    setSaving(true);
    setError(null);
    const res = await fetch("/api/conversations", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify(
        mode === "existing"
          ? { phoneNumberId, contactId }
          : { phoneNumberId, phone, name: name.trim() || undefined }
      ),
    }).catch(() => null);
    setSaving(false);
    if (!res) {
      setError("Sin conexión con el servidor");
      return;
    }
    const data = (await res.json().catch(() => null)) as {
      conversation?: ConversationDto;
      error?: { message?: string };
    } | null;
    if (!res.ok || !data?.conversation) {
      setError(data?.error?.message ?? "No se pudo crear la conversación");
      return;
    }
    onCreated(data.conversation);
  }

  return (
    <div
      className="fixed inset-0 z-50 flex items-center justify-center bg-black/30 p-4"
      role="dialog"
      aria-modal="true"
      aria-label="Nueva conversación"
      onClick={onClose}
    >
      <div
        className="w-full max-w-md rounded-lg border bg-background p-5 shadow-lg"
        onClick={(e) => e.stopPropagation()}
      >
        <div className="mb-4 flex items-center justify-between">
          <h2 className="text-[15px] font-[650]">Nueva conversación</h2>
          <button
            onClick={onClose}
            aria-label="Cerrar"
            className="rounded-sm p-1 text-text-3 hover:bg-accent hover:text-foreground"
          >
            <X className="h-4 w-4" strokeWidth={1.7} />
          </button>
        </div>

        {loadingNumbers ? (
          <p className="text-sm text-text-3">Cargando números…</p>
        ) : usable.length === 0 ? (
          <p className="text-sm text-text-3">
            No hay un número de WhatsApp listo para enviar. Conéctalo en{" "}
            <a href="/settings/whatsapp" className="text-primary hover:underline">
              Configuración → WhatsApp
            </a>
            .
          </p>
        ) : (
          <div className="space-y-4">
            <div className="space-y-1.5">
              <Label htmlFor="new-chat-number">Enviar desde</Label>
              <select
                id="new-chat-number"
                value={phoneNumberId}
                onChange={(e) => setPhoneNumberId(e.target.value)}
                className="flex h-9 w-full rounded-md border border-input bg-card px-3 py-1 text-sm focus-visible:outline-none focus-visible:ring-1 focus-visible:ring-ring"
              >
                {all.map((n) => (
                  <option key={n.phoneNumberId} value={n.phoneNumberId} disabled={Boolean(n.problem)}>
                    {n.label}
                    {n.displayPhoneNumber && n.displayPhoneNumber !== n.label
                      ? ` · ${n.displayPhoneNumber}`
                      : ""}
                    {n.isDefault ? " (predeterminado)" : ""}
                  </option>
                ))}
              </select>
            </div>

            <div className="flex gap-1.5">
              {(
                [
                  { id: "existing", label: "Contacto existente" },
                  { id: "new", label: "Teléfono nuevo" },
                ] as const
              ).map((m) => (
                <button
                  key={m.id}
                  onClick={() => setMode(m.id)}
                  className={cn(
                    "rounded-full border px-3 py-[5px] text-[12.5px] font-medium transition-colors",
                    mode === m.id
                      ? "border-brand bg-brand text-white"
                      : "bg-background text-text-2 hover:bg-accent"
                  )}
                >
                  {m.label}
                </button>
              ))}
            </div>

            {mode === "existing" ? (
              <div className="space-y-1.5">
                <Label htmlFor="new-chat-search">Contacto</Label>
                <Input
                  id="new-chat-search"
                  placeholder="Buscar por nombre o teléfono…"
                  value={query}
                  onChange={(e) => {
                    setQuery(e.target.value);
                    setContactId(null);
                  }}
                />
                <ul className="max-h-44 overflow-y-auto rounded-md border">
                  {contacts === null ? (
                    <li className="px-3 py-2 text-xs text-text-3">Buscando…</li>
                  ) : contacts.length === 0 ? (
                    <li className="px-3 py-2 text-xs text-text-3">Sin resultados</li>
                  ) : (
                    contacts.map((c) => (
                      <li key={c.id}>
                        <button
                          onClick={() => setContactId(c.id)}
                          className={cn(
                            "flex w-full justify-between px-3 py-2 text-left text-sm hover:bg-subtle",
                            contactId === c.id && "bg-[var(--bg-active)] font-medium"
                          )}
                        >
                          <span className="truncate">{c.name}</span>
                          <span className="text-xs text-text-3">+{c.phone}</span>
                        </button>
                      </li>
                    ))
                  )}
                </ul>
              </div>
            ) : (
              <div className="grid gap-3">
                <div className="space-y-1.5">
                  <Label htmlFor="new-chat-phone">Teléfono (con código de país)</Label>
                  <Input
                    id="new-chat-phone"
                    placeholder="+57 300 123 4567"
                    value={phone}
                    onChange={(e) => setPhone(e.target.value)}
                  />
                </div>
                <div className="space-y-1.5">
                  <Label htmlFor="new-chat-name">Nombre (opcional)</Label>
                  <Input
                    id="new-chat-name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                  />
                </div>
              </div>
            )}

            <p className="flex items-start gap-2 rounded-md border border-[#ece2cf] bg-[#faf7f0] p-2.5 text-xs text-[#8a6d3b]">
              <Clock3 className="mt-0.5 h-3.5 w-3.5 shrink-0" strokeWidth={1.7} />
              Sin un mensaje del cliente en las últimas 24 horas, WhatsApp solo
              permite iniciar con una plantilla aprobada.
            </p>

            {error && <p className="text-xs text-destructive">{error}</p>}

            <div className="flex justify-end gap-2">
              <Button variant="outline" onClick={onClose}>
                Cancelar
              </Button>
              <Button disabled={!canSubmit || saving} onClick={() => void submit()}>
                {saving ? "Abriendo…" : "Abrir conversación"}
              </Button>
            </div>
          </div>
        )}
      </div>
    </div>
  );
}
