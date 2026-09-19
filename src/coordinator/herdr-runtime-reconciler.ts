import type { Logger } from "pino";
import type { ProjectConfig, Binding, HerdrPane, ReconciliationDiagnostics, ReconciliationPassResult } from "../domain/types.js";
import type { HerdrPort } from "../domain/ports/external.js";
import type { RuntimeReconciliationStore } from "../domain/ports/binding.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import { PriorityReconciliationRunner, type PriorityReconciliationScope } from "../runtime/priority-reconciliation-runner.js";
import { HerdrSnapshotCollector } from "./herdr-snapshot-collector.js";
import { BindingRuntimeConverger } from "./binding-runtime-converger.js";
import { ProjectCatalog } from "./project-catalog.js";
import { reconciliationCooldownCovers } from "./reconciliation-scope-policy.js";

const EVENT_RECONCILIATION_COOLDOWN_MS = 1_000;

interface HerdrRuntimeReconcilerOptions {
  projects: readonly ProjectConfig[];
  store: RuntimeReconciliationStore;
  herdr: HerdrPort;
  lifecycleEvents: LifecycleEventPublisher;
  channelPublisher: {
    enqueueRunCardUpdate(bindingId: string, promptId: string, messageId: string, viewVersion: number, cardRole: "answer", card: object): Promise<void>;
  };
  wakeOutbound?: () => void;
  convergeAnswer?(promptId: string): Promise<void>;
  logger: Logger;
  discoverPane(pane: HerdrPane, project: ProjectConfig): Promise<Binding>;
  scheduler: PromptWorkScheduler;
  isBindingBusy(bindingId: string): boolean;
  worktreeNameFor?(cwd: string | null | undefined): Promise<string | null>;
  externalTurnObserver?: { observe(binding: Binding): Promise<void> };
  presentation: Pick<PrimaryPresentation, "mainCard" | "paneEntryCard" | "answerCard">;
}

export interface HerdrRuntimeReconcilerPort {
  captureBaselines(): Promise<void>;
  reconcile(workspaceIds?: readonly string[]): Promise<void>;
  requestReconciliation(workspaceIds?: readonly string[]): Promise<void>;
  requestPaneReconciliation(paneIds: readonly string[]): Promise<void>;
  snapshot(): ReconciliationDiagnostics;
  start(intervalMs: number): void;
  stop(): Promise<void>;
}

export class HerdrRuntimeReconciler implements HerdrRuntimeReconcilerPort {
  private readonly configuredWorkspaceIds: ReadonlySet<string>;
  private readonly projects: ProjectCatalog;
  private skippedPaneReasons = new Map<string, string>();
  private readonly snapshots: HerdrSnapshotCollector;
  private readonly reconciliationRunner: PriorityReconciliationRunner;
  private readonly lastReconciledAt = new Map<string, number>();
  private readonly converger: BindingRuntimeConverger;

  constructor(private readonly options: HerdrRuntimeReconcilerOptions) {
    this.configuredWorkspaceIds = new Set(options.projects.map((project) => project.workspaceId));
    this.snapshots = new HerdrSnapshotCollector(options.herdr, options.logger);
    this.reconciliationRunner = new PriorityReconciliationRunner({ execute: (scope) => this.execute(scope) });
    this.converger = new BindingRuntimeConverger(options);
    this.projects = new ProjectCatalog(options.projects);
  }

  async captureBaselines(): Promise<void> {
    const panes = await this.snapshots.allOrConfigured([...this.configuredWorkspaceIds]);
    for (const pane of panes) this.converger.captureBaseline(pane);
  }

  async reconcile(workspaceIds?: readonly string[]): Promise<void> {
    return this.reconciliationRunner.request(scopeForWorkspaces(workspaceIds), { allowActiveCoverage: true });
  }

  async requestReconciliation(workspaceIds?: readonly string[]): Promise<void> {
    if (reconciliationCooldownCovers({ ...(workspaceIds ? { requestedWorkspaceIds: workspaceIds } : {}), configuredWorkspaceIds: this.configuredWorkspaceIds, lastReconciledAt: this.lastReconciledAt, now: performance.now(), cooldownMs: EVENT_RECONCILIATION_COOLDOWN_MS })) {
      this.reconciliationRunner.markCoalesced();
      return;
    }
    return this.reconciliationRunner.request(scopeForWorkspaces(workspaceIds), { allowActiveCoverage: workspaceIds !== undefined });
  }

  async requestPaneReconciliation(paneIds: readonly string[]): Promise<void> {
    return this.reconciliationRunner.request({ kind: "panes", ids: paneIds });
  }

  private async reconcilePanes(paneIds: readonly string[]): Promise<void> {
    const uniquePaneIds = [...new Set(paneIds)];
    const observations = this.options.herdr.observeRuntimes
      ? await this.options.herdr.observeRuntimes(uniquePaneIds)
      : new Map(await Promise.all(uniquePaneIds.map(async (paneId) => [paneId, await this.options.herdr.observeRuntime(paneId)] as const)));
    for (const paneId of uniquePaneIds) {
      const existing = this.options.store.findBindingByPane(paneId);
      if (!existing || (existing.state !== "active" && existing.state !== "orphaned")) continue;
      try {
        const observation = observations.get(paneId) ?? { pane: null, traexProcess: false, composerReady: false, evidenceSource: "none" as const };
        if (!observation.pane) { await this.converger.orphan(existing); continue; }
        await this.converger.converge(existing, observation.pane);
      } catch (error) {
        this.options.logger.warn({ event: "pane-reconciliation-failed", err: safeLogError(error), workspaceId: existing.workspaceId, paneId, outcome: "deferred" }, "failed to reconcile one Herdr pane");
      }
    }
  }

  snapshot(): ReconciliationDiagnostics {
    return this.reconciliationRunner.snapshot();
  }

  start(intervalMs: number): void {
    this.reconciliationRunner.start(intervalMs);
  }

  async stop(): Promise<void> {
    await this.reconciliationRunner.stop();
  }

  private async execute(scope: PriorityReconciliationScope): Promise<ReconciliationPassResult | void> {
    if (scope.kind === "panes") return this.reconcilePanes(scope.ids);
    const result = await this.reconcileOnce(scope.kind === "workspaces" ? new Set(scope.ids) : undefined);
    const completedAt = performance.now();
    for (const workspaceId of result.reconciledWorkspaceIds) this.lastReconciledAt.set(workspaceId, completedAt);
    return result;
  }

  private async reconcileOnce(requestedWorkspaceIds?: ReadonlySet<string>): Promise<ReconciliationPassResult> {
    const allActiveBindings = this.options.store.listBindingsByState("active");
    const orphanedBindings = this.options.store.listBindingsByState("orphaned");
    const reconciliationWorkspaceIds = new Set(this.configuredWorkspaceIds);
    for (const binding of [...allActiveBindings, ...orphanedBindings]) reconciliationWorkspaceIds.add(binding.workspaceId);
    const workspaceIds = requestedWorkspaceIds
      ? [...requestedWorkspaceIds].filter((workspaceId) => reconciliationWorkspaceIds.has(workspaceId))
      : [...reconciliationWorkspaceIds];
    const { panesByWorkspace, failures } = await this.snapshots.collect(workspaceIds);

    const paneIdsByWorkspace = new Map<string, Set<string>>();
    for (const [workspaceId, workspacePanes] of panesByWorkspace) paneIdsByWorkspace.set(workspaceId, new Set(workspacePanes.map((pane) => pane.paneId)));
    const activeBindings = requestedWorkspaceIds
      ? allActiveBindings.filter((binding) => requestedWorkspaceIds.has(binding.workspaceId))
      : allActiveBindings;
    const bindingByPaneId = new Map(activeBindings.flatMap((binding) => binding.paneId ? [[binding.paneId, binding] as const] : []));
    let pendingBindings: Binding[] | null = null;
    let interruptedProvisioningByProjectId: Map<string, Binding> | null = null;
    for (const binding of activeBindings) {
      try {
        const workspacePanes = panesByWorkspace.get(binding.workspaceId);
        if (!workspacePanes) {
          binding.degradationCount + 1 >= 2
            ? await this.converger.orphan(binding, `Herdr workspace ${binding.workspaceId} remained unavailable`)
            : this.options.store.transitionBinding(binding.id, { type: "pane_probe_failed", confirmedMissing: false, orphanThreshold: 2 });
          continue;
        }
        if (binding.paneId && !paneIdsByWorkspace.get(binding.workspaceId)!.has(binding.paneId)) await this.converger.orphan(binding);
      } catch (error) {
        this.options.logger.warn({ event: "binding-reconciliation-failed", err: safeLogError(error), bindingId: binding.id, workspaceId: binding.workspaceId, paneId: binding.paneId, phase: "missing-pane", outcome: "deferred" }, "failed to reconcile one binding");
      }
    }

    const nextSkippedPaneReasons = requestedWorkspaceIds ? new Map(this.skippedPaneReasons) : new Map<string, string>();
    for (const [requestedWorkspaceId, panes] of panesByWorkspace) for (const snapshotPane of panes) {
      try {
      let pane = snapshotPane;
      if (pane.workspaceId !== requestedWorkspaceId) {
        this.options.logger.warn({ event: "herdr-pane-skipped", requestedWorkspaceId, reportedWorkspaceId: pane.workspaceId, paneId: pane.paneId, reason: "workspace_mismatch" }, "skipping pane returned for the wrong workspace");
        continue;
      }
      let existing = bindingByPaneId.get(pane.paneId) ?? this.options.store.findBindingByPane(pane.paneId);
      if (existing && pane.agentState === "unknown") {
        try {
          const observation = await this.options.herdr.observeRuntime(pane.paneId);
          pane = observation.pane ?? pane;
          this.options.logger.debug({
            event: "binding-runtime-observed", bindingId: existing.id, paneId: pane.paneId,
            agentState: observation.pane?.agentState ?? "unknown", evidenceSource: observation.evidenceSource
          }, "enriched bound pane from runtime evidence");
        }
        catch (error) {
          this.options.logger.warn({ event: "binding-agent-probe-failed", err: safeLogError(error), bindingId: existing.id, workspaceId: pane.workspaceId, paneId: pane.paneId, outcome: "unknown" }, "failed to enrich unknown bound pane");
        }
      }
      if (!existing) {
        if (!pane.foregroundExecutables.includes("traex")) continue;
        const matchingProjects = this.projects.projectsForWorkspaceAndCwd(pane.workspaceId, pane.cwd);
        const project = matchingProjects.length === 1 ? matchingProjects[0] : undefined;
        if (!project) {
          const matchingProjectIds = matchingProjects.map((candidate) => candidate.id).sort();
          const reason = matchingProjects.length === 0 ? "unregistered" : "ambiguous";
          const signature = `${reason}:${matchingProjectIds.join(",")}`;
          nextSkippedPaneReasons.set(pane.paneId, signature);
          if (this.skippedPaneReasons.get(pane.paneId) !== signature) this.options.logger.warn({ event: "herdr-pane-skipped", workspaceId: pane.workspaceId, paneId: pane.paneId, matchingProjects: matchingProjectIds, reason }, "skipping unregistered or ambiguous Herdr pane");
          continue;
        }
        if (!interruptedProvisioningByProjectId) {
          pendingBindings ??= this.options.store.listBindingsByState("pending");
          interruptedProvisioningByProjectId = new Map<string, Binding>();
          for (const candidate of pendingBindings) {
            if (candidate.lifecycle !== "provisioning" || candidate.provisioningCheckpoint !== "selected" || !candidate.projectId) continue;
            if (!interruptedProvisioningByProjectId.has(candidate.projectId)) interruptedProvisioningByProjectId.set(candidate.projectId, candidate);
          }
        }
        const interruptedProvisioning = interruptedProvisioningByProjectId.get(project.id);
        if (interruptedProvisioning) {
          const signature = `provisioning:${interruptedProvisioning.id}`;
          nextSkippedPaneReasons.set(pane.paneId, signature);
          if (this.skippedPaneReasons.get(pane.paneId) !== signature) this.options.logger.warn({ event: "herdr-pane-skipped", workspaceId: pane.workspaceId, paneId: pane.paneId, projectId: project.id, bindingId: interruptedProvisioning.id, reason: "ambiguous_interrupted_provisioning" }, "leaving pane unclaimed until interrupted provisioning is resolved explicitly");
          continue;
        }
        if (this.skippedPaneReasons.has(pane.paneId)) this.options.logger.info({ event: "herdr-pane-skip-resolved", workspaceId: pane.workspaceId, paneId: pane.paneId, projectId: project.id, outcome: "registered" }, "previously skipped Herdr pane now matches a project");
        existing = await this.options.discoverPane(pane, project);
        bindingByPaneId.set(pane.paneId, existing);
        continue;
      }
      await this.converger.converge(existing, pane);
      } catch (error) {
        this.options.logger.warn({ event: "pane-reconciliation-failed", err: safeLogError(error), workspaceId: requestedWorkspaceId, paneId: snapshotPane.paneId, outcome: "deferred" }, "failed to reconcile one Herdr pane");
      }
    }
    if (requestedWorkspaceIds === undefined && panesByWorkspace.size === reconciliationWorkspaceIds.size) {
      const livePaneIds = new Set([...panesByWorkspace.values()].flatMap((panes) => panes.map((pane) => pane.paneId)));
      this.converger.prune(livePaneIds);
    }
    this.skippedPaneReasons = nextSkippedPaneReasons;
    return { reconciledWorkspaceIds: new Set(panesByWorkspace.keys()), failures };
  }

}

function scopeForWorkspaces(workspaceIds?: readonly string[]): PriorityReconciliationScope {
  return workspaceIds === undefined ? { kind: "all" } : { kind: "workspaces", ids: workspaceIds };
}
