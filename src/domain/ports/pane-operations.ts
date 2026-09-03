import type { Binding, PaneCloseOperation, PaneControlOperation, PaneControlOperationKind, OutboundReply, SessionSummary } from "../types.js";
import type { PaneControlOutcome as DomainPaneControlOutcome } from "../pane-control-lifecycle.js";
import type { RunCardView } from "../run-card-view.js";
import type { TopicViewState } from "../topic-view.js";
import type { SessionTransition } from "../pane-thread-lifecycle.js";

export interface PaneOperationsStore {
  audit(input: { actorOpenId: string; action: string; target: string; outcome: string }): void;
  cancelQueuedPromptsWithProjection(input: { bindingId: string; reason: string; occurredAt: string; rootMessageId: string | null; renderRunCard(view: RunCardView): object }): { cancelledPromptIds: string[]; outboxReserved: boolean };
  consumePaneCloseRequest(input: { bindingId: string; paneId: string; actorOpenId: string; codeHash: string; now: string }): { outcome: "consumed"; operationId: string; paneId: string } | { outcome: "invalid" | "unauthorized" | "expired" | "stale" };
  countPendingPrompts(bindingId: string): number;
  createPaneCloseRequest(input: { id: string; bindingId: string; paneId: string; actorOpenId: string; codeHash: string; expiresAt: string }): void;
  createAutomaticPaneCloseOperation(input: { id: string; bindingId: string; paneId: string; now: string }): void;
  acceptPaneControlOperation(input: { id: string; idempotencyKey: string; bindingId: string; paneId: string; terminalId: string | null; bindingGeneration: number; kind: PaneControlOperationKind; payload?: string | null; parentPromptId?: string | null; actorOpenId: string; sourceMessageId: string }): { operation: PaneControlOperation; inserted: boolean };
  claimNextPaneControlOperation(bindingId?: string): PaneControlOperation | null;
  claimPaneControlOperation(id: string): PaneControlOperation | null;
  finishPaneControlOperation(id: string, state: DomainPaneControlOutcome, detail?: string | null): boolean;
  finishPaneControlWithResult(input: { operationId: string; state: DomainPaneControlOutcome; detail?: string | null; result: { kind: "card_reply" | "card_update"; targetMessageId: string; idempotencyKey: string; targetRole?: OutboundReply["targetRole"]; card: object } }): boolean;
  getPaneControlOperation(id: string): PaneControlOperation | null;
  listRecoverablePaneControlOperations(): PaneControlOperation[];
  claimAppliedPaneControlOperation(id: string): PaneControlOperation | null;
  rejectAppliedPaneControlOperation(id: string, detail: string): PaneControlOperation | null;
  findBindingByPane(paneId: string): Binding | null;
  finishPaneCloseRequest(operationId: string, state: "succeeded" | "rejected" | "uncertain", detail?: string): void;
  getBinding(id: string): Binding | null;
  listBindings(): Binding[];
  listSessions(chatId: string): SessionSummary[];
  listUnresolvedPaneCloseOperations(): PaneCloseOperation[];
  loadTopicView(bindingId: string): TopicViewState | null;
  transitionBinding(id: string, transition: SessionTransition): Binding;
  transitionBindingWithOutbox(input: { id: string; transition: SessionTransition; event: import("../events.js").BridgeEvent; view: TopicViewState; messageId: string; card: object }): Binding;
  updateBindingMetadata(id: string, patch: import("../types.js").BindingMetadataPatch): Binding;
}

export interface PaneControlStore extends Pick<PaneOperationsStore, "acceptPaneControlOperation" | "claimNextPaneControlOperation" | "claimPaneControlOperation" | "finishPaneControlOperation" | "getPaneControlOperation" | "listRecoverablePaneControlOperations" | "audit" | "getBinding" | "listBindings"> {}
export interface PaneCloseStore extends Pick<PaneOperationsStore, "audit" | "consumePaneCloseRequest" | "countPendingPrompts" | "createPaneCloseRequest" | "createAutomaticPaneCloseOperation" | "finishPaneCloseRequest" | "getBinding" | "listBindings" | "listUnresolvedPaneCloseOperations" | "transitionBinding"> {}
