import type { Logger } from "pino";
import { createBridgeEvent, type BridgeEventOf } from "../domain/create-bridge-event.js";
import type { BridgeEvent } from "../domain/events.js";
import type { HerdrPort, TraexTranscriptObservation, TraexTranscriptReaderPort } from "../domain/ports/external.js";
import type { DetachedPromptSkipResult, PromptRunStore } from "../domain/ports/prompt.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import type { Binding, EventOrigin, PromptJob, PromptWorkerDiagnostics } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkHint, PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { outputFingerprint } from "../runtime/output.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { ShutdownContext } from "../runtime/shutdown-context.js";
import { PromptRunRegistry } from "./prompt-run-registry.js";
import { abortedPromptNotice, decideDetachedTurnTerminalOutcome, isLaterConflictingTranscriptTurn } from "./prompt-execution-lifecycle.js";
import { PromptSafetyScanner } from "./prompt-safety-scanner.js";
import type { MainCardWorkflowPort } from "./main-card-workflow.js";
import { TranscriptObserver, type TurnOutputSource } from "./transcript-observer.js";
import { PromptTurnExecutor } from "./prompt-turn-executor.js";

export interface ActiveTurnSnapshot {
  promptId: string;
  paneId: string;
  state: Binding["lastAgentState"];
}

export interface PromptRunWorkflowPort {
  prepareRecovery(): void;
  start(): void;
  requestSafetyScan(): void;
  snapshot(): PromptWorkerDiagnostics;
  activeTurn(bindingId: string): ActiveTurnSnapshot | null;
  isBindingBusy(bindingId: string): boolean;
  awake(bindingId: string): Promise<{ outcome: "recovered"; recoveredTurns: number } | { outcome: "none" | "busy" | "unavailable"; reason: string }>;
  skipDetached(bindingId: string, expectedBindingGeneration: number, actorOpenId: string, sourceMessageId: string, rootMessageId: string | null): DetachedPromptSkipResult;
  stop(context?: ShutdownContext): Promise<void>;
}

interface PromptRunWorkflowOptions {
  store: PromptRunStore;
  herdr: HerdrPort;
  bus: LifecycleEventPublisher;
  scheduler: PromptWorkScheduler;
  outboundWork: OutboundWorkNotifier;
  logger: Logger;
  presentation: Pick<PrimaryPresentation, "mainCard" | "answerCard">;
  turnTimeoutMs: number;
  shutdownGraceMs?: number;
  safetyScanIntervalMs?: number;
  staleClaimGraceMs?: number;
  transcriptReader?: TraexTranscriptReaderPort;
  handoffExternalTurns?: (bindingId: string) => Promise<void>;
  observeSupersedingExternalTurn?: (binding: Binding, prompt: PromptJob, observation: TraexTranscriptObservation) => Promise<"ignored" | "pending" | "observing" | "completed">;
  recoverExternalTurns?: (binding: Binding, prompt: PromptJob) => Promise<{ outcome: "recovered"; recoveredTurns: number } | { outcome: "none" | "unavailable"; reason: string }>;
  mainCards?: Pick<MainCardWorkflowPort, "converge">;
}

const STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE = "⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。";

export class PromptRunWorkflow implements PromptRunWorkflowPort {
  private readonly registry = new PromptRunRegistry();
  private readonly shutdownGraceMs: number;
  private readonly safetyScanner: PromptSafetyScanner;
  private readonly transcriptObserver: TranscriptObserver;
  private readonly turnExecutor: PromptTurnExecutor;
  private unsubscribe: (() => void) | null = null;
  private started = false;
  private stopping = false;
  private readonly legacyDetachedWithoutIdentity = new Set<string>();

  constructor(private readonly options: PromptRunWorkflowOptions) {
    this.shutdownGraceMs = options.shutdownGraceMs ?? 30_000;
    const intervalMs = options.safetyScanIntervalMs ?? 5_000;
    this.safetyScanner = new PromptSafetyScanner({
      store: options.store, scheduler: options.scheduler, logger: options.logger, intervalMs,
      staleClaimGraceMs: options.staleClaimGraceMs ?? Math.max(10_000, intervalMs * 2),
      isBindingOwned: (bindingId) => this.registry.hasWorker(bindingId) || this.registry.hasTurn(bindingId),
      pruneDetachedTracking: () => this.pruneDetachedTracking()
    });
    this.transcriptObserver = new TranscriptObserver({
      store: options.store, ...(options.transcriptReader ? { reader: options.transcriptReader } : {}), logger: options.logger,
      isBindingActive: (bindingId) => this.isBindingActive(bindingId), isStopping: () => this.stopping,
      publishObservation: async (bindingId, promptId, observation) => {
        await this.publish(bindingId, "TurnOutputObserved", "herdr", { promptId, observation });
      }
    });
    this.turnExecutor = new PromptTurnExecutor({
      store: options.store, herdr: options.herdr, transcript: this.transcriptObserver, logger: options.logger, turnTimeoutMs: options.turnTimeoutMs,
      isBindingActive: (bindingId) => this.isBindingActive(bindingId), isStopping: () => this.stopping,
      updateTurnState: (bindingId, promptId, state) => this.registry.updateTurnState(bindingId, promptId, state),
      convergeMainCard: (bindingId) => this.convergeMainCard(bindingId),
      observeDetached: (prompt, binding, source, controller) => this.observeDetachedTurnWithSource(prompt, binding, source, controller),
      publish: (bindingId, type, origin, payload) => this.publish(bindingId, type, origin, payload)
    });
  }

  prepareRecovery(): void {
    const recovered = this.options.store.recoverRunningPrompts();
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
      activeTurnWorkers: this.registry.activeWorkerCount, activeSteeringWorkers: this.registry.activeSteeringWorkerCount,
      ...safety
    };
  }

  wake(event: PromptWorkHint): void {
    if (this.stopping) return;
    try {
      if (event.kind === "steering-ready") {
        this.scheduleSteering(event.bindingId, event.parentPromptId);
        return;
      }
      if (event.kind === "detached-observer-ready") {
        const prompt = this.options.store.getPrompt(event.promptId);
        if (prompt?.bindingId === event.bindingId && prompt.state === "running" && prompt.observationState === "detached") this.scheduleDetachedObserver(prompt);
        return;
      }
      if (event.kind === "binding-runtime-changed" && !this.isBindingActive(event.bindingId)) this.registry.abortTurn(event.bindingId);
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
    const prompt = this.options.store.listDetachedPrompts().find((candidate) => candidate.bindingId === bindingId);
    if (!prompt) return { outcome: "none", reason: "no_detached_prompt" };
    const binding = this.options.store.getBinding(bindingId);
    if (!binding?.paneId || binding.state !== "active" || binding.lifecycle !== "active") return { outcome: "unavailable", reason: "binding_not_active" };
    if (!this.options.recoverExternalTurns) return { outcome: "unavailable", reason: "recovery_unavailable" };
    const existing = this.registry.worker(bindingId);
    if (existing) {
      this.registry.abortTurn(bindingId);
      await existing;
    }
    if (this.registry.hasWorker(bindingId) || this.registry.hasSteeringWorker(bindingId)) return { outcome: "busy", reason: "binding_busy" };
    const recovery = this.options.recoverExternalTurns(binding, prompt);
    const worker = recovery.then(() => undefined);
    this.registry.registerWorker(bindingId, worker);
    try {
      return await recovery;
    } finally {
      this.registry.releaseWorker(bindingId, worker);
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId });
    }
  }

  skipDetached(bindingId: string, expectedBindingGeneration: number, actorOpenId: string, sourceMessageId: string, rootMessageId: string | null): DetachedPromptSkipResult {
    const result = this.options.store.skipOldestDetachedPrompt({
      bindingId, expectedBindingGeneration, actorOpenId, sourceMessageId, rootMessageId,
      reason: "人工跳过；此前执行结果不确定，任务不会自动重放。",
      occurredAt: new Date().toISOString(), renderRunCard: this.options.presentation.answerCard
    });
    this.options.logger.info({ event: "detached-prompt-skip", bindingId, promptId: result.outcome === "skipped" ? result.promptId : null, actorOpenId, sourceMessageId, outcome: result.outcome }, "processed explicit detached prompt skip");
    if (result.outcome === "skipped") {
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId });
      if (result.outboxReserved) this.options.outboundWork.wake();
    }
    return result;
  }

  async stop(context?: ShutdownContext): Promise<void> {
    this.stopping = true;
    this.legacyDetachedWithoutIdentity.clear();
    this.transcriptObserver.clear();
    this.safetyScanner.stop();
    this.unsubscribe?.();
    this.unsubscribe = null;
    const pending = this.registry.pendingWorkers;
    if (!pending.length) return;
    const settled = Promise.allSettled(pending);
    let didSettle = false;
    void settled.then(() => { didSettle = true; });
    const abortObservers = () => {
      this.options.logger.warn({ event: "bridge-shutdown-turns-aborted", activeTurns: this.registry.activeTurnCount, graceMs: context?.remainingMs() ?? this.shutdownGraceMs, outcome: "aborted" }, "aborting Bridge prompt waiters after shutdown grace period");
      this.registry.abortAll((run) => {
        this.options.store.markPromptObservationDetached(run.promptId, "Bridge 已停止观察，但 TraeX 任务可能仍在运行；重启后会继续观察，不会重复发送请求。");
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

  private scheduleSteering(bindingId: string, parentPromptId: string): void {
    const previous = this.registry.steeringWorker(bindingId) ?? Promise.resolve();
    const worker = previous.catch(() => undefined).then(() => this.drainSteering(bindingId, parentPromptId)).finally(() => {
      this.registry.releaseSteeringWorker(bindingId, worker);
    });
    this.registry.registerSteeringWorker(bindingId, worker);
  }

  private pruneDetachedTracking(): void {
    for (const promptId of this.legacyDetachedWithoutIdentity) {
      const prompt = this.options.store.getPrompt(promptId);
      if (!prompt || prompt.state !== "running" || prompt.observationState !== "detached") this.legacyDetachedWithoutIdentity.delete(promptId);
    }
    this.transcriptObserver.prune();
  }

  private async drainSteering(bindingId: string, parentPromptId: string): Promise<void> {
    for (let prompt = this.options.store.claimNextReadySteering(bindingId, parentPromptId); prompt; prompt = this.options.store.claimNextReadySteering(bindingId, parentPromptId)) {
      const message = "Steering is unsupported; text was not injected and will not be replayed.";
      this.options.store.failPrompt({ promptId: prompt.id, error: message, occurredAt: new Date().toISOString(), steeringFailureKind: "rejected" });
      await this.publish(bindingId, "SteeringFailed", "bridge", { promptId: prompt.id, parentPromptId, error: message, failureKind: "rejected", automatic: prompt.steeringOrigin === "automatic" });
      this.options.logger.warn({ event: "steering-rejected", bindingId, promptId: prompt.id, parentPromptId, outcome: "failed", reason: "unsupported" }, "rejected legacy steering work without terminal input");
    }
  }

  private scheduleWorker(bindingId: string): void {
    if (this.registry.hasWorker(bindingId)) return;
    const worker = this.drain(bindingId).finally(() => {
      this.registry.releaseWorker(bindingId, worker);
    });
    this.registry.registerWorker(bindingId, worker);
  }

  private async drain(bindingId: string): Promise<void> {
    while (!this.stopping) {
      if (this.options.handoffExternalTurns) await this.options.handoffExternalTurns(bindingId);
      const claimed = this.options.store.claimNextDispatchablePrompt(bindingId);
      if (!claimed) return;
      const { binding, prompt, model } = claimed;
      if (model) await this.convergeMainCard(bindingId);
      const abortController = this.registry.attachTurn(bindingId, prompt.id, binding.paneId!);
      let observerDetached = false;
      try {
        ({ observerDetached } = await this.turnExecutor.execute(claimed, abortController));
      } finally {
        const steeringWorker = this.registry.steeringWorker(bindingId);
        if (steeringWorker) await steeringWorker;
        const notice = "父任务已结束，本次 `/swarm steer` 未注入，也不会转为普通任务。";
        const orphaned = this.options.store.failQueuedSteering(bindingId, prompt.id, notice);
        for (const steeringId of orphaned) {
          const steering = this.options.store.getPrompt(steeringId);
          const automatic = steering?.steeringOrigin === "automatic";
          await this.publish(bindingId, "SteeringFailed", "bridge", { promptId: steeringId, parentPromptId: prompt.id, error: automatic ? "当前任务已结束，未自动注入" : notice, failureKind: "rejected", automatic });
        }
        this.registry.detachTurn(bindingId, prompt.id);
        this.options.scheduler.wake({ kind: "control-ready", bindingId });
        const latestBinding = this.options.store.getBinding(bindingId);
        if (!observerDetached && latestBinding?.lifecycle === "draining") await this.archiveDrainedBinding(latestBinding);
      }
    }
  }

  private scheduleDetachedObserver(prompt: PromptJob): void {
    if (this.legacyDetachedWithoutIdentity.has(prompt.id)) return;
    if (this.registry.hasWorker(prompt.bindingId)) return;
    const worker = this.observeDetachedTurn(prompt).finally(() => {
      this.registry.releaseWorker(prompt.bindingId, worker);
      const latest = this.options.store.getPrompt(prompt.id);
      if (!this.stopping && latest && !(latest.state === "running" && latest.observationState === "detached")) {
        this.options.scheduler.wake({ kind: "prompt-ready", bindingId: prompt.bindingId });
      }
    });
    this.registry.registerWorker(prompt.bindingId, worker);
  }

  private async observeDetachedTurn(prompt: PromptJob): Promise<void> {
    const currentPrompt = this.options.store.getPrompt(prompt.id);
    if (!currentPrompt || currentPrompt.state !== "running" || currentPrompt.observationState !== "detached") return;
    if (!currentPrompt.transcriptTurnId || !currentPrompt.transcriptTurnStartedAt) {
      if (!this.legacyDetachedWithoutIdentity.has(currentPrompt.id)) {
        this.legacyDetachedWithoutIdentity.add(currentPrompt.id);
        this.options.logger.warn({ event: "detached-turn-identity-missing", bindingId: currentPrompt.bindingId, promptId: currentPrompt.id, outcome: "uncertain" }, "detached prompt has no exact transcript turn identity; observation remains uncertain");
      }
      return;
    }
    prompt = currentPrompt;
    const binding = this.options.store.getBinding(prompt.bindingId);
    if (!binding?.paneId || binding.state !== "active") return;
    const paneId = binding.paneId;
    const abortController = this.registry.attachTurn(binding.id, prompt.id, paneId, binding.lastAgentState);
    const outputSource = await this.transcriptObserver.open(binding);
    try {
      await this.observeDetachedTurnWithSource(prompt, binding, outputSource, abortController);
    } finally {
      this.registry.detachTurn(binding.id, prompt.id);
    }
  }

  private async observeDetachedTurnWithSource(
    prompt: PromptJob,
    binding: Binding,
    initialSource: TurnOutputSource,
    abortController: AbortController
  ): Promise<void> {
    const paneId = binding.paneId!;
    let outputSource = initialSource;
    let supersedingTurnInProgress = false;
    try {
      while (!this.stopping && !abortController.signal.aborted) {
        const durablePrompt = this.options.store.getPrompt(prompt.id);
        if (!durablePrompt || (!supersedingTurnInProgress && (durablePrompt.state !== "running" || durablePrompt.observationState !== "detached"))) return;
        if (durablePrompt.state === "running") prompt = durablePrompt;
        if (!this.isBindingActive(binding.id)) return;
        const observation = await this.options.herdr.observeRuntime(paneId);
        const pane = observation.pane;
        if (!pane) throw new Error(`Herdr pane ${paneId} disappeared while observing an existing turn`);
        const state = pane.agentState;
        this.registry.updateTurnState(binding.id, prompt.id, state);
        const typed = await this.transcriptObserver.read(outputSource, binding, prompt.id);
        outputSource = typed.source;
        if (isLaterConflictingTranscriptTurn(prompt, typed.observation) && this.options.observeSupersedingExternalTurn) {
          const handoff = await this.options.observeSupersedingExternalTurn(binding, prompt, typed.observation);
          if (handoff === "completed") return;
          if (handoff === "pending" || handoff === "observing") {
            supersedingTurnInProgress = true;
            if (this.options.herdr.waitForRuntimeChange) await this.options.herdr.waitForRuntimeChange(paneId, 500, abortController.signal);
            else await abortableWait(500, abortController.signal);
            continue;
          }
        }
        const owned = this.transcriptObserver.own(binding, prompt, typed.observation);
        if (owned.owned) {
          this.transcriptObserver.retain(outputSource, owned.observation);
          const startedAt = prompt.transcriptTurnStartedAt ? Date.parse(prompt.transcriptTurnStartedAt) : Number.NaN;
          await this.transcriptObserver.publishOwned(binding.id, prompt.id, owned.observation, startedAt);
        }
        const terminal = owned.owned
          ? decideDetachedTurnTerminalOutcome(prompt, owned.observation, observation.traexProcess)
          : { kind: "pending" as const };
        if (terminal.kind === "completed") {
          const sourceAnswer = terminal.finalAnswer ?? (outputSource.mode === "typed" ? outputSource.chunks.join("\n\n") : "");
          const finalAnswer = sourceAnswer || STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE;
          const settled = this.options.store.settleDetachedPrompt({
            promptId: prompt.id, bindingId: binding.id, runtime: state, occurredAt: new Date().toISOString(),
            terminal: { kind: "completed", answer: finalAnswer, outputFingerprint: outputFingerprint(sourceAnswer) }
          });
          if (!settled) return;
          await this.publish(binding.id, "TurnCompleted", "herdr", { promptId: prompt.id, answer: finalAnswer, queueDepth: this.options.store.countPendingPrompts(binding.id) });
          this.options.logger.info({ event: "detached-turn-completed", bindingId: binding.id, promptId: prompt.id, paneId, outcome: "observed_without_replay" }, "observed completion of an existing TraeX turn");
          return;
        }
        if (terminal.kind === "aborted") {
          const reason = abortedPromptNotice(terminal.reason);
          const settled = this.options.store.settleDetachedPrompt({
            promptId: prompt.id, bindingId: binding.id, runtime: state, occurredAt: new Date().toISOString(),
            terminal: { kind: "failed", error: reason }
          });
          if (!settled) return;
          await this.publish(binding.id, "TurnFailed", "herdr", { promptId: prompt.id, error: reason, queueDepth: this.options.store.countPendingPrompts(binding.id) });
          this.options.logger.info({ event: "detached-turn-aborted", bindingId: binding.id, promptId: prompt.id, paneId, outcome: "failed_without_replay" }, "observed explicit abort of an existing TraeX turn");
          return;
        }
        if (this.options.herdr.waitForRuntimeChange) await this.options.herdr.waitForRuntimeChange(paneId, 500, abortController.signal);
        else await abortableWait(500, abortController.signal);
      }
    } catch (error) {
      if (abortController.signal.aborted || this.stopping) return;
      this.options.store.markPromptObservationDetached(prompt.id, `无法确认 TraeX 任务结果：${errorMessage(error)}；请求不会自动重发。`);
      this.options.logger.warn({ event: "detached-turn-observation-failed", err: safeLogError(error), bindingId: binding.id, promptId: prompt.id, paneId, outcome: "uncertain" }, "could not observe existing TraeX turn");
    }
  }

  private isBindingActive(bindingId: string): boolean {
    const binding = this.options.store.getBinding(bindingId);
    return binding?.state === "active" && binding.lifecycle === "active";
  }

  private async archiveDrainedBinding(binding: Binding): Promise<void> {
    const event = createBridgeEvent(binding.id, "BindingArchived", "bridge", { reason: "当前任务已结束，话题归档完成；Herdr pane 与 TraeX 保持运行。" });
    const current = this.options.store.loadTopicView(binding.id) ?? initialTopicView(binding.id);
    const view = reduceTopicView(current, event);
    if (!binding.statusMessageId) {
      this.options.store.transitionBinding(binding.id, { type: "drain_completed" });
      await this.options.bus.publish(event);
      return;
    }
    this.options.store.transitionBindingWithOutbox({ id: binding.id, transition: { type: "drain_completed" }, event, view, messageId: binding.statusMessageId, card: this.options.presentation.mainCard(view) });
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

function abortableWait(milliseconds: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) return Promise.reject(new Error("observer detached"));
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => { signal.removeEventListener("abort", onAbort); resolve(); }, milliseconds);
    const onAbort = () => { clearTimeout(timer); reject(new Error("observer detached")); };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
