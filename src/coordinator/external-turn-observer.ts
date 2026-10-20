import type { Logger } from "pino";
import { createBridgeEvent } from "../domain/create-bridge-event.js";
import { transcriptObserverIdentity, transcriptSourceFor } from "../domain/transcript-observer-identity.js";
import type { BindingPromptWorkflowPort } from "../domain/ports/prompt-acceptance.js";
import type { ExternalTurnObservationStore } from "../domain/ports/workflow.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import type { AgentTranscriptObservation, AgentTranscriptReaderPort } from "../domain/ports/external.js";
import type { Binding, EventOrigin, ExternalTurnSupersessionFence, HerdrAgentSession, PromptJob } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { ExactTurnObserver, type ExactTurnCursor } from "../runtime/exact-turn-observer.js";
import { safeLogError } from "../runtime/safe-error.js";
import { createBoundedTurnOutput, type BoundedTurnOutput } from "../runtime/bounded-turn-output.js";
import { mapWithConcurrency } from "../runtime/map-with-concurrency.js";

type ExternalTurnStore = ExternalTurnObservationStore;

interface ExternalTurnObserverOptions {
  store: ExternalTurnStore;
  workflow: Pick<BindingPromptWorkflowPort, "applyCoreObservation">;
  transcriptReader: AgentTranscriptReaderPort;
  bus: LifecycleEventPublisher;
  outboundWork: OutboundWorkNotifier;
  logger: Logger;
  wakePrompt(bindingId: string): void;
  presentation: Pick<PrimaryPresentation, "answerCard" | "primaryHumanReviewNotification">;
  pollIntervalMs?: number;
  recoveryNotFoundMaxAttempts?: number;
}
interface TurnProjectionState {
  pendingStarts: Map<string, string>;
  promptsByTurn: Map<string, { promptId: string; output: BoundedTurnOutput }>;
}
interface ExternalTurnRecoveryFence {
  promptId: string;
  bindingId: string;
  expectedGeneration: number;
  expectedPaneId: string;
  expectedSession: HerdrAgentSession;
  turnId: string;
  startedAt: string;
}
interface ObservedBinding extends TurnProjectionState {
  identity: string;
  cursor: ExactTurnCursor;
  cursorKind: "exact" | "active";
  recoveryFence: ExternalTurnRecoveryFence | null;
  idleWithoutTerminalConfirmations: number;
  lastIdleObservedAt: string | null;
}

const MAX_DRAIN_OBSERVATIONS = 8;
const MAX_DRAIN_PAGES_PER_WAKE = 8;
const MAX_AWAKE_OBSERVATIONS = 256;
const ACTIVE_BINDING_OBSERVATION_CONCURRENCY = 4;
const IDLE_WITHOUT_TERMINAL_CONFIRMATIONS = 2;
const MISSING_TERMINAL_EVENT_ERROR = "TraeX returned idle without a terminal transcript event; the outcome is unknown and the prompt was not replayed";

export class ExternalTurnObserver {
  private readonly bindings = new Map<string, ObservedBinding>();
  private readonly handedOffBindings = new Map<string, { identity: string; state: TurnProjectionState }>();
  private readonly observations = new Map<string, Promise<void>>();
  private readonly handedOffInFlight = new Set<string>();
  private readonly inFlight = new Set<Promise<unknown>>();
  private readonly exactTurns: ExactTurnObserver;
  private timer: NodeJS.Timeout | null = null;
  private scan: Promise<void> | null = null;
  private stopPromise: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly options: ExternalTurnObserverOptions) {
    this.exactTurns = new ExactTurnObserver(options.transcriptReader);
  }

  start(intervalMs = this.options.pollIntervalMs ?? 2_000): void {
    if (this.stopping || this.timer) return;
    this.timer = setInterval(() => { void this.scanActiveBindings(); }, intervalMs);
    this.timer.unref();
    // An active cursor deliberately establishes its exact boundary before it
    // consumes transcript data. On a fresh process the first scan therefore
    // opens the cursor and the second drains it. Do both now rather than
    // waiting a full polling interval before projecting a running local turn.
    void this.runStartupScans();
  }

  private async runStartupScans(): Promise<void> {
    await this.scanActiveBindings();
    await this.scanActiveBindings();
  }

  observe(binding: Binding): Promise<void> {
    if (this.stopping || binding.agentKind !== "traex") return Promise.resolve();
    return this.track(() => this.enqueueObservation(binding, false));
  }

  handoff(bindingId: string): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return this.track(async () => {
      const binding = this.options.store.getBinding(bindingId);
      if (binding?.agentKind === "traex") await this.enqueueObservation(binding, true);
    });
  }

  catchUp(bindingId: string): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return this.track(async () => {
      const binding = this.options.store.getBinding(bindingId);
      if (binding?.agentKind === "traex") await this.enqueueObservation(binding, true, false);
    });
  }

  observeByPane(paneIds: readonly string[]): Promise<void> {
    if (this.stopping) return Promise.resolve();
    return this.track(async () => {
      await Promise.all([...new Set(paneIds)].map(async (paneId) => {
        const binding = this.options.store.findBindingByPane(paneId);
        if (binding?.state === "active" && binding.agentKind === "traex") await this.observe(binding);
      }));
    });
  }

  observeSupersedingTurn(binding: Binding, prompt: PromptJob, observation: AgentTranscriptObservation): Promise<"ignored" | "pending" | "observing" | "completed"> {
    if (this.stopping || binding.agentKind !== "traex") return Promise.resolve("ignored");
    return this.track(async () => {
      this.handedOffInFlight.add(binding.id);
      try { return await this.observeSupersedingTurnInLifecycle(binding, prompt, observation); }
      finally { this.handedOffInFlight.delete(binding.id); }
    });
  }

  private async observeSupersedingTurnInLifecycle(binding: Binding, prompt: PromptJob, observation: AgentTranscriptObservation): Promise<"ignored" | "pending" | "observing" | "completed"> {
    const source = transcriptSourceFor(binding);
    const session = source.nativeSession;
    const identity = transcriptObserverIdentity(binding);
    if (!session || !identity || !binding.paneId || !prompt.transcriptTurnId || !prompt.transcriptTurnStartedAt) return "ignored";
    let handedOff = this.handedOffBindings.get(binding.id);
    if (!handedOff || handedOff.identity !== identity) {
      handedOff = { identity, state: { pendingStarts: new Map(), promptsByTurn: new Map() } };
      this.handedOffBindings.set(binding.id, handedOff);
    }
    const outcome = await this.apply(binding, session, handedOff.state, observation, { promptId: prompt.id, turnId: prompt.transcriptTurnId, startedAt: prompt.transcriptTurnStartedAt });
    if (outcome === "completed") this.handedOffBindings.delete(binding.id);
    return outcome;
  }

  recoverAfterDetachedTurn(binding: Binding, prompt: PromptJob): Promise<{ outcome: "recovered"; recoveredTurns: number } | { outcome: "none" | "unavailable"; reason: string }> {
    if (this.stopping) return Promise.resolve({ outcome: "unavailable", reason: "observer_stopping" });
    if (binding.agentKind !== "traex") return Promise.resolve({ outcome: "unavailable", reason: "unsupported_agent_kind" });
    return this.track(() => this.recoverAfterDetachedTurnInLifecycle(binding, prompt));
  }

  private async recoverAfterDetachedTurnInLifecycle(binding: Binding, prompt: PromptJob): Promise<{ outcome: "recovered"; recoveredTurns: number } | { outcome: "none" | "unavailable"; reason: string }> {
    const source = transcriptSourceFor(binding);
    const session = source.nativeSession;
    if (!session || !binding.paneId || !prompt.transcriptTurnId || !prompt.transcriptTurnStartedAt) return { outcome: "unavailable", reason: "missing_exact_turn_identity" };
    const opened = await this.exactTurns.open({
      source,
      boundary: { kind: "after", turnId: prompt.transcriptTurnId, startedAt: prompt.transcriptTurnStartedAt }
    });
    if (opened.mode !== "typed") return { outcome: "unavailable", reason: opened.reason };
    const state: TurnProjectionState = { pendingStarts: new Map(), promptsByTurn: new Map() };
    let supersede: ExternalTurnSupersessionFence | undefined = { promptId: prompt.id, turnId: prompt.transcriptTurnId, startedAt: prompt.transcriptTurnStartedAt };
    const completedTurns = new Set<string>();
    await opened.cursor.drain({ limit: MAX_AWAKE_OBSERVATIONS, onObservation: async (observation) => {
      const outcome = await this.apply(binding, session, state, observation, supersede);
      if (outcome === "observing" || outcome === "completed") supersede = undefined;
      if (outcome === "completed" && observation.turnId) completedTurns.add(observation.turnId);
      return "continue" as const;
    } });
    return completedTurns.size > 0 ? { outcome: "recovered", recoveredTurns: completedTurns.size } : { outcome: "none", reason: "no_complete_later_turn" };
  }

  private async enqueueObservation(binding: Binding, force: boolean, wakeLegacyPrompt = true): Promise<void> {
    const previous = this.observations.get(binding.id) ?? Promise.resolve();
    const observation = previous.catch(() => undefined).then(() => this.observeBinding(binding, force, wakeLegacyPrompt));
    this.observations.set(binding.id, observation);
    try { await observation; }
    finally { if (this.observations.get(binding.id) === observation) this.observations.delete(binding.id); }
  }

  async scanActiveBindings(): Promise<void> {
    if (this.stopping) return;
    if (this.scan) return this.scan;
    const scan = this.track(async () => {
      const active = this.options.store.listBindingsByState("active").filter((binding) => binding.agentKind === "traex");
      await mapWithConcurrency(active, ACTIVE_BINDING_OBSERVATION_CONCURRENCY, (binding) => this.observe(binding));
      this.releaseInactiveBindings(new Set(active.map(({ id }) => id)));
    });
    this.scan = scan;
    try { await scan; }
    catch (error) {
      this.options.logger.warn({ event: "external-turn-scan-failed", err: safeLogError(error), outcome: "deferred" }, "failed to scan active bindings for external Herdr turns");
    } finally { if (this.scan === scan) this.scan = null; }
  }

  private releaseInactiveBindings(activeBindingIds: ReadonlySet<string>): void {
    for (const bindingId of this.bindings.keys()) {
      if (!activeBindingIds.has(bindingId) && !this.observations.has(bindingId)) this.bindings.delete(bindingId);
    }
    for (const bindingId of this.handedOffBindings.keys()) {
      if (!activeBindingIds.has(bindingId) && !this.handedOffInFlight.has(bindingId)) this.handedOffBindings.delete(bindingId);
    }
  }

  private async observeBinding(binding: Binding, force = false, wakeLegacyPrompt = true): Promise<void> {
    if (this.stopping) return;
    const source = transcriptSourceFor(binding);
    const session = source.nativeSession;
    const identity = transcriptObserverIdentity(binding);
    if (!session || !identity || !binding.paneId) { this.bindings.delete(binding.id); return; }
    let observed = this.bindings.get(binding.id);
    let openedNow = false;
    const activeExternalPrompt = this.options.store.getActiveExternalPrompt(binding.id, binding.generation);
    if (activeExternalPrompt) this.observeHumanReview(binding, activeExternalPrompt);
    const activeRecoveryFence: ExternalTurnRecoveryFence | null = activeExternalPrompt?.transcriptTurnId && activeExternalPrompt.transcriptTurnStartedAt ? {
      promptId: activeExternalPrompt.id, bindingId: binding.id, expectedGeneration: binding.generation,
      expectedPaneId: binding.paneId, expectedSession: session, turnId: activeExternalPrompt.transcriptTurnId,
      startedAt: activeExternalPrompt.transcriptTurnStartedAt
    } : null;
    if (observed?.cursorKind === "active" && activeRecoveryFence
      && this.options.store.isExternalTurnRecoveryDue({ ...activeRecoveryFence, now: new Date().toISOString() })) {
      this.bindings.delete(binding.id);
      observed = undefined;
    }
    if (!observed || observed.identity !== identity) {
      let durable = activeExternalPrompt;
      let recoveryFence = activeRecoveryFence;
      if (recoveryFence && durable?.executionOrigin === "herdr" && durable.observationState === "detached") {
        const repaired = this.options.store.repairProjectedExternalTurn({
          ...recoveryFence,
          occurredAt: new Date().toISOString()
        });
        if (repaired.outcome === "repaired") {
          this.bindings.delete(binding.id);
          if (repaired.terminalState === "completed") {
            await this.publish(binding.id, "TurnCompleted", "herdr", {
              promptId: recoveryFence.promptId, answer: repaired.answer,
              queueDepth: this.options.store.countPendingPrompts(binding.id)
            });
          } else {
            await this.publish(binding.id, "TurnFailed", "herdr", {
              promptId: recoveryFence.promptId, error: repaired.error,
              queueDepth: this.options.store.countPendingPrompts(binding.id)
            });
          }
          this.options.logger.info({
            event: "external-turn-projected-owner-repaired", bindingId: binding.id,
            promptId: recoveryFence.promptId, paneId: binding.paneId, turnId: recoveryFence.turnId,
            terminalState: repaired.terminalState, outcome: "repaired"
          }, "repaired external Herdr turn owner from durable projected evidence");
          if (wakeLegacyPrompt) this.options.wakePrompt(binding.id);
          return;
        }
      }
      if (recoveryFence && !this.options.store.isExternalTurnRecoveryDue({ ...recoveryFence, now: new Date().toISOString() })) {
        recoveryFence = null;
        durable = null;
      }
      const opened = await this.exactTurns.open({
        source,
        boundary: durable?.transcriptTurnId && durable.transcriptTurnStartedAt
          ? { kind: "at", turnId: durable.transcriptTurnId, startedAt: durable.transcriptTurnStartedAt }
          : { kind: "active" }
      });
      if (opened.mode !== "typed") {
        this.bindings.delete(binding.id);
        if (recoveryFence) {
          const occurredAt = new Date().toISOString();
          const deferred = this.options.store.deferExternalTurnRecovery({
            ...recoveryFence, failureCode: opened.reason, occurredAt, runtimeObservedAt: binding.lastObservedAt
          });
          if (deferred?.shouldLog) this.options.logger.warn({
            event: "external-turn-recovery-deferred", bindingId: binding.id, promptId: recoveryFence.promptId,
            paneId: binding.paneId, turnId: recoveryFence.turnId, failureCode: opened.reason,
            recoveryState: deferred.recoveryState, attemptCount: deferred.attemptCount,
            nextAttemptAt: deferred.nextAttemptAt, outcome: "deferred"
          }, "deferred external Herdr turn recovery with durable backoff");
          const runtimeIsTerminal = binding.lastAgentState === "idle" || binding.lastAgentState === "done";
          if (opened.reason === "recovery_not_found" && runtimeIsTerminal && binding.lastObservedAt
            && deferred && deferred.attemptCount >= (this.options.recoveryNotFoundMaxAttempts ?? 3)) {
            const failed = this.options.store.failExternalTurnWithoutTerminalEvent({
              ...recoveryFence, expectedObservedAt: binding.lastObservedAt,
              error: "Core historical indexing completed without the exact native turn; the outcome is unknown and the prompt was not replayed",
              occurredAt
            });
            if (failed) {
              this.options.store.clearExternalTurnRecovery(recoveryFence.promptId);
              await this.publish(binding.id, "TurnFailed", "herdr", {
                promptId: recoveryFence.promptId,
                error: "Core historical indexing completed without the exact native turn; the outcome is unknown and the prompt was not replayed",
                queueDepth: this.options.store.countPendingPrompts(binding.id)
              });
              if (wakeLegacyPrompt) this.options.wakePrompt(binding.id);
            }
          }
          if (deferred) return this.observeBinding(binding, force, wakeLegacyPrompt);
        }
        return;
      }
      if (recoveryFence && opened.recoveredIdentity && opened.recoveredIdentity.canonicalStartedAt !== recoveryFence.startedAt) {
        const occurredAt = new Date().toISOString();
        const corrected = this.options.store.correctExternalTurnStartedAt({
          ...recoveryFence,
          expectedStartedAt: recoveryFence.startedAt,
          canonicalStartedAt: opened.recoveredIdentity.canonicalStartedAt,
          occurredAt
        });
        if (!corrected) {
          const deferred = this.options.store.deferExternalTurnRecovery({ ...recoveryFence, failureCode: "canonical_identity_conflict", occurredAt });
          if (deferred?.shouldLog) this.options.logger.warn({
            event: "external-turn-recovery-deferred", bindingId: binding.id, promptId: recoveryFence.promptId,
            paneId: binding.paneId, turnId: recoveryFence.turnId, failureCode: "canonical_identity_conflict",
            recoveryState: deferred.recoveryState, attemptCount: deferred.attemptCount,
            nextAttemptAt: deferred.nextAttemptAt, outcome: "deferred"
          }, "deferred external Herdr turn recovery with durable backoff");
          return;
        }
        recoveryFence = { ...recoveryFence, promptId: corrected.promptId, startedAt: opened.recoveredIdentity.canonicalStartedAt };
        durable = this.options.store.getPrompt(corrected.promptId);
      }
      observed = {
        identity, cursor: opened.cursor, cursorKind: recoveryFence ? "exact" : "active", recoveryFence,
        pendingStarts: new Map(), promptsByTurn: new Map(), idleWithoutTerminalConfirmations: 0, lastIdleObservedAt: null
      };
      if (durable?.transcriptTurnId && durable.transcriptTurnStartedAt) {
        observed.pendingStarts.set(durable.transcriptTurnId, durable.transcriptTurnStartedAt);
        observed.promptsByTurn.set(durable.transcriptTurnId, { promptId: durable.id, output: createBoundedTurnOutput() });
        await this.replayProjectedTurnState(binding, session, observed, durable.transcriptTurnId, durable.transcriptTurnStartedAt);
      }
      this.bindings.set(binding.id, observed);
      openedNow = true;
    }
    // Only a durably-owned, exact bridge turn may consume this transcript in a
    // competing observer. A lagging in-memory worker must not hide a later
    // local Herdr turn after its bridge prompt has already settled.
    if (openedNow && !force) return;
    const bridgePrompt = !force && observed.promptsByTurn.size === 0
      ? this.options.store.getActiveBridgePrompt(binding.id, binding.generation)
      : null;
    const supersedingFence = bridgePrompt?.observationState === "detached" && bridgePrompt.transcriptTurnId && bridgePrompt.transcriptTurnStartedAt
      ? { promptId: bridgePrompt.id, turnId: bridgePrompt.transcriptTurnId, startedAt: bridgePrompt.transcriptTurnStartedAt }
      : undefined;
    if (!force && !openedNow && bridgePrompt && !supersedingFence) return;
    try {
      let supersede = supersedingFence;
      let accepted = 0;
      let drainedPages = 0;
      let drained;
      do {
        drainedPages += 1;
        drained = await observed.cursor.drain({ limit: MAX_DRAIN_OBSERVATIONS, onObservation: async (observation) => {
          const outcome = await this.apply(binding, session, observed, observation, supersede);
          if (outcome === "observing" || outcome === "completed") supersede = undefined;
          return "continue" as const;
        } });
        accepted += drained.accepted;
        if (drained.accepted === MAX_DRAIN_OBSERVATIONS && !drained.stopped && !this.stopping) {
          await new Promise<void>((resolve) => setImmediate(resolve));
        }
      } while (drained.accepted === MAX_DRAIN_OBSERVATIONS && !drained.stopped && !this.stopping && drainedPages < MAX_DRAIN_PAGES_PER_WAKE);
      if (observed.recoveryFence) {
        this.options.store.clearExternalTurnRecovery(observed.recoveryFence.promptId);
        observed.recoveryFence = null;
      }
      if (accepted > 0 || (binding.lastAgentState !== "idle" && binding.lastAgentState !== "done")) {
        observed.idleWithoutTerminalConfirmations = 0;
        observed.lastIdleObservedAt = null;
        return;
      }
      const durable = this.options.store.getActiveExternalPrompt(binding.id, binding.generation);
      if (!durable?.transcriptTurnId || !durable.transcriptTurnStartedAt || !observed.promptsByTurn.has(durable.transcriptTurnId)) {
        observed.idleWithoutTerminalConfirmations = 0;
        observed.lastIdleObservedAt = null;
        return;
      }
      const observedAtMs = binding.lastObservedAt ? Date.parse(binding.lastObservedAt) : Number.NaN;
      const startedAtMs = Date.parse(durable.transcriptTurnStartedAt);
      const previousObservedAtMs = observed.lastIdleObservedAt ? Date.parse(observed.lastIdleObservedAt) : Number.NEGATIVE_INFINITY;
      if (!Number.isFinite(observedAtMs) || !Number.isFinite(startedAtMs) || observedAtMs <= startedAtMs || observedAtMs <= previousObservedAtMs) return;
      observed.lastIdleObservedAt = binding.lastObservedAt;
      observed.idleWithoutTerminalConfirmations += 1;
      if (observed.idleWithoutTerminalConfirmations < IDLE_WITHOUT_TERMINAL_CONFIRMATIONS) return;
      const failed = this.options.store.failExternalTurnWithoutTerminalEvent({
        promptId: durable.id, bindingId: binding.id, expectedGeneration: binding.generation, expectedPaneId: binding.paneId, expectedSession: session, expectedObservedAt: binding.lastObservedAt!,
        turnId: durable.transcriptTurnId, startedAt: durable.transcriptTurnStartedAt, error: MISSING_TERMINAL_EVENT_ERROR, occurredAt: new Date().toISOString()
      });
      observed.idleWithoutTerminalConfirmations = 0;
      if (!failed) return;
      observed.promptsByTurn.delete(durable.transcriptTurnId);
      observed.pendingStarts.delete(durable.transcriptTurnId);
      await this.publish(binding.id, "TurnFailed", "herdr", { promptId: durable.id, error: MISSING_TERMINAL_EVENT_ERROR, queueDepth: this.options.store.countPendingPrompts(binding.id) });
      this.options.logger.warn({ event: "external-turn-terminal-event-missing", bindingId: binding.id, promptId: durable.id, paneId: binding.paneId, turnId: durable.transcriptTurnId, outcome: "failed_closed" }, "failed external Herdr turn after repeated idle observations without a terminal event");
      if (wakeLegacyPrompt) this.options.wakePrompt(binding.id);
    } catch (error) {
      this.bindings.delete(binding.id);
      const safeError = safeLogError(error);
      const failureCode = externalTurnRecoveryFailureCode(safeError);
      const deferred = observed.recoveryFence ? this.options.store.deferExternalTurnRecovery({
        ...observed.recoveryFence, failureCode, occurredAt: new Date().toISOString(), runtimeObservedAt: binding.lastObservedAt
      }) : null;
      if (!observed.recoveryFence || !deferred || deferred.shouldLog) this.options.logger.warn({
        event: "external-turn-observation-failed", err: safeError, bindingId: binding.id,
        promptId: observed.recoveryFence?.promptId, paneId: binding.paneId,
        failureCode, recoveryState: deferred?.recoveryState, attemptCount: deferred?.attemptCount,
        nextAttemptAt: deferred?.nextAttemptAt, outcome: "deferred"
      }, "failed to observe external Herdr turn");
      if (observed.recoveryFence && deferred) return this.observeBinding(binding, force);
    }
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.stopPromise = Promise.allSettled([...this.inFlight]).then(() => {
      this.bindings.clear();
      this.handedOffBindings.clear();
    });
    return this.stopPromise;
  }

  private track<T>(operation: () => Promise<T>): Promise<T> {
    const pending = operation();
    const tracked = pending.finally(() => { this.inFlight.delete(tracked); });
    this.inFlight.add(tracked);
    return tracked;
  }

  private async apply(binding: Binding, session: HerdrAgentSession, observed: TurnProjectionState, observation: AgentTranscriptObservation, supersede?: ExternalTurnSupersessionFence): Promise<"ignored" | "pending" | "observing" | "completed"> {
    const lifecycle = observation.turnLifecycle;
    const turnId = observation.turnId ?? lifecycle?.turnId;
    const wasOwned = turnId ? observed.promptsByTurn.has(turnId) : false;
    const receipt = await this.options.workflow.applyCoreObservation({ origin: "herdr", binding, session, state: observed, observation, ...(supersede ? { supersede } : {}) });
    if (receipt.owned && turnId && !wasOwned) {
      this.options.logger.info({ event: "external-turn-adopted", bindingId: binding.id, promptId: receipt.prompt.id, paneId: binding.paneId, turnId, adoption: "workflow", supersededPromptCount: receipt.supersededPromptIds?.length ?? 0, outcome: "observing" }, "adopted external Herdr turn for Primary card projection");
      const startedAt = observed.pendingStarts.get(turnId) ?? lifecycle?.startedAt;
      if (startedAt) await this.replayProjectedTurnState(binding, session, observed, turnId, startedAt);
    }
    if (receipt.outcome === "projected") return "observing";
    if (receipt.outcome === "detached") return "completed";
    return receipt.outcome;
  }

  private async publish<T extends Parameters<typeof createBridgeEvent>[1]>(bindingId: string, type: T, origin: EventOrigin, payload: Extract<ReturnType<typeof createBridgeEvent>, { type: T }>["payload"]): Promise<void> {
    await this.options.bus.publish(createBridgeEvent(bindingId, type, origin, payload));
  }

  private async replayProjectedTurnState(binding: Binding, session: HerdrAgentSession, observed: TurnProjectionState, turnId: string, startedAt: string): Promise<void> {
    const state = await this.options.transcriptReader.replayProjectedTurnState?.(transcriptSourceFor(binding), turnId, startedAt);
    if (!state) return;
    await this.apply(binding, session, observed, {
      turnId,
      answerDelta: "",
      ...(state.planSteps ? { mainStatus: { planSteps: state.planSteps } } : {}),
      ...(state.goalChanges?.length ? { goalChanges: state.goalChanges } : {})
    });
  }

  private observeHumanReview(binding: Binding, prompt: PromptJob): void {
    if (!binding.paneId || binding.lastAgentState === "unknown") return;
    const observation = this.options.store.observePrimaryPromptState({
      bindingId: binding.id, promptId: prompt.id, expectedGeneration: binding.generation, expectedPaneId: binding.paneId,
      state: binding.lastAgentState, notice: binding.lastAgentState === "blocked" ? "Primary 正在等待 Herdr 中的本地审批或交互输入。" : null,
      occurredAt: new Date().toISOString(), renderHumanReviewNotification: this.options.presentation.primaryHumanReviewNotification
    });
    if (observation.notification.outcome === "reserved") {
      this.options.outboundWork.wake();
      this.options.logger.info({ event: "primary-human-review-notification-reserved", bindingId: binding.id, promptId: prompt.id, paneId: binding.paneId, episodeId: observation.notification.episodeId, notificationKind: observation.notification.kind, mention: observation.notification.mention, outcome: "reserved" }, "reserved Primary human review notification");
    }
  }
}

function externalTurnRecoveryFailureCode(error: ReturnType<typeof safeLogError>): string {
  return error.code === undefined ? "transcript_read_failed" : String(error.code).slice(0, 128);
}
