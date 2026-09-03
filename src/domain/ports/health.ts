import type { InstanceLease, OperationalSummary, SqliteIntegrityInspection } from "../types.js";
import type { Binding } from "../types.js";

export interface LeaseStore {
  acquireInstanceLease(ownerId: string, now: string, expiresAt: string): InstanceLease | null;
  renewInstanceLease(ownerId: string, fencingToken: number, now: string, expiresAt: string): InstanceLease | null;
  releaseInstanceLease(ownerId: string, fencingToken: number): boolean;
}

export interface HealthStore {
  getOperationalSummary(): OperationalSummary;
  listBindings(): Binding[];
}

export interface DatabaseIntegrityStore {
  inspectIntegrity(limit: number, signal?: AbortSignal): SqliteIntegrityInspection | Promise<SqliteIntegrityInspection>;
}
