import type { ControlActor } from "./commands.js";

export type InstanceTurnState = "queued" | "claimed" | "dispatching" | "running" | "blocked" | "completed" | "failed" | "cancelled" | "dispatch-uncertain";
export interface InstanceTurn {
  id: string; idempotencyKey: string; projectId: string; instanceId: string; instanceGeneration: number;
  actor: ControlActor; kind: "turn" | "followup"; text: string; state: InstanceTurnState; result: string | null; error: string | null;
  createdAt: string; updatedAt: string;
}
export interface InstanceEvent { id: number; projectId: string; instanceId: string; turnId: string | null; kind: string; payload: Record<string, unknown>; createdAt: string }
export interface InstanceOperation {
  id: string; idempotencyKey: string; projectId: string; instanceId: string; instanceGeneration: number; actor: ControlActor;
  kind: "steer" | "interrupt"; payload: string | null; state: "accepted" | "running" | "succeeded" | "rejected" | "failed"; result: string | null; createdAt: string; updatedAt: string;
}
