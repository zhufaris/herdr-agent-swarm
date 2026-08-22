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
    view = reduceTopicView(view, event("TurnOutputObserved", { promptId: "new", answerSnapshot: "live ", progressEvents: [] }));
    view = reduceTopicView(view, event("TurnOutputObserved", { promptId: "new", answerSnapshot: "live answer", progressEvents: [] }));
    view = reduceTopicView(view, event("TurnCompleted", { promptId: "old", answer: "stale", queueDepth: 1 }));

    expect(view).toMatchObject({ phase: "running", activePromptId: "new", answer: "live answer" });
  });

  it("does not update the project card for an identical visible snapshot", () => {
    const running = reduceTopicView(initialTopicView("b1"), event("TurnStarted", { promptId: "p1", queueDepth: 1 }));
    const first = reduceTopicView(running, event("TurnOutputObserved", { promptId: "p1", answerSnapshot: "Working", hasProgressSnapshot: true, progressEvents: [{ key: "step:test", kind: "step", label: "Run tests", state: "active" }] }));
    const duplicateEvent = { ...event("TurnOutputObserved", { promptId: "p1", answerSnapshot: "Working", hasProgressSnapshot: true, progressEvents: [{ key: "step:test", kind: "step" as const, label: "Run tests", state: "active" as const }] }), eventId: "duplicate", occurredAt: "later" };

    expect(reduceTopicView(first, duplicateEvent)).toBe(first);
  });

  it("keeps only the latest eight progress entries and the latest 2500 answer characters", () => {
    let view = reduceTopicView(initialTopicView("b1"), event("TurnStarted", { promptId: "p1", queueDepth: 1 }));
    for (let index = 0; index < 9; index += 1) {
      view = reduceTopicView(view, event("TurnOutputObserved", {
        promptId: "p1", answerSnapshot: Array.from({ length: index + 1 }, (_, snapshotIndex) => String(snapshotIndex).repeat(300)).join(""),
        progressEvents: [{ key: `read:${index}`, kind: "read", label: `file-${index}`, state: "done" }]
      }));
    }

    expect(view.recentProgress).toHaveLength(8);
    expect(view.recentProgress.map((item) => item.key)).toEqual(Array.from({ length: 8 }, (_, index) => `read:${index + 1}`));
    expect(view.answer).toHaveLength(2500);
    expect(view.answer).toBe(`${"0".repeat(100)}${"1".repeat(300)}${"2".repeat(300)}${"3".repeat(300)}${"4".repeat(300)}${"5".repeat(300)}${"6".repeat(300)}${"7".repeat(300)}${"8".repeat(300)}`);
  });

  it("resets the rolling window when a new request starts", () => {
    let view = reduceTopicView(initialTopicView("b1"), event("TurnStarted", { promptId: "p1", queueDepth: 1 }));
    view = reduceTopicView(view, event("TurnOutputObserved", { promptId: "p1", answerSnapshot: "old", progressEvents: [{ key: "old", kind: "edit", label: "old", state: "done" }] }));
    view = reduceTopicView(view, event("TurnStarted", { promptId: "p2", queueDepth: 1 }));

    expect(view).toMatchObject({ activePromptId: "p2", answer: null, recentProgress: [] });
  });

  it("projects blocked and orphaned states", () => {
    const blocked = reduceTopicView(initialTopicView("b1"), event("AgentStateChanged", { state: "blocked", queueDepth: 1 }));
    expect(blocked.phase).toBe("blocked");
    const orphaned = reduceTopicView(blocked, event("BindingOrphaned", { reason: "pane missing" }));
    expect(orphaned).toMatchObject({ phase: "orphaned", notice: "pane missing" });
  });

  it("restores the primary card state from the latest persisted request", () => {
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "do it", queuePosition: 1, occurredAt: "start" });
    const output = reduceRunCard(queued, { type: "output", occurredAt: "later", answerSnapshot: "latest answer", progressEvents: [{ key: "test", kind: "test", label: "tests passed", state: "done", occurredAt: "later" }] });
    const completed = reduceRunCard(output, { type: "completed", occurredAt: "done", answer: "finished" });

    expect(mirrorRunCardToTopic(initialTopicView("b1"), { ...completed, answer: "x".repeat(2_600), progressEvents: Array.from({ length: 10 }, (_, index) => ({ key: String(index), kind: "test" as const, label: `test-${index}`, state: "done" as const, occurredAt: "later" })) })).toMatchObject({
      phase: "done", answer: "x".repeat(2_500), activePromptId: null, recentProgress: Array.from({ length: 8 }, (_, index) => expect.objectContaining({ key: String(index + 2) }))
    });
  });
});
