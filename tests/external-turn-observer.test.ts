import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { ExternalTurnObserver } from "../src/coordinator/external-turn-observer.js";
import type { TraexTranscriptObservation } from "../src/domain/ports.js";
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

  it("does not poll transcript data while a binding worker is busy but permits an explicit handoff", async () => {
    const readObservation = vi.fn(async () => ({ answerDelta: "" }));
    const open = vi.fn(async () => ({ mode: "typed" as const, cursor: { readDelta: async () => "", readObservation } }));
    let active = false;
    const store = { getBinding: () => binding } as never;
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
});
