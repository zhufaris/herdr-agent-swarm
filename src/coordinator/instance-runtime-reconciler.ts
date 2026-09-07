import type { Logger } from "pino";
import { matchesHerdrAgentKind, type AgentInstance, type ObservedInstanceState } from "../domain/agent-instance.js";
import type { InstanceLifecycleStore, InstanceTurnStore } from "../domain/ports/instance.js";
import type { HerdrPane, ProjectConfig, ReconciliationDiagnostics } from "../domain/types.js";
import type { PaneHost } from "../runtime/herdr/pane-host.js";
import { safeLogError } from "../runtime/safe-error.js";
import { ReconciliationRunMetrics } from "../runtime/reconciliation-run-metrics.js";

interface Options { projects: readonly ProjectConfig[]; store: InstanceLifecycleStore & Pick<InstanceTurnStore, "countPendingInstanceTurns">; paneHost: PaneHost; wake(instanceId: string): void; wakeCardContext?: () => void; logger?: Pick<Logger, "warn"> }
interface ReconciliationScope { paneIds?: readonly string[]; workspaceIds?: readonly string[] }

export class InstanceRuntimeReconciler {
  private readonly projectsById: ReadonlyMap<string, ProjectConfig>;
  private running: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private completed = false;
  private lastError: string | null = null;
  private readonly metrics = new ReconciliationRunMetrics();

  constructor(private readonly options: Options) {
    this.projectsById = new Map(options.projects.map((project) => [project.id, project]));
  }

  reconcile(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) { this.metrics.markCoalesced(); return this.running; }
    const run = this.runMeasured();
    this.running = run;
    return run.finally(() => { if (this.running === run) this.running = null; });
  }

  async requestReconciliation(scope?: ReconciliationScope): Promise<void> {
    if (!scope) return this.reconcile();
    if (this.stopping) return;
    if (this.running) { this.metrics.markCoalesced(); await this.running; }
    if (this.stopping) return;
    const run = this.runMeasured(scope);
    this.running = run;
    try { await run; }
    finally { if (this.running === run) this.running = null; }
  }
  start(intervalMs: number): void {
    if (this.stopping || this.timer) return;
    this.timer = setInterval(() => {
      void this.requestReconciliation().catch((error) => {
        this.options.logger?.warn({ event: "instance-runtime-reconciliation-failed", err: safeLogError(error), outcome: "retry_later" }, "periodic instance runtime reconciliation failed");
      });
    }, intervalMs);
    this.timer.unref();
  }
  async stop(): Promise<void> { this.stopping = true; if (this.timer) clearInterval(this.timer); this.timer = null; await this.running; }
  snapshot(): ReconciliationDiagnostics & { ready: boolean; lastError: string | null } {
    return { ...this.metrics.snapshot(this.stopping ? "stopping" : this.running ? "running" : "idle"), ready: this.completed && !this.lastError, lastError: this.lastError };
  }

  private async runMeasured(scope?: ReconciliationScope): Promise<void> {
    await this.metrics.measure(() => this.reconcileOnce(scope));
  }

  private async reconcileOnce(scope?: ReconciliationScope): Promise<void> {
    try {
      if (scope?.paneIds) {
        const paneIds = [...new Set(scope.paneIds)];
        const panesById = this.options.paneHost.snapshotPanes
          ? new Map((await this.options.paneHost.snapshotPanes()).map((pane) => [pane.paneId, pane]))
          : null;
        for (const paneId of paneIds) {
          const instance = this.options.store.findAgentInstanceByPane(paneId);
          if (!instance) continue;
          const project = this.projectsById.get(instance.projectId);
          if (!project) continue;
          const pane = panesById ? panesById.get(paneId) ?? null : await this.options.paneHost.inspectPane(paneId);
          await this.reconcileInstance(instance, project, new Map(pane ? [[paneId, pane]] : []));
        }
        this.completed = true; this.lastError = null;
        return;
      }
      const workspaceIds = scope?.workspaceIds ? new Set(scope.workspaceIds) : null;
      for (const project of this.options.projects) {
        if (workspaceIds && !workspaceIds.has(project.workspaceId)) continue;
        const panes = await this.options.paneHost.listPanes(project.workspaceId);
        const panesById = new Map(panes.map((pane) => [pane.paneId, pane]));
        for (const instance of this.options.store.listAgentInstances(project.id)) await this.reconcileInstance(instance, project, panesById);
      }
      this.completed = true; this.lastError = null;
    } catch (error) { this.lastError = error instanceof Error ? error.message : String(error); throw error; }
  }

  private async reconcileInstance(instance: AgentInstance, project: ProjectConfig, panes: ReadonlyMap<string, HerdrPane>): Promise<void> {
    let runtime = instance.runtimeRef;
    if (!runtime) {
      const pending = instance.pendingRuntimeRef;
      if (instance.role !== "worker" || instance.workerSessionLifecycle !== "active" || instance.desiredState !== "running" || !pending
        || pending.generation !== instance.generation || instance.provisioningCheckpoint !== "pane-allocated" && instance.provisioningCheckpoint !== "runtime-started") return;
      const pendingPane = panes.get(pending.paneId);
      const workspace = this.options.store.getWorkspaceLease(instance.workspaceLeaseId);
      if (!pendingPane || pending.herdrWorkspaceId !== project.workspaceId || pendingPane.workspaceId !== pending.herdrWorkspaceId
        || pendingPane.cwd !== workspace?.cwd || !pendingPane.agentKind || !matchesHerdrAgentKind(instance.agentKind, pendingPane.agentKind)
        || !pendingPane.agentSession?.value || !matchesHerdrAgentKind(instance.agentKind, pendingPane.agentSession.agent)) return;
      const attached = this.options.store.attachAgentInstanceRuntime({
        instanceId: instance.id, expectedGeneration: instance.generation, herdrWorkspaceId: pending.herdrWorkspaceId,
        paneId: pending.paneId, nativeSessionId: pendingPane.agentSession.value
      });
      if (!attached?.runtimeRef) return;
      instance = attached;
      runtime = attached.runtimeRef;
    }
    const pane = panes.get(runtime.paneId);
    if (!pane) { if (this.options.store.terminateWorkerSession({ instanceId: instance.id, expectedGeneration: instance.generation, reason: `Herdr pane ${runtime.paneId} is missing` })) this.options.wakeCardContext?.(); return; }
    const workspace = this.options.store.getWorkspaceLease(instance.workspaceLeaseId);
    if (pane.workspaceId !== runtime.herdrWorkspaceId || pane.workspaceId !== project.workspaceId || pane.cwd !== workspace?.cwd || !pane.agentKind || !matchesHerdrAgentKind(instance.agentKind, pane.agentKind)) {
      if (this.options.store.terminateWorkerSession({ instanceId: instance.id, expectedGeneration: instance.generation, reason: `Herdr pane ${runtime.paneId} identity mismatch` })) this.options.wakeCardContext?.();
      return;
    }
    const observedState = normalizeState(pane);
    const updated = this.options.store.updateAgentInstanceObservation({ instanceId: instance.id, expectedGeneration: instance.generation, observedState, lastError: observedState === "detached" ? "Herdr runtime state is uncertain" : null });
    if (updated) this.options.wakeCardContext?.();
    if (updated && observedState === "idle" && this.options.store.countPendingInstanceTurns(instance.id, instance.generation) > 0) this.options.wake(instance.id);
  }
}

function normalizeState(pane: HerdrPane): ObservedInstanceState {
  if (pane.agentState === "idle" || pane.agentState === "done") return "idle";
  if (pane.agentState === "working") return "working";
  if (pane.agentState === "blocked") return "blocked";
  return "detached";
}
