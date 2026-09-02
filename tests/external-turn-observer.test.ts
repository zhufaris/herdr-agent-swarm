import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { ExternalTurnObserver } from "../src/coordinator/external-turn-observer.js";
import type { TraexTranscriptObservation } from "../src/domain/ports.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("ExternalTurnObserver", () => {
  it("opens only the active binding attached to a targeted Pane", async () => {
    const store = new SqliteBindingStore(":memory:");
    for (const [id, paneId] of [["b1", "w1:p1"], ["b2", "w1:p2"]]) {
      store.createPendingBinding({ id, workspaceId: "w1", chatId: "c1", topicId: `t-${id}`, rootMessageId: `root-${id}`, title: id });
      store.updateBinding(id, { state: "active", lifecycle: "active", attachment: "attached", paneId, agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: `session-${id}` });
    }
    const open = vi.fn(async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; } } }));
    const observer = new ExternalTurnObserver({ store, transcriptReader: { open }, bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), isBindingBusy: () => false, wakePrompt() {} });

    await observer.observeByPane(["w1:p2"]);

    expect(open).toHaveBeenCalledOnce();
    expect(open).toHaveBeenCalledWith(expect.objectContaining({ value: "session-b2" }));
    await observer.stop();
    store.close();
  });

  it("keeps a pending turn start across reads and projects a direct Herdr turn to completion", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", generation: 2, paneId: "w1:p1", agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const observations: TraexTranscriptObservation[] = [
      { turnId: "turn-1", freshTurnStart: true, answerDelta: "", turnLifecycle: { turnId: "turn-1", state: "active", startedAt: "2026-08-31T10:00:00.000Z" } },
      { turnId: "turn-1", requestText: "direct task", answerDelta: "", turnLifecycle: { turnId: "turn-1", state: "active", startedAt: "2026-08-31T10:00:00.000Z" } },
      { turnId: "turn-1", answerDelta: "answer", turnLifecycle: { turnId: "turn-1", state: "active", startedAt: "2026-08-31T10:00:00.000Z" } },
      { turnId: "turn-1", answerDelta: "", turnLifecycle: { turnId: "turn-1", state: "completed", startedAt: "2026-08-31T10:00:00.000Z", finalAnswer: "answer" } },
      { answerDelta: "" }
    ];
    const cursor = { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } };
    const transcriptReader = { open: vi.fn(async () => ({ mode: "typed" as const, cursor })) };
    const bus = new BridgeEventBus();
    const events: string[] = [];
    bus.onBridgeEvent("capture", (event) => { events.push(event.type); });
    const wake = vi.fn();
    const observer = new ExternalTurnObserver({ store, transcriptReader, bus, outboundWork: { wake }, logger: pino({ enabled: false }), isBindingBusy: () => false, wakePrompt() {}, idFactory: () => "external-1" });

    await observer.observe(store.getBinding("b1")!);
    expect(store.getPrompt("external-1")).toBeNull();
    await observer.observe(store.getBinding("b1")!);

    expect(store.getPrompt("external-1")).toMatchObject({ executionOrigin: "herdr", state: "delivered", observationState: "completed", transcriptTurnId: "turn-1" });
    expect(store.loadRunCard("external-1")).toMatchObject({ phase: "completed", answer: "answer" });
    expect(events).toEqual(["TurnStarted", "TurnOutputObserved", "TurnCompleted"]);
    expect(wake).toHaveBeenCalledOnce();
    store.close();
  });

  it("recovers a persisted external turn from a terminal transcript baseline while the binding is busy after restart", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const startedAt = "2026-08-31T10:00:00.000Z";
    const view = createQueuedRunCard({ promptId: "external-1", bindingId: "b1", title: "Direct", workspaceId: "w1", paneId: "w1:p1", requestText: "direct task", queuePosition: 0, occurredAt: startedAt });
    store.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1",
      expectedSession: { source: "traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "turn-1", startedAt, requestText: "direct task", externalPromptId: "external-1",
      externalMessageId: "herdr-turn:session-1:turn-1", externalView: view, answerCardFor: () => ({})
    });
    const completed: TraexTranscriptObservation = {
      turnId: "turn-1", answerDelta: "",
      turnLifecycle: { turnId: "turn-1", state: "completed", startedAt, finalAnswer: "recovered answer" }
    };
    const wakePrompt = vi.fn();
    const open = vi.fn(async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return { turnId: "later-turn", answerDelta: "", turnLifecycle: { turnId: "later-turn", state: "completed" as const, startedAt, finalAnswer: "later answer" } }; } } }));
    const openAtTurn = vi.fn(async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return completed; } } }));
    const observer = new ExternalTurnObserver({
      store,
      transcriptReader: { open, openAtTurn },
      bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), isBindingBusy: () => true, wakePrompt
    });

    await observer.observe(store.getBinding("b1")!);
    await observer.observe(store.getBinding("b1")!);

    expect(store.getPrompt("external-1")).toMatchObject({ state: "delivered", observationState: "completed" });
    expect(store.loadRunCard("external-1")).toMatchObject({ phase: "completed", answer: "recovered answer" });
    expect(open).not.toHaveBeenCalled();
    expect(openAtTurn).toHaveBeenCalledWith(expect.objectContaining({ value: "session-1" }), "turn-1", startedAt);
    expect(wakePrompt).toHaveBeenCalledWith("b1");
    await observer.stop();
    store.close();
  });

  it("fails an adopted external turn when TraeX records a human interruption and wakes the FIFO", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const turnId = "turn-aborted";
    const observations: TraexTranscriptObservation[] = [
      { turnId, freshTurnStart: true, requestText: "direct task", answerDelta: "", turnLifecycle: { turnId, state: "active", startedAt: "2026-08-31T10:00:00.000Z" } },
      { turnId, answerDelta: "", turnLifecycle: { turnId, state: "aborted", startedAt: "2026-08-31T10:00:00.000Z", reason: "interrupted" } },
      { answerDelta: "" }
    ];
    const events: string[] = [];
    const bus = new BridgeEventBus();
    bus.onBridgeEvent("capture", (event) => events.push(event.type));
    const wakePrompt = vi.fn();
    const observer = new ExternalTurnObserver({
      store,
      transcriptReader: { open: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } } }) },
      bus, outboundWork: { wake() {} }, logger: pino({ enabled: false }), isBindingBusy: () => false, wakePrompt, idFactory: () => "external-aborted"
    });

    const binding = store.getBinding("b1")!;
    await observer.observe(binding);
    await observer.observe(binding);
    await observer.observe(binding);

    expect(store.getPrompt("external-aborted")).toMatchObject({ state: "failed", observationState: "completed" });
    expect(events).toEqual(["TurnStarted", "TurnFailed"]);
    expect(wakePrompt).toHaveBeenCalledWith("b1");
    await observer.stop();
    store.close();
  });

  it("does not poll transcript data while a binding worker is busy but permits an explicit handoff", async () => {
    const readObservation = vi.fn(async () => ({ answerDelta: "" }));
    const open = vi.fn(async () => ({ mode: "typed" as const, cursor: { readDelta: async () => "", readObservation } }));
    let active = false;
    const store = { getBinding: () => binding, getActiveExternalPrompt: () => null } as never;
    const observer = new ExternalTurnObserver({ store, transcriptReader: { open }, bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), isBindingBusy: () => active, wakePrompt() {} });
    const binding = { id: "b1", generation: 1, paneId: "w1:p1", agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" } as never;
    await observer.observe(binding);
    active = true;
    await observer.observe(binding);
    expect(open).toHaveBeenCalledOnce();
    expect(readObservation).not.toHaveBeenCalled();
    await observer.handoff("b1");
    expect(readObservation).toHaveBeenCalledOnce();
  });

  it("polls active bindings without requiring a Herdr runtime reconciliation", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const observations: TraexTranscriptObservation[] = [
      { turnId: "turn-1", freshTurnStart: true, requestText: "direct task", answerDelta: "answer", turnLifecycle: { turnId: "turn-1", state: "completed", startedAt: "2026-08-31T10:00:00.000Z", finalAnswer: "answer" } },
      { answerDelta: "" }
    ];
    const cursor = { async readDelta() { return ""; }, async readObservation() { return observations.shift() ?? { answerDelta: "" }; } };
    const wakePrompt = vi.fn();
    const observer = new ExternalTurnObserver({ store, transcriptReader: { open: async () => ({ mode: "typed" as const, cursor }) }, bus: new BridgeEventBus(), outboundWork: { wake() {} }, logger: pino({ enabled: false }), isBindingBusy: () => false, wakePrompt, idFactory: () => "external-1" });

    await observer.scanActiveBindings();
    await observer.scanActiveBindings();

    expect(store.getPrompt("external-1")).toMatchObject({ state: "delivered", executionOrigin: "herdr" });
    expect(wakePrompt).toHaveBeenCalledWith("b1");
    await observer.stop();
    store.close();
  });

  it("does not reproject a superseding turn after its handed-off cursor completed it", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const existing = createQueuedRunCard({ promptId: "old", bindingId: "b1", title: "Old", workspaceId: "w1", paneId: "w1:p1", requestText: "old", queuePosition: 1, occurredAt: "2026-08-31T10:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "old", bindingId: "b1", larkMessageId: "m-old", actorOpenId: "u1", body: "old" }, view: existing, rootMessageId: "root", answerCard: {} });
    store.database.prepare("UPDATE prompt_jobs SET state='running', observation_state='detached', dispatched_at='2026-08-31T10:00:01.000Z', transcript_turn_id='old-turn', transcript_turn_started_at='2026-08-31T10:00:01.000Z' WHERE id='old'").run();
    const replay: TraexTranscriptObservation[] = [
      { turnId: "new-turn", freshTurnStart: true, requestText: "new", answerDelta: "answer", turnLifecycle: { turnId: "new-turn", state: "completed", startedAt: "2026-08-31T10:00:02.000Z", finalAnswer: "answer" } }, { answerDelta: "" }
    ];
    const bus = new BridgeEventBus(); const events: string[] = []; bus.onBridgeEvent("capture", (event) => events.push(event.type));
    const observer = new ExternalTurnObserver({ store, transcriptReader: { open: async () => ({ mode: "typed" as const, cursor: { async readDelta() { return ""; }, async readObservation() { return replay.shift() ?? { answerDelta: "" }; } } }) }, bus, outboundWork: { wake() {} }, logger: pino({ enabled: false }), isBindingBusy: () => false, wakePrompt() {}, idFactory: () => "external" });
    const binding = store.getBinding("b1")!; const old = store.getPrompt("old")!;
    const completed = await observer.observeSupersedingTurn(binding, old, { turnId: "new-turn", freshTurnStart: true, requestText: "new", answerDelta: "answer", turnLifecycle: { turnId: "new-turn", state: "completed", startedAt: "2026-08-31T10:00:02.000Z", finalAnswer: "answer" } });
    expect(completed).toBe("completed"); const eventCount = events.length;
    await observer.observe(binding); await observer.observe(binding);
    expect(events).toHaveLength(eventCount); expect(store.loadRunCard("external")).toMatchObject({ answer: "answer", phase: "completed" });
    await observer.stop(); store.close();
  });
});
