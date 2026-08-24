import type { Logger } from "pino";
import { renderProjectEntryCard, renderRequestAnswerCard } from "../cards/run-card.js";
import type { BridgeEvent } from "../domain/events.js";
import type { OutboundIntentPort, ProjectionStore } from "../domain/ports.js";
import { reduceRunCard, type RunCardChange } from "../domain/run-card-view.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import type { BridgeEventBus } from "./bridge-event-bus.js";
import { CardUpdateScheduler } from "./card-update-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import { ANSWER_STREAM_PAGE_LIMIT, renderAnswerStreamPage } from "../runtime/answer-stream.js";
import { answerElementId } from "../domain/run-card-view.js";

export class ConversationViewProjector {
  private readonly views = new Map<string, ReturnType<typeof initialTopicView>>();
  private readonly bindingTails = new Map<string, Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private unsubscribeStreamCardCreated: (() => void) | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private readonly scheduler: CardUpdateScheduler;

  constructor(
    private readonly bus: BridgeEventBus,
    private readonly store: ProjectionStore,
    private readonly channelPublisher: OutboundIntentPort,
    private readonly logger: Logger
  ) {
    this.scheduler = new CardUpdateScheduler(async (promptId) => {
      let view = this.store.loadRunCard(promptId);
      if (!view?.answerMessageId) return;
      if (view.answerCardId) {
        const fullContent = answerContent(view);
        while (view.answerCardId) {
          const { page, nextPageStart } = renderAnswerStreamPage(fullContent, view.answerPageStart, ANSWER_STREAM_PAGE_LIMIT);
          const sequence = Math.max(view.answerSequence + 1, view.viewVersion);
          this.store.saveRunCard({ ...view, answerSequence: sequence });
          await this.channelPublisher.enqueueStreamContent(view.bindingId, promptId, view.answerCardId, view.answerElementId, page, sequence);
          if (nextPageStart === null) {
            if (["completed", "failed"].includes(view.phase)) await this.channelPublisher.enqueueStreamFinish(view.bindingId, promptId, view.answerCardId, view.phase === "completed" ? "Completed" : "Failed", sequence + 1);
            break;
          }

          await this.channelPublisher.enqueueStreamFinish(view.bindingId, promptId, view.answerCardId, `Continued on part ${view.answerPageIndex + 2}`, sequence + 1);
          const pageStart = nextPageStart;
          const pageIndex = view.answerPageIndex + 1;
          const nextElementId = answerElementId(promptId, pageIndex);
          const nextPage = renderAnswerStreamPage(fullContent, pageStart, ANSWER_STREAM_PAGE_LIMIT).page;
          const nextView = { ...view, answerElementId: nextElementId };
          const binding = this.store.getBinding(view.bindingId);
          if (!binding?.rootMessageId) return;
          await this.channelPublisher.enqueueStreamCardCreate({
            bindingId: view.bindingId, promptId, rootMessageId: binding.rootMessageId, pageIndex, pageStart, elementId: nextElementId, viewVersion: view.viewVersion,
            card: renderRequestAnswerCard(nextView, { pageNumber: pageIndex + 1, initialContent: nextPage })
          });
          view = this.store.loadRunCard(promptId);
          if (!view?.answerCardId || view.answerPageIndex !== pageIndex) return;
        }
        return;
      }
      if (view.larkMessageId) await this.channelPublisher.enqueueRunCardUpdate(view.bindingId, promptId, view.answerMessageId, view.viewVersion, "answer", renderRequestAnswerCard(view));
    });
  }

  start(): () => void {
    this.unsubscribe = this.bus.onBridgeEvent((event) => this.enqueue(event));
    this.unsubscribeStreamCardCreated = this.channelPublisher.onStreamCardCreated((promptId, viewVersion) => {
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
          this.scheduler.schedule(promptId, next.viewVersion, ["blocked", "completed", "failed"].includes(next.phase));
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

    const binding = this.store.getBinding(event.bindingId);
    if (!binding?.rootMessageId) return;
    const card = renderProjectEntryCard(next);
    try {
      if (binding.statusMessageId) {
        await this.channelPublisher.enqueueCardUpdate(binding.id, binding.statusMessageId, event.eventId, card);
      } else {
        await this.channelPublisher.enqueueCard(binding.rootMessageId, `status-card:${binding.id}`, card, binding.id);
      }
    } catch (error) {
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

function answerContent(view: NonNullable<ReturnType<ProjectionStore["loadRunCard"]>>): string {
  const base = ["⏳ 已接收请求", view.answer].filter(Boolean).join("\n\n");
  return view.phase === "blocked" ? `${base}\n\n⚠️ ${view.notice ?? "等待用户处理"}`
    : view.phase === "failed" ? `${base}\n\n❌ ${view.notice ?? "执行失败"}` : base;
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
