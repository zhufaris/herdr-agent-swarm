import type { Logger } from "pino";
import type { HerdrPort, AgentTranscriptObservation, AgentTranscriptReaderPort } from "../domain/ports/external.js";
import type { BindingPromptWorkflowPort, PromptCoreObservationOutput } from "../domain/ports/prompt-acceptance.js";
import type { PromptDispatchStore } from "../domain/ports/prompt-run.js";
import type { Binding, PromptJob } from "../domain/types.js";
import { ExactTurnObserver, type ExactTurnCursor } from "../runtime/exact-turn-observer.js";
import { TraexTurnLineageProbe } from "../runtime/traex-turn-lineage-probe.js";
import type { DescriptorAwareTranscriptReader } from "../runtime/agent-transcript-reader.js";
import { safeLogError } from "../runtime/safe-error.js";
import { abortableWait } from "../runtime/abortable-wait.js";
import { appendTurnOutput, createBoundedTurnOutput, legacyTruncatedTurnOutputPrefix } from "../runtime/bounded-turn-output.js";
import { projectOwnedTranscriptOutput } from "./owned-transcript-output-projector.js";
import { transcriptSourceFor } from "../domain/transcript-observer-identity.js";
import { applyAnswerTimelineDeltas, type AnswerTimelineItem } from "../domain/answer-timeline.js";
import { CoreSessionCursorExpiredError } from "../runtime/herdr-events-reader.js";

export type TurnOutputSource =
  | { mode: "unavailable"; reason: string }
  | { mode: "typed"; cursor: ExactTurnCursor; emitted: boolean; output: ReturnType<typeof createBoundedTurnOutput>; terminalLifecycle?: NonNullable<AgentTranscriptObservation["turnLifecycle"]> };

interface TranscriptObserverOptions {
  store: Pick<PromptDispatchStore, "getBinding" | "getPrompt" | "claimPromptTranscriptTurn" | "loadRunCard"> & Partial<Pick<PromptDispatchStore, "listPromptTranscriptTurns" | "adoptPromptTranscriptContinuation">>;
  reader?: AgentTranscriptReaderPort;
  herdr: Pick<HerdrPort, "observeRuntime">;
  adoptRuntimeIdentity(input: { bindingId: string; expectedPaneId: string; expectedGeneration: number; pane: import("../domain/types.js").HerdrPane }): import("../domain/types.js").RuntimeObservationApplication;
  logger: Logger;
  isBindingActive(bindingId: string): boolean;
  isStopping(): boolean;
  publishObservation(bindingId: string, promptId: string, observation: NonNullable<ReturnType<typeof projectOwnedTranscriptOutput>["observation"]>): Promise<void>;
  workflow?: Pick<BindingPromptWorkflowPort, "applyCoreObservation">;
  allowLegacySettlementForTests?: boolean;
  identityPollMs?: number;
  attachedPollMs?: number;
}
const FIRST_TURN_TRANSCRIPT_IDENTITY_GRACE_MS = 3_000;
const TRANSCRIPT_IDENTITY_MAX_POLL_MS = 500;
const FINAL_TRANSCRIPT_DRAIN_LIMIT = 256;
const DETACHED_REPLAY_DRAIN_LIMIT = 256;
const MAX_TRANSCRIPT_CONFLICT_PROMPTS = 256;
const MAX_TRANSCRIPT_CONFLICT_TURNS_PER_PROMPT = 16;

export class TranscriptObserver {
  private readonly conflictTurns = new Map<string, Set<string>>();
  private readonly exactTurns: ExactTurnObserver | undefined;
  private readonly lineageProbe: TraexTurnLineageProbe | undefined;
  private readonly identityPollMs: number;
  private readonly attachedPollMs: number;

  constructor(private readonly options: TranscriptObserverOptions) {
    if (!options.workflow && !options.allowLegacySettlementForTests) throw new Error("TranscriptObserver requires BindingPromptWorkflow.applyCoreObservation");
    this.exactTurns = options.reader ? new ExactTurnObserver(options.reader) : undefined;
    this.lineageProbe = options.reader && typeof (options.reader as DescriptorAwareTranscriptReader).resolveTranscriptDescriptor === "function"
      ? new TraexTurnLineageProbe(options.reader as DescriptorAwareTranscriptReader) : undefined;
    this.identityPollMs = options.identityPollMs ?? 50;
    this.attachedPollMs = options.attachedPollMs ?? 250;
  }

  clear(): void { this.conflictTurns.clear(); }

  prune(): void {
    for (const promptId of this.conflictTurns.keys()) {
      const prompt = this.options.store.getPrompt(promptId);
      if (!prompt || prompt.state !== "running" || prompt.observationState !== "detached") this.conflictTurns.delete(promptId);
    }
  }

  async open(binding: Binding): Promise<TurnOutputSource> {
    if (!this.exactTurns) return { mode: "unavailable", reason: "transcript_not_found" };
    const sourceIdentity = transcriptSourceFor(binding);
    try {
      const result = await this.exactTurns.open({ source: sourceIdentity, boundary: { kind: "latest" } });
      return result.mode === "typed"
        ? { mode: "typed", cursor: result.cursor, emitted: false, output: createBoundedTurnOutput() }
        : { mode: "unavailable", reason: result.reason };
    } catch (error) {
      this.options.logger.warn({ event: "traex-transcript-open-failed", err: safeLogError(error), bindingId: binding.id, paneId: binding.paneId, unavailableReason: "transcript_validation_failed", outcome: "structured_output_unavailable" }, "could not open typed TraeX transcript");
      return { mode: "unavailable", reason: "transcript_validation_failed" };
    }
  }

  async openDetached(binding: Binding, prompt: PromptJob): Promise<TurnOutputSource> {
    const persistedAnswer = this.options.store.loadRunCard?.(prompt.id)?.answer ?? "";
    const legacyPrefix = legacyTruncatedTurnOutputPrefix(persistedAnswer);
    const fallback = async () => {
      const source = await this.open(binding);
      if (source.mode === "typed") { source.output = createBoundedTurnOutput(persistedAnswer); source.emitted = Boolean(persistedAnswer); }
      return source;
    };
    if (!this.exactTurns || !prompt.transcriptTurnId || !prompt.transcriptTurnStartedAt) return fallback();
    try {
      const opened = await this.exactTurns.open({
        source: transcriptSourceFor(binding),
        boundary: { kind: "at", turnId: prompt.transcriptTurnId, startedAt: prompt.transcriptTurnStartedAt },
        expected: { turnId: prompt.transcriptTurnId, startedAt: prompt.transcriptTurnStartedAt }
      });
      if (opened.mode !== "typed") return fallback();
      const source: TurnOutputSource = { mode: "typed", cursor: opened.cursor, emitted: Boolean(persistedAnswer), output: createBoundedTurnOutput(persistedAnswer) };
      let replayedAnswer = createBoundedTurnOutput();
      let replayedTimeline: AnswerTimelineItem[] = [];
      const replayedGoalChanges: NonNullable<AgentTranscriptObservation["goalChanges"]> = [];
      let latestMainStatus: AgentTranscriptObservation["mainStatus"];
      await opened.cursor.drain({ limit: DETACHED_REPLAY_DRAIN_LIMIT, onObservation: async (observation) => {
        replayedAnswer = appendTurnOutput(replayedAnswer, observation.answerDelta);
        replayedTimeline = applyAnswerTimelineDeltas(replayedTimeline, observation.timelineDeltas ?? []);
        replayedGoalChanges.push(...(observation.goalChanges ?? []));
        if (observation.mainStatus) latestMainStatus = mergeMainStatus(latestMainStatus, observation.mainStatus);
        if (observation.turnLifecycle?.state === "completed" || observation.turnLifecycle?.state === "aborted") source.terminalLifecycle = observation.turnLifecycle;
        return "continue" as const;
      } });
      const persistedPrefix = legacyPrefix ?? persistedAnswer;
      if (!replayedAnswer.truncated && replayedAnswer.text.startsWith(persistedPrefix) && replayedAnswer.text.length > persistedPrefix.length) {
        source.output = replayedAnswer;
        if (legacyPrefix !== null) {
          await this.options.publishObservation(binding.id, prompt.id, {
            ...(replayedGoalChanges.length ? { goalChanges: replayedGoalChanges } : {}),
            answer: { snapshot: replayedAnswer.text, update: "replace-all", toolActivities: [], ...(replayedTimeline.length ? { timelineDeltas: replayedTimeline } : {}) },
            main: {}
          });
        } else {
          const suffix = replayedAnswer.text.slice(persistedAnswer.length).trimStart();
          if (suffix || replayedTimeline.length || replayedGoalChanges.length) await this.publishOwned(binding.id, prompt.id, { turnId: prompt.transcriptTurnId, answerDelta: suffix, ...(replayedTimeline.length ? { timelineDeltas: replayedTimeline } : {}), ...(replayedGoalChanges.length ? { goalChanges: replayedGoalChanges } : {}) }, Date.parse(prompt.transcriptTurnStartedAt));
        }
      } else if (replayedTimeline.length || replayedGoalChanges.length) {
        await this.publishOwned(binding.id, prompt.id, { turnId: prompt.transcriptTurnId, answerDelta: "", ...(replayedTimeline.length ? { timelineDeltas: replayedTimeline } : {}), ...(replayedGoalChanges.length ? { goalChanges: replayedGoalChanges } : {}) }, Date.parse(prompt.transcriptTurnStartedAt));
      }
      if (latestMainStatus) await this.publishOwned(binding.id, prompt.id, { turnId: prompt.transcriptTurnId, answerDelta: "", mainStatus: latestMainStatus }, Date.parse(prompt.transcriptTurnStartedAt));
      const terminalObservation: AgentTranscriptObservation = { turnId: prompt.transcriptTurnId, answerDelta: "", ...(source.terminalLifecycle ? { turnLifecycle: source.terminalLifecycle } : {}) };
      return await this.openProvenDetachedContinuation(source, binding, prompt, terminalObservation);
    } catch (error) {
      if (error instanceof CoreSessionCursorExpiredError) return { mode: "unavailable", reason: "cursor_expired" };
      this.options.logger.warn({ event: "detached-transcript-replay-failed", err: safeLogError(error), bindingId: binding.id, promptId: prompt.id, paneId: binding.paneId, outcome: "live_tail_only" }, "could not replay detached transcript state; continuing from the live tail");
      return fallback();
    }
  }

  async acquire(binding: Binding, signal: AbortSignal, policy?: "sessionless-bootstrap"): Promise<TurnOutputSource> {
    const startedAt = Date.now();
    let current = binding;
    let source = await this.open(current);
    const canRetry = () => source.mode === "unavailable" && (
      source.reason === "missing_session_identity" ||
      source.reason === "transcript_not_found" && Boolean(this.options.reader) && Boolean(current.agentSessionValue)
    );
    if (!canRetry() || current.hasCompletedTurn || policy === "sessionless-bootstrap") return source;
    const deadline = Date.now() + FIRST_TURN_TRANSCRIPT_IDENTITY_GRACE_MS;
    let pollMs = this.identityPollMs;
    while (Date.now() < deadline) {
      current = this.options.store.getBinding(binding.id) ?? current;
      if (current.agentSessionValue) {
        source = await this.open(current);
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

  async recoverFirstTurn(source: TurnOutputSource, binding: Binding): Promise<{ source: TurnOutputSource; binding: Binding }> {
    if (source.mode !== "unavailable" || source.reason !== "missing_session_identity" || binding.hasCompletedTurn || !binding.paneId || !this.exactTurns) return { source, binding };
    try {
      const observation = await this.options.herdr.observeRuntime(binding.paneId);
      if (!observation.pane) return { source, binding };
      const applied = this.options.adoptRuntimeIdentity({ bindingId: binding.id, expectedPaneId: binding.paneId, expectedGeneration: binding.generation, pane: observation.pane });
      if (applied.outcome !== "applied" || !applied.binding.agentSessionValue) return { source, binding };
      const opened = await this.exactTurns.open({ source: transcriptSourceFor(applied.binding), boundary: { kind: "first" } });
      if (opened.mode !== "typed") return { source, binding: applied.binding };
      this.options.logger.info({ event: "traex-transcript-source-upgraded", bindingId: binding.id, paneId: binding.paneId, outcome: "typed_after_dispatch" }, "acquired first-turn TraeX session identity after prompt dispatch");
      return { source: { mode: "typed", cursor: opened.cursor, emitted: false, output: createBoundedTurnOutput() }, binding: applied.binding };
    } catch (error) {
      this.options.logger.warn({ event: "traex-transcript-source-upgrade-failed", err: safeLogError(error), bindingId: binding.id, paneId: binding.paneId, outcome: "structured_output_unavailable" }, "could not recover first-turn TraeX transcript identity");
      return { source, binding };
    }
  }

  async read(source: TurnOutputSource, binding: Binding, promptId: string): Promise<{ source: TurnOutputSource; observation: AgentTranscriptObservation; accepted: boolean }> {
    if (source.mode === "unavailable") return { source, observation: { answerDelta: "" }, accepted: false };
    try {
      const result = await source.cursor.read();
      return { source, observation: result.kind === "accepted" ? result.observation : { answerDelta: "" }, accepted: result.kind === "accepted" };
    } catch (error) {
      if (error instanceof CoreSessionCursorExpiredError) {
        return { source: { mode: "unavailable", reason: "cursor_expired" }, observation: { answerDelta: "" }, accepted: false };
      }
      const outcome = source.emitted ? "typed_output_preserved" : "structured_output_unavailable";
      this.options.logger.warn({ event: "traex-transcript-read-failed", err: safeLogError(error), bindingId: binding.id, promptId, paneId: binding.paneId, unavailableReason: "transcript_read_failed", outcome }, "typed TraeX transcript became unavailable");
      return { source: source.emitted ? source : { mode: "unavailable", reason: "transcript_read_failed" }, observation: { answerDelta: "" }, accepted: false };
    }
  }

  async observeAttached(input: { source: TurnOutputSource; binding: Binding; prompt: PromptJob; startedAt: number; signal: AbortSignal; confirmDispatched(): void; updateSource(source: TurnOutputSource): void }): Promise<void> {
    let source = input.source;
    await abortableWait(this.attachedPollMs, input.signal).catch(() => undefined);
    while (!this.options.isStopping() && !input.signal.aborted && this.options.isBindingActive(input.binding.id)) {
      if (source.mode === "unavailable" && source.reason === "missing_session_identity") {
        const recovered = await this.recoverFirstTurn(source, input.binding);
        source = recovered.source;
        input.updateSource(source);
      }
      const typed = await this.read(source, input.binding, input.prompt.id);
      source = typed.source;
      input.updateSource(source);
      if (typed.observation.freshTurnStart === true && typed.observation.turnLifecycle) input.confirmDispatched();
      try {
        const owned = await this.applyCoreObservation(input.binding, input.prompt, typed.observation, source, input.startedAt);
        if (owned.owned) {
          this.updateSourceFromReceipt(source, owned.output);
        }
        if (typed.accepted && source.mode === "typed") await source.cursor.acknowledge?.(owned.owned ? "projected" : "ignored");
      } catch (error) {
        if (typed.accepted && source.mode === "typed") await source.cursor.acknowledge?.("quarantined", error instanceof Error ? error.message : String(error));
        this.options.logger.warn({ event: "traex-transcript-projection-quarantined", err: safeLogError(error), bindingId: input.binding.id, promptId: input.prompt.id, paneId: input.binding.paneId, outcome: "continued_after_quarantine" }, "quarantined one Core event projection and continued observing later events");
      }
      await abortableWait(this.attachedPollMs, input.signal).catch(() => undefined);
    }
  }

  async drain(source: TurnOutputSource, binding: Binding, prompt: PromptJob, startedAt: number): Promise<TurnOutputSource> {
    if (source.mode !== "typed") return source;
    try {
      await source.cursor.drain({ limit: FINAL_TRANSCRIPT_DRAIN_LIMIT, onObservation: async (observation) => {
        const owned = await this.applyCoreObservation(binding, prompt, observation, source, startedAt);
        if (owned.owned) this.updateSourceFromReceipt(source, owned.output);
        return "continue" as const;
      } });
    } catch (error) {
      const outcome = source.emitted ? "typed_output_preserved" : "structured_output_unavailable";
      this.options.logger.warn({ event: "traex-transcript-read-failed", err: safeLogError(error), bindingId: binding.id, promptId: prompt.id, paneId: binding.paneId, unavailableReason: "transcript_read_failed", outcome }, "typed TraeX transcript became unavailable");
      return source.emitted ? source : { mode: "unavailable", reason: "transcript_read_failed" };
    }
    return source;
  }

  async openProvenDetachedContinuation(source: TurnOutputSource, binding: Binding, prompt: PromptJob, observation: AgentTranscriptObservation): Promise<TurnOutputSource> {
    const terminal = observation.turnLifecycle;
    if (!this.exactTurns || !this.lineageProbe || !terminal || terminal.state !== "completed") return source;
    const lineage = await this.lineageProbe.inspect(transcriptSourceFor(binding));
    const next = lineage.find((candidate) => candidate.origin === "runtime_continuation" && candidate.parentTurnId === terminal.turnId && candidate.chainId);
    if (!next) return source;
    try {
      const opened = await this.exactTurns.open({ source: transcriptSourceFor(binding), boundary: { kind: "after", turnId: terminal.turnId, startedAt: terminal.startedAt } });
      if (opened.mode !== "typed") return source;
      this.options.logger.info({ event: "detached-transcript-continuation-opened", bindingId: binding.id, promptId: prompt.id, paneId: binding.paneId, turnId: next.turnId, parentTurnId: terminal.turnId, outcome: "core_events_after_owned_turn" }, "opened Core events after a proven TraeX goal continuation parent");
      return { mode: "typed", cursor: opened.cursor, emitted: source.mode === "typed" ? source.emitted : false, output: source.mode === "typed" ? source.output : createBoundedTurnOutput() };
    } catch (error) {
      this.options.logger.warn({ event: "detached-transcript-continuation-open-failed", err: safeLogError(error), bindingId: binding.id, promptId: prompt.id, paneId: binding.paneId, outcome: "retain_completed_turn" }, "could not open Core events after a proven TraeX continuation parent");
      return source;
    }
  }

  async own(binding: Binding, prompt: PromptJob, observation: AgentTranscriptObservation): Promise<{ owned: boolean; prompt: PromptJob; observation: AgentTranscriptObservation }> {
    const current = this.options.store.getPrompt(prompt.id) ?? prompt;
    if (!observation.turnId) return { owned: false, prompt: current, observation };
    let ownedPrompt = current;
    const needsTurnIdentity = !current.transcriptTurnId;
    const needsAcceptedTurnStart = current.transcriptTurnId === observation.turnId && !current.transcriptTurnStartedAt;
    if ((needsTurnIdentity || needsAcceptedTurnStart) && observation.freshTurnStart === true && observation.turnLifecycle && (current.observationState === "attached" || needsAcceptedTurnStart)) {
      const outcome = this.options.store.claimPromptTranscriptTurn({ promptId: current.id, bindingId: binding.id, turnId: observation.turnLifecycle.turnId, startedAt: observation.turnLifecycle.startedAt });
      if (outcome.prompt) ownedPrompt = outcome.prompt;
      if (outcome.state === "claimed") this.options.logger.info({ event: "transcript-turn-owned", bindingId: binding.id, promptId: current.id, paneId: binding.paneId, turnId: observation.turnId, outcome: "claimed" }, "claimed exact TraeX transcript turn ownership");
    }
    const observedStartedAt = observation.turnLifecycle?.startedAt;
    let ownedTurns = this.ownedTurns(ownedPrompt);
    let owned = ownedTurns.some((turn) => turn.turnId === observation.turnId && (!observedStartedAt || turn.startedAt === observedStartedAt));
    if (!owned && this.lineageProbe && observedStartedAt && current.transcriptTurnId) {
      const lineage = await this.lineageProbe.inspect(transcriptSourceFor(binding));
      const candidate = lineage.find((turn) => turn.turnId === observation.turnId && turn.startedAt === observedStartedAt);
      if (candidate?.origin === "runtime_continuation" && candidate.parentTurnId && candidate.chainId) {
        const outcome = this.options.store.adoptPromptTranscriptContinuation?.({
          promptId: ownedPrompt.id, bindingId: binding.id, bindingGeneration: binding.generation, turnId: candidate.turnId, startedAt: candidate.startedAt,
          parentTurnId: candidate.parentTurnId, chainId: candidate.chainId
        });
        if (outcome?.state === "adopted") this.options.logger.info({ event: "transcript-turn-owned", bindingId: binding.id, promptId: ownedPrompt.id, paneId: binding.paneId, turnId: candidate.turnId, parentTurnId: candidate.parentTurnId, outcome: "continuation-adopted" }, "adopted proven TraeX goal continuation");
        ownedTurns = this.ownedTurns(ownedPrompt);
        owned = outcome?.state === "adopted" || outcome?.state === "matched";
      }
    }
    const detachedIdentityMatches = ownedPrompt.observationState !== "detached" || ownedTurns.some((turn) => turn.turnId === observation.turnId && turn.startedAt === observedStartedAt);
    owned = owned && detachedIdentityMatches;
    if (!owned && ownedPrompt.transcriptTurnId) this.logConflict(binding, current.id, ownedPrompt.transcriptTurnId, observation.turnId);
    return { owned, prompt: ownedPrompt, observation };
  }

  private ownedTurns(prompt: PromptJob): Array<{ turnId: string; startedAt: string }> {
    const durable = this.options.store.listPromptTranscriptTurns?.(prompt.id);
    if (durable) return durable;
    return prompt.transcriptTurnId && prompt.transcriptTurnStartedAt ? [{ turnId: prompt.transcriptTurnId, startedAt: prompt.transcriptTurnStartedAt }] : [];
  }

  retain(source: TurnOutputSource, observation: AgentTranscriptObservation): void {
    if (source.mode !== "typed") return;
    const projection = projectOwnedTranscriptOutput({ state: source, observation });
    source.emitted = projection.state.emitted;
    source.output = projection.state.output;
    if (projection.state.terminalLifecycle) source.terminalLifecycle = projection.state.terminalLifecycle;
  }

  async publishOwned(bindingId: string, promptId: string, observation: AgentTranscriptObservation, startedAt: number): Promise<void> {
    await this.publish(bindingId, promptId, observation, startedAt);
  }

  private async applyCoreObservation(binding: Binding, prompt: PromptJob, observation: AgentTranscriptObservation, source: TurnOutputSource, startedAt: number): Promise<{ owned: boolean; prompt: PromptJob; observation: AgentTranscriptObservation; output?: PromptCoreObservationOutput }> {
    if (!this.options.workflow) {
      const owned = await this.own(binding, prompt, observation);
      if (owned.owned) {
        await this.publish(binding.id, prompt.id, owned.observation, startedAt);
        this.retain(source, owned.observation);
        return { ...owned, output: this.outputFromSource(source) };
      }
      return owned;
    }
    const receipt = await this.options.workflow.applyCoreObservation({
      origin: "bridge",
      binding,
      prompt,
      observation,
      output: this.outputFromSource(source),
      ...(Number.isFinite(startedAt) ? { elapsedSeconds: Math.floor((Date.now() - startedAt) / 1_000) } : {})
    });
    return { owned: receipt.owned, prompt: receipt.prompt ?? prompt, observation, ...(receipt.output ? { output: receipt.output } : {}) };
  }

  private outputFromSource(source: TurnOutputSource): PromptCoreObservationOutput {
    return source.mode === "typed"
      ? { emitted: source.emitted, text: source.output.text, truncated: source.output.truncated, ...(source.terminalLifecycle ? { terminalLifecycle: source.terminalLifecycle } : {}) }
      : { emitted: false, text: "", truncated: false };
  }

  private updateSourceFromReceipt(source: TurnOutputSource, output: PromptCoreObservationOutput | undefined): void {
    if (!output || source.mode !== "typed") return;
    source.emitted = output.emitted ?? Boolean(output.text);
    source.output = { text: output.text, truncated: output.truncated };
    if (output.terminalLifecycle) source.terminalLifecycle = output.terminalLifecycle;
  }

  private async publish(bindingId: string, promptId: string, observation: AgentTranscriptObservation, startedAt: number): Promise<void> {
    const projection = projectOwnedTranscriptOutput({ state: { emitted: false, output: createBoundedTurnOutput() }, observation, ...(Number.isFinite(startedAt) ? { elapsedSeconds: Math.floor((Date.now() - startedAt) / 1_000) } : {}) });
    if (projection.observation) await this.options.publishObservation(bindingId, promptId, projection.observation);
  }

  private logConflict(binding: Binding, promptId: string, acceptedTurnId: string, observedTurnId: string): void {
    let observed = this.conflictTurns.get(promptId);
    if (!observed) {
      if (this.conflictTurns.size >= MAX_TRANSCRIPT_CONFLICT_PROMPTS) this.conflictTurns.delete(this.conflictTurns.keys().next().value!);
      observed = new Set<string>();
      this.conflictTurns.set(promptId, observed);
    }
    if (observed.has(observedTurnId)) return;
    if (observed.size >= MAX_TRANSCRIPT_CONFLICT_TURNS_PER_PROMPT) observed.delete(observed.values().next().value!);
    observed.add(observedTurnId);
    this.options.logger.warn({ event: "transcript-turn-conflict", bindingId: binding.id, promptId, paneId: binding.paneId, acceptedTurnId, observedTurnId, outcome: "ignored" }, "ignored output from a conflicting TraeX transcript turn");
  }
}

function mergeMainStatus(current: AgentTranscriptObservation["mainStatus"], update: NonNullable<AgentTranscriptObservation["mainStatus"]>): NonNullable<AgentTranscriptObservation["mainStatus"]> {
  return {
    ...(update.statusTitle !== undefined ? { statusTitle: update.statusTitle } : current?.statusTitle !== undefined ? { statusTitle: current.statusTitle } : {}),
    ...(update.planSteps !== undefined ? { planSteps: update.planSteps } : current?.planSteps !== undefined ? { planSteps: current.planSteps } : {}),
    ...(update.tokenCount !== undefined ? { tokenCount: update.tokenCount } : current?.tokenCount !== undefined ? { tokenCount: current.tokenCount } : {})
  };
}
