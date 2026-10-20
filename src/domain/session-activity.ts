import type { DeliveryOwnerFence, DeliveryScope } from "./delivery-scope.js";

export type SessionActivityItemKind = "task" | "agent" | "tool";
export type SessionActivityTurnState = "active" | "completed" | "aborted";

export interface SessionActivityProducerFence {
  kind: "primary" | "worker";
  id: string;
  runtimeGeneration: number;
  sessionGeneration: number;
  runtimePaneId: string;
}

export interface SessionActivityProjectionContext {
  scope: Extract<DeliveryScope, { kind: "pane" }>;
  ownerFence: DeliveryOwnerFence;
  producer: SessionActivityProducerFence;
}

/** Bounded compatibility fact derived from an external protocol, never task or result content. */
export interface SessionActivityAgentLifecycleMutation {
  agentId: string;
  displayName?: string;
  model?: string;
  state: "started" | "running" | "completed" | "failed" | "interrupted" | "blocked";
  terminal: boolean;
}

/** Durable bounded identity evidence for one Subagent within an exact producer session. */
export interface SessionAgentIdentity {
  scopeKey: string;
  producerKind: "primary" | "worker";
  producerId: string;
  producerGeneration: number;
  producerSessionGeneration: number;
  agentId: string;
  displayName: string | null;
  model: string | null;
  sourceLaneSequence: number;
  sourceEventId: string;
}

export interface SessionActivitySnapshot {
  scopeKey: string;
  workspaceId: string;
  paneId: string;
  bindingId: string;
  bindingGeneration: number;
  sessionEpoch: number;
  nativeSessionId: string;
  revision: number;
  currentModel: string | null;
  currentGoal: { goalId: string; objective: string; status: string; sourceUpdatedAt: number } | null;
  lastTurnId: string | null;
  lastTurnState: SessionActivityTurnState | null;
  compactionCount: number;
  tokenUsage: number | null;
  contextUsage: number | null;
  updatedAt: string;
}

export interface SessionActivityItem {
  scopeKey: string;
  producerKind: "primary" | "worker";
  producerId: string;
  kind: SessionActivityItemKind;
  itemId: string;
  ordinal: number;
  label: string;
  state: string;
  terminal: boolean;
  sourceEventId: string;
  sourceLaneSequence: number;
  updatedAt: string;
}

export interface SessionActivityView {
  snapshot: SessionActivitySnapshot;
  items: SessionActivityItem[];
}

export interface SessionActivityDiagnostics {
  missingIdentityFallbackCount: number;
  lastMissingIdentityAt: string | null;
  lastMissingIdentityOutcome: "uuid_fallback" | null;
}

export interface SessionActivityBindingFence {
  bindingId: string;
  bindingGeneration: number;
  sessionEpoch: number;
}

export interface SessionActivityInvalidationFence extends SessionActivityBindingFence {
  producer: SessionActivityProducerFence;
  occurredAt: string;
}

export const SESSION_ACTIVITY_MAX_TERMINAL_PER_KIND = 20;
export const SESSION_ACTIVITY_VISIBLE_ACTIVE_PER_KIND = 8;

export interface SessionActivityDisplayGroup {
  kind: "agent";
  items: Array<Pick<SessionActivityItem, "terminal"> & { label: string; state: string }>;
}

export interface SessionActivityDisplay {
  compactionCount: number | null;
  groups: SessionActivityDisplayGroup[];
}

/** The exact bounded data that can affect the shared Subagents/Compaction presentation. */
export function sessionActivityDisplay(view: SessionActivityView): SessionActivityDisplay {
  const agents = view.items
    .filter((item) => item.kind === "agent" && !item.terminal)
    .slice(0, SESSION_ACTIVITY_VISIBLE_ACTIVE_PER_KIND)
    .map((item) => ({
      label: truncateSessionActivityText(item.label, 160),
      state: truncateSessionActivityText(item.state, 48),
      terminal: item.terminal
    }));
  return {
    compactionCount: view.snapshot.compactionCount > 0 ? view.snapshot.compactionCount : null,
    groups: agents.length ? [{ kind: "agent", items: agents }] : []
  };
}

export function sessionActivityPresentationFingerprint(view: SessionActivityView | null): string {
  if (!view) return "null";
  const display = sessionActivityDisplay(view);
  return JSON.stringify(display.compactionCount === null && display.groups.length === 0 ? null : display);
}

function truncateSessionActivityText(value: string, max: number): string {
  return value.length > max ? `${value.slice(0, max - 1)}…` : value;
}
