import type { Logger } from "pino";
import { applyMonotonicAgentState, isConfirmedUnregisteredTraexAgent, type ObservedAgentState } from "../domain/binding-runtime-convergence-policy.js";
import { createBridgeEvent, type BridgeEventOf } from "../domain/create-bridge-event.js";
import type { BridgeEvent } from "../domain/events.js";
import type { RuntimeReconciliationStore } from "../domain/ports/binding.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import { initialTopicView, reduceTopicView } from "../domain/topic-view.js";
import type { Binding, HerdrPane, ProjectConfig } from "../domain/types.js";
import { formatProjectPaneTitle } from "../domain/thread-title.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import { ProjectCatalog } from "./project-catalog.js";
import { isNativeTraexSession } from "../domain/traex-session-identity.js";
import { decideRuntimeIdentityReconciliation } from "./pane-runtime-identity.js";

export class BindingRuntimeConverger {
  private readonly observedAgentStates = new Map<string, ObservedAgentState>();
  private readonly observedTabIds = new Map<string, string | null>();
  private readonly observedWorktreeNames = new Map<string, string | null>();
  private readonly observedWorkspaces = new Map<string, string | null>();
  private readonly observedBranches = new Map<string, string | null>();
  private readonly projects: ProjectCatalog;

  constructor(private readonly options: {
    projects: readonly ProjectConfig[]; store: RuntimeReconciliationStore; lifecycleEvents: LifecycleEventPublisher;
    wakeOutbound?: () => void; convergeAnswer?(promptId: string): Promise<void>; logger: Logger; scheduler: PromptWorkScheduler;
    isBindingBusy(bindingId: string): boolean; worktreeNameFor?(cwd: string | null | undefined): Promise<string | null>; branchFor?(cwd: string | null | undefined): Promise<string | null>; externalTurnObserver?: { observe(binding: Binding): Promise<void> };
    presentation: Pick<PrimaryPresentation, "mainCard" | "paneEntryCard" | "answerCard">;
  }) {
    this.projects = new ProjectCatalog(options.projects);
  }

  captureBaseline(pane: HerdrPane): void {
    if (pane.stateChangeSeq !== null && pane.stateChangeSeq !== undefined) this.observedAgentStates.set(pane.paneId, { terminalId: pane.terminalId ?? null, sequence: pane.stateChangeSeq, state: pane.agentState });
    this.observedTabIds.set(pane.paneId, pane.tabId ?? null);
  }

  prune(livePaneIds: ReadonlySet<string>): void {
    pruneMissingPaneObservations(this.observedAgentStates, livePaneIds);
    pruneMissingPaneObservations(this.observedTabIds, livePaneIds);
    pruneMissingPaneObservations(this.observedWorktreeNames, livePaneIds);
    pruneMissingPaneObservations(this.observedWorkspaces, livePaneIds);
    pruneMissingPaneObservations(this.observedBranches, livePaneIds);
  }

  async converge(initial: Binding, initialPane: HerdrPane): Promise<void> {
    let existing = initial; let pane = initialPane;
    if (existing.lifecycle !== "active" && existing.lifecycle !== "draining") return;
    if (!existing.projectId) { const project = this.projects.projectForWorkspaceAndCwd(pane.workspaceId, pane.cwd); if (project) existing = this.options.store.updateBindingMetadata(existing.id, { projectId: project.id }); }
    if (existing.lifecycle === "provisioning") return;
    const previous = existing.lastAgentState; const previousPaneToken = existing.paneToken;
    if (existing.agentKind === "traex" && isConfirmedUnregisteredTraexAgent(pane)) { await this.degrade(existing, pane); return; }
    pane = this.withMonotonicAgentState(pane);
    const hadExactNativeSession = hasExactNativeSession(existing);
    const recovery = existing.attachment === "orphaned" ? this.recoveryProjection(existing, pane) : undefined;
    const observation = this.options.store.reconcileRuntimeIdentity({ bindingId: existing.id, expectedPaneId: pane.paneId, expectedGeneration: existing.generation, expectedSessionEpoch: existing.sessionEpoch, pane, decide: decideRuntimeIdentityReconciliation, ...(recovery ? { recovery } : {}) });
    if (observation.outcome === "stale" || observation.outcome === "conflict") return;
    if (observation.outcome === "session_rotation_pending") {
      this.options.logger.debug({ event: "binding-session-rotation-pending", bindingId: existing.id, paneId: pane.paneId, outcome: observation.outcome }, "preserved Binding identity while the durable Orchestrator clear operation awaits its rotation receipt");
      return;
    }
    if (observation.outcome === "unchanged_refusal") return;
    if (observation.outcome === "refused") {
      this.options.logger.warn({ event: "binding-runtime-identity-refused", bindingId: existing.id, paneId: pane.paneId, reason: observation.reason, outcome: observation.outcome }, "kept Binding identity because the live runtime identity was not safe to reconcile");
      return;
    }
    if (!("binding" in observation)) return;
    if (observation.outcome === "recovered") {
      if (observation.outboxReserved) this.options.wakeOutbound?.();
      await this.options.lifecycleEvents.publish(observation.event);
      this.options.logger.info({ event: "binding-orphan-recovered", bindingId: existing.id, workspaceId: existing.workspaceId, paneId: pane.paneId, outcome: "recovered" }, "restored an orphaned binding from unchanged authoritative runtime identity");
    }
    existing = await this.rename(observation.binding, pane);
    if (observation.outcome === "terminal_refreshed") this.options.logger.info({ event: "binding-terminal-identity-refreshed", bindingId: existing.id, paneId: pane.paneId, outcome: "native_session_matched" }, "accepted new terminal identity for restored native Agent session");
    if (existing.state !== "active") return;
    const exactNativeSessionAdopted = observation.outcome === "adopted" || (existing.agentKind === "traex" && !hadExactNativeSession && hasExactNativeSession(existing));
    const tabId = pane.tabId ?? null; const priorTabId = this.observedTabIds.get(pane.paneId);
    const paneName = pane.paneName?.trim() || null; const priorPaneName = this.options.store.loadTopicView(existing.id)?.paneName ?? null;
    const identityCwd = pane.foregroundCwd ?? pane.cwd;
    const workspace = identityCwd ?? null;
    const branch = await this.options.branchFor?.(identityCwd) ?? null;
    const worktreeName = await this.options.worktreeNameFor?.(identityCwd) ?? null;
    const priorWorktreeName = this.observedWorktreeNames.get(pane.paneId); const priorWorkspace = this.observedWorkspaces.get(pane.paneId); const priorBranch = this.observedBranches.get(pane.paneId);
    const tabChanged = (tabId !== null && priorTabId !== tabId) || (tabId === null && priorTabId !== undefined && priorTabId !== null);
    const worktreeChanged = (worktreeName !== null && priorWorktreeName !== worktreeName) || (worktreeName === null && priorWorktreeName !== undefined && priorWorktreeName !== null);
    const workspaceChanged = (workspace !== null && priorWorkspace !== workspace) || (workspace === null && priorWorkspace !== undefined && priorWorkspace !== null);
    const branchChanged = (branch !== null && priorBranch !== branch) || (branch === null && priorBranch !== undefined && priorBranch !== null);
    const paneTokenChanged = Boolean(pane.paneToken && pane.paneToken !== previousPaneToken);
    const paneNameChanged = Boolean(paneName && paneName !== priorPaneName);
    this.observedTabIds.set(pane.paneId, tabId); this.observedWorktreeNames.set(pane.paneId, worktreeName); this.observedWorkspaces.set(pane.paneId, workspace); this.observedBranches.set(pane.paneId, branch);
    if (paneTokenChanged) {
      const updatedPromptIds = this.options.store.backfillRunCardPaneToken({ bindingId: existing.id, expectedGeneration: existing.generation, paneToken: pane.paneToken!, occurredAt: new Date().toISOString() });
      for (const promptId of updatedPromptIds) await this.options.convergeAnswer?.(promptId);
    }
    if (tabChanged || workspaceChanged || worktreeChanged || branchChanged || paneTokenChanged || paneNameChanged) await this.publish(existing.id, "PaneOutputObserved", { ...(tabChanged ? { tabId } : {}), ...(workspaceChanged ? { workspace } : {}), ...(paneTokenChanged ? { paneToken: pane.paneToken } : {}), ...(paneNameChanged ? { paneName } : {}), ...(worktreeChanged ? { worktreeName } : {}), ...(branchChanged ? { branch } : {}) });
    if (existing.agentKind === "traex") await this.options.externalTurnObserver?.observe(existing);
    if (this.options.isBindingBusy(existing.id)) return;
    const agentStateChanged = previous !== pane.agentState;
    if (agentStateChanged || exactNativeSessionAdopted) {
      const queueDepth = this.options.store.countPendingPrompts(existing.id);
      if (agentStateChanged) await this.publish(existing.id, "AgentStateChanged", { state: pane.agentState, queueDepth });
      this.options.scheduler.wake({ kind: "binding-runtime-changed", bindingId: existing.id });
      const becameSettled = (previous === "blocked" || previous === "unknown") && (pane.agentState === "idle" || pane.agentState === "done");
      const adoptedWhileSettled = exactNativeSessionAdopted && (pane.agentState === "idle" || pane.agentState === "done");
      if ((becameSettled || adoptedWhileSettled) && queueDepth > 0) this.options.scheduler.wake({ kind: "prompt-ready", bindingId: existing.id });
    }
  }

  async orphan(binding: Binding, reason = `Herdr pane ${binding.paneId} no longer exists`): Promise<Binding> {
    const current = this.options.store.loadTopicView(binding.id) ?? initialTopicView(binding.id); const event = createBridgeEvent(binding.id, "BindingOrphaned", "herdr", { reason }); const view = reduceTopicView(current, event);
    const result = this.options.store.orphanBindingWithProjection({ bindingId: binding.id, expectedPaneId: binding.paneId!, expectedGeneration: binding.generation, occurredAt: new Date().toISOString(), reason, view, rootMessageId: binding.rootMessageId, mainCard: this.options.presentation.mainCard(view), paneEntryCard: this.options.presentation.paneEntryCard(view), renderRunCard: this.options.presentation.answerCard });
    if (result.outcome === "orphaned") { if (result.outboxReserved) this.options.wakeOutbound?.(); await this.publish(binding.id, "BindingOrphaned", { reason }); for (const promptId of result.updatedPromptIds) try { await this.options.convergeAnswer?.(promptId); } catch (error) { this.options.logger.warn({ event: "orphan-answer-convergence-failed", err: safeLogError(error), bindingId: binding.id, promptId, outcome: "deferred" }, "failed to converge an orphaned prompt Answer"); } }
    return result.binding ?? binding;
  }

  private withMonotonicAgentState(pane: HerdrPane): HerdrPane { const result = applyMonotonicAgentState(pane, this.observedAgentStates.get(pane.paneId)); if (result.observation) this.observedAgentStates.set(pane.paneId, result.observation); return result.pane; }
  private recoveryProjection(binding: Binding, pane: HerdrPane) {
    const current = this.options.store.loadTopicView(binding.id) ?? { ...initialTopicView(binding.id), title: binding.title, workspaceId: binding.workspaceId, spaceName: this.projects.spaceNameForBinding(binding), paneId: binding.paneId, paneToken: binding.paneToken };
    const event = createBridgeEvent(binding.id, "BindingActivated", "herdr", { paneId: pane.paneId, paneToken: pane.paneToken ?? binding.paneToken, paneName: pane.paneName ?? null, tabId: pane.tabId ?? null, topicId: binding.topicId ?? "unknown" }); const view = reduceTopicView(current, event);
    return { event, view, rootMessageId: binding.rootMessageId, mainCard: this.options.presentation.mainCard(view), paneEntryCard: this.options.presentation.paneEntryCard(view) };
  }
  private async degrade(binding: Binding, pane: HerdrPane): Promise<Binding> {
    const reason = `TraeX is running in Herdr pane ${pane.paneId}, but it is not registered as a Herdr Agent. 请由会话创建者发送 \`/swarm reset\` 创建可投递的新会话。`;
    const current = this.options.store.loadTopicView(binding.id) ?? { ...initialTopicView(binding.id), title: binding.title, workspaceId: binding.workspaceId, spaceName: this.projects.spaceNameForBinding(binding), paneId: pane.paneId }; const event = createBridgeEvent(binding.id, "BindingDegraded", "herdr", { reason }); const view = reduceTopicView(current, event);
    const result = this.options.store.degradeBindingWithProjection({ bindingId: binding.id, expectedPaneId: pane.paneId, expectedGeneration: binding.generation, view, rootMessageId: binding.rootMessageId, mainCard: this.options.presentation.mainCard(view), paneEntryCard: this.options.presentation.paneEntryCard(view) });
    if (result.outcome === "degraded") { if (result.outboxReserved) this.options.wakeOutbound?.(); await this.options.lifecycleEvents.publish(event); this.options.logger.warn({ event: "binding-runtime-degraded", bindingId: binding.id, workspaceId: pane.workspaceId, paneId: pane.paneId, reason: "agent_unregistered", outcome: "degraded" }, "TraeX pane is not registered as a Herdr Agent"); } return result.binding ?? binding;
  }
  private async rename(binding: Binding, pane: HerdrPane): Promise<Binding> {
    const paneLabel = pane.label?.trim(); const project = binding.projectId ? this.projects.projectById(binding.projectId) : undefined; if (!paneLabel || !project) return binding; const spaceName = this.projects.spaceNameForBinding(binding); const title = formatProjectPaneTitle(spaceName, pane.cwd, paneLabel, pane.paneId); if (title === binding.title) return binding;
    const event = createBridgeEvent(binding.id, "BindingRenamed", "herdr", { title }); const current = this.options.store.loadTopicView(binding.id) ?? { ...initialTopicView(binding.id), title: binding.title, workspaceId: binding.workspaceId, spaceName, paneId: binding.paneId, phase: "ready" }; const view = reduceTopicView(current, event);
    const result = this.options.store.reconcileBindingTitleWithProjection({ bindingId: binding.id, expectedPaneId: pane.paneId, expectedGeneration: binding.generation, title, view, rootMessageId: binding.rootMessageId, card: this.options.presentation.mainCard(view), paneEntryCard: this.options.presentation.paneEntryCard(view) }); if (result.outcome !== "projected" || !result.binding) return binding; if (result.outboxReserved) this.options.wakeOutbound?.(); await this.options.lifecycleEvents.publish(event); return result.binding;
  }
  private async publish<T extends BridgeEvent["type"]>(bindingId: string, type: T, payload: BridgeEventOf<T>["payload"]): Promise<void> { await this.options.lifecycleEvents.publish(createBridgeEvent<T>(bindingId, type, "herdr", payload)); }
}

function pruneMissingPaneObservations<Value>(observations: Map<string, Value>, livePaneIds: ReadonlySet<string>): void { for (const paneId of observations.keys()) if (!livePaneIds.has(paneId)) observations.delete(paneId); }
function hasExactNativeSession(binding: Binding): boolean {
  if (!binding.agentSessionSource || !binding.agentSessionAgent || !binding.agentSessionKind || !binding.agentSessionValue) return false;
  return isNativeTraexSession({ source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue });
}
