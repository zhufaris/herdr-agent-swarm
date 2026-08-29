import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { HerdrRuntimeReconciler } from "../src/coordinator/herdr-runtime-reconciler.js";
import type { HerdrPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { InProcessPromptWorkScheduler } from "../src/events/prompt-work-scheduler.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

describe("HerdrRuntimeReconciler", () => {
  it("captures startup baselines with bounded parallel terminal reads", async () => {
    const store = new SqliteBindingStore(":memory:");
    for (let index = 1; index <= 5; index += 1) {
      store.createPendingBinding({ id: `b${index}`, projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: `topic-${index}`, rootMessageId: `root-${index}`, title: `task-${index}` });
      store.updateBinding(`b${index}`, { paneId: `w1:p${index}`, state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    }
    const release = new Map<string, () => void>();
    const readOutput = vi.fn((paneId: string) => new Promise<string>((resolve) => { release.set(paneId, () => resolve("")); }));
    const reconciler = fixture(store, { readOutput } as unknown as HerdrPort);

    const capture = reconciler.captureBaselines();
    await vi.waitFor(() => expect(readOutput).toHaveBeenCalledTimes(4));
    expect(readOutput.mock.calls.map(([paneId]) => paneId).sort()).toEqual(["w1:p1", "w1:p2", "w1:p3", "w1:p4"]);
    for (const releaseRead of release.values()) releaseRead();
    await vi.waitFor(() => expect(readOutput).toHaveBeenCalledTimes(5));
    release.get("w1:p5")!();
    await capture;
    store.close();
  });

  it("captures non-empty startup scrollback without replacing the durable topic answer", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    store.saveTopicView({ ...initialTopicView("b1"), phase: "done", answer: "durable answer", viewVersion: 4 });
    const reconciler = fixture(store, { async readOutput() { return "◆ historical scrollback\n────────\nGPT-5.6-Sol · Auto Mode · 31.1K tokens"; } } as unknown as HerdrPort);

    await reconciler.captureBaselines();

    expect(store.loadTopicView("b1")).toMatchObject({ answer: "durable answer", model: "GPT-5.6-Sol", context: "31.1K tokens", viewVersion: 5 });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ bindingId: "b1", targetRole: "session_status" })]);
    store.close();
  });

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
    expect(reconciler.snapshot()).toMatchObject({ state: "running", runCount: 1, coalescedRequestCount: 1, lastStartedAt: expect.any(String), lastCompletedAt: null });
    release();
    await Promise.all([first, second]);

    expect(listPanes).toHaveBeenCalledTimes(1);
    expect(reconciler.snapshot()).toMatchObject({ state: "idle", runCount: 1, successCount: 1, failureCount: 0, coalescedRequestCount: 1, lastOutcome: "succeeded", lastDurationMs: expect.any(Number), maxDurationMs: expect.any(Number) });
    store.close();
  });

  it("converges an existing binding title from its matching Herdr pane once", async () => {
    const pane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task-esk0", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const herdr = { async listPanes() { return [pane]; }, async readOutput() { return ""; } } as unknown as HerdrPort;
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "legacy prompt title" });
    store.updateBinding("b1", { paneId: pane.paneId, statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "legacy prompt title", workspaceId: "w1", paneId: pane.paneId, phase: "ready" });
    const wakeOutbound = vi.fn();
    const reconciler = fixture(store, herdr, undefined, undefined, undefined, wakeOutbound);

    await reconciler.reconcile();

    expect(store.getBinding("b1")?.title).toBe("repo / task-esk0");
    expect(store.loadTopicView("b1")?.title).toBe("repo / task-esk0");
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ bindingId: "b1", targetRole: "session_status", kind: "card_update" })]);
    expect(wakeOutbound).toHaveBeenCalledOnce();

    await reconciler.reconcile();
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    expect(wakeOutbound).toHaveBeenCalledOnce();
    store.close();
  });

  it("does not replace an existing title from a blank pane label", async () => {
    const pane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "   ", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "repo / retained" });
    store.updateBinding("b1", { paneId: pane.paneId, statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });

    await fixture(store, { async listPanes() { return [pane]; }, async readOutput() { return ""; } } as unknown as HerdrPort).reconcile();

    expect(store.getBinding("b1")?.title).toBe("repo / retained");
    expect(store.listPendingOutboundReplies()).toEqual([]);
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
    expect(reconciler.snapshot().state).toBe("stopping");
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

  it("keeps a pane unclaimed when multiple projects share its workspace and directory", async () => {
    const pane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const store = new SqliteBindingStore(":memory:");
    const discoverPane = vi.fn();
    const reconciler = new HerdrRuntimeReconciler({
      projects: [
        { id: "one", displayName: "One", description: "One", workspaceId: "w1", cwd: "/repo" },
        { id: "two", displayName: "Two", description: "Two", workspaceId: "w1", cwd: "/repo" }
      ],
      store, herdr: { async listPanes() { return [pane]; } } as unknown as HerdrPort, lifecycleEvents: new BridgeEventBus(),
      channelPublisher: { async drain() {}, async enqueueRunCardUpdate() {} }, logger: pino({ enabled: false }),
      discoverPane, scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false
    });

    await reconciler.reconcile();

    expect(discoverPane).not.toHaveBeenCalled();
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
    expect(reconciler.snapshot()).toMatchObject({ runCount: 2, successCount: 2, failureCount: 0, coalescedRequestCount: 1, lastOutcome: "succeeded" });
    store.close();
  });

  it("absorbs an event already covered by the active workspace scan", async () => {
    let release!: () => void;
    const blocked = new Promise<void>((resolve) => { release = resolve; });
    const listPanes = vi.fn(async () => { await blocked; return []; });
    const store = new SqliteBindingStore(":memory:");
    const reconciler = new HerdrRuntimeReconciler({
      projects: [{ id: "one", displayName: "One", description: "One", workspaceId: "w1", cwd: "/one" }],
      store, herdr: { listPanes } as unknown as HerdrPort, lifecycleEvents: new BridgeEventBus(),
      channelPublisher: { async enqueueRunCardUpdate() {} }, logger: pino({ enabled: false }),
      discoverPane: async () => { throw new Error("not used"); }, scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false
    });

    const first = reconciler.requestReconciliation(["w1"]);
    await vi.waitFor(() => expect(listPanes).toHaveBeenCalledTimes(1));
    const duplicate = reconciler.requestReconciliation(["w1"]);
    release();
    await Promise.all([first, duplicate]);

    expect(listPanes).toHaveBeenCalledTimes(1);
    expect(reconciler.snapshot()).toMatchObject({ runCount: 1, successCount: 1, coalescedRequestCount: 1 });
    store.close();
  });

  it("absorbs an event emitted immediately after its workspace scan completes", async () => {
    const listPanes = vi.fn(async () => []);
    const store = new SqliteBindingStore(":memory:");
    const reconciler = new HerdrRuntimeReconciler({
      projects: [{ id: "one", displayName: "One", description: "One", workspaceId: "w1", cwd: "/one" }],
      store, herdr: { listPanes } as unknown as HerdrPort, lifecycleEvents: new BridgeEventBus(),
      channelPublisher: { async enqueueRunCardUpdate() {} }, logger: pino({ enabled: false }),
      discoverPane: async () => { throw new Error("not used"); }, scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false
    });

    await reconciler.requestReconciliation(["w1"]);
    await reconciler.requestReconciliation(["w1"]);

    expect(listPanes).toHaveBeenCalledTimes(1);
    expect(reconciler.snapshot()).toMatchObject({ runCount: 1, successCount: 1, coalescedRequestCount: 1 });
    store.close();
  });

  it("records a failed physical reconciliation without swallowing the error", async () => {
    const store = new SqliteBindingStore(":memory:");
    vi.spyOn(store, "listBindingsByState").mockImplementation(() => { throw new Error("scan failed"); });
    const reconciler = fixture(store, { async listPanes() { return []; } } as unknown as HerdrPort);

    expect(reconciler.snapshot()).toMatchObject({ state: "idle", runCount: 0, successCount: 0, failureCount: 0, lastOutcome: null });
    await expect(reconciler.reconcile()).rejects.toThrow("scan failed");
    expect(reconciler.snapshot()).toMatchObject({ state: "idle", runCount: 1, successCount: 0, failureCount: 1, lastStartedAt: expect.any(String), lastCompletedAt: expect.any(String), lastDurationMs: expect.any(Number), maxDurationMs: expect.any(Number), lastOutcome: "failed" });
    store.close();
  });

  it("checkpoints changed terminal output without projecting Answer text when Pane metadata is unchanged", async () => {
    const store = new SqliteBindingStore(":memory:");
    let binding = store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    binding = store.updateBinding(binding.id, { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    const readOutput = vi.fn().mockResolvedValueOnce("◆ first local answer\n────────").mockResolvedValueOnce("◆ second local answer\n────────");
    const pane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, agentKind: "traex", outputRevision: 7, stateChangeSeq: 1, foregroundExecutables: ["traex"] };
    const bus = new BridgeEventBus();
    const answers: string[] = [];
    bus.onBridgeEvent("test", (event) => { if (event.type === "PaneOutputObserved" && event.payload.observation?.answer.snapshot) answers.push(event.payload.observation.answer.snapshot); });
    const reconciler = fixture(store, { async listPanes() { return [pane]; }, readOutput } as unknown as HerdrPort, undefined, pino({ enabled: false }), bus);

    await reconciler.reconcile();
    const firstFingerprint = store.getBinding("b1")!.lastOutputFingerprint;
    await reconciler.reconcile();

    expect(readOutput).toHaveBeenCalledTimes(2);
    expect(firstFingerprint).toEqual(expect.any(String));
    expect(store.getBinding("b1")!.lastOutputFingerprint).not.toBe(firstFingerprint);
    expect(answers).toEqual([]);
    store.close();
  });

  it("persists a terminal fingerprint without adding terminal text to the Main Card intent", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    const pane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, agentKind: "traex", outputRevision: 7, stateChangeSeq: 1, foregroundExecutables: ["traex"] };
    const wakeOutbound = vi.fn();
    const reconciler = fixture(store, { async listPanes() { return [pane]; }, async readOutput() { return "◆ durable local answer\n────────"; } } as unknown as HerdrPort, undefined, pino({ enabled: false }), new BridgeEventBus(), wakeOutbound);

    await reconciler.reconcile();

    expect(store.getBinding("b1")).toMatchObject({ lastOutputFingerprint: expect.any(String) });
    expect(store.loadTopicView("b1")).toMatchObject({ phase: "ready", answer: null });
    const outbound = store.listPendingOutboundReplies();
    expect(outbound).toEqual(expect.arrayContaining([expect.objectContaining({ bindingId: "b1", targetRole: "session_status" })]));
    expect(outbound.map((reply) => reply.payload).join("\n")).not.toContain("durable local answer");
    expect(wakeOutbound).toHaveBeenCalledOnce();
    store.close();
  });

  it("keeps reading unknown panes when their snapshot revision is unchanged", async () => {
    const store = new SqliteBindingStore(":memory:");
    let binding = store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    binding = store.updateBinding(binding.id, { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    const readOutput = vi.fn().mockResolvedValueOnce("◆ first answer\n────────").mockResolvedValueOnce("◆ second answer\n────────");
    const pane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "unknown" as const, agentKind: "traex", outputRevision: 7, stateChangeSeq: 1, foregroundExecutables: ["traex"] };
    const reconciler = fixture(store, { async listPanes() { return [pane]; }, readOutput } as unknown as HerdrPort);

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(readOutput).toHaveBeenCalledTimes(2);
    store.close();
  });

  it("keeps reading terminal output when pane metadata revision changes", async () => {
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

    expect(readOutput).toHaveBeenCalledTimes(3);
    store.close();
  });

  it("discards terminal output when the binding generation changes during the read", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    let release!: (output: string) => void;
    const readOutput = vi.fn(() => new Promise<string>((resolve) => { release = resolve; }));
    const pane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, outputRevision: 7, stateChangeSeq: 1, foregroundExecutables: ["traex"] };
    const events: string[] = [];
    const bus = new BridgeEventBus();
    bus.onBridgeEvent("test", (event) => { events.push(event.type); });
    const reconciler = new HerdrRuntimeReconciler({
      projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }], store,
      herdr: { async listPanes() { return [pane]; }, readOutput } as unknown as HerdrPort, lifecycleEvents: bus,
      channelPublisher: { async enqueueRunCardUpdate() {} }, logger: pino({ enabled: false }),
      discoverPane: async () => { throw new Error("not used"); }, scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false
    });

    const reconciliation = reconciler.reconcile();
    await vi.waitFor(() => expect(readOutput).toHaveBeenCalledOnce());
    store.updateBinding("b1", { generation: 2 });
    release("◆ stale answer\n────────");
    await reconciliation;

    expect(store.getBinding("b1")).toMatchObject({ generation: 2, lastOutputFingerprint: null });
    expect(events).not.toContain("TurnCompleted");
    store.close();
  });

  it("does not publish duplicate telemetry for an unchanged terminal snapshot", async () => {
    const store = new SqliteBindingStore(":memory:");
    let binding = store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    binding = store.updateBinding(binding.id, { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    const events: string[] = [];
    const bus = new BridgeEventBus();
    const stop = bus.onBridgeEvent("test", (event) => { if (event.type === "PaneOutputObserved") events.push(event.type); });
    const pane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "unknown" as const, agentKind: "traex", outputRevision: 7, stateChangeSeq: 1, foregroundExecutables: ["traex"] };
    const reconciler = new HerdrRuntimeReconciler({
      projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }], store,
      herdr: { async listPanes() { return [pane]; }, async readOutput() { return "GPT-5.6-Sol · Auto Mode · 31.1K tokens"; } } as unknown as HerdrPort,
      lifecycleEvents: bus, channelPublisher: { async enqueueRunCardUpdate() {} }, logger: pino({ enabled: false }),
      discoverPane: async () => { throw new Error("not used"); }, scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false
    });

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(events).toEqual(["PaneOutputObserved"]);
    stop();
    store.close();
  });

  it("projects passively observed model and context telemetry for an idle binding", async () => {
    const store = new SqliteBindingStore(":memory:");
    let binding = store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    binding = store.updateBinding(binding.id, { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    const bus = new BridgeEventBus();
    const observed: Array<{ type: string; payload: unknown }> = [];
    bus.onBridgeEvent("telemetry-test", (event) => { observed.push(event); });
    const pane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, agentKind: "traex", outputRevision: 7, stateChangeSeq: 1, foregroundExecutables: ["traex"] };
    const reconciler = new HerdrRuntimeReconciler({
      projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }],
      store, herdr: { async listPanes() { return [pane]; }, async readOutput() { return "GPT-5.6-Terra · Auto Mode · 31.1K tokens"; } } as unknown as HerdrPort,
      lifecycleEvents: bus, channelPublisher: { async drain() {}, async enqueueRunCardUpdate() {} }, logger: pino({ enabled: false }),
      discoverPane: async () => { throw new Error("not used"); }, scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false
    });

    await reconciler.reconcile();

    expect(observed.find((event) => event.type === "PaneOutputObserved")?.payload).toMatchObject({ observation: { main: { model: "GPT-5.6-Terra", context: "31.1K tokens" } } });
    store.close();
  });

  it("projects a changed authoritative Herdr tab ID for the main card", async () => {
    const store = new SqliteBindingStore(":memory:");
    let binding = store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    binding = store.updateBinding(binding.id, { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    const bus = new BridgeEventBus();
    const observed: Array<{ type: string; payload: unknown }> = [];
    bus.onBridgeEvent("tab-test", (event) => { observed.push(event); });
    const pane = { paneId: "w1:p1", tabId: "w1:t1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const reconciler = fixture(store, { async listPanes() { return [pane]; }, async readOutput() { return ""; } } as unknown as HerdrPort, undefined, pino({ enabled: false }), bus);

    await reconciler.reconcile();

    expect(observed.find((event) => event.type === "PaneOutputObserved")?.payload).toMatchObject({ tabId: "w1:t1" });
    store.close();
  });

  it("projects the resolved Git worktree directory name for the main card", async () => {
    const store = new SqliteBindingStore(":memory:");
    let binding = store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    binding = store.updateBinding(binding.id, { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    const bus = new BridgeEventBus();
    const observed: Array<{ type: string; payload: unknown }> = [];
    bus.onBridgeEvent("worktree-test", (event) => { observed.push(event); });
    const pane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo/.worktree/feat-main-card/src", label: "task", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const reconciler = new HerdrRuntimeReconciler({
      projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }], store,
      herdr: { async listPanes() { return [pane]; }, async readOutput() { return ""; } } as unknown as HerdrPort, lifecycleEvents: bus,
      channelPublisher: { async enqueueRunCardUpdate() {} }, logger: pino({ enabled: false }), discoverPane: async () => { throw new Error("not used"); },
      scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false, worktreeNameFor: async (cwd) => cwd ? "feat-main-card" : null
    });

    await reconciler.reconcile();

    expect(observed.find((event) => event.type === "PaneOutputObserved")?.payload).toMatchObject({ worktreeName: "feat-main-card" });
    store.close();
  });

  it("does not regress Agent state from an older native state sequence", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", lastAgentState: "idle" });
    let pane = {
      paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "working" as const,
      agentKind: "codex", outputRevision: 7, stateChangeSeq: 10, foregroundExecutables: ["traex"]
    };
    const reconciler = fixture(store, { async listPanes() { return [pane]; }, async readOutput() { return "working"; } } as unknown as HerdrPort);

    await reconciler.reconcile();
    pane = { ...pane, agentState: "idle" as const, outputRevision: 8, stateChangeSeq: 9 };
    await reconciler.reconcile();

    expect(store.getBinding("b1")?.lastAgentState).toBe("working");
    store.close();
  });

  it("forgets observations for panes absent from a complete snapshot", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "old", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "old-topic", rootMessageId: "old-root", title: "old task" });
    store.updateBinding("old", { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", lastAgentState: "idle" });
    let panes = [{
      paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "old task", agentState: "idle" as const,
      agentKind: "codex", outputRevision: 10, stateChangeSeq: 10, foregroundExecutables: ["traex"]
    }];
    const reconciler = fixture(store, { async listPanes() { return panes; }, async readOutput() { return ""; } } as unknown as HerdrPort);

    await reconciler.reconcile();
    panes = [];
    await reconciler.reconcile();
    store.database.prepare("UPDATE bindings SET pane_id = NULL WHERE id = 'old'").run();
    store.createPendingBinding({ id: "new", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "new-topic", rootMessageId: "new-root", title: "new task" });
    store.updateBinding("new", { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", lastAgentState: "idle" });
    panes = [{
      paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "new task", agentState: "working" as const,
      agentKind: "codex", outputRevision: 1, stateChangeSeq: 1, foregroundExecutables: ["traex"]
    }];

    await reconciler.reconcile();

    expect(store.getBinding("new")?.lastAgentState).toBe("working");
    store.close();
  });

  it("resets the Agent state sequence fence when the terminal identity changes", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", {
      paneId: "w1:p1", traexSessionId: "old-terminal", agentSessionSource: "codex-hook", agentSessionAgent: "codex", agentSessionKind: "id", agentSessionValue: "conversation-1",
      state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", lastAgentState: "idle"
    });
    let pane = {
      paneId: "w1:p1", terminalId: "old-terminal", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "working" as const,
      agentKind: "codex", agentSession: { source: "codex-hook", agent: "codex", kind: "id" as const, value: "conversation-1" }, outputRevision: 7, stateChangeSeq: 10, foregroundExecutables: ["traex"]
    };
    const reconciler = fixture(store, { async listPanes() { return [pane]; }, async readOutput() { return ""; } } as unknown as HerdrPort);

    await reconciler.reconcile();
    pane = { ...pane, terminalId: "new-terminal", agentState: "idle" as const, stateChangeSeq: 1, outputRevision: 1 };
    await reconciler.reconcile();

    expect(store.getBinding("b1")).toMatchObject({ traexSessionId: "new-terminal", lastAgentState: "idle", attachment: "attached" });
    store.close();
  });

  it("isolates a transient terminal read failure and continues with the next pane", async () => {
    const store = new SqliteBindingStore(":memory:");
    for (const index of [1, 2]) {
      store.createPendingBinding({ id: `b${index}`, projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: `topic-${index}`, rootMessageId: `root-${index}`, title: `task-${index}` });
      store.updateBinding(`b${index}`, { paneId: `w1:p${index}`, traexSessionId: `term-${index}`, state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    }
    const panes = [1, 2].map((index) => ({ paneId: `w1:p${index}`, terminalId: `term-${index}`, workspaceId: "w1", cwd: "/repo", label: `task-${index}`, agentState: "idle" as const, agentKind: "traex", outputRevision: 8, stateChangeSeq: 1, foregroundExecutables: ["traex"] }));
    let failFirst = true;
    const readOutput = vi.fn(async (paneId: string) => { if (paneId === "w1:p1" && failFirst) { failFirst = false; throw new Error("temporary read failure"); } return `◆ recovered ${paneId}\n────────`; });
    const reconciler = fixture(store, { async listPanes() { return panes; }, readOutput } as unknown as HerdrPort);

    await expect(reconciler.reconcile()).resolves.toBeUndefined();
    expect(store.getBinding("b2")?.lastOutputFingerprint).not.toBeNull();
    await expect(reconciler.reconcile()).resolves.toBeUndefined();

    expect(readOutput.mock.calls.filter(([paneId]) => paneId === "w1:p1")).toHaveLength(2);
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

  it("degrades a live unregistered TraeX pane and restores it after native Agent registration", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "task", workspaceId: "w1", paneId: "w1:p1", phase: "ready" });
    let registered = false;
    const pane = () => ({
      paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "task",
      agentState: registered ? "idle" as const : "unknown" as const, agentKind: registered ? "codex" : null, foregroundExecutables: ["traex"]
    });
    const wakeOutbound = vi.fn();
    const reconciler = fixture(store, { async listPanes() { return [pane()]; }, async observeRuntime() { return { pane: pane(), traexProcess: true, composerReady: registered, evidenceSource: registered ? "structured" : "process" }; }, async readOutput() { return ""; } } as unknown as HerdrPort, undefined, undefined, undefined, wakeOutbound);

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(store.getBinding("b1")).toMatchObject({ state: "active", attachment: "degraded", degradationCount: 0 });
    expect(store.loadTopicView("b1")).toMatchObject({ phase: "degraded", notice: expect.stringContaining("/swarm reset") });
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    expect(wakeOutbound).toHaveBeenCalledOnce();

    registered = true;
    await reconciler.reconcile();

    expect(store.getBinding("b1")).toMatchObject({ attachment: "attached", lastAgentState: "idle" });
    store.close();
  });

  it("atomically projects orphan state after repeated workspace discovery failures", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "task", workspaceId: "w1", paneId: "w1:p1", requestText: "run", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "run" }, view, rootMessageId: "root", answerCard: {} });
    const herdr = { async listAllPanes() { throw new Error("snapshot unavailable"); }, async listPanes() { throw new Error("workspace unavailable"); } } as unknown as HerdrPort;
    const reconciler = fixture(store, herdr);

    await reconciler.reconcile();
    await reconciler.reconcile();

    expect(store.getBinding("b1")).toMatchObject({ attachment: "orphaned" });
    expect(store.getPrompt("p1")).toMatchObject({ state: "cancelled" });
    expect(store.loadRunCard("p1")).toMatchObject({ phase: "failed" });
    expect(store.loadTopicView("b1")).toMatchObject({ phase: "orphaned" });
    store.close();
  });

  it("persists a missing-pane orphan projection without a process-local view projector", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    const runningView = createQueuedRunCard({ promptId: "running", bindingId: "b1", title: "task", workspaceId: "w1", paneId: "w1:p1", requestText: "run", queuePosition: 1, occurredAt: "2026-08-27T00:00:00.000Z" });
    const queuedView = createQueuedRunCard({ promptId: "queued", bindingId: "b1", title: "task", workspaceId: "w1", paneId: "w1:p1", requestText: "queue", queuePosition: 2, occurredAt: "2026-08-27T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "running", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "run" }, view: runningView, rootMessageId: "root", answerCard: {} });
    store.acceptPrompt({ prompt: { id: "queued", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "queue" }, view: queuedView, rootMessageId: "root", answerCard: {} });
    store.saveRunCard({ ...runningView, phase: "running", answerMessageId: "answer-running", viewVersion: 2 });
    store.saveRunCard({ ...queuedView, phase: "queued", viewVersion: 1 });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'attached' WHERE id = 'running'").run();
    const reconciler = fixture(store, { async listAllPanes() { return []; }, async readOutput() { return ""; } } as unknown as HerdrPort, undefined, pino({ enabled: false }), new BridgeEventBus());

    await reconciler.reconcile();

    expect(store.getBinding("b1")).toMatchObject({ state: "orphaned", attachment: "orphaned" });
    expect(store.loadRunCard("running")).toMatchObject({ phase: "failed" });
    expect(store.loadRunCard("queued")).toMatchObject({ phase: "failed" });
    expect(store.getPrompt("running")).toMatchObject({ state: "failed", observationState: "completed" });
    expect(store.getPrompt("queued")).toMatchObject({ state: "cancelled", observationState: "completed" });
    expect(store.loadTopicView("b1")).toMatchObject({ phase: "orphaned" });
    const replyCount = store.listPendingOutboundReplies().length;
    await reconciler.reconcile();
    expect(store.listPendingOutboundReplies()).toHaveLength(replyCount);
    store.close();
  });

  it("converges delivered Answer cards after orphaning their prompts", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    const runningView = createQueuedRunCard({ promptId: "running", bindingId: "b1", title: "task", workspaceId: "w1", paneId: "w1:p1", requestText: "run", queuePosition: 1, occurredAt: "2026-08-27T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "running", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "run" }, view: runningView, rootMessageId: "root", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-running", "card-running");
    store.markPromptDispatched("running");
    const convergeAnswer = vi.fn(async () => {});
    const reconciler = fixture(
      store,
      { async listAllPanes() { return []; }, async readOutput() { return ""; } } as unknown as HerdrPort,
      undefined,
      pino({ enabled: false }),
      new BridgeEventBus(),
      undefined,
      convergeAnswer
    );

    await reconciler.reconcile();

    expect(store.loadRunCard("running")).toMatchObject({ phase: "failed", answerCardId: "card-running" });
    expect(convergeAnswer).toHaveBeenCalledOnce();
    expect(convergeAnswer).toHaveBeenCalledWith("running");
    store.close();
  });

  it("continues orphan Answer convergence after one prompt fails", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated" });
    for (const promptId of ["first", "second"]) {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: "task", workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 1, occurredAt: "2026-08-27T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "u1", body: promptId }, view, rootMessageId: "root", answerCard: {} });
      store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, `answer-${promptId}`, `card-${promptId}`);
    }
    store.markPromptDispatched("first");
    const convergeAnswer = vi.fn(async (promptId: string) => { if (promptId === "first") throw new Error("temporary convergence failure"); });
    const reconciler = fixture(
      store,
      { async listAllPanes() { return []; }, async readOutput() { return ""; } } as unknown as HerdrPort,
      undefined,
      pino({ enabled: false }),
      new BridgeEventBus(),
      undefined,
      convergeAnswer
    );

    await expect(reconciler.reconcile()).resolves.toBeUndefined();

    expect(convergeAnswer.mock.calls.map(([promptId]) => promptId)).toEqual(["first", "second"]);
    expect(store.loadRunCard("first")).toMatchObject({ phase: "failed" });
    expect(store.loadRunCard("second")).toMatchObject({ phase: "failed" });
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

  it("loads workspace fallbacks concurrently while retaining each successful snapshot", async () => {
    const store = new SqliteBindingStore(":memory:");
    const release = new Map<string, () => void>();
    const listPanes = vi.fn((workspaceId: string) => new Promise<HerdrPane[]>((resolve) => {
      release.set(workspaceId, () => resolve([]));
    }));
    const reconciler = new HerdrRuntimeReconciler({
      projects: [
        { id: "repo-one", displayName: "Repo one", description: "Repo one", workspaceId: "w1", cwd: "/repo-one" },
        { id: "repo-two", displayName: "Repo two", description: "Repo two", workspaceId: "w2", cwd: "/repo-two" }
      ],
      store, herdr: { async listAllPanes() { throw new Error("snapshot unavailable"); }, listPanes } as unknown as HerdrPort,
      lifecycleEvents: new BridgeEventBus(), channelPublisher: { async drain() {}, async enqueueRunCardUpdate() {} }, logger: pino({ enabled: false }),
      discoverPane: async () => { throw new Error("not used"); }, scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false
    });

    const reconciliation = reconciler.reconcile();
    await Promise.resolve();
    expect(listPanes.mock.calls.map(([workspaceId]) => workspaceId).sort()).toEqual(["w1", "w2"]);
    release.get("w1")!();
    release.get("w2")!();
    await reconciliation;
    store.close();
  });

  it("enriches an unknown bound pane and wakes its queued FIFO", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "task" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "term-1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", lastAgentState: "unknown" });
    store.enqueuePrompt({ id: "queued", bindingId: "b1", larkMessageId: "message-1", actorOpenId: "user", body: "queued work" });
    const countPendingPrompts = vi.spyOn(store, "countPendingPrompts");
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
    expect(countPendingPrompts).toHaveBeenCalledTimes(1);
    expect(countPendingPrompts).toHaveBeenCalledWith("b1");
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
  logger = pino({ enabled: false }),
  lifecycleEvents = new BridgeEventBus(),
  wakeOutbound?: () => void,
  convergeAnswer?: (promptId: string) => Promise<void>
) {
  return new HerdrRuntimeReconciler({
    projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }],
    store, herdr, lifecycleEvents,
    channelPublisher: { async drain() {}, async enqueueRunCardUpdate() {} },
    logger, discoverPane, scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false, wakeOutbound, convergeAnswer
  });
}
