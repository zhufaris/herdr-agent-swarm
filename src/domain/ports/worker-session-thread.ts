import type { IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult } from "../inbound.js";
import type { WorkerMainView } from "../worker-main-view.js";

export interface WorkerThreadScope { chatId: string; topicId: string | null; rootMessageId: string | null }
export interface ValidatedWorkerThreadTarget {
  threadId: string; workerId: string; workerName: string; workerSessionGeneration: number; projectId: string; runtimeGeneration: number;
  parentBindingId: string; parentBindingGeneration: number; parentPaneId: string; rootMessageId: string; mode: "canonical-main" | "legacy-entry";
  view: WorkerMainView; activeTurn: { id: string; state: string } | null;
}
export type WorkerThreadResolution = { kind: "none" } | { kind: "stale"; threadId: string } | { kind: "active"; target: ValidatedWorkerThreadTarget };

export interface WorkerThreadPublicationTarget {
  instanceId: string; runtimeGeneration: number; workerSessionGeneration: number; conversationKey: string | null; bindingId?: string; bindingGeneration?: number;
  parentPaneId?: string; sourceMainMessageId?: string;
}
export type WorkerThreadPublicationDecision = { kind: "reserved" } | { kind: "pending" } | { kind: "existing"; rootMessageId: string } | { kind: "stale" };
export type WorkerMainPlacementDecision = "reserved" | "waiting" | "current" | "stale";
export type WorkerThreadSettlementDecision = { kind: "canonical" | "legacy" | "stale"; invalidations: Array<{ targetKind: "worker-session" | "primary-session"; targetId: string; targetGeneration: number; reason: string }> };

export interface WorkerSessionThreadApplicationStore {
  resolveScope(scope: WorkerThreadScope): WorkerThreadResolution;
  reserveLegacyEntry(input: { actionMessageId: string; chatId: string; target: WorkerThreadPublicationTarget; render(view: WorkerMainView, generatedAt: string): object }): WorkerThreadPublicationDecision;
}

export interface WorkerSessionThreadProjectionStore {
  reserveCanonicalMain(view: WorkerMainView, card: object): WorkerMainPlacementDecision;
}

export interface WorkerSessionThreadDeliveryStore {
  settlePublication(input: { threadId: string; workerId: string; workerSessionGeneration: number; viewVersion: number | null; messageId: string; cardId: string | null; topicId: string; occurredAt: string }): WorkerThreadSettlementDecision;
}

export interface WorkerSessionThreadLifecycleStore { retireSession(workerId: string, workerSessionGeneration: number, occurredAt: string): void }
export interface WorkerSessionThreadWorkflowPort {
  handleMessage(message: IncomingLarkMessage): Promise<{ handled: false } | { handled: true; disposition: "prompt_queued" | "command_completed" | "rejected" }>;
  publishFromCard(action: IncomingLarkCardAction, target: WorkerThreadPublicationTarget): Promise<LarkCardActionResult>;
}
