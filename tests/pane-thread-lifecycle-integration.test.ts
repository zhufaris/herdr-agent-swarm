import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { SyncCoordinator } from "../src/coordinator/sync-coordinator.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { CardProjector } from "../src/events/card-projector.js";
import { LarkChannelPublisher } from "../src/events/lark-channel-publisher.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("pane/thread lifecycle integration", () => {
  it("drains the active turn, cancels queued work, then archives without closing the pane", async () => {
    let finish!: () => void;
    const activeTurn = new Promise<void>((resolve) => { finish = resolve; });
    const submitted: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: `card-${Math.random()}` }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }]; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt(_paneId, text) { submitted.push(text); await activeTurn; return "done"; }, async readOutput() { return "◆ done\n────────"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active" });
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false })); projector.start();
    const coordinator = new SyncCoordinator(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage(message(1, "first"));
    await vi.waitFor(() => expect(submitted).toHaveLength(1));
    await coordinator.handleMessage(message(2, "second"));
    await coordinator.handleMessage({ ...message(3, "/herdr close"), mentionsBot: true });

    expect(store.listBindings()[0]).toMatchObject({ lifecycle: "draining", state: "active" });
    expect(store.getOperationalSummary().prompts).toMatchObject({ running: 1, cancelled: 1 });
    finish();
    await vi.waitFor(() => expect(store.listBindings()[0]).toMatchObject({ lifecycle: "archived", state: "archived" }));
    expect(submitted).toHaveLength(1);

    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("reattaches an orphaned session without replay, then resumes explicitly", async () => {
    const submitted: string[] = [];
    const pane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; },
      async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: `card-${Math.random()}` }; }, async updateCard() {}
    };
    const herdr: HerdrPort = {
      async assertWorkspace() {}, async listPanes() { return [pane]; }, async getPane(id) { return id === pane.paneId ? pane : null; },
      async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt(_paneId, text) { submitted.push(text); return "done"; },
      async readOutput() { return "◆ done\n────────"; }, async renamePane() {}
    };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active" });
    store.transitionBinding("b1", { type: "pane_probe_failed", confirmedMissing: true, orphanThreshold: 2 });
    store.enqueuePrompt({ id: "queued", bindingId: "b1", larkMessageId: "old-message", actorOpenId: "user", body: "do not replay" });
    const bus = new BridgeEventBus();
    const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const projector = new CardProjector(bus, store, publisher, pino({ enabled: false })); projector.start();
    const coordinator = new SyncCoordinator(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();

    await coordinator.handleMessage({ ...message(10, "/herdr reattach w1:p1"), mentionsBot: true });
    expect(store.listBindings()[0]).toMatchObject({ lifecycle: "archived", attachment: "attached", generation: 1 });
    expect(submitted).toEqual([]);

    await coordinator.handleMessage({ ...message(11, "/herdr resume"), mentionsBot: true });
    expect(store.listBindings()[0]).toMatchObject({ lifecycle: "active", attachment: "attached", generation: 1 });
    // The queued job has no delivered cards, so it remains visible/non-runnable instead of being replayed.
    expect(submitted).toEqual([]);
    await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close();
  });

  it("uses hysteresis for transient workspace probe failures", async () => {
    let failWorkspace = false;
    const pane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const lark: LarkPort = { async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "unused", rootMessageId: "unused" }; }, async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {} };
    const herdr: HerdrPort = { async assertWorkspace() {}, async listPanes() { if (failWorkspace) throw new Error("timeout"); return [pane]; }, async getPane() { return pane; }, async createPane() { return pane; }, async startTraex() {}, async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {} };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "repo / task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active" });
    const bus = new BridgeEventBus(); const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
    const coordinator = new SyncCoordinator(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
    await coordinator.start();
    failWorkspace = true;
    await coordinator.reconcile();
    expect(store.listBindings()[0]).toMatchObject({ attachment: "degraded", degradationCount: 1 });
    await coordinator.reconcile();
    expect(store.listBindings()[0]).toMatchObject({ attachment: "orphaned", degradationCount: 2, state: "orphaned" });
    await coordinator.stop(); await publisher.stop(); store.close();
  });
});

function message(index: number, text: string) {
  return { eventId: `e${index}`, messageId: `m${index}`, chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false };
}

function config(): BridgeConfig {
  return {
    lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
    herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" },
    projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "repo", projectsConfigPath: "test", traex: { executable: "traex" },
    databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
  };
}
