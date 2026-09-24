import type { AcceptCommandIntentInput, AcceptCommandIntentResult, CommandIntent, CommandIntentTerminalState } from "../command-intent.js";
import type { Binding } from "../types.js";
import type { CommandStatusView } from "../command-status-view.js";
import type { SwarmCommandSource } from "../swarm-command.js";
export type CommandStatusRenderer = (view: CommandStatusView) => object;

export interface CommandIntentStore {
  acceptCommandIntent(input: AcceptCommandIntentInput, source?: SwarmCommandSource, renderStatus?: CommandStatusRenderer): AcceptCommandIntentResult;
  getCommandIntent(id: string): CommandIntent | null;
  getCommandStatusView(id: string): CommandStatusView | null;
  claimNextCommandIntent(laneKey?: string, renderStatus?: CommandStatusRenderer): CommandIntent | null;
  finishCommandIntent(id: string, state: CommandIntentTerminalState, outcome: CommandIntent["outcome"], renderStatus?: CommandStatusRenderer): CommandIntent | null;
  listRecoverableCommandIntents(): CommandIntent[];
  recoverExecutingCommandIntents(recoveredAt: string, renderStatus?: CommandStatusRenderer): number;
  registerWorkerThreadEntry(input: { commandIntentId: string; workerId: string; workerSessionGeneration: number; bindingId: string; bindingGeneration: number; rootMessageId: string }): boolean;
}

export interface CommandIntentWorkflowStore extends CommandIntentStore {
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  getBinding(id: string): Binding | null;
}
