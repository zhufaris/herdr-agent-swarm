import type { AcceptTurnControlOperationInput, TurnControlOperation, TurnControlState } from "../turn-control.js";
import type { TurnControlOwner } from "../turn-control.js";

export interface TurnControlStore {
  getPrioritySteer(owner: TurnControlOwner, idempotencyKey: string): { logicalTurnId: string; text: string } | null;
  acceptTurnControlOperation(input: AcceptTurnControlOperationInput): { operation: TurnControlOperation; inserted: boolean };
  getTurnControlOperation(id: string): TurnControlOperation | null;
  getTurnControlOperationByIdempotencyKey(idempotencyKey: string): TurnControlOperation | null;
  claimTurnControlOperation(id: string): TurnControlOperation | null;
  rejectAcceptedTurnControlOperation(input: { id: string; result: Record<string, unknown>; card?: object }): TurnControlOperation | null;
  finishTurnControlOperation(input: { id: string; state: Extract<TurnControlState, "delivered" | "rejected" | "uncertain">; result: Record<string, unknown>; card?: object }): TurnControlOperation | null;
  recoverTurnControlOperations(renderResult?: (operation: TurnControlOperation) => object): { accepted: TurnControlOperation[]; uncertain: TurnControlOperation[] };
}
