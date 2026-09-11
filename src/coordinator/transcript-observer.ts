import type { Logger } from "pino";
import type { TraexTranscriptObservation, TraexTranscriptReaderPort } from "../domain/ports/external.js";
import type { PromptRunStore } from "../domain/ports/prompt-run.js";
import type { Binding, PromptJob } from "../domain/types.js";
import { ExactTurnObserver, type ExactTurnCursor } from "../runtime/exact-turn-observer.js";
import { safeLogError } from "../runtime/safe-error.js";
import { projectOwnedTranscriptOutput } from "./owned-transcript-output-projector.js";
import { transcriptSessionFor } from "../domain/transcript-observer-identity.js";

export type TurnOutputSource =
  | { mode: "unavailable"; reason: string }
  | { mode: "typed"; cursor: ExactTurnCursor; emitted: boolean; chunks: string[]; terminalLifecycle?: NonNullable<TraexTranscriptObservation["turnLifecycle"]> };

interface TranscriptObserverOptions {
  store: Pick<PromptRunStore, "getBinding" | "getPrompt" | "claimPromptTranscriptTurn">;
  reader?: TraexTranscriptReaderPort;
  logger: Logger;
  isBindingActive(bindingId: string): boolean;
  isStopping(): boolean;
  publishObservation(bindingId: string, promptId: string, observation: NonNullable<ReturnType<typeof projectOwnedTranscriptOutput>["observation"]>): Promise<void>;
  identityPollMs?: number;
  attachedPollMs?: number;
}

const FIRST_TURN_TRANSCRIPT_IDENTITY_GRACE_MS = 3_000;
const TRANSCRIPT_IDENTITY_MAX_POLL_MS = 500;
const FINAL_TRANSCRIPT_DRAIN_LIMIT = 8;
const MAX_TRANSCRIPT_CONFLICT_PROMPTS = 256;
const MAX_TRANSCRIPT_CONFLICT_TURNS_PER_PROMPT = 16;

export class TranscriptObserver {
  private readonly conflictTurns = new Map<string, Set<string>>();
  private readonly exactTurns: ExactTurnObserver | undefined;
  private readonly identityPollMs: number;
  private readonly attachedPollMs: number;

  constructor(private readonly options: TranscriptObserverOptions) {
    this.exactTurns = options.reader ? new ExactTurnObserver(options.reader) : undefined;
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
    const session = transcriptSessionFor(binding);
    try {
      const result = await this.exactTurns.open({ session, boundary: { kind: "latest" } });
      return result.mode === "typed"
        ? { mode: "typed", cursor: result.cursor, emitted: false, chunks: [] }
        : { mode: "unavailable", reason: result.reason };
    } catch (error) {
      this.options.logger.warn({ event: "traex-transcript-open-failed", err: safeLogError(error), bindingId: binding.id, paneId: binding.paneId, unavailableReason: "transcript_validation_failed", outcome: "structured_output_unavailable" }, "could not open typed TraeX transcript");
      return { mode: "unavailable", reason: "transcript_validation_failed" };
    }
  }

  async acquire(binding: Binding, signal: AbortSignal): Promise<TurnOutputSource> {
    const startedAt = Date.now();
    let current = binding;
    let source = await this.open(current);
    const canRetry = () => source.mode === "unavailable" && (
      source.reason === "missing_session_identity" ||
      source.reason === "transcript_not_found" && Boolean(this.options.reader) && Boolean(current.agentSessionValue)
    );
    if (!canRetry() || current.hasCompletedTurn) return source;
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

  async read(source: TurnOutputSource, binding: Binding, promptId: string): Promise<{ source: TurnOutputSource; observation: TraexTranscriptObservation }> {
    if (source.mode === "unavailable") return { source, observation: { answerDelta: "" } };
    try {
      const result = await source.cursor.read();
      return { source, observation: result.kind === "accepted" ? result.observation : { answerDelta: "" } };
    } catch (error) {
      const outcome = source.emitted ? "typed_output_preserved" : "structured_output_unavailable";
      this.options.logger.warn({ event: "traex-transcript-read-failed", err: safeLogError(error), bindingId: binding.id, promptId, paneId: binding.paneId, unavailableReason: "transcript_read_failed", outcome }, "typed TraeX transcript became unavailable");
      return { source: source.emitted ? source : { mode: "unavailable", reason: "transcript_read_failed" }, observation: { answerDelta: "" } };
    }
  }

  async observeAttached(input: { source: TurnOutputSource; binding: Binding; prompt: PromptJob; startedAt: number; signal: AbortSignal; confirmDispatched(): void; updateSource(source: TurnOutputSource): void }): Promise<void> {
    let source = input.source;
    await abortableWait(this.attachedPollMs, input.signal).catch(() => undefined);
    while (!this.options.isStopping() && !input.signal.aborted && this.options.isBindingActive(input.binding.id)) {
      const typed = await this.read(source, input.binding, input.prompt.id);
      source = typed.source;
      input.updateSource(source);
      if (typed.observation.freshTurnStart === true && typed.observation.turnLifecycle) input.confirmDispatched();
      const owned = this.own(input.binding, input.prompt, typed.observation);
      if (owned.owned) {
        this.retain(source, owned.observation);
        await this.publish(input.binding.id, input.prompt.id, owned.observation, input.startedAt);
      }
      await abortableWait(this.attachedPollMs, input.signal).catch(() => undefined);
    }
  }

  async drain(source: TurnOutputSource, binding: Binding, prompt: PromptJob, startedAt: number): Promise<TurnOutputSource> {
    if (source.mode !== "typed") return source;
    try {
      await source.cursor.drain({ limit: FINAL_TRANSCRIPT_DRAIN_LIMIT, onObservation: async (observation) => {
        const owned = this.own(binding, prompt, observation);
        if (owned.owned) {
          this.retain(source, owned.observation);
          await this.publish(binding.id, prompt.id, owned.observation, startedAt);
          if (owned.observation.turnLifecycle?.state === "completed") return "stop";
        }
        return "continue";
      } });
    } catch (error) {
      const outcome = source.emitted ? "typed_output_preserved" : "structured_output_unavailable";
      this.options.logger.warn({ event: "traex-transcript-read-failed", err: safeLogError(error), bindingId: binding.id, promptId: prompt.id, paneId: binding.paneId, unavailableReason: "transcript_read_failed", outcome }, "typed TraeX transcript became unavailable");
      return source.emitted ? source : { mode: "unavailable", reason: "transcript_read_failed" };
    }
    return source;
  }

  own(binding: Binding, prompt: PromptJob, observation: TraexTranscriptObservation): { owned: boolean; prompt: PromptJob; observation: TraexTranscriptObservation } {
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
    const detachedIdentityMatches = ownedPrompt.observationState !== "detached" || observation.turnLifecycle?.startedAt === ownedPrompt.transcriptTurnStartedAt;
    const owned = ownedPrompt.transcriptTurnId !== null && observation.turnId === ownedPrompt.transcriptTurnId && detachedIdentityMatches;
    if (!owned && ownedPrompt.transcriptTurnId) this.logConflict(binding, current.id, ownedPrompt.transcriptTurnId, observation.turnId);
    return { owned, prompt: ownedPrompt, observation };
  }

  retain(source: TurnOutputSource, observation: TraexTranscriptObservation): void {
    if (source.mode !== "typed") return;
    const projection = projectOwnedTranscriptOutput({ state: source, observation });
    source.emitted = projection.state.emitted;
    source.chunks = [...projection.state.chunks];
    if (projection.state.terminalLifecycle) source.terminalLifecycle = projection.state.terminalLifecycle;
  }

  async publishOwned(bindingId: string, promptId: string, observation: TraexTranscriptObservation, startedAt: number): Promise<void> {
    await this.publish(bindingId, promptId, observation, startedAt);
  }

  private async publish(bindingId: string, promptId: string, observation: TraexTranscriptObservation, startedAt: number): Promise<void> {
    const projection = projectOwnedTranscriptOutput({ state: { emitted: false, chunks: [] }, observation, ...(Number.isFinite(startedAt) ? { elapsedSeconds: Math.floor((Date.now() - startedAt) / 1_000) } : {}) });
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

async function abortableWait(ms: number, signal: AbortSignal): Promise<void> {
  if (signal.aborted) throw new Error("aborted");
  await new Promise<void>((resolve, reject) => {
    const timer = setTimeout(resolve, ms);
    signal.addEventListener("abort", () => { clearTimeout(timer); reject(new Error("aborted")); }, { once: true });
  });
}
