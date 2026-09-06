import type { Logger } from "pino";
import { normalizeTurnOutputObservation, type BridgeEvent } from "../domain/events.js";
import type { OutboundCheckpointSubscriber, OutboundIntentPort } from "../domain/ports/outbox.js";
import type { AnswerPageStore, MainCardStore, ProjectionStore } from "../domain/ports/projection.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import type { AnswerPageWorkflowPort } from "../coordinator/answer-page-workflow.js";
import { AnswerPageWorkflow } from "../coordinator/answer-page-workflow.js";
import type { MainCardWorkflowPort } from "../coordinator/main-card-workflow.js";
import { MainCardWorkflow } from "../coordinator/main-card-workflow.js";
import { reduceRunCard, type RunCardChange } from "../domain/run-card-view.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import type { LifecycleEventSubscriber } from "./bridge-event-bus.js";
import { CardUpdateScheduler, type CardUpdateSchedulerDiagnostics } from "./card-update-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import { LruMap } from "../runtime/lru-map.js";
import { KeyedSerialWorkQueue } from "../runtime/keyed-serial-work-queue.js";

const ANSWER_STREAM_INTERVAL_MS = 500;
const ANSWER_UPDATE_BUDGET_MS = 1_500;
const ANSWER_STREAM_MIN_DELTA_CHARS = 80;
const MAIN_CARD_UPDATE_INTERVAL_MS = 2_500;
const TOPIC_VIEW_CACHE_CAPACITY = 256;
const ANSWER_LENGTH_CACHE_CAPACITY = 512;

export class ConversationViewProjector {
  private readonly views = new LruMap<string, ReturnType<typeof initialTopicView>>(TOPIC_VIEW_CACHE_CAPACITY);
  private readonly bindingWork = new KeyedSerialWorkQueue<string>();
  private unsubscribe: (() => void) | null = null;
  private unsubscribeStreamCardCreated: (() => void) | null = null;
  private unsubscribeMainCardCheckpoint: (() => void) | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private readonly scheduler: CardUpdateScheduler;
  private readonly answerContentLengths = new LruMap<string, number>(ANSWER_LENGTH_CACHE_CAPACITY);
  private readonly answerPages: AnswerPageWorkflowPort;
  private readonly mainCards: MainCardWorkflowPort;
  private readonly answerUpdateDelayMs: number;
  private readonly mainUpdateDelayMs: number;

  constructor(
    private readonly bus: LifecycleEventSubscriber,
    private readonly store: ProjectionStore,
    private readonly channelPublisher: OutboundIntentPort,
    private readonly checkpoints: OutboundCheckpointSubscriber,
    private readonly logger: Logger,
    private readonly presentation: Pick<PrimaryPresentation, "mainCard" | "answerCard" | "finalAnswer" | "answerStreamContent" | "answerStreamPage" | "finalAnswerPage">,
    answerPages?: AnswerPageWorkflowPort,
    mainCards?: MainCardWorkflowPort,
    options: { cardUpdateDebounceMs?: number; mainCardUpdateDebounceMs?: number } = {}
  ) {
    this.answerPages = answerPages ?? new AnswerPageWorkflow(store as ProjectionStore & AnswerPageStore, () => { void checkpoints.requestScan(); }, presentation, logger);
    this.mainCards = mainCards ?? new MainCardWorkflow(store as ProjectionStore & MainCardStore, () => { void checkpoints.requestScan(); }, presentation, logger);
    this.answerUpdateDelayMs = Math.min(options.cardUpdateDebounceMs ?? ANSWER_STREAM_INTERVAL_MS, ANSWER_UPDATE_BUDGET_MS);
    this.mainUpdateDelayMs = options.mainCardUpdateDebounceMs ?? MAIN_CARD_UPDATE_INTERVAL_MS;
    this.scheduler = new CardUpdateScheduler(async (cardKey) => {
      const [family, id] = splitCardKey(cardKey);
      if (family === "main") {
        await this.mainCards.converge(id);
        return;
      }
      const promptId = id;
      const view = this.store.loadRunCard(promptId);
      if (!view?.answerCardId && view?.answerMessageId) {
        await this.channelPublisher.enqueueRunCardUpdate(view.bindingId, promptId, view.answerMessageId, view.viewVersion, "answer", this.presentation.answerCard(view));
        this.answerContentLengths.set(promptId, view.answer.length);
        return;
      }
      await this.answerPages.converge(promptId);
      if (view) this.answerContentLengths.set(promptId, view.answer.length);
    }, this.answerUpdateDelayMs, (error, cardKey, version) => {
      this.logger.error({ event: "card-update-failed", err: safeLogError(error), cardKey, viewVersion: version, outcome: "retry" }, "failed to converge card; retry scheduled");
    }, (result) => {
      this.logger.debug({ event: "card-convergence-flushed", ...result }, "card convergence flush completed");
    });
  }

  snapshot(): CardUpdateSchedulerDiagnostics { return this.scheduler.diagnostics(); }
  cacheDiagnostics(): { topicViews: number; answerLengths: number } {
    return { topicViews: this.views.size, answerLengths: this.answerContentLengths.size };
  }

  start(): () => void {
    this.unsubscribe = this.bus.onBridgeEvent("conversation-view-projector", (event) => this.enqueue(event));
    this.unsubscribeStreamCardCreated = this.checkpoints.onAnswerCheckpoint((promptId, viewVersion) => {
      this.scheduler.schedule(answerCardKey(promptId), viewVersion, { priority: "terminal" });
    });
    this.unsubscribeMainCardCheckpoint = this.checkpoints.onMainCardCheckpoint?.((bindingId, viewVersion) => {
      this.scheduler.schedule(mainCardKey(bindingId), viewVersion, { priority: "terminal" });
    }) ?? null;
    return () => { this.unsubscribe?.(); this.unsubscribeStreamCardCreated?.(); this.unsubscribeMainCardCheckpoint?.(); };
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeStreamCardCreated?.();
    this.unsubscribeStreamCardCreated = null;
    this.unsubscribeMainCardCheckpoint?.();
    this.unsubscribeMainCardCheckpoint = null;
    this.views.clear();
    this.answerContentLengths.clear();
    this.stopPromise = this.bindingWork.stop().then(() => this.scheduler.stop());
    return this.stopPromise;
  }

  private async onEvent(event: BridgeEvent): Promise<void> {
    if (this.stopping) return;
    const promptId = promptIdOf(event);
    const runCard = promptId ? this.store.loadRunCard(promptId) : null;
    if (promptId && runCard) {
      const change = runCardChange(event);
      if (change) {
        const next = reduceRunCard(runCard, change);
        if (next !== runCard) {
          this.store.saveRunCard(next);
          const terminal = ["blocked", "completed", "failed"].includes(next.phase);
          const contentLength = next.answer.length;
          const previousLength = this.answerContentLengths.get(promptId) ?? 0;
          const firstContent = previousLength === 0 && contentLength > 0;
          const progressChanged = event.type === "TurnOutputObserved" && normalizeTurnOutputObservation(event.payload).answer.toolActivities.length > 0;
          this.scheduler.schedule(answerCardKey(promptId), next.viewVersion, {
            priority: terminal || firstContent || progressChanged || contentLength - previousLength >= ANSWER_STREAM_MIN_DELTA_CHARS ? "terminal" : "normal",
            delayMs: this.answerUpdateDelayMs
          });
          if (terminal) this.answerContentLengths.delete(promptId);
        } else if (["blocked", "completed", "failed"].includes(runCard.phase) && runCard.viewVersion > runCard.answerDeliveredVersion) {
          // The durable workflow transition may have projected the terminal view
          // before this process-local lifecycle notification arrived.
          this.scheduler.schedule(answerCardKey(promptId), runCard.viewVersion, { priority: "terminal" });
        }
      }
    }
    const current = this.views.get(event.bindingId) ?? this.store.loadTopicView(event.bindingId) ?? initialTopicView(event.bindingId);
    const next = reduceTopicView(current, event);
    if (next === current) return;
    this.views.set(event.bindingId, next);
    this.store.saveTopicView(next);

    try {
      this.scheduler.schedule(mainCardKey(event.bindingId), next.viewVersion, {
        priority: isImmediateMainEvent(event, next.phase) ? "terminal" : isInteractiveMainEvent(event) ? "interactive" : "normal",
        delayMs: isInteractiveMainEvent(event) ? Math.min(1_000, this.mainUpdateDelayMs) : this.mainUpdateDelayMs
      });
      if (["done", "error", "archived", "orphaned"].includes(next.phase)) this.views.delete(event.bindingId);
    }
    catch (error) {
      this.logger.error({ event: "card-projection-failed", err: safeLogError(error), bindingId: event.bindingId, eventId: event.eventId, bridgeEventType: event.type, outcome: "failed" }, "failed to project Lark card");
      throw error;
    }
  }

  private enqueue(event: BridgeEvent): Promise<void> {
    return this.bindingWork.enqueue(event.bindingId, () => this.onEvent(event));
  }
}

function answerCardKey(promptId: string): string { return `answer:${promptId}`; }
function mainCardKey(bindingId: string): string { return `main:${bindingId}`; }
function splitCardKey(cardKey: string): ["answer" | "main", string] {
  const separator = cardKey.indexOf(":");
  const family = cardKey.slice(0, separator);
  const id = cardKey.slice(separator + 1);
  if ((family !== "answer" && family !== "main") || !id) throw new Error(`Invalid card update key: ${cardKey}`);
  return [family, id];
}

function isImmediateMainEvent(event: BridgeEvent, phase: ReturnType<typeof initialTopicView>["phase"]): boolean {
  return ["blocked", "done", "error", "degraded", "draining", "archived", "orphaned"].includes(phase)
    || event.type === "BindingCreated" || event.type === "BindingActivated";
}

function isInteractiveMainEvent(event: BridgeEvent): boolean {
  return event.type === "TurnStarted" || event.type === "AgentStateChanged" || event.type === "TurnOutputObserved" && normalizeTurnOutputObservation(event.payload).answer.toolActivities.length > 0;
}

function promptIdOf(event: BridgeEvent): string | null {
  if (event.type === "PromptQueued" || event.type === "PromptCancelled" || event.type === "SteeringQueued" || event.type === "RunQueuePositionChanged" || event.type === "TurnStarted" || event.type === "SteeringStarted" || event.type === "SteeringDelivered" || event.type === "SteeringFailed" || event.type === "TurnOutputObserved" || event.type === "TurnCompleted" || event.type === "TurnFailed") return event.payload.promptId;
  if (event.type === "AgentStateChanged") return event.payload.promptId ?? null;
  return null;
}

function runCardChange(event: BridgeEvent): RunCardChange | null {
  switch (event.type) {
    case "PromptQueued": return null;
    case "PromptCancelled": return { type: "failed", occurredAt: event.occurredAt, notice: event.payload.reason };
    case "SteeringQueued": return { type: "queue-position", occurredAt: event.occurredAt, queuePosition: 0 };
    case "RunQueuePositionChanged": return { type: "queue-position", occurredAt: event.occurredAt, queuePosition: event.payload.queuePosition };
    case "TurnStarted": return { type: "started", occurredAt: event.occurredAt };
    case "SteeringStarted": return { type: "started", occurredAt: event.occurredAt };
    case "SteeringDelivered": return { type: "steering-delivered", occurredAt: event.occurredAt, notice: event.payload.automatic ? "已自动加入当前执行" : "已加入当前执行" };
    case "SteeringFailed": return { type: "steering-failed", occurredAt: event.occurredAt, notice: event.payload.error, failureKind: event.payload.failureKind };
    case "TurnOutputObserved": {
      const answer = normalizeTurnOutputObservation(event.payload).answer;
      return { type: "output", occurredAt: event.occurredAt, answerSnapshot: answer.snapshot, ...(answer.previousSnapshot === undefined ? {} : { previousAnswerSnapshot: answer.previousSnapshot }), ...(answer.update === undefined ? {} : { answerUpdate: answer.update }), progressEvents: answer.toolActivities.map((item) => ({ ...item, occurredAt: event.occurredAt })), ...(answer.hasToolActivitySnapshot === undefined ? {} : { hasProgressSnapshot: answer.hasToolActivitySnapshot }) };
    }
    case "AgentStateChanged": return event.payload.state === "blocked"
      ? { type: "blocked", occurredAt: event.occurredAt, notice: "TraeX 需要人工审批。请回到对应 Herdr pane 完成审批。" }
      : event.payload.state === "working" ? { type: "started", occurredAt: event.occurredAt } : null;
    case "TurnCompleted": return { type: "completed", occurredAt: event.occurredAt, answer: event.payload.answer };
    case "TurnFailed": return { type: "failed", occurredAt: event.occurredAt, notice: event.payload.error };
    default: return null;
  }
}
