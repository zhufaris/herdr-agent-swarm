import type { Binding, HerdrAgentSession } from "./types.js";
import { canonicalTraexSession } from "./traex-session-identity.js";

/**
 * Stable in-process cache identity for a binding's exact transcript source.
 * Length-prefixed fields avoid ambiguity if a future session value contains a
 * conventional separator such as `:`.
 */
export function transcriptObserverIdentity(binding: Pick<Binding, "generation" | "paneId" | "agentSessionSource" | "agentSessionAgent" | "agentSessionKind" | "agentSessionValue">): string | null {
  const session = transcriptSessionFor(binding);
  if (!binding.paneId || !session) return null;
  const identitySession = canonicalTraexSession(session);
  return [String(binding.generation), binding.paneId, identitySession.source, identitySession.agent, identitySession.kind, identitySession.value]
    .map((field) => `${field.length}:${field}`)
    .join("");
}

export function transcriptSessionFor(binding: Pick<Binding, "agentSessionSource" | "agentSessionAgent" | "agentSessionKind" | "agentSessionValue">): HerdrAgentSession | null {
  return binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
    ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue }
    : null;
}
