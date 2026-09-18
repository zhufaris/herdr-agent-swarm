import type { Logger } from "pino";
import { matchesHerdrAgentKind, type AgentInstance, type ObservedInstanceState } from "../domain/agent-instance.js";
import { isNativeTraexSession } from "../domain/traex-session-identity.js";
import type { InstanceRuntimeReconciliationStore } from "../domain/ports/instance.js";
import type { HerdrPane, ProjectConfig, ReconciliationDiagnostics } from "../domain/types.js";
import type { PaneHost } from "../runtime/herdr/pane-host.js";
import { safeLogError } from "../runtime/safe-error.js";
import { PriorityReconciliationRunner, type PriorityReconciliationScope } from "../runtime/priority-reconciliation-runner.js";
import { ProjectCatalog } from "./project-catalog.js";

interface Options { projects: readonly ProjectConfig[]; store: InstanceRuntimeReconciliationStore; paneHost: PaneHost; wake(instanceId: string): void; wakeCardContext?: () => void; logger?: Pick<Logger, "warn"> }
interface ReconciliationScope { paneIds?: readonly string[]; workspaceIds?: readonly string[] }

export class InstanceRuntimeReconciler {
  private readonly projects: ProjectCatalog;
  private readonly runner: PriorityReconciliationRunner;
  private completed = false;
  private lastError: string | null = null;

  constructor(private readonly options: Options) {
    this.projects = new ProjectCatalog(options.projects);
    this.runner = new PriorityReconciliationRunner({ execute: (scope) => this.execute(scope) });
  }

  reconcile(): Promise<void> {
    return this.runner.request({ kind: "all" }, { allowActiveCoverage: true });
  }

  requestReconciliation(scope?: ReconciliationScope): Promise<void> {
    if (!scope) return this.runner.request({ kind: "all" });
    const requests: Promise<void>[] = [];
    if (scope.paneIds?.length) requests.push(this.runner.request({ kind: "panes", ids: scope.paneIds }));
    if (scope.workspaceIds?.length) requests.push(this.runner.request({ kind: "workspaces", ids: scope.workspaceIds }));
    return requests.length > 0 ? Promise.all(requests).then(() => undefined) : Promise.resolve();
  }
  start(intervalMs: number): void {
    this.runner.start(intervalMs);
  }
  async stop(): Promise<void> { await this.runner.stop(); }
  snapshot(): ReconciliationDiagnostics & { ready: boolean; lastError: string | null } {
    return { ...this.runner.snapshot(), ready: this.completed && !this.lastError, lastError: this.lastError };
  }

  private async execute(scope: PriorityReconciliationScope): Promise<void> {
    try {
      if (scope.kind === "panes") await this.reconcileOnce({ paneIds: scope.ids });
      else if (scope.kind === "workspaces") await this.reconcileOnce({ workspaceIds: scope.ids });
      else await this.reconcileOnce();
    } catch (error) {
      this.options.logger?.warn({ event: "instance-runtime-reconciliation-failed", err: safeLogError(error), outcome: "retry_later" }, "instance runtime reconciliation failed");
      throw error;
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
    if (instance.agentKind === "traex" && isNativeTraexSession(pane.agentSession) && pane.agentSession.value !== runtime.nativeSessionId) {
      const refreshed = this.options.store.refreshAgentInstanceRuntimeSession({
        instanceId: instance.id, expectedGeneration: instance.generation, herdrWorkspaceId: runtime.herdrWorkspaceId, paneId: runtime.paneId, nativeSessionId: pane.agentSession.value
      });
      if (!refreshed?.runtimeRef) return;
      instance = refreshed;
      runtime = refreshed.runtimeRef;
      this.options.wakeCardContext?.();
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
