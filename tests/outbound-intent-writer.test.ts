import { describe, expect, it, vi } from "vitest";
import { OutboundIntentWriter } from "../src/events/outbound-intent-writer.js";
import { InProcessOutboundWorkNotifier } from "../src/events/outbound-work-notifier.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("OutboundIntentWriter", () => {
  it("returns after durable enqueue without waiting for a delivery listener", async () => {
    const store = new SqliteBindingStore(":memory:");
    const notifier = new InProcessOutboundWorkNotifier();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const listener = vi.fn(async () => blocked);
    notifier.subscribe(listener);
    const writer = new OutboundIntentWriter(store, notifier);

    await expect(writer.enqueueCard("root-1", "card-1", { schema: "2.0" })).resolves.toBeUndefined();

    expect(store.listPendingOutboundReplies()).toMatchObject([{ idempotencyKey: "card-1", state: "pending" }]);
    await new Promise((resolve) => queueMicrotask(resolve));
    expect(listener).toHaveBeenCalledTimes(1);
    release();
    store.close();
  });

  it("persists before publishing its best-effort wake-up", async () => {
    const store = new SqliteBindingStore(":memory:");
    const notifier = new InProcessOutboundWorkNotifier();
    const observedCounts: number[] = [];
    notifier.subscribe(() => { observedCounts.push(store.listPendingOutboundReplies().length); });
    const writer = new OutboundIntentWriter(store, notifier);

    await writer.enqueueCardUpdate(null, "message-1", "event-1", { schema: "2.0" });
    await new Promise((resolve) => queueMicrotask(resolve));

    expect(observedCounts).toEqual([1]);
    store.close();
  });
});
