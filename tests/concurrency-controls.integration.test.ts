import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import type { HerdrPort, LarkPort, TraexTranscriptReaderPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";

const STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE = "⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。";

describe("coordinator concurrency controls", () => {
  it("continues startup after a recoverable view convergence stage fails", async () => {
    const store = new SqliteBindingStore(":memory:");
    const originalListBindings = store.listBindings.bind(store);
    let first = true;
    store.listBindings = () => { if (first) { first = false; throw new Error("one startup view is unreadable"); } return originalListBindings(); };
    const lark = quietLark();
    const start = vi.spyOn(lark, "start");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, emptyHerdr(), lark, bus, publisher, pino({ enabled: false }));

    await expect(coordinator.start()).resolves.toBeUndefined();
    expect(start).toHaveBeenCalledOnce();
    expect(coordinator.snapshot()).toMatchObject({
      state: "degraded", completedAt: expect.any(String),
      stages: expect.arrayContaining([
        { name: "view-convergence", state: "failed", error: "one startup view is unreadable", durationMs: expect.any(Number) },
        { name: "runtime-reconciliation", state: "completed", durationMs: expect.any(Number) }
      ])
    });

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("checks configured workspaces concurrently during startup", async () => {
    const release = new Map<string, () => void>();
    const assertWorkspace = vi.fn((workspaceId: string) => new Promise<void>((resolve) => { release.set(workspaceId, resolve); }));
    const herdr = { ...emptyHerdr(), assertWorkspace };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const startupConfig = { ...config(), projects: [
      { id: "one", displayName: "One", description: "One", workspaceId: "w1", cwd: "/one" },
      { id: "two", displayName: "Two", description: "Two", workspaceId: "w2", cwd: "/two" }
    ], defaultProjectId: "one" };
    const coordinator = createTestRouter(startupConfig, store, herdr, lark, bus, publisher, pino({ enabled: false }));

    const startup = coordinator.start();
    await vi.waitFor(() => expect(assertWorkspace.mock.calls.map(([workspaceId]) => workspaceId).sort()).toEqual(["w1", "w2"]));
    release.get("w1")!();
    release.get("w2")!();
    await startup;

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("coalesces concurrent reconciliation calls into one workspace scan", async () => {
    let block = false;
    let release!: () => void;
    let blocked = Promise.resolve();
    let scans = 0;
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { scans += 1; if (block) await blocked; return []; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt() { return "done"; }, async renamePane() {}
    };
    const { coordinator, publisher, store } = fixture(herdr);
    await coordinator.start();
    scans = 0; block = true; blocked = new Promise<void>((resolve) => { release = resolve; });

    const first = coordinator.reconcile();
    const second = coordinator.reconcile();
    await vi.waitFor(() => expect(scans).toBe(1));
    release();
    await Promise.all([first, second]);
    expect(scans).toBe(1);

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("uses scoped binding queries for one reconciliation pass", async () => {
    const { coordinator, publisher, store } = fixture(emptyHerdr());
    await coordinator.start();
    const original = store.listBindingsByState.bind(store);
    const states: string[] = [];
    store.listBindingsByState = (state) => { states.push(state); return original(state); };
    store.listBindings = () => { throw new Error("reconcile must not load every binding"); };

    await coordinator.reconcile();

    expect(states).toEqual(["active"]);
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("loads affected run cards once when a Pane is missing", async () => {
    const { coordinator, publisher, store } = fixture(emptyHerdr());
    await coordinator.start();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active" });
    for (const [promptId, phase] of [["running", "running"], ["blocked", "blocked"], ["queued", "queued"], ["done", "completed"]] as const) {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 1, occurredAt: "2026-08-23T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "u1", body: promptId }, view, rootMessageId: "m1", answerCard: {} });
      store.saveRunCard({ ...store.loadRunCard(promptId)!, phase });
    }
    const original = store.listRunCardsByPhases.bind(store);
    const calls: string[][] = [];
    store.listRunCardsByPhases = (bindingId, phases) => { calls.push([...phases]); return original(bindingId, phases); };
    store.listRunCards = () => { throw new Error("missing-Pane reconciliation must use a phase query"); };

    await coordinator.reconcile();

    expect(calls).toEqual([["running", "blocked", "queued"]]);
    expect(store.loadRunCard("running")).toMatchObject({ phase: "failed", queuePosition: 0 });
    expect(store.loadRunCard("blocked")).toMatchObject({ phase: "failed", queuePosition: 0 });
    expect(store.loadRunCard("queued")).toMatchObject({ phase: "failed", queuePosition: 0 });
    expect(store.getPrompt("queued")).toMatchObject({ state: "cancelled", observationState: "completed" });
    expect(store.loadRunCard("done")).toMatchObject({ phase: "completed", viewVersion: 1 });
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("accepts concurrent inbound messages without waiting for Lark delivery", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const replies: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text" }; },
      async replyCard(rootMessageId) { if (rootMessageId === "m1") await firstBlocked; replies.push(rootMessageId); return { messageId: `card-${rootMessageId}` }; },
      async updateCard() {}
    };
    const { coordinator, publisher, store } = fixture(emptyHerdr(), lark);
    await coordinator.start();
    const first = coordinator.handleMessage(message(1));
    await vi.waitFor(() => expect(store.database.prepare("SELECT state FROM inbound_messages WHERE event_id = 'e1'").get()).toMatchObject({ state: "accepted" }));
    const second = coordinator.handleMessage(message(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.database.prepare("SELECT state FROM inbound_messages WHERE event_id = 'e2'").get()).toMatchObject({ state: "accepted" });

    releaseFirst();
    await Promise.all([first, second]);
    await vi.waitFor(() => expect(replies).toEqual(["m1", "m2"]));
    expect(replies).toEqual(["m1", "m2"]);
    expect(store.database.prepare("SELECT state FROM inbound_messages ORDER BY created_at, event_id").all()).toEqual([{ state: "accepted" }, { state: "accepted" }]);
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("starts a queued prompt while its initial answer card retries independently", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    let failReply = true;
    let runCount = 0;
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", title: "Task", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; },
      async createPane() { throw new Error("not used"); },
      async startTraex() {},
      async runPrompt() { runCount += 1; return "done"; },
      async renamePane() {}
    };
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text" }; },
      async replyCard() { return { messageId: "legacy" }; },
      async updateCard() {},
      async createStreamingCard() { return { cardId: "cardkit-1" }; },
      async replyStreamingCardReference() {
        if (failReply) { failReply = false; throw new Error("temporary"); }
        return { messageId: "answer-1" };
      },
      async streamCardContent() {},
      async finishStreamingCard() {}
    };
    const { coordinator, publisher, store } = fixture(herdr, lark);
    try {
      store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
      store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
      await coordinator.start();

      await coordinator.handleMessage({ eventId: "prompt-e1", messageId: "prompt-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "do work", mentionsBot: false, isRootMessage: false });

      await vi.waitFor(() => expect(runCount).toBe(1));
      await vi.advanceTimersByTimeAsync(1_300);
      await vi.waitFor(() => expect(store.loadRunCard(store.listRunCards("b1")[0]!.promptId)?.answerMessageId).toBe("answer-1"));
      expect(runCount).toBe(1);
    } finally {
      await coordinator.stop(); await publisher.stop(); store.close(); vi.useRealTimers();
    }
  });

  it("keeps a committed unavailable-output result completed when a lifecycle subscriber fails", async () => {
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", title: "Task", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; },
      async createPane() { throw new Error("not used"); },
      async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, _onObservation, _signal, onDispatched) { await onDispatched?.(); return "done"; },
      async renamePane() {}
    };
    const { coordinator, publisher, store, bus } = fixture(herdr);
    const lifecycleTypes: string[] = [];
    bus.onBridgeEvent("lifecycle-sequence", (event) => { lifecycleTypes.push(event.type); });
    bus.onBridgeEvent("failing-projector", (event) => {
      if (event.type === "TurnCompleted") throw new Error("projection failed");
    });
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "prompt-e1", messageId: "prompt-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "do work", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed", answer: STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE }));

    const promptId = store.listRunCards("b1")[0]!.promptId;
    expect(store.getPrompt(promptId)).toMatchObject({ state: "delivered", observationState: "completed", error: null });
    expect(lifecycleTypes).toContain("TurnStarted");
    expect(lifecycleTypes).toContain("TurnCompleted");
    expect(lifecycleTypes).not.toContain("RunQueuePositionChanged");
    await vi.waitFor(() => expect(bus.snapshot()).toMatchObject({ subscriberFailures: 1, lastFailedSubscriber: "failing-projector" }));

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("streams typed transcript output and ignores misleading terminal code markers", async () => {
    let terminalReads = 0;
    const deltas = [
      "Typed **analysis**",
      "```bash\nnpm test\n```\n\n```text\n12 tests passed\n```",
      "```diff\n--- a/src/a.ts\n+++ b/src/a.ts\n@@ -1 +1 @@\n-old\n+new\n```"
    ];
    const transcriptReader: TraexTranscriptReaderPort = {
      async open(session) {
        expect(session).toEqual({ source: "bridge", agent: "traex", kind: "id", value: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });
        return { mode: "typed", cursor: { async readDelta() { return deltas.shift() ?? ""; } } };
      }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) {
        await onDispatched?.();
        await onObservation?.({ state: "working", stateSource: "herdr", output: "• Bash fake terminal command\nnot typed" });
        await onObservation?.({ state: "working", stateSource: "herdr", output: "+ fake terminal diff" });
        return "done";
      }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const scheduler = undefined;
    const { logger, records } = collectingLogger();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, logger, 30_000, scheduler, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", reportedTraexSessionId: "01a03eb1-c193-7531-83c0-e6c6f70143d4", reportedTraexSessionAt: "2026-08-27T12:00:00.000Z" });

    await coordinator.start();
    const terminalReadsBeforePrompt = terminalReads;
    await coordinator.handleMessage({ eventId: "typed-e1", messageId: "typed-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "do typed work", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed" }));
    const answer = store.listRunCards("b1")[0]!.answer;
    expect(answer).toContain("Typed **analysis**");
    expect(answer).toContain("```bash\nnpm test\n```");
    expect(answer).toContain("```diff");
    expect(answer).not.toMatch(/fake terminal|misleading terminal/);
    expect(terminalReads - terminalReadsBeforePrompt).toBe(0);
    expect(records).toContainEqual(expect.objectContaining({ event: "turn-started", outputMode: "typed" }));

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("routes one typed observation to independent Answer and Main Card projections", async () => {
    let reads = 0;
    const transcriptReader: TraexTranscriptReaderPort = {
      async open() { return { mode: "typed", cursor: {
        async readDelta() { return ""; },
        async readObservation() {
          reads += 1;
          return reads === 1 ? {
            answerDelta: "Visible answer",
            mainStatus: { statusTitle: "Verifying deployment", tokenCount: 1_234, planSteps: [
              { key: "plan:0", label: "Run checks", state: "active" as const }
            ] }
          } : { answerDelta: "" };
        }
      } }; }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) { await onDispatched?.(); await onObservation?.({ state: "working", stateSource: "herdr", output: "ignored terminal" }); return "done"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const observed: Extract<BridgeEvent, { type: "TurnOutputObserved" }>[] = [];
    bus.onBridgeEvent("observation-test", (item) => { if (item.type === "TurnOutputObserved") observed.push(item); });
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", reportedTraexSessionId: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "split-e1", messageId: "split-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "split output", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed" }));
    expect(observed[0]?.payload.observation.answer).toMatchObject({ snapshot: "Visible answer", toolActivities: [] });
    expect(observed[0]?.payload.observation.main.status).toMatchObject({ statusTitle: "Verifying deployment", tokenCount: 1_234, planSteps: [{ key: "plan:0", kind: "step", state: "active" }] });
    expect(store.listRunCards("b1")[0]!.answer).toBe("Visible answer");

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("keeps terminal text out of the Answer when no session identity exists", async () => {
    const transcriptReader: TraexTranscriptReaderPort = {
      async open(session) {
        expect(session).toBeNull();
        return { mode: "unavailable", reason: "missing_session_identity" };
      }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, _onObservation, _signal, onDispatched) { await onDispatched?.(); return "done"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const { logger, records } = collectingLogger();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, logger, 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "terminal-e1", messageId: "terminal-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "terminal work", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed", answer: STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE }), { timeout: 4_000 });
    expect(store.listRunCards("b1")[0]!.answer).not.toContain("SECRET_TERMINAL_SENTINEL");
    expect(records).toContainEqual(expect.objectContaining({ event: "turn-started", outputMode: "unavailable", unavailableReason: "missing_session_identity" }));

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("waits for a first-turn session report before marking structured output unavailable", async () => {
    const sessionId = "01a04440-4348-78a1-ac78-60927a085826";
    let store!: SqliteBindingStore;
    const opens: Array<string | null> = [];
    const transcriptReader: TraexTranscriptReaderPort = {
      async open(session) {
        opens.push(session?.value ?? null);
        if (!session) {
          store.recordReportedTraexSession({ bindingId: "b1", paneId: "w1:p1", generation: 1, sessionId, reportedAt: "2026-08-27T17:24:41.778Z" });
          return { mode: "unavailable", reason: "missing_session_identity" };
        }
        expect(session).toEqual({ source: "bridge", agent: "traex", kind: "id", value: sessionId });
        let read = false;
        return { mode: "typed", cursor: { async readDelta() { if (read) return ""; read = true; return "authoritative JSONL answer"; } } };
      }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) {
        await onDispatched?.();
        await onObservation?.({ state: "working", stateSource: "herdr", output: "◆ ignored terminal text" });
        return "done";
      }, async renamePane() {}
    };
    store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const { logger, records } = collectingLogger();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, logger, 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "late-session-e1", messageId: "late-session-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "first turn", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed" }));

    expect(opens).toEqual([null, sessionId]);
    expect(store.listRunCards("b1")[0]!.answer).toBe("authoritative JSONL answer");
    expect(records).toContainEqual(expect.objectContaining({ event: "traex-transcript-source-upgraded", outcome: "typed" }));

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("waits for a first-turn transcript to appear after its session identity is known", async () => {
    const sessionId = "01a04440-4348-78a1-ac78-60927a085826";
    let opens = 0;
    const transcriptReader: TraexTranscriptReaderPort = {
      async open(session) {
        opens += 1;
        expect(session).toEqual({ source: "bridge", agent: "traex", kind: "id", value: sessionId });
        if (opens === 1) return { mode: "unavailable", reason: "transcript_not_found" };
        let read = false;
        return { mode: "typed", cursor: { async readDelta() { if (read) return ""; read = true; return "JSONL created after session report"; } } };
      }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) {
        await onDispatched?.();
        await onObservation?.({ state: "working", stateSource: "herdr", output: "◆ ignored terminal text" });
        return "done";
      }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const { logger, records } = collectingLogger();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, logger, 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", reportedTraexSessionId: sessionId });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "late-transcript-e1", messageId: "late-transcript-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "first turn", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed" }));

    expect(opens).toBe(2);
    expect(store.listRunCards("b1")[0]!.answer).toBe("JSONL created after session report");
    expect(records).toContainEqual(expect.objectContaining({ event: "traex-transcript-source-upgraded", outcome: "typed" }));

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("keeps terminal output out of the Answer when typed transcript reading fails", async () => {
    const transcriptReader: TraexTranscriptReaderPort = {
      async open() { return { mode: "typed", cursor: { async readDelta() { throw new Error("transcript unavailable"); } } }; }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) {
        await onDispatched?.();
        await onObservation?.({ state: "working", stateSource: "herdr", output: "◆ SECRET_TRANSCRIPT_FAILURE_TERMINAL" });
        return "done";
      }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const { logger, records } = collectingLogger();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, logger, 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", agentSessionSource: "bridge", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "fallback-e1", messageId: "fallback-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "fallback work", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed", answer: STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE }));
    expect(store.listRunCards("b1")[0]!.answer).not.toContain("SECRET_TRANSCRIPT_FAILURE_TERMINAL");
    expect(records).toContainEqual(expect.objectContaining({ event: "traex-transcript-read-failed", unavailableReason: "transcript_read_failed", outcome: "structured_output_unavailable" }));

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("ignores terminal redraws when structured output is unavailable", async () => {
    const transcriptReader: TraexTranscriptReaderPort = {
      async open() { return { mode: "unavailable", reason: "transcript_not_found" }; }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) {
        await onDispatched?.();
        await onObservation?.({ state: "working", stateSource: "herdr", output: `◆ ${"old terminal line\n".repeat(2500)}` });
        await onObservation?.({ state: "working", stateSource: "herdr", output: "◆ replacement terminal answer" });
        return "done";
      }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "redraw-e1", messageId: "redraw-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "redraw work", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed" }));
    const answer = store.listRunCards("b1")[0]!.answer;
    expect(answer).toBe(STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE);
    expect(answer).not.toContain("replacement terminal answer");

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("does not mix terminal text into an answer after typed output was established", async () => {
    let reads = 0;
    const transcriptReader: TraexTranscriptReaderPort = {
      async open() { return { mode: "typed", cursor: { async readDelta() { reads += 1; if (reads === 1) return "authoritative typed answer"; throw new Error("transcript interrupted"); } } }; }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation, _signal, onDispatched) {
        await onDispatched?.();
        await onObservation?.({ state: "working", stateSource: "herdr", output: "◆ first terminal screen" });
        await onObservation?.({ state: "working", stateSource: "herdr", output: "◆ terminal after typed failure" });
        return "done";
      }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const lark = quietLark();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const { logger, records } = collectingLogger();
    const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, logger, 30_000, undefined, undefined, transcriptReader);
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle", agentSessionSource: "bridge", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "01a03eb1-c193-7531-83c0-e6c6f70143d4" });

    await coordinator.start();
    await coordinator.handleMessage({ eventId: "mixed-e1", messageId: "mixed-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "typed then fail", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")[0]).toMatchObject({ phase: "completed", answer: "authoritative typed answer" }));
    expect(store.listRunCards("b1")[0]!.answer).not.toContain("terminal");
    expect(records).toContainEqual(expect.objectContaining({ event: "traex-transcript-read-failed", unavailableReason: "transcript_read_failed", outcome: "typed_output_preserved" }));

    await coordinator.stop(); await publisher.stop(); store.close();
  });
});

function fixture(herdr: HerdrPort, lark: LarkPort = quietLark()) {
  const store = new SqliteBindingStore(":memory:");
  const bus = new BridgeEventBus();
  const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
  const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
  return { coordinator, publisher, store, bus };
}

function emptyHerdr(): HerdrPort {
  return { async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {} };
}

function quietLark(): LarkPort {
  return { async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; }, async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {} };
}

function collectingLogger(): { logger: ReturnType<typeof pino>; records: Array<Record<string, unknown>> } {
  const records: Array<Record<string, unknown>> = [];
  const destination = { write(chunk: string) { records.push(JSON.parse(chunk) as Record<string, unknown>); } };
  return { logger: pino({ level: "trace" }, destination), records };
}

function message(index: number) {
  return { eventId: `e${index}`, messageId: `m${index}`, chatId: "chat", topicId: `m${index}`, rootMessageId: `m${index}`, actorOpenId: "user", text: "/swarm help", mentionsBot: true, isRootMessage: true };
}

function config(): BridgeConfig {
  return {
    lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
    herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" },
    projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }],
    defaultProjectId: "repo", projectsConfigPath: "test", traex: { executable: "traex", permissionMode: "auto", sessionsRoot: "/tmp/traex-sessions" }, databasePath: ":memory:",
    http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
  };
}
