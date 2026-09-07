import type { PromptAcceptanceStore } from "../../domain/ports/prompt-acceptance.js";
import type { PromptRunStore } from "../../domain/ports/prompt-run.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";
import type { SqliteBindingProjectionStore } from "./binding-projection-store.js";
import type { SqliteOperationsStore } from "./operations-store.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import type { SqlitePromptStore } from "./prompt-store.js";

export class SqlitePromptCapabilityStore implements PromptAcceptanceStore, PromptRunStore {
  constructor(
    private readonly prompts: SqlitePromptStore,
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly bindingProjections: SqliteBindingProjectionStore,
    private readonly projections: SqliteProjectionStore,
    private readonly operations: SqliteOperationsStore
  ) {}

  acceptPrompt(input: Parameters<PromptAcceptanceStore["acceptPrompt"]>[0]): ReturnType<PromptAcceptanceStore["acceptPrompt"]> { return this.prompts.acceptPrompt(input); }
  acceptPromptWithEffects(input: Parameters<PromptAcceptanceStore["acceptPromptWithEffects"]>[0]): ReturnType<PromptAcceptanceStore["acceptPromptWithEffects"]> { return this.prompts.acceptPromptWithEffects(input); }
  audit(input: Parameters<PromptAcceptanceStore["audit"]>[0]): void { this.operations.audit(input); }
  countPendingPrompts(bindingId: string): number { return this.prompts.countPendingPrompts(bindingId); }

  recoverRunningPrompts(): number { return this.prompts.recoverRunningPrompts(); }
  listDetachedPrompts(): ReturnType<PromptRunStore["listDetachedPrompts"]> { return this.prompts.listDetachedPrompts(); }
  skipOldestDetachedPrompt(input: Parameters<PromptRunStore["skipOldestDetachedPrompt"]>[0]): ReturnType<PromptRunStore["skipOldestDetachedPrompt"]> { return this.prompts.skipOldestDetachedPrompt(input); }
  settleDetachedPrompt(input: Parameters<PromptRunStore["settleDetachedPrompt"]>[0]): boolean { return this.prompts.settleDetachedPrompt(input); }
  scanDurablePromptWork(): ReturnType<PromptRunStore["scanDurablePromptWork"]> { return this.prompts.scanDurablePromptWork(); }
  listStaleUndispatchedPromptClaims(updatedBefore: string, limit: number): NonNullable<ReturnType<NonNullable<PromptRunStore["listStaleUndispatchedPromptClaims"]>>> { return this.prompts.listStaleUndispatchedPromptClaims(updatedBefore, limit); }
  requeueStaleUndispatchedPromptClaim(candidate: Parameters<NonNullable<PromptRunStore["requeueStaleUndispatchedPromptClaim"]>>[0]): boolean { return this.prompts.requeueStaleUndispatchedPromptClaim(candidate); }
  getBinding(id: string): ReturnType<PromptRunStore["getBinding"]> { return this.bindings.getBinding(id); }
  getPrompt(id: string): ReturnType<PromptRunStore["getPrompt"]> { return this.prompts.getPrompt(id); }
  claimNextDispatchablePrompt(bindingId: string): ReturnType<PromptRunStore["claimNextDispatchablePrompt"]> { return this.prompts.claimNextDispatchablePrompt(bindingId); }
  markPromptDispatched(id: string, dispatchedAt: string): void { this.prompts.markPromptDispatched(id, dispatchedAt); }
  markModelPromptPrepared(input: Parameters<PromptRunStore["markModelPromptPrepared"]>[0]): boolean { return this.prompts.markModelPromptPrepared(input); }
  markModelPromptAccepted(input: Parameters<PromptRunStore["markModelPromptAccepted"]>[0]): boolean { return this.prompts.markModelPromptAccepted(input); }
  rollbackPreparedModelPrompt(input: Parameters<PromptRunStore["rollbackPreparedModelPrompt"]>[0]): boolean { return this.prompts.rollbackPreparedModelPrompt(input); }
  claimPromptTranscriptTurn(input: Parameters<PromptRunStore["claimPromptTranscriptTurn"]>[0]): ReturnType<PromptRunStore["claimPromptTranscriptTurn"]> { return this.prompts.claimPromptTranscriptTurn(input); }
  markPromptObservationDetached(id: string, notice: string): void { this.prompts.markPromptObservationDetached(id, notice); }
  updatePrompt(id: string, state: Parameters<PromptRunStore["updatePrompt"]>[1], error?: string | null): void { this.prompts.updatePrompt(id, state, error); }
  completeTurn(input: Parameters<PromptRunStore["completeTurn"]>[0]): ReturnType<PromptRunStore["completeTurn"]> { return this.prompts.completeTurn(input); }
  failPrompt(input: Parameters<PromptRunStore["failPrompt"]>[0]): void { this.prompts.failPrompt(input); }
  updateBindingMetadata(...args: Parameters<PromptRunStore["updateBindingMetadata"]>): ReturnType<PromptRunStore["updateBindingMetadata"]> { return this.bindings.updateBindingMetadata(...args); }
  transitionBinding(...args: Parameters<PromptRunStore["transitionBinding"]>): ReturnType<PromptRunStore["transitionBinding"]> { return this.bindings.transitionBinding(...args); }
  listQueuedTurnRunCards(bindingId: string): ReturnType<PromptRunStore["listQueuedTurnRunCards"]> { return this.prompts.listQueuedTurnRunCards(bindingId); }
  loadRunCard(promptId: string): ReturnType<PromptRunStore["loadRunCard"]> { return this.projections.loadRunCard(promptId); }
  loadTopicView(bindingId: string): ReturnType<PromptRunStore["loadTopicView"]> { return this.projections.loadTopicView(bindingId); }
  transitionBindingWithOutbox(input: Parameters<PromptRunStore["transitionBindingWithOutbox"]>[0]): ReturnType<PromptRunStore["transitionBindingWithOutbox"]> { return this.bindingProjections.transitionBindingWithOutbox(input); }
}
