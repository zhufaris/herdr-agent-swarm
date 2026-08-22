import { describe, expect, it } from "vitest";
import type { BridgeEvent } from "../src/domain/events.js";
import { initialTopicView, reduceTopicView } from "../src/domain/topic-view.js";

function event<T extends BridgeEvent["type"]>(type: T, payload: Extract<BridgeEvent, { type: T }>["payload"]): Extract<BridgeEvent, { type: T }> {
  return { eventId: type, bindingId: "b1", type, origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload } as Extract<BridgeEvent, { type: T }>;
}

describe("topic view reducer", () => {
  it("projects lifecycle and turn events deterministically", () => {
    const events: BridgeEvent[] = [
      event("BindingCreated", { title: "Fix tests", workspaceId: "w1", paneId: null }),
      event("BindingActivated", { paneId: "w1:p2", topicId: "t1" }),
      event("PromptQueued", { promptId: "p1", queueDepth: 1, actorOpenId: "u1" }),
      event("TurnStarted", { promptId: "p1", queueDepth: 1 }),
      event("TurnCompleted", { promptId: "p1", answer: "Done", queueDepth: 0 })
    ];
    const reduceAll = () => events.reduce(reduceTopicView, initialTopicView("b1"));
    expect(reduceAll()).toEqual(reduceAll());
    expect(reduceAll()).toMatchObject({ title: "Fix tests", paneId: "w1:p2", phase: "done", answer: "Done", queueDepth: 0 });
  });

  it("projects blocked and orphaned states", () => {
    const blocked = reduceTopicView(initialTopicView("b1"), event("AgentStateChanged", { state: "blocked", queueDepth: 1 }));
    expect(blocked.phase).toBe("blocked");
    const orphaned = reduceTopicView(blocked, event("BindingOrphaned", { reason: "pane missing" }));
    expect(orphaned).toMatchObject({ phase: "orphaned", notice: "pane missing" });
  });
});
