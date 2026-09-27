import type { AgentTranscriptSource } from "./ports/external.js";
import type { Binding, HerdrAgentSession } from "./types.js";

/**
 * Stable in-process cache identity for a binding's exact transcript source.
 * Length-prefixed fields avoid ambiguity if a future session value contains a
 * conventional separator such as `:`.
 */
export function transcriptObserverIdentity(binding: Pick<Binding, "id" | "agentKind" | "generation" | "paneId" | "agentSessionSource" | "agentSessionAgent" | "agentSessionKind" | "agentSessionValue">): string | null {
  if (!binding.id || !binding.agentKind || !binding.paneId) return null;
  const source = transcriptSourceFor(binding);
  const session = source.nativeSession;
  return [binding.id, binding.agentKind, String(binding.generation), binding.paneId, session?.source ?? "", session?.agent ?? "", session?.kind ?? "", session?.value ?? ""]
    .map((field) => `${field.length}:${field}`)
    .join("");
}

export function transcriptSourceFor(binding: Pick<Binding, "id" | "agentKind" | "generation" | "paneId" | "agentSessionSource" | "agentSessionAgent" | "agentSessionKind" | "agentSessionValue">): AgentTranscriptSource {
  return { agentKind: binding.agentKind, bindingId: binding.id, generation: binding.generation, paneId: binding.paneId, nativeSession: nativeSessionFor(binding) };
}

function nativeSessionFor(binding: Pick<Binding, "agentSessionSource" | "agentSessionAgent" | "agentSessionKind" | "agentSessionValue">): HerdrAgentSession | null {
  if (!binding.agentSessionSource || !binding.agentSessionAgent || !binding.agentSessionKind || !binding.agentSessionValue) return null;
  return { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue };
}
