import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { HerdrRuntimeReconciler } from "../src/coordinator/herdr-runtime-reconciler.js";
import type { HerdrPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { InProcessPromptWorkScheduler } from "../src/events/prompt-work-scheduler.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("HerdrRuntimeReconciler", () => {
  it("coalesces overlapping reconciliation calls into one workspace scan", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const listPanes = vi.fn(async () => { await blocked; return []; });
    const herdr = { listPanes } as unknown as HerdrPort;
    const store = new SqliteBindingStore(":memory:");
    const reconciler = new HerdrRuntimeReconciler({
      projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }],
      store,
      herdr,
      lifecycleEvents: new BridgeEventBus(),
      channelPublisher: { async drain() {}, async enqueueRunCardUpdate() {} },
      logger: pino({ enabled: false }),
      discoverPane: async () => { throw new Error("not used"); },
      scheduler: new InProcessPromptWorkScheduler(),
      isBindingBusy: () => false
    });

    const first = reconciler.reconcile();
    const second = reconciler.reconcile();
    await vi.waitFor(() => expect(listPanes).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);

    expect(listPanes).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("starts one timer and stop waits for the in-flight pass", async () => {
    vi.useFakeTimers();
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const listPanes = vi.fn(async () => { await blocked; return []; });
    const store = new SqliteBindingStore(":memory:");
    const reconciler = fixture(store, { listPanes } as unknown as HerdrPort);
    reconciler.start(100);
    reconciler.start(100);

    await vi.advanceTimersByTimeAsync(100);
    expect(listPanes).toHaveBeenCalledTimes(1);
    let stopped = false;
    const stopping = reconciler.stop().then(() => { stopped = true; });
    await Promise.resolve();
    expect(stopped).toBe(false);
    release();
    await stopping;
    await vi.advanceTimersByTimeAsync(200);
    expect(listPanes).toHaveBeenCalledTimes(1);

    store.close();
    vi.useRealTimers();
  });

  it("adds a discovered Pane to the pass-local map immediately", async () => {
    const pane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const herdr = { async listPanes() { return [pane, pane]; }, async readOutput() { return ""; } } as unknown as HerdrPort;
    const store = new SqliteBindingStore(":memory:");
    const discoverPane = vi.fn(async () => {
      let binding = store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: null, rootMessageId: null, title: "task" });
      binding = store.updateBinding(binding.id, { paneId: pane.paneId });
      return binding;
    });
    const reconciler = fixture(store, herdr, discoverPane);

    await reconciler.reconcile();

    expect(discoverPane).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("scans only requested workspaces for event-driven reconciliation", async () => {
    const listPanes = vi.fn(async () => []);
    const store = new SqliteBindingStore(":memory:");
    const reconciler = new HerdrRuntimeReconciler({
      projects: [
        { id: "one", displayName: "One", description: "One", workspaceId: "w1", cwd: "/one" },
        { id: "two", displayName: "Two", description: "Two", workspaceId: "w2", cwd: "/two" }
      ],
      store, herdr: { listPanes } as unknown as HerdrPort, lifecycleEvents: new BridgeEventBus(),
      channelPublisher: { async drain() {}, async enqueueRunCardUpdate() {} }, logger: pino({ enabled: false }),
      discoverPane: async () => { throw new Error("not used"); }, scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false
    });

    await reconciler.requestReconciliation(["w2"]);

    expect(listPanes).toHaveBeenCalledTimes(1);
    expect(listPanes).toHaveBeenCalledWith("w2");
    store.close();
  });

  it("runs a follow-up pass when an event arrives during reconciliation", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const listPanes = vi.fn(async (workspaceId: string) => { if (workspaceId === "w1") await blocked; return []; });
    const store = new SqliteBindingStore(":memory:");
    const reconciler = new HerdrRuntimeReconciler({
      projects: [
        { id: "one", displayName: "One", description: "One", workspaceId: "w1", cwd: "/one" },
        { id: "two", displayName: "Two", description: "Two", workspaceId: "w2", cwd: "/two" }
      ],
      store, herdr: { listPanes } as unknown as HerdrPort, lifecycleEvents: new BridgeEventBus(),
      channelPublisher: { async drain() {}, async enqueueRunCardUpdate() {} }, logger: pino({ enabled: false }),
      discoverPane: async () => { throw new Error("not used"); }, scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false
    });

    const first = reconciler.requestReconciliation(["w1"]);
    await vi.waitFor(() => expect(listPanes).toHaveBeenCalledWith("w1"));
    const second = reconciler.requestReconciliation(["w2"]);
    release();
    await Promise.all([first, second]);

    expect(listPanes.mock.calls.map(([workspaceId]) => workspaceId)).toEqual(["w1", "w2"]);
    store.close();
  });

  it("skips terminal reads when the Herdr output revision is unchanged", async () => {
    const store = new SqliteBindingStore(":memory:");
    let binding = store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    binding = store.updateBinding(binding.id, { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    const readOutput = vi.fn(async () => "unchanged");
    const pane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, agentKind: "traex", outputRevision: 7, stateChangeSeq: 1, foregroundExecutables: ["traex"] };
    const reconciler = fixture(store, { async listPanes() { return [pane]; }, readOutput } as unknown as HerdrPort);

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(readOutput).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("reads terminal output when the output revision changes even if agent state does not", async () => {
    const store = new SqliteBindingStore(":memory:");
    let binding = store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    binding = store.updateBinding(binding.id, { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    let outputRevision = 7;
    const readOutput = vi.fn(async () => "◆ local answer\n────────");
    const pane = () => ({
      paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const,
      agentKind: "traex", outputRevision, stateChangeSeq: 1, foregroundExecutables: ["traex"]
    });
    const reconciler = fixture(store, { async listPanes() { return [pane()]; }, readOutput } as unknown as HerdrPort);

    await reconciler.reconcile();
    await reconciler.reconcile();
    outputRevision = 8;
    await reconciler.reconcile();

    expect(readOutput).toHaveBeenCalledTimes(2);
    store.close();
  });

  it("accepts a restored terminal identity only when the native Agent session matches", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", {
      paneId: "w1:p1", traexSessionId: "old-terminal", agentSessionSource: "codex-hook", agentSessionAgent: "codex",
      agentSessionKind: "id", agentSessionValue: "conversation-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated"
    });
    const pane = {
      paneId: "w1:p1", terminalId: "new-terminal", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const,
      agentKind: "codex", agentSession: { source: "codex-hook", agent: "codex", kind: "id" as const, value: "conversation-1" }, outputRevision: 7, stateChangeSeq: 1, foregroundExecutables: ["traex"]
    };
    const reconciler = fixture(store, { async listPanes() { return [pane]; }, async readOutput() { return ""; } } as unknown as HerdrPort);

    await reconciler.reconcile();

    expect(store.getBinding("b1")).toMatchObject({ traexSessionId: "new-terminal", attachment: "attached", state: "active" });
    store.close();
  });

  it("learns a newly reported native Agent session without changing terminal identity", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", {
      paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated"
    });
    const pane = {
      paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const,
      agentKind: "codex", agentSession: { source: "codex-hook", agent: "codex", kind: "id" as const, value: "conversation-1" }, outputRevision: 7, stateChangeSeq: 1, foregroundExecutables: ["traex"]
    };
    const reconciler = fixture(store, { async listPanes() { return [pane]; }, async readOutput() { return ""; } } as unknown as HerdrPort);

    await reconciler.reconcile();

    expect(store.getBinding("b1")).toMatchObject({
      traexSessionId: "term-1", agentSessionSource: "codex-hook", agentSessionAgent: "codex",
      agentSessionKind: "id", agentSessionValue: "conversation-1", attachment: "attached"
    });
    store.close();
  });

  it("preserves a persisted native Agent session when the same terminal reports a different one", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", {
      paneId: "w1:p1", traexSessionId: "term-1", agentSessionSource: "codex-hook", agentSessionAgent: "codex",
      agentSessionKind: "id", agentSessionValue: "conversation-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated"
    });
    const pane = {
      paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const,
      agentKind: "codex", agentSession: { source: "codex-hook", agent: "codex", kind: "id" as const, value: "conversation-2" }, outputRevision: 7, stateChangeSeq: 1, foregroundExecutables: ["traex"]
    };
    const logger = pino({ enabled: false });
    const warning = vi.spyOn(logger, "warn");
    const reconciler = fixture(store, { async listPanes() { return [pane]; }, async readOutput() { return ""; } } as unknown as HerdrPort, undefined, logger);

    await reconciler.reconcile();

    expect(store.getBinding("b1")).toMatchObject({ agentSessionValue: "conversation-1", attachment: "attached" });
    expect(warning).toHaveBeenCalledWith(expect.objectContaining({ event: "binding-agent-session-mismatch" }), expect.any(String));
    store.close();
  });

  it("orphans a changed terminal when the native Agent session differs", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", {
      paneId: "w1:p1", traexSessionId: "old-terminal", agentSessionSource: "codex-hook", agentSessionAgent: "codex",
      agentSessionKind: "id", agentSessionValue: "conversation-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated"
    });
    const pane = {
      paneId: "w1:p1", terminalId: "new-terminal", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const,
      agentKind: "codex", agentSession: { source: "codex-hook", agent: "codex", kind: "id" as const, value: "another-conversation" }, outputRevision: 7, stateChangeSeq: 1, foregroundExecutables: ["traex"]
    };
    const reconciler = fixture(store, { async listPanes() { return [pane]; }, async readOutput() { return ""; } } as unknown as HerdrPort);

    await reconciler.reconcile();

    expect(store.getBinding("b1")).toMatchObject({ traexSessionId: "old-terminal", attachment: "orphaned", state: "orphaned" });
    store.close();
  });

  it("does not orphan panes when the authoritative snapshot is unavailable", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    const herdr = { async listAllPanes() { throw new Error("Herdr unavailable"); }, async listPanes() { throw new Error("legacy pane discovery unavailable"); } } as unknown as HerdrPort;
    const reconciler = fixture(store, herdr);

    await reconciler.reconcile();

    expect(store.getBinding("b1")).toMatchObject({ attachment: "degraded", degradationCount: 1 });
    store.close();
  });

  it("falls back to workspace pane discovery when the authoritative snapshot is unavailable", async () => {
    const store = new SqliteBindingStore(":memory:");
    let binding = store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    binding = store.updateBinding(binding.id, { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    const pane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, agentKind: "traex", stateChangeSeq: 1, foregroundExecutables: ["traex"] };
    const listPanes = vi.fn(async () => [pane]);
    const herdr = { async listAllPanes() { throw new Error("snapshot schema unsupported"); }, listPanes, async readOutput() { return ""; } } as unknown as HerdrPort;
    const reconciler = fixture(store, herdr);

    await reconciler.reconcile();

    expect(listPanes).toHaveBeenCalledOnce();
    expect(listPanes).toHaveBeenCalledWith("w1");
    expect(store.getBinding(binding.id)).toMatchObject({ attachment: "attached", degradationCount: 0 });
    store.close();
  });

  it("enriches an unknown bound pane and wakes its queued FIFO", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", lastAgentState: "unknown" });
    store.enqueuePrompt({ id: "queued", bindingId: "b1", larkMessageId: "message-1", actorOpenId: "user", body: "queued work" });
    const unknownPane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "unknown" as const, agentKind: null, stateChangeSeq: 9, foregroundExecutables: [] };
    const observedPane = { ...unknownPane, agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const observeRuntime = vi.fn(async () => ({ pane: observedPane, traexProcess: true, composerReady: true, evidenceSource: "visible" as const }));
    const wake = vi.fn();
    const scheduler = new InProcessPromptWorkScheduler();
    scheduler.subscribe(wake);
    const reconciler = new HerdrRuntimeReconciler({
      projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }],
      store, herdr: { async listAllPanes() { return [unknownPane]; }, observeRuntime, async readOutput() { return "❯ Use /skills to list available skills"; } } as unknown as HerdrPort,
      lifecycleEvents: new BridgeEventBus(), channelPublisher: { async drain() {}, async enqueueRunCardUpdate() {} }, logger: pino({ enabled: false }),
      discoverPane: async () => { throw new Error("not used"); }, scheduler, isBindingBusy: () => false
    });

    await reconciler.reconcile();

    expect(observeRuntime).toHaveBeenCalledWith("w1:p1");
    expect(store.getBinding("b1")).toMatchObject({ lastAgentState: "idle", attachment: "attached" });
    await Promise.resolve();
    expect(wake).toHaveBeenCalledWith({ kind: "binding-runtime-changed", bindingId: "b1" });
    expect(wake).toHaveBeenCalledWith({ kind: "prompt-ready", bindingId: "b1" });
    store.close();
  });
});

function fixture(
  store: SqliteBindingStore,
  herdr: HerdrPort,
  discoverPane: ConstructorParameters<typeof HerdrRuntimeReconciler>[0]["discoverPane"] = async () => { throw new Error("not used"); },
  logger = pino({ enabled: false })
) {
  return new HerdrRuntimeReconciler({
    projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }],
    store, herdr, lifecycleEvents: new BridgeEventBus(),
    channelPublisher: { async drain() {}, async enqueueRunCardUpdate() {} },
    logger, discoverPane, scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false
  });
}
