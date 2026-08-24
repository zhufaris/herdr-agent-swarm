import pino from "pino";
import { describe, expect, it } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { InboundRouter } from "../src/coordinator/inbound-router.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import type { HerdrPane } from "../src/domain/types.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { LarkOutboxDispatcher } from "../src/events/lark-outbox-dispatcher.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("project provisioning recovery", () => {
  it("pauses a linked selected checkpoint instead of risking a duplicate pane", async () => {
    const harness = createHarness();
    const selection = createProcessingSelection(harness.store);
    const binding = harness.store.createPendingBinding({ id: "binding-1", projectId: "alpha", workspaceId: "w1", chatId: "chat", topicId: null, rootMessageId: null, title: "Alpha / task" });
    harness.store.linkProjectSelectionBinding(selection.id, binding.id);

    await harness.coordinator.start();

    expect(harness.created).toBe(0);
    expect(harness.started).toBe(0);
    expect(harness.topics).toBe(0);
    expect(harness.store.getProjectSelection(selection.id)).toMatchObject({
      state: "processing",
      error: expect.stringContaining("/herdr attach")
    });
    await harness.close();
  });

  it.each([
    ["pane_created", 1, 1, "active"],
    ["runtime_started", 0, 1, "active"],
    ["thread_created", 0, 0, "active"]
  ] as const)("resumes %s without duplicating completed effects", async (checkpoint, expectedStarts, expectedTopics, expectedState) => {
    const harness = createHarness();
    const selection = createProcessingSelection(harness.store);
    let binding = harness.store.createPendingBinding({ id: "binding-1", projectId: "alpha", workspaceId: "w1", chatId: "chat", topicId: null, rootMessageId: null, title: "Alpha / task" });
    harness.store.linkProjectSelectionBinding(selection.id, binding.id);
    binding = harness.store.updateBinding(binding.id, { paneId: "w1:p9", traexSessionId: "term-1" });
    binding = harness.store.transitionBinding(binding.id, { type: "pane_created" });
    if (checkpoint !== "pane_created") binding = harness.store.transitionBinding(binding.id, { type: "runtime_started" });
    if (checkpoint === "thread_created") {
      binding = harness.store.updateBinding(binding.id, { topicId: "topic-existing", rootMessageId: "root-existing", statusMessageId: "root-existing" });
      harness.store.transitionBinding(binding.id, { type: "thread_created" });
    }

    await harness.coordinator.start();

    expect(harness.created).toBe(0);
    expect(harness.started).toBe(expectedStarts);
    expect(harness.topics).toBe(expectedTopics);
    if (expectedTopics) expect(harness.topicKeys).toEqual(["binding-1"]);
    expect(harness.store.getProjectSelection(selection.id)).toMatchObject({ state: "completed" });
    expect(harness.store.listBindings()[0]).toMatchObject({ state: expectedState, lifecycle: "active", provisioningCheckpoint: "activated", lastAgentState: "idle" });
    await harness.close();
  });

  it("refuses a reused pane id whose terminal identity changed", async () => {
    const harness = createHarness({ terminalId: "different-terminal" });
    const selection = createProcessingSelection(harness.store);
    const binding = harness.store.createPendingBinding({ id: "binding-1", projectId: "alpha", workspaceId: "w1", chatId: "chat", topicId: null, rootMessageId: null, title: "Alpha / task" });
    harness.store.linkProjectSelectionBinding(selection.id, binding.id);
    harness.store.updateBinding(binding.id, { paneId: "w1:p9", traexSessionId: "term-1" });
    harness.store.transitionBinding(binding.id, { type: "pane_created" });

    await harness.coordinator.start();

    expect(harness.created).toBe(0);
    expect(harness.started).toBe(0);
    expect(harness.topics).toBe(0);
    expect(harness.store.getProjectSelection(selection.id)).toMatchObject({ state: "processing" });
    await harness.close();
  });

  it("fails a legacy processing selection that has no linked binding", async () => {
    const harness = createHarness();
    const selection = createProcessingSelection(harness.store);

    await harness.coordinator.start();

    expect(harness.store.getProjectSelection(selection.id)).toMatchObject({ state: "failed", error: "Interrupted before recoverable project identity was persisted" });
    expect(harness.created).toBe(0);
    await harness.close();
  });
});

function createProcessingSelection(store: SqliteBindingStore) {
  const selection = store.createProjectSelection({ id: "selection-1", commandMessageId: "command-1", chatId: "chat", topicId: null, rootMessageId: "command-1", actorOpenId: "user", requestedTitle: "task", expiresAt: "2099-01-01T00:00:00.000Z", card: {} });
  const outbound = store.listPendingOutboundReplies()[0]!;
  store.markOutboundReplyDelivered(outbound.id, "selector-1");
  store.claimProjectSelection({ selectionId: selection.id, projectId: "alpha", messageId: "selector-1", chatId: "chat", actorOpenId: "user", allowedProjectIds: ["alpha"] });
  return selection;
}

function createHarness(options: { terminalId?: string } = {}) {
  const store = new SqliteBindingStore(":memory:");
  let created = 0; let started = 0; let topics = 0; const topicKeys: Array<string | undefined> = [];
  const pane: HerdrPane = { paneId: "w1:p9", terminalId: options.terminalId ?? "term-1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"] };
  const herdr: HerdrPort = {
    async assertWorkspace() {}, async listPanes() { return [pane]; }, async getPane() { return pane; },
    async createPane() { created += 1; return pane; }, async startTraex() { started += 1; }, async runPrompt() { return "done"; },
    async readOutput() { return ""; }, async renamePane() {}
  };
  const lark: LarkPort = {
    async start() {}, async stop() {}, isReady: () => true,
    async createTopic(_card, idempotencyKey) { topics += 1; topicKeys.push(idempotencyKey); return { topicId: `topic-${topics}`, rootMessageId: `root-${topics}` }; },
    async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {}
  };
  const bus = new BridgeEventBus();
  const publisher = new LarkOutboxDispatcher(bus, store, lark, pino({ enabled: false })); publisher.start();
  const coordinator = new InboundRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
  return { store, coordinator, get created() { return created; }, get started() { return started; }, get topics() { return topics; }, get topicKeys() { return topicKeys; }, async close() { await coordinator.stop(); await publisher.stop(); store.close(); } };
}

function config(): BridgeConfig {
  return {
    lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot" },
    herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" },
    projects: [{ id: "alpha", displayName: "Alpha", description: "Alpha", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "alpha", projectsConfigPath: "test", traex: { executable: "traex" },
    databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
  };
}
