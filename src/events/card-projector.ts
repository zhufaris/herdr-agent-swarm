import type { Logger } from "pino";
import { renderRunCard } from "../cards/run-card.js";
import type { BridgeEvent } from "../domain/events.js";
import type { BindingStorePort, LarkPort } from "../domain/ports.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import type { BridgeEventBus } from "./bridge-event-bus.js";

export class CardProjector {
  private readonly views = new Map<string, ReturnType<typeof initialTopicView>>();

  constructor(
    private readonly bus: BridgeEventBus,
    private readonly store: BindingStorePort,
    private readonly lark: LarkPort,
    private readonly logger: Logger
  ) {}

  start(): () => void {
    return this.bus.onBridgeEvent((event) => this.onEvent(event));
  }

  private async onEvent(event: BridgeEvent): Promise<void> {
    const current = this.views.get(event.bindingId) ?? this.store.loadTopicView(event.bindingId) ?? initialTopicView(event.bindingId);
    const next = reduceTopicView(current, event);
    this.views.set(event.bindingId, next);
    this.store.saveTopicView(next);

    const binding = this.store.listBindings().find((candidate) => candidate.id === event.bindingId);
    if (!binding?.rootMessageId) return;
    const card = renderRunCard(next);
    try {
      if (binding.statusMessageId) {
        await this.lark.updateCard(binding.statusMessageId, card);
      } else {
        const sent = await this.lark.replyCard(binding.rootMessageId, card);
        this.store.recordBridgeMessage(sent.messageId);
        this.store.updateBinding(binding.id, { statusMessageId: sent.messageId });
      }
    } catch (error) {
      this.logger.error({ err: error, bindingId: event.bindingId, eventId: event.eventId }, "failed to project Lark card");
      throw error;
    }
  }
}
