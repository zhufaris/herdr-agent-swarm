import type { AcceptTurnControlOperationInput, TurnControlOperation, TurnControlState } from "../turn-control.js";
import type { TurnControlOwner } from "../turn-control.js";
import type { PromptJob } from "../types.js";
import type { RunCardView } from "../run-card-view.js";
import type { AcceptInstanceTurnWithCardInput } from "./instance.js";
import type { AcceptPromptInput } from "./prompt.js";
import type { InstanceStore } from "./instance.js";

export interface TurnControlStore {
  getPrioritySteer(owner: TurnControlOwner, idempotencyKey: string): { logicalTurnId: string; text: string } | null;
  acceptTurnControlOperation(input: AcceptTurnControlOperationInput): { operation: TurnControlOperation; inserted: boolean };
  getTurnControlOperation(id: string): TurnControlOperation | null;
  getTurnControlOperationByIdempotencyKey(idempotencyKey: string): TurnControlOperation | null;
  claimTurnControlOperation(id: string): TurnControlOperation | null;
  rejectAcceptedTurnControlOperation(input: { id: string; result: Record<string, unknown>; card?: object }): TurnControlOperation | null;
  finishTurnControlOperation(input: { id: string; state: Extract<TurnControlState, "delivered" | "rejected" | "uncertain">; result: Record<string, unknown>; card?: object }): TurnControlOperation | null;
  convertTurnControlToPrimaryPriority(input: { operationId: string; prompt: AcceptPromptInput["prompt"]; view: RunCardView; rootMessageId: string; answerCard: object; maxQueueDepth: number; expectedBindingGeneration: number; result: Record<string, unknown>; card?: object }): { operation: TurnControlOperation; prompt: PromptJob } | null;
  convertTurnControlToWorkerPriority(input: { operationId: string; turn: Omit<AcceptInstanceTurnWithCardInput, "view" | "render"> & { view?: AcceptInstanceTurnWithCardInput["view"]; render?: AcceptInstanceTurnWithCardInput["render"] }; maxQueueDepth: number; result: Record<string, unknown>; card?: object }): { operation: TurnControlOperation; logicalTurnId: string } | null;
  recoverTurnControlOperations(renderResult?: (operation: TurnControlOperation) => object): { accepted: TurnControlOperation[]; uncertain: TurnControlOperation[] };
}

export interface TurnControlWorkflowStore extends TurnControlStore,
  Pick<InstanceStore, "getBinding" | "getActiveOrdinaryPrompt" | "getAgentInstance" | "getActiveInstanceTurn" | "acceptInstanceTurn" | "acceptInstanceTurnWithCard" | "countPendingInstanceTurns"> {
  acceptPrompt(input: AcceptPromptInput): { prompt: PromptJob; view: RunCardView; inserted: boolean };
  countPendingPrompts(bindingId: string): number;
}
