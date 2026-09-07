import type { AcceptCommandIntentInput, AcceptCommandIntentResult, CommandIntent, CommandIntentTerminalState } from "../command-intent.js";
import type { Binding } from "../types.js";

export interface CommandIntentStore {
  acceptCommandIntent(input: AcceptCommandIntentInput): AcceptCommandIntentResult;
  getCommandIntent(id: string): CommandIntent | null;
  claimNextCommandIntent(laneKey?: string): CommandIntent | null;
  finishCommandIntent(id: string, state: CommandIntentTerminalState, outcome: CommandIntent["outcome"]): CommandIntent | null;
  listRecoverableCommandIntents(): CommandIntent[];
  recoverExecutingCommandIntents(recoveredAt: string): number;
}

export interface CommandIntentWorkflowStore extends CommandIntentStore {
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  getBinding(id: string): Binding | null;
}
