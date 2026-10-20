import pino from "pino";
import { createHash } from "node:crypto";
import { describe, expect, it, vi } from "vitest";
import type { BridgeConfig } from "../src/config.js";
import { createTestRouter } from "./helpers/create-test-router.js";
import type { HerdrPort, LarkPort } from "../src/domain/ports.js";
import type { HerdrPane } from "../src/domain/types.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { TestConversationViewProjector as ConversationViewProjector } from "./helpers/create-test-conversation-view-projector.js";
import { createTestPublisher } from "./helpers/create-test-outbound.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { primaryPresentation } from "./helpers/presentation.js";

describe("project provisioning recovery", () => {
  it("lazily creates one managed Orchestrator at its configured cwd and reuses its fixed Thread", async () => {
    const harness = createHarness({ paneAppearsOnCreate: true, orchestrator: true, workspaces: [{ workspaceId: "w1", label: "Alpha" }, { workspaceId: "w4", label: "herdr" }] });
    await harness.coordinator.start();

    await harness.coordinator.handleMessage({ eventId: "orchestrator-first", messageId: "orchestrator-first", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "orchestrator-first", actorOpenId: "user", text: "coordinate this", mentionsBot: true, isRootMessage: true });

    const binding = harness.store.findOrchestratorBinding("feishu:primary", "chat");
    expect(binding).toMatchObject({ kind: "orchestrator", state: "active", lifecycle: "active", topicId: "topic-1", rootMessageId: "root-1", workspaceId: "w4", paneId: "w4:p9", paneToken: "orch", traexSessionId: "term-1" });
    expect(harness.created).toBe(0);
    expect(harness.createdV2).toHaveLength(1);
    expect(harness.createdV2[0]).toMatchObject({ workspaceId: "w4", expectedWorkspaceLabel: "herdr", token: "orch", cwd: "/orchestrator" });
    expect(harness.createdCwds).toEqual([]);
    expect(harness.store.database.prepare("SELECT source_message_key, text, expected_session_id, state FROM submission_intents WHERE owner_id = ?").all(binding!.id)).toEqual([
      { source_message_key: "orchestrator-first", text: "coordinate this", expected_session_id: null, state: "prepared" }
    ]);
    await harness.coordinator.handleMessage({ eventId: "orchestrator-first", messageId: "orchestrator-first", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "orchestrator-first", actorOpenId: "user", text: "coordinate this", mentionsBot: true, isRootMessage: true });
    expect(harness.createdV2).toHaveLength(1);
    expect(harness.shared).toEqual([]);

    await harness.coordinator.handleMessage({ eventId: "orchestrator-thread", messageId: "orchestrator-thread", parentMessageId: "root-1", chatId: "chat", topicId: "topic-1", rootMessageId: "root-1", actorOpenId: "user", text: "continue without mention", mentionsBot: false, isRootMessage: false });

    await harness.coordinator.handleMessage({ eventId: "orchestrator-later", messageId: "orchestrator-later", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "orchestrator-later", actorOpenId: "user", text: "do not submit this", mentionsBot: true, isRootMessage: true });

    expect(harness.createdV2).toHaveLength(1);
    expect(harness.shared).toEqual([{ topicId: "topic-1", messageId: "orchestrator-later", chatId: "chat", sourceRootMessageId: "root-1" }]);
    expect(harness.store.database.prepare("SELECT source_message_key FROM submission_intents WHERE owner_id = ? ORDER BY created_at, rowid").all(binding!.id)).toEqual([
      { source_message_key: "orchestrator-first" }, { source_message_key: "orchestrator-thread" }
    ]);
    expect(harness.store.database.prepare("SELECT (SELECT COUNT(*) FROM prompt_inputs) AS inputs, (SELECT COUNT(*) FROM native_input_batches) AS batches, (SELECT COUNT(*) FROM prompt_jobs) AS jobs").get()).toEqual({ inputs: 0, batches: 0, jobs: 0 });
    expect(harness.store.database.prepare("SELECT text, owner_id, pane_id, terminal_id, expected_agent_kind, state FROM submission_intents WHERE source_message_key = ?").get("orchestrator-thread")).toEqual({
      text: "continue without mention", owner_id: binding!.id, pane_id: "w4:p9", terminal_id: "term-1", expected_agent_kind: "traex", state: "prepared"
    });
    await harness.close();
  });

  it.each([
    ["missing", [{ workspaceId: "w1", label: "Alpha" }]],
    ["duplicate", [{ workspaceId: "w4", label: "herdr" }, { workspaceId: "w5", label: "herdr" }]]
  ])("fails closed before Orchestrator creation when the exact herdr Space is %s", async (_case, workspaces) => {
    const harness = createHarness({ paneAppearsOnCreate: true, orchestrator: true, workspaces });
    await harness.coordinator.start();

    await harness.coordinator.handleMessage({ eventId: `orchestrator-${_case}`, messageId: `orchestrator-${_case}`, parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: `orchestrator-${_case}`, actorOpenId: "user", text: "coordinate this", mentionsBot: true, isRootMessage: true });

    expect(harness.created).toBe(0);
    expect(harness.createdV2).toHaveLength(0);
    expect(harness.store.findOrchestratorBinding("feishu:primary", "chat")).toBeNull();
    await harness.close();
  });

  it("does not fall back to automatic allocation when fixed-token creation is rejected", async () => {
    const harness = createHarness({ paneAppearsOnCreate: true, orchestrator: true, createV2Outcome: "token-conflict" });
    await harness.coordinator.start();

    await harness.coordinator.handleMessage({ eventId: "orchestrator-conflict", messageId: "orchestrator-conflict", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "orchestrator-conflict", actorOpenId: "user", text: "coordinate this", mentionsBot: true, isRootMessage: true });

    expect(harness.createdV2).toHaveLength(1);
    expect(harness.created).toBe(0);
    expect(harness.store.findOrchestratorBinding("feishu:primary", "chat")).toMatchObject({ lifecycle: "provisioning", provisioningCheckpoint: "selected", paneId: null });
    await harness.close();
  });

  it("rejects fixed Orchestrator provisioning before Binding reservation when tab.create.v2 is unavailable", async () => {
    const harness = createHarness({ paneAppearsOnCreate: true, orchestrator: true, paneCreationV2Supported: false });
    await harness.coordinator.start();

    await harness.coordinator.handleMessage({ eventId: "orchestrator-unsupported", messageId: "orchestrator-unsupported", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "orchestrator-unsupported", actorOpenId: "user", text: "coordinate this", mentionsBot: true, isRootMessage: true });

    expect(harness.createdV2).toHaveLength(0);
    expect(harness.created).toBe(0);
    expect(harness.store.findOrchestratorBinding("feishu:primary", "chat")).toBeNull();
    await harness.close();
  });

  it("preserves the selected checkpoint when Core rejects a concurrent herdr label rename", async () => {
    const harness = createHarness({ paneAppearsOnCreate: true, orchestrator: true, createV2Outcome: "label-mismatch" });
    await harness.coordinator.start();

    await harness.coordinator.handleMessage({ eventId: "orchestrator-label-race", messageId: "orchestrator-label-race", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "orchestrator-label-race", actorOpenId: "user", text: "coordinate this", mentionsBot: true, isRootMessage: true });

    expect(harness.createdV2).toHaveLength(1);
    expect(harness.created).toBe(0);
    expect(harness.store.findOrchestratorBinding("feishu:primary", "chat")).toMatchObject({ workspaceId: "w4", provisioningCheckpoint: "selected", paneId: null });
    await harness.close();
  });

  it("converges concurrent Orchestrator root mentions on one Pane and one initial Agent Input", async () => {
    const harness = createHarness({ paneAppearsOnCreate: true, orchestrator: true });
    await harness.coordinator.start();
    const rootMessage = (id: string) => ({ eventId: id, messageId: id, parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: id, actorOpenId: "user", text: `coordinate ${id}`, mentionsBot: true, isRootMessage: true });

    await Promise.all([
      harness.coordinator.handleMessage(rootMessage("orchestrator-a")),
      harness.coordinator.handleMessage(rootMessage("orchestrator-b"))
    ]);

    const binding = harness.store.findOrchestratorBinding("feishu:primary", "chat");
    expect(binding).not.toBeNull();
    expect(harness.createdV2).toHaveLength(1);
    expect(harness.topics).toBe(1);
    expect(harness.store.database.prepare("SELECT source_message_key FROM submission_intents WHERE owner_id = ?").all(binding!.id)).toHaveLength(1);
    expect(harness.store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE binding_id = ?").get(binding!.id)).toEqual({ count: 0 });
    expect(harness.shared).toHaveLength(1);
    await harness.close();
  });

  it("does not initialize an Orchestrator for an unauthorized actor", async () => {
    const harness = createHarness({ paneAppearsOnCreate: true, orchestrator: true });
    await harness.coordinator.start();

    await harness.coordinator.handleMessage({ eventId: "orchestrator-intruder", messageId: "orchestrator-intruder", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "orchestrator-intruder", actorOpenId: "intruder", text: "coordinate this", mentionsBot: true, isRootMessage: true });

    expect(harness.store.findOrchestratorBinding("feishu:primary", "chat")).toBeNull();
    expect(harness.created).toBe(0);
    await harness.close();
  });

  it("recovers an Orchestrator runtime checkpoint against the configured Orchestrator cwd", async () => {
    const harness = createHarness({ orchestrator: true });
    const selection = createProcessingSelection(harness.store, { commandMessageId: "orchestrator-source", initialPromptText: "recover this exactly once" });
    let binding = harness.store.createPendingBinding({ id: "orchestrator-recovery", kind: "orchestrator", projectId: "alpha", workspaceId: "w1", chatId: "chat", topicId: null, rootMessageId: null, title: "Orchestrator" });
    harness.store.linkProjectSelectionBinding(selection.id, binding.id);
    harness.store.setBindingPrimaryToolCapability({ bindingId: binding.id, expectedGeneration: 1, capabilityHash: capabilityHash("test-orchestrator-recovery-1") });
    binding = harness.store.updateBinding(binding.id, { paneId: "w1:p9", traexSessionId: "term-1" });
    binding = harness.store.transitionBinding(binding.id, { type: "pane_created" });
    harness.store.transitionBinding(binding.id, { type: "runtime_started" });

    await harness.coordinator.start();

    expect(harness.created).toBe(0);
    expect(harness.started).toBe(0);
    expect(harness.topics).toBe(1);
    expect(harness.store.getBinding(binding.id)).toMatchObject({ kind: "orchestrator", state: "active", lifecycle: "active", topicId: "topic-1" });
    expect(harness.store.database.prepare("SELECT source_message_key, text, expected_session_id, state FROM submission_intents WHERE owner_id = ?").all(binding.id)).toEqual([
      { source_message_key: "orchestrator-source", text: "recover this exactly once", expected_session_id: null, state: "prepared" }
    ]);
    await harness.close();
  });

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

  it("pauses a pane_created checkpoint when foreground process observation is unavailable", async () => {
    const harness = createHarness({ processProbeUnavailable: true });
    const selection = createProcessingSelection(harness.store);
    let binding = harness.store.createPendingBinding({ id: "binding-1", projectId: "alpha", workspaceId: "w1", chatId: "chat", topicId: null, rootMessageId: null, title: "Alpha / task" });
    harness.store.linkProjectSelectionBinding(selection.id, binding.id);
    harness.store.setBindingPrimaryToolCapability({ bindingId: binding.id, expectedGeneration: 1, capabilityHash: capabilityHash("test-binding-1-1") });
    binding = harness.store.updateBinding(binding.id, { paneId: "w1:p9", traexSessionId: "term-1" });
    harness.store.transitionBinding(binding.id, { type: "pane_created" });

    await harness.coordinator.start();

    expect(harness.started).toBe(0);
    expect(harness.created).toBe(0);
    expect(harness.store.getProjectSelection(selection.id)).toMatchObject({ state: "processing", error: expect.stringContaining("process probe is unavailable") });
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
    expect(harness.store.loadRuntimeIdentityClaim({ bindingId: binding.id, bindingGeneration: 1, sessionEpoch: 1 })).toMatchObject({ state: "released" });
    expect(harness.store.loadRuntimeIdentityClaim({ bindingId: binding.id, bindingGeneration: 2, sessionEpoch: 1 })).toMatchObject({ state: "unclaimed" });
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

  it("resumes an automatic default selection before any pane was created", async () => {
    const harness = createHarness({ paneAppearsOnCreate: true });
    const selection = harness.store.createAutomaticProjectSelection({
      id: "automatic-1", commandMessageId: "root-task", chatId: "chat", topicId: "root-task", rootMessageId: "root-task", actorOpenId: "user",
      requestedTitle: "task", initialPromptText: "do the work", projectId: "alpha", expiresAt: "2099-01-01T00:00:00.000Z"
    });

    await harness.coordinator.start();

    expect(harness.created).toBe(1);
    expect(harness.started).toBe(1);
    expect(harness.topics).toBe(1);
    expect(harness.store.getProjectSelection(selection.id)).toMatchObject({ state: "completed", selectedProjectId: "alpha", bindingId: expect.any(String), error: null });
    expect(harness.store.listBindings()).toEqual([expect.objectContaining({ projectId: "alpha", workspaceId: "w1", state: "active" })]);
    await harness.close();
  });
});

function createProcessingSelection(store: SqliteBindingStore, options: { commandMessageId?: string; initialPromptText?: string } = {}) {
  const commandMessageId = options.commandMessageId ?? "command-1";
  const selection = store.createProjectSelection({ id: "selection-1", commandMessageId, chatId: "chat", topicId: null, rootMessageId: commandMessageId, actorOpenId: "user", requestedTitle: "task", initialPromptText: options.initialPromptText, expiresAt: "2099-01-01T00:00:00.000Z", card: {} });
  const outbound = store.listPendingOutboundReplies()[0]!;
  store.markOutboundReplyDelivered(outbound.id, "selector-1");
  store.claimProjectSelection({ selectionId: selection.id, projectId: "alpha", messageId: "selector-1", chatId: "chat", actorOpenId: "user", allowedProjectIds: ["alpha"] });
  return selection;
}

function createHarness(options: { terminalId?: string; paneMissing?: boolean; occupiedUnreadyPane?: boolean; processProbeUnavailable?: boolean; paneAppearsOnCreate?: boolean; orchestrator?: boolean; workspaces?: Array<{ workspaceId: string; label: string }>; paneCreationV2Supported?: boolean; createV2Outcome?: "created" | "token-conflict" | "label-mismatch" } = {}) {
  const store = new SqliteBindingStore(":memory:");
  let created = 0; let started = 0; let topics = 0; const topicKeys: Array<string | undefined> = []; const startedPaneIds: string[] = [];
  const createdCwds: string[] = []; const shared: Array<{ topicId: string; messageId: string; chatId: string; sourceRootMessageId?: string }> = [];
  const createdCalls: Array<Record<string, unknown>> = []; const startedCalls: Array<{ paneId: string; args: string[] | undefined }> = [];
  const orchestratorWorkspaceId = options.workspaces?.find((workspace) => workspace.label === "herdr")?.workspaceId ?? "w4";
  const pane: HerdrPane = { paneId: options.orchestrator ? `${orchestratorWorkspaceId}:p9` : "w1:p9", paneToken: options.orchestrator ? "orch" : null, terminalId: options.terminalId ?? "term-1", workspaceId: options.orchestrator ? orchestratorWorkspaceId : "w1", cwd: options.orchestrator ? "/orchestrator" : "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"] };
  const replacement: HerdrPane = { paneId: "w1:p10", terminalId: "term-2", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"] };
  const paneAtCreatedCwd = (value: HerdrPane) => ({ ...value, cwd: createdCwds.at(-1) ?? value.cwd });
  const createdV2: Array<Record<string, unknown>> = [];
  const herdr = {
    async assertWorkspace() {}, async listPanes() { return options.paneMissing || options.paneAppearsOnCreate ? [] : [pane]; },
    async listWorkspaces() { return options.workspaces ?? [{ workspaceId: "w4", label: "herdr" }]; },
    async getPane(paneId) { return options.paneMissing || options.paneAppearsOnCreate && created === 0 ? null : paneAtCreatedCwd(paneId === replacement.paneId ? replacement : pane); },
    async observeRuntime(paneId) {
      if (paneId === replacement.paneId) return { pane: paneAtCreatedCwd(replacement), traexProcess: true, composerReady: true, evidenceSource: "structured" };
      if (options.processProbeUnavailable) return { pane: paneAtCreatedCwd(pane), traexProcess: false, composerReady: false, evidenceSource: "process", processProbe: "unavailable" as const };
      return { pane: paneAtCreatedCwd(pane), traexProcess: true, composerReady: !options.occupiedUnreadyPane, evidenceSource: options.occupiedUnreadyPane ? "process" : "structured" };
    },
    async createPane(_workspaceId, cwd, createOptions) { created += 1; createdCwds.push(cwd); createdCalls.push(createOptions ?? {}); return paneAtCreatedCwd(options.occupiedUnreadyPane ? replacement : pane); },
    async supportsPaneCreationV2() { return options.paneCreationV2Supported ?? true; },
    async createPaneV2(input: Record<string, unknown>) {
      createdV2.push(input);
      if (options.createV2Outcome === "token-conflict") return { outcome: "token-conflict" as const, code: "pane_token_conflict", reason: "orch is occupied" };
      if (options.createV2Outcome === "label-mismatch") return { outcome: "label-mismatch" as const, code: "workspace_label_mismatch", reason: "herdr was renamed" };
      return { outcome: "created" as const, receipt: { workspaceId: input.workspaceId as string, tabId: `${input.workspaceId}:t9`, paneId: `${input.workspaceId}:p9`, terminalId: options.terminalId ?? "term-1", token: "orch" } };
    },
    async startTraex(paneId, _executable, args) { started += 1; startedPaneIds.push(paneId); startedCalls.push({ paneId, args }); }, async runPrompt() { return "done"; }, async renamePane() {}
  } as HerdrPort;
  const lark: LarkPort = {
    async start() {}, async stop() {}, isReady: () => true,
    async createTopic(_card, idempotencyKey) { topics += 1; topicKeys.push(idempotencyKey); return { topicId: `topic-${topics}`, rootMessageId: `root-${topics}` }; },
    async replyText() { return { messageId: "text" }; }, async replyCard() { return { messageId: "card" }; }, async updateCard() {},
    async shareThread(topicId, target) { shared.push({ topicId, ...target }); return { messageId: `shared-${shared.length}` }; }
  };
  const bus = new BridgeEventBus();
  const publisher = createTestPublisher(store, lark, pino({ enabled: false })); publisher.start();
  const projector = new ConversationViewProjector(bus, store, publisher, publisher, pino({ enabled: false }), primaryPresentation); projector.start();
  const coordinator = createTestRouter(config(options.orchestrator), store, herdr, lark, bus, publisher, pino({ enabled: false }));
  return { store, coordinator, get created() { return created; }, get createdV2() { return createdV2; }, get createdCwds() { return createdCwds; }, get createdCalls() { return createdCalls; }, get started() { return started; }, get startedPaneIds() { return startedPaneIds; }, get startedCalls() { return startedCalls; }, get topics() { return topics; }, get topicKeys() { return topicKeys; }, get shared() { return shared; }, async close() { await coordinator.stop(); await projector.stop(); await publisher.stop(); store.close(); } };
}

function primaryToolArgs(bindingId: string, generation: number): string[] {
  return [
    "-c", 'mcp_servers.herdr_agent_swarm.command="node"',
    "-c", `mcp_servers.herdr_agent_swarm.args=["primary-tools","--binding","${bindingId}","--generation","${generation}"]`,
    "-c", 'mcp_servers.herdr_agent_swarm.env_vars=["SWARM_PRIMARY_CAPABILITY"]'
  ];
}

function capabilityHash(capability: string): string { return createHash("sha256").update(capability).digest("hex"); }

function config(orchestrator = false): BridgeConfig {
  return {
    gateway: { kind: "feishu", id: "feishu:primary" },
    lark: { appId: "app", appSecret: "secret", chatId: "chat", botOpenId: "bot", allowedOpenIds: ["u1", "u2", "creator", "user", "user-1"], adminOpenIds: ["u1", "u2", "creator", "user", "user-1"] },
    herdr: { workspaceId: "w1", workspaceCwd: "/repo", executable: "herdr" },
    projects: [{ id: "alpha", displayName: "Alpha", description: "Alpha", workspaceId: "w1", cwd: "/repo", ...(orchestrator ? { orchestrator: { enabled: true, cwd: "/orchestrator" } } : {}) }], defaultProjectId: "alpha", projectsConfigPath: "test", traex: { executable: "traex" },
    databasePath: ":memory:", http: { host: "127.0.0.1", port: 8787 }, logLevel: "silent", commandTimeoutMs: 1000, turnTimeoutMs: 1000, reconcileIntervalMs: 60_000, maxQueueDepth: 20, larkMessageChunkSize: 3500
  };
}
