import type { Logger } from "pino";
import type { BridgeEventOf } from "../domain/create-bridge-event.js";
import type { BridgeEvent } from "../domain/events.js";
import type { HerdrPort, TraexTranscriptObservation } from "../domain/ports/external.js";
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
  store: Pick<PromptRecoveryStore, "getPrompt" | "getBinding" | "settleDetachedPrompt" | "markPromptObservationDetached" | "countPendingPrompts">;
  herdr: Pick<HerdrPort, "observeRuntime" | "waitForRuntimeChange">;
  transcript: Pick<TranscriptObserver, "openDetached" | "read" | "own" | "retain" | "publishOwned">;
  registry: Pick<PromptRunRegistry, "attachTurn" | "updateTurnState" | "detachTurn">;
  logger: Pick<Logger, "info" | "warn">;
  isBindingActive(bindingId: string): boolean;
  isStopping(): boolean;
  observeSupersedingExternalTurn?(binding: Binding, prompt: PromptJob, observation: TraexTranscriptObservation): Promise<"ignored" | "pending" | "observing" | "completed">;
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
        if (isLaterConflictingTranscriptTurn(prompt, typed.observation) && this.options.observeSupersedingExternalTurn) {
          const handoff = await this.options.observeSupersedingExternalTurn(binding, prompt, typed.observation);
          if (handoff === "completed") return;
          if (handoff === "pending" || handoff === "observing") { superseding = true; await this.wait(paneId, controller.signal); continue; }
        }
        const owned = this.options.transcript.own(binding, prompt, typed.observation);
        if (owned.owned) {
          this.options.transcript.retain(source, owned.observation);
          await this.options.transcript.publishOwned(binding.id, prompt.id, owned.observation, Date.parse(prompt.transcriptTurnStartedAt!));
        }
        const terminal = owned.owned ? decideDetachedTurnTerminalOutcome(prompt, owned.observation, runtime.traexProcess) : { kind: "pending" as const };
        if (terminal.kind === "completed") {
          const sourceAnswer = terminal.finalAnswer ?? (source.mode === "typed" ? source.output.text : "");
          const answer = sourceAnswer || STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE;
          if (!this.options.store.settleDetachedPrompt({ promptId: prompt.id, bindingId: binding.id, runtime: state, occurredAt: new Date().toISOString(), terminal: { kind: "completed", answer, outputFingerprint: outputFingerprint(sourceAnswer) } })) return;
          await this.options.publish(binding.id, "TurnCompleted", "herdr", { promptId: prompt.id, answer, queueDepth: this.options.store.countPendingPrompts(binding.id) });
          this.options.logger.info({ event: "detached-turn-completed", bindingId: binding.id, promptId: prompt.id, paneId, outcome: "observed_without_replay" }, "observed completion of an existing TraeX turn");
          return;
        }
        if (terminal.kind === "aborted") {
          const reason = abortedPromptNotice(terminal.reason);
          if (!this.options.store.settleDetachedPrompt({ promptId: prompt.id, bindingId: binding.id, runtime: state, occurredAt: new Date().toISOString(), terminal: { kind: "failed", error: reason } })) return;
          await this.options.publish(binding.id, "TurnFailed", "herdr", { promptId: prompt.id, error: reason, queueDepth: this.options.store.countPendingPrompts(binding.id) });
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
  private async wait(paneId: string, signal: AbortSignal): Promise<void> {
    if (this.options.herdr.waitForRuntimeChange) await this.options.herdr.waitForRuntimeChange(paneId, 500, signal);
    else await abortableWait(500, signal);
  }
}
function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
