import pino from "pino";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { ConversationViewProjector } from "../src/events/conversation-view-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { InProcessPromptWorkScheduler } from "../src/events/prompt-work-scheduler.js";

const STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE = "⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。";

async function createAutomaticSteeringHarness(maxQueueDepth = 20) {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const turns: string[] = [];
  const info = vi.fn();
  const error = vi.fn();
  const warn = vi.fn();
  const replyCard = vi.fn(async () => ({ messageId: `card-${Math.random()}` }));
  const logger = { info, warn, error, debug: vi.fn() } as unknown as Logger;
  const lark: LarkPort = {
    async start() {}, async stop() {}, isReady: () => true,
    async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
    async replyText() { return { messageId: "text-1" }; },
    replyCard,
    async updateCard() {}
  };
  const herdr: HerdrPort = {
    async assertWorkspace() {},
    async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
    async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
    async runPrompt(_paneId, text, _timeoutMs, onObservation, _signal, onDispatched) {
      turns.push(text);
      onDispatched?.();
      await onObservation?.({ state: "working", stateSource: "structured", output: "working" });
      if (turns.length === 1) await hold;
      await onObservation?.({ state: "done", stateSource: "structured", output: "◆ done\n────────" });
      return "done";
    },
    async sendEscape() {}, async renamePane() {}
  };
  const config = { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", allowedOpenIds: ["u1", "u2", "creator", "user", "user-1"], adminOpenIds: ["u1", "u2", "creator", "user", "user-1"] }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "default", displayName: "Default project", description: "Test project", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth, larkMessageChunkSize: 3500 } as const satisfies BridgeConfig;
  const store = new SqliteBindingStore(":memory:");
  const bus = new BridgeEventBus();
  const bridgeEvents: Array<{ type: string; payload: unknown }> = [];
  bus.onBridgeEvent("automatic-steering-test", (event) => { bridgeEvents.push(event); });
  const scheduler = new InProcessPromptWorkScheduler(logger);
  const schedulerWake = vi.spyOn(scheduler, "wake");
  const publisher = createTestPublisher(store, lark, logger); publisher.start();
  const projector = new ConversationViewProjector(bus, store, publisher, publisher, logger); projector.start();
  const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, logger, 30_000, scheduler);
  await coordinator.start();
  const bindingId = store.findBindingByPane("w1:p1")!.id;
  const message = (id: string, text: string, hasUnsupportedContent = false) => ({ eventId: `event-${id}`, messageId: id, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false, hasUnsupportedContent });
  const send = (id: string, text: string, hasUnsupportedContent = false) => coordinator.handleMessage(message(id, text, hasUnsupportedContent));
  await send("parent-message", "parent");
  await vi.waitFor(() => expect(store.findBindingByPane("w1:p1")).toMatchObject({ lastAgentState: "working" }));
  const parent = store.listRunCards(bindingId)[0]!;
  schedulerWake.mockClear();
  return { bindingId, bridgeEvents, bus, coordinator, error, info, message, parent, projector, publisher, release, replyCard, schedulerWake, send, store, turns, warn, async close() { release(); await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close(); } };
}

describe("active-turn steering", () => {
  it("rejects explicit steering without terminal input and preserves queued work", async () => {
    let output = "initial";
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const turns: string[] = [];
    const steering: string[] = [];
    const escapes: string[] = [];
    const info = vi.fn();
    const logger = { info, warn: vi.fn(), error: vi.fn(), debug: vi.fn() } as unknown as Logger;
    let cardNumber = 0;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text-1" }; },
      async replyCard() { cardNumber += 1; return { messageId: `card-${cardNumber}` }; },
      async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"], agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" } }]; },
      async getPane() { return { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "working", foregroundExecutables: ["traex"], agentSession: { source: "herdr-traex-shim", agent: "traex", kind: "id", value: "session-1" }, activeTurnId: "runtime-1" }; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, text, _timeoutMs, onObservation) {
        turns.push(text);
        await onObservation?.({ state: "working", stateSource: "structured", output, turnId: "runtime-1", turnStartedAt: "2026-09-05T00:00:00.000Z" });
        await hold;
        output += "\n◆ parent answer\n────────";
        await onObservation?.({ state: "done", stateSource: "structured", output });
        return "done";
      },
      async interruptAgent(input) { escapes.push(input.paneId); return { status: "interrupted" }; }, async renamePane() {}
    };
    const config = {
      lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", allowedOpenIds: ["u1", "u2", "creator", "user", "user-1"], adminOpenIds: ["u1", "u2", "creator", "user", "user-1"] },
      herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" },
      projects: [{ id: "default", displayName: "Default project", description: "Test project", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" },
      databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent",
      commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
    } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false }));
    publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }));
    projector.start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, logger);
    await coordinator.start();
    const bindingId = store.findBindingByPane("w1:p1")!.id;
    const message = (n: number, text: string) => ({ eventId: `e${n}`, messageId: `m${n}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false });

    await coordinator.handleMessage(message(1, "parent"));
    await vi.waitFor(() => expect(store.listRunCards(bindingId)[0]).toMatchObject({ phase: "running" }));
    store.updateBinding(bindingId, { agentSessionSource: "herdr-traex-shim", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    let activePrompt = store.getActiveOrdinaryPrompt(bindingId, 1)!;
    if (!activePrompt.dispatchedAt) { store.markPromptDispatched(activePrompt.id, new Date().toISOString()); activePrompt = store.getPrompt(activePrompt.id)!; }
    if (!activePrompt.transcriptTurnId) store.claimPromptTranscriptTurn({ promptId: activePrompt.id, bindingId, turnId: "runtime-1", startedAt: new Date(Date.parse(activePrompt.dispatchedAt!) + 250).toISOString() });
    expect(store.getBinding(bindingId)).toMatchObject({ agentSessionValue: "session-1" });
    expect(store.getActiveOrdinaryPrompt(bindingId, 1)).toMatchObject({ transcriptTurnId: "runtime-1" });
    const runningModel = store.acceptPaneControlOperation({ id: "running-model", idempotencyKey: "test:running-model", bindingId, paneId: "w1:p1", terminalId: null, bindingGeneration: 1, kind: "model", actorOpenId: "user", sourceMessageId: "model-message" });
    expect(store.claimPaneControlOperation(runningModel.operation.id)).toMatchObject({ state: "running" });
    const queued = createQueuedRunCard({ promptId: "queued-turn", bindingId, title: "queued turn", workspaceId: "w1", paneId: "w1:p1", requestText: "queued turn", queuePosition: 1, occurredAt: new Date().toISOString() });
    store.acceptPrompt({ prompt: { id: "queued-turn", bindingId, larkMessageId: "queued-message", actorOpenId: "user", body: "queued turn" }, view: queued, rootMessageId: "root-1", answerCard: {} });
    await publisher.drain();
    await coordinator.handleMessage(message(4, "/swarm stop"));
    expect(store.database.prepare("SELECT kind, state FROM turn_control_operations").all()).toEqual([expect.objectContaining({ kind: "interrupt", state: "delivered" })]);
    await vi.waitFor(() => expect(escapes).toEqual(["w1:p1"]));
    store.finishPaneControlOperation(runningModel.operation.id, "confirmed");
    expect(store.listRunCards(bindingId).some((view) => view.requestText === "/swarm stop")).toBe(false);
    await Promise.all([coordinator.handleMessage(message(2, "/swarm steer steer one")), coordinator.handleMessage(message(3, "/swarm steer steer two"))]);
    expect(steering).toEqual([]);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM pane_control_operations WHERE kind = 'steer'").get()).toEqual({ count: 0 });
    await coordinator.handleMessage(message(2, "/swarm steer steer one"));
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM pane_control_operations WHERE kind = 'steer'").get()).toEqual({ count: 0 });
    expect(JSON.stringify(info.mock.calls)).not.toContain("steer one");

    expect(turns).toHaveLength(1);
    expect(turns[0]).toBe("parent");
    expect(escapes).toEqual(["w1:p1"]);
    expect(store.listQueuedTurnPromptIds(bindingId)).toEqual(["queued-turn"]);
    expect(steering).toEqual([]);
    release();
    await vi.waitFor(() => expect(store.listRunCards(bindingId)[0]).toMatchObject({ phase: "completed", answer: STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE }));
    await vi.waitFor(() => expect(turns).toEqual(["parent", "queued turn"]));

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("fails an uninjectable /swarm steer instead of converting it into an ordinary turn", async () => {
    let output = "initial";
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const turns: string[] = [];
    const steering: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text-1" }; }, async replyCard() { return { messageId: `card-${Math.random()}` }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, text, _timeoutMs, onObservation) {
        turns.push(text);
        await onObservation?.({ state: "working", stateSource: "structured", output });
        await hold;
        output += "\n◆ parent answer\n────────";
        await onObservation?.({ state: "done", stateSource: "structured", output });
        return "done";
      },
      async sendEscape() {}, async renamePane() {}
    };
    const config = { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", allowedOpenIds: ["u1", "u2", "creator", "user", "user-1"], adminOpenIds: ["u1", "u2", "creator", "user", "user-1"] }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "default", displayName: "Default project", description: "Test project", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500 } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:"); const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false })); await coordinator.start();
    const bindingId = store.findBindingByPane("w1:p1")!.id;
    const message = (n: number, text: string) => ({ eventId: `e${n}`, messageId: `m${n}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false });

    await coordinator.handleMessage(message(1, "parent"));
    await vi.waitFor(() => expect(store.listRunCards(bindingId)[0]).toMatchObject({ phase: "running" }));
    await coordinator.handleMessage(message(2, "/swarm steer late steer"));
    expect(steering).toEqual([]);
    expect(store.database.prepare("SELECT state FROM pane_control_operations WHERE payload = 'late steer'").get()).toBeUndefined();
    // Never promoted to an ordinary turn, before or after the parent finishes.
    expect(store.listQueuedTurnPromptIds(bindingId)).toEqual([]);
    release();
    await vi.waitFor(() => expect(store.listRunCards(bindingId)[0]).toMatchObject({ phase: "completed" }));
    expect(turns).toEqual(["parent"]);
    expect(store.listQueuedTurnPromptIds(bindingId)).toEqual([]);

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("rejects /swarm steer on a local approval screen without injecting text", async () => {
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const steering = vi.fn();
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text-1" }; }, async replyCard() { return { messageId: `card-${Math.random()}` }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation) { await onObservation?.({ state: "blocked", stateSource: "structured", output: "❯ needs approval" }); await hold; return "done"; },
      async sendEscape() {}, async renamePane() {}
    };
    const config = { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", allowedOpenIds: ["u1", "u2", "creator", "user", "user-1"], adminOpenIds: ["u1", "u2", "creator", "user", "user-1"] }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "default", displayName: "Default project", description: "Test project", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500 } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:"); const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false })); await coordinator.start();
    const send = (n: number, text: string) => coordinator.handleMessage({ eventId: `approval-e${n}`, messageId: `approval-m${n}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false });

    await send(1, "parent");
    await vi.waitFor(() => expect(store.findBindingByPane("w1:p1")).toMatchObject({ lastAgentState: "blocked" }));
    await send(2, "/swarm steer continue");
    expect(store.database.prepare("SELECT state FROM pane_control_operations WHERE payload = 'continue'").get()).toBeUndefined();
    expect(steering).not.toHaveBeenCalled();

    release();
    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("keeps messages FIFO while the active turn is blocked", async () => {
    let output = "initial";
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const turns: string[] = [];
    const steering: string[] = [];
    const escapes: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text-1" }; }, async replyCard() { return { messageId: `card-${Math.random()}` }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, text, _timeoutMs, onObservation) {
        turns.push(text);
        if (turns.length === 1) { await onObservation?.({ state: "blocked", stateSource: "structured", output }); await hold; }
        output += `\n◆ answer ${turns.length}\n────────`;
        await onObservation?.({ state: "done", stateSource: "structured", output });
        return "done";
      },
      async sendEscape(paneId) { escapes.push(paneId); }, async renamePane() {}
    };
    const config = { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", allowedOpenIds: ["u1", "u2", "creator", "user", "user-1"], adminOpenIds: ["u1", "u2", "creator", "user", "user-1"] }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "default", displayName: "Default project", description: "Test project", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500 } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:"); const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false })); await coordinator.start();
    const send = (n: number, text: string) => coordinator.handleMessage({ eventId: `blocked-e${n}`, messageId: `blocked-m${n}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false });

    await send(1, "parent");
    await vi.waitFor(() => expect(store.findBindingByPane("w1:p1")).toMatchObject({ lastAgentState: "blocked" }));
    await send(2, "later turn");
    const pendingBeforeStop = store.countPendingPrompts(store.findBindingByPane("w1:p1")!.id);
    await send(3, "/swarm stop");
    await send(4, "/swarm steer capacity queue status");
    expect(steering).toEqual([]);
    await send(5, "/swarm stop");
    expect(steering).toEqual([]);
    expect(escapes).toEqual([]); expect(turns).toEqual(["parent"]);
    expect(store.countPendingPrompts(store.findBindingByPane("w1:p1")!.id)).toBe(pendingBeforeStop);
    expect(store.listRunCards(store.findBindingByPane("w1:p1")!.id).some((view) => view.requestText === "/swarm stop")).toBe(false);
    release();
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1]).toBe("later turn");

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });
});

describe("automatic continuation steering", () => {
  it("wakes durable ordinary work before queued-card projection completes", async () => {
    const harness = await createAutomaticSteeringHarness();
    harness.release();
    await vi.waitFor(() => expect(harness.store.getPrompt(harness.parent.promptId)?.state).toBe("delivered"));
    await harness.publisher.stop();
    harness.schedulerWake.mockClear();
    let releaseProjection!: () => void;
    const projectionBlocked = new Promise<void>((resolve) => { releaseProjection = resolve; });
    let projectionStarted!: () => void;
    const projectionEntered = new Promise<void>((resolve) => { projectionStarted = resolve; });
    const unsubscribe = harness.bus.onBridgeEvent("blocked-queue-projection", async (event) => {
      if (event.type !== "PromptQueued") return;
      projectionStarted();
      await projectionBlocked;
    });

    const handling = harness.send("nonblocking-dispatch", "investigate another issue");
    await projectionEntered;

    const prompt = harness.store.database.prepare("SELECT id, state FROM prompt_jobs WHERE lark_message_id = ?").get("nonblocking-dispatch") as { id: string; state: string };
    expect(["queued", "running"]).toContain(prompt.state);
    expect(harness.store.database.prepare("SELECT kind, state FROM outbound_replies WHERE prompt_id = ? AND kind = 'stream_card_create'").get(prompt.id)).toEqual({ kind: "stream_card_create", state: "pending" });
    expect(harness.schedulerWake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: harness.bindingId });
    await vi.waitFor(() => expect(harness.turns).toContain("investigate another issue"));

    releaseProjection();
    await handling;
    unsubscribe();
    await harness.close();
  });

  it("keeps an eligible continuation as ordinary FIFO work", async () => {
    const harness = await createAutomaticSteeringHarness();
    await harness.send("auto-message", "继续");
    expect(harness.store.getPrompt(harness.store.listRunCards(harness.bindingId).find((view) => view.requestText === "继续")!.promptId)).toMatchObject({
      dispatchKind: "turn", parentPromptId: null, steeringOrigin: null
    });
    expect(harness.schedulerWake.mock.calls.filter(([hint]) => hint.kind === "steering-ready")).toHaveLength(0);
    expect(harness.schedulerWake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: harness.bindingId });
    expect(harness.store.loadQueueFeedbackInputs(harness.bindingId).queued.every((view) => view.steeringOrigin === null)).toBe(true);
    await harness.close();
  });

  it.each([
    ["ambiguous new work", "修复另一个问题", false, "not_allowlisted"],
    ["unsupported rich content", "继续", true, "unsupported_content"]
  ])("keeps %s as an ordinary FIFO turn", async (_label, text, hasUnsupportedContent, reason) => {
    const harness = await createAutomaticSteeringHarness();
    await harness.send(`ordinary-${reason}`, text, hasUnsupportedContent);
    const prompt = harness.store.getPrompt(harness.store.listRunCards(harness.bindingId).find((view) => view.requestText === text)!.promptId);
    expect(prompt).toMatchObject({ dispatchKind: "turn", parentPromptId: null, steeringOrigin: null });
    expect(harness.schedulerWake.mock.calls.filter(([hint]) => hint.kind === "steering-ready")).toHaveLength(0);
    expect(harness.schedulerWake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: harness.bindingId });
    expect(harness.info.mock.calls).toContainEqual([expect.objectContaining({ event: "auto-steering-classified", outcome: "ordinary", reason }), "classified continuation message"]);
    await harness.close();
  });

  it("retains /instances command semantics instead of classifying it as a prompt", async () => {
    const harness = await createAutomaticSteeringHarness();
    await harness.send("instances-message", "/instances");
    expect(harness.store.listRunCards(harness.bindingId).map((view) => view.requestText)).toEqual(["parent"]);
    expect(harness.schedulerWake.mock.calls.filter(([hint]) => hint.kind === "prompt-ready" || hint.kind === "steering-ready")).toHaveLength(0);
    expect(harness.info.mock.calls.some(([record]) => record.event === "auto-steering-classified" && record.messageId === "instances-message")).toBe(false);
    await harness.close();
  });

  it("preserves one durable ordinary decision and one scheduler wake for duplicate delivery", async () => {
    const harness = await createAutomaticSteeringHarness();
    const duplicate = harness.message("duplicate-message", "继续");
    await harness.coordinator.handleMessage(duplicate);
    await harness.coordinator.handleMessage(duplicate);
    const rows = harness.store.database.prepare("SELECT id, dispatch_kind, parent_prompt_id, steering_origin FROM prompt_jobs WHERE lark_message_id = ?").all(duplicate.messageId);
    expect(rows).toEqual([{ id: expect.any(String), dispatch_kind: "turn", parent_prompt_id: null, steering_origin: null }]);
    expect(harness.schedulerWake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: harness.bindingId });
    expect(harness.schedulerWake.mock.calls.filter(([hint]) => hint.kind === "steering-ready")).toHaveLength(0);
    await harness.close();
  });

  it("rejects an eligible continuation when the ordinary queue is full", async () => {
    const harness = await createAutomaticSteeringHarness(1);
    expect(harness.store.countPendingPrompts(harness.bindingId)).toBe(1);
    await harness.send("full-auto-message", "继续");
    expect(harness.store.listRunCards(harness.bindingId).map((view) => view.requestText)).toEqual(["parent"]);
    expect(harness.schedulerWake.mock.calls.filter(([hint]) => hint.kind === "prompt-ready" || hint.kind === "steering-ready")).toHaveLength(0);
    await harness.close();
  });

  it("rejects ambiguous ordinary work when the queue is full", async () => {
    const harness = await createAutomaticSteeringHarness(1);
    await harness.send("full-ordinary-message", "修复另一个问题");
    expect(harness.store.listRunCards(harness.bindingId).map((view) => view.requestText)).toEqual(["parent"]);
    expect(harness.store.countPendingPrompts(harness.bindingId)).toBe(1);
    expect(harness.schedulerWake.mock.calls.filter(([hint]) => hint.kind === "prompt-ready" || hint.kind === "steering-ready")).toHaveLength(0);
    await harness.close();
  });

  it("rejects an eligible continuation when its full-queue parent invalidates before acceptance", async () => {
    const harness = await createAutomaticSteeringHarness(1);
    const eventsBefore = harness.bridgeEvents.length;
    const auditsBefore = Number((harness.store.database.prepare("SELECT COUNT(*) AS count FROM audit_log").get() as { count: number }).count);
    harness.replyCard.mockClear();
    const acceptClassifiedPrompt = harness.store.acceptClassifiedPrompt.bind(harness.store);
    vi.spyOn(harness.store, "acceptClassifiedPrompt").mockImplementation((input) => {
      harness.store.markPromptObservationDetached(harness.parent.promptId, "test race");
      return acceptClassifiedPrompt(input);
    });
    await harness.send("full-fallback-message", "继续");
    await vi.waitFor(() => expect(harness.replyCard).toHaveBeenCalledTimes(1));
    expect(harness.store.listRunCards(harness.bindingId).map((view) => view.requestText)).toEqual(["parent"]);
    expect(harness.store.countPendingPrompts(harness.bindingId)).toBe(1);
    expect(harness.schedulerWake.mock.calls.filter(([hint]) => hint.kind === "prompt-ready" || hint.kind === "steering-ready")).toHaveLength(0);
    expect(harness.bridgeEvents).toHaveLength(eventsBefore);
    expect(harness.store.database.prepare("SELECT COUNT(*) AS count FROM audit_log").get()).toEqual({ count: auditsBefore });
    expect(harness.error.mock.calls.some(([record]) => record.event === "lark-message-handling-failed")).toBe(false);
    expect(harness.info.mock.calls).toContainEqual([expect.objectContaining({ event: "auto-steering-classified", outcome: "queue_full", reason: "no_candidate" }), "classified continuation message"]);
    expect(harness.info.mock.calls).toContainEqual([expect.objectContaining({ event: "lark-message-accepted", messageId: "full-fallback-message", disposition: "rejected" }), "completed durable inbound handling"]);
    await harness.close();
  });

});
