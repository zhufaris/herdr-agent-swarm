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

const TERMINAL_FALLBACK_WARNING = "> ⚠️ 未能读取 TraeX JSONL，以下内容来自 Herdr pane fallback，可能缺少工具调用结构或完整上下文。";

async function createAutomaticSteeringHarness(maxQueueDepth = 20, steeringResult: "injected" | "not_working" | "throw" = "injected") {
  let release!: () => void;
  const hold = new Promise<void>((resolve) => { release = resolve; });
  const turns: string[] = [];
  const steering: string[] = [];
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
    async steerPrompt(_paneId, text) { steering.push(text); if (steeringResult === "throw") throw new Error("delivery unavailable"); return steeringResult; },
    async sendEscape() {}, async readOutput() { return "working"; }, async renamePane() {}
  };
  const config = { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "default", displayName: "Default project", description: "Test project", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth, larkMessageChunkSize: 3500 } as const satisfies BridgeConfig;
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
  return { bindingId, bridgeEvents, coordinator, error, info, message, parent, projector, publisher, release, replyCard, schedulerWake, send, steering, store, turns, warn, async close() { release(); await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close(); } };
}

describe("active-turn steering", () => {
  it("injects ordered steering into one active waiter and keeps final output on the parent card", async () => {
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
      async steerPrompt(_paneId, text) {
        steering.push(text);
        return "injected";
      },
      async sendEscape(paneId) { escapes.push(paneId); },
      async readOutput() { return output; }, async renamePane() {}
    };
    const config = {
      lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
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
    const runningModel = store.acceptPaneControlOperation({ id: "running-model", idempotencyKey: "test:running-model", bindingId, paneId: "w1:p1", terminalId: null, bindingGeneration: 1, kind: "model", actorOpenId: "user", sourceMessageId: "model-message" });
    expect(store.claimPaneControlOperation(runningModel.operation.id)).toMatchObject({ state: "running" });
    const queued = createQueuedRunCard({ promptId: "queued-turn", bindingId, title: "queued turn", workspaceId: "w1", paneId: "w1:p1", requestText: "queued turn", queuePosition: 1, occurredAt: new Date().toISOString() });
    store.acceptPrompt({ prompt: { id: "queued-turn", bindingId, larkMessageId: "queued-message", actorOpenId: "user", body: "queued turn" }, view: queued, rootMessageId: "root-1", answerCard: {} });
    await publisher.drain();
    await coordinator.handleMessage(message(4, "/swarm stop"));
    await vi.waitFor(() => expect(escapes).toEqual(["w1:p1"]));
    store.finishPaneControlOperation(runningModel.operation.id, "confirmed");
    expect(store.listRunCards(bindingId).some((view) => view.requestText === "/swarm stop")).toBe(false);
    await Promise.all([coordinator.handleMessage(message(2, "/swarm steer steer one")), coordinator.handleMessage(message(3, "/swarm steer steer two"))]);
    await vi.waitFor(() => expect(steering).toEqual(["steer one", "steer two"]));
    await vi.waitFor(() => expect(["steer one", "steer two"].every((text) => store.database.prepare("SELECT state FROM pane_control_operations WHERE payload = ?").get(text)?.state === "confirmed")).toBe(true));
    await coordinator.handleMessage(message(2, "/swarm steer steer one"));
    expect(steering).toEqual(["steer one", "steer two"]);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM pane_control_operations WHERE kind = 'steer' AND state = 'confirmed'").get()).toEqual({ count: 2 });
    expect(JSON.stringify(info.mock.calls)).not.toContain("steer one");

    expect(turns).toHaveLength(1);
    expect(turns[0]).toBe("parent");
    expect(escapes).toEqual(["w1:p1"]);
    expect(store.listQueuedTurnPromptIds(bindingId)).toEqual(["queued-turn"]);
    expect(steering).toEqual(["steer one", "steer two"]);
    release();
    await vi.waitFor(() => expect(store.listRunCards(bindingId)[0]).toMatchObject({ phase: "completed", answer: `${TERMINAL_FALLBACK_WARNING}\n\n◆ parent answer` }));
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
      async steerPrompt(_paneId, text) { steering.push(text); return "not_working"; },
      async sendEscape() {},
      async readOutput() { return output; }, async renamePane() {}
    };
    const config = { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "default", displayName: "Default project", description: "Test project", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500 } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:"); const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false })); await coordinator.start();
    const bindingId = store.findBindingByPane("w1:p1")!.id;
    const message = (n: number, text: string) => ({ eventId: `e${n}`, messageId: `m${n}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false });

    await coordinator.handleMessage(message(1, "parent"));
    await vi.waitFor(() => expect(store.listRunCards(bindingId)[0]).toMatchObject({ phase: "running" }));
    await coordinator.handleMessage(message(2, "/swarm steer late steer"));
    await vi.waitFor(() => expect(steering).toEqual(["late steer"]));
    await vi.waitFor(() => expect(store.database.prepare("SELECT state FROM pane_control_operations WHERE payload = 'late steer'").get()).toEqual({ state: "rejected" }));
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
      async steerPrompt() { steering(); return "injected"; }, async sendEscape() {},
      async readOutput() { return "❯ Approval required: allow this action?"; }, async renamePane() {}
    };
    const config = { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "default", displayName: "Default project", description: "Test project", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500 } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:"); const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false })); await coordinator.start();
    const send = (n: number, text: string) => coordinator.handleMessage({ eventId: `approval-e${n}`, messageId: `approval-m${n}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false });

    await send(1, "parent");
    await vi.waitFor(() => expect(store.findBindingByPane("w1:p1")).toMatchObject({ lastAgentState: "blocked" }));
    await send(2, "/swarm steer continue");
    await vi.waitFor(() => expect(store.database.prepare("SELECT state FROM pane_control_operations WHERE payload = 'continue'").get()).toEqual({ state: "rejected" }));
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
      async steerPrompt(_paneId, text) { steering.push(text); return "injected"; },
      async sendEscape(paneId) { escapes.push(paneId); },
      async readOutput() { return output; }, async renamePane() {}
    };
    const config = { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "default", displayName: "Default project", description: "Test project", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500 } as const satisfies BridgeConfig;
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
    await vi.waitFor(() => expect(steering).toEqual(["capacity queue status"]));
    await send(5, "/swarm stop");
    await vi.waitFor(() => expect(steering).toEqual(["capacity queue status"]));
    expect(escapes).toEqual(["w1:p1", "w1:p1"]); expect(turns).toEqual(["parent"]);
    expect(store.countPendingPrompts(store.findBindingByPane("w1:p1")!.id)).toBe(pendingBeforeStop);
    expect(store.listRunCards(store.findBindingByPane("w1:p1")!.id).some((view) => view.requestText === "/swarm stop")).toBe(false);
    release();
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1]).toBe("later turn");

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });
});

describe("automatic continuation steering", () => {
  it("routes an eligible continuation to the active parent", async () => {
    const harness = await createAutomaticSteeringHarness();
    await harness.send("auto-message", "继续");
    expect(harness.store.getPrompt(harness.store.listRunCards(harness.bindingId).find((view) => view.requestText === "继续")!.promptId)).toMatchObject({
      dispatchKind: "steering", parentPromptId: harness.parent.promptId, steeringOrigin: "automatic"
    });
    expect(harness.schedulerWake.mock.calls.map(([hint]) => hint)).not.toContainEqual({ kind: "prompt-ready", bindingId: harness.bindingId });
    expect(harness.schedulerWake).toHaveBeenCalledWith({ kind: "steering-ready", bindingId: harness.bindingId, parentPromptId: harness.parent.promptId });
    expect(harness.store.loadQueueFeedbackInputs(harness.bindingId).queued.every((view) => view.steeringOrigin === null)).toBe(true);
    await vi.waitFor(() => expect(harness.steering).toEqual(["继续"]));
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
    expect(harness.steering).toEqual([]);
    expect(harness.info.mock.calls).toContainEqual([expect.objectContaining({ event: "auto-steering-classified", outcome: "ordinary", reason }), "classified continuation message"]);
    await harness.close();
  });

  it.each([
    ["stale parent", "parent_stale", (harness: Awaited<ReturnType<typeof createAutomaticSteeringHarness>>) => {
      harness.store.database.prepare("UPDATE run_cards SET activity_at = ? WHERE prompt_id = ?").run("2000-01-01T00:00:00.000Z", harness.parent.promptId);
    }],
    ["detached observation", "parent_detached", (harness: Awaited<ReturnType<typeof createAutomaticSteeringHarness>>) => {
      harness.store.markPromptObservationDetached(harness.parent.promptId, "test detach");
    }],
    ["unknown runtime state", "parent_state", (harness: Awaited<ReturnType<typeof createAutomaticSteeringHarness>>) => {
      harness.store.updateBinding(harness.bindingId, { lastAgentState: "unknown" });
    }]
  ])("falls back exactly once for a %s", async (_label, reason, arrange) => {
    const harness = await createAutomaticSteeringHarness();
    arrange(harness);
    await harness.send(`fallback-${reason}`, "继续");
    const prompt = harness.store.getPrompt(harness.store.listRunCards(harness.bindingId).find((view) => view.requestText === "继续")!.promptId);
    expect(prompt).toMatchObject({ dispatchKind: "turn", parentPromptId: null, steeringOrigin: null });
    expect(harness.schedulerWake.mock.calls.filter(([hint]) => hint.kind === "steering-ready")).toHaveLength(0);
    expect(harness.schedulerWake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: harness.bindingId });
    expect(harness.info.mock.calls).toContainEqual([expect.objectContaining({ event: "auto-steering-fell-back-before-dispatch", reason }), "fell back to ordinary prompt before dispatch"]);
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

  it("preserves one durable automatic decision and one scheduler wake for duplicate delivery", async () => {
    const harness = await createAutomaticSteeringHarness();
    const duplicate = harness.message("duplicate-message", "继续");
    await harness.coordinator.handleMessage(duplicate);
    await harness.coordinator.handleMessage(duplicate);
    const rows = harness.store.database.prepare("SELECT id, dispatch_kind, parent_prompt_id, steering_origin FROM prompt_jobs WHERE lark_message_id = ?").all(duplicate.messageId);
    expect(rows).toEqual([{ id: expect.any(String), dispatch_kind: "steering", parent_prompt_id: harness.parent.promptId, steering_origin: "automatic" }]);
    expect(harness.schedulerWake.mock.calls.map(([hint]) => hint)).not.toContainEqual({ kind: "prompt-ready", bindingId: harness.bindingId });
    expect(harness.schedulerWake).toHaveBeenCalledWith({ kind: "steering-ready", bindingId: harness.bindingId, parentPromptId: harness.parent.promptId });
    await vi.waitFor(() => expect(harness.steering).toEqual(["继续"]));
    await harness.close();
  });

  it("accepts an eligible continuation as steering when the ordinary queue is full", async () => {
    const harness = await createAutomaticSteeringHarness(1);
    expect(harness.store.countPendingPrompts(harness.bindingId)).toBe(1);
    await harness.send("full-auto-message", "继续");
    const prompt = harness.store.getPrompt(harness.store.listRunCards(harness.bindingId).find((view) => view.requestText === "继续")!.promptId);
    expect(prompt).toMatchObject({ dispatchKind: "steering", parentPromptId: harness.parent.promptId, steeringOrigin: "automatic" });
    await vi.waitFor(() => expect(harness.steering).toEqual(["继续"]));
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
    expect(harness.info.mock.calls).toContainEqual([expect.objectContaining({ event: "auto-steering-classified", outcome: "queue_full", reason: "parent_detached" }), "classified continuation message"]);
    expect(harness.info.mock.calls).toContainEqual([expect.objectContaining({ event: "lark-message-accepted", messageId: "full-fallback-message", disposition: "rejected" }), "completed durable inbound handling"]);
    await harness.close();
  });

  it.each([
    ["not_working", "rejected"],
    ["throw", "uncertain"]
  ] as const)("records automatic %s delivery as %s without creating an ordinary prompt", async (steeringResult, failureKind) => {
    const harness = await createAutomaticSteeringHarness(20, steeringResult);
    await harness.send(`automatic-${failureKind}`, "继续");
    const expectedNotice = failureKind === "rejected"
      ? "当前任务已结束，未自动注入"
      : "自动注入结果无法确认，请检查 Herdr pane；Bridge 不会自动重试。";
    await vi.waitFor(() => expect(harness.store.listRunCards(harness.bindingId).find((view) => view.requestText === "继续")).toMatchObject({ phase: "failed", steeringOrigin: "automatic", steeringFailureKind: failureKind, notice: expectedNotice }));
    const prompt = harness.store.getPrompt(harness.store.listRunCards(harness.bindingId).find((view) => view.requestText === "继续")!.promptId)!;
    expect(prompt).toMatchObject({ dispatchKind: "steering", steeringOrigin: "automatic", state: "failed" });
    expect(harness.store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE source_prompt_id = ?").get(prompt.id)).toEqual({ count: 0 });
    expect(harness.bridgeEvents).toContainEqual(expect.objectContaining({ type: "SteeringFailed", payload: expect.objectContaining({ promptId: prompt.id, parentPromptId: harness.parent.promptId, failureKind, automatic: true }) }));
    const calls = failureKind === "uncertain" ? harness.error.mock.calls : harness.warn.mock.calls;
    expect(calls).toContainEqual([expect.objectContaining({ event: "auto-steering-delivery-failed", bindingId: harness.bindingId, promptId: prompt.id, parentPromptId: harness.parent.promptId, failureKind }), "automatic steering delivery failed"]);
    await harness.close();
  });
});
