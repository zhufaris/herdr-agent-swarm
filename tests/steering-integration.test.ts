import pino from "pino";
import type { Logger } from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { SyncCoordinator } from "../src/coordinator/sync-coordinator.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { CardProjector } from "../src/events/card-projector.js";
import { LarkChannelPublisher } from "../src/events/lark-channel-publisher.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("active-turn steering", () => {
  it("injects ordered steering into one active waiter and keeps final output on the parent card", async () => {
    let output = "initial";
    let release!: () => void;
    const hold = new Promise<void>((resolve) => { release = resolve; });
    const turns: string[] = [];
    const steering: string[] = [];
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
        await onObservation?.({ state: "working", output });
        await hold;
        output += "\n◆ parent answer\n────────";
        await onObservation?.({ state: "done", output });
        return "done";
      },
      async steerPrompt(_paneId, text) { steering.push(text); return "injected"; },
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
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false }));
    publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false }));
    projector.start();
    const coordinator = new SyncCoordinator(config, store, herdr, lark, bus, publisher, logger);
    await coordinator.start();
    const bindingId = store.findBindingByPane("w1:p1")!.id;
    const message = (n: number, text: string) => ({ eventId: `e${n}`, messageId: `m${n}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false });

    await coordinator.handleMessage(message(1, "parent"));
    await vi.waitFor(() => expect(store.listRunCards(bindingId)[0]).toMatchObject({ phase: "running" }));
    await Promise.all([coordinator.handleMessage(message(2, "steer one")), coordinator.handleMessage(message(3, "steer two"))]);
    await vi.waitFor(() => expect(steering).toEqual(["steer one", "steer two"]));
    await vi.waitFor(() => expect(store.listRunCards(bindingId).slice(1).every((view) => view.phase === "completed")).toBe(true));
    await coordinator.handleMessage(message(2, "steer one"));
    expect(steering).toEqual(["steer one", "steer two"]);
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "prompt-dispatch-decided", dispatchKind: "steering", outcome: "accepted" }), expect.any(String));
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "steering-delivered", outcome: "delivered" }), expect.any(String));
    expect(JSON.stringify(info.mock.calls)).not.toContain("steer one");

    expect(turns).toHaveLength(1);
    expect(turns[0]).toBe("parent");
    expect(store.listRunCards(bindingId).slice(1)).toMatchObject([
      { phase: "completed", answer: "", notice: "已加入当前执行" },
      { phase: "completed", answer: "", notice: "已加入当前执行" }
    ]);
    release();
    await vi.waitFor(() => expect(store.listRunCards(bindingId)[0]).toMatchObject({ phase: "completed", answer: "parent answer" }));

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("keeps messages FIFO while the active turn is blocked", async () => {
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
        if (turns.length === 1) { await onObservation?.({ state: "blocked", output }); await hold; }
        output += `\n◆ answer ${turns.length}\n────────`;
        await onObservation?.({ state: "done", output });
        return "done";
      },
      async steerPrompt(_paneId, text) { steering.push(text); return "injected"; },
      async readOutput() { return output; }, async renamePane() {}
    };
    const config = { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "default", displayName: "Default project", description: "Test project", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500 } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:"); const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false })); projector.start();
    const coordinator = new SyncCoordinator(config, store, herdr, lark, bus, publisher, pino({ enabled: false })); await coordinator.start();
    const send = (n: number, text: string) => coordinator.handleMessage({ eventId: `blocked-e${n}`, messageId: `blocked-m${n}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false });

    await send(1, "parent");
    await vi.waitFor(() => expect(store.findBindingByPane("w1:p1")).toMatchObject({ lastAgentState: "blocked" }));
    await send(2, "later turn");
    expect(steering).toEqual([]); expect(turns).toEqual(["parent"]);
    release();
    await vi.waitFor(() => expect(turns).toHaveLength(2));
    expect(turns[1]).toBe("later turn");

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });
});
