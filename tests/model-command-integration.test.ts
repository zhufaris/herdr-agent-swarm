import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { ConversationViewProjector } from "../src/events/conversation-view-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("model command", () => {
  it("runs outside the prompt queue and replies with the native TraeX result", async () => {
    const cards: object[] = [];
    const runPaneCommand = vi.fn(async () => "Current model: GPT-5.5");
    const selectPaneModel = vi.fn(async () => undefined);
    const fixture = await setup(cards, runPaneCommand, { selectPaneModel });

    await fixture.coordinator.handleMessage(message("/model GPT-5.5"));

    expect(selectPaneModel).toHaveBeenCalledWith("w1:p1", "GPT-5.5", 1000);
    expect(runPaneCommand).toHaveBeenCalledWith("w1:p1", "/model", 1000);
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
    const observeRuntime = vi.fn(async () => ({ pane: observedPane, traexProcess: true, composerReady: true, evidenceSource: "visible" as const }));
    let snapshotReads = 0;
    const selectPaneModel = vi.fn(async () => undefined);
    const fixture = await setup(cards, runPaneCommand, {
      pane: observedPane,
      listPanes: async () => ++snapshotReads === 1 ? [observedPane] : [snapshotPane],
      observeRuntime, selectPaneModel
    });

    await fixture.coordinator.handleMessage(message("/model GPT-5.5"));

    expect(observeRuntime).toHaveBeenCalledWith("w1:p1");
    expect(selectPaneModel).toHaveBeenCalledWith("w1:p1", "GPT-5.5", 1000);
    expect(runPaneCommand).toHaveBeenCalledWith("w1:p1", "/model", 1000);
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

  it("switches from the model dropdown and updates that card without creating a prompt", async () => {
    const cards: object[] = [];
    const updates: Array<{ messageId: string; card: object }> = [];
    const modelList = "Select Model and Effort\n 1. GPT-5.6-Sol          support reasoning\n 2. GPT-5.6-Terra (current)  support reasoning";
    const runPaneCommand = vi.fn(async () => modelList);
    const selectPaneModel = vi.fn(async () => undefined);
    const fixture = await setup(cards, runPaneCommand, { updates, selectPaneModel });

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "GPT-5.6-Terra",
      value: { action: "select_model", bindingId: fixture.bindingId }
    });

    expect(selectPaneModel).toHaveBeenCalledWith("w1:p1", "GPT-5.6-Terra", 1000);
    expect(runPaneCommand).toHaveBeenCalledWith("w1:p1", "/model", 1000);
    const modelUpdates = updates.filter((update) => update.messageId === "model-card-1");
    expect(modelUpdates).toHaveLength(1);
    expect(JSON.stringify(modelUpdates[0]!.card)).toContain('\"initial_option\":\"GPT-5.6-Terra\"');
    expect(fixture.store.countPendingPrompts(fixture.bindingId)).toBe(0);
    expect(fixture.store.listRunCards(fixture.bindingId)).toHaveLength(0);
    await fixture.close();
  });

  it("updates the model card with a visible error when a dropdown switch fails", async () => {
    const cards: object[] = [];
    const updates: Array<{ messageId: string; card: object }> = [];
    const selectPaneModel = vi.fn(async () => { throw new Error("Timed out waiting for TraeX model selection"); });
    const fixture = await setup(cards, vi.fn(async () => "unused"), { updates, selectPaneModel });

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "GPT-5.6-Terra",
      value: { action: "select_model", bindingId: fixture.bindingId }
    });

    expect(JSON.stringify(updates.at(-1)!.card)).toContain("模型切换失败");
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
    updates?: Array<{ messageId: string; card: object }>;
    selectPaneModel?: HerdrPort["selectPaneModel"];
  } = {}
) {
  const lark: LarkPort = {
    async start() {}, async stop() {}, isReady: () => true,
    async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
    async replyText() { return { messageId: "text-1" }; },
    async replyCard(_root, card) { cards.push(card); return { messageId: `card-${cards.length}` }; },
    async updateCard(messageId, card) { options.updates?.push({ messageId, card }); }
  };
  const pane = options.pane ?? { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, foregroundExecutables: ["traex"] };
  const herdr: HerdrPort = {
    async assertWorkspace() {}, listPanes: options.listPanes ?? (async () => [pane]), async getPane() { return pane; },
    observeRuntime: options.observeRuntime ?? (async () => ({ pane, traexProcess: pane.foregroundExecutables.includes("traex"), composerReady: pane.agentState === "idle", evidenceSource: "structured" })),
    ...(options.selectPaneModel ? { selectPaneModel: options.selectPaneModel } : {}),
    async createPane() { throw new Error("unused"); }, async startTraex() {}, async runPrompt() { return "done"; },
    runPaneCommand, async readOutput() { return ""; }, async renamePane() {}
  };
  const store = new SqliteBindingStore(":memory:");
  const bus = new BridgeEventBus();
  const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
  const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
  const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
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
