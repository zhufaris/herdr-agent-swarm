import pino from "pino";
import { describe, expect, it, vi } from "vitest";
import { BindingReconciliationPass } from "../src/coordinator/binding-reconciliation-pass.js";
import type { HerdrPort } from "../src/domain/ports.js";
import { BridgeEventBus } from "../src/events/bridge-event-bus.js";
import { InProcessPromptWorkScheduler } from "../src/events/prompt-work-scheduler.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { applicationPresentation } from "./helpers/presentation.js";

describe("BindingReconciliationPass", () => {
  it("converges an owned Pane and claims a discovered Pane once per full snapshot", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "existing", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "existing" });
    store.updateBinding("existing", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", lastAgentState: "idle" });
    const existingPane = { paneId: "w1:p1", workspaceId: "w1", cwd: "/repo", label: "existing", agentState: "working" as const, foregroundExecutables: ["traex"] };
    const discoveredPane = { paneId: "w1:p2", workspaceId: "w1", cwd: "/repo", label: "new", agentState: "idle" as const, foregroundExecutables: ["traex"] };
    const discoverPane = vi.fn(async () => {
      const binding = store.createPendingBinding({ id: "discovered", projectId: "repo", workspaceId: "w1", chatId: "chat", topicId: null, rootMessageId: null, title: "new" });
      return store.updateBinding(binding.id, { paneId: discoveredPane.paneId });
    });
    const pass = new BindingReconciliationPass({
      projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w1", cwd: "/repo" }],
      store, herdr: { async listPanes() { return [existingPane, discoveredPane, discoveredPane]; } } as unknown as HerdrPort,
      lifecycleEvents: new BridgeEventBus(), logger: pino({ enabled: false }), discoverPane,
      scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false, presentation: applicationPresentation
    });

    const result = await pass.execute({ kind: "all" });

    expect(result).toMatchObject({ existingBindingCount: 1, discoveryCandidateCount: 2 });
    expect(store.getBinding("existing")?.lastAgentState).toBe("working");
    expect(discoverPane).toHaveBeenCalledTimes(1);
    store.close();
  });

  it("does not discover the moved Pane while its Orchestrator identity receipt is pending", async () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({
      id: "orchestrator", kind: "orchestrator", gatewayId: "feishu:primary", projectId: "repo",
      workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Orchestrator"
    });
    store.updateBinding("orchestrator", {
      paneId: "w1:p1", paneToken: "abcd", traexSessionId: "terminal-1",
      state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", lastAgentState: "idle"
    });
    store.capabilityModules().orchestratorIdentity.accept({
      id: "migration-1", bindingId: "orchestrator", bindingGeneration: 1,
      expected: { workspaceId: "w1", paneId: "w1:p1", terminalId: "terminal-1", token: "abcd" },
      target: { workspaceId: "w2", expectedWorkspaceLabel: "herdr", token: "orch" }
    });
    const movedPane = {
      paneId: "w2:p9", paneToken: "orch", terminalId: "terminal-1", workspaceId: "w2", cwd: "/repo",
      label: "orchestrator", agentState: "idle" as const, foregroundExecutables: ["traex"]
    };
    const discoverPane = vi.fn(async () => store.getBinding("orchestrator")!);
    const pass = new BindingReconciliationPass({
      projects: [{ id: "repo", displayName: "Repo", description: "Repo", workspaceId: "w2", cwd: "/repo" }],
      store,
      herdr: { async listPanes(workspaceId: string) { return workspaceId === "w2" ? [movedPane] : []; } } as unknown as HerdrPort,
      lifecycleEvents: new BridgeEventBus(), logger: pino({ enabled: false }), discoverPane,
      scheduler: new InProcessPromptWorkScheduler(), isBindingBusy: () => false, presentation: applicationPresentation
    });

    await pass.execute({ kind: "all" });

    expect(discoverPane).not.toHaveBeenCalled();
    expect(store.getBinding("orchestrator")).toMatchObject({ state: "active", workspaceId: "w1", paneId: "w1:p1" });
    store.close();
  });
});
