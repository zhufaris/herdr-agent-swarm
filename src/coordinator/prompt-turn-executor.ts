import type { Logger } from "pino";
import type { BridgeEventOf } from "../domain/create-bridge-event.js";
import type { BridgeEvent } from "../domain/events.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { ClaimedPrompt, PromptRunStore } from "../domain/ports/prompt.js";
import type { EventOrigin, PromptJob } from "../domain/types.js";
import { outputFingerprint } from "../runtime/output.js";
import { safeLogError } from "../runtime/safe-error.js";
import { abortedPromptNotice, decidePromptExecutionFailure } from "./prompt-execution-lifecycle.js";
import type { TranscriptObserver, TurnOutputSource } from "./transcript-observer.js";

const STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE = "⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。";

interface PromptTurnExecutorOptions {
  store: PromptRunStore;
  herdr: Pick<HerdrPort, "runPrompt">;
  transcript: TranscriptObserver;
  logger: Logger;
  turnTimeoutMs: number;
  isBindingActive(bindingId: string): boolean;
  isStopping(): boolean;
  updateTurnState(bindingId: string, promptId: string, state: import("../domain/types.js").AgentState): void;
  convergeMainCard(bindingId: string): Promise<void>;
  observeDetached(prompt: PromptJob, binding: ClaimedPrompt["binding"], source: TurnOutputSource, controller: AbortController): Promise<void>;
  publish<T extends BridgeEvent["type"]>(bindingId: string, type: T, origin: EventOrigin, payload: BridgeEventOf<T>["payload"]): Promise<void>;
}

export class PromptTurnExecutor {
  constructor(private readonly options: PromptTurnExecutorOptions) {}

  async execute(claimed: ClaimedPrompt, abortController: AbortController): Promise<{ observerDetached: boolean }> {
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
      const promptWaiter = this.options.herdr.runPrompt(paneId, prompt.body, this.options.turnTimeoutMs, async ({ state: observedState, stateSource }) => {
        if (!this.options.isBindingActive(bindingId)) return;
        const previousState = binding.lastAgentState;
        if (observedState !== "unknown") this.options.updateTurnState(bindingId, prompt.id, observedState);
        if (stateSource !== "unknown" && observedState !== "unknown" && previousState !== observedState) {
          binding = this.options.store.transitionBinding(bindingId, { type: "pane_observed", runtime: observedState });
          const observedQueueDepth = this.options.store.countPendingPrompts(bindingId);
          await this.options.publish(bindingId, "AgentStateChanged", "herdr", { state: observedState, queueDepth: observedQueueDepth, promptId: prompt.id });
          if (observedState === "blocked") this.options.logger.warn({ event: "turn-blocked", bindingId, promptId: prompt.id, workspaceId: binding.workspaceId, paneId, agentState: observedState, queueDepth: observedQueueDepth, outcome: "waiting_for_user" }, "TraeX turn requires user action");
        }
      }, abortController.signal, confirmDispatched, modelOptions);
      stopAttachedTranscript = new AbortController();
      attachedTranscriptObserver = this.options.transcript.observeAttached({ source: outputSource, binding, prompt, startedAt, signal: stopAttachedTranscript.signal, confirmDispatched, updateSource: (source) => { outputSource = source; } });
      const state = await promptWaiter;
      stopAttachedTranscript.abort();
      await attachedTranscriptObserver;
      attachedTranscriptObserver = null;
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
      const sourceAnswer = outputSource.mode === "typed" ? outputSource.chunks.join("\n\n") : "";
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
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
