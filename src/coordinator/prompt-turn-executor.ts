import type { Logger } from "pino";
import { selectCompletionChoiceTerminalAnswer, selectCompletionChoiceTerminalInput } from "../domain/completion-choice.js";
import type { BridgeEventOf } from "../domain/create-bridge-event.js";
import type { BridgeEvent } from "../domain/events.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { BindingPromptWorkflowPort, ClaimedPrompt, PromptCoreObservationOutput } from "../domain/ports/prompt-acceptance.js";
import type { PromptDispatchStore } from "../domain/ports/prompt-run.js";
import type { Binding, EventOrigin, PromptJob } from "../domain/types.js";
import { safeLogError } from "../runtime/safe-error.js";
import { abortedPromptNotice, decidePromptExecutionFailure } from "./prompt-execution-lifecycle.js";
import type { TranscriptObserver, TurnOutputSource } from "./transcript-observer.js";
import type { AgentDriverCatalog } from "../domain/agent-runtime.js";
import type { PrimaryHumanReviewNotificationInput } from "../domain/human-review.js";

const STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE = "⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。";
type BridgePromptSettlement = NonNullable<Extract<Parameters<BindingPromptWorkflowPort["applyCoreObservation"]>[0], { origin: "bridge" }>["settlement"]>;

interface PromptTurnExecutorOptions {
  store: PromptDispatchStore;
  herdr: Pick<HerdrPort, "runPrompt" | "waitForAgent">;
  transcript: TranscriptObserver;
  bindingPrompts: Pick<BindingPromptWorkflowPort, "applyCoreObservation">;
  logger: Logger;
  turnTimeoutMs: number;
  agentDrivers?: AgentDriverCatalog;
  isBindingActive(bindingId: string): boolean;
  isStopping(): boolean;
  updateTurnState(bindingId: string, promptId: string, state: import("../domain/types.js").AgentState): void;
  renderHumanReviewNotification(input: PrimaryHumanReviewNotificationInput): object;
  wakeOutbound(): void;
  convergeMainCard(bindingId: string): Promise<void>;
  releaseUndispatched(claimed: ClaimedPrompt): boolean;
  observeDetached(prompt: PromptJob, binding: ClaimedPrompt["binding"], source: TurnOutputSource, controller: AbortController): Promise<void>;
  publish<T extends BridgeEvent["type"]>(bindingId: string, type: T, origin: EventOrigin, payload: BridgeEventOf<T>["payload"]): Promise<void>;
}

export class PromptTurnExecutor {
  constructor(private readonly options: PromptTurnExecutorOptions) {}

  async execute(
    claimed: ClaimedPrompt,
    abortController: AbortController,
    options: { transcriptAcquisition?: "sessionless-bootstrap" } = {}
  ): Promise<{ observerDetached: boolean; dispatchDeferred?: boolean }> {
    const capabilities = this.options.agentDrivers?.describe(claimed.binding.agentKind);
    if (claimed.binding.agentKind !== "traex" && !capabilities?.structuredEvents) return this.executeWithoutTranscript(claimed, abortController);
    let { binding, prompt, executionBody, model } = claimed;
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
      outputSource = await this.options.transcript.acquire(binding, abortController.signal, options.transcriptAcquisition);
      this.options.logger.info({
        event: "turn-started", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, queueDepth,
        outputMode: outputSource.mode, ...(outputSource.mode === "unavailable" ? { unavailableReason: outputSource.reason } : {}), outcome: "running"
      }, "Agent turn started");
      const dispatchAttemptedAt = new Date().toISOString();
      const confirmDispatched = (): void => {
        if (dispatched) return;
        this.options.store.markPromptDispatched(prompt.id, dispatchAttemptedAt);
        dispatched = true;
      };
      if (model) throw new Error("Model-aware prompt requires the native Herdr Core queue");
      const observeState = async ({ state: observedState, stateSource }: import("../domain/types.js").RuntimeTurnObservation) => {
        if (!this.options.isBindingActive(bindingId)) return;
        const previousState = binding.lastAgentState;
        if (observedState !== "unknown") this.options.updateTurnState(bindingId, prompt.id, observedState);
        if (stateSource !== "unknown" && observedState !== "unknown") {
          const observation = this.options.store.observePrimaryPromptState({
            bindingId, promptId: prompt.id, expectedGeneration: binding.generation, expectedPaneId: paneId,
            state: observedState, notice: observedState === "blocked" ? "Primary 正在等待 Herdr 中的本地审批或交互输入。" : null,
            occurredAt: new Date().toISOString(), renderHumanReviewNotification: this.options.renderHumanReviewNotification
          });
          if (observation.outcome !== "stale") binding = observation.binding;
          if (observation.notification.outcome === "reserved") {
            this.options.wakeOutbound();
            this.options.logger.info({ event: "primary-human-review-notification-reserved", bindingId, promptId: prompt.id, paneId, episodeId: observation.notification.episodeId, notificationKind: observation.notification.kind, mention: observation.notification.mention, outcome: "reserved" }, "reserved Primary human review notification");
          } else if (observedState === "blocked" && observation.notification.reason === "stale-routing") {
            this.options.logger.warn({ event: "primary-human-review-notification-skipped", bindingId, promptId: prompt.id, paneId, reason: observation.notification.reason, outcome: "state_not_committed" }, "skipped stale Primary human review notification route");
          }
        }
        if (stateSource !== "unknown" && observedState !== "unknown" && previousState !== observedState) {
          const observedQueueDepth = this.options.store.countPendingPrompts(bindingId);
          await this.options.publish(bindingId, "AgentStateChanged", "herdr", { state: observedState, queueDepth: observedQueueDepth, promptId: prompt.id });
          if (observedState === "blocked") this.options.logger.warn({ event: "turn-blocked", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, agentState: observedState, queueDepth: observedQueueDepth, outcome: "waiting_for_user" }, "TraeX turn requires user action");
        }
      };
      const promptWaiter = this.options.herdr.runPrompt(paneId, executionBody, this.options.turnTimeoutMs, observeState, abortController.signal, confirmDispatched);
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
        await this.settleBridgePrompt({ binding, prompt, source: outputSource, settlement: { kind: "detached", notice: "Session changed after dispatch; the prompt will not be replayed." } });
        await this.options.convergeMainCard(bindingId);
        return { observerDetached };
      }
      const stateBeforeReturn = binding.lastAgentState;
      this.options.updateTurnState(bindingId, prompt.id, state);
      const finalObservation = this.options.store.observePrimaryPromptState({
        bindingId, promptId: prompt.id, expectedGeneration: binding.generation, expectedPaneId: paneId,
        state, notice: state === "blocked" ? "Primary 正在等待 Herdr 中的本地审批或交互输入。" : null,
        occurredAt: new Date().toISOString(), renderHumanReviewNotification: this.options.renderHumanReviewNotification
      });
      if (finalObservation.outcome !== "stale") binding = finalObservation.binding;
      if (finalObservation.notification.outcome === "reserved") {
        this.options.wakeOutbound();
        this.options.logger.info({ event: "primary-human-review-notification-reserved", bindingId, promptId: prompt.id, paneId, episodeId: finalObservation.notification.episodeId, notificationKind: finalObservation.notification.kind, mention: finalObservation.notification.mention, outcome: "reserved" }, "reserved Primary human review notification");
      }
      if (stateBeforeReturn !== state) await this.options.publish(bindingId, "AgentStateChanged", "herdr", { state, queueDepth, promptId: prompt.id });
      outputSource = await this.options.transcript.drain(outputSource, binding, prompt, startedAt);
      if (outputSource.mode === "typed" && outputSource.terminalLifecycle?.state === "aborted") {
        const reason = abortedPromptNotice(outputSource.terminalLifecycle.reason);
        await this.settleBridgePrompt({ binding, prompt, source: outputSource, settlement: { kind: "failed", error: reason } });
        this.options.logger.info({ event: "turn-aborted", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "failed_without_replay" }, "TraeX turn was explicitly aborted");
        return { observerDetached };
      }
      const accumulatedAnswer = outputSource.mode === "typed" ? outputSource.output.text : "";
      const sourceAnswer = selectCompletionChoiceTerminalAnswer(outputSource.mode === "typed" ? outputSource.terminalLifecycle?.finalAnswer : undefined, accumulatedAnswer);
      const finalAnswer = sourceAnswer || STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE;
      const terminalInput = selectCompletionChoiceTerminalInput(outputSource.mode === "typed" ? outputSource.terminalLifecycle?.finalAnswer : undefined, accumulatedAnswer || STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE);
      await this.settleBridgePrompt({ binding, prompt, source: outputSource, settlement: { kind: "completed", answer: terminalInput, sourceAnswer, ...(outputSource.mode === "typed" && outputSource.terminalLifecycle?.completionChoice ? { completionChoice: outputSource.terminalLifecycle.completionChoice } : {}), replaceAnswer: outputSource.mode === "unavailable" } });
      this.options.logger.info({ event: "turn-completed", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "completed" }, "TraeX turn completed");
    } catch (error) {
      stopAttachedTranscript?.abort();
      if (attachedTranscriptObserver) await attachedTranscriptObserver;
      attachedTranscriptObserver = null;
      const failure = decidePromptExecutionFailure({ dispatched, stopping: this.options.isStopping(), observerAborted: abortController.signal.aborted, error: errorMessage(error) });
      if (failure.kind === "detach") {
        await turnStartedPublication;
        outputSource = await this.options.transcript.drain(outputSource, binding, prompt, startedAt);
        if (outputSource.mode === "typed" && outputSource.terminalLifecycle?.state === "completed") {
          const sourceAnswer = selectCompletionChoiceTerminalAnswer(outputSource.terminalLifecycle.finalAnswer, outputSource.output.text);
          const answer = sourceAnswer || STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE;
          const terminalInput = selectCompletionChoiceTerminalInput(outputSource.terminalLifecycle.finalAnswer, outputSource.output.text || STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE);
          await this.settleBridgePrompt({ binding, prompt, source: outputSource, settlement: { kind: "completed", answer: terminalInput, sourceAnswer, ...(outputSource.terminalLifecycle.completionChoice ? { completionChoice: outputSource.terminalLifecycle.completionChoice } : {}) } });
          this.options.logger.info({ event: "turn-completed-after-drain", bindingId, promptId: prompt.id, paneId, outcome: "completed_without_detach" }, "completed a proven transcript turn while handling waiter failure");
          return { observerDetached };
        }
        if (outputSource.mode === "typed" && outputSource.terminalLifecycle?.state === "aborted") {
          const reason = abortedPromptNotice(outputSource.terminalLifecycle.reason);
          await this.settleBridgePrompt({ binding, prompt, source: outputSource, settlement: { kind: "failed", error: reason } });
          return { observerDetached };
        }
        observerDetached = true;
        await this.settleBridgePrompt({ binding, prompt, source: outputSource, settlement: { kind: "detached", notice: failure.notice } });
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
      await this.settleBridgePrompt({ binding, prompt, source: outputSource, settlement: { kind: "failed", error: failure.error, eventOrigin: "bridge" } });
      await this.options.convergeMainCard(bindingId);
      this.options.logger.error({ event: "turn-failed", err: safeLogError(error), bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, durationMs: Date.now() - startedAt, outcome: "failed" }, "TraeX turn failed");
      return { observerDetached };
    } finally {
      stopAttachedTranscript?.abort();
      if (attachedTranscriptObserver) await attachedTranscriptObserver;
    }
    return { observerDetached };
  }

  private async executeWithoutTranscript(claimed: ClaimedPrompt, abortController: AbortController): Promise<{ observerDetached: boolean; dispatchDeferred?: boolean }> {
    const { binding, prompt, executionBody } = claimed;
    const driver = this.options.agentDrivers?.get(binding.agentKind);
    if (!driver || !driver.describe().available) {
      await this.settleBridgePrompt({ binding, prompt, settlement: { kind: "failed", error: `Agent adapter is unavailable: ${binding.agentKind}`, eventOrigin: "bridge" } });
      return { observerDetached: false };
    }
    const runtime = { herdrWorkspaceId: binding.workspaceId, paneId: binding.paneId!, nativeSessionId: binding.agentSessionValue ?? null, generation: binding.generation };
    const startedAt = Date.now();
    let dispatched = false;
    await this.options.publish(binding.id, "TurnStarted", "bridge", { promptId: prompt.id, queueDepth: this.options.store.countPendingPrompts(binding.id) });
    const receipt = await driver.submit(runtime, executionBody, {
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
      await this.settleBridgePrompt({ binding, prompt, settlement: { kind: "detached", notice: `${binding.agentKind} 请求可能已投递，但 Bridge 无法确认最终结果：${receipt.reason}；不会自动重发。` } });
      await this.options.convergeMainCard(binding.id);
      return { observerDetached: true };
    }
    const notice = `⚠️ ${binding.agentKind} 当前不支持结构化输出捕获。任务已结束，请前往对应 Herdr Pane 查看本地会话。`;
    await this.settleBridgePrompt({ binding, prompt, settlement: { kind: "completed", answer: notice, sourceAnswer: "", replaceAnswer: true } });
    this.options.store.transitionBinding(binding.id, { type: "pane_observed", runtime: "done" });
    this.options.logger.info({ event: "turn-completed", bindingId: binding.id, promptId: prompt.id, agentKind: binding.agentKind, durationMs: Date.now() - startedAt, outcome: "completed_without_structured_output" }, "Agent turn completed without structured output");
    return { observerDetached: false };
  }

  private async settleBridgePrompt(input: {
    binding: Binding;
    prompt: PromptJob;
    source?: TurnOutputSource;
    settlement: BridgePromptSettlement;
  }): Promise<void> {
    const output = input.source ? outputFromSource(input.source) : { emitted: false, text: "", truncated: false };
    const lifecycle = output.terminalLifecycle;
    await this.options.bindingPrompts.applyCoreObservation({
      origin: "bridge",
      binding: input.binding,
      prompt: input.prompt,
      observation: {
        answerDelta: "",
        ...(lifecycle ? { turnId: lifecycle.turnId, turnLifecycle: lifecycle } : input.prompt.transcriptTurnId ? { turnId: input.prompt.transcriptTurnId } : {})
      },
      output,
      settlement: input.settlement
    });
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }

function outputFromSource(source: TurnOutputSource): PromptCoreObservationOutput {
  return source.mode === "typed"
    ? { emitted: source.emitted, text: source.output.text, truncated: source.output.truncated, ...(source.terminalLifecycle ? { terminalLifecycle: source.terminalLifecycle } : {}) }
    : { emitted: false, text: "", truncated: false };
}
