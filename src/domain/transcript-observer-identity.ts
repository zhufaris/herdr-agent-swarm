import type { AgentTranscriptSource } from "./ports/external.js";
import type { Binding, HerdrAgentSession } from "./types.js";

/**
 * Stable in-process cache identity for a binding's exact transcript source.
 * Length-prefixed fields avoid ambiguity if a future session value contains a
 * conventional separator such as `:`.
 */
export function transcriptObserverIdentity(binding: Pick<Binding, "id" | "agentKind" | "generation" | "sessionEpoch" | "workspaceId" | "paneId" | "agentSessionSource" | "agentSessionAgent" | "agentSessionKind" | "agentSessionValue">): string | null {
  if (!binding.id || !binding.agentKind || !binding.paneId) return null;
  const source = transcriptSourceFor(binding);
  const session = source.nativeSession;
  return [binding.id, binding.agentKind, String(binding.generation), String(binding.sessionEpoch ?? ""), binding.workspaceId ?? "", binding.paneId, session?.source ?? "", session?.agent ?? "", session?.kind ?? "", session?.value ?? ""]
    .map((field) => `${field.length}:${field}`)
    .join("");
}

export function transcriptSourceFor(binding: Pick<Binding, "id" | "agentKind" | "generation" | "sessionEpoch" | "workspaceId" | "paneId" | "agentSessionSource" | "agentSessionAgent" | "agentSessionKind" | "agentSessionValue">): AgentTranscriptSource {
  const nativeSession = nativeSessionFor(binding);
  return {
    agentKind: binding.agentKind, bindingId: binding.id, generation: binding.generation, paneId: binding.paneId, nativeSession,
    ...(binding.paneId && binding.workspaceId && Number.isSafeInteger(binding.sessionEpoch) && binding.sessionEpoch > 0 && nativeSession?.kind === "id" ? { sessionActivityContext: {
      scope: { kind: "pane" as const, workspaceId: binding.workspaceId, paneId: binding.paneId },
      ownerFence: { kind: "primary" as const, id: binding.id, generation: binding.generation, sessionGeneration: binding.sessionEpoch },
      producer: { kind: "primary" as const, id: binding.id, runtimeGeneration: binding.generation, sessionGeneration: binding.sessionEpoch, runtimePaneId: binding.paneId }
    } } : {})
  };
}

function nativeSessionFor(binding: Pick<Binding, "agentSessionSource" | "agentSessionAgent" | "agentSessionKind" | "agentSessionValue">): HerdrAgentSession | null {
  if (!binding.agentSessionSource || !binding.agentSessionAgent || !binding.agentSessionKind || !binding.agentSessionValue) return null;
  return { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue };
}
