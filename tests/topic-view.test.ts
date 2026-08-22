import { describe, expect, it } from "vitest";
import type { BridgeEvent } from "../src/domain/events.js";
import { initialTopicView, mirrorRunCardToTopic, reduceTopicView } from "../src/domain/topic-view.js";
import { createQueuedRunCard, reduceRunCard } from "../src/domain/run-card-view.js";

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

  it("mirrors live output and ignores a stale terminal event", () => {
    let view = reduceTopicView(initialTopicView("b1"), event("TurnStarted", { promptId: "new", queueDepth: 2 }));
    view = reduceTopicView(view, event("TurnOutputObserved", { promptId: "new", answerDelta: "live ", progressEvents: [] }));
    view = reduceTopicView(view, event("TurnOutputObserved", { promptId: "new", answerDelta: "answer", progressEvents: [] }));
    view = reduceTopicView(view, event("TurnCompleted", { promptId: "old", answer: "stale", queueDepth: 1 }));

    expect(view).toMatchObject({ phase: "running", activePromptId: "new", answer: "live answer" });
  });

  it("projects blocked and orphaned states", () => {
    const blocked = reduceTopicView(initialTopicView("b1"), event("AgentStateChanged", { state: "blocked", queueDepth: 1 }));
    expect(blocked.phase).toBe("blocked");
    const orphaned = reduceTopicView(blocked, event("BindingOrphaned", { reason: "pane missing" }));
    expect(orphaned).toMatchObject({ phase: "orphaned", notice: "pane missing" });
  });

  it("restores the primary card state from the latest persisted request", () => {
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "do it", queuePosition: 1, occurredAt: "start" });
    const output = reduceRunCard(queued, { type: "output", occurredAt: "later", answerDelta: "latest answer", progressEvents: [{ key: "test", kind: "test", label: "tests passed", state: "done", occurredAt: "later" }] });
    const completed = reduceRunCard(output, { type: "completed", occurredAt: "done", answer: "finished" });

    expect(mirrorRunCardToTopic(initialTopicView("b1"), completed)).toMatchObject({ phase: "done", answer: "finished", latestProgress: "✅ tests passed", activePromptId: null });
  });
});
