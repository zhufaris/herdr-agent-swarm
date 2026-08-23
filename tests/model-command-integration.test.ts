import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { SyncCoordinator } from "../src/coordinator/sync-coordinator.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { CardProjector } from "../src/events/card-projector.js";
import { LarkChannelPublisher } from "../src/events/lark-channel-publisher.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("model command", () => {
  it("runs outside the prompt queue and replies with the native TraeX result", async () => {
    const cards: object[] = [];
    const runPaneCommand = vi.fn(async () => "Current model: GPT-5.5");
    const fixture = await setup(cards, runPaneCommand);

    await fixture.coordinator.handleMessage(message("/model GPT-5.5"));

    expect(runPaneCommand).toHaveBeenCalledWith("w1:p1", "/model GPT-5.5", 1000);
    expect(fixture.store.countPendingPrompts(fixture.bindingId)).toBe(0);
    expect(fixture.store.listRunCards(fixture.bindingId)).toHaveLength(0);
    expect(JSON.stringify(cards.at(-1))).toContain("Current model: GPT-5.5");
    await fixture.close();
  });

  it("observes the bound pane when the workspace snapshot cannot identify TraeX", async () => {
    const cards: object[] = [];
    const runPaneCommand = vi.fn(async () => "Current model: GPT-5.5");
    const snapshotPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "unknown" as const, foregroundExecutables: [] };
    const observedPane = { ...snapshotPane, agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const observeRuntime = vi.fn(async () => ({ pane: observedPane, state: "idle" as const, traexProcess: true, composerReady: true, evidenceSource: "visible" as const }));
    let snapshotReads = 0;
    const fixture = await setup(cards, runPaneCommand, {
      pane: observedPane,
      listPanes: async () => ++snapshotReads === 1 ? [observedPane] : [snapshotPane],
      observeRuntime
    });

    await fixture.coordinator.handleMessage(message("/model GPT-5.5"));

    expect(observeRuntime).toHaveBeenCalledWith("w1:p1");
    expect(runPaneCommand).toHaveBeenCalledWith("w1:p1", "/model GPT-5.5", 1000);
    expect(JSON.stringify(cards.at(-1))).toContain("Current model: GPT-5.5");
    await fixture.close();
  });

  it("rejects the command while the binding is busy without touching the pane", async () => {
    const cards: object[] = [];
    const runPaneCommand = vi.fn(async () => "unexpected");
    const fixture = await setup(cards, runPaneCommand);
    fixture.store.updateBinding(fixture.bindingId, { lastAgentState: "working" });

    await fixture.coordinator.handleMessage(message("/model"));

    expect(runPaneCommand).not.toHaveBeenCalled();
    expect(JSON.stringify(cards.at(-1))).toContain("当前任务或队列完成后");
    await fixture.close();
  });
});

async function setup(
  cards: object[],
  runPaneCommand: HerdrPort["runPaneCommand"],
  options: {
    pane?: Awaited<ReturnType<HerdrPort["getPane"]>> & {};
    listPanes?: HerdrPort["listPanes"];
    observeRuntime?: HerdrPort["observeRuntime"];
  } = {}
) {
  const lark: LarkPort = {
    async start() {}, async stop() {}, isReady: () => true,
    async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
    async replyText() { return { messageId: "text-1" }; },
    async replyCard(_root, card) { cards.push(card); return { messageId: `card-${cards.length}` }; },
    async updateCard() {}
  };
  const pane = options.pane ?? { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, foregroundExecutables: ["traex"] };
  const herdr: HerdrPort = {
    async assertWorkspace() {}, listPanes: options.listPanes ?? (async () => [pane]), async getPane() { return pane; },
    ...(options.observeRuntime ? { observeRuntime: options.observeRuntime } : {}),
    async createPane() { throw new Error("unused"); }, async startTraex() {}, async runPrompt() { return "done"; },
    runPaneCommand, async readOutput() { return ""; }, async renamePane() {}
  };
  const store = new SqliteBindingStore(":memory:");
  const bus = new BridgeEventBus();
  const publisher = new LarkChannelPublisher(bus, store, lark, pino({ enabled: false })); publisher.start();
  const projector = new CardProjector(bus, store, publisher, pino({ enabled: false })); projector.start();
  const coordinator = new SyncCoordinator(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
  await coordinator.start();
  const bindingId = store.findBindingByPane("w1:p1")!.id;
  return { coordinator, store, bindingId, async close() { await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close(); } };
}

function message(text: string) {
  return { eventId: `event-${text}`, messageId: `message-${text}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false };
}

function config(): BridgeConfig {
  return { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "default", displayName: "Default", description: "Test", workspaceId: "w1", cwd: "/repo", spaceName: "datasage" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500 };
}
