import { matchesHerdrAgentKind, type AgentInstance, type ObservedInstanceState } from "../domain/agent-instance.js";
import type { InstanceStore } from "../domain/ports.js";
import type { HerdrPane, ProjectConfig } from "../domain/types.js";
import type { PaneHost } from "../runtime/herdr/pane-host.js";

interface Options { projects: readonly ProjectConfig[]; store: InstanceStore; paneHost: PaneHost; wake(instanceId: string): void }

export class InstanceRuntimeReconciler {
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private completed = false;
  private lastError: string | null = null;

  constructor(private readonly options: Options) {}

  reconcile(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) return this.running;
    const run = this.reconcileOnce();
    this.running = run;
    return run.finally(() => { if (this.running === run) this.running = null; });
  }

  requestReconciliation(): void { void this.reconcile().catch(() => undefined); }
  start(intervalMs: number): void {
    if (this.stopping || this.timer) return;
    this.timer = setInterval(() => this.requestReconciliation(), intervalMs);
    this.timer.unref();
  }
  async stop(): Promise<void> { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null; await this.running; }
  snapshot(): { ready: boolean; lastError: string | null } { return { ready: this.completed && !this.lastError, lastError: this.lastError }; }

  private async reconcileOnce(): Promise<void> {
    try {
      for (const project of this.options.projects) {
        const panes = await this.options.paneHost.listPanes(project.workspaceId);
        const panesById = new Map(panes.map((pane) => [pane.paneId, pane]));
        for (const instance of this.options.store.listAgentInstances(project.id)) await this.reconcileInstance(instance, project, panesById);
      }
      this.completed = true; this.lastError = null;
    } catch (error) { this.lastError = error instanceof Error ? error.message : String(error); throw error; }
  }

  private async reconcileInstance(instance: AgentInstance, project: ProjectConfig, panes: ReadonlyMap<string, HerdrPane>): Promise<void> {
    const runtime = instance.runtimeRef;
    if (!runtime) return;
    const pane = panes.get(runtime.paneId);
    if (!pane) { this.options.store.detachAgentInstanceRuntime({ instanceId: instance.id, expectedGeneration: instance.generation, reason: `Herdr pane ${runtime.paneId} is missing` }); return; }
    const workspace = this.options.store.getWorkspaceLease(instance.workspaceLeaseId);
    if (pane.workspaceId !== runtime.herdrWorkspaceId || pane.workspaceId !== project.workspaceId || pane.cwd !== workspace?.cwd || !pane.agentKind || !matchesHerdrAgentKind(instance.agentKind, pane.agentKind)) {
      this.options.store.detachAgentInstanceRuntime({ instanceId: instance.id, expectedGeneration: instance.generation, reason: `Herdr pane ${runtime.paneId} identity mismatch` });
      return;
    }
    const observedState = normalizeState(pane);
    const updated = this.options.store.updateAgentInstanceObservation({ instanceId: instance.id, expectedGeneration: instance.generation, observedState, lastError: observedState === "detached" ? "Herdr runtime state is uncertain" : null });
    if (updated && observedState === "idle" && this.options.store.countPendingInstanceTurns(instance.id) > 0) this.options.wake(instance.id);
  }
}

function normalizeState(pane: HerdrPane): ObservedInstanceState {
  if (pane.agentState === "idle" || pane.agentState === "done") return "idle";
  if (pane.agentState === "working") return "working";
  if (pane.agentState === "blocked") return "blocked";
  return "detached";
}
