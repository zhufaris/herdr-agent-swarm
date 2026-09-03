import type { LarkPort } from "../domain/ports/external.js";
import type { InboundDispatcherDiagnostics, IncomingLarkCardAction, IncomingLarkMessage, StartupRecoveryDiagnostics } from "../domain/types.js";
import type { ShutdownContext } from "../runtime/shutdown-context.js";
import type { CardActionRouterPort } from "./card-action-router.js";
import type { HerdrRuntimeReconcilerPort } from "./herdr-runtime-reconciler.js";
import type { InboundMessageDispatcherPort } from "./inbound-message-dispatcher.js";
import type { ModelSelectionWorkflowPort } from "./model-selection-workflow.js";
import type { PromptRunWorkflowPort } from "./prompt-run-workflow.js";
import type { RetiredPaneCleanupWorkflowPort } from "./retired-pane-cleanup-workflow.js";
import type { SessionOperationWorkflowPort } from "./session-operation-workflow.js";
import type { StartupRecoveryWorkflowPort } from "./startup-recovery-workflow.js";

export interface InboundRouterPort {
  start(): Promise<void>;
  stop(context?: ShutdownContext): Promise<void>;
  handleMessage(message: IncomingLarkMessage): Promise<void>;
  handleCardAction(action: IncomingLarkCardAction): Promise<import("../domain/types.js").LarkCardActionResult | void>;
  snapshot(): StartupRecoveryDiagnostics;
  inboundSnapshot(): InboundDispatcherDiagnostics;
}

export interface InboundRouterOptions {
  lark: Pick<LarkPort, "stop">; modelSelection: ModelSelectionWorkflowPort; promptRun: PromptRunWorkflowPort; reconciler: HerdrRuntimeReconcilerPort; retiredPaneCleanup: RetiredPaneCleanupWorkflowPort; sessionOperations: SessionOperationWorkflowPort; inboundDispatcher: InboundMessageDispatcherPort; cardActionRouter: CardActionRouterPort; startupRecovery: StartupRecoveryWorkflowPort;
}

export class InboundRouter implements InboundRouterPort {
  constructor(private readonly options: InboundRouterOptions) {}

  async start(): Promise<void> {
    await this.options.startupRecovery.start();
  }

  snapshot(): StartupRecoveryDiagnostics { return this.options.startupRecovery.snapshot(); }
  inboundSnapshot(): InboundDispatcherDiagnostics { return this.options.inboundDispatcher.snapshot(); }
  reconcileHerdrWorkspaces(workspaceIds?: readonly string[]): Promise<void> { return this.options.reconciler.requestReconciliation(workspaceIds); }
  async reconcile(): Promise<void> { await Promise.all([this.options.reconciler.reconcile(), this.options.retiredPaneCleanup.requestScan()]); }
  async handleMessage(message: IncomingLarkMessage): Promise<void> { await this.options.inboundDispatcher.handleMessage(message); }
  async handleCardAction(action: IncomingLarkCardAction): Promise<import("../domain/types.js").LarkCardActionResult | void> { return this.options.cardActionRouter.handle(action); }

  async stop(context?: ShutdownContext): Promise<void> {
    await this.options.startupRecovery.stop(); this.options.modelSelection.shutdown();
    await Promise.allSettled([this.options.lark.stop(), this.options.retiredPaneCleanup.stop(), this.options.reconciler.stop(), this.options.promptRun.stop(context), this.options.sessionOperations.stop(), this.options.inboundDispatcher.stop(), this.options.cardActionRouter.stop()]);
  }
}
