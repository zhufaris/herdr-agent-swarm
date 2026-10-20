import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import type { IncomingLarkCardAction } from "../src/domain/types.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { TestConversationViewProjector as ConversationViewProjector } from "./helpers/create-test-conversation-view-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { primaryPresentation } from "./helpers/presentation.js";
import { primaryManagedAgentName } from "../src/domain/managed-agent-name.js";

describe("project selection flow", () => {
  for (const command of ["/swarm new", "/swarm projects"] as const) {
    it(`returns after durable selector reservation for ${command} while Ring delivery continues`, async () => {
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
      await handling;

      expect(handled).toBe(true);
      const selection = await waitForProjectSelection(store, `message-${command}`);
      expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE selection_id = ? AND state = 'pending'").get(selection.id)).toEqual({ count: 1 });
      await deliveryStarted;
      releaseDelivery();
      await publisher.drain();
      expect(replyCard).toHaveBeenCalled();
      expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE selection_id = ? AND state = 'pending'").get(selection.id)).toEqual({ count: 0 });
      await coordinator.stop(); await publisher.stop(); store.close();
    });
  }

  it("keeps a failed Global head durable and leaves the selector behind it", async () => {
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { throw new Error("not used"); },
      async replyText() { return { messageId: "text" }; }, async replyCard() { throw Object.assign(new Error("rate limited"), { response: { status: 429 } }); }, async updateCard() {}
    };
    const herdr = { async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {} } as HerdrPort;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await expect(coordinator.handleMessage({ eventId: "event-failed-selector", messageId: "message-failed-selector", chatId: "chat", topicId: null, rootMessageId: "message-failed-selector", actorOpenId: "user-1", text: "/swarm new", mentionsBot: true, isRootMessage: true })).resolves.toBeUndefined();
    const selection = await waitForProjectSelection(store, "message-failed-selector");
    await publisher.drain();

    expect(selection.state).toBe("pending");
    expect(store.database.prepare("SELECT state, attempt_count FROM outbound_replies WHERE selection_id = ?").get(selection.id)).toMatchObject({ state: "pending", attempt_count: 0 });
    expect(store.database.prepare("SELECT state, attempt_count FROM outbound_replies WHERE projection_key LIKE 'command-status:%' ORDER BY delivery_order LIMIT 1").get()).toMatchObject({ state: "pending", attempt_count: 1 });
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("persists the requested Primary Agent kind before project selection", async () => {
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { throw new Error("not used"); },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "selector-card" }; }, async updateCard() {}
    };
    const herdr = { async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; }, async renamePane() {} } as HerdrPort;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "event-pi", messageId: "message-pi", chatId: "chat", topicId: null, rootMessageId: "message-pi", actorOpenId: "user-1", text: "/swarm new investigate --agent pi", mentionsBot: true, isRootMessage: true });

    await waitForProjectSelection(store, "message-pi");
    expect(store.database.prepare("SELECT requested_title, agent_kind FROM project_selections WHERE command_message_id = ?").get("message-pi")).toEqual({ requested_title: "investigate", agent_kind: "pi" });
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("starts the selected Primary Agent driver and preserves its kind on the binding", async () => {
    let onAction: ((action: IncomingLarkCardAction) => Promise<unknown>) | undefined;
    let selectorCard: object | undefined;
    let paneCreated = false;
    const startAgent = vi.fn(async () => undefined);
    const lark: LarkPort = {
      async start(_onMessage, callback) { onAction = callback; }, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "pi-topic", rootMessageId: "pi-root" }; }, async replyText() { return { messageId: "text" }; },
      async replyCard(_root, card) { selectorCard = card; return { messageId: "selector-card" }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return paneCreated ? { paneId: "w1:pi", terminalId: "term-pi", workspaceId: "w1", cwd: "/work/alpha", label: "pi-primary", agentKind: "pi", agentSession: { source: "herdr:pi", agent: "pi", kind: "id", value: "pi-session" }, agentState: "idle", foregroundExecutables: ["pi"] } : null; },
      async createPane(workspaceId, cwd, options) { paneCreated = true; return { paneId: "w1:pi", workspaceId, cwd, label: options?.title ?? null, agentState: "idle", foregroundExecutables: [] }; },
      async observeRuntime() { return { pane: { paneId: "w1:pi", terminalId: "term-pi", workspaceId: "w1", cwd: "/work/alpha", label: "pi-primary", agentKind: "pi", agentSession: { source: "herdr:pi", agent: "pi", kind: "id", value: "pi-session" }, agentState: "idle", foregroundExecutables: ["pi"] }, traexProcess: false, composerReady: false, evidenceSource: "structured" }; },
      startAgent, async startTraex() { throw new Error("TraeX must not start"); }, async runPrompt() { throw new Error("legacy Prompt executor must not run"); }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = createTestRouter(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    await coordinator.handleMessage({ eventId: "event-pi-create", messageId: "message-pi-create", chatId: "chat", topicId: null, rootMessageId: "message-pi-create", actorOpenId: "user-1", text: "/swarm new investigate --agent pi", mentionsBot: true, isRootMessage: true });
    await waitForProjectSelection(store, "message-pi-create");
    await publisher.drain();
    const value = findProjectButton(selectorCard!, "alpha").value as { selectionId: string; projectId: string; action: string };
    await onAction!({ messageId: "selector-card", chatId: "chat", operatorOpenId: "user-1", value });
    await vi.waitFor(() => expect(store.getProjectSelection(value.selectionId)?.state).toBe("completed"));

    const piBinding = store.findBindingByPane("w1:pi")!;
    expect(startAgent).toHaveBeenCalledWith("w1:pi", { name: primaryManagedAgentName("alpha", piBinding.id, piBinding.generation), kind: "pi", executable: "pi", args: [] });
    expect(piBinding).toMatchObject({ agentKind: "pi", state: "active" });
    expect(store.hasBindingPrimaryToolCapability(piBinding.id, piBinding.generation)).toBe(false);
    await vi.waitFor(() => expect(store.loadTopicView(piBinding.id)).toMatchObject({ agentKind: "pi", primaryToolsAvailable: false, primaryToolsNotice: expect.stringContaining("pi Primary") }));
    await coordinator.handleMessage({ eventId: "pi-prompt-event", messageId: "pi-prompt", chatId: "chat", topicId: "pi-topic", rootMessageId: "pi-root", actorOpenId: "user-1", text: "run with pi", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.database.prepare("SELECT text, owner_id, pane_id, terminal_id, expected_agent_kind, expected_session_id, state FROM submission_intents WHERE source_message_key = ?").get("pi-prompt")).toEqual({
      text: "run with pi", owner_id: piBinding.id, pane_id: "w1:pi", terminal_id: "term-pi",
      expected_agent_kind: "pi", expected_session_id: "pi-session", state: "prepared"
    }));
    expect(store.getPromptInputBySource("feishu", "pi-prompt")).toBeNull();
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
    await waitForProjectSelection(store, "m-async");
    await publisher.drain();
    await vi.waitFor(() => expect(findProjectCard(selectorCards, "alpha")).toBeDefined());
    const value = findProjectButton(findProjectCard(selectorCards, "alpha")!, "alpha").value as { selectionId: string; projectId: string; action: string };

    await expect(onAction!({ messageId: "selector-card", chatId: "chat", operatorOpenId: "user-1", value })).resolves.toEqual({ toast: { type: "success", content: "项目创建已开始。" } });
    expect(store.getProjectSelection(value.selectionId)?.state).toBe("processing");
    releasePane();
    await vi.waitFor(() => expect(store.getProjectSelection(value.selectionId)?.state).toBe("completed"));

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("submits a mentioned default-project bootstrap as one first-session Agent Input", async () => {
    const created: string[] = [];
    const prompts: string[] = [];
    const selectorCards: object[] = [];
    const groupCards: object[] = [];
    const answerUpdates: object[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic(card) { groupCards.push(card); return { topicId: "task-topic", rootMessageId: "task-root" }; },
      async replyText() { return { messageId: "text-1" }; },
      async replyCard(_root, card) { selectorCards.push(card); return { messageId: "selector-card" }; },
      async updateCard() {},
      async createStreamingCard(card) { selectorCards.push(card); return { cardId: "answer-card" }; },
      async replyStreamingCardReference() { return { messageId: "selector-card" }; },
      async streamCardContent() {},
      async finishStreamingCard() {},
      async updateCardKit(_messageId, card) { answerUpdates.push(card); }
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
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    const coordinator = createTestRouter(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    const message = { eventId: "natural-e1", messageId: "natural-m1", chatId: "chat", topicId: "natural-topic", rootMessageId: "natural-m1", actorOpenId: "user-1", text: "帮我排查登录超时", mentionsBot: true, isRootMessage: true };
    await coordinator.handleMessage(message);
    await coordinator.handleMessage(message);
    await vi.waitFor(() => expect(store.database.prepare("SELECT COUNT(*) AS count FROM submission_intents WHERE source_message_key = ?").get("natural-m1")).toEqual({ count: 1 }));
    expect(store.database.prepare("SELECT ingress_source, source_message_key, text, owner_kind, expected_session_id, state FROM submission_intents WHERE source_message_key = ?").get("natural-m1")).toEqual({
      ingress_source: "feishu:primary", source_message_key: "natural-m1", text: "帮我排查登录超时", owner_kind: "primary", expected_session_id: null, state: "prepared"
    });
    expect(prompts).toEqual([]);
    expect(store.database.prepare("SELECT (SELECT COUNT(*) FROM prompt_inputs) AS inputs, (SELECT COUNT(*) FROM native_input_batches) AS batches, (SELECT COUNT(*) FROM prompt_jobs) AS jobs").get()).toEqual({ inputs: 0, batches: 0, jobs: 0 });
    expect(created).toHaveLength(1);
    expect(created[0]).toMatch(/^[a-z0-9]{4}$/);
    expect(selectorCards).toHaveLength(0);
    expect(answerUpdates).toHaveLength(0);
    expect(answerUpdates.some((card) => JSON.stringify(card).includes('"action":"completion_action"'))).toBe(false);
    expect(groupCards).toHaveLength(1);
    expect(store.findBindingByPane("w1:p1")).toMatchObject({ creatorOpenId: "user-1", projectId: "alpha", workspaceId: "w1", title: `herdr / ${created[0]}` });
    const selection = store.database.prepare("SELECT id FROM project_selections WHERE command_message_id = ?").get("natural-m1") as { id: string };
    expect(store.getProjectSelection(selection.id)).toMatchObject({ state: "completed", selectedProjectId: "alpha", requestedTitle: "帮我排查登录超时", initialPromptText: "帮我排查登录超时" });

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
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    store.createPendingBinding({ id: "existing-binding", projectId: "bridge", workspaceId: "wH", chatId: "chat", topicId: "existing-topic", rootMessageId: "existing-root", title: "bridge / Existing" });
    store.updateBinding("existing-binding", { paneId: "wH:p1", state: "active" });

    await coordinator.handleMessage({ eventId: "e1", messageId: "command-1", chatId: "chat", topicId: "existing-topic", rootMessageId: "existing-root", actorOpenId: "user-1", text: "/swarm new Fix login", mentionsBot: true, isRootMessage: false });
    await waitForProjectSelection(store, "command-1");
    await publisher.drain();
    expect(created).toEqual([]);
    await vi.waitFor(() => expect(findProjectCard(cards, "datasage")).toBeDefined());
    const button = findProjectButton(findProjectCard(cards, "datasage")!, "datasage");
    const value = button.value as { selectionId: string; projectId: string; action: string };
    expect(store.getProjectSelection(value.selectionId)).toMatchObject({ selectorMessageId: "selector-card-1", requestedTitle: "Fix login" });

    const updatesBeforeUnauthorizedAction = updates.length;
    await onAction!({ messageId: "selector-card-1", chatId: "chat", operatorOpenId: "another-user", value });
    expect(updates).toHaveLength(updatesBeforeUnauthorizedAction);
    expect(created).toEqual([]);

    await onAction!({ messageId: "selector-card-1", chatId: "chat", operatorOpenId: "user-1", value });
    await onAction!({ messageId: "selector-card-1", chatId: "chat", operatorOpenId: "user-1", value });
    await vi.waitFor(() => expect(store.getProjectSelection(value.selectionId)?.state).toBe("completed"));
    await publisher.drain();

    expect(created).toEqual([["wD", "/work/datasage", {
      bindingId: expect.any(String), generation: 1, projectId: "datasage", placement: "dedicated-tab", title: expect.stringMatching(/^[a-z0-9]{4}$/),
      displayIdentity: { role: { kind: "managed-primary" } },
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
    const completedCard = updates.findLast((card) => JSON.stringify(card).includes("项目已打开"));
    expect(completedCard).toBeDefined();
    expect(JSON.stringify(completedCard)).toContain("datasage_semantic_knowledge");
    expect(JSON.stringify(completedCard)).toContain("发送话题入口");
    expect(JSON.stringify(completedCard)).toContain('\"action\":\"open_project_thread\"');
    expect(JSON.stringify(completedCard)).not.toContain("openMessageId");
    expect(JSON.stringify(completedCard)).not.toContain("client/chat/open");
    expect(JSON.stringify(completedCard)).not.toContain("当前话题");
    expect(JSON.stringify(completedCard)).not.toContain("**Workspace**");

    await coordinator.handleMessage({
      eventId: "e-first-prompt", messageId: "first-prompt", chatId: "chat", topicId: "project-topic-1", rootMessageId: "project-root-1",
      actorOpenId: "user-1", text: "start the task", mentionsBot: false, isRootMessage: false
    });
    await vi.waitFor(() => expect(store.database.prepare("SELECT text, pane_id, terminal_id, expected_agent_kind, state FROM submission_intents WHERE source_message_key = ?").get("first-prompt")).toEqual({
      text: "start the task", pane_id: "wD:p9", terminal_id: "term-9", expected_agent_kind: "traex", state: "prepared"
    }));
    expect(prompts).toEqual([]);
    expect(store.getPromptInputBySource("feishu", "first-prompt")).toBeNull();

    const openButton = findActionButton(completedCard, "open_project_thread");
    await onAction!({ messageId: "selector-card-1", chatId: "chat", operatorOpenId: "user-1", value: openButton.value });
    expect(shareThread).toHaveBeenCalledWith("project-topic-1", { messageId: "selector-card-1", chatId: "chat", sourceRootMessageId: "project-root-1" });

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
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    const coordinator = createTestRouter(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "e-random", messageId: "command-random", chatId: "chat", topicId: "topic-random", rootMessageId: "root-random", actorOpenId: "user-1", text: "/swarm new", mentionsBot: true, isRootMessage: true });
    await waitForProjectSelection(store, "command-random");
    await publisher.drain();
    await vi.waitFor(() => expect(findProjectCard(selectorCards, "alpha")).toBeDefined());
    const value = findProjectButton(findProjectCard(selectorCards, "alpha")!, "alpha").value as { selectionId: string; projectId: string; action: string };
    await onAction!({ messageId: "selector-card-1", chatId: "chat", operatorOpenId: "user-1", value });
    await vi.waitFor(() => expect(store.getProjectSelection(value.selectionId)?.state).toBe("completed"));

    const paneName = created[0]?.title;
    expect(paneName).toMatch(/^[a-z0-9]{4}$/);
    expect(store.findBindingByPane("w1:p7")).toMatchObject({ title: `herdr / ${paneName}` });
    expect(JSON.stringify(groupCards[0])).toContain(`herdr / ${paneName}`);

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
    const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
    const coordinator = createTestRouter(configForTests(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "e-fail", messageId: "command-fail", chatId: "chat", topicId: null, rootMessageId: "command-fail", actorOpenId: "user-1", text: "/swarm new Broken", mentionsBot: true, isRootMessage: true });
    await waitForProjectSelection(store, "command-fail");
    await publisher.drain();
    await vi.waitFor(() => expect(findProjectCard(selectorCards, "alpha")).toBeDefined());
    const value = findProjectButton(findProjectCard(selectorCards, "alpha")!, "alpha").value;
    await onAction!({ messageId: "selector-card-1", chatId: "chat", operatorOpenId: "user-1", value });
    await vi.waitFor(() => expect(store.getProjectSelection((value as { selectionId: string }).selectionId)?.error).toBe("group card unavailable"));
    await publisher.drain();

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
    await waitForProjectSelection(store, "command-not-ready");
    await publisher.drain();
    await vi.waitFor(() => expect(findProjectCard(selectorCards, "alpha")).toBeDefined());
    const value = findProjectButton(findProjectCard(selectorCards, "alpha")!, "alpha").value;
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

function findProjectCard(cards: object[], projectId: string): object | undefined {
  return cards.find((card) => {
    try { findProjectButton(card, projectId); return true; } catch { return false; }
  });
}

function findActionButton(card: object, action: string): { value: unknown } {
  const elements = (card as { body: { elements: Array<{ behaviors?: Array<{ type?: string; value?: { action?: string } }> }> } }).body.elements;
  const button = elements.find((element) => element.behaviors?.some((behavior) => behavior.type === "callback" && behavior.value?.action === action));
  if (!button) throw new Error(`Missing action button: ${action}`);
  return { value: button.behaviors!.find((behavior) => behavior.type === "callback")!.value };
}

async function waitForProjectSelection(store: SqliteBindingStore, commandMessageId: string): Promise<{ id: string; state: string }> {
  let selection: { id: string; state: string } | undefined;
  await vi.waitFor(() => {
    selection = store.database.prepare("SELECT id, state FROM project_selections WHERE command_message_id = ?").get(commandMessageId) as { id: string; state: string } | undefined;
    expect(selection).toBeDefined();
  });
  return selection!;
}
