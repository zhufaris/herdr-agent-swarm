import { afterEach, describe, expect, it } from "vitest";
import { initialTopicView } from "../src/domain/topic-view.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

let store: SqliteBindingStore | undefined;
afterEach(() => store?.close());

describe("SQLite store", () => {
  it("persists bindings, FIFO jobs, deduplication, and view snapshots", () => {
    store = new SqliteBindingStore(":memory:");
    const binding = store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding(binding.id, { paneId: "w1:p2", state: "active" });
    expect(store.findBindingByLarkScope("unknown-thread", "m1")?.id).toBe("b1");
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "first" });
    store.enqueuePrompt({ id: "p2", bindingId: "b1", larkMessageId: "m3", actorOpenId: "u1", body: "second" });
    expect(store.claimNextPrompt("b1")?.id).toBe("p1");
    expect(store.recoverRunningPrompts()).toBe(1);
    expect(store.claimNextPrompt("b1")?.id).toBe("p1");
    store.recordProcessedEvent("e1", "m2");
    expect(store.hasProcessedEvent("e1")).toBe(true);
    const view = { ...initialTopicView("b1"), title: "Task" };
    store.saveTopicView(view);
    expect(store.loadTopicView("b1")).toEqual(view);
  });
});
