import type { Logger } from "pino";
import { createBridgeEvent, type BridgeEventOf } from "../domain/create-bridge-event.js";
import type { BridgeEvent } from "../domain/events.js";
import type { HerdrPort, AgentTranscriptObservation, AgentTranscriptReaderPort } from "../domain/ports/external.js";
import type { DetachedPromptSkipResult } from "../domain/ports/prompt-acceptance.js";
import type { BindingPromptWorkflowPort } from "../domain/ports/prompt-acceptance.js";
import type { PromptDispatchStore, PromptRecoveryStore, PromptSessionStore } from "../domain/ports/prompt-run.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import type { Binding, EventOrigin, PromptJob, PromptWorkerDiagnostics } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkHint, PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { ShutdownContext } from "../runtime/shutdown-context.js";
import { PromptRunRegistry } from "./prompt-run-registry.js";
import { PromptSafetyScanner } from "./prompt-safety-scanner.js";
import type { MainCardConvergencePort } from "../domain/ports/card-convergence.js";
import { TranscriptObserver } from "./transcript-observer.js";
import { PromptTurnExecutor } from "./prompt-turn-executor.js";
import type { AgentDriverCatalog } from "../domain/agent-runtime.js";
import type { ActiveTurnSnapshot, PrimaryRuntimeStatePort } from "../domain/ports/primary-runtime-state.js";
import { DetachedPromptObserver } from "./detached-prompt-observer.js";
import { PrimaryPromptDispatcher } from "./primary-prompt-dispatcher.js";
import { assessDetachedPromptReceipt } from "./core-event-recovery.js";

export interface PromptRunWorkflowPort extends PrimaryRuntimeStatePort {
  prepareRecovery(): void;
  start(): void;
  requestSafetyScan(): void;
  snapshot(): PromptWorkerDiagnostics;
  awake(bindingId: string): Promise<{ outcome: "recovered"; recoveredTurns: number } | { outcome: "none" | "busy" | "unavailable"; reason: string }>;
  skipDetached(bindingId: string, expectedBindingGeneration: number, actorOpenId: string, sourceMessageId: string, rootMessageId: string | null): DetachedPromptSkipResult;
  stop(context?: ShutdownContext): Promise<void>;
}

interface PromptRunWorkflowOptions {
  stores: { dispatch: PromptDispatchStore; recovery: PromptRecoveryStore; session: PromptSessionStore };
  herdr: HerdrPort;
  bus: LifecycleEventPublisher;
  scheduler: PromptWorkScheduler;
  outboundWork: OutboundWorkNotifier;
  logger: Logger;
  presentation: Pick<PrimaryPresentation, "mainCard" | "paneEntryCard" | "answerCard" | "primaryHumanReviewNotification">;
  turnTimeoutMs: number;
  agentDrivers?: AgentDriverCatalog;
  shutdownGraceMs?: number;
  safetyScanIntervalMs?: number;
  supervisedSafetyScan?: boolean;
  staleClaimGraceMs?: number;
  detachedPromptAutoSkipMs?: number;
  transcriptReader?: AgentTranscriptReaderPort;
  adoptRuntimeIdentity(input: { bindingId: string; expectedPaneId: string; expectedGeneration: number; pane: import("../domain/types.js").HerdrPane }): import("../domain/types.js").RuntimeObservationApplication;
  transcriptPolling?: { identityMs: number; attachedMs: number };
  handoffExternalTurns?: (bindingId: string) => Promise<void>;
  observeSupersedingExternalTurn?: (binding: Binding, prompt: PromptJob, observation: AgentTranscriptObservation) => Promise<"ignored" | "pending" | "observing" | "completed">;
  recoverExternalTurns?: (binding: Binding, prompt: PromptJob) => Promise<{ outcome: "recovered"; recoveredTurns: number } | { outcome: "none" | "unavailable"; reason: string }>;
  onRecoveredPromptSettled?(promptId: string): void | Promise<void>;
  mainCards?: Pick<MainCardConvergencePort, "converge">;
  bindingPrompts: Pick<BindingPromptWorkflowPort, "applyCoreObservation" | "drainDueNativeInputBatch">;
}

export class PromptRunWorkflow implements PromptRunWorkflowPort {
  private readonly registry = new PromptRunRegistry();
  private readonly shutdownGraceMs: number;
  private readonly safetyScanner: PromptSafetyScanner;
  private readonly transcriptObserver: TranscriptObserver;
  private readonly detachedObserver: DetachedPromptObserver;
  private readonly turnExecutor: PromptTurnExecutor;
  private readonly dispatcher: PrimaryPromptDispatcher;
  private readonly batchTimers = new Map<string, ReturnType<typeof setTimeout>>();
  private readonly batchReconciliations = new Map<string, Promise<void>>();
  private readonly pendingWorkerWakes = new Set<string>();
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private stopping = false;
  constructor(private readonly options: PromptRunWorkflowOptions) {
    this.shutdownGraceMs = options.shutdownGraceMs ?? 30_000;
    const intervalMs = options.safetyScanIntervalMs ?? 5_000;
    this.safetyScanner = new PromptSafetyScanner({
      store: options.stores.recovery, scheduler: options.scheduler, logger: options.logger, intervalMs,
      staleClaimGraceMs: options.staleClaimGraceMs ?? Math.max(10_000, intervalMs * 2),
      isBindingOwned: (bindingId) => this.registry.hasWorker(bindingId) || this.registry.hasTurn(bindingId),
      maintainObserverCaches: () => this.transcriptObserver.prune(),
      externallyScheduled: options.supervisedSafetyScan ?? false
    });
    this.transcriptObserver = new TranscriptObserver({
      store: options.stores.dispatch, herdr: options.herdr, adoptRuntimeIdentity: options.adoptRuntimeIdentity, ...(options.transcriptReader ? { reader: options.transcriptReader } : {}), logger: options.logger,
      ...(options.transcriptPolling ? { identityPollMs: options.transcriptPolling.identityMs, attachedPollMs: options.transcriptPolling.attachedMs } : {}),
      isBindingActive: (bindingId) => this.isBindingActive(bindingId), isStopping: () => this.stopping,
      publishObservation: async (bindingId, promptId, observation) => {
        await this.publish(bindingId, "TurnOutputObserved", "herdr", { promptId, observation });
      },
      workflow: options.bindingPrompts
    });
    this.detachedObserver = new DetachedPromptObserver({
      store: options.stores.recovery, herdr: options.herdr, transcript: this.transcriptObserver, registry: this.registry, logger: options.logger,
      isBindingActive: (bindingId) => this.isBindingActive(bindingId), isStopping: () => this.stopping,
      ...(options.observeSupersedingExternalTurn ? { observeSupersedingExternalTurn: options.observeSupersedingExternalTurn } : {}),
      ...(options.onRecoveredPromptSettled ? { onSettled: options.onRecoveredPromptSettled } : {}),
      renderRunCard: options.presentation.answerCard,
      publish: (bindingId, type, origin, payload) => this.publish(bindingId, type, origin, payload)
    });
    this.turnExecutor = new PromptTurnExecutor({
      store: options.stores.dispatch, herdr: options.herdr, ...(options.agentDrivers ? { agentDrivers: options.agentDrivers } : {}), transcript: this.transcriptObserver, bindingPrompts: options.bindingPrompts, logger: options.logger, turnTimeoutMs: options.turnTimeoutMs,
      isBindingActive: (bindingId) => this.isBindingActive(bindingId), isStopping: () => this.stopping,
      updateTurnState: (bindingId, promptId, state) => this.registry.updateTurnState(bindingId, promptId, state),
      renderHumanReviewNotification: options.presentation.primaryHumanReviewNotification,
      wakeOutbound: () => options.outboundWork.wake(),
      convergeMainCard: (bindingId) => this.convergeMainCard(bindingId),
      releaseUndispatched: ({ binding, prompt }) => this.options.stores.recovery.releaseUndispatchedPromptClaim({ promptId: prompt.id, bindingId: binding.id, updatedAt: prompt.updatedAt, bindingGeneration: binding.generation, paneId: binding.paneId! }),
      observeDetached: (prompt, binding, source, controller) => this.detachedObserver.observeSource(prompt, binding, source, controller),
      publish: (bindingId, type, origin, payload) => this.publish(bindingId, type, origin, payload)
    });
    this.dispatcher = new PrimaryPromptDispatcher({
      stores: options.stores, herdr: options.herdr, executor: this.turnExecutor, registry: this.registry, scheduler: options.scheduler, logger: options.logger,
      isStopping: () => this.stopping,
      ...(options.handoffExternalTurns ? { handoffExternalTurns: options.handoffExternalTurns } : {}),
      convergeMainCard: (bindingId) => this.convergeMainCard(bindingId),
      archiveDrainedBinding: (binding) => this.archiveDrainedBinding(binding)
    });
  }

  prepareRecovery(): void {
    const recovered = this.options.stores.recovery.recoverRunningPrompts();
    if (recovered > 0) this.options.logger.warn({ event: "startup-prompts-recovered", recovered, outcome: "detached_without_replay" }, "detached from interrupted prompt observers without replay");
  }

  start(): void {
    if (this.unsubscribe) return;
    this.stopping = false;
    this.started = true;
    this.unsubscribe = this.options.scheduler.subscribe((event) => this.wake(event));
    this.safetyScanner.start();
  }

  requestSafetyScan(): void {
    if (this.stopping) return;
    this.safetyScanner.request();
  }

  snapshot(): PromptWorkerDiagnostics {
    const safety = this.safetyScanner.snapshot();
    return {
      state: this.stopping ? "stopping" : this.started ? "running" : "idle",
      activeTurnWorkers: this.registry.activeWorkerCount,
      nativeSubmissionWorkers: 0,
      ...safety
    };
  }

  wake(event: PromptWorkHint): void {
    if (this.stopping) return;
    try {
      if (event.kind === "detached-observer-ready") {
        const prompt = this.options.stores.recovery.getPrompt(event.promptId);
        if (prompt?.bindingId === event.bindingId && prompt.executionOrigin !== "herdr" && (
          ((prompt.state === "running" || prompt.state === "recovering") && prompt.observationState === "detached")
          || ((prompt.state === "uncertain" || prompt.state === "cancelled") && prompt.observationState === "completed")
        )) this.scheduleDetachedObserver(prompt);
        return;
      }
      if (event.kind === "binding-runtime-changed" && !this.isBindingActive(event.bindingId)) this.registry.abortTurn(event.bindingId);
      if (event.kind === "prompt-ready" && this.registry.hasWorker(event.bindingId)) {
        this.pendingWorkerWakes.add(event.bindingId);
        void this.reconcileNativeInputBatch(event.bindingId);
        return;
      }
      this.scheduleWorker(event.bindingId);
    } finally {
      this.safetyScanner.resetCadence();
    }
  }

  activeTurn(bindingId: string): ActiveTurnSnapshot | null {
    return this.registry.activeTurn(bindingId);
  }

  isBindingBusy(bindingId: string): boolean {
    return this.registry.isBindingBusy(bindingId);
  }

  async awake(bindingId: string): Promise<{ outcome: "recovered"; recoveredTurns: number } | { outcome: "none" | "busy" | "unavailable"; reason: string }> {
    const prompt = this.options.stores.recovery.listDetachedPrompts().find((candidate) => candidate.bindingId === bindingId);
    if (!prompt) return { outcome: "none", reason: "no_detached_prompt" };
    const binding = this.options.stores.recovery.getBinding(bindingId);
    if (!binding?.paneId || binding.state !== "active" || binding.lifecycle !== "active") return { outcome: "unavailable", reason: "binding_not_active" };
    if (!this.options.recoverExternalTurns) return { outcome: "unavailable", reason: "recovery_unavailable" };
    const existing = this.registry.worker(bindingId);
    if (existing) {
      this.registry.abortTurn(bindingId);
      await existing;
    }
    if (this.registry.hasWorker(bindingId)) return { outcome: "busy", reason: "binding_busy" };
    const recovery = this.options.recoverExternalTurns(binding, prompt);
    const worker = recovery.then(() => undefined);
    this.registry.registerWorker(bindingId, worker);
    try {
      const result = await recovery;
      if (result.outcome === "recovered") await this.notifyRecoveredPromptSettled(prompt.id);
      return result;
    } finally {
      this.registry.releaseWorker(bindingId, worker);
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId });
    }
  }

  skipDetached(bindingId: string, expectedBindingGeneration: number, actorOpenId: string, sourceMessageId: string, rootMessageId: string | null): DetachedPromptSkipResult {
    const result = this.options.stores.recovery.skipOldestDetachedPrompt({
      bindingId, expectedBindingGeneration, actorOpenId, sourceMessageId, rootMessageId,
      reason: "人工跳过；此前执行结果不确定，任务不会自动重放。",
      occurredAt: new Date().toISOString(), renderRunCard: this.options.presentation.answerCard
    });
    this.options.logger.info({ event: "detached-prompt-skip", bindingId, promptId: result.outcome === "skipped" ? result.promptId : null, actorOpenId, sourceMessageId, outcome: result.outcome }, "processed explicit detached prompt skip");
    if (result.outcome === "skipped") {
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId });
      if (result.outboxReserved) this.options.outboundWork.wake();
      this.safetyScanner.request();
    }
    return result;
  }

  async stop(context?: ShutdownContext): Promise<void> {
    this.stopping = true;
    this.transcriptObserver.clear();
    this.safetyScanner.stop();
    for (const timer of this.batchTimers.values()) clearTimeout(timer);
    this.batchTimers.clear();
    this.pendingWorkerWakes.clear();
    this.unsubscribe?.();
    this.unsubscribe = null;
    const pending = [...this.registry.pendingWorkers, ...this.batchReconciliations.values()];
    if (!pending.length) return;
    const settled = Promise.allSettled(pending);
    let didSettle = false;
    void settled.then(() => { didSettle = true; });
    const abortObservers = () => {
      this.options.logger.warn({ event: "bridge-shutdown-turns-aborted", activeTurns: this.registry.activeTurnCount, graceMs: context?.remainingMs() ?? this.shutdownGraceMs, outcome: "aborted" }, "aborting Bridge prompt waiters after shutdown grace period");
      this.registry.abortAll((run) => {
        this.options.stores.recovery.markPromptObservationDetached(run.promptId, "Bridge 已停止观察，但 TraeX 任务可能仍在运行；重启后会继续观察，不会重复发送请求。");
      });
    };
    if (context?.signal.aborted) abortObservers();
    else if (context) {
      await waitForSettlementOrAbort(settled, context.signal);
      if (!didSettle) abortObservers();
      await settled;
    } else if (!await settlesWithin(settled, this.shutdownGraceMs)) {
      abortObservers();
      await settled;
    }
  }

  private scheduleWorker(bindingId: string): void {
    if (this.registry.hasWorker(bindingId)) return;
    const worker = this.reconcileNativeInputBatch(bindingId)
      .then(() => this.dispatcher.drain(bindingId))
      .finally(() => {
        this.registry.releaseWorker(bindingId, worker);
        if (!this.stopping && this.pendingWorkerWakes.delete(bindingId)) this.scheduleWorker(bindingId);
      });
    this.registry.registerWorker(bindingId, worker);
  }

  private reconcileNativeInputBatch(bindingId: string): Promise<void> {
    const existing = this.batchReconciliations.get(bindingId);
    if (existing) return existing;
    const reconciliation = this.options.bindingPrompts.drainDueNativeInputBatch(bindingId)
      .then((result) => this.scheduleNativeInputBatchWake(bindingId, result.nextDueAt))
      .catch((error) => {
        this.options.logger.warn({ event: "native-input-batch-reconciliation-failed", err: safeLogError(error), bindingId, outcome: "deferred_to_reconciliation" }, "deferred Native Input Batch reconciliation after a transient failure");
      })
      .finally(() => this.batchReconciliations.delete(bindingId));
    this.batchReconciliations.set(bindingId, reconciliation);
    return reconciliation;
  }

  private scheduleNativeInputBatchWake(bindingId: string, dueAt: string | null): void {
    const existing = this.batchTimers.get(bindingId);
    if (existing) clearTimeout(existing);
    this.batchTimers.delete(bindingId);
    if (!dueAt || this.stopping) return;
    const timer = setTimeout(() => {
      this.batchTimers.delete(bindingId);
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId });
    }, Math.max(0, Date.parse(dueAt) - Date.now()));
    timer.unref?.();
    this.batchTimers.set(bindingId, timer);
  }

  private scheduleDetachedObserver(prompt: PromptJob): void {
    if (this.registry.hasWorker(prompt.bindingId)) return;
    let requestRecoveryRescan = false;
    const worker = this.tryRecoverProjectedBridgeTurn(prompt)
      .then(async (historicalRecovery) => {
        if (historicalRecovery === "recovered" || historicalRecovery === "needs_human") return;
        if (historicalRecovery === "turn_owned_by_other_prompt") {
          requestRecoveryRescan = await this.tryAutoSkip(prompt);
          return;
        }
        const recovery = await assessDetachedPromptReceipt({ prompt, store: this.options.stores.dispatch, ...(this.options.transcriptReader ? { reader: this.options.transcriptReader } : {}) });
        if (recovery.outcome === "owned") await this.detachedObserver.observe(recovery.prompt);
        else if (recovery.outcome === "accepted") {
          this.persistRecoveredNativeReceipt(recovery.prompt);
          requestRecoveryRescan = await this.tryAutoSkip(recovery.prompt);
        } else if (recovery.outcome === "uncertain") {
          this.persistRecoveredNativeReceipt(recovery.prompt, "Core reported an uncertain native submission; it will not be replayed");
          requestRecoveryRescan = await this.tryAutoSkip(recovery.prompt);
        } else if (recovery.outcome === "rejected") {
          requestRecoveryRescan = this.releaseRejectedNativeReceipt(recovery.prompt);
        }
        else if (isQualifyingDetachedRecovery(recovery)) requestRecoveryRescan = await this.tryAutoSkip(prompt);
      }).catch((error) => {
        this.options.logger.warn({ event: "detached-prompt-ownership-recovery-failed", err: safeLogError(error), bindingId: prompt.bindingId, promptId: prompt.id, outcome: "deferred" }, "deferred detached Prompt ownership recovery after a transient Core failure");
      }).finally(() => {
        this.registry.releaseWorker(prompt.bindingId, worker);
        const latest = this.options.stores.recovery.getPrompt(prompt.id);
        const stillOwnsExecutionSlot = latest?.state === "running" && latest.observationState === "detached";
        if (!this.stopping && latest && !stillOwnsExecutionSlot) {
          this.options.scheduler.wake({ kind: "prompt-ready", bindingId: prompt.bindingId });
        }
        if (!this.stopping && requestRecoveryRescan) this.safetyScanner.request();
      });
    this.registry.registerWorker(prompt.bindingId, worker);
  }

  private async tryRecoverProjectedBridgeTurn(prompt: PromptJob): Promise<"recovered" | "needs_human" | "turn_owned_by_other_prompt" | "unresolved"> {
    if (typeof this.options.stores.recovery.recoverProjectedBridgeTurn !== "function") return "unresolved";
    const binding = this.options.stores.recovery.getBinding(prompt.bindingId);
    if (!binding?.paneId || !binding.agentSessionValue) return "unresolved";
    const recovery = this.options.stores.recovery.recoverProjectedBridgeTurn({
      promptId: prompt.id,
      bindingId: binding.id,
      expectedBindingGeneration: binding.generation,
      expectedPaneId: binding.paneId,
      expectedNativeSessionId: binding.agentSessionValue,
      occurredAt: new Date().toISOString(),
      renderRunCard: this.options.presentation.answerCard
    });
    if (recovery.outcome === "turn_owned_by_other_prompt") return recovery.outcome;
    if (recovery.outcome === "needs_human") {
      if (recovery.outboxReserved) this.options.outboundWork.wake();
      await this.notifyRecoveredPromptSettled(prompt.id);
      return "needs_human";
    }
    if (recovery.outcome !== "recovered") return "unresolved";
    if ("recoveryMode" in recovery && recovery.recoveryMode === "late") {
      if (recovery.outboxReserved) this.options.outboundWork.wake();
      await this.notifyRecoveredPromptSettled(prompt.id);
      this.options.logger.info({
        event: "uncertain-prompt-projected-turn-repaired", bindingId: binding.id, promptId: prompt.id,
        paneId: binding.paneId, turnId: recovery.turnId, terminalState: recovery.terminalState, outcome: "recovered"
      }, "repaired an uncertain Bridge Prompt from exact projected Core evidence on a separate continuation");
      return "recovered";
    }
    if (recovery.terminalState === "completed") {
      await this.publish(binding.id, "TurnCompleted", "herdr", {
        promptId: prompt.id,
        answer: recovery.answer,
        queueDepth: this.options.stores.recovery.countPendingPrompts(binding.id)
      });
    } else {
      await this.publish(binding.id, "TurnFailed", "herdr", {
        promptId: prompt.id,
        error: recovery.error,
        queueDepth: this.options.stores.recovery.countPendingPrompts(binding.id)
      });
    }
    await this.notifyRecoveredPromptSettled(prompt.id);
    this.options.logger.info({
      event: "detached-prompt-projected-turn-recovered", bindingId: binding.id, promptId: prompt.id,
      paneId: binding.paneId, turnId: recovery.turnId, terminalState: recovery.terminalState, outcome: "recovered"
    }, "recovered detached Bridge Prompt from durable projected Core events");
    return "recovered";
  }

  private persistRecoveredNativeReceipt(prompt: PromptJob, uncertainReason?: string): void {
    if (!prompt.nativeSubmissionId || !prompt.dispatchedAt) return;
    this.options.stores.dispatch.applyPromptNativeSubmissionReceipt({
      promptId: prompt.id, bindingId: prompt.bindingId, submissionId: prompt.nativeSubmissionId,
      dispatchedAt: prompt.dispatchedAt, state: uncertainReason ? "uncertain" : "accepted",
      notice: uncertainReason ?? "Core confirmed the native submission; observing execution without replay"
    });
  }

  private releaseRejectedNativeReceipt(prompt: PromptJob): boolean {
    if (!prompt.nativeSubmissionId || !prompt.dispatchedAt) return false;
    return this.options.stores.dispatch.releaseRejectedNativeSubmission({
      promptId: prompt.id, bindingId: prompt.bindingId, submissionId: prompt.nativeSubmissionId, dispatchedAt: prompt.dispatchedAt
    });
  }

  private async tryAutoSkip(prompt: PromptJob): Promise<boolean> {
    const timeoutMs = this.options.detachedPromptAutoSkipMs ?? 0;
    if (timeoutMs === 0) return false;
    const current = this.options.stores.recovery.getPrompt(prompt.id);
    const binding = this.options.stores.recovery.getBinding(prompt.bindingId);
    if (!current || !binding?.paneId || !binding.agentSessionValue || current.state !== "recovering" || current.observationState !== "detached" || current.transcriptTurnId || current.transcriptTurnStartedAt) return false;
    const dispatchedAt = Date.parse(current.dispatchedAt ?? current.createdAt);
    const occurredAt = new Date();
    if (!Number.isFinite(dispatchedAt)) return false;
    const runtime = await this.options.herdr.observeRuntime(binding.paneId);
    if (!runtime.pane || runtime.pane.paneId !== binding.paneId || runtime.pane.agentSession?.value !== binding.agentSessionValue || !["idle", "done"].includes(runtime.pane.agentState)) return false;
    const result = this.options.stores.recovery.advanceDetachedPromptRecovery({
      promptId: current.id,
      bindingId: binding.id,
      expectedBindingGeneration: binding.generation,
      expectedPaneId: binding.paneId,
      expectedNativeSessionId: binding.agentSessionValue,
      expiredBefore: new Date(occurredAt.getTime() - timeoutMs).toISOString(),
      reason: "⚠ 无法确认该请求的最终执行结果，已跳过；请求不会自动重放，后续队列继续处理。",
      occurredAt: occurredAt.toISOString(),
      renderRunCard: this.options.presentation.answerCard
    });
    this.options.logger.warn({
      event: "detached-prompt-recovery-advanced", bindingId: binding.id, promptId: current.id, paneId: binding.paneId,
      outcome: result.outcome, attemptCount: result.outcome === "stale" ? null : result.attemptCount,
      nextAttemptAt: result.outcome === "deferred" || result.outcome === "observed" ? result.nextAttemptAt : null
    }, "advanced bounded recovery for a Core-unrecoverable detached Prompt without replay");
    if (result.outcome === "skipped") {
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
      if (result.outboxReserved) this.options.outboundWork.wake();
      return true;
    }
    return false;
  }

  private isBindingActive(bindingId: string): boolean {
    const binding = this.options.stores.session.getBinding(bindingId);
    return binding?.state === "active" && binding.lifecycle === "active";
  }

  private async archiveDrainedBinding(binding: Binding): Promise<void> {
    const event = createBridgeEvent(binding.id, "BindingArchived", "bridge", { reason: "当前任务已结束，话题归档完成；Herdr pane 与 TraeX 保持运行。" });
    const current = this.options.stores.session.loadTopicView(binding.id) ?? initialTopicView(binding.id);
    const view = reduceTopicView(current, event);
    if (!binding.statusMessageId) {
      this.options.stores.session.transitionBinding(binding.id, { type: "drain_completed" });
      await this.options.bus.publish(event);
      return;
    }
    this.options.stores.session.transitionBindingWithOutbox({ id: binding.id, transition: { type: "drain_completed" }, event, view, messageId: binding.statusMessageId, card: this.options.presentation.mainCard(view), paneEntryCard: this.options.presentation.paneEntryCard(view) });
    this.options.outboundWork.wake();
    await this.options.bus.publish(event);
  }

  private async publish<T extends BridgeEvent["type"]>(bindingId: string, type: T, origin: EventOrigin, payload: BridgeEventOf<T>["payload"]): Promise<void> {
    await this.options.bus.publish(createBridgeEvent(bindingId, type, origin, payload));
  }

  private async convergeMainCard(bindingId: string): Promise<void> {
    try { await this.options.mainCards?.converge(bindingId); }
    catch (error) { this.options.logger.warn({ event: "model-main-card-convergence-failed", err: safeLogError(error), bindingId, outcome: "deferred" }, "deferred model state projection to normal Main Card convergence"); }
  }

  private async notifyRecoveredPromptSettled(promptId: string): Promise<void> {
    try { await this.options.onRecoveredPromptSettled?.(promptId); }
    catch (error) {
      this.options.logger.warn({ event: "recovered-prompt-delivery-wake-failed", err: safeLogError(error), promptId, outcome: "deferred_to_scan" }, "Could not wake downstream delivery recovery; periodic recovery will retry");
    }
  }
}

const QUALIFYING_DETACHED_RECOVERY_REASONS = new Set([
  "missing_submission_identity",
  "submission_identity_mismatch",
  "submission_not_observed",
  "submission_receipt_unavailable",
  "submission_cancelled",
  "legacy_submission_unavailable",
  "submission_receipt_identity_mismatch",
  "submission_receipt_session_mismatch",
  "submission_terminal_without_event"
]);

function isQualifyingDetachedRecovery(recovery: Awaited<ReturnType<typeof assessDetachedPromptReceipt>>): boolean {
  if (recovery.outcome !== "pending" && recovery.outcome !== "unavailable") return false;
  return QUALIFYING_DETACHED_RECOVERY_REASONS.has(recovery.reason);
}

function settlesWithin(promise: Promise<unknown>, timeoutMs: number): Promise<boolean> {
  if (timeoutMs <= 0) return Promise.resolve(false);
  return new Promise((resolve) => {
    const timer = setTimeout(() => resolve(false), timeoutMs);
    timer.unref();
    void promise.then(() => { clearTimeout(timer); resolve(true); });
  });
}

function waitForSettlementOrAbort(promise: Promise<unknown>, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.resolve();
  return new Promise((resolve) => {
    const onAbort = () => { cleanup(); resolve(); };
    const cleanup = () => signal.removeEventListener("abort", onAbort);
    signal.addEventListener("abort", onAbort, { once: true });
    void promise.then(() => { cleanup(); resolve(); }, () => { cleanup(); resolve(); });
  });
}
