import type { Logger } from "pino";
import { renderProjectEntryCard, renderRequestAnswerCard } from "../cards/run-card.js";
import type { BridgeEvent } from "../domain/events.js";
import type { OutboundCheckpointSubscriber, OutboundIntentPort, ProjectionStore } from "../domain/ports.js";
import { reduceRunCard, type RunCardChange } from "../domain/run-card-view.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import type { LifecycleEventSubscriber } from "./bridge-event-bus.js";
import { CardUpdateScheduler } from "./card-update-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import { ANSWER_STREAM_PAGE_LIMIT, answerStreamContent, renderAnswerStreamPage } from "../runtime/answer-stream.js";
import { answerElementId } from "../domain/run-card-view.js";

const ANSWER_STREAM_INTERVAL_MS = 1_500;
const ANSWER_STREAM_MIN_DELTA_CHARS = 400;
const PRIMARY_CARD_INTERVAL_MS = 3_000;

export class ConversationViewProjector {
  private readonly views = new Map<string, ReturnType<typeof initialTopicView>>();
  private readonly bindingTails = new Map<string, Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private unsubscribeStreamCardCreated: (() => void) | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private readonly scheduler: CardUpdateScheduler;
  private readonly primaryScheduler: CardUpdateScheduler;
  private readonly answerContentLengths = new Map<string, number>();
  private readonly primaryVersions = new Map<string, number>();

  constructor(
    private readonly bus: LifecycleEventSubscriber,
    private readonly store: ProjectionStore,
    private readonly channelPublisher: OutboundIntentPort,
    private readonly checkpoints: OutboundCheckpointSubscriber,
    private readonly logger: Logger
  ) {
    this.scheduler = new CardUpdateScheduler(async (promptId) => {
      let view = this.store.loadRunCard(promptId);
      if (!view?.answerMessageId) return;
      if (view.answerCardId) {
        // A continuation is a durable hand-off. Until Lark has created that
        // card and checkpointed the new page, do not enqueue more writes for
        // the old card: those writes would be stale as soon as the checkpoint
        // advances and could block the prompt's ordered outbox lane.
        if (this.store.hasPendingAnswerContinuation(promptId, view.answerPageIndex + 1)) return;
        const fullContent = answerStreamContent(view);
        while (view.answerCardId) {
          const { page, nextPageStart } = renderAnswerStreamPage(fullContent, view.answerPageStart, ANSWER_STREAM_PAGE_LIMIT);
          // CardKit sequences are scoped to one streamed element. A continuation
          // gets a new element and its durable answerSequence is reset to zero
          // when its card creation is checkpointed. Do not carry viewVersion
          // across that boundary.
          const sequence = view.answerSequence + 1;
          this.store.saveRunCard({ ...view, answerSequence: sequence });
          await this.channelPublisher.enqueueStreamContent(view.bindingId, promptId, view.answerCardId, view.answerElementId, page, sequence);
          this.answerContentLengths.set(promptId, fullContent.length);
          if (nextPageStart === null) {
            if (["completed", "failed"].includes(view.phase)) await this.channelPublisher.enqueueStreamFinish(
              view.bindingId, promptId, view.answerCardId, view.phase === "completed" ? "Completed" : "Failed", sequence + 1
            );
            break;
          }

          await this.channelPublisher.enqueueStreamFinish(view.bindingId, promptId, view.answerCardId, `回答将在第 ${view.answerPageIndex + 2} 页继续`, sequence + 1);
          const pageStart = nextPageStart;
          const pageIndex = view.answerPageIndex + 1;
          const nextElementId = answerElementId(promptId, pageIndex);
          const nextPage = renderAnswerStreamPage(fullContent, pageStart, ANSWER_STREAM_PAGE_LIMIT).page;
          const nextView = { ...view, answerElementId: nextElementId };
          const binding = this.store.getBinding(view.bindingId);
          if (!binding?.rootMessageId) return;
          await this.channelPublisher.enqueueStreamCardCreate({
            bindingId: view.bindingId, promptId, rootMessageId: binding.rootMessageId, pageIndex, pageStart, elementId: nextElementId, viewVersion: view.viewVersion,
            card: renderRequestAnswerCard(nextView, { pageNumber: pageIndex + 1, initialContent: nextPage, streaming: true })
          });
          view = this.store.loadRunCard(promptId);
          if (!view?.answerCardId || view.answerPageIndex !== pageIndex) return;
        }
        return;
      }
      if (view.larkMessageId) await this.channelPublisher.enqueueRunCardUpdate(view.bindingId, promptId, view.answerMessageId, view.viewVersion, "answer", renderRequestAnswerCard(view));
    }, ANSWER_STREAM_INTERVAL_MS);
    this.primaryScheduler = new CardUpdateScheduler(async (bindingId) => {
      const view = this.views.get(bindingId) ?? this.store.loadTopicView(bindingId);
      const binding = this.store.getBinding(bindingId);
      if (!view || !binding?.rootMessageId) return;
      const card = renderProjectEntryCard(view);
      if (binding.statusMessageId) await this.channelPublisher.enqueueCardUpdate(binding.id, binding.statusMessageId, view.lastEventId ?? `primary:${binding.id}`, card);
      else await this.channelPublisher.enqueueCard(binding.rootMessageId, `status-card:${binding.id}`, card, binding.id, "session_status");
    }, PRIMARY_CARD_INTERVAL_MS);
  }

  start(): () => void {
    this.unsubscribe = this.bus.onBridgeEvent("conversation-view-projector", (event) => this.enqueue(event));
    this.unsubscribeStreamCardCreated = this.checkpoints.onStreamCardCreated((promptId, viewVersion) => {
      const view = this.store.loadRunCard(promptId);
      this.scheduler.schedule(promptId, Math.max(viewVersion, view?.viewVersion ?? 0), true);
    });
    return () => { this.unsubscribe?.(); this.unsubscribeStreamCardCreated?.(); };
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.unsubscribeStreamCardCreated?.();
    this.unsubscribeStreamCardCreated = null;
    this.scheduler.stop();
    this.primaryScheduler.stop();
    this.answerContentLengths.clear();
    this.primaryVersions.clear();
    this.stopPromise = Promise.allSettled([...this.bindingTails.values()]).then(() => undefined);
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
          const contentLength = answerStreamContent(next).length;
          const previousLength = this.answerContentLengths.get(promptId) ?? 0;
          this.scheduler.schedule(promptId, next.viewVersion, terminal || contentLength - previousLength >= ANSWER_STREAM_MIN_DELTA_CHARS);
          if (terminal) this.answerContentLengths.delete(promptId);
        } else if (["blocked", "completed", "failed"].includes(runCard.phase) && runCard.viewVersion > runCard.answerDeliveredVersion) {
          // The durable workflow transition may have projected the terminal view
          // before this process-local lifecycle notification arrived.
          this.scheduler.schedule(promptId, runCard.viewVersion, true);
        }
      }
    }
    const current = this.views.get(event.bindingId) ?? this.store.loadTopicView(event.bindingId) ?? initialTopicView(event.bindingId);
    const next = reduceTopicView(current, event);
    if (next === current) return;
    this.store.saveTopicView(next);
    this.views.set(event.bindingId, next);

    try {
      const version = (this.primaryVersions.get(event.bindingId) ?? 0) + 1;
      this.primaryVersions.set(event.bindingId, version);
      this.primaryScheduler.schedule(event.bindingId, version, primaryDeliveryImmediate(event, next));
    }
    catch (error) {
      this.logger.error({ event: "card-projection-failed", err: safeLogError(error), bindingId: event.bindingId, eventId: event.eventId, bridgeEventType: event.type, outcome: "failed" }, "failed to project Lark card");
    }
  }

  private enqueue(event: BridgeEvent): Promise<void> {
    const previous = this.bindingTails.get(event.bindingId) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(() => this.onEvent(event));
    const tail = work.catch(() => undefined);
    this.bindingTails.set(event.bindingId, tail);
    void tail.then(() => {
      if (this.bindingTails.get(event.bindingId) === tail) this.bindingTails.delete(event.bindingId);
    });
    return work;
  }
}

function primaryDeliveryImmediate(event: BridgeEvent, view: ReturnType<typeof initialTopicView>): boolean {
  if (event.type !== "TurnOutputObserved" && event.type !== "PaneOutputObserved") return true;
  return view.phase === "done" || view.phase === "blocked" || view.phase === "error";
}

function promptIdOf(event: BridgeEvent): string | null {
  if (event.type === "PromptQueued" || event.type === "PromptCancelled" || event.type === "SteeringQueued" || event.type === "RunQueuePositionChanged" || event.type === "TurnStarted" || event.type === "SteeringStarted" || event.type === "SteeringDelivered" || event.type === "SteeringFailed" || event.type === "TurnOutputObserved" || event.type === "TurnCompleted" || event.type === "TurnFailed") return event.payload.promptId;
  if (event.type === "AgentStateChanged") return event.payload.promptId ?? null;
  return null;
}

function runCardChange(event: BridgeEvent): RunCardChange | null {
  switch (event.type) {
    case "PromptQueued": return { type: "queue-position", occurredAt: event.occurredAt, queuePosition: event.payload.queueDepth };
    case "PromptCancelled": return { type: "failed", occurredAt: event.occurredAt, notice: event.payload.reason };
    case "SteeringQueued": return { type: "queue-position", occurredAt: event.occurredAt, queuePosition: 0 };
    case "RunQueuePositionChanged": return { type: "queue-position", occurredAt: event.occurredAt, queuePosition: event.payload.queuePosition };
    case "TurnStarted": return { type: "started", occurredAt: event.occurredAt };
    case "SteeringStarted": return { type: "started", occurredAt: event.occurredAt };
    case "SteeringDelivered": return { type: "steering-delivered", occurredAt: event.occurredAt, notice: "已加入当前执行" };
    case "SteeringFailed": return { type: "failed", occurredAt: event.occurredAt, notice: event.payload.error };
    case "TurnOutputObserved": return { type: "output", occurredAt: event.occurredAt, answerSnapshot: event.payload.answerSnapshot, ...(event.payload.previousAnswerSnapshot === undefined ? {} : { previousAnswerSnapshot: event.payload.previousAnswerSnapshot }), ...(event.payload.answerUpdate === undefined ? {} : { answerUpdate: event.payload.answerUpdate }), progressEvents: event.payload.progressEvents.map((item) => ({ ...item, occurredAt: event.occurredAt })), ...(event.payload.hasProgressSnapshot === undefined ? {} : { hasProgressSnapshot: event.payload.hasProgressSnapshot }) };
    case "AgentStateChanged": return event.payload.state === "blocked"
      ? { type: "blocked", occurredAt: event.occurredAt, notice: "TraeX 需要人工审批。请回到对应 Herdr pane 完成审批。" }
      : event.payload.state === "working" ? { type: "started", occurredAt: event.occurredAt } : null;
    case "TurnCompleted": return { type: "completed", occurredAt: event.occurredAt, answer: event.payload.answer };
    case "TurnFailed": return { type: "failed", occurredAt: event.occurredAt, notice: event.payload.error };
    default: return null;
  }
}
