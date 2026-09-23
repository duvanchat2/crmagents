import { scheduleAgentTurn } from "@/server/ai/pipeline";
import { getAgentEngine, isAiConfigured } from "@/lib/env";

/**
 * Punto de enganche del turno del agente tras la ingesta de un mensaje
 * entrante REAL (las conversaciones del Laboratorio invocan el pipeline
 * directamente, sin debounce).
 */
export async function maybeRunAgentTurn(
  conversationId: string
): Promise<void> {
  if (!isAiConfigured()) return;
  // Con Hermes (Kapso) como cerebro, el agente interno NUNCA responde en
  // conversaciones reales: garantía de un solo agente (Constitución II).
  if (getAgentEngine() === "hermes") return;
  scheduleAgentTurn(conversationId);
}
