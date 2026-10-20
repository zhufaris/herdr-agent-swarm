import { describe, expect, it, vi } from "vitest";
import type { PreparedDelivery, OutboundReply } from "../src/domain/delivery.js";
import type { OutboundIntentStore, PreparedDeliveryReservationInput } from "../src/domain/ports/outbox.js";
import { OutboundIntentWriter } from "../src/events/outbound-intent-writer.js";
import { InProcessOutboundWorkNotifier } from "../src/events/outbound-work-notifier.js";

describe("OutboundIntentWriter", () => {
  it("returns after durable reservation without waiting for a delivery listener", async () => {
    const target = fixture();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const listener = vi.fn(async () => blocked);
    target.notifier.subscribe(listener);
    const writer = new OutboundIntentWriter(target.store, target.notifier, target.consumer);

    const enqueue = writer.enqueueCard("root-1", "card-1", { schema: "2.0" });

    expect(target.reservePreparedOutboundReply).toHaveBeenCalledOnce();
    expect(target.enqueuePreparedDelivery).not.toHaveBeenCalled();
    await expect(enqueue).resolves.toBeUndefined();
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(target.enqueuePreparedDelivery).toHaveBeenCalledWith(target.prepared);
    expect(listener).not.toHaveBeenCalled();
    release();
  });

  it("hands exact post-commit work to the Ring without publishing a global recovery wake", async () => {
    const events: string[] = [];
    const target = fixture(events);
    const wake = vi.fn(() => { events.push("wake"); });
    const writer = new OutboundIntentWriter(target.store, { subscribe: () => () => {}, wake }, target.consumer);

    const enqueue = writer.enqueueCardUpdate(null, "message-1", "event-1", { schema: "2.0" });

    expect(target.reservePreparedOutboundReply).toHaveBeenCalledWith(expect.objectContaining({
      bindingId: null,
      globalDelivery: true,
      idempotencyKey: "card-update:message-1:event-1"
    }));
    expect(wake).not.toHaveBeenCalled();

    await enqueue;
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(events).toEqual(["reserve", "consume", "handoff"]);
    expect(target.enqueuePreparedDelivery).toHaveBeenCalledWith(target.prepared);
  });

  it("delegates exact-message deletion idempotency and marks unowned work as global", async () => {
    const target = fixture();
    const wake = vi.spyOn(target.notifier, "wake");
    const writer = new OutboundIntentWriter(target.store, target.notifier, target.consumer);

    await writer.enqueueMessageDelete(null, "answer-message-1", "clear:operation-1:answer-message-1");
    await writer.enqueueMessageDelete(null, "answer-message-1", "clear:operation-1:answer-message-1");

    expect(target.reservePreparedOutboundReply).toHaveBeenCalledTimes(2);
    expect(target.reservePreparedOutboundReply).toHaveBeenNthCalledWith(1, expect.objectContaining({
      bindingId: null,
      globalDelivery: true,
      idempotencyKey: "clear:operation-1:answer-message-1",
      kind: "message_delete",
      rootMessageId: "answer-message-1",
      payload: ""
    }));
    expect(target.reservePreparedOutboundReply).toHaveBeenNthCalledWith(2, expect.objectContaining({
      globalDelivery: true,
      idempotencyKey: "clear:operation-1:answer-message-1"
    }));
    expect(wake).not.toHaveBeenCalled();
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(target.enqueuePreparedDelivery).toHaveBeenCalledTimes(2);
  });

  it("does not escalate a terminal or duplicate reservation without an effect to global recovery", async () => {
    const target = fixture();
    target.reservePreparedOutboundReply.mockImplementationOnce((input) => ({
      commitState: "committed" as const,
      result: { id: input.id, idempotencyKey: input.idempotencyKey } as OutboundReply,
      consumeEffects: vi.fn(() => [])
    }));
    const wake = vi.spyOn(target.notifier, "wake");
    const writer = new OutboundIntentWriter(target.store, target.notifier, target.consumer);

    await writer.enqueueCard("root-1", "terminal-replay", { schema: "2.0" });
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(target.enqueuePreparedDelivery).not.toHaveBeenCalled();
    expect(wake).not.toHaveBeenCalled();
  });
});

function fixture(events: string[] = []) {
  const prepared = { replyId: "reply-1", scope: { kind: "global" } } as PreparedDelivery;
  const consumeEffects = vi.fn(() => {
    events.push("consume");
    return [prepared];
  });
  const reservePreparedOutboundReply = vi.fn((input: PreparedDeliveryReservationInput) => {
    events.push("reserve");
    return {
      commitState: "committed" as const,
      result: { id: input.id, idempotencyKey: input.idempotencyKey } as OutboundReply,
      consumeEffects
    };
  });
  const store: OutboundIntentStore = {
    reservePreparedOutboundReply,
    getActiveAnswerPage: () => null,
    getBinding: () => null,
    loadRunCard: () => null
  };
  const notifier = new InProcessOutboundWorkNotifier();
  const enqueuePreparedDelivery = vi.fn((delivery: PreparedDelivery) => {
    events.push("handoff");
    expect(delivery).toBe(prepared);
  });
  return {
    store,
    notifier,
    consumer: { enqueuePreparedDelivery },
    reservePreparedOutboundReply,
    enqueuePreparedDelivery,
    prepared
  };
}
