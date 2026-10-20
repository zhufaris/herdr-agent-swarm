import type { DatabaseDiagnosticsInspection, InstanceLease, OperationalSummary, SqliteIntegrityInspection } from "../types.js";
import type { Binding } from "../types.js";
import type { RecoveryDurableEvidence, RecoveryStage } from "../recovery.js";

export interface LeaseStore {
  acquireInstanceLease(ownerId: string, now: string, expiresAt: string): InstanceLease | null;
  renewInstanceLease(ownerId: string, fencingToken: number, ttlMs: number): InstanceLease | null;
  releaseInstanceLease(ownerId: string, fencingToken: number): boolean;
}

export interface HealthStore {
  probeReadiness(): void;
  getOperationalSummary(): OperationalSummary;
  getRecoveryDurableEvidence(): RecoveryDurableEvidence;
  getRecoveryStageForBinding(bindingId: string): RecoveryStage | null;
  listBindings(): Binding[];
}

export interface DatabaseIntegrityStore {
  inspectIntegrity(limit: number, signal?: AbortSignal): SqliteIntegrityInspection | Promise<SqliteIntegrityInspection>;
}

export interface DatabaseDiagnosticsStore {
  inspectDiagnostics(input: { issueLimit: number; includePhysical: boolean }, signal?: AbortSignal): Promise<DatabaseDiagnosticsInspection>;
}
