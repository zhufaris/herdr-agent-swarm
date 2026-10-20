import type { AcceptOrchestratorClearOperationInput, OrchestratorClearOperation, SessionRotationReceipt } from "../orchestrator-clear.js";
import type { Binding } from "../binding.js";

export interface OrchestratorClearStore {
  getBinding(id: string): Binding | null;
  hasNonterminalPrompt(bindingId: string): boolean;
  hasActiveIdentityMigration(bindingId: string): boolean;
  accept(input: AcceptOrchestratorClearOperationInput): { operation: OrchestratorClearOperation; inserted: boolean };
  get(id: string): OrchestratorClearOperation | null;
  claimNext(bindingId: string): OrchestratorClearOperation | null;
  markRotationUncertain(operationId: string, detail: string): OrchestratorClearOperation | null;
  applyRotationReceipt(input: { operationId: string; receipt: SessionRotationReceipt }): { operation: OrchestratorClearOperation; binding: Binding } | null;
  settleAnswerWithdrawal(input: { outboundReplyId: string; outcome: "deleted" | "already_absent" | "failed"; detail?: string | null }): OrchestratorClearOperation | null;
  listTerminalWithoutResult(limit?: number): OrchestratorClearOperation[];
  reserveResult(operationId: string, card: object): boolean;
  finish(operationId: string, state: "succeeded" | "partial" | "rejected" | "failed", detail?: string | null): OrchestratorClearOperation | null;
  listRecoverable(limit?: number): OrchestratorClearOperation[];
}
