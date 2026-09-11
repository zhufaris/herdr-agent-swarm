import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import type { HerdrPort, LarkPort, TraexControlPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { ConversationViewProjector } from "../src/events/conversation-view-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { primaryPresentation } from "./helpers/presentation.js";

const UNSUPPORTED = "运行中的 Agent 不支持远程切换模型";

describe("model command without terminal interaction", () => {
  it("validates and stores a runtime model for the next ordinary prompt", async () => {
    const fixture = await setup();

    await fixture.coordinator.handleMessage(message("/swarm model GPT-5.5"));

    await vi.waitFor(() => expect(fixture.updates.some((update) => JSON.stringify(update.card).includes("将在下一条普通消息生效"))).toBe(true));
    expect(fixture.herdrCalls).toContain("listModels");
    expect(fixture.store.countPendingPrompts(fixture.bindingId)).toBe(0);
    expect(fixture.store.getModelPreference(fixture.bindingId)).toMatchObject({ desiredModel: "GPT-5.5", state: "pending" });
    expect(fixture.store.database.prepare("SELECT state FROM pane_control_operations WHERE kind = 'model'").get()).toBeUndefined();
    await fixture.close();
  });

  it("stores model card selection without terminal input", async () => {
    const fixture = await setup();

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "GPT-5.6-Terra",
      value: { action: "select_model", bindingId: fixture.bindingId }
    });

    await vi.waitFor(() => expect(fixture.updates.some((update) => update.messageId === "model-card-1" && JSON.stringify(update.card).includes("将在下一条普通消息生效"))).toBe(true));
    expect(fixture.herdrCalls).toContain("listModels");
    expect(fixture.store.getModelPreference(fixture.bindingId)).toMatchObject({ desiredModel: "GPT-5.6-Terra", state: "pending" });
    expect(fixture.store.countPendingPrompts(fixture.bindingId)).toBe(0);
    await fixture.close();
  });

  it("rejects a recovered model operation and releases queued prompt work", async () => {
    const fixture = await setup();
    await fixture.coordinator.stop();
    fixture.store.acceptPaneControlOperation({
      id: "model-op", idempotencyKey: "model-op", bindingId: fixture.bindingId, paneId: "w1:p1", terminalId: "term-1",
      bindingGeneration: 1, kind: "model", payload: "GPT-5.5", actorOpenId: "user", sourceMessageId: "model-card-1"
    });
    fixture.store.claimPaneControlOperation("model-op");

    await fixture.coordinator.start();

    await vi.waitFor(() => expect(fixture.store.getPaneControlOperation("model-op")).toMatchObject({ state: "rejected", detail: expect.stringContaining(UNSUPPORTED) }));
    expect(fixture.herdrCalls.filter((call) => call !== "assertWorkspace")).toEqual([]);
    await fixture.close();
  });

  it("rejects stale model-mode callbacks without sending keys", async () => {
    const fixture = await setup();
    fixture.store.acceptPaneControlOperation({
      id: "model-op", idempotencyKey: "model-op", bindingId: fixture.bindingId, paneId: "w1:p1", terminalId: "term-1",
      bindingGeneration: 1, kind: "model", payload: "GPT-5.5", actorOpenId: "user", sourceMessageId: "model-card-1"
    });
    fixture.store.claimPaneControlOperation("model-op");
    fixture.store.finishPaneControlOperation("model-op", "applied", JSON.stringify(["Standard", "Max"]));

    await fixture.coordinator.handleCardAction({
      messageId: "model-card-1", chatId: "chat", operatorOpenId: "user", option: "Max",
      value: { action: "select_model_mode", bindingId: fixture.bindingId, operationId: "model-op" }
    });

    expect(fixture.store.getPaneControlOperation("model-op")).toMatchObject({ state: "rejected" });
    expect(fixture.herdrCalls.filter((call) => call !== "assertWorkspace")).toEqual([]);
    await fixture.close();
  });
});

async function setup() {
  const cards: object[] = [];
  const updates: Array<{ messageId: string; card: object }> = [];
  const herdrCalls: string[] = [];
  const lark: LarkPort = {
    async start() {}, async stop() {}, isReady: () => true,
    async createTopic() { return { topicId: "topic-1", rootMessageId: "root-1" }; },
    async replyText() { return { messageId: "text-1" }; },
    async replyCard(_root, card) { cards.push(card); return { messageId: `card-${cards.length}` }; },
    async updateCard(messageId, card) { updates.push({ messageId, card }); }
  };
  const pane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, agentKind: "traex", foregroundExecutables: ["traex"], agentSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "01a03eb1-c193-7531-83c0-e6c6f70143d4" } };
  const herdr: HerdrPort = {
    async assertWorkspace() { herdrCalls.push("assertWorkspace"); }, async listPanes() { return [pane]; }, async getPane() { return pane; },
    async observeRuntime() { herdrCalls.push("observeRuntime"); return { pane, traexProcess: true, composerReady: true, evidenceSource: "structured" }; },
    async createPane() { throw new Error("unused"); }, async startTraex() { herdrCalls.push("startTraex"); },
    async runPrompt() { herdrCalls.push("runPrompt"); return "done"; }, async sendEscape() { herdrCalls.push("sendEscape"); },
    async renamePane() { herdrCalls.push("renamePane"); }
  };
  const traexControl: TraexControlPort = {
    async listModels() { herdrCalls.push("listModels"); return ["GPT-5.5", "GPT-5.6-Terra"].map((name) => ({ id: name, name, displayName: name })); },
    async runModelPrompt() { throw new Error("unused"); }
  };
  const store = new SqliteBindingStore(":memory:");
  const bus = new BridgeEventBus();
  const publisher = createTestPublisher(store, lark, pino({ enabled: false }));
  publisher.start();
  const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation);
  projector.start();
  const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }), 30_000, undefined, undefined, undefined, false, traexControl);
  await coordinator.start();
  const bindingId = store.findBindingByPane("w1:p1")!.id;
  herdrCalls.length = 0;
  return { cards, updates, herdrCalls, coordinator, store, bindingId, async close() { await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close(); } };
}

function message(text: string) {
  return { eventId: `event-${text}`, messageId: `message-${text}`, chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text, mentionsBot: false, isRootMessage: false };
}

function config(): BridgeConfig {
  return { lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", allowedOpenIds: ["u1", "u2", "creator", "user", "user-1"], adminOpenIds: ["u1", "u2", "creator", "user", "user-1"] }, herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" }, projects: [{ id: "default", displayName: "Default", description: "Test", workspaceId: "w1", cwd: "/repo", spaceName: "datasage" }], defaultProjectId: "default", projectsConfigPath: "test", traex: { executable: "traex" }, databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500 };
}
