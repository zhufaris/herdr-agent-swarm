import type { Logger } from "pino";
import { renderRequestAnswerCard } from "../cards/run-card.js";
import { createBridgeEvent, type BridgeEventOf } from "../domain/create-bridge-event.js";
import type { BridgeEvent } from "../domain/events.js";
import type { ProjectConfig, Binding, HerdrPane } from "../domain/types.js";
import type { HerdrPort, RuntimeReconciliationStore } from "../domain/ports.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { cleanTerminalOutput, extractNewOutput, outputFingerprint } from "../runtime/output.js";
import { safeLogError } from "../runtime/safe-error.js";
import { extractFinalTraexAnswer, parseTerminalStreamDelta } from "../runtime/traex-output-parser.js";

interface HerdrRuntimeReconcilerOptions {
  projects: readonly ProjectConfig[];
  store: RuntimeReconciliationStore;
  herdr: HerdrPort;
  lifecycleEvents: LifecycleEventPublisher;
  channelPublisher: {
    enqueueRunCardUpdate(bindingId: string, promptId: string, messageId: string, viewVersion: number, cardRole: "answer", card: object): Promise<void>;
  };
  logger: Logger;
  discoverPane(pane: HerdrPane, project: ProjectConfig): Promise<Binding>;
  scheduler: PromptWorkScheduler;
  isBindingBusy(bindingId: string): boolean;
}

const BASELINE_READ_CONCURRENCY = 4;

export interface HerdrRuntimeReconcilerPort {
  captureBaselines(): Promise<void>;
  reconcile(workspaceIds?: readonly string[]): Promise<void>;
  requestReconciliation(workspaceIds?: readonly string[]): Promise<void>;
  start(intervalMs: number): void;
  stop(): Promise<void>;
}

export class HerdrRuntimeReconciler implements HerdrRuntimeReconcilerPort {
  private reconciliation: Promise<void> | null = null;
  private pendingReconciliation: Set<string> | null | undefined;
  private stopping = false;
  private timer: NodeJS.Timeout | null = null;
  private readonly observedTerminalOutputs = new Map<string, string>();
  private readonly observedOutputRevisions = new Map<string, number>();
  private readonly observedAgentStates = new Map<string, { terminalId: string | null; sequence: number; state: HerdrPane["agentState"] }>();
  private skippedPaneReasons = new Map<string, string>();

  constructor(private readonly options: HerdrRuntimeReconcilerOptions) {}

  async captureBaselines(): Promise<void> {
    const bindings = this.options.store.listBindingsByState("active").filter((item) => item.paneId);
    await forEachConcurrent(bindings, BASELINE_READ_CONCURRENCY, async (binding) => {
      try {
        const output = cleanTerminalOutput(await this.options.herdr.readOutput(binding.paneId!, 240));
        this.observedTerminalOutputs.set(binding.paneId!, output);
        if (output) this.options.store.updateBinding(binding.id, { lastOutputFingerprint: outputFingerprint(output) });
        if (output && !this.options.isBindingBusy(binding.id)) await this.publishTerminalTelemetry(binding, output);
      } catch (error) {
        const next = this.options.store.transitionBinding(binding.id, { type: "pane_probe_failed", confirmedMissing: isPaneMissing(error), orphanThreshold: 2 });
        if (next.attachment === "orphaned") await this.publish(binding.id, "BindingOrphaned", { reason: `Unable to read Herdr pane ${binding.paneId}: ${errorMessage(error)}` });
        this.options.logger.warn({ event: "binding-pane-probe-failed", err: safeLogError(error), bindingId: binding.id, workspaceId: binding.workspaceId, paneId: binding.paneId, degradationCount: next.degradationCount, outcome: next.attachment }, "failed to observe Herdr pane during startup");
      }
    });
  }

  async reconcile(workspaceIds?: readonly string[]): Promise<void> {
    if (this.stopping) return;
    if (this.reconciliation) return this.reconciliation;
    this.enqueueReconciliation(workspaceIds);
    const work = this.drainReconciliations();
    this.reconciliation = work;
    try { await work; }
    finally { if (this.reconciliation === work) this.reconciliation = null; }
  }

  async requestReconciliation(workspaceIds?: readonly string[]): Promise<void> {
    if (this.stopping) return;
    this.enqueueReconciliation(workspaceIds);
    if (this.reconciliation) return this.reconciliation;
    const work = this.drainReconciliations();
    this.reconciliation = work;
    try { await work; }
    finally { if (this.reconciliation === work) this.reconciliation = null; }
  }

  private enqueueReconciliation(workspaceIds?: readonly string[]): void {
    if (workspaceIds === undefined || this.pendingReconciliation === null) { this.pendingReconciliation = null; return; }
    this.pendingReconciliation ??= new Set<string>();
    for (const workspaceId of workspaceIds) this.pendingReconciliation.add(workspaceId);
  }

  private async drainReconciliations(): Promise<void> {
    while (this.pendingReconciliation !== undefined && !this.stopping) {
      const requested = this.pendingReconciliation;
      this.pendingReconciliation = undefined;
      await this.reconcileOnce(requested === null ? undefined : requested);
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

  private async reconcileOnce(requestedWorkspaceIds?: ReadonlySet<string>): Promise<void> {
    const panesByWorkspace = new Map<string, HerdrPane[]>();
    const configuredWorkspaceIds = new Set(this.options.projects.map((project) => project.workspaceId));
    const workspaceIds = requestedWorkspaceIds
      ? [...requestedWorkspaceIds].filter((workspaceId) => configuredWorkspaceIds.has(workspaceId))
      : [...configuredWorkspaceIds];
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

    const allActiveBindings = this.options.store.listBindingsByState("active");
    const activeBindings = requestedWorkspaceIds
      ? allActiveBindings.filter((binding) => requestedWorkspaceIds.has(binding.workspaceId))
      : allActiveBindings;
    const bindingByPaneId = new Map(activeBindings.flatMap((binding) => binding.paneId ? [[binding.paneId, binding] as const] : []));
    let pendingBindings: Binding[] | null = null;
    for (const binding of activeBindings) {
      const workspacePanes = panesByWorkspace.get(binding.workspaceId);
      if (!workspacePanes) {
        const next = this.options.store.transitionBinding(binding.id, { type: "pane_probe_failed", confirmedMissing: false, orphanThreshold: 2 });
        this.options.logger.warn({ event: "binding-pane-probe-failed", bindingId: binding.id, workspaceId: binding.workspaceId, paneId: binding.paneId, degradationCount: next.degradationCount, outcome: next.attachment, reason: "workspace_unavailable" }, "could not observe binding because its workspace was unavailable");
        if (next.attachment === "orphaned") await this.publish(binding.id, "BindingOrphaned", { reason: `Herdr workspace ${binding.workspaceId} remained unavailable` });
        continue;
      }
      const paneIds = new Set(workspacePanes.map((pane) => pane.paneId));
      if (binding.paneId && !paneIds.has(binding.paneId)) await this.orphanMissingPane(binding);
    }

    const nextSkippedPaneReasons = requestedWorkspaceIds ? new Map(this.skippedPaneReasons) : new Map<string, string>();
    for (const [requestedWorkspaceId, panes] of panesByWorkspace) for (const snapshotPane of panes) {
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
      if (!pane.foregroundExecutables.includes("traex")) continue;
      if (!existing) {
        const projects = this.options.projects.filter((project) => project.workspaceId === pane.workspaceId && project.cwd === pane.cwd);
        if (projects.length !== 1) {
          const reason = projects.length === 0 ? "unregistered" : "ambiguous";
          const signature = `${reason}:${projects.map((project) => project.id).sort().join(",")}`;
          nextSkippedPaneReasons.set(pane.paneId, signature);
          if (this.skippedPaneReasons.get(pane.paneId) !== signature) this.options.logger.warn({ event: "herdr-pane-skipped", workspaceId: pane.workspaceId, paneId: pane.paneId, matchingProjects: projects.map((project) => project.id), reason }, "skipping unregistered or ambiguous Herdr pane");
          continue;
        }
        pendingBindings ??= this.options.store.listBindingsByState("pending");
        const interruptedProvisioning = pendingBindings.find((candidate) => candidate.lifecycle === "provisioning" && candidate.provisioningCheckpoint === "selected" && candidate.projectId === projects[0]!.id);
        if (interruptedProvisioning) {
          const signature = `provisioning:${interruptedProvisioning.id}`;
          nextSkippedPaneReasons.set(pane.paneId, signature);
          if (this.skippedPaneReasons.get(pane.paneId) !== signature) this.options.logger.warn({ event: "herdr-pane-skipped", workspaceId: pane.workspaceId, paneId: pane.paneId, projectId: projects[0]!.id, bindingId: interruptedProvisioning.id, reason: "ambiguous_interrupted_provisioning" }, "leaving pane unclaimed until interrupted provisioning is resolved explicitly");
          continue;
        }
        if (this.skippedPaneReasons.has(pane.paneId)) this.options.logger.info({ event: "herdr-pane-skip-resolved", workspaceId: pane.workspaceId, paneId: pane.paneId, projectId: projects[0]!.id, outcome: "registered" }, "previously skipped Herdr pane now matches a project");
        existing = await this.options.discoverPane(pane, projects[0]!);
        bindingByPaneId.set(pane.paneId, existing);
        const output = cleanTerminalOutput(await this.options.herdr.readOutput(pane.paneId, 240));
        this.observedTerminalOutputs.set(pane.paneId, output);
        if (pane.outputRevision !== null && pane.outputRevision !== undefined) this.observedOutputRevisions.set(pane.paneId, pane.outputRevision);
        continue;
      }
      if (!existing.projectId) {
        const projects = this.options.projects.filter((project) => project.workspaceId === pane.workspaceId && project.cwd === pane.cwd);
        if (projects.length === 1) existing = this.options.store.updateBinding(existing.id, { projectId: projects[0]!.id });
      }
      if (existing.lifecycle === "provisioning") continue;
      pane = this.withMonotonicAgentState(pane);
      const previous = existing.lastAgentState;
      if (existing.traexSessionId && pane.terminalId && existing.traexSessionId !== pane.terminalId) {
        if (sameNativeAgentSession(existing, pane)) {
          existing = this.options.store.updateBinding(existing.id, { traexSessionId: pane.terminalId, ...nativeAgentSessionPatch(pane) });
          this.options.logger.info({ event: "binding-terminal-identity-refreshed", bindingId: existing.id, paneId: pane.paneId, outcome: "native_session_matched" }, "accepted new terminal identity for restored native Agent session");
        } else {
          this.options.store.transitionBinding(existing.id, { type: "pane_probe_failed", confirmedMissing: true, orphanThreshold: 2 });
          await this.publish(existing.id, "BindingOrphaned", { reason: `Herdr pane ${pane.paneId} terminal identity changed` });
          continue;
        }
      }
      if (pane.agentSession && !hasNativeAgentSession(existing)) {
        existing = this.options.store.updateBinding(existing.id, nativeAgentSessionPatch(pane));
      } else if (pane.agentSession && !sameNativeAgentSession(existing, pane)) {
        this.options.logger.warn({
          event: "binding-agent-session-mismatch", bindingId: existing.id, paneId: pane.paneId, outcome: "preserved_persisted_identity"
        }, "Herdr reported a different native Agent session for the existing terminal identity");
      }
      if (existing.attachment !== "orphaned" && (existing.lifecycle === "active" || existing.lifecycle === "draining")) this.options.store.transitionBinding(existing.id, { type: "pane_observed", runtime: pane.agentState });
      if (existing.state !== "active" || this.options.isBindingBusy(existing.id)) continue;
      if (previous !== pane.agentState) {
        const queueDepth = this.options.store.countPendingPrompts(existing.id);
        this.options.store.updateBinding(existing.id, { lastAgentState: pane.agentState });
        await this.publish(existing.id, "AgentStateChanged", { state: pane.agentState, queueDepth });
        this.options.scheduler.wake({ kind: "binding-runtime-changed", bindingId: existing.id });
        if ((previous === "blocked" || previous === "unknown") && (pane.agentState === "idle" || pane.agentState === "done") && queueDepth > 0) this.options.scheduler.wake({ kind: "prompt-ready", bindingId: existing.id });
      }
      // Snapshot revisions describe pane metadata, not terminal content, for
      // unstructured panes. Keep reading those bounded outputs and let the
      // output fingerprint suppress unchanged projections.
      if (pane.agentState !== "unknown" && pane.outputRevision !== null && pane.outputRevision !== undefined && this.observedOutputRevisions.get(pane.paneId) === pane.outputRevision) continue;
      await this.publishChangedLocalOutput(existing, pane.paneId);
      if (pane.outputRevision !== null && pane.outputRevision !== undefined) this.observedOutputRevisions.set(pane.paneId, pane.outputRevision);
    }
    this.skippedPaneReasons = nextSkippedPaneReasons;
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
      try { panesByWorkspace.set(workspaceId, await this.options.herdr.listPanes(workspaceId)); }
      catch (error) {
        this.options.logger.error({ event: "workspace-reconciliation-failed", err: safeLogError(error), workspaceId, outcome: "failed" }, "workspace reconciliation failed");
      }
    }));
  }

  private async orphanMissingPane(binding: Binding): Promise<void> {
    this.options.store.transitionBinding(binding.id, { type: "pane_probe_failed", confirmedMissing: true, orphanThreshold: 2 });
    const occurredAt = new Date().toISOString();
    for (const view of this.options.store.listRunCardsByPhases(binding.id, ["running", "blocked", "queued"])) {
      const terminal = view.phase === "running" || view.phase === "blocked";
      const next = terminal
        ? { ...view, phase: "failed" as const, notice: `Herdr pane ${binding.paneId} no longer exists`, finishedAt: occurredAt, queuePosition: 0, viewVersion: view.viewVersion + 1, updatedAt: occurredAt }
        : { ...view, phase: "blocked" as const, notice: `Herdr pane ${binding.paneId} no longer exists，请恢复绑定后重试。`, viewVersion: view.viewVersion + 1, updatedAt: occurredAt };
      this.options.store.saveRunCard(next);
      if (!next.answerCardId && next.answerMessageId) await this.options.channelPublisher.enqueueRunCardUpdate(next.bindingId, next.promptId, next.answerMessageId, next.viewVersion, "answer", renderRequestAnswerCard(next));
    }
    await this.publish(binding.id, "BindingOrphaned", { reason: `Herdr pane ${binding.paneId} no longer exists` });
  }

  private async publishChangedLocalOutput(binding: Binding, paneId: string): Promise<void> {
    const output = cleanTerminalOutput(await this.options.herdr.readOutput(paneId, 240));
    if (!output) return;
    const previous = this.observedTerminalOutputs.get(paneId) ?? "";
    this.observedTerminalOutputs.set(paneId, output);
    const fingerprint = outputFingerprint(output);
    const completedAnswerFingerprint = outputFingerprint(extractFinalTraexAnswer(output));
    if (!this.options.isBindingBusy(binding.id)) await this.publishTerminalTelemetry(binding, output, fingerprint);
    if (fingerprint === binding.lastOutputFingerprint || completedAnswerFingerprint === binding.lastOutputFingerprint) return;
    this.options.store.updateBinding(binding.id, { lastOutputFingerprint: fingerprint });
    const answer = extractTraexAnswer(extractNewOutput(previous, output));
    if (answer) await this.publish(binding.id, "TurnCompleted", { promptId: `local:${fingerprint.slice(0, 16)}`, answer, queueDepth: this.options.store.countPendingPrompts(binding.id) });
  }

  private async publishTerminalTelemetry(binding: Binding, output: string, fingerprint = outputFingerprint(output)): Promise<void> {
    const telemetry = parseTerminalStreamDelta("", output, "");
    if (!telemetry.model && !telemetry.context) return;
    await this.publish(binding.id, "TurnOutputObserved", {
      promptId: `local:${fingerprint.slice(0, 16)}`, answerSnapshot: "", progressEvents: [],
      ...(telemetry.model ? { model: telemetry.model } : {}),
      ...(telemetry.context ? { context: telemetry.context } : {})
    });
  }

  private async publish<T extends BridgeEvent["type"]>(bindingId: string, type: T, payload: BridgeEventOf<T>["payload"]): Promise<void> {
    await this.options.lifecycleEvents.publish(createBridgeEvent<T>(bindingId, type, "herdr", payload));
  }
}

async function forEachConcurrent<T>(items: readonly T[], limit: number, operation: (item: T) => Promise<void>): Promise<void> {
  let next = 0;
  const worker = async () => {
    while (next < items.length) {
      const item = items[next++];
      if (item !== undefined) await operation(item);
    }
  };
  await Promise.all(Array.from({ length: Math.min(limit, items.length) }, worker));
}

function sameNativeAgentSession(binding: Binding, pane: HerdrPane): boolean {
  return Boolean(
    binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue && pane.agentSession &&
    binding.agentSessionSource === pane.agentSession.source && binding.agentSessionAgent === pane.agentSession.agent &&
    binding.agentSessionKind === pane.agentSession.kind && binding.agentSessionValue === pane.agentSession.value
  );
}
function hasNativeAgentSession(binding: Binding): boolean {
  return Boolean(binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue);
}
function nativeAgentSessionPatch(pane: HerdrPane): Pick<Binding, "agentSessionSource" | "agentSessionAgent" | "agentSessionKind" | "agentSessionValue"> {
  return {
    agentSessionSource: pane.agentSession?.source ?? null, agentSessionAgent: pane.agentSession?.agent ?? null,
    agentSessionKind: pane.agentSession?.kind ?? null, agentSessionValue: pane.agentSession?.value ?? null
  };
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function isPaneMissing(error: unknown): boolean { return /(?:pane|agent).*(?:not found|does not exist)|agent_not_found/i.test(errorMessage(error)); }
function extractTraexAnswer(output: string): string | null {
  const marker = /^\s*◆\s+/m.exec(output);
  if (!marker || marker.index === undefined) return null;
  const answer = output.slice(marker.index + marker[0].length).split(/\n\s*─{3,}/)[0]?.trim() ?? "";
  return answer || null;
}
