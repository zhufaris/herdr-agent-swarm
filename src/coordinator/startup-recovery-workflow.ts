import type { Logger } from "pino";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import type { GatewayIngressPort, GatewayIngressSink } from "../gateways/contract/plugin.js";
import type { StartupRecoveryStore } from "../domain/ports/workflow.js";
import type { StartupRecoveryDiagnostics } from "../domain/types.js";
import type { InboundWorkNotifier } from "../events/inbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { BindingProvisioningWorkflowPort } from "./binding-provisioning-workflow.js";
import type { CardActionRouterPort } from "./card-action-router.js";
import type { HerdrRuntimeReconcilerPort } from "./herdr-runtime-reconciler.js";
import type { InboundMessageDispatcherPort } from "./inbound-message-dispatcher.js";
import type { InboundMessageRoutingWorkflowPort } from "./inbound-message-routing-workflow.js";
import type { PaneClosureWorkflowPort } from "./pane-closure-workflow.js";
import type { PaneControlWorkflowPort } from "./pane-control-workflow.js";
import type { PromptRunWorkflowPort } from "./prompt-run-workflow.js";
import type { RetiredPaneCleanupWorkflowPort } from "./retired-pane-cleanup-workflow.js";
import type { SessionOperationWorkflowPort } from "./session-operation-workflow.js";
import type { StartupViewConvergerPort } from "./startup-view-converger.js";
import type { SwarmCommandGatewayPort } from "./swarm-command-gateway.js";
import { StartupViewRecovery } from "./startup-view-recovery.js";

export interface StartupRecoveryWorkflowPort {
  prepareDelivery(): Promise<void>;
  recoverRuntime(): Promise<void>;
  start(): Promise<void>;
  stop(): Promise<void>;
  snapshot(): StartupRecoveryDiagnostics;
}

export interface StartupRecoveryWorkflowOptions {
  config: BridgeConfig; store: StartupRecoveryStore; herdr: { assertWorkspace(workspaceId: string, expectedSpaceName?: string): Promise<void> }; gatewayIngress: GatewayIngressPort; gatewaySink: GatewayIngressSink; logger: Logger; scheduler: PromptWorkScheduler; inboundWork: InboundWorkNotifier;
  promptRun: PromptRunWorkflowPort; provisioning: BindingProvisioningWorkflowPort; paneControl: PaneControlWorkflowPort; paneClosure: PaneClosureWorkflowPort; reconciler: HerdrRuntimeReconcilerPort; retiredPaneCleanup: RetiredPaneCleanupWorkflowPort; startupViews: StartupViewConvergerPort; sessionOperations: SessionOperationWorkflowPort; swarmCommands: Pick<SwarmCommandGatewayPort, "recover">; inboundDispatcher: InboundMessageDispatcherPort; cardActionRouter: CardActionRouterPort; messageRouting: InboundMessageRoutingWorkflowPort;
}

/** Coordinates the ordered, degradable recovery sequence before accepting Lark work. */
export class StartupRecoveryWorkflow implements StartupRecoveryWorkflowPort {
  private stopInboundSubscription: (() => void) | null = null;
  private stopControlSubscription: (() => void) | null = null;
  private prepareDeliveryPromise: Promise<void> | null = null;
  private runtimeRecoveryPromise: Promise<void> | null = null;
  private runtimeRecoveryPrepared = false;
  private readonly startupViewRecovery: StartupViewRecovery;
  private diagnostics: StartupRecoveryDiagnostics = { state: "idle", startedAt: null, completedAt: null, stages: [] };

  constructor(private readonly options: StartupRecoveryWorkflowOptions) {
    this.startupViewRecovery = new StartupViewRecovery({
      convergeAll: () => options.startupViews.converge(),
      convergeBindings: (bindingIds) => options.startupViews.convergeBindings(bindingIds)
    });
  }

  prepareDelivery(): Promise<void> {
    this.prepareDeliveryPromise ??= this.performPrepareDelivery();
    return this.prepareDeliveryPromise;
  }

  recoverRuntime(): Promise<void> {
    this.runtimeRecoveryPromise ??= this.performRuntimeRecovery().then(
      () => { this.runtimeRecoveryPrepared = true; },
      (error: unknown) => { this.runtimeRecoveryPromise = null; throw error; }
    );
    return this.runtimeRecoveryPromise;
  }

  async start(): Promise<void> {
    const { config, gatewayIngress, gatewaySink, promptRun, reconciler, provisioning, retiredPaneCleanup, inboundWork, inboundDispatcher } = this.options;
    await this.prepareDelivery();
    if (this.runtimeRecoveryPrepared) this.runtimeRecoveryPrepared = false;
    else { this.runtimeRecoveryPromise = null; await this.recoverRuntime(); this.runtimeRecoveryPrepared = false; }
    promptRun.start(); this.options.sessionOperations.start(config.reconcileIntervalMs); reconciler.start(config.reconcileIntervalMs); retiredPaneCleanup.start(config.reconcileIntervalMs);
    this.stopInboundSubscription = inboundWork.subscribe((event) => this.options.messageRouting.handle(event.payload));
    await gatewayIngress.start(gatewaySink);
    await this.runStage("provisioning", () => provisioning.recover());
    await this.runStage("initial-project-prompts", () => this.recoverInitialProjectPrompts());
    inboundDispatcher.start(); await inboundDispatcher.drain();
    this.diagnostics = { ...this.diagnostics, state: this.diagnostics.stages.some((stage) => stage.state === "failed") ? "degraded" : "completed", completedAt: new Date().toISOString() };
  }

  private async performRuntimeRecovery(): Promise<void> {
    const { config, herdr, logger, reconciler, paneControl, retiredPaneCleanup, inboundDispatcher } = this.options;
    this.startupViewRecovery.start();
    const recoveredInbound = inboundDispatcher.recoverProcessingMessages();
    if (recoveredInbound > 0) logger.warn({ event: "startup-inbound-recovered", recovered: recoveredInbound, outcome: "requeued" }, "returned interrupted inbound messages to acceptance queue");
    const workspaceAssertions = new Map<string, { workspaceId: string; spaceName: string; explicitSpaceName: boolean }>();
    for (const project of config.projects) {
      const spaceName = projectSpaceName(project);
      const existing = workspaceAssertions.get(project.workspaceId);
      if (!existing || !existing.explicitSpaceName && Boolean(project.spaceName)) workspaceAssertions.set(project.workspaceId, { workspaceId: project.workspaceId, spaceName, explicitSpaceName: Boolean(project.spaceName) });
    }
    await Promise.all([...workspaceAssertions.values()].map(({ workspaceId, spaceName }) => herdr.assertWorkspace(workspaceId, spaceName)));
    await this.runStage("runtime-baselines", () => reconciler.captureBaselines());
    this.stopControlSubscription = this.options.scheduler.subscribe((event) => {
      if (event.kind === "control-ready") void paneControl.drainPaneControls(event.bindingId).catch((error) => logger.error({ event: "pane-control-drain-failed", err: safeLogError(error), bindingId: event.bindingId, outcome: "deferred" }, "pane control drain failed"));
    });
    await this.runStage("pane-controls", () => Promise.all([paneControl.recover(), this.options.paneClosure.recover()]).then(() => undefined));
    await this.runStage("session-operations", () => this.options.sessionOperations.recover());
    await this.runStage("swarm-commands", () => this.options.swarmCommands.recover());
    await this.runStage("retired-pane-cleanup", () => retiredPaneCleanup.recover());
    await this.runStage("runtime-reconciliation", () => reconciler.reconcile());
  }

  async stop(): Promise<void> {
    this.stopInboundSubscription?.(); this.stopInboundSubscription = null;
    this.stopControlSubscription?.(); this.stopControlSubscription = null;
    await this.startupViewRecovery.stop();
  }

  snapshot(): StartupRecoveryDiagnostics {
    const startupViews = this.startupViewRecovery.snapshot();
    const viewRecoveryPending = startupViews.pendingCount > 0 || startupViews.fullRescanPending;
    const viewRecovered = startupViews.retryCount > 0 && !viewRecoveryPending && startupViews.lastFailure === null;
    const stages = this.diagnostics.stages.map((stage) => viewRecovered && stage.name === "view-convergence"
      ? { name: stage.name, state: "completed" as const, durationMs: stage.durationMs }
      : { ...stage });
    const state = viewRecoveryPending || stages.some((stage) => stage.state === "failed") ? "degraded" : this.diagnostics.state === "running" ? "running" : "completed";
    return { ...this.diagnostics, state, stages, startupViews };
  }

  private async performPrepareDelivery(): Promise<void> {
    const { store, logger, promptRun, startupViews } = this.options;
    this.diagnostics = { state: "running", startedAt: new Date().toISOString(), completedAt: null, stages: [] };
    promptRun.prepareRecovery();
    const recoveredLegacyCards = store.recoverLegacyElementIdDeadLetters();
    if (recoveredLegacyCards > 0) logger.warn({ event: "startup-legacy-answer-cards-recovered", recovered: recoveredLegacyCards, outcome: "requeued" }, "requeued answer cards rejected for the legacy element id format");
    let failedBindingIds: readonly string[] = [];
    const converged = await this.runStage("view-convergence", async () => { failedBindingIds = await startupViews.converge(); });
    if (converged) this.startupViewRecovery.add(failedBindingIds);
    else this.startupViewRecovery.requestFullRescan();
  }

  private async recoverInitialProjectPrompts(): Promise<void> {
    for (const selection of this.options.store.listCompletedProjectSelectionsWithInitialPrompt()) {
      if (!selection.bindingId) continue;
      const binding = this.options.store.getBinding(selection.bindingId);
      if (binding) await this.options.messageRouting.enqueueInitialProjectPrompt(binding, selection);
    }
  }

  private async runStage(stage: string, operation: () => Promise<void>): Promise<boolean> {
    const startedAt = Date.now();
    try {
      await operation(); this.diagnostics.stages.push({ name: stage, state: "completed", durationMs: Date.now() - startedAt });
      this.options.logger.info({ event: "startup-recovery-stage-completed", stage, durationMs: Date.now() - startedAt, outcome: "completed" }, "startup recovery stage completed");
      return true;
    } catch (error) {
      this.diagnostics.stages.push({ name: stage, state: "failed", durationMs: Date.now() - startedAt, error: errorMessage(error).slice(0, 500) });
      this.options.logger.warn({ event: "startup-recovery-stage-failed", stage, durationMs: Date.now() - startedAt, err: safeLogError(error), outcome: "deferred" }, "startup recovery stage failed; periodic convergence will retry durable work");
      return false;
    }
  }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
