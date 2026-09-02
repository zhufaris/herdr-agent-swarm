import type { Logger } from "pino";
import { renderProjectEntryCard } from "../cards/run-card.js";
import { createBridgeEvent, type BridgeEventOf } from "../domain/create-bridge-event.js";
import type { BridgeEvent } from "../domain/events.js";
import type { HerdrPort, PromptRunStore, TraexTranscriptCursorPort, TraexTranscriptMainStatus, TraexTranscriptObservation, TraexTranscriptReaderPort } from "../domain/ports.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import type { Binding, EventOrigin, PromptJob, PromptWorkerDiagnostics } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkHint, PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { outputFingerprint } from "../runtime/output.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { ShutdownContext } from "../runtime/shutdown-context.js";
import { TurnSupervisor } from "./turn-supervisor.js";

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
  stop(context?: ShutdownContext): Promise<void>;
}

interface PromptRunWorkflowOptions {
  store: PromptRunStore;
  herdr: HerdrPort;
  bus: LifecycleEventPublisher;
  scheduler: PromptWorkScheduler;
  outboundWork: OutboundWorkNotifier;
  logger: Logger;
  turnTimeoutMs: number;
  shutdownGraceMs?: number;
  safetyScanIntervalMs?: number;
  transcriptReader?: TraexTranscriptReaderPort;
  handoffExternalTurns?: (bindingId: string) => Promise<void>;
  observeSupersedingExternalTurn?: (binding: Binding, prompt: PromptJob, observation: TraexTranscriptObservation) => Promise<"ignored" | "pending" | "observing" | "completed">;
  recoverExternalTurns?: (binding: Binding, prompt: PromptJob) => Promise<{ outcome: "recovered"; recoveredTurns: number } | { outcome: "none" | "unavailable"; reason: string }>;
}

type TurnOutputSource =
  | { mode: "unavailable"; reason: string }
  | { mode: "typed"; cursor: TraexTranscriptCursorPort; emitted: boolean; chunks: string[]; lastObservationSignature: string; terminalLifecycle?: NonNullable<TraexTranscriptObservation["turnLifecycle"]> };

const STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE = "⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。";
const FIRST_TURN_TRANSCRIPT_IDENTITY_GRACE_MS = 3_000;
const TRANSCRIPT_IDENTITY_POLL_MS = 50;
const TRANSCRIPT_IDENTITY_MAX_POLL_MS = 500;
const ATTACHED_TRANSCRIPT_POLL_MS = 250;
const FINAL_TRANSCRIPT_DRAIN_LIMIT = 8;
const MAX_TRANSCRIPT_CONFLICT_PROMPTS = 256;
const MAX_TRANSCRIPT_CONFLICT_TURNS_PER_PROMPT = 16;

export class PromptRunWorkflow implements PromptRunWorkflowPort {
  private readonly workers = new Map<string, Promise<void>>();
  private readonly steeringWorkers = new Map<string, Promise<void>>();
  private readonly turns = new TurnSupervisor();
  private readonly shutdownGraceMs: number;
  private readonly safetyScanIntervalMs: number;
  private unsubscribe: (() => void) | null = null;
  private safetyTimer: ReturnType<typeof setTimeout> | null = null;
  private started = false;
  private stopping = false;
  private consecutiveIdleScans = 0;
  private currentSafetyScanDelayMs: number | null = null;
  private nextSafetyScanAt: string | null = null;
  private lastScanAt: string | null = null;
  private lastScanOutcome: PromptWorkerDiagnostics["lastScanOutcome"] = null;
  private lastDiscovered: PromptWorkerDiagnostics["lastDiscovered"] = { turns: 0, steering: 0, detached: 0, cancelled: 0, failedDetached: 0 };
  private lastScanFailureAt: string | null = null;
  private readonly legacyDetachedWithoutIdentity = new Set<string>();
  private readonly transcriptConflictTurns = new Map<string, Set<string>>();

  constructor(private readonly options: PromptRunWorkflowOptions) {
    this.shutdownGraceMs = options.shutdownGraceMs ?? 30_000;
    this.safetyScanIntervalMs = options.safetyScanIntervalMs ?? 5_000;
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
    this.requestSafetyScan();
  }

  requestSafetyScan(): void {
    if (this.stopping) return;
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    this.safetyTimer = null;
    this.currentSafetyScanDelayMs = null;
    this.nextSafetyScanAt = null;
    try {
      const result = this.options.store.scanDurablePromptWork();
      for (const promptId of this.legacyDetachedWithoutIdentity) {
        const prompt = this.options.store.getPrompt(promptId);
        if (!prompt || prompt.state !== "running" || prompt.observationState !== "detached") this.legacyDetachedWithoutIdentity.delete(promptId);
      }
      for (const promptId of this.transcriptConflictTurns.keys()) {
        const prompt = this.options.store.getPrompt(promptId);
        if (!prompt || prompt.state !== "running" || prompt.observationState !== "detached") this.transcriptConflictTurns.delete(promptId);
      }
      const discovered = { turns: 0, steering: 0, detached: 0, cancelled: result.cancelled, failedDetached: result.failedDetached };
      for (const hint of result.hints) {
        if (hint.kind === "prompt-ready") discovered.turns += 1;
        else if (hint.kind === "steering-ready") discovered.steering += 1;
        else if (hint.kind === "detached-observer-ready") discovered.detached += 1;
        this.options.scheduler.wake(hint);
      }
      this.lastDiscovered = discovered;
      this.lastScanOutcome = result.hints.length > 0 || result.cancelled > 0 || result.failedDetached > 0 ? "work_found" : "idle";
      if (this.lastScanOutcome === "idle") this.consecutiveIdleScans += 1;
      else this.consecutiveIdleScans = 0;
      if (result.cancelled > 0 || result.failedDetached > 0) this.options.logger.info({
        event: "prompt-backlog-converged", cancelled: result.cancelled, failedDetached: result.failedDetached, outcome: "terminalized"
      }, "converged prompt work whose bindings can no longer dispatch or observe");
    } catch (error) {
      this.lastDiscovered = { turns: 0, steering: 0, detached: 0, cancelled: 0, failedDetached: 0 };
      this.lastScanOutcome = "failed";
      this.consecutiveIdleScans = 0;
      this.lastScanFailureAt = new Date().toISOString();
      this.options.logger.error({ event: "prompt-safety-scan-failed", err: safeLogError(error), outcome: "deferred_to_next_scan" }, "durable prompt safety scan failed");
    } finally {
      this.lastScanAt = new Date().toISOString();
      if (this.started && !this.stopping) {
        const delay = this.lastScanOutcome === "idle"
          ? this.safetyScanIntervalMs * Math.min(2 ** Math.max(0, this.consecutiveIdleScans - 1), 6)
          : this.safetyScanIntervalMs;
        this.armSafetyScan(delay);
      }
    }
  }

  snapshot(): PromptWorkerDiagnostics {
    return {
      state: this.stopping ? "stopping" : this.started ? "running" : "idle",
      activeTurnWorkers: this.workers.size, activeSteeringWorkers: this.steeringWorkers.size,
      currentSafetyScanDelayMs: this.currentSafetyScanDelayMs, nextSafetyScanAt: this.nextSafetyScanAt,
      lastScanAt: this.lastScanAt, lastScanOutcome: this.lastScanOutcome,
      lastDiscovered: { ...this.lastDiscovered }, lastScanFailureAt: this.lastScanFailureAt
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
      if (event.kind === "binding-runtime-changed" && !this.isBindingActive(event.bindingId)) this.turns.abort(event.bindingId);
      this.scheduleWorker(event.bindingId);
    } finally {
      this.consecutiveIdleScans = 0;
      this.armSafetyScan(this.safetyScanIntervalMs);
    }
  }

  activeTurn(bindingId: string): ActiveTurnSnapshot | null {
    const turn = this.turns.get(bindingId);
    return turn ? { promptId: turn.promptId, paneId: turn.paneId, state: turn.state } : null;
  }

  isBindingBusy(bindingId: string): boolean {
    return this.turns.has(bindingId) || this.workers.has(bindingId) || this.steeringWorkers.has(bindingId);
  }

  async awake(bindingId: string): Promise<{ outcome: "recovered"; recoveredTurns: number } | { outcome: "none" | "busy" | "unavailable"; reason: string }> {
    const prompt = this.options.store.listDetachedPrompts().find((candidate) => candidate.bindingId === bindingId);
    if (!prompt) return { outcome: "none", reason: "no_detached_prompt" };
    const binding = this.options.store.getBinding(bindingId);
    if (!binding?.paneId || binding.state !== "active" || binding.lifecycle !== "active") return { outcome: "unavailable", reason: "binding_not_active" };
    if (!this.options.recoverExternalTurns) return { outcome: "unavailable", reason: "recovery_unavailable" };
    const existing = this.workers.get(bindingId);
    if (existing) {
      this.turns.abort(bindingId);
      await existing;
    }
    if (this.workers.has(bindingId) || this.steeringWorkers.has(bindingId)) return { outcome: "busy", reason: "binding_busy" };
    const recovery = this.options.recoverExternalTurns(binding, prompt);
    const worker = recovery.then(() => undefined);
    this.workers.set(bindingId, worker);
    try {
      return await recovery;
    } finally {
      if (this.workers.get(bindingId) === worker) this.workers.delete(bindingId);
      this.options.scheduler.wake({ kind: "prompt-ready", bindingId });
    }
  }

  async stop(context?: ShutdownContext): Promise<void> {
    this.stopping = true;
    this.legacyDetachedWithoutIdentity.clear();
    this.transcriptConflictTurns.clear();
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    this.safetyTimer = null;
    this.currentSafetyScanDelayMs = null;
    this.nextSafetyScanAt = null;
    this.unsubscribe?.();
    this.unsubscribe = null;
    const pending = [...this.workers.values(), ...this.steeringWorkers.values()];
    if (!pending.length) return;
    const settled = Promise.allSettled(pending);
    let didSettle = false;
    void settled.then(() => { didSettle = true; });
    const abortObservers = () => {
      this.options.logger.warn({ event: "bridge-shutdown-turns-aborted", activeTurns: this.turns.size(), graceMs: context?.remainingMs() ?? this.shutdownGraceMs, outcome: "aborted" }, "aborting Bridge prompt waiters after shutdown grace period");
      this.turns.abortAll((run) => {
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

  private armSafetyScan(delayMs: number): void {
    if (this.stopping || !this.started) return;
    if (this.safetyTimer) clearTimeout(this.safetyTimer);
    this.currentSafetyScanDelayMs = delayMs;
    this.nextSafetyScanAt = new Date(Date.now() + delayMs).toISOString();
    this.safetyTimer = setTimeout(() => {
      this.safetyTimer = null;
      this.currentSafetyScanDelayMs = null;
      this.nextSafetyScanAt = null;
      this.requestSafetyScan();
    }, delayMs);
    this.safetyTimer.unref?.();
  }

  private scheduleSteering(bindingId: string, parentPromptId: string): void {
    const previous = this.steeringWorkers.get(bindingId) ?? Promise.resolve();
    const worker = previous.catch(() => undefined).then(() => this.drainSteering(bindingId, parentPromptId)).finally(() => {
      if (this.steeringWorkers.get(bindingId) === worker) this.steeringWorkers.delete(bindingId);
    });
    this.steeringWorkers.set(bindingId, worker);
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
    if (this.workers.has(bindingId)) return;
    const worker = this.drain(bindingId).finally(() => {
      if (this.workers.get(bindingId) === worker) this.workers.delete(bindingId);
    });
    this.workers.set(bindingId, worker);
  }

  private async drain(bindingId: string): Promise<void> {
    while (!this.stopping) {
      if (this.options.handoffExternalTurns) await this.options.handoffExternalTurns(bindingId);
      const claimed = this.options.store.claimNextDispatchablePrompt(bindingId);
      if (!claimed) return;
      let { binding, prompt } = claimed;
      const paneId = binding.paneId!;
      const queueDepth = this.options.store.countPendingPrompts(bindingId);
      const startedAt = Date.now();
      const abortController = this.turns.attach(bindingId, prompt.id, paneId);
      let observerDetached = false;
      let dispatched = false;
      let outputSource: TurnOutputSource = { mode: "unavailable", reason: "transcript_not_opened" };
      let turnStartedPublication: Promise<void> = Promise.resolve();
      let stopAttachedTranscript: AbortController | null = null;
      let attachedTranscriptObserver: Promise<void> | null = null;
      try {
        turnStartedPublication = this.publish(bindingId, "TurnStarted", "bridge", { promptId: prompt.id, queueDepth }).catch((error) => {
          this.options.logger.error({ event: "turn-started-publication-failed", err: safeLogError(error), bindingId, promptId: prompt.id, outcome: "workflow_continued" }, "TurnStarted lifecycle publication failed; prompt dispatch continued");
        });
        outputSource = await this.acquireTranscript(binding, abortController.signal);
        this.options.logger.info({
          event: "turn-started", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, queueDepth,
          outputMode: outputSource.mode, ...(outputSource.mode === "unavailable" ? { unavailableReason: outputSource.reason } : {}), outcome: "running"
        }, "TraeX turn started");
        const dispatchAttemptedAt = new Date().toISOString();
        const confirmDispatched = (): void => {
          if (dispatched) return;
          this.options.store.markPromptDispatched(prompt.id, dispatchAttemptedAt);
          dispatched = true;
        };
        const promptWaiter = this.options.herdr.runPrompt(paneId, prompt.body, this.options.turnTimeoutMs, async ({ state: observedState, stateSource }) => {
          if (!this.isBindingActive(bindingId)) return;
          const previousState = binding.lastAgentState;
          if (observedState !== "unknown") this.turns.updateState(bindingId, prompt.id, observedState);
          if (stateSource !== "unknown" && observedState !== "unknown" && previousState !== observedState) {
            binding = this.options.store.transitionBinding(bindingId, { type: "pane_observed", runtime: observedState });
            const observedQueueDepth = this.options.store.countPendingPrompts(bindingId);
            await this.publish(bindingId, "AgentStateChanged", "herdr", { state: observedState, queueDepth: observedQueueDepth, promptId: prompt.id });
            if (observedState === "blocked") this.options.logger.warn({ event: "turn-blocked", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, agentState: observedState, queueDepth: observedQueueDepth, outcome: "waiting_for_user" }, "TraeX turn requires user action");
          }
        }, abortController.signal, confirmDispatched);
        stopAttachedTranscript = new AbortController();
        attachedTranscriptObserver = this.observeAttachedTranscript(
          outputSource, binding, prompt, startedAt, stopAttachedTranscript.signal, confirmDispatched,
          (source) => { outputSource = source; }
        );
        const state = await promptWaiter;
        stopAttachedTranscript.abort();
        await attachedTranscriptObserver;
        attachedTranscriptObserver = null;
        await turnStartedPublication;
        if (!this.isBindingActive(bindingId)) return;
        const stateBeforeReturn = binding.lastAgentState;
        this.turns.updateState(bindingId, prompt.id, state);
        binding = this.options.store.transitionBinding(bindingId, { type: "pane_observed", runtime: state });
        if (stateBeforeReturn !== state) await this.publish(bindingId, "AgentStateChanged", "herdr", { state, queueDepth, promptId: prompt.id });
        outputSource = await this.drainAvailableTranscript(outputSource, binding, prompt, startedAt);
        if (outputSource.mode === "typed" && outputSource.terminalLifecycle?.state === "aborted") {
          const reason = abortedTurnNotice(outputSource.terminalLifecycle.reason);
          this.options.store.failPrompt({ promptId: prompt.id, error: reason, occurredAt: new Date().toISOString() });
          await this.publish(bindingId, "TurnFailed", "herdr", { promptId: prompt.id, error: reason, queueDepth: this.options.store.countPendingPrompts(bindingId) });
          this.options.logger.info({ event: "turn-aborted", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "failed_without_replay" }, "TraeX turn was explicitly aborted");
          return;
        }
        const sourceAnswer = outputSource.mode === "typed" ? outputSource.chunks.join("\n\n") : "";
        const finalAnswer = sourceAnswer || STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE;
        binding = this.options.store.completeTurn({ promptId: prompt.id, bindingId, answer: finalAnswer, outputFingerprint: outputFingerprint(sourceAnswer), occurredAt: new Date().toISOString(), replaceAnswer: outputSource.mode === "unavailable" });
        await this.publish(bindingId, "TurnCompleted", "herdr", { promptId: prompt.id, answer: finalAnswer, queueDepth: this.options.store.countPendingPrompts(bindingId) });
        this.options.logger.info({ event: "turn-completed", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "completed" }, "TraeX turn completed");
      } catch (error) {
        stopAttachedTranscript?.abort();
        if (attachedTranscriptObserver) await attachedTranscriptObserver;
        attachedTranscriptObserver = null;
        if (!this.isBindingActive(bindingId)) { observerDetached = true; return; }
        if (dispatched) {
          await turnStartedPublication;
          outputSource = await this.drainAvailableTranscript(outputSource, binding, prompt, startedAt);
          const notice = this.stopping ? "Bridge 已停止观察，但 TraeX 任务可能仍在运行；重启后会继续观察，不会重复发送请求。" : `TraeX 请求已尝试投递，但 Bridge 无法确认最终结果：${errorMessage(error)}；不会自动重发。`;
          observerDetached = true;
          this.options.store.markPromptObservationDetached(prompt.id, notice);
          this.options.logger.warn({ event: "turn-observer-detached", err: safeLogError(error), bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "detached_without_replay" }, "detached Bridge waiter from possibly in-flight TraeX turn");
          const detachedPrompt = this.options.store.getPrompt(prompt.id);
          if (!this.stopping && detachedPrompt?.transcriptTurnId && detachedPrompt.transcriptTurnStartedAt) {
            await this.observeDetachedTurnWithSource(detachedPrompt, binding, outputSource, abortController);
          }
          return;
        }
        if (abortController.signal.aborted && this.stopping) { observerDetached = true; return; }
        this.options.store.failPrompt({ promptId: prompt.id, error: errorMessage(error), occurredAt: new Date().toISOString() });
        await this.publish(bindingId, "TurnFailed", "bridge", { promptId: prompt.id, error: errorMessage(error), queueDepth: this.options.store.countPendingPrompts(bindingId) });
        this.options.logger.error({ event: "turn-failed", err: safeLogError(error), bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "failed" }, "TraeX turn failed");
        if (binding.lastAgentState === "blocked") return;
      } finally {
        stopAttachedTranscript?.abort();
        if (attachedTranscriptObserver) await attachedTranscriptObserver;
        const steeringWorker = this.steeringWorkers.get(bindingId);
        if (steeringWorker) await steeringWorker;
        const notice = "父任务已结束，本次 `/swarm steer` 未注入，也不会转为普通任务。";
        const orphaned = this.options.store.failQueuedSteering(bindingId, prompt.id, notice);
        for (const steeringId of orphaned) {
          const steering = this.options.store.getPrompt(steeringId);
          const automatic = steering?.steeringOrigin === "automatic";
          await this.publish(bindingId, "SteeringFailed", "bridge", { promptId: steeringId, parentPromptId: prompt.id, error: automatic ? "当前任务已结束，未自动注入" : notice, failureKind: "rejected", automatic });
        }
        this.turns.detach(bindingId, prompt.id);
        this.options.scheduler.wake({ kind: "control-ready", bindingId });
        const latestBinding = this.options.store.getBinding(bindingId);
        if (!observerDetached && latestBinding?.lifecycle === "draining") await this.archiveDrainedBinding(latestBinding);
      }
    }
  }

  private scheduleDetachedObserver(prompt: PromptJob): void {
    if (this.legacyDetachedWithoutIdentity.has(prompt.id)) return;
    if (this.workers.has(prompt.bindingId)) return;
    const worker = this.observeDetachedTurn(prompt).finally(() => {
      if (this.workers.get(prompt.bindingId) === worker) this.workers.delete(prompt.bindingId);
      const latest = this.options.store.getPrompt(prompt.id);
      if (!this.stopping && latest && !(latest.state === "running" && latest.observationState === "detached")) {
        this.options.scheduler.wake({ kind: "prompt-ready", bindingId: prompt.bindingId });
      }
    });
    this.workers.set(prompt.bindingId, worker);
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
    const abortController = this.turns.attach(binding.id, prompt.id, paneId, binding.lastAgentState);
    const outputSource = await this.openTranscript(binding);
    try {
      await this.observeDetachedTurnWithSource(prompt, binding, outputSource, abortController);
    } finally {
      this.turns.detach(binding.id, prompt.id);
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
        this.turns.updateState(binding.id, prompt.id, state);
        const typed = await this.readTypedDelta(outputSource, binding, prompt.id);
        outputSource = typed.source;
        if (this.isLaterConflictingTurn(prompt, typed.observation) && this.options.observeSupersedingExternalTurn) {
          const handoff = await this.options.observeSupersedingExternalTurn(binding, prompt, typed.observation);
          if (handoff === "completed") return;
          if (handoff === "pending" || handoff === "observing") {
            supersedingTurnInProgress = true;
            if (this.options.herdr.waitForRuntimeChange) await this.options.herdr.waitForRuntimeChange(paneId, 500, abortController.signal);
            else await abortableWait(500, abortController.signal);
            continue;
          }
        }
        const owned = this.ownTranscriptObservation(binding, prompt, typed.observation);
        if (owned.owned) {
          this.retainOwnedObservation(outputSource, owned.observation);
          const startedAt = prompt.transcriptTurnStartedAt ? Date.parse(prompt.transcriptTurnStartedAt) : Number.NaN;
          await this.publishTypedObservation(binding.id, prompt.id, owned.observation, startedAt);
        }
        const lifecycle = owned.owned ? owned.observation.turnLifecycle : undefined;
        const lifecycleCompletesOwnedTurn = lifecycle?.state === "completed"
          && lifecycle.turnId === prompt.transcriptTurnId
          && lifecycle.startedAt === prompt.transcriptTurnStartedAt;
        if (observation.traexProcess && lifecycleCompletesOwnedTurn) {
          this.options.store.transitionBinding(binding.id, { type: "pane_observed", runtime: state });
          const sourceAnswer = lifecycle.finalAnswer ?? (outputSource.mode === "typed" ? outputSource.chunks.join("\n\n") : "");
          const finalAnswer = sourceAnswer || STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE;
          this.options.store.completeTurn({ promptId: prompt.id, bindingId: binding.id, answer: finalAnswer, outputFingerprint: outputFingerprint(sourceAnswer), occurredAt: new Date().toISOString(), replaceAnswer: true });
          await this.publish(binding.id, "TurnCompleted", "herdr", { promptId: prompt.id, answer: finalAnswer, queueDepth: this.options.store.countPendingPrompts(binding.id) });
          this.options.logger.info({ event: "detached-turn-completed", bindingId: binding.id, promptId: prompt.id, paneId, outcome: "observed_without_replay" }, "observed completion of an existing TraeX turn");
          return;
        }
        const lifecycleAbortsOwnedTurn = lifecycle?.state === "aborted"
          && lifecycle.turnId === prompt.transcriptTurnId
          && lifecycle.startedAt === prompt.transcriptTurnStartedAt;
        if (observation.traexProcess && lifecycleAbortsOwnedTurn) {
          this.options.store.transitionBinding(binding.id, { type: "pane_observed", runtime: state });
          const reason = abortedTurnNotice(lifecycle.reason);
          this.options.store.failPrompt({ promptId: prompt.id, error: reason, occurredAt: new Date().toISOString() });
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

  private isLaterConflictingTurn(prompt: PromptJob, observation: TraexTranscriptObservation): boolean {
    if (!prompt.transcriptTurnId || !prompt.transcriptTurnStartedAt || !observation.turnId || observation.turnId === prompt.transcriptTurnId) return false;
    const observedStartedAt = observation.turnLifecycle?.startedAt;
    if (!observedStartedAt) return false;
    const observedMs = Date.parse(observedStartedAt);
    const ownedMs = Date.parse(prompt.transcriptTurnStartedAt);
    return Number.isFinite(observedMs) && Number.isFinite(ownedMs) && observedMs > ownedMs;
  }

  private isBindingActive(bindingId: string): boolean {
    const binding = this.options.store.getBinding(bindingId);
    return binding?.state === "active" && binding.lifecycle === "active";
  }

  private async openTranscript(binding: Binding): Promise<TurnOutputSource> {
    if (!this.options.transcriptReader) return { mode: "unavailable", reason: "transcript_not_found" };
    const session = binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
      ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue }
      : null;
    try {
      const result = await this.options.transcriptReader.open(session);
      return result.mode === "typed"
        ? { mode: "typed", cursor: result.cursor, emitted: false, chunks: [], lastObservationSignature: "" }
        : { mode: "unavailable", reason: result.reason };
    } catch (error) {
      this.options.logger.warn({ event: "traex-transcript-open-failed", err: safeLogError(error), bindingId: binding.id, paneId: binding.paneId, unavailableReason: "transcript_validation_failed", outcome: "structured_output_unavailable" }, "could not open typed TraeX transcript");
      return { mode: "unavailable", reason: "transcript_validation_failed" };
    }
  }

  private async acquireTranscript(binding: Binding, signal: AbortSignal): Promise<TurnOutputSource> {
    const startedAt = Date.now();
    let current = binding;
    let source = await this.openTranscript(current);
    const canRetry = () => source.mode === "unavailable" && (
      source.reason === "missing_session_identity" ||
      source.reason === "transcript_not_found" && Boolean(this.options.transcriptReader) && Boolean(current.agentSessionValue)
    );
    if (!canRetry() || current.hasCompletedTurn) return source;
    const deadline = Date.now() + FIRST_TURN_TRANSCRIPT_IDENTITY_GRACE_MS;
    let pollMs = TRANSCRIPT_IDENTITY_POLL_MS;
    while (Date.now() < deadline) {
      current = this.options.store.getBinding(binding.id) ?? current;
      if (current.agentSessionValue) {
        source = await this.openTranscript(current);
        if (source.mode === "typed") {
          this.options.logger.info({ event: "traex-transcript-source-upgraded", bindingId: binding.id, paneId: binding.paneId, waitedMs: Date.now() - startedAt, outcome: "typed" }, "acquired delayed TraeX session identity before prompt dispatch");
          return source;
        }
        if (!canRetry()) return source;
      }
      await abortableWait(Math.min(pollMs, Math.max(1, deadline - Date.now())), signal);
      pollMs = Math.min(TRANSCRIPT_IDENTITY_MAX_POLL_MS, pollMs * 2);
    }
    return source;
  }

  private async readTypedDelta(source: TurnOutputSource, binding: Binding, promptId: string): Promise<{ source: TurnOutputSource; observation: TraexTranscriptObservation }> {
    if (source.mode === "unavailable") return { source, observation: { answerDelta: "" } };
    try {
      const observation = source.cursor.readObservation
        ? await source.cursor.readObservation()
        : { answerDelta: await source.cursor.readDelta() };
      return { source, observation };
    } catch (error) {
      const outcome = source.emitted ? "typed_output_preserved" : "structured_output_unavailable";
      this.options.logger.warn({ event: "traex-transcript-read-failed", err: safeLogError(error), bindingId: binding.id, promptId, paneId: binding.paneId, unavailableReason: "transcript_read_failed", outcome }, "typed TraeX transcript became unavailable");
      return { source: source.emitted ? source : { mode: "unavailable", reason: "transcript_read_failed" }, observation: { answerDelta: "" } };
    }
  }

  private async observeAttachedTranscript(
    initialSource: TurnOutputSource,
    binding: Binding,
    prompt: PromptJob,
    startedAt: number,
    signal: AbortSignal,
    confirmDispatched: () => void,
    updateSource: (source: TurnOutputSource) => void
  ): Promise<void> {
    let source = initialSource;
    await abortableWait(ATTACHED_TRANSCRIPT_POLL_MS, signal).catch(() => undefined);
    while (!this.stopping && !signal.aborted && this.isBindingActive(binding.id)) {
      const typed = await this.readTypedDelta(source, binding, prompt.id);
      source = typed.source;
      updateSource(source);
      const signature = JSON.stringify(typed.observation);
      if (source.mode === "typed" && signature === source.lastObservationSignature) {
        await abortableWait(ATTACHED_TRANSCRIPT_POLL_MS, signal).catch(() => undefined);
        continue;
      }
      if (source.mode === "typed") source.lastObservationSignature = signature;
      if (typed.observation.freshTurnStart === true && typed.observation.turnLifecycle) confirmDispatched();
      const owned = this.ownTranscriptObservation(binding, prompt, typed.observation);
      if (owned.owned) {
        this.retainOwnedObservation(source, owned.observation);
        await this.publishTypedObservation(binding.id, prompt.id, owned.observation, startedAt);
      }
      await abortableWait(ATTACHED_TRANSCRIPT_POLL_MS, signal).catch(() => undefined);
    }
  }

  private async drainAvailableTranscript(source: TurnOutputSource, binding: Binding, prompt: PromptJob, startedAt: number): Promise<TurnOutputSource> {
    let current = source;
    let previousSignature = current.mode === "typed" ? current.lastObservationSignature : "";
    for (let iteration = 0; iteration < FINAL_TRANSCRIPT_DRAIN_LIMIT && current.mode === "typed"; iteration += 1) {
      const typed = await this.readTypedDelta(current, binding, prompt.id);
      current = typed.source;
      const signature = JSON.stringify(typed.observation);
      if (signature === previousSignature || signature === JSON.stringify({ answerDelta: "" })) break;
      previousSignature = signature;
      if (current.mode === "typed") current.lastObservationSignature = signature;
      const owned = this.ownTranscriptObservation(binding, prompt, typed.observation);
      if (owned.owned) {
        this.retainOwnedObservation(current, owned.observation);
        await this.publishTypedObservation(binding.id, prompt.id, owned.observation, startedAt);
        if (owned.observation.turnLifecycle?.state === "completed") break;
      }
    }
    return current;
  }

  private ownTranscriptObservation(
    binding: Binding,
    prompt: PromptJob,
    observation: TraexTranscriptObservation
  ): { owned: boolean; prompt: PromptJob; observation: TraexTranscriptObservation } {
    const current = this.options.store.getPrompt(prompt.id) ?? prompt;
    if (!observation.turnId) return { owned: false, prompt: current, observation };
    let ownedPrompt = current;
    if (!current.transcriptTurnId && observation.freshTurnStart === true && observation.turnLifecycle && current.observationState === "attached") {
      const outcome = this.options.store.claimPromptTranscriptTurn({
        promptId: current.id,
        bindingId: binding.id,
        turnId: observation.turnLifecycle.turnId,
        startedAt: observation.turnLifecycle.startedAt
      });
      if (outcome.prompt) ownedPrompt = outcome.prompt;
      if (outcome.state === "claimed") {
        this.options.logger.info({ event: "transcript-turn-owned", bindingId: binding.id, promptId: current.id, paneId: binding.paneId, turnId: observation.turnId, outcome: "claimed" }, "claimed exact TraeX transcript turn ownership");
      }
    }
    const detachedIdentityMatches = ownedPrompt.observationState !== "detached" || (
      observation.turnLifecycle?.startedAt === ownedPrompt.transcriptTurnStartedAt
    );
    const owned = ownedPrompt.transcriptTurnId !== null && observation.turnId === ownedPrompt.transcriptTurnId && detachedIdentityMatches;
    if (!owned && ownedPrompt.transcriptTurnId) {
      this.logTranscriptConflictOnce(binding, current.id, ownedPrompt.transcriptTurnId, observation.turnId);
    }
    return { owned, prompt: ownedPrompt, observation };
  }

  private logTranscriptConflictOnce(binding: Binding, promptId: string, acceptedTurnId: string, observedTurnId: string): void {
    let observed = this.transcriptConflictTurns.get(promptId);
    if (!observed) {
      if (this.transcriptConflictTurns.size >= MAX_TRANSCRIPT_CONFLICT_PROMPTS) this.transcriptConflictTurns.delete(this.transcriptConflictTurns.keys().next().value!);
      observed = new Set<string>();
      this.transcriptConflictTurns.set(promptId, observed);
    }
    if (observed.has(observedTurnId)) return;
    if (observed.size >= MAX_TRANSCRIPT_CONFLICT_TURNS_PER_PROMPT) observed.delete(observed.values().next().value!);
    observed.add(observedTurnId);
    this.options.logger.warn({ event: "transcript-turn-conflict", bindingId: binding.id, promptId, paneId: binding.paneId, acceptedTurnId, observedTurnId, outcome: "ignored" }, "ignored output from a conflicting TraeX transcript turn");
  }

  private retainOwnedObservation(source: TurnOutputSource, observation: TraexTranscriptObservation): void {
    if (source.mode !== "typed") return;
    if (observation.turnLifecycle?.state === "completed" || observation.turnLifecycle?.state === "aborted") source.terminalLifecycle = observation.turnLifecycle;
    if (observation.answerDelta) {
      source.chunks.push(observation.answerDelta);
      source.emitted = true;
    }
  }

  private async publishTypedObservation(bindingId: string, promptId: string, observation: TraexTranscriptObservation, startedAt: number): Promise<void> {
    const mainStatus = observation.mainStatus && Number.isFinite(startedAt) ? toMainStatus(observation.mainStatus, startedAt) : undefined;
    if (!observation.answerDelta && !observation.toolActivities?.length && !mainStatus) return;
    await this.publish(bindingId, "TurnOutputObserved", "herdr", {
      promptId,
      observation: {
        answer: { snapshot: observation.answerDelta, update: "append", toolActivities: observation.toolActivities ?? [] },
        main: { ...(mainStatus ? { status: mainStatus } : {}) }
      }
    });
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
    this.options.store.transitionBindingWithOutbox({ id: binding.id, transition: { type: "drain_completed" }, event, view, messageId: binding.statusMessageId, card: renderProjectEntryCard(view) });
    this.options.outboundWork.wake();
    await this.options.bus.publish(event);
  }

  private async publish<T extends BridgeEvent["type"]>(bindingId: string, type: T, origin: EventOrigin, payload: BridgeEventOf<T>["payload"]): Promise<void> {
    await this.options.bus.publish(createBridgeEvent(bindingId, type, origin, payload));
  }
}

function toMainStatus(status: TraexTranscriptMainStatus, startedAt: number): NonNullable<Extract<BridgeEvent, { type: "TurnOutputObserved" }>["payload"]["observation"]["main"]["status"]> {
  return {
    ...(status.statusTitle ? { statusTitle: status.statusTitle } : {}),
    ...(status.planSteps ? { planSteps: status.planSteps.map((step) => ({ ...step, kind: "step" as const })) } : {}),
    elapsedSeconds: Math.max(0, Math.floor((Date.now() - startedAt) / 1_000)),
    ...(status.tokenCount !== undefined ? { tokenCount: status.tokenCount } : {})
  };
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
function abortedTurnNotice(reason?: string): string { return reason === "interrupted" ? "TraeX turn was interrupted by a human operator" : `TraeX turn was aborted${reason ? `: ${reason}` : ""}`; }
