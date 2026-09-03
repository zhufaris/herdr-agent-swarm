import type { ControlActor } from "./commands.js";
import type { HerdrAgentSession } from "./types.js";

export type TurnControlKind = "steer" | "interrupt";
export type TurnControlState = "accepted" | "dispatching" | "delivered" | "rejected" | "uncertain";
export type TurnControlOwner = { kind: "binding"; id: string } | { kind: "instance"; id: string };

export interface TurnTarget {
  owner: TurnControlOwner;
  projectId: string;
  paneId: string;
  generation: number;
  agentSession: HerdrAgentSession;
  logicalTurnId: string;
  runtimeTurnId: string;
}

export interface TurnControlOperation {
  id: string;
  idempotencyKey: string;
  kind: TurnControlKind;
  target: TurnTarget;
  actor: ControlActor;
  payload: string | null;
  sourceMessageId: string | null;
  sourceCardId: string | null;
  state: TurnControlState;
  result: Record<string, unknown> | null;
  createdAt: string;
  updatedAt: string;
}

export interface AcceptTurnControlOperationInput {
  id: string;
  idempotencyKey: string;
  kind: TurnControlKind;
  target: TurnTarget;
  actor: ControlActor;
  payload: string | null;
  sourceMessageId?: string | null;
  sourceCardId?: string | null;
  result?: { targetMessageId: string; bindingId?: string | null; card: object };
}
