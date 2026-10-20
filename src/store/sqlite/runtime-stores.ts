import type { HealthStore } from "../../domain/ports/health.js";
import type { RetentionStore } from "../../domain/ports/retention.js";
import type { SqliteStoreLifecycle } from "../sqlite-store-bundle.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";
import type { SqliteContext } from "./context.js";
import type { SqliteInboundProjectStore } from "./inbound-project-store.js";
import type { SqliteLeaseStore } from "./lease-store.js";
import type { SqliteOperationsStore } from "./operations-store.js";
import type { SqliteOutboxStore } from "./outbox-store.js";
import type { SqliteProjectionGapStore } from "./projection-gap-store.js";
import type { SqliteSessionOperationStore } from "./session-operation-store.js";
import type { SqliteCoreEventInboxStore } from "./core-event-inbox-store.js";
import type { SqliteRetentionAuditStore } from "./retention-audit-store.js";
import type { SqliteRetentionCompactionStore } from "./retention-compaction-store.js";

export class SqliteStoreLifecycleAdapter implements SqliteStoreLifecycle {
  constructor(private readonly context: SqliteContext, private readonly lease: SqliteLeaseStore) {}
  activateWriteFence(ownerId: string, fencingToken: number): ReturnType<SqliteLeaseStore["activateWriteFence"]> { return this.lease.activateWriteFence(ownerId, fencingToken); }
  recoverPriorOwnerClaimsBatch(...args: Parameters<SqliteLeaseStore["recoverPriorOwnerClaimsBatch"]>): ReturnType<SqliteLeaseStore["recoverPriorOwnerClaimsBatch"]> { return this.lease.recoverPriorOwnerClaimsBatch(...args); }
  deactivateWriteFence(): void { this.lease.deactivateWriteFence(); }
  runtimeDiagnostics(): ReturnType<SqliteContext["runtimeDiagnostics"]> { return this.context.runtimeDiagnostics(); }
  close(): void { this.context.close(); }
}

export class SqliteHealthStoreAdapter implements HealthStore {
  constructor(private readonly operations: SqliteOperationsStore, private readonly bindings: SqliteBindingLifecycleStore) {}
  probeReadiness(): void { this.operations.probeReadiness(); }
  getOperationalSummary(): ReturnType<HealthStore["getOperationalSummary"]> { return this.operations.getOperationalSummary(); }
  getRecoveryDurableEvidence(): ReturnType<HealthStore["getRecoveryDurableEvidence"]> { return this.operations.getRecoveryDurableEvidence(); }
  getRecoveryStageForBinding(bindingId: string): ReturnType<HealthStore["getRecoveryStageForBinding"]> { return this.operations.getRecoveryStageForBinding(bindingId); }
  listBindings(): ReturnType<HealthStore["listBindings"]> { return this.bindings.listBindings(); }
}

export class SqliteRetentionStoreAdapter implements RetentionStore {
  constructor(
    private readonly outbox: SqliteOutboxStore,
    private readonly inbound: SqliteInboundProjectStore,
    private readonly sessions: SqliteSessionOperationStore,
    private readonly projectionGaps: SqliteProjectionGapStore,
    private readonly coreEvents: SqliteCoreEventInboxStore,
    private readonly retentionAudit: SqliteRetentionAuditStore,
    private readonly retentionCompaction: SqliteRetentionCompactionStore
  ) {}
  prepare(...args: Parameters<SqliteRetentionAuditStore["prepare"]>): ReturnType<SqliteRetentionAuditStore["prepare"]> { return this.retentionAudit.prepare(...args); }
  load(...args: Parameters<SqliteRetentionAuditStore["load"]>): ReturnType<SqliteRetentionAuditStore["load"]> { return this.retentionAudit.load(...args); }
  auditPage(...args: Parameters<SqliteRetentionCompactionStore["auditPage"]>): ReturnType<SqliteRetentionCompactionStore["auditPage"]> { return this.retentionCompaction.auditPage(...args); }
  compactPage(...args: Parameters<SqliteRetentionCompactionStore["compactPage"]>): ReturnType<SqliteRetentionCompactionStore["compactPage"]> { return this.retentionCompaction.compactPage(...args); }
  backfillCoreEventDiscriminators(limit: number): ReturnType<SqliteCoreEventInboxStore["backfillDiscriminators"]> { return this.coreEvents.backfillDiscriminators(limit); }
  pruneDeliveredOutboundReplies(cutoff: string, limit: number): number { return this.outbox.pruneDeliveredOutboundReplies(cutoff, limit); }
  compactDeliveryIntents(limit: number): number { return this.outbox.compactDeliveryIntents(limit); }
  classifyHistoricalDeliveryDebt(cutoff: string, limit: number): ReturnType<NonNullable<RetentionStore["classifyHistoricalDeliveryDebt"]>> { return this.outbox.classifyHistoricalDeliveryDebt(cutoff, limit); }
  pruneCompensatedProjectionGaps(cutoff: string, limit: number): number { return this.projectionGaps.pruneCompensated(cutoff, limit); }
  pruneAcceptedInboundMessages(cutoff: string, limit: number): number { return this.inbound.pruneAcceptedInboundMessages(cutoff, limit); }
  pruneTerminalSessionOperations(cutoff: string, limit: number): number { return this.sessions.pruneTerminal(cutoff, limit); }
}
