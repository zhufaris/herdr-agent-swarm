import type { PaneIdentity, PaneIdentityReconcileReceipt } from "./ports/external.js";

export type OrchestratorIdentityMigrationState = "accepted" | "applying" | "uncertain" | "succeeded" | "rejected" | "failed";

export interface OrchestratorIdentityMigration {
  id: string;
  bindingId: string;
  bindingGeneration: number;
  expected: PaneIdentity;
  target: { workspaceId: string; expectedWorkspaceLabel: string; token: string };
  state: OrchestratorIdentityMigrationState;
  attemptCount: number;
  receipt: PaneIdentityReconcileReceipt | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
}

export type AcceptOrchestratorIdentityMigrationInput = Omit<OrchestratorIdentityMigration,
  "state" | "attemptCount" | "receipt" | "detail" | "createdAt" | "updatedAt">;
