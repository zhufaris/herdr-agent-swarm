import type { Logger } from "pino";
import type { BridgeEventOf } from "../domain/create-bridge-event.js";
import type { BridgeEvent } from "../domain/events.js";
import type { HerdrPort, TraexControlPort } from "../domain/ports/external.js";
import type { ClaimedPrompt } from "../domain/ports/prompt-acceptance.js";
import type { PromptDispatchStore } from "../domain/ports/prompt-run.js";
import type { EventOrigin, PromptJob } from "../domain/types.js";
import { outputFingerprint } from "../domain/output-fingerprint.js";
import { safeLogError } from "../runtime/safe-error.js";
import { abortedPromptNotice, decidePromptExecutionFailure } from "./prompt-execution-lifecycle.js";
import type { TranscriptObserver, TurnOutputSource } from "./transcript-observer.js";
import type { AgentDriverCatalog } from "../domain/agent-runtime.js";

const STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE = "⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。";

interface PromptTurnExecutorOptions {
  store: PromptDispatchStore;
  herdr: Pick<HerdrPort, "runPrompt" | "waitForAgent">;
  traexControl?: TraexControlPort;
  transcript: TranscriptObserver;
  logger: Logger;
  turnTimeoutMs: number;
  agentDrivers?: AgentDriverCatalog;
  isBindingActive(bindingId: string): boolean;
  isStopping(): boolean;
  updateTurnState(bindingId: string, promptId: string, state: import("../domain/types.js").AgentState): void;
  convergeMainCard(bindingId: string): Promise<void>;
  releaseUndispatched(claimed: ClaimedPrompt): boolean;
  observeDetached(prompt: PromptJob, binding: ClaimedPrompt["binding"], source: TurnOutputSource, controller: AbortController): Promise<void>;
  publish<T extends BridgeEvent["type"]>(bindingId: string, type: T, origin: EventOrigin, payload: BridgeEventOf<T>["payload"]): Promise<void>;
}

export class PromptTurnExecutor {
  constructor(private readonly options: PromptTurnExecutorOptions) {}

  async execute(claimed: ClaimedPrompt, abortController: AbortController): Promise<{ observerDetached: boolean; dispatchDeferred?: boolean }> {
    if (claimed.binding.agentKind !== "traex") return this.executeWithoutTranscript(claimed, abortController);
    let { binding, prompt, model } = claimed;
    const bindingId = binding.id;
    const paneId = binding.paneId!;
    const queueDepth = this.options.store.countPendingPrompts(bindingId);
    const startedAt = Date.now();
    let observerDetached = false;
    let dispatched = false;
    let outputSource: TurnOutputSource = { mode: "unavailable", reason: "transcript_not_opened" };
    let turnStartedPublication: Promise<void> = Promise.resolve();
    let stopAttachedTranscript: AbortController | null = null;
    let attachedTranscriptObserver: Promise<void> | null = null;
    try {
      turnStartedPublication = this.options.publish(bindingId, "TurnStarted", "bridge", { promptId: prompt.id, queueDepth }).catch((error) => {
        this.options.logger.error({ event: "turn-started-publication-failed", err: safeLogError(error), bindingId, promptId: prompt.id, outcome: "workflow_continued" }, "TurnStarted lifecycle publication failed; prompt dispatch continued");
      });
      outputSource = await this.options.transcript.acquire(binding, abortController.signal);
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
      const modelOptions = model && binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue ? {
        modelDispatch: model,
        agentSession: { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue },
        onPrepared: async (operationId: string) => {
          if (!this.options.store.markModelPromptPrepared({ bindingId, bindingGeneration: binding.generation, promptId: prompt.id, revision: model.revision, operationId })) throw new Error("Model prompt prepare fence changed");
          await this.options.convergeMainCard(bindingId);
        },
        onPrepareAborted: async (operationId: string) => {
          if (!this.options.store.rollbackPreparedModelPrompt({ bindingId, bindingGeneration: binding.generation, promptId: prompt.id, revision: model.revision, operationId })) throw new Error("Model prompt abort fence changed");
          dispatched = false;
          await this.options.convergeMainCard(bindingId);
        },
        onAccepted: async ({ operationId, turnId }: { operationId: string; turnId: string }) => {
          if (!this.options.store.markModelPromptAccepted({ bindingId, bindingGeneration: binding.generation, promptId: prompt.id, revision: model.revision, operationId, turnId })) throw new Error("Model prompt acceptance fence changed");
          await this.options.convergeMainCard(bindingId);
        }
      } : undefined;
      if (model && !modelOptions) throw new Error("Model-aware prompt requires an exact TraeX session identity");
      if (modelOptions && !this.options.traexControl) throw new Error("TraeX model control is unavailable");
      const observeState = async ({ state: observedState, stateSource }: import("../domain/types.js").RuntimeTurnObservation) => {
        if (!this.options.isBindingActive(bindingId)) return;
        const previousState = binding.lastAgentState;
        if (observedState !== "unknown") this.options.updateTurnState(bindingId, prompt.id, observedState);
        if (stateSource !== "unknown" && observedState !== "unknown" && previousState !== observedState) {
          binding = this.options.store.transitionBinding(bindingId, { type: "pane_observed", runtime: observedState });
          const observedQueueDepth = this.options.store.countPendingPrompts(bindingId);
          await this.options.publish(bindingId, "AgentStateChanged", "herdr", { state: observedState, queueDepth: observedQueueDepth, promptId: prompt.id });
          if (observedState === "blocked") this.options.logger.warn({ event: "turn-blocked", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, agentState: observedState, queueDepth: observedQueueDepth, outcome: "waiting_for_user" }, "TraeX turn requires user action");
        }
      };
      const promptWaiter = modelOptions
        ? this.options.traexControl!.runModelPrompt(paneId, prompt.body, modelOptions, abortController.signal, confirmDispatched).then(async () => {
          await observeState({ state: "working", stateSource: "structured" });
          if (!this.options.herdr.waitForAgent) throw new Error("Herdr adapter does not support native Agent wait");
          return this.options.herdr.waitForAgent(paneId, this.options.turnTimeoutMs, observeState, abortController.signal);
        })
        : this.options.herdr.runPrompt(paneId, prompt.body, this.options.turnTimeoutMs, observeState, abortController.signal, confirmDispatched);
      stopAttachedTranscript = new AbortController();
      attachedTranscriptObserver = this.options.transcript.observeAttached({ source: outputSource, binding, prompt, startedAt, signal: stopAttachedTranscript.signal, confirmDispatched, updateSource: (source) => { outputSource = source; } });
      const state = await promptWaiter;
      stopAttachedTranscript.abort();
      await attachedTranscriptObserver;
      attachedTranscriptObserver = null;
      const recovered = await this.options.transcript.recoverFirstTurn(outputSource, binding);
      outputSource = recovered.source;
      binding = recovered.binding;
      await turnStartedPublication;
      if (!this.options.isBindingActive(bindingId) && this.options.store.getBinding(bindingId)?.lifecycle !== "draining") {
        observerDetached = true;
        this.options.store.markPromptObservationDetached(prompt.id, "Session changed after dispatch; the prompt will not be replayed.");
        await this.options.convergeMainCard(bindingId);
        return { observerDetached };
      }
      const stateBeforeReturn = binding.lastAgentState;
      this.options.updateTurnState(bindingId, prompt.id, state);
      binding = this.options.store.transitionBinding(bindingId, { type: "pane_observed", runtime: state });
      if (stateBeforeReturn !== state) await this.options.publish(bindingId, "AgentStateChanged", "herdr", { state, queueDepth, promptId: prompt.id });
      outputSource = await this.options.transcript.drain(outputSource, binding, prompt, startedAt);
      if (outputSource.mode === "typed" && outputSource.terminalLifecycle?.state === "aborted") {
        const reason = abortedPromptNotice(outputSource.terminalLifecycle.reason);
        this.options.store.failPrompt({ promptId: prompt.id, error: reason, occurredAt: new Date().toISOString() });
        await this.options.publish(bindingId, "TurnFailed", "herdr", { promptId: prompt.id, error: reason, queueDepth: this.options.store.countPendingPrompts(bindingId) });
        this.options.logger.info({ event: "turn-aborted", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "failed_without_replay" }, "TraeX turn was explicitly aborted");
        return { observerDetached };
      }
      const sourceAnswer = outputSource.mode === "typed" ? outputSource.output.text : "";
      const finalAnswer = sourceAnswer || STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE;
      this.options.store.completeTurn({ promptId: prompt.id, bindingId, answer: finalAnswer, outputFingerprint: outputFingerprint(sourceAnswer), occurredAt: new Date().toISOString(), replaceAnswer: outputSource.mode === "unavailable" });
      await this.options.publish(bindingId, "TurnCompleted", "herdr", { promptId: prompt.id, answer: finalAnswer, queueDepth: this.options.store.countPendingPrompts(bindingId) });
      this.options.logger.info({ event: "turn-completed", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "completed" }, "TraeX turn completed");
    } catch (error) {
      stopAttachedTranscript?.abort();
      if (attachedTranscriptObserver) await attachedTranscriptObserver;
      attachedTranscriptObserver = null;
      const failure = decidePromptExecutionFailure({ dispatched, stopping: this.options.isStopping(), observerAborted: abortController.signal.aborted, error: errorMessage(error) });
      if (failure.kind === "detach") {
        await turnStartedPublication;
        outputSource = await this.options.transcript.drain(outputSource, binding, prompt, startedAt);
        observerDetached = true;
        this.options.store.markPromptObservationDetached(prompt.id, failure.notice);
        await this.options.convergeMainCard(bindingId);
        this.options.logger.warn({ event: "turn-observer-detached", err: safeLogError(error), bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "detached_without_replay" }, "detached Bridge waiter from possibly in-flight TraeX turn");
        const detachedPrompt = this.options.store.getPrompt(prompt.id);
        if (!this.options.isStopping() && detachedPrompt?.transcriptTurnId && detachedPrompt.transcriptTurnStartedAt) await this.options.observeDetached(detachedPrompt, binding, outputSource, abortController);
        return { observerDetached };
      }
      if (failure.kind === "retry") {
        const released = this.options.releaseUndispatched(claimed);
        this.options.logger.warn({ event: "prompt-pre-dispatch-rejected", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: released ? "requeued_before_dispatch" : "stale_claim" }, "Herdr rejected prompt before acceptance; returned it to the FIFO");
        return { observerDetached, dispatchDeferred: true };
      }
      if (failure.kind === "ignore") return { observerDetached: true };
      this.options.store.failPrompt({ promptId: prompt.id, error: failure.error, occurredAt: new Date().toISOString() });
      await this.options.convergeMainCard(bindingId);
      await this.options.publish(bindingId, "TurnFailed", "bridge", { promptId: prompt.id, error: failure.error, queueDepth: this.options.store.countPendingPrompts(bindingId) });
      this.options.logger.error({ event: "turn-failed", err: safeLogError(error), bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "failed" }, "TraeX turn failed");
      return { observerDetached };
    } finally {
      stopAttachedTranscript?.abort();
      if (attachedTranscriptObserver) await attachedTranscriptObserver;
    }
    return { observerDetached };
  }

  private async executeWithoutTranscript(claimed: ClaimedPrompt, abortController: AbortController): Promise<{ observerDetached: boolean; dispatchDeferred?: boolean }> {
    const { binding, prompt } = claimed;
    const driver = this.options.agentDrivers?.get(binding.agentKind);
    if (!driver || !driver.describe().available) {
      this.options.store.failPrompt({ promptId: prompt.id, error: `Agent adapter is unavailable: ${binding.agentKind}`, occurredAt: new Date().toISOString() });
      return { observerDetached: false };
    }
    const runtime = { herdrWorkspaceId: binding.workspaceId, paneId: binding.paneId!, nativeSessionId: binding.agentSessionValue ?? null, generation: binding.generation };
    const startedAt = Date.now();
    let dispatched = false;
    await this.options.publish(binding.id, "TurnStarted", "bridge", { promptId: prompt.id, queueDepth: this.options.store.countPendingPrompts(binding.id) });
    const receipt = await driver.submit(runtime, prompt.body, {
      onDispatched: () => { if (!dispatched) { this.options.store.markPromptDispatched(prompt.id, new Date().toISOString()); dispatched = true; } },
      onObservation: async ({ state, stateSource }) => {
        if (stateSource === "unknown" || state === "unknown" || !this.options.isBindingActive(binding.id)) return;
        this.options.updateTurnState(binding.id, prompt.id, state);
        this.options.store.transitionBinding(binding.id, { type: "pane_observed", runtime: state });
      }
    }, abortController.signal);
    if (receipt.status === "not-delivered") {
      const released = this.options.releaseUndispatched(claimed);
      this.options.logger.warn({ event: "prompt-pre-dispatch-rejected", bindingId: binding.id, promptId: prompt.id, agentKind: binding.agentKind, outcome: released ? "requeued_before_dispatch" : "stale_claim" }, "Agent rejected prompt before acceptance");
      return { observerDetached: false, dispatchDeferred: true };
    }
    if (receipt.status === "delivery-uncertain") {
      this.options.store.markPromptObservationDetached(prompt.id, `${binding.agentKind} 请求可能已投递，但 Bridge 无法确认最终结果：${receipt.reason}；不会自动重发。`);
      await this.options.convergeMainCard(binding.id);
      return { observerDetached: true };
    }
    const notice = `⚠️ ${binding.agentKind} 当前不支持结构化输出捕获。任务已结束，请前往对应 Herdr Pane 查看本地会话。`;
    this.options.store.completeTurn({ promptId: prompt.id, bindingId: binding.id, answer: notice, outputFingerprint: outputFingerprint(""), occurredAt: new Date().toISOString(), replaceAnswer: true });
    this.options.store.transitionBinding(binding.id, { type: "pane_observed", runtime: "done" });
    await this.options.publish(binding.id, "TurnCompleted", "herdr", { promptId: prompt.id, answer: notice, queueDepth: this.options.store.countPendingPrompts(binding.id) });
    this.options.logger.info({ event: "turn-completed", bindingId: binding.id, promptId: prompt.id, agentKind: binding.agentKind, durationMs: Date.now() - startedAt, outcome: "completed_without_structured_output" }, "Agent turn completed without structured output");
    return { observerDetached: false };
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
