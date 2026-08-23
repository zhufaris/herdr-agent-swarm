import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { SyncCoordinator } from "../src/coordinator/sync-coordinator.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import type { IncomingLarkCardAction } from "../src/domain/types.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { CardProjector } from "../src/events/card-projector.js";
import { LarkChannelPublisher } from "../src/events/lark-channel-publisher.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("project selection flow", () => {
  it("explains where to continue when a message targets an archived or unbound topic", async () => {
    const cards: Array<{ rootMessageId: string; card: object }> = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; },
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(rootMessageId, card) { cards.push({ rootMessageId, card }); return { messageId: `card-${cards.length}` }; },
      async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; },
      async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; },
      async readOutput() { return ""; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "archived-binding", projectId: "alpha", workspaceId: "w1", chatId: "chat", topicId: "archived-topic", rootMessageId: "archived-root", title: "alpha / old task" });
    store.updateBinding("archived-binding", { paneId: "w1:p-old", state: "archived" });
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = new SyncCoordinator(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "e-archived", messageId: "m-archived", chatId: "chat", topicId: "archived-topic", rootMessageId: "archived-root", actorOpenId: "user-1", text: "继续", mentionsBot: false, isRootMessage: false });
    await coordinator.handleMessage({ eventId: "e-archived-again", messageId: "m-archived-again", chatId: "chat", topicId: "archived-topic", rootMessageId: "archived-root", actorOpenId: "user-1", text: "再试一次", mentionsBot: false, isRootMessage: false });
    await coordinator.handleMessage({ eventId: "e-unbound", messageId: "m-unbound", chatId: "chat", topicId: "unbound-topic", rootMessageId: "unbound-root", actorOpenId: "user-1", text: "当前项目", mentionsBot: false, isRootMessage: false });

    expect(cards.map(({ rootMessageId }) => rootMessageId)).toEqual(["archived-root", "archived-root", "unbound-root"]);
    expect(JSON.stringify(cards[0]!.card)).toContain("话题已归档");
    expect(JSON.stringify(cards[0]!.card)).toContain("/herdr new");
    expect(JSON.stringify(cards[2]!.card)).toContain("话题未连接");
    expect(JSON.stringify(cards[2]!.card)).toContain("/herdr new");

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("creates exactly one pane in the clicked project and does not submit an initial prompt", async () => {
    let onAction: ((action: IncomingLarkCardAction) => Promise<void>) | undefined;
    const created: Array<[string, string, unknown]> = [];
    const started: string[] = [];
    const prompts: string[] = [];
    const cards: object[] = [];
    const groupCards: object[] = [];
    const updates: object[] = [];
    const shareThread = vi.fn(async () => ({ messageId: "forwarded-topic-1" }));
    const lark: LarkPort = {
      async start(_onMessage, callback) { onAction = callback; }, async stop() {}, isReady: () => true,
      async createTopic(card) { groupCards.push(card); return { topicId: "project-topic-1", rootMessageId: "project-root-1" }; },
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { cards.push(card); return { messageId: "selector-card-1" }; },
      async updateCard(_messageId, card) { updates.push(card); }, shareThread
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; },
      async createPane(workspaceId, cwd, options) { created.push([workspaceId, cwd, options]); return { paneId: "wD:p9", workspaceId, cwd, label: null, agentState: "idle", foregroundExecutables: [] }; },
      async startTraex(paneId) { started.push(paneId); }, async runPrompt(_pane, text) { prompts.push(text); return "done"; },
      async readOutput() { return ""; }, async renamePane() {}
    };
    const config = {
      lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
      herdr: { workspaceId: "wH", workspaceCwd: "/work/bridge", executable: "herdr" },
      projects: [
        { id: "bridge", displayName: "Bridge", spaceName: "herdr-lark-bridge", description: "Bridge service", workspaceId: "wH", cwd: "/work/bridge" },
        { id: "datasage", displayName: "DataSage", spaceName: "datasage_semantic_knowledge", description: "Semantic knowledge", workspaceId: "wD", cwd: "/work/datasage" }
      ], defaultProjectId: "bridge", projectsConfigPath: "config/projects.json",
      traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent",
      commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
    } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false })); projector.start();
    const coordinator = new SyncCoordinator(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    store.createPendingBinding({ id: "existing-binding", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "existing-topic", rootMessageId: "existing-root", title: "bridge / Existing" });
    store.updateBinding("existing-binding", { paneId: "wH:p1", state: "active" });

    await coordinator.handleMessage({ eventId: "e1", messageId: "command-1", chatId: "chat", topicId: "existing-topic", rootMessageId: "existing-root", actorOpenId: "user-1", text: "/herdr new Fix login", mentionsBot: true, isRootMessage: false });
    expect(created).toEqual([]);
    expect(cards).toHaveLength(1);
    const button = findProjectButton(cards[0]!, "datasage");
    const value = button.value as { selectionId: string; projectId: string; action: string };
    expect(store.getProjectSelection(value.selectionId)).toMatchObject({ selectorMessageId: "selector-card-1", requestedTitle: "Fix login" });

    await onAction!({ messageId: "selector-card-1", chatId: "chat", operatorOpenId: "another-user", value });
    expect(updates).toEqual([]);
    expect(created).toEqual([]);

    await onAction!({ messageId: "selector-card-1", chatId: "chat", operatorOpenId: "user-1", value });
    await onAction!({ messageId: "selector-card-1", chatId: "chat", operatorOpenId: "user-1", value });

    expect(created).toEqual([["wD", "/work/datasage", {
      bindingId: expect.any(String), generation: 1, projectId: "datasage", title: "datasage_semantic_knowledge / Fix login", placement: "dedicated-tab"
    }]]);
    expect(started).toEqual(["wD:p9"]);
    expect(prompts).toEqual([]);
    expect(groupCards).toHaveLength(1);
    expect(JSON.stringify(groupCards[0])).toContain("datasage_semantic_knowledge");
    expect(JSON.stringify(groupCards[0])).toContain("wD:p9");
    expect(store.findBindingByPane("wD:p9")).toMatchObject({
      projectId: "datasage", workspaceId: "wD", title: "datasage_semantic_knowledge / Fix login", state: "active",
      topicId: "project-topic-1", rootMessageId: "project-root-1", statusMessageId: "project-root-1"
    });
    expect(store.getProjectSelection(value.selectionId)).toMatchObject({ state: "completed", selectedProjectId: "datasage" });
    expect(JSON.stringify(updates.at(-1))).toContain("项目已打开");
    expect(JSON.stringify(updates.at(-1))).toContain("datasage_semantic_knowledge");
    expect(JSON.stringify(updates.at(-1))).toContain("发送话题入口");
    const completedCard = updates.at(-1)!;
    expect(JSON.stringify(completedCard)).toContain('\"action\":\"open_project_thread\"');
    expect(JSON.stringify(completedCard)).not.toContain("openMessageId");
    expect(JSON.stringify(completedCard)).not.toContain("client/chat/open");
    expect(JSON.stringify(updates.at(-1))).not.toContain("当前话题");
    expect(JSON.stringify(updates.at(-1))).not.toContain("**Workspace**");

    const openButton = findActionButton(completedCard, "open_project_thread");
    await onAction!({ messageId: "selector-card-1", chatId: "chat", operatorOpenId: "user-1", value: openButton.value });
    expect(shareThread).toHaveBeenCalledWith("project-topic-1", "chat");

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("reconciles each workspace independently and skips an unavailable workspace", async () => {
    const listed: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; },
      async replyText() { return { messageId: "text-1" }; }, async replyCard() { return { messageId: "card-1" }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes(workspaceId) {
        listed.push(workspaceId);
        if (workspaceId === "w1") throw new Error("w1 unavailable");
        return [{ paneId: "w2:p1", workspaceId: "w2", cwd: "/work/beta", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }];
      },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {}
    };
    const multiProjectConfig = {
      ...configForTests(),
      projects: [
        { id: "alpha", displayName: "Alpha", description: "Alpha project", workspaceId: "w1", cwd: "/work/alpha" },
        { id: "beta", displayName: "Beta", description: "Beta project", workspaceId: "w2", cwd: "/work/beta" }
      ]
    } satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b2", projectId: "beta", workspaceId: "w2", chatId: "chat", topicId: "topic-2", rootMessageId: "root-2", title: "beta / task" });
    store.updateBinding("b2", { paneId: "w2:p1", state: "active" });
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = new SyncCoordinator(multiProjectConfig, store, herdr, lark, bus, publisher, pino({ enabled: false }));

    await coordinator.start();

    expect(new Set(listed)).toEqual(new Set(["w1", "w2"]));
    expect(store.findBindingByPane("w2:p1")).toMatchObject({ state: "active", projectId: "beta" });
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("keeps the started pane recoverable when group-card creation fails", async () => {
    let onAction: ((action: IncomingLarkCardAction) => Promise<void>) | undefined;
    const selectorCards: object[] = [];
    const updates: object[] = [];
    const lark: LarkPort = {
      async start(_onMessage, callback) { onAction = callback; }, async stop() {}, isReady: () => true,
      async createTopic() { throw new Error("group card unavailable"); },
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { selectorCards.push(card); return { messageId: "selector-card-1" }; },
      async updateCard(_messageId, card) { updates.push(card); }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; },
      async createPane(workspaceId, cwd) { return { paneId: "w1:p7", workspaceId, cwd, label: null, agentState: "idle", foregroundExecutables: [] }; },
      async startTraex() {}, async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false })); projector.start();
    const coordinator = new SyncCoordinator(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "e-fail", messageId: "command-fail", chatId: "chat", topicId: null, rootMessageId: "command-fail", actorOpenId: "user-1", text: "/herdr new Broken", mentionsBot: true, isRootMessage: true });
    const value = findProjectButton(selectorCards[0]!, "alpha").value;
    await onAction!({ messageId: "selector-card-1", chatId: "chat", operatorOpenId: "user-1", value });

    expect(store.listBindings()).toHaveLength(1);
    expect(store.listBindings()[0]).toMatchObject({ state: "pending", lifecycle: "provisioning", provisioningCheckpoint: "runtime_started", paneId: "w1:p7", topicId: null, rootMessageId: null, statusMessageId: null });
    expect(store.getProjectSelection((value as { selectionId: string }).selectionId)).toMatchObject({ state: "processing", error: "group card unavailable" });
    expect(JSON.stringify(updates.at(-1))).toContain("项目创建已暂停");

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });
});

function configForTests(): BridgeConfig {
  return {
    lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
    herdr: { workspaceId: "w1", workspaceCwd: "/work/alpha", executable: "herdr" },
    projects: [{ id: "alpha", displayName: "Alpha", description: "Alpha project", workspaceId: "w1", cwd: "/work/alpha" }],
    defaultProjectId: "alpha", projectsConfigPath: "test", traex: { executable: "traex" },
    databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent",
    commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
  };
}

function findProjectButton(card: object, projectId: string): { value: unknown } {
  const elements = (card as { body: { elements: Array<{ value?: { projectId?: string } }> } }).body.elements;
  const button = elements.find((element) => element.value?.projectId === projectId);
  if (!button) throw new Error(`Missing project button: ${projectId}`);
  return { value: button.value };
}

function findActionButton(card: object, action: string): { value: unknown } {
  const elements = (card as { body: { elements: Array<{ value?: { action?: string } }> } }).body.elements;
  const button = elements.find((element) => element.value?.action === action);
  if (!button) throw new Error(`Missing action button: ${action}`);
  return { value: button.value };
}
