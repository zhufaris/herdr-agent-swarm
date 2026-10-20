import type { Logger } from "pino";
import { matchesHerdrAgentKind, type AgentInstance, type ObservedInstanceState } from "../domain/agent-instance.js";
import { isNativeTraexSession } from "../domain/traex-session-identity.js";
import type { InstanceRuntimeReconciliationStore } from "../domain/ports/instance.js";
import type { RuntimeObservationPort } from "../domain/ports/runtime-observation.js";
import type { SemanticSnapshotCursor } from "../domain/runtime-observation.js";
import type { HerdrPane, ProjectConfig, ReconciliationDiagnostics } from "../domain/types.js";
import type { PaneHost } from "../domain/ports/pane-host.js";
import { safeLogError } from "../runtime/safe-error.js";
import { PriorityReconciliationRunner, type PriorityReconciliationScope } from "../runtime/priority-reconciliation-runner.js";
import { ProjectCatalog } from "./project-catalog.js";
import type { PaneTopologyReconciliationPort } from "../domain/ports/pane-topology.js";

interface Options { projects: readonly ProjectConfig[]; store: InstanceRuntimeReconciliationStore; paneHost: PaneHost; runtimeObservations?: RuntimeObservationPort; topology?: PaneTopologyReconciliationPort; wake(instanceId: string): void; wakeCardContext?: () => void; logger?: Pick<Logger, "warn"> }
interface ReconciliationScope { paneIds?: readonly string[]; workspaceIds?: readonly string[] }

const MAX_RECONCILIATION_FAILURES = 20;

export class InstanceRuntimeReconciler {
  private readonly projects: ProjectCatalog;
  private readonly runner: PriorityReconciliationRunner;
  private completed = false;
  private lastError: string | null = null;
  private semanticCursor: SemanticSnapshotCursor | null = null;

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
      if (this.options.runtimeObservations) {
        await this.reconcileSemantic();
        return;
      }
      if (scope.kind === "panes") await this.reconcileOnce({ paneIds: scope.ids });
      else if (scope.kind === "workspaces") await this.reconcileOnce({ workspaceIds: scope.ids });
      else await this.reconcileOnce();
    } catch (error) {
      this.options.logger?.warn({ event: "instance-runtime-reconciliation-failed", err: safeLogError(error), outcome: "retry_later" }, "instance runtime reconciliation failed");
      throw error;
    }
  }

  private async reconcileSemantic(): Promise<void> {
    const observations = this.options.runtimeObservations!;
    const evidence = await observations.readSemanticSnapshot({ cursor: this.semanticCursor, workspaceIds: [...new Set(this.options.projects.map((project) => project.workspaceId))] });
    if (evidence.kind === "current") {
      this.completed = true;
      this.lastError = null;
      return;
    }
    let complete = true;
    if (evidence.kind === "rebuild-required") await this.reconcileOnce(undefined, evidence.panes);
    else complete = await this.reconcileSemanticDelta(evidence);
    if (complete && observations.canAcknowledgeSemanticGeneration(evidence.cursor)) this.semanticCursor = evidence.cursor;
  }

  private async reconcileSemanticDelta(evidence: Extract<Awaited<ReturnType<RuntimeObservationPort["readSemanticSnapshot"]>>, { kind: "delta" }>): Promise<boolean> {
    try {
      for (const workspace of evidence.workspaces) {
        const projects = this.options.projects.filter((project) => project.workspaceId === workspace.workspaceId);
        for (const project of projects) {
          const topology = await this.options.topology?.reconcileWorkspace({ project, panes: workspace.panes });
          if (topology?.topologyChanged) return false;
        }
      }
      const panes = new Map([...evidence.added, ...evidence.changed].map((pane) => [pane.paneId, pane]));
      const paneIds = [...new Set([...panes.keys(), ...evidence.removed.map((pane) => pane.paneId)])];
      const failures: Error[] = [];
      let failureCount = 0;
      for (const paneId of paneIds) {
        const instance = this.options.store.findAgentInstanceByPane(paneId);
        if (!instance) continue;
        const project = this.projects.projectById(instance.projectId);
        if (!project) continue;
        try { await this.reconcileInstance(instance, project, new Map(panes.has(paneId) ? [[paneId, panes.get(paneId)!]] : [])); }
        catch (error) {
          failureCount += 1;
          if (failures.length < MAX_RECONCILIATION_FAILURES) failures.push(instanceFailure(instance.id, error));
        }
      }
      if (failures.length) throw aggregateFailure(failures, failureCount);
      this.completed = true;
      this.lastError = null;
      return true;
    } catch (error) {
      this.completed = false;
      this.lastError = (error instanceof AggregateError ? error.message : reconciliationErrorMessage(error)).slice(0, 500);
      throw error;
    }
  }

  private async reconcileOnce(scope?: ReconciliationScope, suppliedSnapshot?: readonly HerdrPane[]): Promise<void> {
    try {
      const failures: Error[] = [];
      let failureCount = 0;
      const collectFailure = (failure: Error): void => {
        failureCount += 1;
        if (failures.length < MAX_RECONCILIATION_FAILURES) failures.push(failure);
      };
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
          try {
            const pane = panesById ? panesById.get(paneId) ?? null : await this.options.paneHost.inspectPane(paneId);
            await this.reconcileInstance(instance, project, new Map(pane ? [[paneId, pane]] : []));
          } catch (error) {
            collectFailure(instanceFailure(instance.id, error));
          }
        }
      }
      if (scope && !scope.workspaceIds?.length) {
        if (failures.length) throw aggregateFailure(failures, failureCount);
        this.completed = true;
        this.lastError = null;
        return;
      }
      const workspaceIds = scope?.workspaceIds ? new Set(scope.workspaceIds) : null;
      const panesByWorkspace = new Map<string, Promise<ReadonlyMap<string, HerdrPane>>>();
      if (suppliedSnapshot) {
        const suppliedByWorkspace = new Map<string, Map<string, HerdrPane>>();
        for (const project of this.options.projects) suppliedByWorkspace.set(project.workspaceId, new Map());
        for (const pane of suppliedSnapshot) {
          const workspace = suppliedByWorkspace.get(pane.workspaceId) ?? new Map<string, HerdrPane>();
          workspace.set(pane.paneId, pane);
          suppliedByWorkspace.set(pane.workspaceId, workspace);
        }
        for (const [workspaceId, panes] of suppliedByWorkspace) panesByWorkspace.set(workspaceId, Promise.resolve(panes));
      }
      const failedWorkspaceIds = new Set<string>();
      const panesForWorkspace = (workspaceId: string): Promise<ReadonlyMap<string, HerdrPane>> => {
        const existing = panesByWorkspace.get(workspaceId);
        if (existing) return existing;
        const loading = this.options.paneHost.listPanes(workspaceId).then((panes) => new Map(panes.map((pane) => [pane.paneId, pane])));
        panesByWorkspace.set(workspaceId, loading);
        return loading;
      };
      for (const project of this.options.projects) {
        if (workspaceIds && !workspaceIds.has(project.workspaceId)) continue;
        if (failedWorkspaceIds.has(project.workspaceId)) continue;
        let panesById: ReadonlyMap<string, HerdrPane>;
        try {
          panesById = await panesForWorkspace(project.workspaceId);
          const topology = await this.options.topology?.reconcileWorkspace({ project, panes: [...panesById.values()] });
          if (topology?.topologyChanged) {
            panesById = new Map((await this.options.paneHost.listPanes(project.workspaceId)).map((pane) => [pane.paneId, pane]));
          }
        } catch (error) {
          failedWorkspaceIds.add(project.workspaceId);
          collectFailure(workspaceFailure(project.workspaceId, error));
          continue;
        }
        for (const instance of this.options.store.listAgentInstances(project.id)) {
          if (reconciledInstanceIds.has(instance.id)) continue;
          try {
            await this.reconcileInstance(instance, project, panesById);
          } catch (error) {
            collectFailure(instanceFailure(instance.id, error));
          }
        }
      }
      if (failures.length) throw aggregateFailure(failures, failureCount);
      this.completed = true; this.lastError = null;
    } catch (error) {
      this.completed = false;
      this.lastError = (error instanceof AggregateError ? error.message : reconciliationErrorMessage(error)).slice(0, 500);
      throw error;
    }
  }

  private async reconcileInstance(instance: AgentInstance, project: ProjectConfig, panes: ReadonlyMap<string, HerdrPane>): Promise<void> {
    let runtime = instance.runtimeRef;
    if (!runtime) {
      const pending = instance.pendingRuntimeRef;
      if (instance.role !== "worker" || instance.workerSessionLifecycle !== "active" || instance.desiredState !== "running" || !pending
        || pending.generation !== instance.generation || instance.provisioningCheckpoint !== "pane-allocated" && instance.provisioningCheckpoint !== "runtime-started") return;
      const pendingPane = panes.get(pending.paneId);
      if (!pendingPane) {
        if (this.options.store.terminateWorkerSession({
          instanceId: instance.id, expectedGeneration: instance.generation, reason: `Herdr pending pane ${pending.paneId} is missing`
        })) this.options.wakeCardContext?.();
        return;
      }
      const workspace = this.options.store.getWorkspaceLease(instance.workspaceLeaseId);
      if (pending.herdrWorkspaceId !== project.workspaceId || pendingPane.workspaceId !== pending.herdrWorkspaceId
        || pendingPane.cwd !== workspace?.cwd || !pendingPane.agentKind || !matchesHerdrAgentKind(instance.agentKind, pendingPane.agentKind)
        || !pendingPane.agentSession?.value || !matchesHerdrAgentKind(instance.agentKind, pendingPane.agentSession.agent)) return;
      const attached = this.options.store.attachAgentInstanceRuntime({
        instanceId: instance.id, expectedGeneration: instance.generation, herdrWorkspaceId: pending.herdrWorkspaceId,
        paneId: pending.paneId, paneToken: pendingPane.paneToken ?? null, nativeSessionId: pendingPane.agentSession.value
      });
      if (!attached?.runtimeRef) return;
      instance = attached;
      runtime = attached.runtimeRef;
      this.options.wakeCardContext?.();
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
    const observation = this.options.store.updateAgentInstanceObservation({
      instanceId: instance.id, expectedGeneration: instance.generation, expectedRuntime: runtime, expectedParent: instance.parent,
      observedState, ...(pane.paneToken ? { paneToken: pane.paneToken } : {}), lastError: observedState === "detached" ? "Herdr runtime state is uncertain" : null
    });
    if (observation.outcome === "updated") this.options.wakeCardContext?.();
    if (observation.outcome === "updated" && observedState === "idle" && this.options.store.countPendingInstanceTurns(instance.id, instance.generation) > 0) this.options.wake(instance.id);
  }
}

function instanceFailure(instanceId: string, cause: unknown): Error {
  return new Error(`Instance runtime reconciliation failed for instance ${instanceId}`, { cause });
}

function workspaceFailure(workspaceId: string, cause: unknown): Error {
  return new Error(`Instance runtime reconciliation failed for workspace ${workspaceId}`, { cause });
}

function aggregateFailure(failures: readonly Error[], failureCount: number): AggregateError {
  const omitted = failureCount - failures.length;
  const scopeSummary = omitted > 0
    ? `Instance runtime reconciliation failed for ${failureCount} scopes; reporting the first ${failures.length}`
    : `Instance runtime reconciliation failed for ${failureCount} scope${failureCount === 1 ? "" : "s"}`;
  const first = failures[0]!;
  const detail = reconciliationErrorMessage(first).slice(0, 200);
  return new AggregateError(failures, `${scopeSummary}; ${first.message}: ${detail}`.slice(0, 500));
}

function reconciliationErrorMessage(error: unknown): string {
  if (error instanceof AggregateError && error.errors.length > 0) {
    const first = error.errors[0];
    return reconciliationErrorMessage(first);
  }
  if (error instanceof Error && error.cause !== undefined) return reconciliationErrorMessage(error.cause);
  return error instanceof Error ? error.message : String(error);
}

function normalizeState(pane: HerdrPane): ObservedInstanceState {
  if (pane.agentState === "idle" || pane.agentState === "done") return "idle";
  if (pane.agentState === "working") return "working";
  if (pane.agentState === "blocked") return "blocked";
  return "detached";
}
