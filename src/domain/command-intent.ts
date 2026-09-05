import type { BridgeCommand } from "./types.js";
import type { SwarmCommandContext, SwarmCommandReplayPolicy } from "./swarm-command.js";

export type CommandIntentState = "accepted" | "executing" | "succeeded" | "rejected" | "failed" | "uncertain";
export type CommandIntentTerminalState = Extract<CommandIntentState, "succeeded" | "rejected" | "failed" | "uncertain">;

export interface CommandIntentOutcome {
  code: string;
  detail: string | null;
  operationKind: string | null;
  operationId: string | null;
}

export interface CommandIntent {
  id: string;
  idempotencyKey: string;
  laneKey: string;
  command: BridgeCommand;
  context: SwarmCommandContext;
  replayPolicy: SwarmCommandReplayPolicy;
  state: CommandIntentState;
  attemptCount: number;
  outcome: CommandIntentOutcome | null;
  claimedAt: string | null;
  createdAt: string;
  updatedAt: string;
}

export interface AcceptCommandIntentInput {
  id: string;
  idempotencyKey: string;
  laneKey: string;
  command: BridgeCommand;
  context: SwarmCommandContext;
  replayPolicy: Exclude<SwarmCommandReplayPolicy, "none">;
  acceptedAt: string;
}

export type AcceptCommandIntentResult =
  | { outcome: "accepted"; intent: CommandIntent }
  | { outcome: "duplicate"; intent: CommandIntent }
  | { outcome: "conflict"; intent: CommandIntent };
