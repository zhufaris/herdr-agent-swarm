import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { SyncCoordinator } from "../src/coordinator/sync-coordinator.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { CardProjector } from "../src/events/card-projector.js";
import { LarkChannelPublisher } from "../src/events/lark-channel-publisher.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("attach existing pane command", () => {
  it("attaches an eligible pane without mutating or starting it and is idempotent", async () => {
    let exposePane = false;
    const createTopic = vi.fn(async () => ({ topicId: "topic-attached", rootMessageId: "root-attached" }));
    const replyCards: object[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, createTopic,
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { replyCards.push(card); return { messageId: `reply-${replyCards.length}` }; },
      async updateCard() {}
    };
    const createPane = vi.fn<HerdrPort["createPane"]>();
    const startTraex = vi.fn<HerdrPort["startTraex"]>();
    const runPrompt = vi.fn<HerdrPort["runPrompt"]>();
    const renamePane = vi.fn<HerdrPort["renamePane"]>();
    const pane = { paneId: "w5:p3G", workspaceId: "w5", cwd: "/different/cwd", label: "Existing pane", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes(workspaceId) { return exposePane && workspaceId === "w5" ? [pane] : []; },
      async getPane() { return null; }, createPane, startTraex, runPrompt, async readOutput() { return ""; }, renamePane
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false })); projector.start();
    const coordinator = new SyncCoordinator(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    exposePane = true;

    await coordinator.handleMessage(command(1));
    expect(store.findBindingByPane("w5:p3G")).toMatchObject({ projectId: "analytics", topicId: "topic-attached", rootMessageId: "root-attached", state: "active" });
    expect(createTopic).toHaveBeenCalledTimes(1);
    expect(createPane).not.toHaveBeenCalled();
    expect(startTraex).not.toHaveBeenCalled();
    expect(runPrompt).not.toHaveBeenCalled();
    expect(renamePane).not.toHaveBeenCalled();

    await coordinator.handleMessage(command(2));
    expect(createTopic).toHaveBeenCalledTimes(1);
    expect(store.listBindings()).toHaveLength(1);
    expect(JSON.stringify(replyCards.at(-1))).toContain("已经连接");
    expect(JSON.stringify(replyCards.at(-1))).toContain("w5:p3G");

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("requires an explicitly configured exact space name", async () => {
    const createTopic = vi.fn(async () => ({ topicId: "topic-attached", rootMessageId: "root-attached" }));
    const replyCards: object[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, createTopic,
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { replyCards.push(card); return { messageId: `reply-${replyCards.length}` }; },
      async updateCard() {}
    };
    const pane = { paneId: "w5:p3G", workspaceId: "w5", cwd: "/different/cwd", label: "Existing pane", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes(workspaceId) { return workspaceId === "w5" ? [pane] : []; },
      async getPane() { return null; }, async createPane() { throw new Error("unexpected createPane"); },
      async startTraex() { throw new Error("unexpected startTraex"); }, async runPrompt() { throw new Error("unexpected runPrompt"); },
      async readOutput() { return ""; }, async renamePane() { throw new Error("unexpected renamePane"); }
    };
    const missingExplicitSpace = config();
    missingExplicitSpace.projects[0]!.spaceName = undefined;
    missingExplicitSpace.projects[0]!.cwd = "/repo/datasage_semantic_knowledge";
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false })); projector.start();
    const coordinator = new SyncCoordinator(missingExplicitSpace, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage(command(1));

    expect(store.findBindingByPane("w5:p3G")).toBeNull();
    expect(createTopic).not.toHaveBeenCalled();
    expect(JSON.stringify(replyCards.at(-1))).toContain("未找到空间");

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("rejects a pane that does not belong to the selected project's workspace", async () => {
    const createTopic = vi.fn(async () => ({ topicId: "topic-attached", rootMessageId: "root-attached" }));
    const replyCards: object[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, createTopic,
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { replyCards.push(card); return { messageId: `reply-${replyCards.length}` }; }, async updateCard() {}
    };
    const wrongWorkspacePane = { paneId: "w5:p3G", workspaceId: "w9", cwd: "/repo", label: "Wrong workspace", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [wrongWorkspacePane]; }, async getPane() { return null; },
      async createPane() { throw new Error("unexpected createPane"); }, async startTraex() { throw new Error("unexpected startTraex"); },
      async runPrompt() { throw new Error("unexpected runPrompt"); }, async readOutput() { return ""; }, async renamePane() { throw new Error("unexpected renamePane"); }
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false })); projector.start();
    const coordinator = new SyncCoordinator(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage(command(1));

    expect(store.findBindingByPane("w5:p3G")).toBeNull();
    expect(createTopic).not.toHaveBeenCalled();
    expect(JSON.stringify(replyCards.at(-1))).toContain("未找到 Pane");

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it.each([
    { name: "an ambiguous space", projects: [config().projects[0]!, { ...config().projects[0]!, id: "analytics-copy", workspaceId: "w6", cwd: "/copy" }], panes: [], expected: "对应多个项目" },
    { name: "a missing pane", projects: config().projects, panes: [], expected: "未找到 Pane" },
    { name: "a pane without TraeX", projects: config().projects, panes: [{ paneId: "w5:p3G", workspaceId: "w5", cwd: "/repo", label: "Shell", agentState: "idle" as const, foregroundExecutables: ["bash"] }], expected: "没有运行 TraeX" }
  ])("rejects $name before creating a binding", async ({ projects, panes, expected }) => {
    let exposePanes = false;
    const createTopic = vi.fn(async () => ({ topicId: "topic-attached", rootMessageId: "root-attached" }));
    const replyCards: object[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, createTopic, async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { replyCards.push(card); return { messageId: `reply-${replyCards.length}` }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return exposePanes ? panes : []; }, async getPane() { return null; },
      async createPane() { throw new Error("unexpected createPane"); }, async startTraex() { throw new Error("unexpected startTraex"); },
      async runPrompt() { throw new Error("unexpected runPrompt"); }, async readOutput() { return ""; }, async renamePane() { throw new Error("unexpected renamePane"); }
    };
    const testConfig = config();
    testConfig.projects = projects;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false })); projector.start();
    const coordinator = new SyncCoordinator(testConfig, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    exposePanes = true;

    await coordinator.handleMessage(command(1));

    expect(store.listBindings()).toHaveLength(0);
    expect(createTopic).not.toHaveBeenCalled();
    expect(JSON.stringify(replyCards.at(-1))).toContain(expected);

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });
});

function config(): BridgeConfig {
  return {
    lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
    herdr: { workspaceId: "w5", workspaceCwd: "/repo", executable: "herdr" },
    projects: [{ id: "analytics", displayName: "Analytics", spaceName: "datasage_semantic_knowledge", description: "Data project", workspaceId: "w5", cwd: "/repo" }],
    defaultProjectId: "analytics", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:",
    http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
  };
}

function command(index: number) {
  return { eventId: `event-${index}`, messageId: `message-${index}`, chatId: "chat", topicId: null, rootMessageId: `message-${index}`, actorOpenId: "user", text: "/herdr attach datasage_semantic_knowledge w5:p3G", mentionsBot: true, isRootMessage: true };
}
