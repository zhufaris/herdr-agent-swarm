import { describe, expect, it, vi } from "vitest";
import { InProcessInboundWorkNotifier } from "../src/events/inbound-work-notifier.js";

describe("InProcessInboundWorkNotifier", () => {
  it("notifies inbound listeners independently of lifecycle events", async () => {
    const notifier = new InProcessInboundWorkNotifier();
    const listener = vi.fn();
    const unsubscribe = notifier.subscribe(listener);
    const event = {
      eventId: "e1", type: "InboundMessageReceived" as const, origin: "lark" as const, occurredAt: "2026-08-24T00:00:00Z",
      payload: { eventId: "e1", messageId: "m1", chatId: "c1", topicId: null, rootMessageId: "m1", actorOpenId: "u1", text: "hello", mentionsBot: true, isRootMessage: true }
    };

    await notifier.notify(event);
    unsubscribe();
    await notifier.notify({ ...event, eventId: "e2" });

    expect(listener).toHaveBeenCalledOnce();
    expect(listener).toHaveBeenCalledWith(event);
  });
});
