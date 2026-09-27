import { describe, expect, it } from "vitest";
import type { BridgeEvent } from "../src/domain/events.js";
import { initialTopicView, mirrorRunCardToTopic, reduceTopicView, updateTopicModelPreference } from "../src/domain/topic-view.js";
import { createQueuedRunCard, reduceRunCard } from "../src/domain/run-card-view.js";
import { renderProjectEntryCard } from "../src/cards/run-card.js";

function event<T extends BridgeEvent["type"]>(type: T, payload: Extract<BridgeEvent, { type: T }>["payload"]): Extract<BridgeEvent, { type: T }> {
  return { eventId: type, bindingId: "b1", type, origin: "bridge", occurredAt: "2026-08-22T00:00:00Z", payload } as Extract<BridgeEvent, { type: T }>;
}

describe("topic view reducer", () => {
  it("projects model preference separately from confirmed runtime telemetry", () => {
    const observed = { ...initialTopicView("b1"), model: "GPT-5.4" };
    const pending = updateTopicModelPreference(observed, {
      bindingId: "b1", bindingGeneration: 1, desiredModel: "GPT-5.6-Sol", desiredRevision: 2,
      effectiveModel: "GPT-5.4", effectiveRevision: 1, state: "pending", dispatchPromptId: null, preparedOperationId: null, updatedAt: "now"
    });

    expect(pending).toMatchObject({ model: "GPT-5.4", modelPreference: { model: "GPT-5.6-Sol", state: "pending", revision: 2 } });
    expect(updateTopicModelPreference(pending, null)).toMatchObject({ model: "GPT-5.4", modelPreference: null, viewVersion: pending.viewVersion + 1 });
  });
  it("persists Primary tool unavailability without rendering its recovery notice", () => {
    const initial = initialTopicView("b1");
    const unavailable = reduceTopicView(initial, { eventId: "e1", bindingId: "b1", type: "PrimaryToolAvailabilityChanged", origin: "bridge", occurredAt: "2026-08-30T00:00:00.000Z", payload: { available: false, reason: "Primary tools unavailable; use reset or replace" } });
    expect(unavailable).toMatchObject({ phase: "provisioning", primaryToolsAvailable: false, primaryToolsNotice: "Primary tools unavailable; use reset or replace" });
    expect(JSON.stringify(renderProjectEntryCard(unavailable))).not.toContain("Primary tools unavailable; use reset or replace");
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

  it("keeps the latest ten Core Agent messages and updates stable message IDs in place", () => {
    let view = reduceTopicView(initialTopicView("b1"), event("TurnStarted", { promptId: "p1", queueDepth: 1 }));
    for (let index = 0; index < 11; index += 1) {
      view = reduceTopicView(view, event("TurnOutputObserved", {
        promptId: "p1",
        observation: {
          answer: { snapshot: "", toolActivities: [] }, main: {},
          agentMessages: [{ messageId: `m${index}`, turnId: "t1", channel: "commentary", markdown: `message ${index}`, occurredAt: `2026-09-27T00:00:${String(index).padStart(2, "0")}Z` }]
        }
      }));
    }
    expect(view.recentAgentMessages).toHaveLength(10);
    expect(view.recentAgentMessages[0]?.messageId).toBe("m1");

    view = reduceTopicView(view, event("TurnOutputObserved", {
      promptId: "p1",
      observation: {
        answer: { snapshot: "", toolActivities: [] }, main: {},
        agentMessages: [{ messageId: "m10", turnId: "t1", channel: "final", markdown: "updated final", occurredAt: "2026-09-27T00:01:00Z" }]
      }
    }));
    expect(view.recentAgentMessages.at(-1)).toMatchObject({ messageId: "m10", channel: "final", markdown: "updated final" });
  });

  it("replaces an adjacent duplicate commentary message with its final form and clears on a new turn", () => {
    let view = reduceTopicView(initialTopicView("b1"), event("TurnStarted", { promptId: "p1", queueDepth: 1 }));
    view = reduceTopicView(view, event("TurnOutputObserved", {
      promptId: "p1", observation: { answer: { snapshot: "", toolActivities: [] }, main: {}, agentMessages: [
        { messageId: "commentary", turnId: "t1", channel: "commentary", markdown: "Done **well**", occurredAt: "one" },
        { messageId: "final", turnId: "t1", channel: "final", markdown: "Done **well**", occurredAt: "two" }
      ] }
    }));
    expect(view.recentAgentMessages).toEqual([expect.objectContaining({ messageId: "final", channel: "final" })]);
    expect(reduceTopicView(view, event("TurnStarted", { promptId: "p2", queueDepth: 1 })).recentAgentMessages).toEqual([]);
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

  it("persists a stable pane name and does not erase it when an observation omits the name", () => {
    const activated = reduceTopicView(initialTopicView("b1"), event("BindingActivated", { paneId: "w1:p1", paneToken: "yx0c", paneName: " nxmz ", topicId: "t1" }));
    const omitted = reduceTopicView(activated, event("PaneOutputObserved", { tabId: "w1:t1" }));
    const renamed = reduceTopicView(omitted, event("PaneOutputObserved", { paneName: "next" }));

    expect(activated).toMatchObject({ paneName: "nxmz" });
    expect(omitted).toMatchObject({ paneName: "nxmz" });
    expect(renamed).toMatchObject({ paneName: "next", viewVersion: omitted.viewVersion + 1 });
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

  it("keeps bounded current-turn progress and the latest 9000 answer characters", () => {
    let view = reduceTopicView(initialTopicView("b1"), event("TurnStarted", { promptId: "p1", queueDepth: 1 }));
    let fullAnswer = "";
    for (let index = 0; index < 34; index += 1) {
      fullAnswer += String(index % 10).repeat(300);
      view = reduceTopicView(view, event("TurnOutputObserved", {
        promptId: "p1", answerSnapshot: fullAnswer,
        progressEvents: [{ key: `read:${index}`, kind: "read", label: `file-${index}`, state: "done" }]
      }));
    }

    expect(view.recentProgress).toHaveLength(8);
    expect(view.recentProgress.map((item) => item.key)).toEqual(Array.from({ length: 8 }, (_, index) => `read:${index + 26}`));
    expect(view.progressSummary).toEqual({ total: 34, stepTotal: 0, stepDone: 0 });
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
      phase: "done", answer: "x".repeat(9_000), activePromptId: null, recentProgress: Array.from({ length: 10 }, (_, index) => expect.objectContaining({ key: String(index) })),
      recentConversation: [
        { key: "p1:user", promptId: "p1", role: "user", content: "do it", occurredAt: "start" },
        { key: "p1:agent", promptId: "p1", role: "agent", content: "x".repeat(2_000), occurredAt: "done" }
      ],
      viewVersion: 1
    });
  });

  it("adds one terminal Agent message and retains the newest five conversation messages", () => {
    let topic = initialTopicView("b1");
    for (let index = 1; index <= 3; index += 1) {
      const queued = createQueuedRunCard({ promptId: `p${index}`, bindingId: "b1", title: `Task ${index}`, workspaceId: "w1", paneId: "w1:p1", requestText: `request-${index}`, queuePosition: 0, occurredAt: `2026-08-22T00:0${index}:00Z` });
      topic = mirrorRunCardToTopic(topic, queued);
      const first = reduceRunCard(queued, { type: "output", occurredAt: `2026-08-22T00:0${index}:01Z`, answerSnapshot: `draft-${index}`, progressEvents: [] });
      topic = mirrorRunCardToTopic(topic, first);
      const updated = reduceRunCard(first, { type: "output", occurredAt: `2026-08-22T00:0${index}:02Z`, answerSnapshot: `answer-${index}`, progressEvents: [] });
      topic = mirrorRunCardToTopic(topic, updated);
      const completed = reduceRunCard(updated, { type: "completed", occurredAt: `2026-08-22T00:0${index}:03Z`, answer: "", replaceAnswer: false });
      topic = mirrorRunCardToTopic(topic, completed);
    }

    expect(topic.recentConversation).toEqual([
      expect.objectContaining({ key: "p1:agent", content: "answer-1" }),
      expect.objectContaining({ key: "p2:user", content: "request-2" }),
      expect.objectContaining({ key: "p2:agent", content: "answer-2" }),
      expect.objectContaining({ key: "p3:user", content: "request-3" }),
      expect.objectContaining({ key: "p3:agent", content: "answer-3" })
    ]);
    expect(topic.recentConversation.filter((message) => message.key === "p3:agent")).toHaveLength(1);
  });

  it("keeps an active Agent draft out of Main Card history until the run is terminal", () => {
    const queued = createQueuedRunCard({ promptId: "p-live", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "inspect", queuePosition: 0, occurredAt: "start" });
    const running = reduceRunCard(queued, { type: "output", occurredAt: "middle", answerSnapshot: "partial answer", progressEvents: [] });
    const liveTopic = mirrorRunCardToTopic(initialTopicView("b1"), running);
    const completed = reduceRunCard(running, { type: "completed", occurredAt: "done", answer: "final answer" });
    const finalTopic = mirrorRunCardToTopic(liveTopic, completed);

    expect(liveTopic.recentConversation).toEqual([
      expect.objectContaining({ key: "p-live:user", content: "inspect" })
    ]);
    expect(finalTopic.recentConversation).toEqual([
      expect.objectContaining({ key: "p-live:user", content: "inspect" }),
      expect.objectContaining({ key: "p-live:agent", content: "partial answer\n\nfinal answer" })
    ]);
  });

  it("upserts answer timeline items by stable identity and canonical sequence", () => {
    const queued = createQueuedRunCard({ promptId: "p-timeline", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    const first = reduceRunCard(queued, { type: "output", occurredAt: "one", answerSnapshot: "", progressEvents: [], timelineDeltas: [
      { kind: "tool", id: "tool:1", sequence: 2, category: "test", label: "npm test", state: "running" },
      { kind: "agent_message", id: "message:1", sequence: 1, markdown: "Checking" }
    ] });
    const updated = reduceRunCard(first, { type: "output", occurredAt: "two", answerSnapshot: "", progressEvents: [], timelineDeltas: [
      { kind: "tool", id: "tool:1", sequence: 2, category: "test", label: "npm test", resultPreview: "2 passed", state: "succeeded" }
    ] });
    const duplicate = reduceRunCard(updated, { type: "output", occurredAt: "three", answerSnapshot: "", progressEvents: [], timelineDeltas: [updated.timelineItems[1]!] });

    expect(updated.timelineItems).toEqual([
      { kind: "agent_message", id: "message:1", sequence: 1, markdown: "Checking" },
      { kind: "tool", id: "tool:1", sequence: 2, category: "test", label: "npm test", resultPreview: "2 passed", state: "succeeded" }
    ]);
    expect(duplicate).toBe(updated);
  });
});
