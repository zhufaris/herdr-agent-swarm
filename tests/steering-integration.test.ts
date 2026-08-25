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
    await vi.waitFor(() => expect(store.listRunCards(bindingId)[0]).toMatchObject({ phase: "completed", answer: "◆ parent answer" }));
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
