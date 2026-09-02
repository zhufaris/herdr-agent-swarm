import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderRequestAnswerCard } from "../cards/run-card.js";
import { createBridgeEvent } from "../domain/create-bridge-event.js";
import type { BindingStorePort, TraexTranscriptCursorPort, TraexTranscriptObservation, TraexTranscriptReaderPort } from "../domain/ports.js";
import { createQueuedRunCard } from "../domain/run-card-view.js";
import type { Binding, EventOrigin, ExternalTurnSupersessionFence, PromptJob } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { outputFingerprint } from "../runtime/output.js";
import { safeLogError } from "../runtime/safe-error.js";

type ExternalTurnStore = Pick<BindingStorePort, "adoptExternalTurn" | "completeTurn" | "countPendingPrompts" | "failPrompt" | "findBindingByPane" | "getActiveExternalPrompt" | "getBinding" | "getPrompt" | "listBindingsByState">;

interface ExternalTurnObserverOptions {
  store: ExternalTurnStore;
  transcriptReader: TraexTranscriptReaderPort;
  bus: LifecycleEventPublisher;
  outboundWork: OutboundWorkNotifier;
  logger: Logger;
  isBindingBusy(bindingId: string): boolean;
  wakePrompt(bindingId: string): void;
  idFactory?: () => string;
}

interface TurnProjectionState {
  pendingStarts: Map<string, string>;
  promptsByTurn: Map<string, { promptId: string; chunks: string[] }>;
}

interface ObservedBinding extends TurnProjectionState {
  identity: string;
  cursor: TraexTranscriptCursorPort;
}

const MAX_DRAIN_OBSERVATIONS = 8;
const MAX_AWAKE_OBSERVATIONS = 256;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export class ExternalTurnObserver {
  private readonly bindings = new Map<string, ObservedBinding>();
  private readonly handedOffBindings = new Map<string, { identity: string; state: TurnProjectionState }>();
  private readonly observations = new Map<string, Promise<void>>();
  private readonly idFactory: () => string;
  private timer: NodeJS.Timeout | null = null;
  private scan: Promise<void> | null = null;
  private stopping = false;

  constructor(private readonly options: ExternalTurnObserverOptions) {
    this.idFactory = options.idFactory ?? randomUUID;
  }

  start(intervalMs = DEFAULT_POLL_INTERVAL_MS): void {
    if (this.stopping || this.timer) return;
    this.timer = setInterval(() => { void this.scanActiveBindings(); }, intervalMs);
    this.timer.unref();
  }

  async observe(binding: Binding): Promise<void> {
    return this.enqueueObservation(binding, false);
  }

  async handoff(bindingId: string): Promise<void> {
    const binding = this.options.store.getBinding(bindingId);
    if (!binding) return;
    await this.enqueueObservation(binding, true);
  }

  async observeByPane(paneIds: readonly string[]): Promise<void> {
    await Promise.all([...new Set(paneIds)].map(async (paneId) => {
      const binding = this.options.store.findBindingByPane(paneId);
      if (binding?.state === "active") await this.observe(binding);
    }));
  }

  async observeSupersedingTurn(binding: Binding, prompt: PromptJob, observation: TraexTranscriptObservation): Promise<"ignored" | "pending" | "observing" | "completed"> {
    const session = sessionFor(binding);
    if (!session || !binding.paneId || !prompt.transcriptTurnId || !prompt.transcriptTurnStartedAt) return "ignored";
    const identity = `${binding.generation}:${binding.paneId}:${session.source}:${session.agent}:${session.kind}:${session.value}`;
    let handedOff = this.handedOffBindings.get(binding.id);
    if (!handedOff || handedOff.identity !== identity) {
      handedOff = { identity, state: { pendingStarts: new Map(), promptsByTurn: new Map() } };
      this.handedOffBindings.set(binding.id, handedOff);
    }
    const outcome = await this.apply(binding, session, handedOff.state, observation, { promptId: prompt.id, turnId: prompt.transcriptTurnId, startedAt: prompt.transcriptTurnStartedAt });
    if (outcome === "completed") this.handedOffBindings.delete(binding.id);
    return outcome;
  }

  async recoverAfterDetachedTurn(binding: Binding, prompt: PromptJob): Promise<{ outcome: "recovered"; recoveredTurns: number } | { outcome: "none" | "unavailable"; reason: string }> {
    const session = sessionFor(binding);
    if (!session || !binding.paneId || !prompt.transcriptTurnId || !prompt.transcriptTurnStartedAt) return { outcome: "unavailable", reason: "missing_exact_turn_identity" };
    if (!this.options.transcriptReader.openAfterTurn) return { outcome: "unavailable", reason: "recovery_cursor_unavailable" };
    const opened = await this.options.transcriptReader.openAfterTurn(session, prompt.transcriptTurnId, prompt.transcriptTurnStartedAt);
    if (opened.mode !== "typed") return { outcome: "unavailable", reason: opened.reason };
    const state: TurnProjectionState = { pendingStarts: new Map(), promptsByTurn: new Map() };
    let supersede: ExternalTurnSupersessionFence | undefined = { promptId: prompt.id, turnId: prompt.transcriptTurnId, startedAt: prompt.transcriptTurnStartedAt };
    const completedTurns = new Set<string>();
    for (let count = 0; count < MAX_AWAKE_OBSERVATIONS; count += 1) {
      const observation = opened.cursor.readObservation ? await opened.cursor.readObservation() : { answerDelta: await opened.cursor.readDelta() };
      if (!hasObservation(observation)) break;
      const outcome = await this.apply(binding, session, state, observation, supersede);
      if (outcome === "observing" || outcome === "completed") supersede = undefined;
      if (outcome === "completed" && observation.turnId) completedTurns.add(observation.turnId);
    }
    return completedTurns.size > 0 ? { outcome: "recovered", recoveredTurns: completedTurns.size } : { outcome: "none", reason: "no_complete_later_turn" };
  }

  private async enqueueObservation(binding: Binding, force: boolean): Promise<void> {
    const previous = this.observations.get(binding.id) ?? Promise.resolve();
    const observation = previous.catch(() => undefined).then(() => this.observeBinding(binding, force));
    this.observations.set(binding.id, observation);
    try { await observation; }
    finally { if (this.observations.get(binding.id) === observation) this.observations.delete(binding.id); }
  }

  async scanActiveBindings(): Promise<void> {
    if (this.stopping) return;
    if (this.scan) return this.scan;
    const scan = Promise.all(this.options.store.listBindingsByState("active").map((binding) => this.observe(binding))).then(() => undefined);
    this.scan = scan;
    try { await scan; }
    catch (error) {
      this.options.logger.warn({ event: "external-turn-scan-failed", err: safeLogError(error), outcome: "deferred" }, "failed to scan active bindings for external Herdr turns");
    } finally { if (this.scan === scan) this.scan = null; }
  }

  private async observeBinding(binding: Binding, force = false): Promise<void> {
    if (this.stopping) return;
    const session = sessionFor(binding);
    if (!session || !binding.paneId) { this.bindings.delete(binding.id); return; }
    const identity = `${binding.generation}:${binding.paneId}:${session.source}:${session.agent}:${session.kind}:${session.value}`;
    let observed = this.bindings.get(binding.id);
    if (!observed || observed.identity !== identity) {
      const durable = this.options.store.getActiveExternalPrompt(binding.id, binding.generation);
      const opened = durable?.transcriptTurnId && durable.transcriptTurnStartedAt && this.options.transcriptReader.openAtTurn
        ? await this.options.transcriptReader.openAtTurn(session, durable.transcriptTurnId, durable.transcriptTurnStartedAt)
        : await this.options.transcriptReader.open(session);
      if (opened.mode !== "typed") { this.bindings.delete(binding.id); return; }
      observed = { identity, cursor: opened.cursor, pendingStarts: new Map(), promptsByTurn: new Map() };
      if (durable?.transcriptTurnId && durable.transcriptTurnStartedAt) {
        observed.pendingStarts.set(durable.transcriptTurnId, durable.transcriptTurnStartedAt);
        observed.promptsByTurn.set(durable.transcriptTurnId, { promptId: durable.id, chunks: [] });
      }
      this.bindings.set(binding.id, observed);
      return;
    }
    if (!force && this.options.isBindingBusy(binding.id) && observed.promptsByTurn.size === 0) return;
    try {
      for (let count = 0; count < MAX_DRAIN_OBSERVATIONS; count += 1) {
        const observation = observed.cursor.readObservation
          ? await observed.cursor.readObservation()
          : { answerDelta: await observed.cursor.readDelta() };
        if (!hasObservation(observation)) break;
        await this.apply(binding, session, observed, observation);
      }
    } catch (error) {
      this.bindings.delete(binding.id);
      this.options.logger.warn({ event: "external-turn-observation-failed", err: safeLogError(error), bindingId: binding.id, paneId: binding.paneId, outcome: "deferred" }, "failed to observe external Herdr turn");
    }
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.scan) await this.scan;
    await Promise.all(this.observations.values());
    this.bindings.clear();
    this.handedOffBindings.clear();
  }

  private async apply(binding: Binding, session: NonNullable<ReturnType<typeof sessionFor>>, observed: TurnProjectionState, observation: TraexTranscriptObservation, supersede?: ExternalTurnSupersessionFence): Promise<"ignored" | "pending" | "observing" | "completed"> {
    const lifecycle = observation.turnLifecycle;
    if (observation.freshTurnStart && lifecycle) observed.pendingStarts.set(lifecycle.turnId, lifecycle.startedAt);
    const turnId = observation.turnId ?? lifecycle?.turnId;
    if (!turnId) return "ignored";
    if (lifecycle && !supersede && !observed.pendingStarts.has(turnId)) observed.pendingStarts.set(turnId, lifecycle.startedAt);
    let owned = observed.promptsByTurn.get(turnId);
    if (!owned && observation.requestText !== undefined) {
      const startedAt = observed.pendingStarts.get(turnId) ?? (supersede ? undefined : lifecycle?.startedAt);
      if (!startedAt) return "ignored";
      const externalPromptId = this.idFactory();
      const externalView = createQueuedRunCard({
        promptId: externalPromptId, bindingId: binding.id, bindingGeneration: binding.generation, title: requestTitle(observation.requestText),
        sessionTitle: binding.title, workspaceId: binding.workspaceId, paneId: binding.paneId, requestText: observation.requestText, queuePosition: 0, occurredAt: startedAt
      });
      const result = this.options.store.adoptExternalTurn({
        bindingId: binding.id, expectedGeneration: binding.generation, expectedPaneId: binding.paneId!, expectedSession: session,
        turnId, startedAt, requestText: observation.requestText, externalPromptId, externalMessageId: `herdr-turn:${session.value}:${turnId}`,
        ...(supersede ? { supersede } : {}),
        externalView, answerCardFor: renderRequestAnswerCard
      });
      if ((result.outcome !== "adopted_queued" && result.outcome !== "created_external" && result.outcome !== "already_owned") || !result.prompt) return "ignored";
      if (result.outcome === "already_owned" && result.prompt.executionOrigin === "bridge") {
        observed.pendingStarts.delete(turnId);
        return "ignored";
      }
      if (result.outcome === "already_owned" && result.prompt.state !== "running") {
        observed.pendingStarts.delete(turnId);
        return "completed";
      }
      owned = { promptId: result.prompt.id, chunks: [] };
      observed.promptsByTurn.set(turnId, owned);
      if (result.outboxReserved) this.options.outboundWork.wake();
      for (const promptId of result.supersededPromptIds) {
        await this.publish(binding.id, "TurnFailed", "herdr", { promptId, error: "A newer Herdr turn superseded this detached turn; its prior outcome remains uncertain.", queueDepth: this.options.store.countPendingPrompts(binding.id) });
      }
      await this.publish(binding.id, "TurnStarted", "herdr", { promptId: owned.promptId, queueDepth: this.options.store.countPendingPrompts(binding.id) });
      this.options.logger.info({ event: "external-turn-adopted", bindingId: binding.id, promptId: owned.promptId, paneId: binding.paneId, turnId, adoption: result.outcome, supersededPromptCount: result.supersededPromptIds.length, outcome: "observing" }, "adopted external Herdr turn for Answer Card projection");
    }
    if (!owned) return observation.freshTurnStart ? "pending" : "ignored";
    if (observation.answerDelta) owned.chunks.push(observation.answerDelta);
    if (observation.answerDelta || observation.toolActivities?.length || observation.mainStatus) {
      await this.publish(binding.id, "TurnOutputObserved", "herdr", {
        promptId: owned.promptId, observation: {
          answer: { snapshot: observation.answerDelta, update: "append", toolActivities: observation.toolActivities ?? [] },
          main: { ...(observation.mainStatus ? { status: {
            ...(observation.mainStatus.statusTitle ? { statusTitle: observation.mainStatus.statusTitle } : {}),
            ...(observation.mainStatus.planSteps ? { planSteps: observation.mainStatus.planSteps.map((step) => ({ ...step, kind: "step" as const })) } : {}),
            ...(observation.mainStatus.tokenCount !== undefined ? { tokenCount: observation.mainStatus.tokenCount } : {})
          } } : {}) }
        }
      });
    }
    if (lifecycle?.state === "completed") {
      const current = this.options.store.getPrompt(owned.promptId);
      if (current?.state === "running") {
        const answer = lifecycle.finalAnswer ?? owned.chunks.join("\n\n");
        this.options.store.completeTurn({ promptId: owned.promptId, bindingId: binding.id, answer, occurredAt: new Date().toISOString(), outputFingerprint: outputFingerprint(answer), replaceAnswer: Boolean(lifecycle.finalAnswer) });
        await this.publish(binding.id, "TurnCompleted", "herdr", { promptId: owned.promptId, answer, queueDepth: this.options.store.countPendingPrompts(binding.id) });
      }
      observed.promptsByTurn.delete(turnId);
      observed.pendingStarts.delete(turnId);
      this.options.wakePrompt(binding.id);
      return "completed";
    }
    if (lifecycle?.state === "aborted") {
      const current = this.options.store.getPrompt(owned.promptId);
      if (current?.state === "running") {
        const reason = lifecycle.reason === "interrupted"
          ? "TraeX turn was interrupted by a human operator"
          : `TraeX turn was aborted${lifecycle.reason ? `: ${lifecycle.reason}` : ""}`;
        this.options.store.failPrompt({ promptId: owned.promptId, error: reason, occurredAt: new Date().toISOString() });
        await this.publish(binding.id, "TurnFailed", "herdr", { promptId: owned.promptId, error: reason, queueDepth: this.options.store.countPendingPrompts(binding.id) });
      }
      observed.promptsByTurn.delete(turnId);
      observed.pendingStarts.delete(turnId);
      this.options.wakePrompt(binding.id);
      return "completed";
    }
    return "observing";
  }

  private async publish<T extends Parameters<typeof createBridgeEvent>[1]>(bindingId: string, type: T, origin: EventOrigin, payload: Extract<ReturnType<typeof createBridgeEvent>, { type: T }>["payload"]): Promise<void> {
    await this.options.bus.publish(createBridgeEvent(bindingId, type, origin, payload));
  }
}

function sessionFor(binding: Binding) {
  return binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
    ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue }
    : null;
}

function hasObservation(value: TraexTranscriptObservation): boolean {
  return Boolean(value.freshTurnStart || value.requestText !== undefined || value.answerDelta || value.toolActivities?.length || value.mainStatus || value.turnLifecycle?.state === "completed" || value.turnLifecycle?.state === "aborted");
}

function requestTitle(body: string): string { const normalized = body.replace(/\s+/g, " " ).trim(); return normalized.length > 64 ? normalized.slice(0, 63) + "…" : normalized || "TraeX request"; }
