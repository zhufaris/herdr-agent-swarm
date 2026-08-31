import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderRequestAnswerCard } from "../cards/run-card.js";
import { createBridgeEvent } from "../domain/create-bridge-event.js";
import type { BindingStorePort, TraexTranscriptCursorPort, TraexTranscriptObservation, TraexTranscriptReaderPort } from "../domain/ports.js";
import { createQueuedRunCard } from "../domain/run-card-view.js";
import type { Binding, EventOrigin } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import { outputFingerprint } from "../runtime/output.js";
import { safeLogError } from "../runtime/safe-error.js";

type ExternalTurnStore = Pick<BindingStorePort, "adoptExternalTurn" | "completeTurn" | "countPendingPrompts" | "findBindingByPane" | "getBinding" | "getPrompt" | "listBindingsByState">;

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

interface ObservedBinding {
  identity: string;
  cursor: TraexTranscriptCursorPort;
  pendingStarts: Map<string, string>;
  promptsByTurn: Map<string, { promptId: string; chunks: string[] }>;
}

const MAX_DRAIN_OBSERVATIONS = 8;
const DEFAULT_POLL_INTERVAL_MS = 2_000;

export class ExternalTurnObserver {
  private readonly bindings = new Map<string, ObservedBinding>();
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
      const opened = await this.options.transcriptReader.open(session);
      if (opened.mode !== "typed") { this.bindings.delete(binding.id); return; }
      observed = { identity, cursor: opened.cursor, pendingStarts: new Map(), promptsByTurn: new Map() };
      this.bindings.set(binding.id, observed);
      return;
    }
    if (!force && this.options.isBindingBusy(binding.id)) return;
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
  }

  private async apply(binding: Binding, session: NonNullable<ReturnType<typeof sessionFor>>, observed: ObservedBinding, observation: TraexTranscriptObservation): Promise<void> {
    const lifecycle = observation.turnLifecycle;
    if (observation.freshTurnStart && lifecycle) observed.pendingStarts.set(lifecycle.turnId, lifecycle.startedAt);
    const turnId = observation.turnId ?? lifecycle?.turnId;
    if (!turnId) return;
    if (lifecycle && !observed.pendingStarts.has(turnId)) observed.pendingStarts.set(turnId, lifecycle.startedAt);
    let owned = observed.promptsByTurn.get(turnId);
    if (!owned && observation.requestText !== undefined) {
      const startedAt = observed.pendingStarts.get(turnId) ?? lifecycle?.startedAt;
      if (!startedAt) return;
      const externalPromptId = this.idFactory();
      const externalView = createQueuedRunCard({
        promptId: externalPromptId, bindingId: binding.id, bindingGeneration: binding.generation, title: requestTitle(observation.requestText),
        sessionTitle: binding.title, workspaceId: binding.workspaceId, paneId: binding.paneId, requestText: observation.requestText, queuePosition: 0, occurredAt: startedAt
      });
      const result = this.options.store.adoptExternalTurn({
        bindingId: binding.id, expectedGeneration: binding.generation, expectedPaneId: binding.paneId!, expectedSession: session,
        turnId, startedAt, requestText: observation.requestText, externalPromptId, externalMessageId: `herdr-turn:${session.value}:${turnId}`,
        externalView, answerCardFor: renderRequestAnswerCard
      });
      if ((result.outcome !== "adopted_queued" && result.outcome !== "created_external" && result.outcome !== "already_owned") || !result.prompt) return;
      if (result.outcome === "already_owned" && result.prompt.executionOrigin === "bridge") {
        observed.pendingStarts.delete(turnId);
        return;
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
    if (!owned) return;
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
    }
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
  return Boolean(value.freshTurnStart || value.requestText !== undefined || value.answerDelta || value.toolActivities?.length || value.mainStatus || value.turnLifecycle?.state === "completed");
}

function requestTitle(body: string): string { const normalized = body.replace(/\s+/g, " " ).trim(); return normalized.length > 64 ? normalized.slice(0, 63) + "…" : normalized || "TraeX request"; }
