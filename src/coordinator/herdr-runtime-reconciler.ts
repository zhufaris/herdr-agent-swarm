import type { Logger } from "pino";
import { renderProjectEntryCard, renderRequestAnswerCard } from "../cards/run-card.js";
import { projectSpaceName } from "../config.js";
import { createBridgeEvent, type BridgeEventOf } from "../domain/create-bridge-event.js";
import type { BridgeEvent } from "../domain/events.js";
import type { ProjectConfig, Binding, HerdrPane, ReconciliationDiagnostics } from "../domain/types.js";
import type { HerdrPort, RuntimeReconciliationStore } from "../domain/ports.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import { formatProjectPaneTitle } from "../domain/thread-title.js";
import { FailureLogGate } from "../runtime/failure-log-gate.js";

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
  externalTurnObserver?: { observe(binding: Binding): Promise<void>; stop(): Promise<void> };
}

const EVENT_RECONCILIATION_COOLDOWN_MS = 1_000;

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
  private reconciliation: Promise<void> | null = null;
  private pendingReconciliation: Set<string> | null | undefined;
  private activeReconciliation: Set<string> | null | undefined;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly observedAgentStates = new Map<string, { terminalId: string | null; sequence: number; state: HerdrPane["agentState"] }>();
  private readonly observedTabIds = new Map<string, string | null>();
  private readonly observedWorktreeNames = new Map<string, string | null>();
  private readonly lastReconciledAt = new Map<string, number>();
  private readonly configuredWorkspaceIds: ReadonlySet<string>;
  private readonly projectsById: ReadonlyMap<string, ProjectConfig>;
  private readonly projectsByWorkspaceAndCwd: ReadonlyMap<string, readonly ProjectConfig[]>;
  private skippedPaneReasons = new Map<string, string>();
  private runCount = 0;
  private successCount = 0;
  private failureCount = 0;
  private coalescedRequestCount = 0;
  private lastStartedAt: string | null = null;
  private lastCompletedAt: string | null = null;
  private lastDurationMs: number | null = null;
  private maxDurationMs: number | null = null;
  private lastOutcome: ReconciliationDiagnostics["lastOutcome"] = null;
  private readonly workspaceFailureLogs = new FailureLogGate();

  constructor(private readonly options: HerdrRuntimeReconcilerOptions) {
    this.configuredWorkspaceIds = new Set(options.projects.map((project) => project.workspaceId));
    this.projectsById = new Map(options.projects.map((project) => [project.id, project]));
    const projectsByWorkspaceAndCwd = new Map<string, ProjectConfig[]>();
    for (const project of options.projects) {
      const key = workspaceCwdKey(project.workspaceId, project.cwd);
      const projects = projectsByWorkspaceAndCwd.get(key) ?? [];
      projects.push(project);
      projectsByWorkspaceAndCwd.set(key, projects);
    }
    this.projectsByWorkspaceAndCwd = projectsByWorkspaceAndCwd;
  }

  async captureBaselines(): Promise<void> {
    const panes = this.options.herdr.listAllPanes
      ? await this.options.herdr.listAllPanes()
      : (await Promise.all([...this.configuredWorkspaceIds].map((workspaceId) => this.options.herdr.listPanes(workspaceId)))).flat();
    for (const pane of panes) {
      if (pane.stateChangeSeq !== null && pane.stateChangeSeq !== undefined) {
        this.observedAgentStates.set(pane.paneId, { terminalId: pane.terminalId ?? null, sequence: pane.stateChangeSeq, state: pane.agentState });
      }
      this.observedTabIds.set(pane.paneId, pane.tabId ?? null);
    }
  }

  async reconcile(workspaceIds?: readonly string[]): Promise<void> {
    if (this.stopping) return;
    if (this.reconciliation) { this.coalescedRequestCount += 1; return this.reconciliation; }
    this.enqueueReconciliation(workspaceIds);
    const work = this.drainReconciliations();
    this.reconciliation = work;
    try { await work; }
    finally { if (this.reconciliation === work) this.reconciliation = null; }
  }

  async requestReconciliation(workspaceIds?: readonly string[]): Promise<void> {
    if (this.stopping) return;
    if (this.reconciliation && this.activeReconciliationCovers(workspaceIds)) {
      this.coalescedRequestCount += 1;
      return this.reconciliation;
    }
    if (!this.reconciliation && this.recentReconciliationCovers(workspaceIds)) {
      this.coalescedRequestCount += 1;
      return;
    }
    this.enqueueReconciliation(workspaceIds);
    if (this.reconciliation) { this.coalescedRequestCount += 1; return this.reconciliation; }
    const work = this.drainReconciliations();
    this.reconciliation = work;
    try { await work; }
    finally { if (this.reconciliation === work) this.reconciliation = null; }
  }

  async requestPaneReconciliation(paneIds: readonly string[]): Promise<void> {
    if (this.stopping) return;
    if (this.reconciliation) await this.reconciliation;
    await this.options.externalTurnObserver?.stop();
    for (const paneId of [...new Set(paneIds)]) {
      const existing = this.options.store.findBindingByPane(paneId);
      if (!existing || (existing.state !== "active" && existing.state !== "orphaned")) continue;
      try {
        const observation = await this.options.herdr.observeRuntime(paneId);
        if (!observation.pane) { await this.orphanMissingPane(existing); continue; }
        await this.convergeExistingBinding(existing, observation.pane);
      } catch (error) {
        this.options.logger.warn({ event: "pane-reconciliation-failed", err: safeLogError(error), workspaceId: existing.workspaceId, paneId, outcome: "deferred" }, "failed to reconcile one Herdr pane");
      }
    }
  }

  private enqueueReconciliation(workspaceIds?: readonly string[]): void {
    if (workspaceIds === undefined || this.pendingReconciliation === null) { this.pendingReconciliation = null; return; }
    this.pendingReconciliation ??= new Set<string>();
    for (const workspaceId of workspaceIds) this.pendingReconciliation.add(workspaceId);
  }

  private activeReconciliationCovers(workspaceIds?: readonly string[]): boolean {
    if (this.activeReconciliation === undefined) return false;
    if (this.activeReconciliation === null) return true;
    if (workspaceIds === undefined) return false;
    return workspaceIds.every((workspaceId) => this.activeReconciliation!.has(workspaceId));
  }

  private recentReconciliationCovers(workspaceIds?: readonly string[]): boolean {
    const cutoff = performance.now() - EVENT_RECONCILIATION_COOLDOWN_MS;
    const requested = workspaceIds ?? [...this.configuredWorkspaceIds];
    return requested.length > 0 && requested.every((workspaceId) => (this.lastReconciledAt.get(workspaceId) ?? -Infinity) >= cutoff);
  }

  private async drainReconciliations(): Promise<void> {
    while (this.pendingReconciliation !== undefined && !this.stopping) {
      const requested = this.pendingReconciliation;
      this.pendingReconciliation = undefined;
      this.activeReconciliation = requested;
      try { await this.runMeasured(requested === null ? undefined : requested); }
      finally { this.activeReconciliation = undefined; }
    }
  }

  snapshot(): ReconciliationDiagnostics {
    return {
      state: this.stopping ? "stopping" : this.reconciliation ? "running" : "idle",
      runCount: this.runCount, successCount: this.successCount, failureCount: this.failureCount, coalescedRequestCount: this.coalescedRequestCount,
      lastStartedAt: this.lastStartedAt, lastCompletedAt: this.lastCompletedAt, lastDurationMs: this.lastDurationMs, maxDurationMs: this.maxDurationMs, lastOutcome: this.lastOutcome
    };
  }

  private async runMeasured(requestedWorkspaceIds?: ReadonlySet<string>): Promise<void> {
    const started = performance.now();
    this.runCount += 1;
    this.lastStartedAt = new Date().toISOString();
    try {
      const reconciledWorkspaceIds = await this.reconcileOnce(requestedWorkspaceIds);
      const completedAt = performance.now();
      for (const workspaceId of reconciledWorkspaceIds) this.lastReconciledAt.set(workspaceId, completedAt);
      this.successCount += 1;
      this.lastOutcome = "succeeded";
    } catch (error) {
      this.failureCount += 1;
      this.lastOutcome = "failed";
      throw error;
    } finally {
      const duration = Math.max(0, Math.round(performance.now() - started));
      this.lastDurationMs = duration;
      this.maxDurationMs = Math.max(this.maxDurationMs ?? 0, duration);
      this.lastCompletedAt = new Date().toISOString();
    }
  }

  start(intervalMs: number): void {
    if (this.stopping || this.timer) return;
    this.timer = setInterval(() => {
      void this.reconcile().catch((error) => this.options.logger.error({ event: "reconciliation-failed", err: safeLogError(error), outcome: "failed" }, "reconciliation failed"));
    }, intervalMs);
    this.timer.unref();
  }

  async stop(): Promise<void> {
    this.stopping = true;
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    if (this.reconciliation) await this.reconciliation;
  }

  private async reconcileOnce(requestedWorkspaceIds?: ReadonlySet<string>): Promise<ReadonlySet<string>> {
    const allActiveBindings = this.options.store.listBindingsByState("active");
    const orphanedBindings = this.options.store.listBindingsByState("orphaned");
    const panesByWorkspace = new Map<string, HerdrPane[]>();
    const reconciliationWorkspaceIds = new Set(this.configuredWorkspaceIds);
    for (const binding of [...allActiveBindings, ...orphanedBindings]) reconciliationWorkspaceIds.add(binding.workspaceId);
    const workspaceIds = requestedWorkspaceIds
      ? [...requestedWorkspaceIds].filter((workspaceId) => reconciliationWorkspaceIds.has(workspaceId))
      : [...reconciliationWorkspaceIds];
    if (this.options.herdr.listAllPanes) {
      try {
        const requested = new Set(workspaceIds);
        const snapshot = await this.options.herdr.listAllPanes();
        for (const workspaceId of workspaceIds) panesByWorkspace.set(workspaceId, []);
        for (const pane of snapshot) if (requested.has(pane.workspaceId)) panesByWorkspace.get(pane.workspaceId)!.push(pane);
      } catch (error) {
        this.options.logger.warn({ event: "herdr-snapshot-fallback", err: safeLogError(error), workspaceIds, outcome: "fallback" }, "Herdr snapshot unavailable; falling back to workspace pane discovery");
        await this.loadWorkspacePanes(workspaceIds, panesByWorkspace);
      }
    } else await this.loadWorkspacePanes(workspaceIds, panesByWorkspace);

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
            ? await this.orphanMissingPane(binding, `Herdr workspace ${binding.workspaceId} remained unavailable`)
            : this.options.store.transitionBinding(binding.id, { type: "pane_probe_failed", confirmedMissing: false, orphanThreshold: 2 });
          continue;
        }
        if (binding.paneId && !paneIdsByWorkspace.get(binding.workspaceId)!.has(binding.paneId)) await this.orphanMissingPane(binding);
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
        const projects = this.projectsByWorkspaceAndCwd.get(workspaceCwdKey(pane.workspaceId, pane.cwd)) ?? [];
        if (projects.length !== 1) {
          const reason = projects.length === 0 ? "unregistered" : "ambiguous";
          const signature = `${reason}:${projects.map((project) => project.id).sort().join(",")}`;
          nextSkippedPaneReasons.set(pane.paneId, signature);
          if (this.skippedPaneReasons.get(pane.paneId) !== signature) this.options.logger.warn({ event: "herdr-pane-skipped", workspaceId: pane.workspaceId, paneId: pane.paneId, matchingProjects: projects.map((project) => project.id), reason }, "skipping unregistered or ambiguous Herdr pane");
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
        const interruptedProvisioning = interruptedProvisioningByProjectId.get(projects[0]!.id);
        if (interruptedProvisioning) {
          const signature = `provisioning:${interruptedProvisioning.id}`;
          nextSkippedPaneReasons.set(pane.paneId, signature);
          if (this.skippedPaneReasons.get(pane.paneId) !== signature) this.options.logger.warn({ event: "herdr-pane-skipped", workspaceId: pane.workspaceId, paneId: pane.paneId, projectId: projects[0]!.id, bindingId: interruptedProvisioning.id, reason: "ambiguous_interrupted_provisioning" }, "leaving pane unclaimed until interrupted provisioning is resolved explicitly");
          continue;
        }
        if (this.skippedPaneReasons.has(pane.paneId)) this.options.logger.info({ event: "herdr-pane-skip-resolved", workspaceId: pane.workspaceId, paneId: pane.paneId, projectId: projects[0]!.id, outcome: "registered" }, "previously skipped Herdr pane now matches a project");
        existing = await this.options.discoverPane(pane, projects[0]!);
        bindingByPaneId.set(pane.paneId, existing);
        continue;
      }
      await this.convergeExistingBinding(existing, pane);
      } catch (error) {
        this.options.logger.warn({ event: "pane-reconciliation-failed", err: safeLogError(error), workspaceId: requestedWorkspaceId, paneId: snapshotPane.paneId, outcome: "deferred" }, "failed to reconcile one Herdr pane");
      }
    }
    if (requestedWorkspaceIds === undefined && panesByWorkspace.size === reconciliationWorkspaceIds.size) {
      const livePaneIds = new Set([...panesByWorkspace.values()].flatMap((panes) => panes.map((pane) => pane.paneId)));
      pruneMissingPaneObservations(this.observedAgentStates, livePaneIds);
      pruneMissingPaneObservations(this.observedTabIds, livePaneIds);
      pruneMissingPaneObservations(this.observedWorktreeNames, livePaneIds);
    }
    this.skippedPaneReasons = nextSkippedPaneReasons;
    return new Set(workspaceIds);
  }

  private async convergeExistingBinding(initial: Binding, initialPane: HerdrPane): Promise<void> {
    let existing = initial;
    let pane = initialPane;
    if (!isTraexCompatiblePane(pane)) return;
    if (!existing.projectId) {
      const projects = this.projectsByWorkspaceAndCwd.get(workspaceCwdKey(pane.workspaceId, pane.cwd)) ?? [];
      if (projects.length === 1) existing = this.options.store.updateBindingMetadata(existing.id, { projectId: projects[0]!.id });
    }
    if (existing.lifecycle === "provisioning") return;
    const previous = existing.lastAgentState;
    if (existing.attachment === "orphaned") {
      const recovered = await this.recoverOrphanedBinding(existing, pane);
      if (!recovered) return;
      existing = recovered;
    }
    if (isConfirmedUnregisteredTraexAgent(pane)) { await this.degradeUnregisteredAgent(existing, pane); return; }
    pane = this.withMonotonicAgentState(pane);
    const observation = this.options.store.applyRuntimeObservation({ bindingId: existing.id, expectedPaneId: pane.paneId, expectedGeneration: existing.generation, pane });
    if (observation.outcome === "stale_binding") return;
    if (observation.outcome === "terminal_identity_changed") { await this.orphanMissingPane(existing, `Herdr pane ${pane.paneId} terminal identity changed`); return; }
    existing = observation.binding;
    existing = await this.convergeBindingTitle(existing, pane);
    if (observation.terminalIdentityRefreshed) this.options.logger.info({ event: "binding-terminal-identity-refreshed", bindingId: existing.id, paneId: pane.paneId, outcome: "native_session_matched" }, "accepted new terminal identity for restored native Agent session");
    if (observation.nativeSessionMismatch) this.options.logger.warn({ event: "binding-agent-session-mismatch", bindingId: existing.id, paneId: pane.paneId, outcome: "preserved_persisted_identity" }, "Herdr reported a different native Agent session for the existing terminal identity");
    if (existing.state !== "active") return;
    const tabId = pane.tabId ?? null;
    const priorTabId = this.observedTabIds.get(pane.paneId);
    const worktreeName = await this.options.worktreeNameFor?.(pane.foregroundCwd ?? pane.cwd) ?? null;
    const priorWorktreeName = this.observedWorktreeNames.get(pane.paneId);
    const tabChanged = (tabId !== null && priorTabId !== tabId) || (tabId === null && priorTabId !== undefined && priorTabId !== null);
    const worktreeChanged = (worktreeName !== null && priorWorktreeName !== worktreeName) || (worktreeName === null && priorWorktreeName !== undefined && priorWorktreeName !== null);
    this.observedTabIds.set(pane.paneId, tabId);
    this.observedWorktreeNames.set(pane.paneId, worktreeName);
    if (tabChanged || worktreeChanged) await this.publish(existing.id, "PaneOutputObserved", { ...(tabChanged ? { tabId } : {}), ...(worktreeChanged ? { worktreeName } : {}) });
    await this.options.externalTurnObserver?.observe(existing);
    if (this.options.isBindingBusy(existing.id)) return;
    if (previous !== pane.agentState) {
      const queueDepth = this.options.store.countPendingPrompts(existing.id);
      await this.publish(existing.id, "AgentStateChanged", { state: pane.agentState, queueDepth });
      this.options.scheduler.wake({ kind: "binding-runtime-changed", bindingId: existing.id });
      if ((previous === "blocked" || previous === "unknown") && (pane.agentState === "idle" || pane.agentState === "done") && queueDepth > 0) this.options.scheduler.wake({ kind: "prompt-ready", bindingId: existing.id });
    }
  }

  private withMonotonicAgentState(pane: HerdrPane): HerdrPane {
    const sequence = pane.stateChangeSeq;
    if (sequence === null || sequence === undefined) return pane;
    const terminalId = pane.terminalId ?? null;
    const previous = this.observedAgentStates.get(pane.paneId);
    if (previous && previous.terminalId === terminalId && sequence <= previous.sequence) {
      return { ...pane, agentState: previous.state };
    }
    this.observedAgentStates.set(pane.paneId, { terminalId, sequence, state: pane.agentState });
    return pane;
  }

  private async loadWorkspacePanes(workspaceIds: readonly string[], panesByWorkspace: Map<string, HerdrPane[]>): Promise<void> {
    await Promise.all(workspaceIds.map(async (workspaceId) => {
      try {
        panesByWorkspace.set(workspaceId, await this.options.herdr.listPanes(workspaceId));
        const recovery = this.workspaceFailureLogs.recover(workspaceId);
        if (recovery) this.options.logger.info({ event: "workspace-reconciliation-recovered", workspaceId, ...recovery, outcome: "recovered" }, "workspace reconciliation recovered");
      }
      catch (error) {
        const safe = safeLogError(error);
        const decision = this.workspaceFailureLogs.fail(workspaceId, safe.message);
        if (decision.kind !== "suppressed") this.options.logger.warn({ event: decision.kind === "summary" ? "workspace-reconciliation-failure-summary" : "workspace-reconciliation-failed", err: safe, workspaceId, repeatCount: decision.count, firstFailureAt: decision.firstFailureAt, outcome: "failed" }, "workspace reconciliation failed");
      }
    }));
  }

  private async orphanMissingPane(binding: Binding, reason = `Herdr pane ${binding.paneId} no longer exists`): Promise<Binding> {
    const occurredAt = new Date().toISOString();
    const current = this.options.store.loadTopicView(binding.id) ?? initialTopicView(binding.id);
    const event = createBridgeEvent(binding.id, "BindingOrphaned", "herdr", { reason });
    const view = reduceTopicView(current, event);
    const result = this.options.store.orphanBindingWithProjection({
      bindingId: binding.id, expectedPaneId: binding.paneId!, expectedGeneration: binding.generation, occurredAt, reason,
      view, rootMessageId: binding.rootMessageId, mainCard: renderProjectEntryCard(view), renderRunCard: renderRequestAnswerCard
    });
    if (result.outcome === "orphaned") {
      if (result.outboxReserved) this.options.wakeOutbound?.();
      await this.publish(binding.id, "BindingOrphaned", { reason });
      for (const promptId of result.updatedPromptIds) {
        try { await this.options.convergeAnswer?.(promptId); }
        catch (error) {
          this.options.logger.warn({ event: "orphan-answer-convergence-failed", err: safeLogError(error), bindingId: binding.id, promptId, outcome: "deferred" }, "failed to converge an orphaned prompt Answer");
        }
      }
    }
    return result.binding ?? binding;
  }

  private async recoverOrphanedBinding(binding: Binding, pane: HerdrPane): Promise<Binding | null> {
    const current = this.options.store.loadTopicView(binding.id) ?? {
      ...initialTopicView(binding.id), title: binding.title, workspaceId: binding.workspaceId,
      spaceName: binding.projectId ? projectSpaceName(this.projectsById.get(binding.projectId)!) : binding.workspaceId, paneId: binding.paneId
    };
    const event = createBridgeEvent(binding.id, "BindingActivated", "herdr", { paneId: pane.paneId, tabId: pane.tabId ?? null, topicId: binding.topicId ?? "unknown" });
    const view = reduceTopicView(current, event);
    const result = this.options.store.recoverOrphanBindingWithProjection({
      bindingId: binding.id, expectedPaneId: pane.paneId, expectedGeneration: binding.generation, pane, view,
      rootMessageId: binding.rootMessageId, mainCard: renderProjectEntryCard(view)
    });
    if (result.outcome !== "recovered" || !result.binding) {
      this.options.logger.warn({
        event: "binding-orphan-recovery-skipped", bindingId: binding.id, workspaceId: binding.workspaceId, paneId: pane.paneId,
        outcome: result.outcome, reason: "runtime_identity_not_proven"
      }, "kept orphaned binding because the live runtime identity did not match");
      return null;
    }
    if (result.outboxReserved) this.options.wakeOutbound?.();
    await this.options.lifecycleEvents.publish(event);
    this.options.logger.info({
      event: "binding-orphan-recovered", bindingId: binding.id, workspaceId: binding.workspaceId, paneId: pane.paneId, outcome: "recovered"
    }, "restored an orphaned binding from unchanged authoritative runtime identity");
    return result.binding;
  }

  private async degradeUnregisteredAgent(binding: Binding, pane: HerdrPane): Promise<Binding> {
    const reason = `TraeX is running in Herdr pane ${pane.paneId}, but it is not registered as a Herdr Agent. 请由会话创建者发送 \`/swarm reset\` 创建可投递的新会话。`;
    const current = this.options.store.loadTopicView(binding.id) ?? {
      ...initialTopicView(binding.id), title: binding.title, workspaceId: binding.workspaceId,
      spaceName: binding.projectId ? projectSpaceName(this.projectsById.get(binding.projectId)!) : binding.workspaceId, paneId: pane.paneId
    };
    const event = createBridgeEvent(binding.id, "BindingDegraded", "herdr", { reason });
    const view = reduceTopicView(current, event);
    const result = this.options.store.degradeBindingWithProjection({
      bindingId: binding.id, expectedPaneId: pane.paneId, expectedGeneration: binding.generation, view,
      rootMessageId: binding.rootMessageId, mainCard: renderProjectEntryCard(view)
    });
    if (result.outcome === "degraded") {
      if (result.outboxReserved) this.options.wakeOutbound?.();
      await this.options.lifecycleEvents.publish(event);
      this.options.logger.warn({ event: "binding-runtime-degraded", bindingId: binding.id, workspaceId: pane.workspaceId, paneId: pane.paneId, reason: "agent_unregistered", outcome: "degraded" }, "TraeX pane is not registered as a Herdr Agent");
    }
    return result.binding ?? binding;
  }

  private async convergeBindingTitle(binding: Binding, pane: HerdrPane): Promise<Binding> {
    const paneLabel = pane.label?.trim();
    const project = binding.projectId ? this.projectsById.get(binding.projectId) : undefined;
    if (!paneLabel || !project) return binding;
    const title = formatProjectPaneTitle(projectSpaceName(project), pane.cwd, paneLabel, pane.paneId);
    if (title === binding.title) return binding;
    const event = createBridgeEvent(binding.id, "BindingRenamed", "herdr", { title });
    const current = this.options.store.loadTopicView(binding.id) ?? {
      ...initialTopicView(binding.id), title: binding.title, workspaceId: binding.workspaceId, spaceName: projectSpaceName(project), paneId: binding.paneId, phase: "ready"
    };
    const view = reduceTopicView(current, event);
    const result = this.options.store.reconcileBindingTitleWithProjection({
      bindingId: binding.id, expectedPaneId: pane.paneId, expectedGeneration: binding.generation, title, view,
      rootMessageId: binding.rootMessageId, card: renderProjectEntryCard(view)
    });
    if (result.outcome !== "projected" || !result.binding) return binding;
    if (result.outboxReserved) this.options.wakeOutbound?.();
    await this.options.lifecycleEvents.publish(event);
    return result.binding;
  }

  private async publish<T extends BridgeEvent["type"]>(bindingId: string, type: T, payload: BridgeEventOf<T>["payload"]): Promise<void> {
    await this.options.lifecycleEvents.publish(createBridgeEvent<T>(bindingId, type, "herdr", payload));
  }
}

function workspaceCwdKey(workspaceId: string, cwd: string | null): string {
  return `${workspaceId}\u0000${cwd ?? ""}`;
}

function pruneMissingPaneObservations<Value>(observations: Map<string, Value>, livePaneIds: ReadonlySet<string>): void {
  for (const paneId of observations.keys()) if (!livePaneIds.has(paneId)) observations.delete(paneId);
}

function isConfirmedUnregisteredTraexAgent(pane: HerdrPane): boolean {
  return pane.agentKind === null && pane.foregroundExecutables.includes("traex");
}

function isTraexCompatiblePane(pane: HerdrPane): boolean {
  return pane.foregroundExecutables.includes("traex")
    || pane.agentKind === "traex" || pane.agentKind === "codex" || pane.agentKind === "claude" || pane.agentKind === "pi";
}
