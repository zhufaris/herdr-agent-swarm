import { describe, expect, it } from "vitest";
import type { BridgeEvent } from "../src/domain/events.js";
import { initialTopicView, mirrorRunCardToTopic, reduceTopicView } from "../src/domain/topic-view.js";
import { createQueuedRunCard, reduceRunCard } from "../src/domain/run-card-view.js";
import { renderProjectEntryCard } from "../src/cards/run-card.js";

function event<T extends BridgeEvent["type"]>(type: T, payload: Extract<BridgeEvent, { type: T }>["payload"]): Extract<BridgeEvent, { type: T }> {
  return { eventId: type, bindingId: "b1", type, origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload } as Extract<BridgeEvent, { type: T }>;
}

describe("topic view reducer", () => {
  it("persists Primary tool unavailability independently from binding health", () => {
    const initial = initialTopicView("b1");
    const unavailable = reduceTopicView(initial, { eventId: "e1", bindingId: "b1", type: "PrimaryToolAvailabilityChanged", origin: "bridge", occurredAt: "2026-08-30T00:00:00.000Z", payload: { available: false, reason: "Primary tools unavailable; use reset or replace" } });
    expect(unavailable).toMatchObject({ phase: "provisioning", primaryToolsAvailable: false, primaryToolsNotice: "Primary tools unavailable; use reset or replace" });
    expect(JSON.stringify(renderProjectEntryCard(unavailable))).toContain("Primary tools unavailable; use reset or replace");
  });
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

  it("persists observed model and context telemetry on the main-card projection", () => {
    const running = reduceTopicView(initialTopicView("b1"), event("TurnStarted", { promptId: "p1", queueDepth: 1 }));
    const observed = reduceTopicView(running, event("TurnOutputObserved", { promptId: "p1", answerSnapshot: "", progressEvents: [], model: "GPT-5.6-Sol", context: "31.1K tokens" }));

    expect(observed).toMatchObject({ model: "GPT-5.6-Sol", context: "31.1K tokens" });
  });

  it("projects Main Card live status independently from Answer Card output", () => {
    const running = reduceTopicView(initialTopicView("b1"), event("TurnStarted", { promptId: "p1", queueDepth: 1 }));
    const observed = reduceTopicView(running, event("TurnOutputObserved", {
      promptId: "p1", observation: { answer: { snapshot: "Public answer only", toolActivities: [{ key: "tool", kind: "test", label: "npm test", state: "done" }] }, main: { status: { statusTitle: "Running focused verification", elapsedSeconds: 177, tokenCount: 4_570, planSteps: [
        { key: "plan:0", kind: "step", label: "Inspect state", state: "done" },
        { key: "plan:1", kind: "step", label: "Deploy bridge", state: "active" }
      ] } } }
    }));

    expect(observed.answer).toBe("Public answer only");
    expect(observed.recentProgress).toEqual([expect.objectContaining({ key: "tool" })]);
    expect(observed.liveStatus).toEqual({
      statusTitle: "Running focused verification", elapsedSeconds: 177, tokenCount: 4_570,
      planSteps: [expect.objectContaining({ key: "plan:0" }), expect.objectContaining({ key: "plan:1" })]
    });
  });

  it("keeps completed live status for the Main Card and clears it only for a new turn", () => {
    let view = reduceTopicView(initialTopicView("b1"), event("TurnStarted", { promptId: "p1", queueDepth: 1 }));
    view = reduceTopicView(view, event("TurnOutputObserved", { promptId: "p1", observation: { answer: { snapshot: "", toolActivities: [] }, main: { status: { statusTitle: "Finishing verification" } } } }));
    view = reduceTopicView(view, event("TurnCompleted", { promptId: "p1", answer: "Done", queueDepth: 0 }));
    expect(view.liveStatus?.statusTitle).toBe("Finishing verification");

    view = reduceTopicView(view, event("TurnStarted", { promptId: "p2", queueDepth: 1 }));
    expect(view.liveStatus).toBeNull();
  });

  it("keeps a running main card running when reconciliation observes more terminal output", () => {
    const running = reduceTopicView(initialTopicView("b1"), event("TurnStarted", { promptId: "p1", queueDepth: 1 }));
    const observed = reduceTopicView(running, event("PaneOutputObserved", { answer: "still working" }));

    expect(observed).toMatchObject({ phase: "running", agentState: "working", activePromptId: "p1", answer: "still working" });
  });

  it("marks an idle passive terminal answer completed when no turn is active", () => {
    const ready = reduceTopicView(initialTopicView("b1"), event("BindingActivated", { paneId: "w1:p1", topicId: "t1" }));
    const observed = reduceTopicView(ready, event("PaneOutputObserved", { answer: "completed outside the bridge" }));

    expect(observed).toMatchObject({ phase: "done", agentState: "done", activePromptId: null, answer: "completed outside the bridge" });
  });

  it("persists the Git worktree directory name without changing the turn lifecycle", () => {
    const running = reduceTopicView(initialTopicView("b1"), event("TurnStarted", { promptId: "p1", queueDepth: 1 }));
    const observed = reduceTopicView(running, event("PaneOutputObserved", { worktreeName: "feat-main-card" }));

    expect(observed).toMatchObject({ phase: "running", activePromptId: "p1", worktreeName: "feat-main-card" });
  });

  it("does not update the project card for an identical visible snapshot", () => {
    const running = reduceTopicView(initialTopicView("b1"), event("TurnStarted", { promptId: "p1", queueDepth: 1 }));
    const first = reduceTopicView(running, event("TurnOutputObserved", { promptId: "p1", answerSnapshot: "Working", hasProgressSnapshot: true, progressEvents: [{ key: "step:test", kind: "step", label: "Run tests", state: "active" }] }));
    const duplicateEvent = { ...event("TurnOutputObserved", { promptId: "p1", answerSnapshot: "Working", hasProgressSnapshot: true, progressEvents: [{ key: "step:test", kind: "step" as const, label: "Run tests", state: "active" as const }] }), eventId: "duplicate", occurredAt: "later" };

    expect(reduceTopicView(first, duplicateEvent)).toBe(first);
  });

  it("advances a durable Main Card version only for visible changes", () => {
    const initial = initialTopicView("b1");
    const started = reduceTopicView(initial, event("TurnStarted", { promptId: "p1", queueDepth: 1 }));
    const duplicate = reduceTopicView(started, { ...event("TurnStarted", { promptId: "p1", queueDepth: 1 }), eventId: "duplicate" });

    expect(initial).toMatchObject({ viewVersion: 0, deliveredVersion: 0 });
    expect(started).toMatchObject({ viewVersion: 1, deliveredVersion: 0 });
    expect(duplicate).toBe(started);
  });

  it("uses the latest visible event time as durable Main Card activity time", () => {
    const started = reduceTopicView(initialTopicView("b1"), {
      ...event("TurnStarted", { promptId: "p1", queueDepth: 1 }),
      occurredAt: "2026-08-27T12:00:00Z"
    });
    expect(started.activityAt).toBe("2026-08-27T12:00:00Z");

    const duplicate = reduceTopicView(started, {
      ...event("TurnStarted", { promptId: "p1", queueDepth: 1 }),
      eventId: "duplicate", occurredAt: "2026-08-27T12:05:00Z"
    });
    expect(duplicate).toBe(started);
    expect(duplicate.activityAt).toBe("2026-08-27T12:00:00Z");
  });

  it("keeps complete current-turn progress and the latest 9000 answer characters", () => {
    let view = reduceTopicView(initialTopicView("b1"), event("TurnStarted", { promptId: "p1", queueDepth: 1 }));
    let fullAnswer = "";
    for (let index = 0; index < 34; index += 1) {
      fullAnswer += String(index % 10).repeat(300);
      view = reduceTopicView(view, event("TurnOutputObserved", {
        promptId: "p1", answerSnapshot: fullAnswer,
        progressEvents: [{ key: `read:${index}`, kind: "read", label: `file-${index}`, state: "done" }]
      }));
    }

    expect(view.recentProgress).toHaveLength(34);
    expect(view.recentProgress.map((item) => item.key)).toEqual(Array.from({ length: 34 }, (_, index) => `read:${index}`));
    expect(view.answer).toHaveLength(9_000);
    expect(view.answer).toBe(fullAnswer.slice(-9_000));
  });

  it("updates repeated progress keys in place within one incremental snapshot", () => {
    let view = reduceTopicView(initialTopicView("b1"), event("TurnStarted", { promptId: "p1", queueDepth: 1 }));
    view = reduceTopicView(view, event("TurnOutputObserved", {
      promptId: "p1", answerSnapshot: "", progressEvents: [
        { key: "read:config", kind: "read", label: "config", state: "active" },
        { key: "test", kind: "test", label: "tests", state: "active" },
        { key: "read:config", kind: "read", label: "config", state: "done" }
      ]
    }));

    expect(view.recentProgress).toEqual([
      expect.objectContaining({ key: "read:config", state: "done" }),
      expect.objectContaining({ key: "test", state: "active" })
    ]);
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

  it("projects a live but unregistered Agent as degraded", () => {
    const degraded = reduceTopicView(initialTopicView("b1"), event("BindingDegraded", { reason: "TraeX is not registered as a Herdr Agent" }));

    expect(degraded).toMatchObject({ phase: "degraded", notice: "TraeX is not registered as a Herdr Agent" });
  });

  it("restores the primary card state from the latest persisted request", () => {
    const queued = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "do it", queuePosition: 1, occurredAt: "start" });
    const output = reduceRunCard(queued, { type: "output", occurredAt: "later", answerSnapshot: "latest answer", progressEvents: [{ key: "test", kind: "test", label: "tests passed", state: "done", occurredAt: "later" }] });
    const completed = reduceRunCard(output, { type: "completed", occurredAt: "done", answer: "finished" });

    expect(mirrorRunCardToTopic(initialTopicView("b1"), { ...completed, answer: "x".repeat(9_100), progressEvents: Array.from({ length: 10 }, (_, index) => ({ key: String(index), kind: "test" as const, label: `test-${index}`, state: "done" as const, occurredAt: "later" })) })).toMatchObject({
      phase: "done", answer: "x".repeat(9_000), activePromptId: null, recentProgress: Array.from({ length: 10 }, (_, index) => expect.objectContaining({ key: String(index) })), viewVersion: 1
    });
  });
});
