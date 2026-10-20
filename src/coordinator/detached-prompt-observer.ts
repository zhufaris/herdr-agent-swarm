import type { Logger } from "pino";
import { selectCompletionChoiceTerminalAnswer, selectCompletionChoiceTerminalInput } from "../domain/completion-choice.js";
import type { BridgeEventOf } from "../domain/create-bridge-event.js";
import type { BridgeEvent } from "../domain/events.js";
import type { HerdrPort, AgentTranscriptObservation } from "../domain/ports/external.js";
import type { PromptRecoveryStore } from "../domain/ports/prompt-run.js";
import type { Binding, EventOrigin, PromptJob } from "../domain/types.js";
import { outputFingerprint } from "../domain/output-fingerprint.js";
import { abortableWait } from "../runtime/abortable-wait.js";
import { safeLogError } from "../runtime/safe-error.js";
import { abortedPromptNotice, decideDetachedTurnTerminalOutcome, isLaterConflictingTranscriptTurn } from "./prompt-execution-lifecycle.js";
import type { PromptRunRegistry } from "./prompt-run-registry.js";
import type { TranscriptObserver, TurnOutputSource } from "./transcript-observer.js";

const STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE = "⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。";
export interface DetachedPromptObserverPort { observe(prompt: PromptJob): Promise<void>; }
interface Options {
  store: Pick<PromptRecoveryStore, "getPrompt" | "getBinding" | "settleDetachedPrompt" | "markPromptObservationDetached" | "markDetachedPromptRecoveryNeedsHuman" | "countPendingPrompts">;
  herdr: Pick<HerdrPort, "observeRuntime" | "waitForRuntimeChange">;
  transcript: Pick<TranscriptObserver, "openDetached" | "read" | "own" | "retain" | "publishOwned"> & Partial<Pick<TranscriptObserver, "openProvenDetachedContinuation">>;
  registry: Pick<PromptRunRegistry, "attachTurn" | "updateTurnState" | "detachTurn">;
  logger: Pick<Logger, "info" | "warn">;
  isBindingActive(bindingId: string): boolean;
  isStopping(): boolean;
  observeSupersedingExternalTurn?(binding: Binding, prompt: PromptJob, observation: AgentTranscriptObservation): Promise<"ignored" | "pending" | "observing" | "completed">;
  onSettled?(promptId: string): void | Promise<void>;
  renderRunCard(view: import("../domain/run-card-view.js").RunCardView): object;
  publish<T extends BridgeEvent["type"]>(bindingId: string, type: T, origin: EventOrigin, payload: BridgeEventOf<T>["payload"]): Promise<void>;
}

export class DetachedPromptObserver implements DetachedPromptObserverPort {
  constructor(private readonly options: Options) {}
  async observe(prompt: PromptJob): Promise<void> {
    const current = this.options.store.getPrompt(prompt.id);
    if (!current || current.state !== "running" || current.observationState !== "detached" || !current.transcriptTurnId || !current.transcriptTurnStartedAt) return;
    prompt = current;
    const binding = this.options.store.getBinding(prompt.bindingId);
    if (!binding?.paneId || binding.state !== "active") return;
    const controller = this.options.registry.attachTurn(binding.id, prompt.id, binding.paneId, binding.lastAgentState);
    try {
      const source = await this.options.transcript.openDetached(binding, prompt);
      await this.observeSource(prompt, binding, source, controller);
    } catch (error) {
      this.recordUncertainFailure(prompt, binding, error, controller.signal);
    }
    finally { this.options.registry.detachTurn(binding.id, prompt.id); }
  }

  async observeSource(prompt: PromptJob, binding: Binding, initialSource: TurnOutputSource, controller: AbortController): Promise<void> {
    const paneId = binding.paneId!;
    let source = initialSource;
    let superseding = false;
    try {
      while (!this.options.isStopping() && !controller.signal.aborted) {
        const durable = this.options.store.getPrompt(prompt.id);
        if (!durable || (!superseding && (durable.state !== "running" || durable.observationState !== "detached"))) return;
        if (durable.state === "running") prompt = durable;
        if (!this.options.isBindingActive(binding.id)) return;
        const runtime = await this.options.herdr.observeRuntime(paneId);
        if (!runtime.pane) throw new Error(`Herdr pane ${paneId} disappeared while observing an existing turn`);
        const state = runtime.pane.agentState;
        this.options.registry.updateTurnState(binding.id, prompt.id, state);
        const typed = await this.options.transcript.read(source, binding, prompt.id);
        source = typed.source;
        if (source.mode === "unavailable" && source.reason === "cursor_expired") {
          const result = this.options.store.markDetachedPromptRecoveryNeedsHuman({
            promptId: prompt.id,
            bindingId: binding.id,
            expectedBindingGeneration: binding.generation,
            expectedPaneId: paneId,
            expectedNativeSessionId: binding.agentSessionValue!,
            reason: "Core session event history no longer includes the required cursor; execution ownership is uncertain and the prompt will not be replayed.",
            occurredAt: new Date().toISOString(),
            renderRunCard: this.options.renderRunCard
          });
          if (result.outcome === "needs_human") await this.notifySettled(prompt.id);
          this.options.logger.warn({
            event: "detached-turn-cursor-expired", bindingId: binding.id, promptId: prompt.id,
            paneId, outcome: result.outcome
          }, "Core session cursor expired; marked detached Prompt for human recovery without replay");
          return;
        }
        const owned = await this.options.transcript.own(binding, prompt, typed.observation);
        if (!owned.owned && isLaterConflictingTranscriptTurn(prompt, typed.observation) && this.options.observeSupersedingExternalTurn) {
          const handoff = await this.options.observeSupersedingExternalTurn(binding, prompt, typed.observation);
          if (typed.accepted && source.mode === "typed") await source.cursor.acknowledge?.(handoff === "ignored" ? "ignored" : "projected");
          if (handoff === "completed") return;
          if (handoff === "pending" || handoff === "observing") { superseding = true; await this.wait(paneId, controller.signal); continue; }
        }
        if (owned.owned) {
          await this.options.transcript.publishOwned(binding.id, prompt.id, owned.observation, Date.parse(prompt.transcriptTurnStartedAt!));
          this.options.transcript.retain(source, owned.observation);
        }
        if (typed.accepted && source.mode === "typed") await source.cursor.acknowledge?.(owned.owned ? "projected" : "ignored");
        const terminal = owned.owned ? decideDetachedOwnedTurnTerminalOutcome(owned.observation, runtime.traexProcess) : { kind: "pending" as const };
        if (terminal.kind === "completed") {
          const continued = this.options.transcript.openProvenDetachedContinuation
            ? await this.options.transcript.openProvenDetachedContinuation(source, binding, prompt, owned.observation)
            : source;
          if (continued !== source) { source = continued; continue; }
          const accumulatedAnswer = source.mode === "typed" ? source.output.text : "";
          const sourceAnswer = selectCompletionChoiceTerminalAnswer(terminal.finalAnswer, accumulatedAnswer);
          const answer = sourceAnswer || STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE;
          const terminalInput = selectCompletionChoiceTerminalInput(terminal.finalAnswer, accumulatedAnswer || STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE);
          const settlement = this.options.store.settleDetachedPrompt({
            promptId: prompt.id, bindingId: binding.id, runtime: state, occurredAt: new Date().toISOString(),
            terminal: { kind: "completed", answer: terminalInput, ...(owned.observation.turnLifecycle?.completionChoice ? { completionChoice: owned.observation.turnLifecycle.completionChoice } : {}), outputFingerprint: outputFingerprint(sourceAnswer) }
          });
          if (!settlement.settled) return;
          await this.options.publish(binding.id, "TurnCompleted", "herdr", { promptId: prompt.id, answer, queueDepth: this.options.store.countPendingPrompts(binding.id) });
          await this.notifySettled(prompt.id);
          this.options.logger.info({ event: "detached-turn-completed", bindingId: binding.id, promptId: prompt.id, paneId, outcome: "observed_without_replay" }, "observed completion of an existing TraeX turn");
          return;
        }
        if (terminal.kind === "aborted") {
          const reason = abortedPromptNotice(terminal.reason);
          const settlement = this.options.store.settleDetachedPrompt({ promptId: prompt.id, bindingId: binding.id, runtime: state, occurredAt: new Date().toISOString(), terminal: { kind: "failed", error: reason } });
          if (!settlement.settled) return;
          await this.options.publish(binding.id, "TurnFailed", "herdr", { promptId: prompt.id, error: reason, queueDepth: this.options.store.countPendingPrompts(binding.id) });
          await this.notifySettled(prompt.id);
          this.options.logger.info({ event: "detached-turn-aborted", bindingId: binding.id, promptId: prompt.id, paneId, outcome: "failed_without_replay" }, "observed explicit abort of an existing TraeX turn");
          return;
        }
        await this.wait(paneId, controller.signal);
      }
    } catch (error) {
      this.recordUncertainFailure(prompt, binding, error, controller.signal);
    }
  }
  private recordUncertainFailure(prompt: PromptJob, binding: Binding, error: unknown, signal: AbortSignal): void {
    if (signal.aborted || this.options.isStopping()) return;
    this.options.store.markPromptObservationDetached(prompt.id, `无法确认 TraeX 任务结果：${errorMessage(error)}；请求不会自动重发。`);
    this.options.logger.warn({ event: "detached-turn-observation-failed", err: safeLogError(error), bindingId: binding.id, promptId: prompt.id, paneId: binding.paneId, outcome: "uncertain" }, "could not observe existing TraeX turn");
  }
  private async notifySettled(promptId: string): Promise<void> {
    try { await this.options.onSettled?.(promptId); }
    catch (error) {
      this.options.logger.warn({ event: "detached-turn-delivery-wake-failed", err: safeLogError(error), promptId, outcome: "deferred_to_scan" }, "Could not wake downstream delivery recovery; periodic recovery will retry");
    }
  }
  private async wait(paneId: string, signal: AbortSignal): Promise<void> {
    if (this.options.herdr.waitForRuntimeChange) await this.options.herdr.waitForRuntimeChange(paneId, 500, signal);
    else await abortableWait(500, signal);
  }
}

function decideDetachedOwnedTurnTerminalOutcome(observation: AgentTranscriptObservation, traexProcessPresent: boolean): import("./prompt-execution-lifecycle.js").DetachedTurnTerminalOutcome {
  const lifecycle = observation.turnLifecycle;
  if (!traexProcessPresent || !lifecycle) return { kind: "pending" };
  if (lifecycle.state === "completed") return lifecycle.finalAnswer === undefined ? { kind: "completed" } : { kind: "completed", finalAnswer: lifecycle.finalAnswer };
  if (lifecycle.state === "aborted") return lifecycle.reason === undefined ? { kind: "aborted" } : { kind: "aborted", reason: lifecycle.reason };
  return { kind: "pending" };
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
