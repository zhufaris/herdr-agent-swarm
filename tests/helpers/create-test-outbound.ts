import type { Logger } from "pino";
import type { LarkPort, OutboundCheckpointSubscriber, OutboundIntentPort, OutboxDispatcherControl } from "../../src/domain/ports.js";
import { OutboundIntentWriter } from "../../src/events/outbound-intent-writer.js";
import { LarkOutboxDispatcher } from "../../src/events/lark-outbox-dispatcher.js";
import { InProcessOutboundWorkNotifier } from "../../src/events/outbound-work-notifier.js";
import type { SqliteBindingStore } from "./sqlite-binding-store.js";
import { createFeishuCompatibilityDelivery } from "../../src/gateways/feishu/plugin.js";

export function createTestOutbound(store: SqliteBindingStore, dispatcher: LarkOutboxDispatcher): OutboundIntentWriter {
  return new OutboundIntentWriter(store, {
    subscribe: () => () => {},
    wake: () => { void dispatcher.requestScan(); }
  });
}

export type TestOutbound = LarkOutboxDispatcher & OutboundIntentPort & OutboundCheckpointSubscriber & OutboxDispatcherControl & { drain(force?: boolean): Promise<void> };

/** Combined test facade for legacy integration fixtures; production composition keeps writer and worker separate. */
export function createTestPublisher(store: SqliteBindingStore, lark: LarkPort, logger: Logger): TestOutbound {
  let dispatcher!: LarkOutboxDispatcher;
  let richTextSequence = 0;
  const transport: LarkPort = {
    ...lark,
    replyStreamingCard: lark.replyStreamingCard ?? (async (rootMessageId, card) => {
      const receipt = await lark.replyCard(rootMessageId, card);
      return { ...receipt, cardId: `cardkit-${receipt.messageId}` };
    }),
    replyRichText: lark.replyRichText ?? (async () => ({ messageId: `rich-text-${++richTextSequence}` })),
    updateRichText: lark.updateRichText ?? (async (messageId, content) => lark.updateCard(messageId, content))
  };
  const processWork = new InProcessOutboundWorkNotifier(logger);
  const work = {
    subscribe: processWork.subscribe.bind(processWork),
    wake: () => { processWork.wake(); void dispatcher.requestScan(); }
  };
  dispatcher = new LarkOutboxDispatcher(store, createFeishuCompatibilityDelivery(transport), logger, work);
  const writer = new OutboundIntentWriter(store, work);
  return Object.assign(dispatcher, {
    enqueueCard: writer.enqueueCard.bind(writer),
    enqueueCardUpdate: writer.enqueueCardUpdate.bind(writer),
    enqueueRunCardUpdate: writer.enqueueRunCardUpdate.bind(writer),
    enqueueStreamContent: writer.enqueueStreamContent.bind(writer),
    enqueueStreamCardCreate: writer.enqueueStreamCardCreate.bind(writer),
    enqueueStreamFinish: writer.enqueueStreamFinish.bind(writer),
    drain: dispatcher.requestScan.bind(dispatcher)
  });
}
