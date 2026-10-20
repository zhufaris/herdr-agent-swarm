import type { Binding } from "../binding.js";
import type { AcceptOrchestratorIdentityMigrationInput, OrchestratorIdentityMigration } from "../orchestrator-identity.js";
import type { PaneIdentityReconcileReceipt } from "./external.js";

export interface OrchestratorIdentityMigrationStore {
  findOrchestratorBinding(gatewayId: string, chatId: string): Binding | null;
  hasActivePrompt(bindingId: string): boolean;
  hasActiveMigration(bindingId: string): boolean;
  accept(input: AcceptOrchestratorIdentityMigrationInput): { operation: OrchestratorIdentityMigration; inserted: boolean };
  claim(operationId: string): OrchestratorIdentityMigration | null;
  markUncertain(operationId: string, detail: string): OrchestratorIdentityMigration | null;
  finish(operationId: string, state: "rejected" | "failed", detail: string): OrchestratorIdentityMigration | null;
  applyReceipt(input: { operationId: string; receipt: PaneIdentityReconcileReceipt }): { operation: OrchestratorIdentityMigration; binding: Binding } | null;
  listRecoverable(limit?: number): OrchestratorIdentityMigration[];
}
