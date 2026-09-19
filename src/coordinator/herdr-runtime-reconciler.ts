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
import { FailureLogGate } from "../runtime/failure-log-gate.js";
import { mapWithConcurrency } from "../runtime/map-with-concurrency.js";

const EVENT_RECONCILIATION_COOLDOWN_MS = 1_000;
const EXISTING_BINDING_CONCURRENCY = 4;

type ReconciliationPhaseDiagnostics = Pick<ReconciliationDiagnostics,
  "snapshotDurationMs" | "missingPaneDurationMs" | "existingBindingDurationMs" | "discoveryDurationMs" |
  "existingBindingCount" | "discoveryCandidateCount">;

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
  private readonly failureLogs = new FailureLogGate();
  private phaseDiagnostics: ReconciliationPhaseDiagnostics = {
    snapshotDurationMs: null, missingPaneDurationMs: null, existingBindingDurationMs: null, discoveryDurationMs: null,
    existingBindingCount: null, discoveryCandidateCount: null
  };

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
        this.logRecovery(`pane:${paneId}`, { workspaceId: existing.workspaceId, paneId });
      } catch (error) {
        this.logFailure(`pane:${paneId}`, "pane-reconciliation", error, { workspaceId: existing.workspaceId, paneId });
      }
    }
  }

  snapshot(): ReconciliationDiagnostics {
    return { ...this.reconciliationRunner.snapshot(), ...this.phaseDiagnostics };
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
    const snapshotStarted = performance.now();
    const { panesByWorkspace, failures } = await this.snapshots.collect(workspaceIds);
    const snapshotDurationMs = elapsedMs(snapshotStarted);

    const paneIdsByWorkspace = new Map<string, Set<string>>();
    for (const [workspaceId, workspacePanes] of panesByWorkspace) paneIdsByWorkspace.set(workspaceId, new Set(workspacePanes.map((pane) => pane.paneId)));
    const activeBindings = requestedWorkspaceIds
      ? allActiveBindings.filter((binding) => requestedWorkspaceIds.has(binding.workspaceId))
      : allActiveBindings;
    const bindingByPaneId = new Map(activeBindings.flatMap((binding) => binding.paneId ? [[binding.paneId, binding] as const] : []));
    let pendingBindings: Binding[] | null = null;
    let interruptedProvisioningByProjectId: Map<string, Binding> | null = null;
    const missingPaneStarted = performance.now();
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
        this.logRecovery(`binding:${binding.id}:missing-pane`, { bindingId: binding.id, workspaceId: binding.workspaceId, paneId: binding.paneId, phase: "missing-pane" });
      } catch (error) {
        this.logFailure(`binding:${binding.id}:missing-pane`, "binding-reconciliation", error, { bindingId: binding.id, workspaceId: binding.workspaceId, paneId: binding.paneId, phase: "missing-pane" });
      }
    }
    const missingPaneDurationMs = elapsedMs(missingPaneStarted);

    const nextSkippedPaneReasons = requestedWorkspaceIds ? new Map(this.skippedPaneReasons) : new Map<string, string>();
    const snapshotPanes = [...panesByWorkspace].flatMap(([requestedWorkspaceId, panes]) => panes.map((pane) => ({ requestedWorkspaceId, pane })));
    const existingPanes: Array<{ requestedWorkspaceId: string; pane: HerdrPane; binding: Binding }> = [];
    const discoveryPanes: Array<{ requestedWorkspaceId: string; pane: HerdrPane }> = [];
    for (const item of snapshotPanes) {
      if (item.pane.workspaceId !== item.requestedWorkspaceId) {
        this.options.logger.warn({ event: "herdr-pane-skipped", requestedWorkspaceId: item.requestedWorkspaceId, reportedWorkspaceId: item.pane.workspaceId, paneId: item.pane.paneId, reason: "workspace_mismatch" }, "skipping pane returned for the wrong workspace");
        continue;
      }
      const existing = bindingByPaneId.get(item.pane.paneId) ?? this.options.store.findBindingByPane(item.pane.paneId);
      if (existing) existingPanes.push({ ...item, binding: existing });
      else discoveryPanes.push(item);
    }
    const existingBindingStarted = performance.now();
    await mapWithConcurrency(existingPanes, EXISTING_BINDING_CONCURRENCY, async ({ requestedWorkspaceId, pane: snapshotPane, binding }) => {
      try {
        let pane = snapshotPane;
        if (pane.agentState === "unknown") {
          try {
            const observation = await this.options.herdr.observeRuntime(pane.paneId);
            pane = observation.pane ?? pane;
            this.logRecovery(`probe:${binding.id}`, { bindingId: binding.id, workspaceId: pane.workspaceId, paneId: pane.paneId, phase: "agent-probe" });
            this.options.logger.debug({
              event: "binding-runtime-observed", bindingId: binding.id, paneId: pane.paneId,
              agentState: observation.pane?.agentState ?? "unknown", evidenceSource: observation.evidenceSource
            }, "enriched bound pane from runtime evidence");
          }
          catch (error) {
            this.logFailure(`probe:${binding.id}`, "binding-agent-probe", error, { bindingId: binding.id, workspaceId: pane.workspaceId, paneId: pane.paneId, outcome: "unknown" });
          }
        }
        await this.converger.converge(binding, pane);
        this.logRecovery(`pane:${snapshotPane.paneId}`, { workspaceId: requestedWorkspaceId, paneId: snapshotPane.paneId });
      } catch (error) {
        this.logFailure(`pane:${snapshotPane.paneId}`, "pane-reconciliation", error, { workspaceId: requestedWorkspaceId, paneId: snapshotPane.paneId });
      }
    });
    const existingBindingDurationMs = elapsedMs(existingBindingStarted);
    const discoveryStarted = performance.now();
    for (const { requestedWorkspaceId, pane } of discoveryPanes) {
      try {
        if (bindingByPaneId.has(pane.paneId) || this.options.store.findBindingByPane(pane.paneId)) continue;
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
        const existing = await this.options.discoverPane(pane, project);
        bindingByPaneId.set(pane.paneId, existing);
        this.logRecovery(`pane:${pane.paneId}`, { workspaceId: pane.workspaceId, paneId: pane.paneId });
      } catch (error) {
        this.logFailure(`pane:${pane.paneId}`, "pane-reconciliation", error, { workspaceId: requestedWorkspaceId, paneId: pane.paneId });
      }
    }
    const discoveryDurationMs = elapsedMs(discoveryStarted);
    if (requestedWorkspaceIds === undefined && panesByWorkspace.size === reconciliationWorkspaceIds.size) {
      const livePaneIds = new Set([...panesByWorkspace.values()].flatMap((panes) => panes.map((pane) => pane.paneId)));
      this.converger.prune(livePaneIds);
    }
    this.skippedPaneReasons = nextSkippedPaneReasons;
    this.phaseDiagnostics = {
      snapshotDurationMs, missingPaneDurationMs, existingBindingDurationMs, discoveryDurationMs,
      existingBindingCount: existingPanes.length, discoveryCandidateCount: discoveryPanes.length
    };
    return { reconciledWorkspaceIds: new Set(panesByWorkspace.keys()), failures };
  }

  private logFailure(scope: string, event: string, error: unknown, context: Record<string, unknown>): void {
    const safe = safeLogError(error);
    const decision = this.failureLogs.fail(scope, safe.message);
    if (decision.kind === "suppressed") return;
    this.options.logger.warn({ ...context, event: decision.kind === "summary" ? `${event}-failure-summary` : `${event}-failed`, err: safe, repeatCount: decision.count, firstFailureAt: decision.firstFailureAt, outcome: "deferred" }, `failed ${event.replaceAll("-", " ")}`);
  }

  private logRecovery(scope: string, context: Record<string, unknown>): void {
    const recovery = this.failureLogs.recover(scope);
    if (recovery) this.options.logger.info({ ...context, event: "reconciliation-recovered", ...recovery, outcome: "recovered" }, "reconciliation recovered");
  }

}

function scopeForWorkspaces(workspaceIds?: readonly string[]): PriorityReconciliationScope {
  return workspaceIds === undefined ? { kind: "all" } : { kind: "workspaces", ids: workspaceIds };
}

function elapsedMs(startedAt: number): number {
  return Math.max(0, Math.round(performance.now() - startedAt));
}
