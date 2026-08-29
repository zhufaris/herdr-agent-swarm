import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { ConversationViewProjector } from "../src/events/conversation-view-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";

describe("model command", () => {
  it("runs outside the prompt queue and replies with the native TraeX result", async () => {
    const cards: object[] = [];
    const runPaneCommand = vi.fn(async () => "Current model: GPT-5.5");
    const beginPaneModelSelection = vi.fn(async () => ({ kind: "composer_ready" as const }));
    const fixture = await setup(cards, runPaneCommand, { beginPaneModelSelection });

    await fixture.coordinator.handleMessage(message("/swarm model GPT-5.5"));

    expect(beginPaneModelSelection).toHaveBeenCalledWith("w1:p1", "GPT-5.5", 1000);
    expect(runPaneCommand).toHaveBeenCalledWith("w1:p1", "/model", 1000);
    expect(fixture.store.countPendingPrompts(fixture.bindingId)).toBe(0);
    expect(fixture.store.listRunCards(fixture.bindingId)).toHaveLength(0);
    expect(JSON.stringify(cards.at(-1))).toContain("Current model: GPT-5.5");
    await fixture.close();
  });

  it("replies to each distinct /swarm model message even when the rendered result is identical", async () => {
    const cards: object[] = [];
    const runPaneCommand = vi.fn(async () => "Current model: GPT-5.5");
    const fixture = await setup(cards, runPaneCommand);
    const statusMessageId = fixture.store.getBinding(fixture.bindingId)!.statusMessageId;

    await fixture.coordinator.handleMessage(message("/swarm model", "first"));
    await fixture.coordinator.handleMessage(message("/swarm model", "second"));

    await vi.waitFor(() => expect(runPaneCommand).toHaveBeenCalledTimes(2));
    await vi.waitFor(() => expect(cards.filter((card) => JSON.stringify(card).includes("Current model: GPT-5.5"))).toHaveLength(2));
    expect(fixture.store.getBinding(fixture.bindingId)?.statusMessageId).toBe(statusMessageId);
    expect(fixture.store.countPendingPrompts(fixture.bindingId)).toBe(0);
    await fixture.close();
  });

  it("runs before queued ordinary prompts while the pane is idle", async () => {
    const cards: object[] = [];
    let releaseModel!: () => void;
    const modelHeld = new Promise<void>((resolve) => { releaseModel = resolve; });
    const runPaneCommand = vi.fn(async () => { await modelHeld; return "Current model: GPT-5.5"; });
    const runPrompt = vi.fn(async () => "done");
    const fixture = await setup(cards, runPaneCommand, { runPrompt });
    const queued = { id: "queued-turn", bindingId: fixture.bindingId, larkMessageId: "queued-message", actorOpenId: "user", body: "ordinary work" };
    const view = createQueuedRunCard({ promptId: queued.id, bindingId: fixture.bindingId, title: "Ordinary work", workspaceId: "w1", paneId: "w1:p1", requestText: queued.body, queuePosition: 1, occurredAt: new Date().toISOString() });
    fixture.store.acceptPrompt({ prompt: queued, view, rootMessageId: "root-1", answerCard: {} });

    const handling = fixture.coordinator.handleMessage(message("/swarm model"));

    await vi.waitFor(() => expect(runPaneCommand).toHaveBeenCalledWith("w1:p1", "/model", 1000));
    expect(fixture.store.getPrompt(queued.id)?.state).toBe("queued");
    expect(runPrompt).not.toHaveBeenCalled();
    releaseModel();
    await handling;
    await vi.waitFor(() => expect(runPrompt).toHaveBeenCalledTimes(1));
    expect(fixture.store.database.prepare("SELECT state FROM pane_control_operations WHERE kind = 'model'").get()).toEqual({ state: "confirmed" });
    await fixture.close();
  });

  it("observes the bound pane when the workspace snapshot cannot identify TraeX", async () => {
    const cards: object[] = [];
    const runPaneCommand = vi.fn(async () => "Current model: GPT-5.5");
    const snapshotPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "unknown" as const, foregroundExecutables: [] };
    const observedPane = { ...snapshotPane, agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const observeRuntime = vi.fn(async () => ({ pane: observedPane, traexProcess: true, composerReady: true, evidenceSource: "visible" as const }));
    let snapshotReads = 0;
    const beginPaneModelSelection = vi.fn(async () => ({ kind: "composer_ready" as const }));
    const fixture = await setup(cards, runPaneCommand, {
      pane: observedPane,
      listPanes: async () => ++snapshotReads === 1 ? [observedPane] : [snapshotPane],
      observeRuntime, beginPaneModelSelection
    });

    await fixture.coordinator.handleMessage(message("/swarm model GPT-5.5"));

    expect(observeRuntime).toHaveBeenCalledWith("w1:p1");
    expect(beginPaneModelSelection).toHaveBeenCalledWith("w1:p1", "GPT-5.5", 1000);
    expect(runPaneCommand).toHaveBeenCalledWith("w1:p1", "/model", 1000);
    expect(JSON.stringify(cards.at(-1))).toContain("Current model: GPT-5.5");
    await fixture.close();
  });

  it("rejects the command while the binding is busy without touching the pane", async () => {
    const cards: object[] = [];
    const runPaneCommand = vi.fn(async () => "unexpected");
    const fixture = await setup(cards, runPaneCommand);
    fixture.store.updateBinding(fixture.bindingId, { lastAgentState: "working" });

    await fixture.coordinator.handleMessage(message("/swarm model"));

    expect(runPaneCommand).not.toHaveBeenCalled();
    expect(fixture.store.database.prepare("SELECT state FROM pane_control_operations WHERE kind = 'model'").get()).toEqual({ state: "rejected" });
    await fixture.close();
  });

  it("switches from the model dropdown and updates that card without creating a prompt", async () => {
    const cards: object[] = [];
    const updates: Array<{ messageId: string; card: object }> = [];
    const modelList = "Select Model and Effort\n 1. GPT-5.6-Sol          support reasoning\n 2. GPT-5.6-Terra (current)  support reasoning";
    const runPaneCommand = vi.fn(async () => modelList);
    const beginPaneModelSelection = vi.fn(async () => ({ kind: "composer_ready" as const }));
    const fixture = await setup(cards, runPaneCommand, { updates, beginPaneModelSelection });

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "GPT-5.6-Terra",
      value: { action: "select_model", bindingId: fixture.bindingId }
    });

    await vi.waitFor(() => expect(beginPaneModelSelection).toHaveBeenCalledWith("w1:p1", "GPT-5.6-Terra", 1000));
    expect(runPaneCommand).toHaveBeenCalledWith("w1:p1", "/model", 1000);
    const modelUpdates = updates.filter((update) => update.messageId === "model-card-1");
    expect(modelUpdates).toHaveLength(1);
    expect(JSON.stringify(modelUpdates[0]!.card)).toContain('\"initial_option\":\"GPT-5.6-Terra\"');
    expect(fixture.store.countPendingPrompts(fixture.bindingId)).toBe(0);
    expect(fixture.store.listRunCards(fixture.bindingId)).toHaveLength(0);
    await fixture.close();
  });

  it("shows TraeX modes after model selection and waits for the explicit mode callback", async () => {
    const cards: object[] = [];
    const updates: Array<{ messageId: string; card: object }> = [];
    const beginPaneModelSelection = vi.fn(async () => ({ kind: "mode_required" as const, modes: ["Standard", "Max"] }));
    const completePaneModelMode = vi.fn(async () => undefined);
    const fixture = await setup(cards, vi.fn(async () => "Current model: GPT-5.6-Terra / Standard"), { updates, beginPaneModelSelection, completePaneModelMode });

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "GPT-5.6-Terra",
      value: { action: "select_model", bindingId: fixture.bindingId }
    });

    await vi.waitFor(() => expect(beginPaneModelSelection).toHaveBeenCalledWith("w1:p1", "GPT-5.6-Terra", 1000));
    expect(completePaneModelMode).not.toHaveBeenCalled();
    const modeCard = updates.at(-1)!;
    const operation = fixture.store.database.prepare("SELECT id, state FROM pane_control_operations WHERE kind = 'model'").get() as { id: string; state: string };
    expect(operation.state).toBe("applied");
    expect(JSON.stringify(modeCard.card)).toContain("选择运行模式");
    expect(JSON.stringify(modeCard.card)).toContain("Standard");
    expect(JSON.stringify(modeCard.card)).toContain("Max");

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "Max",
      value: { action: "select_model_mode", bindingId: fixture.bindingId, operationId: operation.id }
    });

    await vi.waitFor(() => expect(completePaneModelMode).toHaveBeenCalledWith("w1:p1", "Max", 1000));
    expect(fixture.store.getPaneControlOperation(operation.id)).toMatchObject({ state: "confirmed" });
    expect(JSON.stringify(updates.at(-1)?.card)).toContain('"template":"green"');

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "Max",
      value: { action: "select_model_mode", bindingId: fixture.bindingId, operationId: operation.id }
    });
    expect(completePaneModelMode).toHaveBeenCalledTimes(1);
    expect(fixture.store.countPendingPrompts(fixture.bindingId)).toBe(0);
    await fixture.close();
  });

  it("keeps a pending model mode choice through recovery without replaying terminal input", async () => {
    const cards: object[] = [];
    const beginPaneModelSelection = vi.fn(async () => ({ kind: "mode_required" as const, modes: ["Standard", "Max"] }));
    const fixture = await setup(cards, vi.fn(async () => "unused"), { beginPaneModelSelection });

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "GPT-5.6-Terra",
      value: { action: "select_model", bindingId: fixture.bindingId }
    });
    await vi.waitFor(() => expect(beginPaneModelSelection).toHaveBeenCalled());
    const operation = fixture.store.database.prepare("SELECT id FROM pane_control_operations WHERE kind = 'model'").get() as { id: string };

    await fixture.coordinator.stop();
    await fixture.coordinator.start();

    expect(fixture.store.getPaneControlOperation(operation.id)).toMatchObject({ state: "applied" });
    expect(beginPaneModelSelection).toHaveBeenCalledTimes(1);
    await fixture.close();
  });

  it("rejects a mode that was not advertised by the live TraeX selector", async () => {
    const cards: object[] = [];
    const updates: Array<{ messageId: string; card: object }> = [];
    const beginPaneModelSelection = vi.fn(async () => ({ kind: "mode_required" as const, modes: ["Standard", "Max"] }));
    const completePaneModelMode = vi.fn(async () => undefined);
    const fixture = await setup(cards, vi.fn(async () => "unused"), { updates, beginPaneModelSelection, completePaneModelMode });

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "GPT-5.6-Terra",
      value: { action: "select_model", bindingId: fixture.bindingId }
    });
    await vi.waitFor(() => expect(beginPaneModelSelection).toHaveBeenCalled());
    const operation = fixture.store.database.prepare("SELECT id FROM pane_control_operations WHERE kind = 'model'").get() as { id: string };

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "Unadvertised",
      value: { action: "select_model_mode", bindingId: fixture.bindingId, operationId: operation.id }
    });

    expect(completePaneModelMode).not.toHaveBeenCalled();
    expect(fixture.store.getPaneControlOperation(operation.id)).toMatchObject({ state: "applied" });
    expect(updates.some((update) => update.messageId === "model-card-1" && JSON.stringify(update.card).includes("模型模式选择已失效"))).toBe(true);
    await fixture.close();
  });

  it("expires a pending mode choice during recovery and releases ordinary prompts", async () => {
    const cards: object[] = [];
    const updates: Array<{ messageId: string; card: object }> = [];
    const beginPaneModelSelection = vi.fn(async () => ({ kind: "mode_required" as const, modes: ["Standard", "Max"] }));
    const runPrompt = vi.fn(async () => "done" as const);
    const fixture = await setup(cards, vi.fn(async () => "unused"), { updates, beginPaneModelSelection, runPrompt });

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "GPT-5.6-Terra",
      value: { action: "select_model", bindingId: fixture.bindingId }
    });
    await vi.waitFor(() => expect(beginPaneModelSelection).toHaveBeenCalled());
    const operation = fixture.store.database.prepare("SELECT id, detail FROM pane_control_operations WHERE kind = 'model'").get() as { id: string; detail: string };
    await fixture.coordinator.handleMessage(message("ordinary work"));
    expect(fixture.store.countPendingPrompts(fixture.bindingId)).toBe(1);
    expect(runPrompt).not.toHaveBeenCalled();
    const detail = JSON.parse(operation.detail) as { expiresAt: string };
    expect(Date.parse(detail.expiresAt)).toBeGreaterThan(Date.now());
    fixture.store.database.prepare("UPDATE pane_control_operations SET detail = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(operation.detail), expiresAt: "2020-01-01T00:00:00.000Z" }), operation.id);

    await fixture.coordinator.stop();
    await fixture.coordinator.start();

    expect(fixture.store.getPaneControlOperation(operation.id)).toMatchObject({ state: "rejected" });
    await vi.waitFor(() => expect(updates.some((update) => update.messageId === "model-card-1" && JSON.stringify(update.card).includes("模型模式选择已过期"))).toBe(true));
    await vi.waitFor(() => expect(runPrompt).toHaveBeenCalledWith("w1:p1", "ordinary work", 1000, expect.any(Function), expect.any(AbortSignal), expect.any(Function)));
    await fixture.close();
  });

  it("expires a recovered pending mode choice while the service remains running", async () => {
    const cards: object[] = [];
    const updates: Array<{ messageId: string; card: object }> = [];
    const beginPaneModelSelection = vi.fn(async () => ({ kind: "mode_required" as const, modes: ["Standard", "Max"] }));
    const fixture = await setup(cards, vi.fn(async () => "unused"), { updates, beginPaneModelSelection });

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "GPT-5.6-Terra",
      value: { action: "select_model", bindingId: fixture.bindingId }
    });
    await vi.waitFor(() => expect(beginPaneModelSelection).toHaveBeenCalled());
    const operation = fixture.store.database.prepare("SELECT id, detail FROM pane_control_operations WHERE kind = 'model'").get() as { id: string; detail: string };
    fixture.store.database.prepare("UPDATE pane_control_operations SET detail = ? WHERE id = ?").run(JSON.stringify({ ...JSON.parse(operation.detail), expiresAt: new Date(Date.now() + 50).toISOString() }), operation.id);

    await fixture.coordinator.stop();
    await fixture.coordinator.start();

    await vi.waitFor(() => expect(fixture.store.getPaneControlOperation(operation.id)).toMatchObject({ state: "rejected" }));
    expect(JSON.stringify(updates.at(-1)?.card)).toContain("模型模式选择已过期");
    await fixture.close();
  });

  it.each([
    ["generation", { generation: 2 }],
    ["terminal", { traexSessionId: "term-2" }]
  ] as const)("rejects a mode callback after the binding %s changes", async (_identity, patch) => {
    const cards: object[] = [];
    const updates: Array<{ messageId: string; card: object }> = [];
    const beginPaneModelSelection = vi.fn(async () => ({ kind: "mode_required" as const, modes: ["Standard", "Max"] }));
    const completePaneModelMode = vi.fn(async () => undefined);
    const fixture = await setup(cards, vi.fn(async () => "unused"), { updates, beginPaneModelSelection, completePaneModelMode });

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "GPT-5.6-Terra",
      value: { action: "select_model", bindingId: fixture.bindingId }
    });
    await vi.waitFor(() => expect(beginPaneModelSelection).toHaveBeenCalled());
    const operation = fixture.store.database.prepare("SELECT id FROM pane_control_operations WHERE kind = 'model'").get() as { id: string };
    fixture.store.updateBinding(fixture.bindingId, patch);

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "Max",
      value: { action: "select_model_mode", bindingId: fixture.bindingId, operationId: operation.id }
    });

    expect(completePaneModelMode).not.toHaveBeenCalled();
    expect(fixture.store.getPaneControlOperation(operation.id)).toMatchObject({ state: "rejected" });
    expect(JSON.stringify(updates.at(-1)?.card)).toContain("Pane identity 已变化");
    await fixture.close();
  });

  it("accepts a mode callback after PTY restoration when the native Agent session still matches", async () => {
    const cards: object[] = [];
    const beginPaneModelSelection = vi.fn(async () => ({ kind: "mode_required" as const, modes: ["Standard", "Max"] }));
    const completePaneModelMode = vi.fn(async () => undefined);
    const restoredPane = {
      paneId: "w1:p1", terminalId: "term-2", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, foregroundExecutables: ["traex"],
      agentSession: { source: "traex", agent: "traex", kind: "id" as const, value: "session-1" }
    };
    const fixture = await setup(cards, vi.fn(async () => "Current model: GPT-5.6-Terra / Max"), {
      pane: restoredPane, beginPaneModelSelection, completePaneModelMode
    });
    fixture.store.updateBinding(fixture.bindingId, { traexSessionId: "term-1", agentSessionSource: "traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });

    await fixture.coordinator.handleCardAction({ messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "GPT-5.6-Terra", value: { action: "select_model", bindingId: fixture.bindingId } });
    await vi.waitFor(() => expect(beginPaneModelSelection).toHaveBeenCalled());
    const operation = fixture.store.database.prepare("SELECT id FROM pane_control_operations WHERE kind = 'model'").get() as { id: string };
    fixture.store.updateBinding(fixture.bindingId, { traexSessionId: "term-2" });

    await fixture.coordinator.handleCardAction({ messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "Max", value: { action: "select_model_mode", bindingId: fixture.bindingId, operationId: operation.id } });

    expect(completePaneModelMode).toHaveBeenCalledWith("w1:p1", "Max", 1000);
    expect(fixture.store.getPaneControlOperation(operation.id)).toMatchObject({ state: "confirmed" });
    await fixture.close();
  });

  it("updates the model card with a visible error when a dropdown switch fails", async () => {
    const cards: object[] = [];
    const updates: Array<{ messageId: string; card: object }> = [];
    const beginPaneModelSelection = vi.fn(async () => { throw new Error("Timed out waiting for TraeX model selection"); });
    const fixture = await setup(cards, vi.fn(async () => "unused"), { updates, beginPaneModelSelection });

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "GPT-5.6-Terra",
      value: { action: "select_model", bindingId: fixture.bindingId }
    });

    await vi.waitFor(() => expect(JSON.stringify(updates.at(-1)?.card)).toContain("模型命令执行失败或无法确认"));
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
    beginPaneModelSelection?: HerdrPort["beginPaneModelSelection"];
    completePaneModelMode?: HerdrPort["completePaneModelMode"];
    runPrompt?: HerdrPort["runPrompt"];
  } = {}
) {
  const lark: LarkPort = {
    async start() {}, async stop() {}, isReady: () => true,
    async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
    async replyText() { return { messageId: "text-1" }; },
    async replyCard(_root, card) { cards.push(card); return { messageId: `card-${cards.length}` }; },
    async updateCard(messageId, card) { options.updates?.push({ messageId, card }); }
  };
  const pane = options.pane ?? { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, foregroundExecutables: ["traex"] };
  const herdr: HerdrPort = {
    async assertWorkspace() {}, listPanes: options.listPanes ?? (async () => [pane]), async getPane() { return pane; },
    observeRuntime: options.observeRuntime ?? (async () => ({ pane, traexProcess: pane.foregroundExecutables.includes("traex"), composerReady: pane.agentState === "idle", evidenceSource: "structured" })),
    ...(options.beginPaneModelSelection ? { beginPaneModelSelection: options.beginPaneModelSelection } : {}),
    ...(options.completePaneModelMode ? { completePaneModelMode: options.completePaneModelMode } : {}),
    async createPane() { throw new Error("unused"); }, async startTraex() {}, runPrompt: options.runPrompt ?? (async () => "done"),
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

function message(text: string, id = text) {
  return { eventId: `event-${id}`, messageId: `message-${id}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false };
}

function config(): BridgeConfig {
  return { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "default", displayName: "Default", description: "Test", workspaceId: "w1", cwd: "/repo", spaceName: "datasage" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500 };
}
