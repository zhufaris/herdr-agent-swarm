import type { PromptAcceptanceStore } from "../../domain/ports/prompt-acceptance.js";
import type { PromptDispatchStore, PromptRecoveryStore, PromptSessionStore } from "../../domain/ports/prompt-run.js";
import type { SqliteBindingLifecycleStore } from "./binding-store.js";
import type { SqliteBindingProjectionStore } from "./binding-projection-store.js";
import type { SqliteOperationsStore } from "./operations-store.js";
import type { SqliteProjectionStore } from "./projection-store.js";
import type { SqlitePromptStore } from "./prompt-store.js";
import type { SqlitePromptRecoveryStore } from "./prompt-recovery-store.js";
import type { SqlitePromptAcceptanceStore } from "./prompt-acceptance-store.js";
import type { SqlitePromptDispatchStore } from "./prompt-dispatch-store.js";

export class SqlitePromptAcceptanceCapabilityStore implements PromptAcceptanceStore {
  constructor(
    private readonly acceptance: SqlitePromptAcceptanceStore,
    private readonly prompts: SqlitePromptStore,
    private readonly operations: SqliteOperationsStore
  ) {}

  acceptPrompt: PromptAcceptanceStore["acceptPrompt"] = (input) => this.acceptance.acceptPrompt(input);
  acceptPromptWithEffects: PromptAcceptanceStore["acceptPromptWithEffects"] = (input) => this.acceptance.acceptPromptWithEffects(input);
  acceptInterruptedContinuation: PromptAcceptanceStore["acceptInterruptedContinuation"] = (input) => this.acceptance.acceptInterruptedContinuation(input);
  audit: PromptAcceptanceStore["audit"] = (input) => this.operations.audit(input);
  countPendingPrompts: PromptAcceptanceStore["countPendingPrompts"] = (id) => this.prompts.countPendingPrompts(id);
}

export class SqlitePromptDispatchCapabilityStore implements PromptDispatchStore {
  constructor(
    private readonly dispatch: SqlitePromptDispatchStore,
    private readonly recovery: SqlitePromptRecoveryStore,
    private readonly prompts: SqlitePromptStore,
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly projections: SqliteProjectionStore
  ) {}

  getBinding: PromptDispatchStore["getBinding"] = (id) => this.bindings.getBinding(id);
  getPrompt: PromptDispatchStore["getPrompt"] = (id) => this.dispatch.getPrompt(id);
  getActiveOrdinaryPrompt: PromptDispatchStore["getActiveOrdinaryPrompt"] = (id, generation) => this.dispatch.getActiveOrdinaryPrompt(id, generation);
  claimNextDispatchablePrompt: PromptDispatchStore["claimNextDispatchablePrompt"] = (id) => this.dispatch.claimNextDispatchablePrompt(id);
  markPromptDispatched: PromptDispatchStore["markPromptDispatched"] = (id, at) => this.dispatch.markPromptDispatched(id, at);
  markModelPromptPrepared: PromptDispatchStore["markModelPromptPrepared"] = (input) => this.dispatch.markModelPromptPrepared(input);
  markModelPromptAccepted: PromptDispatchStore["markModelPromptAccepted"] = (input) => this.dispatch.markModelPromptAccepted(input);
  rollbackPreparedModelPrompt: PromptDispatchStore["rollbackPreparedModelPrompt"] = (input) => this.dispatch.rollbackPreparedModelPrompt(input);
  claimPromptTranscriptTurn: PromptDispatchStore["claimPromptTranscriptTurn"] = (input) => this.dispatch.claimPromptTranscriptTurn(input);
  markPromptObservationDetached: PromptDispatchStore["markPromptObservationDetached"] = (id, notice) => this.recovery.markPromptObservationDetached(id, notice);
  completeTurn: PromptDispatchStore["completeTurn"] = (input) => this.dispatch.completeTurn(input);
  failPrompt: PromptDispatchStore["failPrompt"] = (input) => this.dispatch.failPrompt(input);
  transitionBinding: PromptDispatchStore["transitionBinding"] = (id, transition) => this.bindings.transitionBinding(id, transition);
  countPendingPrompts: PromptDispatchStore["countPendingPrompts"] = (id) => this.prompts.countPendingPrompts(id);
  loadRunCard: PromptDispatchStore["loadRunCard"] = (id) => this.projections.loadRunCard(id);
}

export class SqlitePromptRecoveryCapabilityStore implements PromptRecoveryStore {
  constructor(
    private readonly recovery: SqlitePromptRecoveryStore,
    private readonly dispatch: SqlitePromptDispatchStore,
    private readonly prompts: SqlitePromptStore,
    private readonly bindings: SqliteBindingLifecycleStore
  ) {}

  recoverRunningPrompts: PromptRecoveryStore["recoverRunningPrompts"] = () => this.recovery.recoverRunningPrompts();
  listDetachedPrompts: PromptRecoveryStore["listDetachedPrompts"] = () => this.recovery.listDetachedPrompts();
  skipOldestDetachedPrompt: PromptRecoveryStore["skipOldestDetachedPrompt"] = (input) => this.recovery.skipOldestDetachedPrompt(input);
  settleDetachedPrompt: PromptRecoveryStore["settleDetachedPrompt"] = (input) => this.recovery.settleDetachedPrompt(input);
  scanDurablePromptWork: PromptRecoveryStore["scanDurablePromptWork"] = () => this.recovery.scanDurablePromptWork();
  listStaleUndispatchedPromptClaims: PromptRecoveryStore["listStaleUndispatchedPromptClaims"] = (before, limit) => this.recovery.listStaleUndispatchedPromptClaims(before, limit);
  requeueStaleUndispatchedPromptClaim: PromptRecoveryStore["requeueStaleUndispatchedPromptClaim"] = (candidate) => this.recovery.requeueStaleUndispatchedPromptClaim(candidate);
  releaseUndispatchedPromptClaim: PromptRecoveryStore["releaseUndispatchedPromptClaim"] = (candidate) => this.recovery.releaseUndispatchedPromptClaim(candidate);
  getBinding: PromptRecoveryStore["getBinding"] = (id) => this.bindings.getBinding(id);
  getPrompt: PromptRecoveryStore["getPrompt"] = (id) => this.dispatch.getPrompt(id);
  markPromptObservationDetached: PromptRecoveryStore["markPromptObservationDetached"] = (id, notice) => this.recovery.markPromptObservationDetached(id, notice);
  countPendingPrompts: PromptRecoveryStore["countPendingPrompts"] = (id) => this.prompts.countPendingPrompts(id);
}

export class SqlitePromptSessionCapabilityStore implements PromptSessionStore {
  constructor(
    private readonly bindings: SqliteBindingLifecycleStore,
    private readonly bindingProjections: SqliteBindingProjectionStore,
    private readonly projections: SqliteProjectionStore
  ) {}

  getBinding: PromptSessionStore["getBinding"] = (id) => this.bindings.getBinding(id);
  loadTopicView: PromptSessionStore["loadTopicView"] = (id) => this.projections.loadTopicView(id);
  transitionBinding: PromptSessionStore["transitionBinding"] = (id, transition) => this.bindings.transitionBinding(id, transition);
  transitionBindingWithOutbox: PromptSessionStore["transitionBindingWithOutbox"] = (input) => this.bindingProjections.transitionBindingWithOutbox(input);
}
