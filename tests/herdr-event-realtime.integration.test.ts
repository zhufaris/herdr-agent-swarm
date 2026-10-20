import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { HerdrRuntimeReconciler } from "../src/coordinator/herdr-runtime-reconciler.js";
import { InstanceRuntimeReconciler } from "../src/coordinator/instance-runtime-reconciler.js";
import type { HerdrPort } from "../src/domain/ports.js";
import type { HerdrPane, ProjectConfig } from "../src/domain/types.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { InProcessPromptWorkScheduler } from "../src/events/prompt-work-scheduler.js";
import { HerdrEventRouter } from "../src/runtime/herdr-event-router.js";
import { HerdrPaneHost } from "../src/runtime/herdr/pane-host.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { applicationPresentation } from "./helpers/presentation.js";
import { WorkspaceSnapshotCache } from "../src/runtime/workspace-snapshot-cache.js";

describe("Herdr event real-time convergence", () => {
  it("converges Primary and Worker durable state and reserves card intent within one second", async () => {
    const store = new SqliteBindingStore(":memory:");
    const project = { id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" } satisfies ProjectConfig;
    const pane: HerdrPane = {
      paneId: "w1:p1", terminalId: "term-1", tabId: "w1:t1", workspaceId: "w1", cwd: "/repo", label: "fresh",
      agentState: "working", agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      stateChangeSeq: 2, foregroundExecutables: ["traex"]
    };
    store.createPendingBinding({ id: "b1", projectId: project.id, workspaceId: project.workspaceId, chatId: "chat", topicId: "topic", rootMessageId: "root", title: "legacy" });
    store.updateBinding("b1", { paneId: pane.paneId, statusMessageId: "root", traexSessionId: pane.terminalId, state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", lastAgentState: "idle" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "legacy", workspaceId: project.workspaceId, spaceName: project.displayName, paneId: pane.paneId, phase: "ready" });
    store.createAgentInstance({ id: "i1", projectId: project.id, name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: project.cwd, branch: null, baseCommit: "base" } });
    store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: project.workspaceId, paneId: pane.paneId, nativeSessionId: "session-1" });
    const listAllPanes = vi.fn(async () => [pane]);
    const herdr = new WorkspaceSnapshotCache({
      async listPanes() { return [pane]; }, listAllPanes, async getPane() { return pane; },
      async observeRuntime() { return { pane, traexProcess: true, composerReady: false, evidenceSource: "structured" as const }; }
    } as unknown as HerdrPort);
    const bindingRuntime = new HerdrRuntimeReconciler({
      projects: [project], store, herdr, runtimeObservations: herdr, lifecycleEvents: new BridgeEventBus(), channelPublisher: { async enqueueRunCardUpdate() {} },
      logger: pino({ enabled: false }), discoverPane: async () => { throw new Error("not used"); }, scheduler: new InProcessPromptWorkScheduler(),
      isBindingBusy: () => false, presentation: applicationPresentation
    });
    const instanceRuntime = new InstanceRuntimeReconciler({ projects: [project], store, paneHost: new HerdrPaneHost(herdr), runtimeObservations: herdr, wake: vi.fn() });
    const router = new HerdrEventRouter({
      invalidateAll: () => herdr.invalidateAll(), invalidateWorkspace: (workspaceId) => herdr.invalidate(workspaceId), invalidatePanes: (paneIds) => herdr.invalidatePanes(paneIds),
      reconcileBindings: (scope) => scope?.paneIds ? bindingRuntime.requestPaneReconciliation(scope.paneIds) : bindingRuntime.requestReconciliation(scope?.workspaceIds),
      reconcileInstances: (scope) => instanceRuntime.requestReconciliation(scope), observePrimaryTurns: async () => undefined, observeInstanceTurns: async () => undefined,
      retryRetiredPanes: async () => undefined, logger: pino({ enabled: false })
    });

    const startedAt = performance.now();
    await router.handle({ kind: "agent-status", scope: "panes", workspaceIds: [project.workspaceId], paneIds: [pane.paneId] });
    const elapsedMs = performance.now() - startedAt;

    expect(elapsedMs).toBeLessThan(1_000);
    expect(store.getBinding("b1")).toMatchObject({ title: "herdr / fresh", lastAgentState: "working" });
    expect(store.getAgentInstance("i1")).toMatchObject({ observedState: "working" });
    expect(listAllPanes).toHaveBeenCalledOnce();
    expect(store.listPendingOutboundReplies()).toEqual(expect.arrayContaining([expect.objectContaining({ bindingId: "b1", targetRole: "session_status", kind: "card_update" })]));
    expect(bindingRuntime.snapshot()).toMatchObject({ lastAcceptedToStartMs: { panes: expect.any(Number) } });
    expect(instanceRuntime.snapshot()).toMatchObject({ lastAcceptedToStartMs: { panes: expect.any(Number) } });
    store.close();
  });

  it("lets Worker consume a shared generation while failed Binding reconciliation retries independently", async () => {
    const store = new SqliteBindingStore(":memory:");
    const project = { id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" } satisfies ProjectConfig;
    let pane: HerdrPane = {
      paneId: "w1:p1", terminalId: "term-1", tabId: "w1:t1", workspaceId: "w1", cwd: "/repo", label: "shared",
      agentState: "idle", agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      stateChangeSeq: 1, foregroundExecutables: ["traex"]
    };
    store.createPendingBinding({ id: "b1", projectId: project.id, workspaceId: project.workspaceId, chatId: "chat", topicId: "topic", rootMessageId: "root", title: "shared" });
    store.updateBinding("b1", { paneId: pane.paneId, statusMessageId: "root", traexSessionId: pane.terminalId, state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", lastAgentState: "idle" });
    store.createAgentInstance({ id: "i1", projectId: project.id, name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: project.cwd, branch: null, baseCommit: "base" } });
    store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: project.workspaceId, paneId: pane.paneId, nativeSessionId: "session-1" });
    const listAllPanes = vi.fn(async () => [pane]);
    const listPanes = vi.fn(async (workspaceId: string) => pane.workspaceId === workspaceId ? [pane] : []);
    const herdr = new WorkspaceSnapshotCache({ listAllPanes, listPanes } as unknown as HerdrPort);
    const externalTurnObserver = { observe: vi.fn(async () => undefined) };
    const bindingRuntime = new HerdrRuntimeReconciler({
      projects: [project], store, herdr, runtimeObservations: herdr, lifecycleEvents: new BridgeEventBus(), channelPublisher: { async enqueueRunCardUpdate() {} },
      logger: pino({ enabled: false }), discoverPane: async () => { throw new Error("not used"); }, scheduler: new InProcessPromptWorkScheduler(),
      isBindingBusy: () => false, externalTurnObserver, presentation: applicationPresentation
    });
    const instanceRuntime = new InstanceRuntimeReconciler({ projects: [project], store, paneHost: new HerdrPaneHost(herdr), runtimeObservations: herdr, wake: vi.fn() });

    await bindingRuntime.reconcile();
    await instanceRuntime.reconcile();
    expect(externalTurnObserver.observe).toHaveBeenCalledOnce();

    pane = { ...pane, agentState: "working", stateChangeSeq: 2 };
    herdr.invalidatePanes([pane.paneId]);
    externalTurnObserver.observe.mockRejectedValueOnce(new Error("observer unavailable"));

    await expect(bindingRuntime.reconcile()).rejects.toThrow("Binding semantic delta failed");
    await instanceRuntime.reconcile();

    expect(store.getAgentInstance("i1")).toMatchObject({ observedState: "working" });
    expect(listAllPanes).toHaveBeenCalledOnce();
    expect(listPanes).toHaveBeenCalledOnce();

    await bindingRuntime.reconcile();

    expect(externalTurnObserver.observe).toHaveBeenCalledTimes(3);
    expect(listAllPanes).toHaveBeenCalledOnce();
    expect(listPanes).toHaveBeenCalledOnce();
    await bindingRuntime.reconcile();
    await instanceRuntime.reconcile();
    expect(externalTurnObserver.observe).toHaveBeenCalledTimes(3);
    expect(listAllPanes).toHaveBeenCalledOnce();
    expect(listPanes).toHaveBeenCalledOnce();
    store.close();
  });

  it("recovers Primary and Worker state with the semantic watchdog when a Pane hint is dropped", async () => {
    const store = new SqliteBindingStore(":memory:");
    const project = { id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" } satisfies ProjectConfig;
    let now = 0;
    let pane: HerdrPane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "legacy", agentState: "idle", agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, foregroundExecutables: ["traex"] };
    store.createPendingBinding({ id: "b1", projectId: project.id, workspaceId: project.workspaceId, chatId: "chat", topicId: "topic", rootMessageId: "root", title: "legacy" });
    store.updateBinding("b1", { paneId: pane.paneId, statusMessageId: "root", traexSessionId: pane.terminalId, state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", lastAgentState: "idle" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "legacy", workspaceId: project.workspaceId, spaceName: project.displayName, paneId: pane.paneId, phase: "ready" });
    store.createAgentInstance({ id: "i1", projectId: project.id, name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: project.cwd, branch: null, baseCommit: "base" } });
    store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: project.workspaceId, paneId: pane.paneId, nativeSessionId: "session-1" });
    const listAllPanes = vi.fn(async () => [pane]);
    const herdr = new WorkspaceSnapshotCache({ listAllPanes } as unknown as HerdrPort, 2_000, undefined, () => now);
    const bindingRuntime = new HerdrRuntimeReconciler({
      projects: [project], store, herdr, runtimeObservations: herdr,
      lifecycleEvents: new BridgeEventBus(), channelPublisher: { async enqueueRunCardUpdate() {} }, logger: pino({ enabled: false }),
      discoverPane: async () => { throw new Error("not used"); }, scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false, presentation: applicationPresentation
    });
    const instanceRuntime = new InstanceRuntimeReconciler({ projects: [project], store, paneHost: new HerdrPaneHost(herdr), runtimeObservations: herdr, wake: vi.fn() });

    await bindingRuntime.reconcile();
    await instanceRuntime.reconcile();
    pane = { ...pane, label: "periodic", agentState: "working", stateChangeSeq: 2 };
    now = 60_000;

    await bindingRuntime.reconcile();
    await instanceRuntime.reconcile();

    expect(store.getBinding("b1")).toMatchObject({ title: "herdr / periodic", lastAgentState: "working" });
    expect(store.getAgentInstance("i1")).toMatchObject({ observedState: "working" });
    expect(listAllPanes).toHaveBeenCalledTimes(2);
    expect(store.listPendingOutboundReplies()).toEqual(expect.arrayContaining([expect.objectContaining({ bindingId: "b1", targetRole: "session_status", kind: "card_update" })]));
    store.close();
  });
});
