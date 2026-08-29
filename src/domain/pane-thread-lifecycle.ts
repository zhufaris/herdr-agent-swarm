import type { AgentState } from "./types.js";

export type SessionLifecycle = "provisioning" | "active" | "draining" | "archived" | "closed" | "failed";
export type AttachmentState = "unattached" | "attached" | "degraded" | "orphaned";
export type ProvisioningCheckpoint = "selected" | "pane_created" | "runtime_started" | "thread_created" | "activated";
export type SessionPhase = "provisioning" | "ready" | "running" | "blocked" | "done" | "degraded" | "orphaned" | "draining" | "archived" | "closed" | "failed";

export interface PaneThreadSessionState {
  lifecycle: SessionLifecycle;
  attachment: AttachmentState;
  runtime: AgentState;
  generation: number;
  provisioningCheckpoint: ProvisioningCheckpoint;
  degradationCount: number;
  hasCompletedTurn: boolean;
}

export type SessionTransition =
  | { type: "pane_created" }
  | { type: "runtime_started"; runtime?: AgentState }
  | { type: "thread_created" }
  | { type: "activate"; runtime?: AgentState }
  | { type: "provisioning_failed" }
  | { type: "archive_requested"; hasActiveTurn: boolean }
  | { type: "drain_completed" }
  | { type: "closed" }
  | { type: "pane_probe_failed"; confirmedMissing: boolean; orphanThreshold: number }
  | { type: "agent_unregistered" }
  | { type: "pane_observed"; runtime: AgentState }
  | { type: "pane_reattached"; replacement: boolean }
  | { type: "recover_failed"; runtime: AgentState }
  | { type: "retry_failed_provisioning"; runtime: AgentState }
  | { type: "turn_completed" };

export function transitionSession(state: PaneThreadSessionState, transition: SessionTransition): PaneThreadSessionState {
  switch (transition.type) {
    case "pane_created":
      requireLifecycle(state, transition.type, "provisioning");
      return { ...state, attachment: "attached", provisioningCheckpoint: "pane_created" };
    case "runtime_started":
      requireLifecycle(state, transition.type, "provisioning");
      return { ...state, runtime: transition.runtime ?? "idle", provisioningCheckpoint: "runtime_started" };
    case "thread_created":
      requireLifecycle(state, transition.type, "provisioning");
      return { ...state, provisioningCheckpoint: "thread_created" };
    case "activate":
      requireLifecycle(state, transition.type, "provisioning", "archived");
      return { ...state, lifecycle: "active", attachment: "attached", runtime: transition.runtime ?? state.runtime, provisioningCheckpoint: "activated", degradationCount: 0 };
    case "provisioning_failed":
      requireLifecycle(state, transition.type, "provisioning");
      return { ...state, lifecycle: "failed" };
    case "archive_requested":
      requireLifecycle(state, transition.type, "active");
      return { ...state, lifecycle: transition.hasActiveTurn ? "draining" : "archived" };
    case "drain_completed":
      requireLifecycle(state, transition.type, "draining");
      return { ...state, lifecycle: "archived" };
    case "closed":
      requireLifecycle(state, transition.type, "archived");
      return { ...state, lifecycle: "closed", attachment: "unattached", runtime: "unknown" };
    case "pane_probe_failed": {
      requireLifecycle(state, transition.type, "active", "draining");
      const degradationCount = state.degradationCount + 1;
      const attachment = transition.confirmedMissing || degradationCount >= transition.orphanThreshold ? "orphaned" : "degraded";
      return { ...state, attachment, degradationCount };
    }
    case "agent_unregistered":
      requireLifecycle(state, transition.type, "active", "draining");
      return { ...state, attachment: "degraded", runtime: "unknown" };
    case "pane_observed":
      requireLifecycle(state, transition.type, "provisioning", "active", "draining");
      return { ...state, attachment: "attached", degradationCount: 0, runtime: transition.runtime };
    case "pane_reattached":
      if (state.attachment !== "orphaned") throw invalidTransition(state, transition.type);
      requireLifecycle(state, transition.type, "active", "archived", "draining");
      return { ...state, lifecycle: "active", attachment: "attached", runtime: "unknown", degradationCount: 0, generation: state.generation + (transition.replacement ? 1 : 0) };
    case "recover_failed":
      requireLifecycle(state, transition.type, "failed");
      return { ...state, lifecycle: "active", attachment: "attached", runtime: transition.runtime, provisioningCheckpoint: "activated", degradationCount: 0 };
    case "retry_failed_provisioning":
      requireLifecycle(state, transition.type, "failed");
      return { ...state, lifecycle: "provisioning", attachment: "unattached", runtime: transition.runtime, provisioningCheckpoint: "runtime_started", degradationCount: 0 };
    case "turn_completed":
      requireLifecycle(state, transition.type, "active", "draining");
      return { ...state, runtime: "done", hasCompletedTurn: true };
  }
}

export function deriveSessionPhase(state: PaneThreadSessionState): SessionPhase {
  if (state.lifecycle !== "active") return state.lifecycle;
  if (state.attachment === "orphaned") return "orphaned";
  if (state.attachment === "degraded") return "degraded";
  if (state.runtime === "working") return "running";
  if (state.runtime === "blocked") return "blocked";
  if (state.runtime === "done" && state.hasCompletedTurn) return "done";
  return "ready";
}

function requireLifecycle(state: PaneThreadSessionState, transition: string, ...allowed: SessionLifecycle[]): void {
  if (!allowed.includes(state.lifecycle)) throw invalidTransition(state, transition);
}

function invalidTransition(state: PaneThreadSessionState, transition: string): Error {
  return new Error(`Cannot ${transition} session in ${state.lifecycle}/${state.attachment}`);
}
