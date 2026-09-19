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
    const herdr = {
      async listPanes() { return [pane]; }, async listAllPanes() { return [pane]; }, async getPane() { return pane; },
      async observeRuntime() { return { pane, traexProcess: true, composerReady: false, evidenceSource: "structured" as const }; }
    } as unknown as HerdrPort;
    const bindingRuntime = new HerdrRuntimeReconciler({
      projects: [project], store, herdr, lifecycleEvents: new BridgeEventBus(), channelPublisher: { async enqueueRunCardUpdate() {} },
      logger: pino({ enabled: false }), discoverPane: async () => { throw new Error("not used"); }, scheduler: new InProcessPromptWorkScheduler(),
      isBindingBusy: () => false, presentation: applicationPresentation
    });
    const instanceRuntime = new InstanceRuntimeReconciler({ projects: [project], store, paneHost: new HerdrPaneHost(herdr), wake: vi.fn() });
    const router = new HerdrEventRouter({
      invalidateAll: vi.fn(), invalidateWorkspace: vi.fn(), invalidatePanes: vi.fn(),
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
    expect(store.listPendingOutboundReplies()).toEqual(expect.arrayContaining([expect.objectContaining({ bindingId: "b1", targetRole: "session_status", kind: "card_update" })]));
    expect(bindingRuntime.snapshot()).toMatchObject({ lastAcceptedToStartMs: { panes: expect.any(Number) } });
    expect(instanceRuntime.snapshot()).toMatchObject({ lastAcceptedToStartMs: { panes: expect.any(Number) } });
    store.close();
  });

  it("recovers durable Primary state with the periodic full pass when a Pane hint is dropped", async () => {
    const store = new SqliteBindingStore(":memory:");
    const project = { id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" } satisfies ProjectConfig;
    const pane: HerdrPane = { paneId: "w1:p1", terminalId: "term-1", workspaceId: "w1", cwd: "/repo", label: "periodic", agentState: "working", agentKind: "traex", foregroundExecutables: ["traex"] };
    store.createPendingBinding({ id: "b1", projectId: project.id, workspaceId: project.workspaceId, chatId: "chat", topicId: "topic", rootMessageId: "root", title: "legacy" });
    store.updateBinding("b1", { paneId: pane.paneId, statusMessageId: "root", traexSessionId: pane.terminalId, state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", lastAgentState: "idle" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "legacy", workspaceId: project.workspaceId, spaceName: project.displayName, paneId: pane.paneId, phase: "ready" });
    const bindingRuntime = new HerdrRuntimeReconciler({
      projects: [project], store, herdr: { async listAllPanes() { return [pane]; }, async listPanes() { return [pane]; } } as unknown as HerdrPort,
      lifecycleEvents: new BridgeEventBus(), channelPublisher: { async enqueueRunCardUpdate() {} }, logger: pino({ enabled: false }),
      discoverPane: async () => { throw new Error("not used"); }, scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false, presentation: applicationPresentation
    });

    bindingRuntime.start(10);
    await vi.waitFor(() => expect(store.getBinding("b1")).toMatchObject({ title: "herdr / periodic", lastAgentState: "working" }), { timeout: 1_000 });
    expect(store.listPendingOutboundReplies()).toEqual(expect.arrayContaining([expect.objectContaining({ bindingId: "b1", targetRole: "session_status", kind: "card_update" })]));
    await bindingRuntime.stop();
    store.close();
  });
});
