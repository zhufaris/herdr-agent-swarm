import pino from "pino";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { TestConversationViewProjector as ConversationViewProjector } from "./helpers/create-test-conversation-view-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { InProcessPromptWorkScheduler } from "../src/events/prompt-work-scheduler.js";
import { primaryPresentation } from "./helpers/presentation.js";

const STRUCTURED_OUTPUT_UNAVAILABLE_NOTICE = "⚠️ 暂时无法读取 TraeX 结构化输出。任务可能仍在运行，请查看 Herdr pane。";

function queueLegacyPrompt(store: SqliteBindingStore, bindingId: string, scheduler: InProcessPromptWorkScheduler, messageId: string, body: string): void {
  const view = createQueuedRunCard({
    promptId: messageId, bindingId, bindingGeneration: 1, title: body,
    workspaceId: "w1", paneId: "w1:p1", requestText: body, queuePosition: 1,
    occurredAt: new Date().toISOString()
  });
  store.acceptPrompt({
    prompt: { id: messageId, bindingId, larkMessageId: messageId, ingressSource: "feishu", actorOpenId: "user", body },
    view, rootMessageId: "root-1", answerCard: {}
  });
  scheduler.wake({ kind: "prompt-ready", bindingId });
}

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
    async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"], terminalId: "terminal-1", agentSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" } }]; },
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
  const projector = new ConversationViewProjector(bus, store, publisher, publisher, logger, primaryPresentation); projector.start();
  const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, logger, 30_000, scheduler);
  await coordinator.start();
  const bindingId = store.findBindingByPane("w1:p1")!.id;
  const message = (id: string, text: string, hasUnsupportedContent = false) => ({ eventId: `event-${id}`, messageId: id, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false, hasUnsupportedContent });
  const send = (id: string, text: string, hasUnsupportedContent = false) => coordinator.handleMessage(message(id, text, hasUnsupportedContent));
  queueLegacyPrompt(store, bindingId, scheduler, "parent-message", "parent");
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
    const scheduler = new InProcessPromptWorkScheduler(logger);
    let cardNumber = 0;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text-1" }; },
      async replyCard() { cardNumber += 1; return { messageId: `card-${cardNumber}` }; },
      async updateCard() {}
    };
    let promptStarted = false;
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"], agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" } }]; },
      async getPane() { return { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: promptStarted ? "working" : "idle", foregroundExecutables: ["traex"], agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, ...(promptStarted ? { activeTurnId: "runtime-1" } : {}) }; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, text, _timeoutMs, onObservation) {
        promptStarted = true;
        turns.push(text);
        await onObservation?.({ state: "working", stateSource: "structured", output, turnId: "runtime-1", turnStartedAt: "2026-09-05T00:00:00.000Z" });
        await hold;
        output += "\n◆ parent answer\n────────";
        await onObservation?.({ state: "done", stateSource: "structured", output });
        promptStarted = false;
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
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation);
    projector.start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, logger, 30_000, scheduler);
    await coordinator.start();
    const bindingId = store.findBindingByPane("w1:p1")!.id;
    const message = (n: number, text: string) => ({ eventId: `e${n}`, messageId: `m${n}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false });

    queueLegacyPrompt(store, bindingId, scheduler, "m1", "parent");
    await vi.waitFor(() => expect(store.listRunCards(bindingId)[0]).toMatchObject({ phase: "running" }));
    store.updateBinding(bindingId, { agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
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
    await vi.waitFor(() => expect(escapes).toEqual(["w1:p1"]));
    await publisher.drain();
    expect(store.database.prepare("SELECT kind, state FROM turn_control_operations").all()).toEqual([expect.objectContaining({ kind: "interrupt", state: "dispatching" })]);
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
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"], terminalId: "terminal-1", agentSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" } }]; },
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
    const logger = pino({ enabled: false });
    const scheduler = new InProcessPromptWorkScheduler(logger);
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, logger, 30_000, scheduler); await coordinator.start();
    const bindingId = store.findBindingByPane("w1:p1")!.id;
    const message = (n: number, text: string) => ({ eventId: `e${n}`, messageId: `m${n}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false });

    queueLegacyPrompt(store, bindingId, scheduler, "m1", "parent");
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
    const logger = pino({ enabled: false });
    const scheduler = new InProcessPromptWorkScheduler(logger);
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, logger, 30_000, scheduler); await coordinator.start();
    const bindingId = store.findBindingByPane("w1:p1")!.id;
    const send = (n: number, text: string) => coordinator.handleMessage({ eventId: `approval-e${n}`, messageId: `approval-m${n}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false });

    queueLegacyPrompt(store, bindingId, scheduler, "approval-m1", "parent");
    await vi.waitFor(() => expect(store.findBindingByPane("w1:p1")).toMatchObject({ lastAgentState: "blocked" }));
    await send(2, "/swarm steer continue");
    expect(store.database.prepare("SELECT state FROM pane_control_operations WHERE payload = 'continue'").get()).toBeUndefined();
    expect(steering).not.toHaveBeenCalled();

    release();
    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("submits ordinary input independently while a legacy turn is blocked", async () => {
    let output = "initial";
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const turns: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text-1" }; }, async replyCard() { return { messageId: `card-${Math.random()}` }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"], terminalId: "terminal-1", agentSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" } }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, text, _timeoutMs, onObservation) {
        turns.push(text);
        if (turns.length === 1) { await onObservation?.({ state: "blocked", stateSource: "structured", output }); await hold; }
        output += `\n◆ answer ${turns.length}\n────────`;
        await onObservation?.({ state: "done", stateSource: "structured", output });
        return "done";
      },
      async sendEscape() {}, async renamePane() {}
    };
    const config = { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", allowedOpenIds: ["u1", "u2", "creator", "user", "user-1"], adminOpenIds: ["u1", "u2", "creator", "user", "user-1"] }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "default", displayName: "Default project", description: "Test project", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500 } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:"); const bus = new BridgeEventBus();
    const logger = pino({ enabled: false });
    const scheduler = new InProcessPromptWorkScheduler(logger);
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, logger, 30_000, scheduler); await coordinator.start();
    const bindingId = store.findBindingByPane("w1:p1")!.id;
    const send = (n: number, text: string) => coordinator.handleMessage({ eventId: `blocked-e${n}`, messageId: `blocked-m${n}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false });

    queueLegacyPrompt(store, bindingId, scheduler, "blocked-m1", "parent");
    await vi.waitFor(() => expect(store.findBindingByPane("w1:p1")).toMatchObject({ lastAgentState: "blocked" }));
    await send(2, "later turn");
    expect(store.database.prepare("SELECT text, state FROM submission_intents WHERE source_message_key = ?").get("blocked-m2")).toEqual({ text: "later turn", state: "prepared" });
    const pendingBeforeStop = store.countPendingPrompts(bindingId);
    expect(turns).toEqual(["parent"]);
    expect(store.countPendingPrompts(bindingId)).toBe(pendingBeforeStop);
    release();
    await vi.waitFor(() => expect(store.getPrompt("blocked-m1")?.state).toBe("delivered"));
    expect(turns).toEqual(["parent"]);

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });
});

describe("ordinary continuation messages", () => {
  it("submits an eligible continuation independently while a legacy turn is active", async () => {
    const harness = await createAutomaticSteeringHarness();
    await harness.send("auto-message", "继续");
    expect(harness.store.database.prepare("SELECT source_message_key, text, owner_id, state FROM submission_intents WHERE source_message_key = ?").get("auto-message")).toEqual({
      source_message_key: "auto-message", text: "继续", owner_id: harness.bindingId, state: "prepared"
    });
    expect(harness.store.getPromptInputBySource("feishu", "auto-message")).toBeNull();
    expect(harness.schedulerWake.mock.calls.filter(([hint]) => hint.kind === "prompt-ready")).toHaveLength(0);
    await harness.close();
  });

  it.each([
    ["ambiguous new work", "修复另一个问题", false],
    ["unsupported rich content", "继续", true]
  ])("keeps %s as unchanged Agent Input", async (_label, text, hasUnsupportedContent) => {
    const harness = await createAutomaticSteeringHarness();
    const messageId = `ordinary-${_label.replaceAll(" ", "-")}`;
    await harness.send(messageId, text, hasUnsupportedContent);
    expect(harness.store.database.prepare("SELECT text, state FROM submission_intents WHERE source_message_key = ?").get(messageId)).toEqual({ text, state: "prepared" });
    expect(harness.store.getPromptInputBySource("feishu", messageId)).toBeNull();
    await harness.close();
  });

  it("routes non-reserved slash text as Agent Input", async () => {
    const harness = await createAutomaticSteeringHarness();
    await harness.send("instances-message", "/instances");
    expect(harness.store.database.prepare("SELECT text, state FROM submission_intents WHERE source_message_key = ?").get("instances-message")).toEqual({ text: "/instances", state: "prepared" });
    await harness.close();
  });

  it("preserves one durable Submission Intent for duplicate delivery", async () => {
    const harness = await createAutomaticSteeringHarness();
    const duplicate = harness.message("duplicate-message", "继续");
    await harness.coordinator.handleMessage(duplicate);
    await harness.coordinator.handleMessage(duplicate);
    const rows = harness.store.database.prepare("SELECT submission_id, text, state FROM submission_intents WHERE source_message_key = ?").all(duplicate.messageId);
    expect(rows).toEqual([{ submission_id: expect.any(String), text: "继续", state: "prepared" }]);
    await harness.close();
  });

  it("does not defer Agent Input when legacy Prompt capacity is full", async () => {
    const harness = await createAutomaticSteeringHarness(1);
    await harness.send("full-message", "继续");
    expect(harness.store.database.prepare("SELECT state FROM inbound_messages WHERE event_id = ?").get("event-full-message")).toEqual({ state: "accepted" });
    expect(harness.store.database.prepare("SELECT text, state FROM submission_intents WHERE source_message_key = ?").get("full-message")).toEqual({ text: "继续", state: "prepared" });
    await harness.close();
  });

});
