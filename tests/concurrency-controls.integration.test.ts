import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { SyncCoordinator } from "../src/coordinator/sync-coordinator.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { LarkChannelPublisher } from "../src/events/lark-channel-publisher.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";

describe("coordinator concurrency controls", () => {
  it("coalesces concurrent reconciliation calls into one workspace scan", async () => {
    let block = false;
    let release!: () => void;
    let blocked = Promise.resolve();
    let scans = 0;
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { scans += 1; if (block) await blocked; return []; },
      async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {},
      async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {}
    };
    const { coordinator, publisher, store } = fixture(herdr);
    await coordinator.start();
    scans = 0; block = true; blocked = new Promise<void>((resolve) => { release = resolve; });

    const first = coordinator.reconcile();
    const second = coordinator.reconcile();
    await vi.waitFor(() => expect(scans).toBe(1));
    release();
    await Promise.all([first, second]);
    expect(scans).toBe(1);

    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("uses scoped binding queries for one reconciliation pass", async () => {
    const { coordinator, publisher, store } = fixture(emptyHerdr());
    await coordinator.start();
    const original = store.listBindingsByState.bind(store);
    const states: string[] = [];
    store.listBindingsByState = (state) => { states.push(state); return original(state); };
    store.listBindings = () => { throw new Error("reconcile must not load every binding"); };

    await coordinator.reconcile();

    expect(states).toEqual(["active"]);
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("loads affected run cards once when a Pane is missing", async () => {
    const { coordinator, publisher, store } = fixture(emptyHerdr());
    await coordinator.start();
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active" });
    for (const [promptId, phase] of [["running", "running"], ["blocked", "blocked"], ["queued", "queued"], ["done", "completed"]] as const) {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 1, occurredAt: "2026-08-23T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "u1", body: promptId }, view, rootMessageId: "m1", answerCard: {} });
      store.saveRunCard({ ...store.loadRunCard(promptId)!, phase });
    }
    const original = store.listRunCardsByPhases.bind(store);
    const calls: string[][] = [];
    store.listRunCardsByPhases = (bindingId, phases) => { calls.push([...phases]); return original(bindingId, phases); };
    store.listRunCards = () => { throw new Error("missing-Pane reconciliation must use a phase query"); };

    await coordinator.reconcile();

    expect(calls).toEqual([["running", "blocked", "queued"]]);
    expect(store.loadRunCard("running")).toMatchObject({ phase: "failed", queuePosition: 0 });
    expect(store.loadRunCard("blocked")).toMatchObject({ phase: "failed", queuePosition: 0 });
    expect(store.loadRunCard("queued")).toMatchObject({ phase: "blocked", queuePosition: 1 });
    expect(store.loadRunCard("done")).toMatchObject({ phase: "completed", viewVersion: 1 });
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("uses one inbound consumer so concurrent messages remain ordered", async () => {
    let releaseFirst!: () => void;
    const firstBlocked = new Promise<void>((resolve) => { releaseFirst = resolve; });
    const replies: string[] = [];
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; },
      async replyText() { return { messageId: "text" }; },
      async replyCard(rootMessageId) { if (rootMessageId === "m1") await firstBlocked; replies.push(rootMessageId); return { messageId: `card-${rootMessageId}` }; },
      async updateCard() {}
    };
    const { coordinator, publisher, store } = fixture(emptyHerdr(), lark);
    await coordinator.start();
    const first = coordinator.handleMessage(message(1));
    await vi.waitFor(() => expect(store.database.prepare("SELECT state FROM inbound_messages WHERE event_id = 'e1'").get()).toMatchObject({ state: "processing" }));
    const second = coordinator.handleMessage(message(2));
    await new Promise((resolve) => setTimeout(resolve, 0));
    expect(store.database.prepare("SELECT state FROM inbound_messages WHERE event_id = 'e2'").get()).toMatchObject({ state: "received" });

    releaseFirst();
    await Promise.all([first, second]);
    expect(replies).toEqual(["m1", "m2"]);
    expect(store.database.prepare("SELECT state FROM inbound_messages ORDER BY created_at, event_id").all()).toEqual([{ state: "accepted" }, { state: "accepted" }]);
    await coordinator.stop(); await publisher.stop(); store.close();
  });

  it("starts a queued prompt after its initial answer card succeeds on retry", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    let failReply = true;
    let runCount = 0;
    const herdr: HerdrPort = {
      async assertWorkspace() {},
      async listPanes() { return [{ paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", title: "Task", foregroundExecutables: ["traex"], agentState: "idle" }]; },
      async getPane() { return null; },
      async createPane() { throw new Error("not used"); },
      async startTraex() {},
      async runPrompt() { runCount += 1; return "done"; },
      async readOutput() { return ""; },
      async renamePane() {}
    };
    const lark: LarkPort = {
      async start() {}, async stop() {}, isReady: () => true,
      async createTopic() { return { topicId: "t1", rootMessageId: "root-1" }; },
      async replyText() { return { messageId: "text" }; },
      async replyCard() { return { messageId: "legacy" }; },
      async updateCard() {},
      async createStreamingCard() { return { cardId: "cardkit-1" }; },
      async replyStreamingCardReference() {
        if (failReply) { failReply = false; throw new Error("temporary"); }
        return { messageId: "answer-1" };
      },
      async streamCardContent() {},
      async finishStreamingCard() {}
    };
    const { coordinator, publisher, store } = fixture(herdr, lark);
    try {
      store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", title: "Task" });
      store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
      await coordinator.start();

      await coordinator.handleMessage({ eventId: "prompt-e1", messageId: "prompt-m1", chatId: "chat", topicId: "t1", rootMessageId: "root-1", actorOpenId: "user", text: "do work", mentionsBot: false, isRootMessage: false });

      expect(runCount).toBe(0);
      await vi.advanceTimersByTimeAsync(1_300);
      await vi.waitFor(() => expect(runCount).toBe(1));
    } finally {
      await coordinator.stop(); await publisher.stop(); store.close(); vi.useRealTimers();
    }
  });
});

function fixture(herdr: HerdrPort, lark: LarkPort = quietLark()) {
  const store = new SqliteBindingStore(":memory:");
  const bus = new BridgeEventBus();
  const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
  const coordinator = new SyncCoordinator(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
  return { coordinator, publisher, store };
}

function emptyHerdr(): HerdrPort {
  return { async assertWorkspace() {}, async listPanes() { return []; }, async getPane() { return null; }, async createPane() { throw new Error("not used"); }, async startTraex() {}, async runPrompt() { return "done"; }, async readOutput() { return ""; }, async renamePane() {} };
}

function quietLark(): LarkPort {
  return { async start() {}, async stop() {}, isReady: () => true, async createTopic() { return { topicId: "t1", rootMessageId: "m1" }; }, async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {} };
}

function message(index: number) {
  return { eventId: `e${index}`, messageId: `m${index}`, chatId: "chat", topicId: `m${index}`, rootMessageId: `m${index}`, actorOpenId: "user", text: "/herdr help", mentionsBot: true, isRootMessage: true };
}

function config(): BridgeConfig {
  return {
    lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
    herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" },
    projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }],
    defaultProjectId: "repo", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:",
    http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
  };
}
