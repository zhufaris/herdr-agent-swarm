import type { Logger } from "pino";
import { renderProjectEntryCard, renderRequestRunCard } from "../cards/run-card.js";
import type { BridgeEvent } from "../domain/events.js";
import type { BindingStorePort } from "../domain/ports.js";
import { reduceRunCard, type RunCardChange } from "../domain/run-card-view.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import type { BridgeEventBus } from "./bridge-event-bus.js";
import type { LarkChannelPublisher } from "./lark-channel-publisher.js";
import { CardUpdateScheduler } from "./card-update-scheduler.js";

export class CardProjector {
  private readonly views = new Map<string, ReturnType<typeof initialTopicView>>();
  private readonly activeHandlers = new Set<Promise<void>>();
  private unsubscribe: (() => void) | null = null;
  private stopping = false;
  private stopPromise: Promise<void> | null = null;
  private readonly scheduler: CardUpdateScheduler;

  constructor(
    private readonly bus: BridgeEventBus,
    private readonly store: BindingStorePort,
    private readonly channelPublisher: LarkChannelPublisher,
    private readonly logger: Logger
  ) {
    this.scheduler = new CardUpdateScheduler(async (promptId) => {
      const view = this.store.loadRunCard(promptId);
      if (!view?.larkMessageId) return;
      await this.channelPublisher.enqueueRunCardUpdate(view.bindingId, promptId, view.larkMessageId, view.viewVersion, renderRequestRunCard(view));
    });
  }

  start(): () => void {
    this.unsubscribe = this.bus.onBridgeEvent((event) => this.trackHandler(this.onEvent(event)));
    return () => this.unsubscribe?.();
  }

  stop(): Promise<void> {
    if (this.stopPromise) return this.stopPromise;
    this.stopping = true;
    this.unsubscribe?.();
    this.unsubscribe = null;
    this.scheduler.stop();
    this.stopPromise = Promise.allSettled([...this.activeHandlers]).then(() => undefined);
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
        }
      }
    }
    const current = this.views.get(event.bindingId) ?? this.store.loadTopicView(event.bindingId) ?? initialTopicView(event.bindingId);
    const next = reduceTopicView(current, event);
    if (next === current) return;
    this.views.set(event.bindingId, next);
    this.store.saveTopicView(next);

    const binding = this.store.listBindings().find((candidate) => candidate.id === event.bindingId);
    if (!binding?.rootMessageId) return;
    const card = renderProjectEntryCard(next);
    try {
      if (binding.statusMessageId) {
        await this.channelPublisher.enqueueCardUpdate(binding.id, binding.statusMessageId, event.eventId, card);
      } else {
        await this.channelPublisher.enqueueCard(binding.rootMessageId, `status-card:${binding.id}`, card, binding.id);
      }
    } catch (error) {
      this.logger.error({ event: "card-projection-failed", err: error, bindingId: event.bindingId, eventId: event.eventId, bridgeEventType: event.type, outcome: "failed" }, "failed to project Lark card");
    }
  }

  private trackHandler(work: Promise<void>): Promise<void> {
    this.activeHandlers.add(work);
    void work.then(
      () => this.activeHandlers.delete(work),
      () => this.activeHandlers.delete(work)
    );
    return work;
  }
}

function promptIdOf(event: BridgeEvent): string | null {
  if (event.type === "PromptQueued" || event.type === "SteeringQueued" || event.type === "RunQueuePositionChanged" || event.type === "TurnStarted" || event.type === "SteeringStarted" || event.type === "SteeringDelivered" || event.type === "SteeringFailed" || event.type === "TurnOutputObserved" || event.type === "TurnCompleted" || event.type === "TurnFailed") return event.payload.promptId;
  if (event.type === "AgentStateChanged") return event.payload.promptId ?? null;
  return null;
}

function runCardChange(event: BridgeEvent): RunCardChange | null {
  switch (event.type) {
    case "PromptQueued": return { type: "queue-position", occurredAt: event.occurredAt, queuePosition: event.payload.queueDepth };
    case "SteeringQueued": return { type: "queue-position", occurredAt: event.occurredAt, queuePosition: 0 };
    case "RunQueuePositionChanged": return { type: "queue-position", occurredAt: event.occurredAt, queuePosition: event.payload.queuePosition };
    case "TurnStarted": return { type: "started", occurredAt: event.occurredAt };
    case "SteeringStarted": return { type: "started", occurredAt: event.occurredAt };
    case "SteeringDelivered": return { type: "steering-delivered", occurredAt: event.occurredAt, notice: "已加入当前执行" };
    case "SteeringFailed": return { type: "failed", occurredAt: event.occurredAt, notice: event.payload.error };
    case "TurnOutputObserved": return { type: "output", occurredAt: event.occurredAt, answerDelta: event.payload.answerDelta, progressEvents: event.payload.progressEvents.map((item) => ({ ...item, occurredAt: event.occurredAt })) };
    case "AgentStateChanged": return event.payload.state === "blocked"
      ? { type: "blocked", occurredAt: event.occurredAt, notice: "TraeX 需要人工审批。请回到对应 Herdr pane 完成审批。" }
      : event.payload.state === "working" ? { type: "started", occurredAt: event.occurredAt } : null;
    case "TurnCompleted": return { type: "completed", occurredAt: event.occurredAt, answer: event.payload.answer };
    case "TurnFailed": return { type: "failed", occurredAt: event.occurredAt, notice: event.payload.error };
    default: return null;
  }
}
