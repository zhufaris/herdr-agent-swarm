import pino from "pino";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import type { HerdrPane } from "../src/domain/types.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { ConversationViewProjector } from "../src/events/conversation-view-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("project provisioning recovery", () => {
  it("marks a pre-feature active binding unavailable without restarting its pane", async () => {
    const harness = createHarness();
    harness.store.createPendingBinding({ id: "legacy-active", projectId: "alpha", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Alpha / legacy" });
    harness.store.updateBinding("legacy-active", { paneId: "w1:p9", statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });

    await harness.coordinator.start();

    expect(harness.started).toBe(0);
    expect(harness.created).toBe(0);
    await vi.waitFor(() => expect(harness.store.loadTopicView("legacy-active")).toMatchObject({ primaryToolsAvailable: false, primaryToolsNotice: expect.stringMatching(/reset.*replace/i) }));
    await harness.close();
  });

  it("does not start a legacy pane_created checkpoint without a persisted capability", async () => {
    const harness = createHarness();
    const selection = createProcessingSelection(harness.store);
    let binding = harness.store.createPendingBinding({ id: "binding-1", projectId: "alpha", workspaceId: "w1", chatId: "chat", topicId: null, rootMessageId: null, title: "Alpha / task" });
    harness.store.linkProjectSelectionBinding(selection.id, binding.id);
    binding = harness.store.updateBinding(binding.id, { paneId: "w1:p9", traexSessionId: "term-1" });
    harness.store.transitionBinding(binding.id, { type: "pane_created" });

    await harness.coordinator.start();

    expect(harness.started).toBe(0);
    expect(harness.created).toBe(0);
    expect(harness.store.getProjectSelection(selection.id)).toMatchObject({ state: "processing", error: expect.stringMatching(/credential provenance.*reset.*replace/i) });
    expect(harness.store.hasBindingPrimaryToolCapability(binding.id, 1)).toBe(false);
    await vi.waitFor(() => expect(harness.store.loadTopicView(binding.id)).toMatchObject({ primaryToolsAvailable: false, primaryToolsNotice: expect.stringMatching(/reset.*replace/i) }));
    await harness.close();
  });

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
      error: expect.stringContaining("/swarm attach")
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
    harness.store.setBindingPrimaryToolCapability({ bindingId: binding.id, expectedGeneration: 1, capabilityHash: capabilityHash("test-binding-1-1") });
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
    if (checkpoint === "pane_created") {
      expect(harness.startedCalls).toEqual([{ paneId: "w1:p9", args: primaryToolArgs("binding-1", 1) }]);
      expect(harness.store.hasBindingPrimaryToolCapability("binding-1", 1)).toBe(true);
    }
    expect(harness.topics).toBe(expectedTopics);
    if (expectedTopics) expect(harness.topicKeys).toEqual(["binding-1"]);
    expect(harness.store.getProjectSelection(selection.id)).toMatchObject({ state: "completed" });
    expect(harness.store.listBindings()[0]).toMatchObject({ state: expectedState, lifecycle: "active", provisioningCheckpoint: "activated", lastAgentState: "idle" });
    await harness.close();
  });

  it("replaces an old-hook TraeX pane before resuming a pane_created checkpoint", async () => {
    const harness = createHarness({ occupiedUnreadyPane: true });
    const selection = createProcessingSelection(harness.store);
    let binding = harness.store.createPendingBinding({ id: "binding-1", projectId: "alpha", workspaceId: "w1", chatId: "chat", topicId: null, rootMessageId: null, title: "Alpha / task" });
    harness.store.linkProjectSelectionBinding(selection.id, binding.id);
    harness.store.setBindingPrimaryToolCapability({ bindingId: binding.id, expectedGeneration: 1, capabilityHash: capabilityHash("test-binding-1-1") });
    binding = harness.store.updateBinding(binding.id, { paneId: "w1:p9", traexSessionId: "term-1" });
    harness.store.transitionBinding(binding.id, { type: "pane_created" });

    await harness.coordinator.start();

    expect(harness.created).toBe(1);
    expect(harness.createdCalls).toEqual([expect.objectContaining({
      bindingId: "binding-1", generation: 2, projectId: "alpha",
      title: expect.stringMatching(/^[a-z0-9]{4}$/),
      environment: { SWARM_PRIMARY_CAPABILITY: "test-binding-1-2" }
    })]);
    expect(harness.startedPaneIds).toEqual(["w1:p10"]);
    expect(harness.startedCalls).toEqual([{ paneId: "w1:p10", args: primaryToolArgs("binding-1", 2) }]);
    expect(harness.store.hasBindingPrimaryToolCapability("binding-1", 2)).toBe(true);
    expect(harness.store.getProjectSelection(selection.id)).toMatchObject({ state: "completed" });
    expect(harness.store.getBinding(binding.id)).toMatchObject({
      state: "active", lifecycle: "active", provisioningCheckpoint: "activated",
      paneId: "w1:p10", traexSessionId: "term-2", generation: 2, lastAgentState: "idle"
    });
    expect(harness.store.findBindingByPane("w1:p9")).toBeNull();
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

  it("terminalizes a project selection whose provisioned pane is confirmed missing", async () => {
    const harness = createHarness({ paneMissing: true });
    const selection = createProcessingSelection(harness.store);
    let binding = harness.store.createPendingBinding({ id: "binding-1", projectId: "alpha", workspaceId: "w1", chatId: "chat", topicId: null, rootMessageId: null, title: "Alpha / task" });
    harness.store.linkProjectSelectionBinding(selection.id, binding.id);
    binding = harness.store.updateBinding(binding.id, { paneId: "w1:p9", traexSessionId: "term-1" });
    harness.store.transitionBinding(binding.id, { type: "pane_created" });

    await harness.coordinator.start();

    expect(harness.store.getProjectSelection(selection.id)).toMatchObject({ state: "failed", error: expect.stringContaining("no longer exists") });
    expect(harness.store.getBinding(binding.id)).toMatchObject({ state: "failed", lifecycle: "failed" });
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

function createHarness(options: { terminalId?: string; paneMissing?: boolean; occupiedUnreadyPane?: boolean } = {}) {
  const store = new SqliteBindingStore(":memory:");
  let created = 0; let started = 0; let topics = 0; const topicKeys: Array<string | undefined> = []; const startedPaneIds: string[] = [];
  const createdCalls: Array<Record<string, unknown>> = []; const startedCalls: Array<{ paneId: string; args: string[] | undefined }> = [];
  const pane: HerdrPane = { paneId: "w1:p9", terminalId: options.terminalId ?? "term-1", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"] };
  const replacement: HerdrPane = { paneId: "w1:p10", terminalId: "term-2", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"] };
  const herdr: HerdrPort = {
    async assertWorkspace() {}, async listPanes() { return options.paneMissing ? [] : [pane]; },
    async getPane(paneId) { return options.paneMissing ? null : paneId === replacement.paneId ? replacement : pane; },
    async observeRuntime(paneId) {
      if (paneId === replacement.paneId) return { pane: replacement, traexProcess: true, composerReady: true, evidenceSource: "structured" };
      return { pane, traexProcess: true, composerReady: !options.occupiedUnreadyPane, evidenceSource: options.occupiedUnreadyPane ? "process" : "structured" };
    },
    async createPane(_workspaceId, _cwd, createOptions) { created += 1; createdCalls.push(createOptions ?? {}); return options.occupiedUnreadyPane ? replacement : pane; },
    async startTraex(paneId, _executable, args) { started += 1; startedPaneIds.push(paneId); startedCalls.push({ paneId, args }); }, async runPrompt() { return "done"; }, async renamePane() {}
  };
  const lark: LarkPort = {
    async start() {}, async stop() {}, isReady: () => true,
    async createTopic(_card, idempotencyKey) { topics += 1; topicKeys.push(idempotencyKey); return { topicId: `topic-${topics}`, rootMessageId: `root-${topics}` }; },
    async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {}
  };
  const bus = new BridgeEventBus();
  const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
  const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false })); projector.start();
  const coordinator = createTestRouter(config(), store, herdr, lark, bus, publisher, pino({ enabled: false }));
  return { store, coordinator, get created() { return created; }, get createdCalls() { return createdCalls; }, get started() { return started; }, get startedPaneIds() { return startedPaneIds; }, get startedCalls() { return startedCalls; }, get topics() { return topics; }, get topicKeys() { return topicKeys; }, async close() { await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close(); } };
}

function primaryToolArgs(bindingId: string, generation: number): string[] {
  return [
    "-c", 'mcp_servers.herdr_agent_swarm.command="node"',
    "-c", `mcp_servers.herdr_agent_swarm.args=["primary-tools","--binding","${bindingId}","--generation","${generation}"]`,
    "-c", 'mcp_servers.herdr_agent_swarm.env_vars=["SWARM_PRIMARY_CAPABILITY"]'
  ];
}

function capabilityHash(capability: string): string { return createHash("sha256").update(capability).digest("hex"); }

function config(): BridgeConfig {
  return {
    lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", allowedOpenIds: ["u1", "u2", "creator", "user", "user-1"], adminOpenIds: ["u1", "u2", "creator", "user", "user-1"] },
    herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" },
    projects: [{ id: "alpha", displayName: "Alpha", description: "Alpha", workspaceId: "w1", cwd: "/repo" }], defaultProjectId: "alpha", projectsConfigPath: "test", traex: { executable: "traex" },
    databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
  };
}
