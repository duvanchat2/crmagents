"use client";

import { useCallback, useEffect, useRef, useState } from "react";
import { useSearchParams } from "next/navigation";
import { PanelRight } from "lucide-react";
import { cn } from "@/lib/utils";
import { ContactAvatar } from "@/components/avatar";
import type { ConversationDto, MessageDto } from "@/lib/types";
import { useEvents } from "@/components/use-events";
import { ConversationList } from "./conversation-list";
import { MessageThread } from "./message-thread";
import { Composer } from "./composer";
import { ContactPanel } from "./contact-panel";
import { NewChatDialog, type InboxNumber } from "./new-chat-dialog";

export function InboxClient() {
  const [conversations, setConversations] = useState<ConversationDto[] | null>(
    null
  );
  const [selectedId, setSelectedId] = useState<string | null>(null);
  const [messages, setMessages] = useState<MessageDto[]>([]);
  const [panelOpen, setPanelOpen] = useState(true);
  // null = cargando (el diálogo de chat nuevo espera el predeterminado).
  const [numbers, setNumbers] = useState<InboxNumber[] | null>(null);
  const [newChatOpen, setNewChatOpen] = useState(false);
  // Se incrementa con cada evento SSE que puede cambiar la etapa/lead o el
  // estado del agente: el panel de detalles lo observa y refetch en vivo.
  const [detailRev, setDetailRev] = useState(0);

  useEffect(() => {
    setPanelOpen(localStorage.getItem("vocero.panelOpen") !== "false");
  }, []);
  const togglePanel = useCallback((open: boolean) => {
    setPanelOpen(open);
    localStorage.setItem("vocero.panelOpen", String(open));
  }, []);
  const selectedIdRef = useRef<string | null>(null);
  selectedIdRef.current = selectedId;
  const lastFetchRef = useRef<string | null>(null);

  const refetchConversations = useCallback(async () => {
    const res = await fetch("/api/conversations").catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { conversations: ConversationDto[] };
    setConversations(data.conversations);
    lastFetchRef.current = new Date().toISOString();
  }, []);

  const refetchMessages = useCallback(async (conversationId: string) => {
    const res = await fetch(
      `/api/conversations/${conversationId}/messages`
    ).catch(() => null);
    if (!res?.ok) return;
    const data = (await res.json()) as { messages: MessageDto[] };
    if (selectedIdRef.current === conversationId) setMessages(data.messages);
  }, []);

  useEffect(() => {
    void refetchConversations();
  }, [refetchConversations]);

  // Números activos de la organización (F2): filtro, etiqueta y chat nuevo.
  useEffect(() => {
    fetch("/api/numbers")
      .then((r) => (r.ok ? r.json() : { numbers: [] }))
      .then((d: { numbers?: InboxNumber[] }) => setNumbers(d.numbers ?? []))
      .catch(() => setNumbers([]));
  }, []);

  const select = useCallback(
    (id: string) => {
      setSelectedId(id);
      setMessages([]);
      void refetchMessages(id);
      void fetch(`/api/conversations/${id}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ markRead: true }),
      });
    },
    [refetchMessages]
  );

  // Enlace directo desde Pipeline (/inbox?conversation=<id>, exacto: un lead
  // por número) o Contactos (/inbox?contact=<id>, su conversación más reciente).
  const searchParams = useSearchParams();
  const contactParam = searchParams.get("contact");
  const conversationParam = searchParams.get("conversation");
  useEffect(() => {
    if (selectedIdRef.current) return;
    const match = conversationParam
      ? conversations?.find((c) => c.id === conversationParam)
      : contactParam
        ? conversations?.find((c) => c.contact.id === contactParam)
        : undefined;
    if (match) select(match.id);
  }, [contactParam, conversationParam, conversations, select]);

  useEvents({
    onMessageNew: ({ conversationId, message }) => {
      if (selectedIdRef.current === conversationId) {
        const m = message as MessageDto;
        setMessages((prev) =>
          prev.some((x) => x.id === m.id) ? prev : [...prev, m]
        );
        void fetch(`/api/conversations/${conversationId}`, {
          method: "PATCH",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ markRead: true }),
        });
      }
      void refetchConversations();
      // Un entrante nuevo puede crear/mover el lead: refresca el panel.
      setDetailRev((v) => v + 1);
    },
    onMessageStatus: ({ conversationId, messageId, status }) => {
      if (selectedIdRef.current !== conversationId) return;
      setMessages((prev) =>
        prev.map((m) =>
          m.id === messageId ? { ...m, status: status as MessageDto["status"] } : m
        )
      );
    },
    onConversationUpdated: () => {
      void refetchConversations();
      // El agente movió de etapa o cambió el handoff: refresca el panel en vivo.
      setDetailRev((v) => v + 1);
    },
    onReconnect: () => {
      // Catch-up tras reconexión (contrato sse.md): refetch completo.
      void refetchConversations();
      if (selectedIdRef.current) void refetchMessages(selectedIdRef.current);
      setDetailRev((v) => v + 1);
    },
  });

  const selected = conversations?.find((c) => c.id === selectedId) ?? null;

  const sendText = useCallback(
    async (text: string): Promise<string | null> => {
      if (!selectedIdRef.current) return "Sin conversación seleccionada";
      const res = await fetch(
        `/api/conversations/${selectedIdRef.current}/messages`,
        {
          method: "POST",
          headers: { "content-type": "application/json" },
          body: JSON.stringify({ text }),
        }
      ).catch(() => null);
      if (!res) return "Sin conexión con el servidor";
      if (!res.ok) {
        const data = (await res.json().catch(() => null)) as {
          error?: { message?: string };
        } | null;
        return data?.error?.message ?? "No se pudo enviar el mensaje";
      }
      if (selectedIdRef.current) void refetchMessages(selectedIdRef.current);
      void refetchConversations();
      return null;
    },
    [refetchMessages, refetchConversations]
  );

  const patchConversation = useCallback(
    async (patch: { aiEnabled?: boolean; reactivate?: boolean }) => {
      if (!selectedIdRef.current) return;
      await fetch(`/api/conversations/${selectedIdRef.current}`, {
        method: "PATCH",
        headers: { "content-type": "application/json" },
        body: JSON.stringify(patch),
      }).catch(() => null);
      void refetchConversations();
    },
    [refetchConversations]
  );

  return (
    <div className="flex h-full">
      {newChatOpen && (
        <NewChatDialog
          numbers={numbers}
          onClose={() => setNewChatOpen(false)}
          onCreated={(conversation) => {
            setNewChatOpen(false);
            setConversations((prev) =>
              prev?.some((c) => c.id === conversation.id)
                ? prev
                : [conversation, ...(prev ?? [])]
            );
            select(conversation.id);
            void refetchConversations();
          }}
        />
      )}
      <section className="w-[360px] shrink-0 overflow-hidden border-r">
        <ConversationList
          conversations={conversations}
          numbers={numbers ?? []}
          selectedId={selectedId}
          onSelect={select}
          onSeeded={() => void refetchConversations()}
          onNewChat={() => setNewChatOpen(true)}
        />
      </section>

      <section className="flex min-w-0 flex-1 flex-col">
        {selected ? (
          <>
            <header className="flex items-center justify-between border-b bg-background px-4 py-2.5">
              <div className="flex items-center gap-3">
                <ContactAvatar
                  name={selected.contact.name}
                  seed={selected.contact.id}
                  size="md"
                />
                <div>
                  <p className="text-[15px] font-[650] leading-tight">
                    {selected.contact.name}
                  </p>
                  <p
                    className={
                      selected.windowOpen
                        ? "text-xs font-medium text-success"
                        : "text-xs text-text-3"
                    }
                  >
                    {selected.windowOpen
                      ? "ventana abierta"
                      : `+${selected.contact.phone}`}
                    {selected.number && (
                      <span className="text-text-3" data-testid="thread-number">
                        {" · vía "}
                        {selected.number.label}
                      </span>
                    )}
                  </p>
                </div>
              </div>
              {!panelOpen && (
                <button
                  onClick={() => togglePanel(true)}
                  aria-label="Mostrar detalles"
                  className="rounded-sm border p-1.5 text-text-3 hover:bg-accent hover:text-foreground"
                >
                  <PanelRight className="h-4 w-4" strokeWidth={1.7} />
                </button>
              )}
            </header>
            <MessageThread messages={messages} />
            <Composer
              conversation={selected}
              onSend={sendText}
              onSent={() => {
                if (selectedIdRef.current)
                  void refetchMessages(selectedIdRef.current);
                void refetchConversations();
              }}
            />
          </>
        ) : (
          <div className="flex flex-1 items-center justify-center bg-chat text-sm text-text-3">
            Elige una conversación para ver el hilo
          </div>
        )}
      </section>

      <section
        className={cn(
          "shrink-0 overflow-hidden border-l transition-[width] duration-[220ms]",
          panelOpen && selected ? "w-[320px]" : "w-0 border-l-0"
        )}
      >
        {selected && (
          <div className="h-full w-[320px]">
            <ContactPanel
              conversation={selected}
              refreshKey={detailRev}
              onPatchConversation={patchConversation}
              onClose={() => togglePanel(false)}
            />
          </div>
        )}
      </section>
    </div>
  );
}
