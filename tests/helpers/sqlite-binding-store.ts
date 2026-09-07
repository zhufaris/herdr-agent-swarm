import { SqliteStoreKernel } from "../../src/store/sqlite-store-kernel.js";
import type { HealthStore, LeaseStore } from "../../src/domain/ports/health.js";
import type { InboundMessageDispatchStore } from "../../src/domain/ports/workflow.js";
import type { WorkerCardDisplayStore } from "../../src/domain/ports/worker-card-display.js";
import type { SqliteRetentionStore, SqliteStoreLifecycle } from "../../src/store/sqlite-store-bundle.js";

/** Legacy broad test driver. Production code must depend on named store capabilities. */
export class SqliteBindingStore extends SqliteStoreKernel {
  private readonly compatibility = this.capabilityModules();

  activateWriteFence(...args: Parameters<SqliteStoreLifecycle["activateWriteFence"]>): void { this.compatibility.lifecycle.activateWriteFence(...args); }
  deactivateWriteFence(): void { this.compatibility.lifecycle.deactivateWriteFence(); }
  acquireInstanceLease(...args: Parameters<LeaseStore["acquireInstanceLease"]>): ReturnType<LeaseStore["acquireInstanceLease"]> { return this.compatibility.lease.acquireInstanceLease(...args); }
  renewInstanceLease(...args: Parameters<LeaseStore["renewInstanceLease"]>): ReturnType<LeaseStore["renewInstanceLease"]> { return this.compatibility.lease.renewInstanceLease(...args); }
  releaseInstanceLease(...args: Parameters<LeaseStore["releaseInstanceLease"]>): boolean { return this.compatibility.lease.releaseInstanceLease(...args); }
  getOperationalSummary(): ReturnType<HealthStore["getOperationalSummary"]> { return this.compatibility.health.getOperationalSummary(); }
  inspectIntegrity(limit: number) { return this.compatibility.integrity.inspectIntegrity(limit); }
  listBindings(): ReturnType<HealthStore["listBindings"]> { return this.compatibility.health.listBindings(); }
  recordInboundMessage(...args: Parameters<InboundMessageDispatchStore["recordInboundMessage"]>): boolean { return this.compatibility.inboundDispatch.recordInboundMessage(...args); }
  claimNextInboundMessage(): ReturnType<InboundMessageDispatchStore["claimNextInboundMessage"]> { return this.compatibility.inboundDispatch.claimNextInboundMessage(); }
  markInboundMessageAccepted(...args: Parameters<InboundMessageDispatchStore["markInboundMessageAccepted"]>): void { this.compatibility.inboundDispatch.markInboundMessageAccepted(...args); }
  releaseInboundMessage(...args: Parameters<InboundMessageDispatchStore["releaseInboundMessage"]>): void { this.compatibility.inboundDispatch.releaseInboundMessage(...args); }
  recoverProcessingInboundMessages(): number { return this.compatibility.inboundDispatch.recoverProcessingInboundMessages(); }
  isBridgeMessage(...args: Parameters<InboundMessageDispatchStore["isBridgeMessage"]>): boolean { return this.compatibility.inboundDispatch.isBridgeMessage(...args); }
  recordBridgeMessage(messageId: string): void { this.compatibility.inboundDispatch.recordBridgeMessage(messageId); }
  pruneDeliveredOutboundReplies(...args: Parameters<SqliteRetentionStore["pruneDeliveredOutboundReplies"]>): number { return this.compatibility.retention.pruneDeliveredOutboundReplies(...args); }
  pruneAcceptedInboundMessages(...args: Parameters<SqliteRetentionStore["pruneAcceptedInboundMessages"]>): number { return this.compatibility.retention.pruneAcceptedInboundMessages(...args); }
  pruneTerminalSessionOperations(...args: Parameters<SqliteRetentionStore["pruneTerminalSessionOperations"]>): number { return this.compatibility.retention.pruneTerminalSessionOperations(...args); }
  reserveWorkerCardDisplay(...args: Parameters<WorkerCardDisplayStore["reserveWorkerCardDisplay"]>): ReturnType<WorkerCardDisplayStore["reserveWorkerCardDisplay"]> { return this.compatibility.workerCardDisplay.reserveWorkerCardDisplay(...args); }
}
