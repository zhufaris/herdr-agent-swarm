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
import { extractFinalTraexAnswer, parseTerminalStreamDelta } from "../runtime/traex-output-parser.js";
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
}

type TurnOutputSource =
  | { mode: "terminal"; fallbackReason: string; warningPublished: boolean }
  | { mode: "typed"; cursor: TraexTranscriptCursorPort; emitted: boolean; chunks: string[] };

const TERMINAL_FALLBACK_WARNING = "> ⚠️ 未能读取 TraeX JSONL，以下内容来自 Herdr pane fallback，可能缺少工具调用结构或完整上下文。";
const FIRST_TURN_TRANSCRIPT_IDENTITY_GRACE_MS = 3_000;
const TRANSCRIPT_IDENTITY_POLL_MS = 50;

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
  private lastDiscovered: PromptWorkerDiagnostics["lastDiscovered"] = { turns: 0, steering: 0, detached: 0, cancelled: 0 };
  private lastScanFailureAt: string | null = null;

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
      const discovered = { turns: 0, steering: 0, detached: 0, cancelled: result.cancelled };
      for (const hint of result.hints) {
        if (hint.kind === "prompt-ready") discovered.turns += 1;
        else if (hint.kind === "steering-ready") discovered.steering += 1;
        else if (hint.kind === "detached-observer-ready") discovered.detached += 1;
        this.options.scheduler.wake(hint);
      }
      this.lastDiscovered = discovered;
      this.lastScanOutcome = result.hints.length > 0 || result.cancelled > 0 ? "work_found" : "idle";
      if (this.lastScanOutcome === "idle") this.consecutiveIdleScans += 1;
      else this.consecutiveIdleScans = 0;
      if (result.cancelled > 0) this.options.logger.info({
        event: "prompt-backlog-converged", cancelled: result.cancelled, outcome: "cancelled"
      }, "cancelled queued prompts whose bindings can no longer dispatch");
    } catch (error) {
      this.lastDiscovered = { turns: 0, steering: 0, detached: 0, cancelled: 0 };
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

  async stop(context?: ShutdownContext): Promise<void> {
    this.stopping = true;
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
    const activeRun = this.turns.get(bindingId);
    if (!activeRun || activeRun.promptId !== parentPromptId) return;
    for (let prompt = this.options.store.claimNextReadySteering(bindingId, parentPromptId); prompt; prompt = this.options.store.claimNextReadySteering(bindingId, parentPromptId)) {
      try {
        const result = this.options.herdr.steerPrompt ? await this.options.herdr.steerPrompt(activeRun.paneId, prompt.body) : "not_working";
        if (result === "not_working") {
          const message = prompt.steeringOrigin === "automatic"
            ? "当前任务已结束，未自动注入"
            : "TraeX 已不在可 steering 的状态，本次 `/swarm steer` 未注入，也不会转为普通任务。";
          this.options.store.failPrompt({ promptId: prompt.id, error: message, occurredAt: new Date().toISOString(), steeringFailureKind: "rejected" });
          await this.publish(bindingId, "SteeringFailed", "bridge", { promptId: prompt.id, parentPromptId, error: message, failureKind: "rejected", automatic: prompt.steeringOrigin === "automatic" });
          if (prompt.steeringOrigin === "automatic") this.options.logger.warn({ event: "auto-steering-delivery-failed", bindingId, promptId: prompt.id, parentPromptId, failureKind: "rejected", outcome: "failed" }, "automatic steering delivery failed");
          this.options.logger.warn({ event: "steering-rejected", bindingId, promptId: prompt.id, parentPromptId, paneId: activeRun.paneId, outcome: "failed", reason: "not_working" }, "steering target was no longer steerable");
          continue;
        }
        await this.publish(bindingId, "SteeringStarted", "bridge", { promptId: prompt.id, parentPromptId });
        this.options.store.completeSteering({ promptId: prompt.id, notice: prompt.steeringOrigin === "automatic" ? "已自动加入当前执行" : "已加入当前执行", occurredAt: new Date().toISOString() });
        await this.publish(bindingId, "SteeringDelivered", "herdr", { promptId: prompt.id, parentPromptId, automatic: prompt.steeringOrigin === "automatic" });
        this.options.logger.info({ event: "steering-delivered", bindingId, promptId: prompt.id, parentPromptId, paneId: activeRun.paneId, outcome: "delivered" }, "steering delivered to active turn");
      } catch (error) {
        const message = prompt.steeringOrigin === "automatic"
          ? "自动注入结果无法确认，请检查 Herdr pane；Bridge 不会自动重试。"
          : `Steering 注入结果无法确认，请检查 Herdr pane 后按需重试：${errorMessage(error)}`;
        this.options.store.failPrompt({ promptId: prompt.id, error: message, occurredAt: new Date().toISOString(), steeringFailureKind: "uncertain" });
        await this.publish(bindingId, "SteeringFailed", "bridge", { promptId: prompt.id, parentPromptId, error: message, failureKind: "uncertain", automatic: prompt.steeringOrigin === "automatic" });
        if (prompt.steeringOrigin === "automatic") this.options.logger.error({ event: "auto-steering-delivery-failed", bindingId, promptId: prompt.id, parentPromptId, failureKind: "uncertain", outcome: "failed" }, "automatic steering delivery failed");
        this.options.logger.error({ event: "steering-failed", err: safeLogError(error), bindingId, promptId: prompt.id, parentPromptId, paneId: activeRun.paneId, outcome: "uncertain" }, "steering delivery failed");
      }
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
    for (let claimed = this.stopping ? null : this.options.store.claimNextDispatchablePrompt(bindingId); claimed; claimed = this.stopping ? null : this.options.store.claimNextDispatchablePrompt(bindingId)) {
      let { binding, prompt } = claimed;
      const paneId = binding.paneId!;
      const queueDepth = this.options.store.countPendingPrompts(bindingId);
      const startedAt = Date.now();
      const abortController = this.turns.attach(bindingId, prompt.id, paneId);
      let observerDetached = false;
      let dispatched = false;
      try {
        await this.publish(bindingId, "TurnStarted", "bridge", { promptId: prompt.id, queueDepth });
        let outputSource = await this.acquireTranscript(binding, abortController.signal);
        this.options.logger.info({
          event: "turn-started", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, queueDepth,
          outputMode: outputSource.mode, ...(outputSource.mode === "terminal" ? { fallbackReason: outputSource.fallbackReason } : {}), outcome: "running"
        }, "TraeX turn started");
        const before = await this.options.herdr.readOutput(paneId, 240);
        let previousObservation = before;
        const state = await this.options.herdr.runPrompt(paneId, prompt.body, this.options.turnTimeoutMs, async ({ state: observedState, stateSource, output }) => {
          if (!this.isBindingActive(bindingId)) return;
          const typed = await this.readTypedDelta(outputSource, binding, prompt.id);
          outputSource = typed.source;
          const parsed = outputSource.mode === "typed"
            ? { delta: typed.observation.answerDelta, update: "append" as const, model: null, context: null }
            : parseTerminalStreamDelta(previousObservation, output, prompt.body);
          previousObservation = output;
          const answerSnapshot = outputSource.mode === "terminal"
            ? terminalFallbackSnapshot(parsed.delta, parsed.update, outputSource.warningPublished)
            : parsed.delta;
          if (outputSource.mode === "terminal" && answerSnapshot) outputSource.warningPublished = true;
          const mainStatus = typed.observation.mainStatus ? toMainStatus(typed.observation.mainStatus, startedAt) : undefined;
          if (answerSnapshot || mainStatus || parsed.model || parsed.context) await this.publish(bindingId, "TurnOutputObserved", "herdr", {
            promptId: prompt.id, observation: {
              answer: { snapshot: answerSnapshot, update: parsed.update, toolActivities: [] },
              main: { ...(mainStatus ? { status: mainStatus } : {}), ...(parsed.model ? { model: parsed.model } : {}), ...(parsed.context ? { context: parsed.context } : {}) }
            }
          });
          const previousState = binding.lastAgentState;
          if (observedState !== "unknown") this.turns.updateState(bindingId, prompt.id, observedState);
          if (stateSource !== "unknown" && observedState !== "unknown" && previousState !== observedState) {
            binding = this.options.store.transitionBinding(bindingId, { type: "pane_observed", runtime: observedState });
            const observedQueueDepth = this.options.store.countPendingPrompts(bindingId);
            await this.publish(bindingId, "AgentStateChanged", "herdr", { state: observedState, queueDepth: observedQueueDepth, promptId: prompt.id });
            if (observedState === "blocked") this.options.logger.warn({ event: "turn-blocked", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, agentState: observedState, queueDepth: observedQueueDepth, outcome: "waiting_for_user" }, "TraeX turn requires user action");
          }
        }, abortController.signal, () => { dispatched = true; this.options.store.markPromptDispatched(prompt.id); });
        if (!this.isBindingActive(bindingId)) return;
        const stateBeforeReturn = binding.lastAgentState;
        this.turns.updateState(bindingId, prompt.id, state);
        binding = this.options.store.transitionBinding(bindingId, { type: "pane_observed", runtime: state });
        if (stateBeforeReturn !== state) await this.publish(bindingId, "AgentStateChanged", "herdr", { state, queueDepth, promptId: prompt.id });
        const finalTyped = await this.readTypedDelta(outputSource, binding, prompt.id);
        outputSource = finalTyped.source;
        const finalMainStatus = finalTyped.observation.mainStatus ? toMainStatus(finalTyped.observation.mainStatus, startedAt) : undefined;
        if (finalTyped.observation.answerDelta || finalMainStatus) await this.publish(bindingId, "TurnOutputObserved", "herdr", { promptId: prompt.id, observation: {
          answer: { snapshot: finalTyped.observation.answerDelta, update: "append", toolActivities: [] },
          main: { ...(finalMainStatus ? { status: finalMainStatus } : {}) }
        } });
        const terminalAnswer = outputSource.mode === "terminal" ? extractFinalTraexAnswer(await this.options.herdr.readOutput(paneId, 240)) : "";
        const streamed = outputSource.mode === "terminal" ? this.options.store.loadRunCard(prompt.id)?.answer ?? "" : "";
        const sourceAnswer = outputSource.mode === "typed" ? outputSource.chunks.join("\n\n") : withTerminalFallbackWarning(streamed || terminalAnswer);
        const finalAnswer = sourceAnswer || "TraeX 已完成，但没有可安全展示的文本输出。请查看 Herdr pane。";
        binding = this.options.store.completeTurn({ promptId: prompt.id, bindingId, answer: finalAnswer, outputFingerprint: outputFingerprint(sourceAnswer), occurredAt: new Date().toISOString() });
        await this.publish(bindingId, "TurnCompleted", "herdr", { promptId: prompt.id, answer: finalAnswer, queueDepth: this.options.store.countPendingPrompts(bindingId) });
        this.options.logger.info({ event: "turn-completed", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "completed" }, "TraeX turn completed");
      } catch (error) {
        if (!this.isBindingActive(bindingId)) { observerDetached = true; return; }
        if (dispatched) {
          const notice = this.stopping ? "Bridge 已停止观察，但 TraeX 任务可能仍在运行；重启后会继续观察，不会重复发送请求。" : `TraeX 请求已尝试投递，但 Bridge 无法确认最终结果：${errorMessage(error)}；不会自动重发。`;
          observerDetached = true;
          this.options.store.markPromptObservationDetached(prompt.id, notice);
          this.options.logger.warn({ event: "turn-observer-detached", err: safeLogError(error), bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "detached_without_replay" }, "detached Bridge waiter from possibly in-flight TraeX turn");
          return;
        }
        if (abortController.signal.aborted && this.stopping) { observerDetached = true; return; }
        this.options.store.failPrompt({ promptId: prompt.id, error: errorMessage(error), occurredAt: new Date().toISOString() });
        await this.publish(bindingId, "TurnFailed", "bridge", { promptId: prompt.id, error: errorMessage(error), queueDepth: this.options.store.countPendingPrompts(bindingId) });
        this.options.logger.error({ event: "turn-failed", err: safeLogError(error), bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "failed" }, "TraeX turn failed");
        if (binding.lastAgentState === "blocked") return;
      } finally {
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
    if (this.workers.has(prompt.bindingId)) return;
    const worker = this.observeDetachedTurn(prompt).finally(() => {
      if (this.workers.get(prompt.bindingId) === worker) this.workers.delete(prompt.bindingId);
      if (!this.stopping) this.options.scheduler.wake({ kind: "prompt-ready", bindingId: prompt.bindingId });
    });
    this.workers.set(prompt.bindingId, worker);
  }

  private async observeDetachedTurn(prompt: PromptJob): Promise<void> {
    const binding = this.options.store.getBinding(prompt.bindingId);
    if (!binding?.paneId || binding.state !== "active") return;
    const paneId = binding.paneId;
    const abortController = this.turns.attach(binding.id, prompt.id, paneId, binding.lastAgentState);
    let observedActive = binding.lastAgentState === "working" || binding.lastAgentState === "blocked";
    try {
      while (!this.stopping) {
        if (!this.isBindingActive(binding.id)) return;
        const observation = await this.options.herdr.observeRuntime(paneId);
        const pane = observation.pane;
        if (!pane) throw new Error(`Herdr pane ${paneId} disappeared while observing an existing turn`);
        const state = pane.agentState;
        this.turns.updateState(binding.id, prompt.id, state);
        if (state === "working" || state === "blocked") observedActive = true;
        const unknownOutput = state === "unknown" ? await this.options.herdr.readOutput(paneId, 240) : null;
        if (observation.traexProcess && (state === "done" || state === "idle" && (observedActive || observation.composerReady))) {
          const terminalAnswer = extractFinalTraexAnswer(unknownOutput ?? await this.options.herdr.readOutput(paneId, 240));
          const streamed = this.options.store.loadRunCard(prompt.id)?.answer ?? "";
          this.options.store.transitionBinding(binding.id, { type: "pane_observed", runtime: state });
          const finalAnswer = streamed || terminalAnswer || "TraeX 已完成，但 Bridge 重连后未能恢复可安全展示的结果。请查看 Herdr pane。";
          this.options.store.completeTurn({ promptId: prompt.id, bindingId: binding.id, answer: finalAnswer, outputFingerprint: outputFingerprint(terminalAnswer), occurredAt: new Date().toISOString() });
          await this.publish(binding.id, "TurnCompleted", "herdr", { promptId: prompt.id, answer: finalAnswer, queueDepth: this.options.store.countPendingPrompts(binding.id) });
          this.options.logger.info({ event: "detached-turn-completed", bindingId: binding.id, promptId: prompt.id, paneId, outcome: "observed_without_replay" }, "observed completion of an existing TraeX turn");
          return;
        }
        if (this.options.herdr.waitForRuntimeChange) await this.options.herdr.waitForRuntimeChange(paneId, 500, abortController.signal);
        else await abortableWait(500, abortController.signal);
      }
    } catch (error) {
      if (abortController.signal.aborted || this.stopping) return;
      this.options.store.markPromptObservationDetached(prompt.id, `无法确认 TraeX 任务结果：${errorMessage(error)}；请求不会自动重发。`);
      this.options.logger.warn({ event: "detached-turn-observation-failed", err: safeLogError(error), bindingId: binding.id, promptId: prompt.id, paneId, outcome: "uncertain" }, "could not observe existing TraeX turn");
    } finally {
      this.turns.detach(binding.id, prompt.id);
    }
  }

  private isBindingActive(bindingId: string): boolean {
    const binding = this.options.store.getBinding(bindingId);
    return binding?.state === "active" && binding.lifecycle === "active";
  }

  private async openTranscript(binding: Binding): Promise<TurnOutputSource> {
    if (!this.options.transcriptReader) return { mode: "terminal", fallbackReason: "transcript_not_found", warningPublished: false };
    const session = binding.reportedTraexSessionId
      ? { source: "bridge", agent: "traex", kind: "id" as const, value: binding.reportedTraexSessionId }
      : binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
      ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue }
      : null;
    try {
      const result = await this.options.transcriptReader.open(session);
      return result.mode === "typed"
        ? { mode: "typed", cursor: result.cursor, emitted: false, chunks: [] }
        : { mode: "terminal", fallbackReason: result.reason, warningPublished: false };
    } catch (error) {
      this.options.logger.warn({ event: "traex-transcript-open-failed", err: safeLogError(error), bindingId: binding.id, paneId: binding.paneId, fallbackReason: "transcript_validation_failed", outcome: "terminal_fallback" }, "could not open typed TraeX transcript");
      return { mode: "terminal", fallbackReason: "transcript_validation_failed", warningPublished: false };
    }
  }

  private async acquireTranscript(binding: Binding, signal: AbortSignal): Promise<TurnOutputSource> {
    const startedAt = Date.now();
    let current = binding;
    let source = await this.openTranscript(current);
    const canRetry = () => source.mode === "terminal" && (
      source.fallbackReason === "missing_session_identity" ||
      source.fallbackReason === "transcript_not_found" && Boolean(this.options.transcriptReader) && Boolean(current.reportedTraexSessionId || current.agentSessionValue)
    );
    if (!canRetry() || current.hasCompletedTurn) return source;
    const deadline = Date.now() + FIRST_TURN_TRANSCRIPT_IDENTITY_GRACE_MS;
    while (Date.now() < deadline) {
      current = this.options.store.getBinding(binding.id) ?? current;
      if (current.reportedTraexSessionId || current.agentSessionValue) {
        source = await this.openTranscript(current);
        if (source.mode === "typed") {
          this.options.logger.info({ event: "traex-transcript-source-upgraded", bindingId: binding.id, paneId: binding.paneId, waitedMs: Date.now() - startedAt, outcome: "typed" }, "acquired delayed TraeX session identity before prompt dispatch");
          return source;
        }
        if (!canRetry()) return source;
      }
      await abortableWait(Math.min(TRANSCRIPT_IDENTITY_POLL_MS, Math.max(1, deadline - Date.now())), signal);
    }
    return source;
  }

  private async readTypedDelta(source: TurnOutputSource, binding: Binding, promptId: string): Promise<{ source: TurnOutputSource; observation: TraexTranscriptObservation }> {
    if (source.mode === "terminal") return { source, observation: { answerDelta: "" } };
    try {
      const observation = source.cursor.readObservation
        ? await source.cursor.readObservation()
        : { answerDelta: await source.cursor.readDelta() };
      if (observation.answerDelta) {
        source.chunks.push(observation.answerDelta);
        source.emitted = true;
      }
      return { source, observation };
    } catch (error) {
      const outcome = source.emitted ? "terminal_fallback_suppressed" : "terminal_fallback";
      this.options.logger.warn({ event: "traex-transcript-read-failed", err: safeLogError(error), bindingId: binding.id, promptId, paneId: binding.paneId, fallbackReason: "transcript_read_failed", outcome }, "typed TraeX transcript became unavailable");
      return { source: source.emitted ? source : { mode: "terminal", fallbackReason: "transcript_read_failed", warningPublished: false }, observation: { answerDelta: "" } };
    }
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

function terminalFallbackSnapshot(delta: string, update: "append" | "replace" | "replace-status" | "replace-all", warningPublished: boolean): string {
  if (!delta) return "";
  return !warningPublished || update === "replace-all" ? withTerminalFallbackWarning(delta) : delta;
}

function withTerminalFallbackWarning(answer: string): string {
  const content = answer
    .split(TERMINAL_FALLBACK_WARNING)
    .map((part) => part.trim())
    .filter(Boolean)
    .join("\n\n");
  return content ? `${TERMINAL_FALLBACK_WARNING}\n\n${content}` : TERMINAL_FALLBACK_WARNING;
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
