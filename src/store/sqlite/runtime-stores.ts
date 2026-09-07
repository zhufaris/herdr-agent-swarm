import type { HealthStore } from "../../domain/ports/health.js";
import type { SqliteRetentionStore, SqliteStoreLifecycle } from "../sqlite-store-bundle.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";
import type { SqliteContext } from "./context.js";
import type { SqliteInboundProjectStore } from "./inbound-project-store.js";
import type { SqliteLeaseStore } from "./lease-store.js";
import type { SqliteOperationsStore } from "./operations-store.js";
import type { SqliteOutboxStore } from "./outbox-store.js";
import type { SqliteSessionOperationStore } from "./session-operation-store.js";

export class SqliteStoreLifecycleAdapter implements SqliteStoreLifecycle {
  constructor(private readonly context: SqliteContext, private readonly lease: SqliteLeaseStore) {}
  activateWriteFence(ownerId: string, fencingToken: number): void { this.lease.activateWriteFence(ownerId, fencingToken); }
  deactivateWriteFence(): void { this.lease.deactivateWriteFence(); }
  close(): void { this.context.close(); }
}

export class SqliteHealthStoreAdapter implements HealthStore {
  constructor(private readonly operations: SqliteOperationsStore, private readonly bindings: SqliteBindingLifecycleStore) {}
  getOperationalSummary(): ReturnType<HealthStore["getOperationalSummary"]> { return this.operations.getOperationalSummary(); }
  listBindings(): ReturnType<HealthStore["listBindings"]> { return this.bindings.listBindings(); }
}

export class SqliteRetentionStoreAdapter implements SqliteRetentionStore {
  constructor(
    private readonly outbox: SqliteOutboxStore,
    private readonly inbound: SqliteInboundProjectStore,
    private readonly sessions: SqliteSessionOperationStore
  ) {}
  pruneDeliveredOutboundReplies(cutoff: string, limit: number): number { return this.outbox.pruneDeliveredOutboundReplies(cutoff, limit); }
  pruneAcceptedInboundMessages(cutoff: string, limit: number): number { return this.inbound.pruneAcceptedInboundMessages(cutoff, limit); }
  pruneTerminalSessionOperations(cutoff: string, limit: number): number { return this.sessions.pruneTerminal(cutoff, limit); }
}
