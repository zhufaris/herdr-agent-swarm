import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { SyncCoordinator } from "../src/coordinator/sync-coordinator.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { CardProjector } from "../src/events/card-projector.js";
import { LarkChannelPublisher } from "../src/events/lark-channel-publisher.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("Herdr discovery", () => {
  it("uses the root card as the status card instead of posting a second card", async () => {
    let created = 0; let replied = 0; let updated = 0;
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { created += 1; return { topicId: "topic-1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text-1" }; },
      async replyCard() { replied += 1; return { messageId: "reply-1" }; },
      async updateCard() { updated += 1; }
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {}
    };
    const config = {
      lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
      herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, traex: { executable: "traex" },
      databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent",
      commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
    } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false }));
    const stopChannelPublisher = publisher.start();
    const stopProjector = new CardProjector(bus, store, publisher, pino({ enabled: false })).start();
    const coordinator = new SyncCoordinator(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await publisher.drain();
    expect({ created, replied, updated }).toEqual({ created: 1, replied: 0, updated: 2 });
    expect(store.findBindingByPane("w1:p1")).toMatchObject({ statusMessageId: "root-1", state: "active" });

    await coordinator.stop(); stopProjector(); stopChannelPublisher(); store.close();
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
      herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, traex: { executable: "traex" },
      databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent",
      commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
    } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false }));
    const stopChannelPublisher = publisher.start();
    const stopProjector = new CardProjector(bus, store, publisher, pino({ enabled: false })).start();
    const coordinator = new SyncCoordinator(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    output = "initial terminal\n❯ next prompt";
    await coordinator.reconcile();
    expect(replies).toEqual([]);

    output = "initial terminal\n❯ next prompt\n◆ TraeX local answer\n────────";
    await coordinator.reconcile();
    await publisher.drain();

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
      herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, traex: { executable: "traex" },
      databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent",
      commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
    } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const stopChannelPublisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })).start();
    const coordinator = new SyncCoordinator(config, store, herdr, lark, bus, new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })), pino({ enabled: false }));
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
      herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, traex: { executable: "traex" },
      databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent",
      commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
    } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const inboundEvents: string[] = [];
    const stopInboundObserver = bus.onInboundMessage((event) => { inboundEvents.push(event.type); });
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false }));
    const stopChannelPublisher = publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false }));
    const stopProjector = projector.start();
    const coordinator = new SyncCoordinator(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "event-1", messageId: "message-1", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text: "run it", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards(store.listBindings()[0]!.id)[0]).toMatchObject({ phase: "completed", answer: "thread reply", larkMessageId: "request-card-1" }));
    await vi.waitFor(() => expect(JSON.stringify(updates.at(-1)?.card)).toContain("thread reply"));
    expect(cards).toHaveLength(1);
    const requestUpdates = updates.filter((update) => JSON.stringify(update.card).includes("HERDR REQUEST"));
    expect(requestUpdates.length).toBeGreaterThan(0);
    expect(requestUpdates.every((update) => update.messageId === "request-card-1")).toBe(true);
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
        await onObservation?.({ state: "working", output });
        if (prompts.length === 1) {
          await onObservation?.({ state: "blocked", output });
          await approval;
          await onObservation?.({ state: "working", output });
        }
        output = `${output}\n◆ answer ${prompts.length}\n────────`;
        await onObservation?.({ state: "done", output });
        return "done";
      },
      async readOutput() { return output; }, async renamePane() {}
    };
    const config = {
      lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
      herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, traex: { executable: "traex" },
      databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent",
      commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
    } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false }));
    const stopPublisher = publisher.start();
    const stopProjector = new CardProjector(bus, store, publisher, pino({ enabled: false })).start();
    const coordinator = new SyncCoordinator(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    const bindingId = store.findBindingByPane("w1:p1")!.id;

    await coordinator.handleMessage({ eventId: "event-1", messageId: "message-1", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text: "first", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(JSON.stringify(updates.at(-1))).toContain("等待终端审批"));
    await coordinator.handleMessage({ eventId: "event-2", messageId: "message-2", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text: "second", mentionsBot: false, isRootMessage: false });
    await new Promise((resolve) => setTimeout(resolve, 20));
    expect(prompts).toEqual(["first"]);
    expect(store.countPendingPrompts(bindingId)).toBe(2);

    releaseApproval();
    await vi.waitFor(() => expect(prompts).toEqual(["first", "second"]));
    await vi.waitFor(() => expect(store.listRunCards(bindingId).at(-1)).toMatchObject({ phase: "completed", answer: "answer 2" }));
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
          await onObservation?.({ state: "blocked", output: "terminal" });
          await blockedTurn;
        }
        return "done";
      },
      async readOutput() { return "terminal"; }, async renamePane() {}
    };
    const config = {
      lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
      herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, traex: { executable: "traex" },
      databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent",
      commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
    } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:");
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false }));
    const stopPublisher = publisher.start();
    const stopProjector = new CardProjector(bus, store, publisher, pino({ enabled: false })).start();
    const coordinator = new SyncCoordinator(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    const bindingId = store.findBindingByPane("w1:p1")!.id;

    await coordinator.handleMessage({ eventId: "event-timeout-1", messageId: "message-timeout-1", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text: "first", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.findBindingByPane("w1:p1")).toMatchObject({ lastAgentState: "blocked" }));
    await coordinator.handleMessage({ eventId: "event-timeout-2", messageId: "message-timeout-2", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text: "second", mentionsBot: false, isRootMessage: false });
    rejectBlockedTurn();
    await vi.waitFor(() => expect(store.countPendingPrompts(bindingId)).toBe(1));
    await new Promise((resolve) => setTimeout(resolve, 20));

    expect(prompts).toEqual(["first"]);
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
      herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, traex: { executable: "traex" },
      databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent",
      commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
    } as const satisfies BridgeConfig;
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", statusMessageId: "status-1" });
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false }));
    const stopPublisher = publisher.start();
    const stopProjector = new CardProjector(bus, store, publisher, pino({ enabled: false })).start();
    const coordinator = new SyncCoordinator(config, store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ eventId: "event-retry", messageId: "message-retry", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text: "run it", mentionsBot: false, isRootMessage: false });
    await vi.waitFor(() => expect(store.listRunCards("b1")).toHaveLength(1));
    await vi.waitFor(() => expect(store.countPendingPrompts("b1")).toBe(0));
    failCard = false;
    expect(replies).toEqual([]);

    await coordinator.stop(); stopProjector(); stopPublisher(); store.close();
  });
});
