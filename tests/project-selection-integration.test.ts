import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import type { IncomingLarkCardAction } from "../src/domain/types.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { ConversationViewProjector } from "../src/events/conversation-view-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("project selection flow", () => {
  for (const command of ["/swarm new", "/swarm projects"] as const) {
    it(`waits for the immediate selector delivery attempt for ${command}`, async () => {
      let releaseDelivery!: () => void;
      let markDeliveryStarted!: () => void;
      const deliveryStarted = new Promise<void>((resolve) => { markDeliveryStarted = resolve; });
      const deliveryReleased = new Promise<void>((resolve) => { releaseDelivery = resolve; });
      const replyCard = vi.fn(async () => { markDeliveryStarted(); await deliveryReleased; return { messageId: "selector-card" }; });
      const lark: LarkPort = {
        async start() {}, async stop() {}, isReady: () => true, async createTopic() { throw new Error("not used"); },
        async replyText() { return { messageId: "text" }; }, replyCard, async updateCard() {}
      };
      const herdr = { async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {} } as HerdrPort;
      const store = new SqliteBindingStore(":memory:");
      const bus = new BridgeEventBus();
      const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
      const coordinator = createTestRouter(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
      await coordinator.start();

      let handled = false;
      const handling = coordinator.handleMessage({ eventId: `event-${command}`, messageId: `message-${command}`, chatId: "chat", topicId: null, rootMessageId: `message-${command}`, actorOpenId: "user-1", text: command, mentionsBot: true, isRootMessage: true }).then(() => { handled = true; });
      await deliveryStarted;
      await Promise.resolve();

      expect(handled).toBe(false);
      expect(store.listPendingOutboundReplies()).toHaveLength(1);
      releaseDelivery();
      await handling;
      expect(replyCard).toHaveBeenCalledOnce();
      expect(store.listPendingOutboundReplies()).toHaveLength(0);
      await coordinator.stop(); await publisher.stop(); store.close();
    });
  }

  it("keeps a failed immediate selector delivery durable for retry", async () => {
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { throw new Error("not used"); },
      async replyText() { return { messageId: "text" }; }, async replyCard() { throw new Error("temporary Lark failure"); }, async updateCard() {}
    };
    const herdr = { async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {} } as HerdrPort;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await expect(coordinator.handleMessage({ eventId: "event-failed-selector", messageId: "message-failed-selector", chatId: "chat", topicId: null, rootMessageId: "message-failed-selector", actorOpenId: "user-1", text: "/swarm new", mentionsBot: true, isRootMessage: true })).resolves.toBeUndefined();

    const selection = store.database.prepare("SELECT id, state FROM project_selections WHERE command_message_id = ?").get("message-failed-selector") as { id: string; state: string };
    expect(selection.state).toBe("pending");
    expect(store.database.prepare("SELECT state, attempt_count FROM outbound_replies WHERE selection_id = ?").get(selection.id)).toMatchObject({ state: "pending", attempt_count: 1 });
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("returns the card callback before project provisioning completes", async () => {
    let onAction: ((action: IncomingLarkCardAction) => Promise<unknown>) | undefined;
    let releasePane!: () => void;
    const paneReady = new Promise<void>((resolve) => { releasePane = resolve; });
    const selectorCards: object[] = [];
    const lark: LarkPort = {
      async start(_onMessage, callback) { onAction = callback; }, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "task-topic", rootMessageId: "task-root" }; },
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { selectorCards.push(card); return { messageId: "selector-card" }; },
      async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; },
      async createPane(_workspaceId, cwd, options) { await paneReady; return { paneId: "w1:p1", workspaceId: "w1", cwd, label: options?.title ?? null, agentState: "idle", foregroundExecutables: [] }; },
      async observeRuntime() { return { pane: { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/work/alpha", label: "task-abcd", agentState: "idle", foregroundExecutables: ["traex"] }, traexProcess: true, composerReady: true, evidenceSource: "structured" }; },
      async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    await coordinator.handleMessage({ eventId: "e-async", messageId: "m-async", chatId: "chat", topicId: "m-async", rootMessageId: "m-async", actorOpenId: "user-1", text: "/swarm new title", mentionsBot: true, isRootMessage: true });
    const value = findProjectButton(selectorCards[0]!, "alpha").value as { selectionId: string; projectId: string; action: string };

    await expect(onAction!({ messageId: "selector-card", chatId: "chat", operatorOpenId: "user-1", value })).resolves.toEqual({ toast: { type: "success", content: "项目创建已开始。" } });
    expect(store.getProjectSelection(value.selectionId)?.state).toBe("processing");
    releasePane();
    await vi.waitFor(() => expect(store.getProjectSelection(value.selectionId)?.state).toBe("completed"));

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("requires an explicit project click before dispatching a natural-language root request", async () => {
    let onAction: ((action: IncomingLarkCardAction) => Promise<unknown>) | undefined;
    const created: string[] = [];
    const prompts: string[] = [];
    const selectorCards: object[] = [];
    const lark: LarkPort = {
      async start(_onMessage, callback) { onAction = callback; }, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "task-topic", rootMessageId: "task-root" }; },
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { selectorCards.push(card); return { messageId: "selector-card" }; },
      async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; },
      async createPane(_workspaceId, _cwd, options) { created.push(options?.title ?? ""); return { paneId: "w1:p1", workspaceId: "w1", cwd: "/work/alpha", label: options?.title ?? null, agentState: "idle", foregroundExecutables: [] }; },
      async observeRuntime() { return { pane: { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/work/alpha", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }, traexProcess: true, composerReady: true, evidenceSource: "structured" }; },
      async startTraex() {}, async runPrompt(_pane, text) { prompts.push(text); return "done"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    const coordinator = createTestRouter(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "natural-e1", messageId: "natural-m1", chatId: "chat", topicId: "natural-topic", rootMessageId: "natural-m1", actorOpenId: "user-1", text: "帮我排查登录超时", mentionsBot: true, isRootMessage: true });
    await publisher.drain();
    expect(created).toEqual([]);
    expect(prompts).toEqual([]);
    expect(store.listBindings()).toEqual([]);
    const value = findProjectButton(selectorCards[0]!, "alpha").value as { selectionId: string; projectId: string; action: string };
    expect(store.getProjectSelection(value.selectionId)).toMatchObject({ requestedTitle: "帮我排查登录超时", initialPromptText: "帮我排查登录超时" });

    await onAction!({ messageId: "selector-card", chatId: "chat", operatorOpenId: "user-1", value });
    await onAction!({ messageId: "selector-card", chatId: "chat", operatorOpenId: "user-1", value });
    await vi.waitFor(() => expect(prompts).toEqual(["帮我排查登录超时"]));
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/^task-[a-z0-9]{4}$/);
    expect(store.findBindingByPane("w1:p1")).toMatchObject({ creatorOpenId: "user-1", title: `alpha / ${created[0]}` });

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

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
      async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "archived-binding", projectId: "alpha", workspaceId: "w1", chatId: "chat", topicId: "archived-topic", rootMessageId: "archived-root", title: "alpha / old task" });
    store.updateBinding("archived-binding", { paneId: "w1:p-old", state: "archived" });
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "e-archived", messageId: "m-archived", chatId: "chat", topicId: "archived-topic", rootMessageId: "archived-root", actorOpenId: "user-1", text: "继续", mentionsBot: false, isRootMessage: false });
    await coordinator.handleMessage({ eventId: "e-archived-again", messageId: "m-archived-again", chatId: "chat", topicId: "archived-topic", rootMessageId: "archived-root", actorOpenId: "user-1", text: "再试一次", mentionsBot: false, isRootMessage: false });
    await coordinator.handleMessage({ eventId: "e-unbound", messageId: "m-unbound", chatId: "chat", topicId: "unbound-topic", rootMessageId: "unbound-root", actorOpenId: "user-1", text: "当前项目", mentionsBot: false, isRootMessage: false });

    expect(cards.map(({ rootMessageId }) => rootMessageId)).toEqual(["archived-root", "archived-root", "unbound-root"]);
    expect(JSON.stringify(cards[0]!.card)).toContain("话题已归档");
    expect(JSON.stringify(cards[0]!.card)).toContain("/swarm new");
    expect(JSON.stringify(cards[2]!.card)).toContain("话题未连接");
    expect(JSON.stringify(cards[2]!.card)).toContain("/swarm new");

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("creates exactly one pane in the clicked project and does not submit an initial prompt", async () => {
    let onAction: ((action: IncomingLarkCardAction) => Promise<void>) | undefined;
    const created: Array<[string, string, unknown]> = [];
    const started: Array<[string, string[] | undefined]> = [];
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
      async observeRuntime() { return { pane: { paneId: "wD:p9", terminalId: "term-9", workspaceId: "wD", cwd: "/work/datasage", label: null, agentState: "idle", foregroundExecutables: ["traex"] }, traexProcess: true, composerReady: true, evidenceSource: "structured" }; },
      async startTraex(paneId, _executable, args) { started.push([paneId, args]); }, async runPrompt(_pane, text) { prompts.push(text); return "done"; }, async renamePane() {}
    };
    const config = {
      lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", allowedOpenIds: ["u1", "u2", "creator", "user", "user-1"], adminOpenIds: ["u1", "u2", "creator", "user", "user-1"] },
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
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    store.createPendingBinding({ id: "existing-binding", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "existing-topic", rootMessageId: "existing-root", title: "bridge / Existing" });
    store.updateBinding("existing-binding", { paneId: "wH:p1", state: "active" });

    await coordinator.handleMessage({ eventId: "e1", messageId: "command-1", chatId: "chat", topicId: "existing-topic", rootMessageId: "existing-root", actorOpenId: "user-1", text: "/swarm new Fix login", mentionsBot: true, isRootMessage: false });
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
    await vi.waitFor(() => expect(store.getProjectSelection(value.selectionId)?.state).toBe("completed"));

    expect(created).toEqual([["wD", "/work/datasage", {
      bindingId: expect.any(String), generation: 1, projectId: "datasage", placement: "dedicated-tab", title: expect.stringMatching(/^task-[a-z0-9]{4}$/),
      environment: { SWARM_PRIMARY_CAPABILITY: expect.stringMatching(/^test-.+-1$/) }
    }]]);
    const bindingId = (created[0]![2] as { bindingId: string }).bindingId;
    expect(started).toEqual([["wD:p9", [
      "-c", 'mcp_servers.herdr_agent_swarm.command="node"',
      "-c", `mcp_servers.herdr_agent_swarm.args=["primary-tools","--binding","${bindingId}","--generation","1"]`,
      "-c", 'mcp_servers.herdr_agent_swarm.env_vars=["SWARM_PRIMARY_CAPABILITY"]'
    ]]]);
    expect(prompts).toEqual([]);
    expect(groupCards).toHaveLength(1);
    expect(JSON.stringify(groupCards[0])).toContain("datasage_semantic_knowledge");
    expect(JSON.stringify(groupCards[0])).toContain("wD:p9");
    const paneTitle = (created[0]![2] as { title: string }).title;
    expect(store.findBindingByPane("wD:p9")).toMatchObject({
      projectId: "datasage", workspaceId: "wD", title: `datasage_semantic_knowledge / ${paneTitle}`, state: "active",
      topicId: "project-topic-1", rootMessageId: "project-root-1", statusMessageId: "project-root-1", lastAgentState: "idle"
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

    await coordinator.handleMessage({
      eventId: "e-first-prompt", messageId: "first-prompt", chatId: "chat", topicId: "project-topic-1", rootMessageId: "project-root-1",
      actorOpenId: "user-1", text: "start the task", mentionsBot: false, isRootMessage: false
    });
    await vi.waitFor(() => expect(prompts).toEqual(["start the task"]));

    const openButton = findActionButton(completedCard, "open_project_thread");
    await onAction!({ messageId: "selector-card-1", chatId: "chat", operatorOpenId: "user-1", value: openButton.value });
    expect(shareThread).toHaveBeenCalledWith("project-topic-1", { messageId: "selector-card-1", chatId: "chat" });

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("uses a short random pane name when /swarm new has no title", async () => {
    let onAction: ((action: IncomingLarkCardAction) => Promise<void>) | undefined;
    const created: Array<{ title?: string }> = [];
    const groupCards: object[] = [];
    const selectorCards: object[] = [];
    const lark: LarkPort = {
      async start(_onMessage, callback) { onAction = callback; }, async stop() {}, isReady: () => true,
      async createTopic(card) { groupCards.push(card); return { topicId: "topic-random", rootMessageId: "root-random" }; },
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { selectorCards.push(card); return { messageId: "selector-card-1" }; },
      async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; },
      async createPane(_workspaceId, _cwd, options) {
        created.push({ title: options?.title });
        return { paneId: "w1:p7", workspaceId: "w1", cwd: "/work/alpha", label: options?.title ?? null, agentState: "idle", foregroundExecutables: [] };
      },
      async observeRuntime() { return { pane: { paneId: "w1:p7", terminalId: "term-7", workspaceId: "w1", cwd: "/work/alpha", label: created[0]?.title ?? null, agentState: "idle", foregroundExecutables: ["traex"] }, traexProcess: true, composerReady: true, evidenceSource: "structured" }; },
      async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    const coordinator = createTestRouter(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "e-random", messageId: "command-random", chatId: "chat", topicId: "topic-random", rootMessageId: "root-random", actorOpenId: "user-1", text: "/swarm new", mentionsBot: true, isRootMessage: true });
    const value = findProjectButton(selectorCards[0]!, "alpha").value as { selectionId: string; projectId: string; action: string };
    await onAction!({ messageId: "selector-card-1", chatId: "chat", operatorOpenId: "user-1", value });
    await vi.waitFor(() => expect(store.getProjectSelection(value.selectionId)?.state).toBe("completed"));

    const paneName = created[0]?.title;
    expect(paneName).toMatch(/^task-[a-z0-9]{4}$/);
    expect(store.findBindingByPane("w1:p7")).toMatchObject({ title: `alpha / ${paneName}` });
    expect(JSON.stringify(groupCards[0])).toContain(`alpha / ${paneName}`);

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
      async runPrompt() { return "done"; }, async renamePane() {}
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
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(multiProjectConfig, store, herdr, lark, bus, publisher, pino({ enabled: false }));

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
      async observeRuntime() { return { pane: { paneId: "w1:p7", terminalId: "term-7", workspaceId: "w1", cwd: "/work/alpha", label: null, agentState: "idle", foregroundExecutables: ["traex"] }, traexProcess: true, composerReady: true, evidenceSource: "structured" }; },
      async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
    const coordinator = createTestRouter(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "e-fail", messageId: "command-fail", chatId: "chat", topicId: null, rootMessageId: "command-fail", actorOpenId: "user-1", text: "/swarm new Broken", mentionsBot: true, isRootMessage: true });
    const value = findProjectButton(selectorCards[0]!, "alpha").value;
    await onAction!({ messageId: "selector-card-1", chatId: "chat", operatorOpenId: "user-1", value });
    await vi.waitFor(() => expect(store.getProjectSelection((value as { selectionId: string }).selectionId)?.error).toBe("group card unavailable"));

    expect(store.listBindings()).toHaveLength(1);
    expect(store.listBindings()[0]).toMatchObject({ state: "pending", lifecycle: "provisioning", provisioningCheckpoint: "runtime_started", paneId: "w1:p7", topicId: null, rootMessageId: null, statusMessageId: null });
    expect(store.getProjectSelection((value as { selectionId: string }).selectionId)).toMatchObject({ state: "processing", error: "group card unavailable" });
    expect(JSON.stringify(updates.at(-1))).toContain("项目创建已暂停");

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("keeps a pane at pane_created when TraeX composer readiness fails", async () => {
    let onAction: ((action: IncomingLarkCardAction) => Promise<void>) | undefined;
    const selectorCards: object[] = [];
    const lark: LarkPort = {
      async start(_onMessage, callback) { onAction = callback; }, async stop() {}, isReady: () => true,
      async createTopic() { throw new Error("must not create topic before runtime readiness"); },
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { selectorCards.push(card); return { messageId: "selector-card-1" }; },
      async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; },
      async createPane(workspaceId, cwd) { return { paneId: "w1:p7", workspaceId, cwd, label: null, agentState: "unknown", foregroundExecutables: [] }; },
      async observeRuntime() { return { pane: { paneId: "w1:p7", terminalId: "term-7", workspaceId: "w1", cwd: "/work/alpha", label: null, agentState: "unknown", foregroundExecutables: [] }, traexProcess: false, composerReady: false, evidenceSource: "process" }; },
      async startTraex() { throw new Error("TraeX composer did not become ready in pane w1:p7"); },
      async runPrompt() { return "done"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "e-not-ready", messageId: "command-not-ready", chatId: "chat", topicId: null, rootMessageId: "command-not-ready", actorOpenId: "user-1", text: "/swarm new Not ready", mentionsBot: true, isRootMessage: true });
    const value = findProjectButton(selectorCards[0]!, "alpha").value;
    await onAction!({ messageId: "selector-card-1", chatId: "chat", operatorOpenId: "user-1", value });
    await vi.waitFor(() => expect(store.getProjectSelection((value as { selectionId: string }).selectionId)?.error).toBe("TraeX composer did not become ready in pane w1:p7"));

    expect(store.listBindings()[0]).toMatchObject({
      state: "pending", lifecycle: "provisioning", provisioningCheckpoint: "pane_created", paneId: "w1:p7", lastAgentState: "unknown"
    });
    expect(store.getProjectSelection((value as { selectionId: string }).selectionId)).toMatchObject({
      state: "processing", error: "TraeX composer did not become ready in pane w1:p7"
    });

    await coordinator.stop(); await publisher.stop(); store.close();
  });
});

function configForTests(): BridgeConfig {
  return {
    lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", allowedOpenIds: ["u1", "u2", "creator", "user", "user-1"], adminOpenIds: ["u1", "u2", "creator", "user", "user-1"] },
    herdr: { workspaceId: "w1", workspaceCwd: "/work/alpha", executable: "herdr" },
    projects: [{ id: "alpha", displayName: "Alpha", description: "Alpha project", workspaceId: "w1", cwd: "/work/alpha" }],
    defaultProjectId: "alpha", projectsConfigPath: "test", traex: { executable: "traex" },
    databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent",
    commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
  };
}

function findProjectButton(card: object, projectId: string): { value: unknown } {
  const elements = (card as { body: { elements: Array<{ behaviors?: Array<{ type?: string; value?: { projectId?: string } }> }> } }).body.elements;
  const button = elements.find((element) => element.behaviors?.some((behavior) => behavior.type === "callback" && behavior.value?.projectId === projectId));
  if (!button) throw new Error(`Missing project button: ${projectId}`);
  return { value: button.behaviors!.find((behavior) => behavior.type === "callback")!.value };
}

function findActionButton(card: object, action: string): { value: unknown } {
  const elements = (card as { body: { elements: Array<{ behaviors?: Array<{ type?: string; value?: { action?: string } }> }> } }).body.elements;
  const button = elements.find((element) => element.behaviors?.some((behavior) => behavior.type === "callback" && behavior.value?.action === action));
  if (!button) throw new Error(`Missing action button: ${action}`);
  return { value: button.behaviors!.find((behavior) => behavior.type === "callback")!.value };
}
