import type { Logger } from "pino";
import { matchesHerdrAgentKind, type AgentInstance, type ObservedInstanceState } from "../domain/agent-instance.js";
import type { InstanceRuntimeReconciliationStore } from "../domain/ports/instance.js";
import type { HerdrPane, ProjectConfig, ReconciliationDiagnostics } from "../domain/types.js";
import type { PaneHost } from "../runtime/herdr/pane-host.js";
import { safeLogError } from "../runtime/safe-error.js";
import { ReconciliationRunMetrics } from "../runtime/reconciliation-run-metrics.js";
import { ProjectCatalog } from "./project-catalog.js";

interface Options { projects: readonly ProjectConfig[]; store: InstanceRuntimeReconciliationStore; paneHost: PaneHost; wake(instanceId: string): void; wakeCardContext?: () => void; logger?: Pick<Logger, "warn"> }
interface ReconciliationScope { paneIds?: readonly string[]; workspaceIds?: readonly string[] }
type PendingReconciliationScope = null | { paneIds: Set<string>; workspaceIds: Set<string> };

export class InstanceRuntimeReconciler {
  private readonly projects: ProjectCatalog;
  private running: Promise<void> | null = null;
  private pending: PendingReconciliationScope | undefined;
  private timer: NodeJS.Timeout | null = null;
  private stopping = false;
  private completed = false;
  private lastError: string | null = null;
  private readonly metrics = new ReconciliationRunMetrics();

  constructor(private readonly options: Options) {
    this.projects = new ProjectCatalog(options.projects);
  }

  reconcile(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.running) { this.metrics.markCoalesced(); return this.running; }
    return this.startDrain(null);
  }

  requestReconciliation(scope?: ReconciliationScope): Promise<void> {
    if (this.stopping) return Promise.resolve();
    const requested = normalizeScope(scope);
    if (this.running) { this.metrics.markCoalesced(); this.pending = mergeScopes(this.pending, requested); return this.running; }
    return this.startDrain(requested);
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
  async stop(): Promise<void> { this.stopping = true; this.pending = undefined; if (this.timer) clearInterval(this.timer); this.timer = null; await this.running; }
  snapshot(): ReconciliationDiagnostics & { ready: boolean; lastError: string | null } {
    return { ...this.metrics.snapshot(this.stopping ? "stopping" : this.running ? "running" : "idle"), ready: this.completed && !this.lastError, lastError: this.lastError };
  }

  private startDrain(requested: PendingReconciliationScope): Promise<void> {
    this.pending = mergeScopes(this.pending, requested);
    const run = this.drain();
    const tracked = run.finally(() => { if (this.running === tracked) this.running = null; });
    this.running = tracked;
    return tracked;
  }

  private async drain(): Promise<void> {
    while (!this.stopping && this.pending !== undefined) {
      const requested = this.pending;
      this.pending = undefined;
      await this.metrics.measure(() => this.reconcileOnce(denormalizeScope(requested)));
    }
  }

  private async reconcileOnce(scope?: ReconciliationScope): Promise<void> {
    try {
      const reconciledInstanceIds = new Set<string>();
      if (scope?.paneIds?.length) {
        const paneIds = [...new Set(scope.paneIds)];
        const panesById = this.options.paneHost.snapshotPanes
          ? new Map((await this.options.paneHost.snapshotPanes()).map((pane) => [pane.paneId, pane]))
          : null;
        for (const paneId of paneIds) {
          const instance = this.options.store.findAgentInstanceByPane(paneId);
          if (!instance) continue;
          reconciledInstanceIds.add(instance.id);
          const project = this.projects.projectById(instance.projectId);
          if (!project) continue;
          const pane = panesById ? panesById.get(paneId) ?? null : await this.options.paneHost.inspectPane(paneId);
          await this.reconcileInstance(instance, project, new Map(pane ? [[paneId, pane]] : []));
        }
      }
      if (scope && !scope.workspaceIds?.length) { this.completed = true; this.lastError = null; return; }
      const workspaceIds = scope?.workspaceIds ? new Set(scope.workspaceIds) : null;
      for (const project of this.options.projects) {
        if (workspaceIds && !workspaceIds.has(project.workspaceId)) continue;
        const panes = await this.options.paneHost.listPanes(project.workspaceId);
        const panesById = new Map(panes.map((pane) => [pane.paneId, pane]));
        for (const instance of this.options.store.listAgentInstances(project.id)) if (!reconciledInstanceIds.has(instance.id)) await this.reconcileInstance(instance, project, panesById);
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

function normalizeScope(scope?: ReconciliationScope): PendingReconciliationScope {
  return scope === undefined ? null : { paneIds: new Set(scope.paneIds ?? []), workspaceIds: new Set(scope.workspaceIds ?? []) };
}
function denormalizeScope(scope: PendingReconciliationScope): ReconciliationScope | undefined {
  return scope === null ? undefined : { ...(scope.paneIds.size ? { paneIds: [...scope.paneIds] } : {}), ...(scope.workspaceIds.size ? { workspaceIds: [...scope.workspaceIds] } : {}) };
}
function mergeScopes(current: PendingReconciliationScope | undefined, next: PendingReconciliationScope): PendingReconciliationScope {
  if (current === null || next === null) return null;
  if (current === undefined) return { paneIds: new Set(next.paneIds), workspaceIds: new Set(next.workspaceIds) };
  return { paneIds: new Set([...current.paneIds, ...next.paneIds]), workspaceIds: new Set([...current.workspaceIds, ...next.workspaceIds]) };
}
function normalizeState(pane: HerdrPane): ObservedInstanceState {
  if (pane.agentState === "idle" || pane.agentState === "done") return "idle";
  if (pane.agentState === "working") return "working";
  if (pane.agentState === "blocked") return "blocked";
  return "detached";
}
