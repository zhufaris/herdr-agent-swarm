import { createHash } from "node:crypto";
import type { CoreEventEnvelope } from "../../domain/core-event-inbox.js";
import type { AgentEvent } from "../../domain/herdr-events.js";
import type { AgentTranscriptSource } from "../../domain/ports/external.js";
import { decodePersistedAgentEvent, encodePersistedAgentEvent } from "./event-codec.js";

export type CoreEventBoundary =
  | { kind: "latest" }
  | { kind: "active" }
  | { kind: "first" }
  | { kind: "at"; turnId: string; startedAt: string }
  | { kind: "after"; turnId: string; startedAt: string };

export function liveCoreEventLaneId(source: AgentTranscriptSource, boundary: CoreEventBoundary, sourceIdentity: string): string {
  return laneId({
    bindingId: source.bindingId,
    generation: source.generation,
    agentKind: source.agentKind,
    boundary,
    sourceIdentity
  });
}

/** Keeps the deployed v2 active-lane digest while naming its session-wide role. */
export function liveCoreSessionLaneId(source: AgentTranscriptSource, sourceIdentity?: string): string {
  if (sourceIdentity) return liveCoreEventLaneId(source, { kind: "active" }, sourceIdentity);
  return laneId({
    bindingId: source.bindingId,
    generation: source.generation,
    agentKind: source.agentKind,
    sessionId: source.nativeSession?.kind === "id" ? source.nativeSession.value : null,
    boundary: "active"
  });
}

export function recoveredCoreEventLaneId(source: AgentTranscriptSource, turnId: string, agentKind: "traex" | "pi", sessionId: string): string {
  return laneId({
    bindingId: source.bindingId,
    generation: source.generation,
    agentKind,
    sessionId,
    turnId,
    boundary: "recovered"
  });
}

export function toCoreEventEnvelope(event: AgentEvent): CoreEventEnvelope {
  return encodePersistedAgentEvent(event);
}

export function fromCoreEventEnvelope(event: CoreEventEnvelope): AgentEvent {
  return decodePersistedAgentEvent(event);
}

function laneId(identity: object): string {
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `core-events:${digest}`;
}
