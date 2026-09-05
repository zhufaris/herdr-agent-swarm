import type { ControlActor } from "./commands.js";
import type { TurnPriority } from "./types.js";

export type InstanceTurnState = "queued" | "claimed" | "dispatching" | "running" | "blocked" | "completed" | "failed" | "cancelled" | "dispatch-uncertain";
export type InstanceEventKind = "turn.accepted" | "turn.claimed" | "turn.transcript-owned" | "turn.requeued-after-restart" | "turn.dispatching" | "turn.running" | "turn.blocked" | "turn.completed" | "turn.failed" | "turn.cancelled" | "turn.dispatch-uncertain" | "turn.abort";
export interface InstanceTurn {
  id: string; idempotencyKey: string; projectId: string; instanceId: string; instanceGeneration: number;
  actor: ControlActor; kind: "turn" | "followup"; priority: TurnPriority; text: string; state: InstanceTurnState; result: string | null; error: string | null;
  parentTurnId: string | null; sourceMessageId: string | null; runtimeTurnId: string | null; runtimeTurnStartedAt: string | null;
  createdAt: string; updatedAt: string;
}
export interface InstanceTurnCursor { createdAt: string; id: string }
export interface InstanceTurnPage { items: InstanceTurn[]; nextCursor: InstanceTurnCursor | null }
export interface InstanceTurnSummary extends InstanceTurn { resultCapture: "pending" | "captured" | "unavailable" }
export interface InstanceEvent { id: number; projectId: string; instanceId: string; turnId: string | null; kind: InstanceEventKind; payload: Record<string, unknown>; createdAt: string }
export interface InstanceOperation {
  id: string; idempotencyKey: string; projectId: string; instanceId: string; instanceGeneration: number; actor: ControlActor;
  kind: "steer" | "interrupt"; payload: string | null; state: "accepted" | "running" | "succeeded" | "rejected" | "failed"; result: string | null; createdAt: string; updatedAt: string;
}
