import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { ConversationViewProjector } from "../src/events/conversation-view-projector.js";
import { LarkOutboxDispatcher } from "../src/events/lark-outbox-dispatcher.js";
import { InProcessInboundWorkNotifier } from "../src/events/inbound-work-notifier.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("Herdr discovery", () => {
  it("logs an unchanged skipped pane once and reports when it becomes routable", async () => {
    let cwd = "/unregistered";
    const warn = vi.fn();
    const info = vi.fn();
    const logger = { warn, info, error: vi.fn(), debug: vi.fn() } as unknown as import("pino").Logger;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text-1" }; }, async replyCard() { return { messageId: "reply-1" }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd, label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {}
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
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, logger);

    await coordinator.start();
    await coordinator.reconcile();
    expect(warn.mock.calls.filter(([context]) => context.event === "herdr-pane-skipped")).toHaveLength(1);

    cwd = "/repo";
    await coordinator.reconcile();
    expect(info).toHaveBeenCalledWith(expect.objectContaining({ event: "herdr-pane-skip-resolved", paneId: "w1:p1", projectId: "default" }), expect.any(String));
    expect(store.findBindingByPane("w1:p1")).toMatchObject({ projectId: "default", state: "active" });

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("publishes repeated working state once while preserving distinct output observations", async () => {
    let output = "initial terminal";
    const submittedPrompts: string[] = [];
    const events: string[] = [];
    const answerSnapshots: string[] = [];
    const answerUpdates: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text-1" }; }, async replyCard() { return { messageId: "request-card-1" }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, text, _timeoutMs, onObservation) {
        submittedPrompts.push(text);
        output += "\n✧ Working";
        await onObservation?.({ state: "working", stateSource: "structured", output });
        output += "\n◆ Ran first";
        await onObservation?.({ state: "working", stateSource: "structured", output });
        output += "\n◆ Ran second";
        await onObservation?.({ state: "working", stateSource: "structured", output });
        output += "\n◆ done\n────────";
        await onObservation?.({ state: "done", stateSource: "structured", output });
        return "done";
      },
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
    const stopObserver = bus.onBridgeEvent((event) => {
      if (event.type === "AgentStateChanged" || event.type === "TurnOutputObserved" || event.type === "TurnCompleted") events.push(event.type + (event.type === "AgentStateChanged" ? `:${event.payload.state}` : ""));
      if (event.type === "TurnOutputObserved") {
        answerSnapshots.push(event.payload.answerSnapshot);
        answerUpdates.push(event.payload.answerUpdate ?? "replace");
      }
    });
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    const stopPublisher = publisher.start();
    const stopProjector = new ConversationViewProjector(bus, store, publisher, pino({ enabled: false })).start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "event-dedup", messageId: "message-dedup", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text: "run", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards(store.listBindings()[0]!.id)[0]).toMatchObject({ phase: "completed" }));

    expect(events.filter((event) => event === "AgentStateChanged:working")).toHaveLength(1);
    expect(events.filter((event) => event === "TurnOutputObserved")).toHaveLength(4);
    expect(events.filter((event) => event === "AgentStateChanged:done")).toHaveLength(1);
    expect(answerSnapshots).toEqual(["✧ Working", "◆ Ran first", "◆ Ran second", "◆ done"]);
    expect(answerUpdates).toEqual(["append", "append", "append", "append"]);
    expect(store.listRunCards(store.listBindings()[0]!.id)[0]?.answer).toBe("✧ Working\n\n◆ Ran first\n\n◆ Ran second\n\n◆ done");
    expect(submittedPrompts).toEqual(["run"]);
    const completedBeforeReconcile = events.filter((event) => event === "TurnCompleted").length;
    const doneBeforeReconcile = events.filter((event) => event === "AgentStateChanged:done").length;
    await coordinator.reconcile();
    expect(events.filter((event) => event === "TurnCompleted")).toHaveLength(completedBeforeReconcile);
    expect(events.filter((event) => event === "AgentStateChanged:done")).toHaveLength(doneBeforeReconcile);

    await coordinator.stop(); stopObserver(); stopProjector(); stopPublisher(); store.close();
  });

  it("ignores unknown runtime state observations while preserving terminal output", async () => {
    let output = "initial terminal";
    const events: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text-1" }; }, async replyCard() { return { messageId: "request-card-1" }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, _text, _timeoutMs, onObservation) {
        output += "\n◆ partial answer";
        await onObservation?.({ state: "unknown", stateSource: "unknown", output });
        output += "\n◆ final answer\n────────";
        await onObservation?.({ state: "done", stateSource: "structured", output });
        return "done";
      },
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
    const stopObserver = bus.onBridgeEvent((event) => {
      if (event.type === "AgentStateChanged" || event.type === "TurnOutputObserved") events.push(event.type + (event.type === "AgentStateChanged" ? `:${event.payload.state}` : ""));
    });
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    const stopPublisher = publisher.start();
    const stopProjector = new ConversationViewProjector(bus, store, publisher, pino({ enabled: false })).start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "event-unknown", messageId: "message-unknown", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text: "run", mentionsBot: false, isRootMessage: false });
    const bindingId = store.findBindingByPane("w1:p1")!.id;
    await vi.waitFor(() => expect(store.listRunCards(bindingId)[0]).toMatchObject({ phase: "completed" }));

    expect(events).toContain("TurnOutputObserved");
    expect(events).not.toContain("AgentStateChanged:unknown");
    expect(events).toContain("AgentStateChanged:done");
    expect(store.findBindingByPane("w1:p1")).toMatchObject({ lastAgentState: "done" });

    await coordinator.stop(); stopObserver(); stopProjector(); stopPublisher(); store.close();
  });

  it("uses the root card as the status card instead of posting a second card", async () => {
    let created = 0; let replied = 0; let updated = 0; let rootCard: object | null = null;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic(card) { created += 1; rootCard = card; return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text-1" }; },
      async replyCard() { replied += 1; return { messageId: "reply-1" }; },
      async updateCard() { updated += 1; }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/work/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {}
    };
    const config = {
      lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
      herdr: { workspaceId: "w1", workspaceCwd: "/work/repo", executable: "herdr" },
      projects: [{ id: "repo", displayName: "Repo", spaceName: "configured-space", description: "Test project", workspaceId: "w1", cwd: "/work/repo" }], defaultProjectId: "repo", projectsConfigPath: "test", traex: { executable: "traex" },
      databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent",
      commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
    } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    const stopChannelPublisher = publisher.start();
    const stopProjector = new ConversationViewProjector(bus, store, publisher, pino({ enabled: false })).start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await publisher.drain();
    expect({ created, replied, updated }).toEqual({ created: 1, replied: 0, updated: 2 });
    expect(store.findBindingByPane("w1:p1")).toMatchObject({ title: "configured-space / task", statusMessageId: "root-1", state: "active" });
    expect(JSON.stringify(rootCard)).toContain("TraeX · configured-space / task");

    await coordinator.stop(); stopProjector(); stopChannelPublisher(); store.close();
  });

  it("uses the configured project for Lark creation and preserves it on rename", async () => {
    const renamed: Array<[string, string, unknown]> = [];
    const created: unknown[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; },
      async replyText() { return { messageId: "text-1" }; },
      async replyCard() { return { messageId: "card-1" }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return []; },
      async getPane() { return { paneId: "w1:p2", tabId: "w1:t2", workspaceId: "w1", cwd: "/work/my-project", label: "Initial pane", agentState: "idle", foregroundExecutables: ["traex"] }; },
      async observeRuntime() { const pane = await this.getPane("w1:p2"); return { pane, traexProcess: true, composerReady: true, evidenceSource: "structured" }; },
      async createPane(workspaceId, cwd, options) { created.push(options); return { paneId: "w1:p2", tabId: "w1:t2", workspaceId, cwd, label: null, agentState: "idle", foregroundExecutables: [] }; },
      async startTraex() {}, async runPrompt() { return "done"; }, async readOutput() { return ""; },
      async renamePane(paneId, title, options) { renamed.push([paneId, title, options]); }
    };
    const config = {
      lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
      herdr: { workspaceId: "w1", workspaceCwd: "/work/my-project", executable: "herdr" },
      projects: [{ id: "my-project", displayName: "My project", spaceName: "my-space", description: "Test project", workspaceId: "w1", cwd: "/work/my-project" }], defaultProjectId: "my-project", projectsConfigPath: "test", traex: { executable: "traex" },
      databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent",
      commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
    } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    const stopPublisher = publisher.start();
    const stopProjector = new ConversationViewProjector(bus, store, publisher, pino({ enabled: false })).start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "new", messageId: "root-2", chatId: "chat", topicId: "topic-2", rootMessageId: "root-2", actorOpenId: "user", text: "/herdr new Initial pane", mentionsBot: true, isRootMessage: true });
    await publisher.drain();
    const selection = (store.database.prepare("SELECT id FROM project_selections WHERE command_message_id = ?").get("root-2") as { id: string }).id;
    expect(selection).toBeTruthy();
    await coordinator.handleCardAction({ messageId: "card-1", chatId: "chat", operatorOpenId: "user", value: { action: "select_project", selectionId: selection, projectId: "my-project" } });
    expect(created).toEqual([{ bindingId: expect.any(String), generation: 1, projectId: "my-project", placement: "dedicated-tab", title: "Initial pane" }]);
    expect(store.findBindingByPane("w1:p2")).toMatchObject({ title: "my-space / Initial pane" });

    await coordinator.handleMessage({ eventId: "rename", messageId: "message-2", chatId: "chat", topicId: "unused", rootMessageId: "unused", actorOpenId: "user", text: "/herdr rename Better pane", mentionsBot: false, isRootMessage: false });
    expect(renamed).toEqual([["w1:p2", "Better pane", { tabTitle: "Better pane" }]]);
    expect(store.findBindingByPane("w1:p2")).toMatchObject({ title: "my-space / Better pane" });

    await coordinator.stop(); stopProjector(); stopPublisher(); store.close();
  });

  it("forwards changed TraeX terminal output even when Herdr continues to report idle", async () => {
    let output = "initial terminal";
    const updates: object[] = [];
    const replies: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText(_rootMessageId, text) { replies.push(text); return { messageId: "text-1" }; },
      async replyCard() { return { messageId: "reply-1" }; },
      async updateCard(_messageId, card) { updates.push(card); }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt() { return "done"; }, async readOutput() { return output; }, async renamePane() {}
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
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    const stopChannelPublisher = publisher.start();
    const stopProjector = new ConversationViewProjector(bus, store, publisher, pino({ enabled: false })).start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    output = "initial terminal\n❯ next prompt";
    await coordinator.reconcile();
    expect(replies).toEqual([]);

    output = "initial terminal\n❯ next prompt\n◆ TraeX local answer\n────────";
    await coordinator.reconcile();
    await publisher.drain();

    expect(JSON.stringify(updates.at(-1))).toContain("已完成");
    expect(JSON.stringify(updates.at(-1))).toContain("TraeX local answer");
    expect(replies).toEqual([]);
    await coordinator.stop(); stopProjector(); stopChannelPublisher(); store.close();
  });

  it("does not treat a TraeX welcome-screen icon as a completed answer", async () => {
    let output = "╭────╮\n│ █ ◆ ◆ █ │\n╰────╯";
    const replies: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText(_rootMessageId, text) { replies.push(text); return { messageId: "text-1" }; },
      async replyCard() { return { messageId: "reply-1" }; },
      async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt() { return "done"; }, async readOutput() { return output; }, async renamePane() {}
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
    const stopChannelPublisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false })).start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, new LarkOutboxDispatcher(store, lark, pino({ enabled: false })), pino({ enabled: false }));
    await coordinator.start();

    output = `${output}\n◆ actual answer`;
    await coordinator.reconcile();

    expect(replies).toEqual([]);
    await coordinator.stop(); stopChannelPublisher(); store.close();
  });

  it("creates one request card and updates it without text replies", async () => {
    let output = "initial terminal";
    const replies: string[] = [];
    const cards: object[] = [];
    const updates: Array<{ messageId: string; card: object }> = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText(_rootMessageId, text) { replies.push(text); return { messageId: "text-1" }; },
      async replyCard(_root, card) { cards.push(card); return { messageId: "request-card-1" }; },
      async updateCard(messageId, card) { updates.push({ messageId, card }); }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt() { output = `${output}\n◆ thread reply\n────────`; return "done"; }, async readOutput() { return output; }, async renamePane() {}
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
    const inboundEvents: string[] = [];
    const inboundWork = new InProcessInboundWorkNotifier();
    const stopInboundObserver = inboundWork.subscribe((event) => { inboundEvents.push(event.type); });
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    const stopChannelPublisher = publisher.start();
    const projector = new ConversationViewProjector(bus, store, publisher, pino({ enabled: false }));
    const stopProjector = projector.start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, inboundWork);
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "event-1", messageId: "message-1", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text: "run it", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards(store.listBindings()[0]!.id)[0]).toMatchObject({ phase: "completed", answer: "thread reply", larkMessageId: "request-card-1", answerMessageId: "request-card-1" }));
    await vi.waitFor(() => expect(updates.some((update) => update.messageId === "request-card-1" && JSON.stringify(update.card).includes("thread reply"))).toBe(true));
    expect(cards).toHaveLength(1);
    expect(updates.some((update) => JSON.stringify(update.card).includes("HERDR REQUEST"))).toBe(false);
    expect(replies).toEqual([]);
    expect(inboundEvents).toEqual(["InboundMessageReceived"]);

    await coordinator.stop(); stopInboundObserver(); stopProjector(); stopChannelPublisher(); store.close();
  });

  it("shows terminal approval and keeps later prompts queued until the active turn resumes", async () => {
    let output = "initial terminal";
    let releaseApproval!: () => void;
    const approval = new Promise<void>((resolve) => { releaseApproval = resolve; });
    const prompts: string[] = [];
    const updates: object[] = [];
    const replies: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText(_rootMessageId, text) { replies.push(text); return { messageId: `text-${replies.length}` }; },
      async replyCard() { return { messageId: "reply-1" }; },
      async updateCard(_messageId, card) { updates.push(card); }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, text, _timeoutMs, onObservation) {
        prompts.push(text);
        await onObservation?.({ state: "working", stateSource: "structured", output });
        if (prompts.length === 1) {
          await onObservation?.({ state: "blocked", stateSource: "structured", output });
          await approval;
          await onObservation?.({ state: "working", stateSource: "structured", output });
        }
        output = `${output}\n◆ answer ${prompts.length}\n────────`;
        await onObservation?.({ state: "done", stateSource: "structured", output });
        return "done";
      },
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
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    const stopPublisher = publisher.start();
    const stopProjector = new ConversationViewProjector(bus, store, publisher, pino({ enabled: false })).start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    const bindingId = store.findBindingByPane("w1:p1")!.id;

    await coordinator.handleMessage({ eventId: "event-1", messageId: "message-1", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text: "first", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(updates.some((card) => JSON.stringify(card).includes("等待用户处理"))).toBe(true));
    expect(updates.some((card) => JSON.stringify(card).includes("TraeX 需要人工审批"))).toBe(true);
    await coordinator.handleMessage({ eventId: "event-2", messageId: "message-2", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text: "second", mentionsBot: false, isRootMessage: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe("first");
    expect(store.countPendingPrompts(bindingId)).toBe(2);

    releaseApproval();
    await vi.waitFor(() => expect(prompts).toHaveLength(2));
    expect(prompts[1]).toBe("second");
    await vi.waitFor(() => expect(store.listRunCards(bindingId).at(-1)).toMatchObject({ phase: "completed", answer: "◆ answer 2" }));
    expect(replies).toEqual([]);

    await coordinator.stop(); stopProjector(); stopPublisher(); store.close();
  });

  it("does not dispatch a queued prompt after a blocked turn times out", async () => {
    let rejectBlockedTurn!: () => void;
    const blockedTurn = new Promise<void>((_resolve, reject) => {
      rejectBlockedTurn = () => reject(new Error("Timed out waiting for TraeX turn in pane w1:p1"));
    });
    const prompts: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text-1" }; }, async replyCard() { return { messageId: "reply-1" }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, text, _timeoutMs, onObservation) {
        prompts.push(text);
        if (prompts.length === 1) {
          await onObservation?.({ state: "blocked", stateSource: "structured", output: "terminal" });
          await blockedTurn;
        }
        return "done";
      },
      async readOutput() { return "terminal"; }, async renamePane() {}
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
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    const stopPublisher = publisher.start();
    const stopProjector = new ConversationViewProjector(bus, store, publisher, pino({ enabled: false })).start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    const bindingId = store.findBindingByPane("w1:p1")!.id;

    await coordinator.handleMessage({ eventId: "event-timeout-1", messageId: "message-timeout-1", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text: "first", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.findBindingByPane("w1:p1")).toMatchObject({ lastAgentState: "blocked" }));
    await coordinator.handleMessage({ eventId: "event-timeout-2", messageId: "message-timeout-2", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text: "second", mentionsBot: false, isRootMessage: false });
    rejectBlockedTurn();
    await vi.waitFor(() => expect(store.countPendingPrompts(bindingId)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(prompts).toHaveLength(1);
    expect(prompts[0]).toBe("first");
    expect(store.countPendingPrompts(bindingId)).toBe(1);

    await coordinator.stop(); stopProjector(); stopPublisher(); store.close();
  });

  it("keeps a message retryable when a card projection fails during prompt acceptance", async () => {
    const replies: string[] = [];
    let failCard = true;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText(_rootMessageId, text) { replies.push(text); return { messageId: `text-${replies.length}` }; },
      async replyCard() { return { messageId: "reply-1" }; },
      async updateCard() { if (failCard) throw new Error("temporary card failure"); }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {}
    };
    const config = {
      lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
      herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" },
      projects: [{ id: "default", displayName: "Default project", description: "Test project", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" },
      databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent",
      commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
    } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:");
    const atomicClaim = vi.spyOn(store, "claimNextDispatchablePrompt");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", statusMessageId: "status-1" });
    const bus = new BridgeEventBus();
    const publisher = new LarkOutboxDispatcher(store, lark, pino({ enabled: false }));
    const stopPublisher = publisher.start();
    const stopProjector = new ConversationViewProjector(bus, store, publisher, pino({ enabled: false })).start();
    const coordinator = createTestRouter(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "event-retry", messageId: "message-retry", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text: "run it", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")).toHaveLength(1));
    await vi.waitFor(() => expect(store.countPendingPrompts("b1")).toBe(0));
    expect(atomicClaim).toHaveBeenCalledWith("b1");
    failCard = false;
    expect(replies).toEqual([]);

    await coordinator.stop(); stopProjector(); stopPublisher(); store.close();
  });
});
