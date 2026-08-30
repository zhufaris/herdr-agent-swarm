import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderDisconnectedTopicCard, renderHelpCard, renderMessageRejectedCard, renderRequestAnswerCard } from "../cards/run-card.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import { deriveTopicTitle, parseCommand, parseInstanceCommand } from "../domain/commands.js";
import { classifyContinuation } from "../domain/continuation-classifier.js";
import { createBridgeEvent, type BridgeEventOf } from "../domain/create-bridge-event.js";
import type { BridgeEvent } from "../domain/events.js";
import type { InboundStore, InstanceStore, LarkPort, OutboundIntentPort, PromptAcceptanceStore } from "../domain/ports.js";
import { createQueuedRunCard } from "../domain/run-card-view.js";
import type { Binding, EventOrigin, IncomingLarkCardAction, IncomingLarkMessage, ProjectSelection, StartupRecoveryDiagnostics } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { InboundWorkNotifier } from "../events/inbound-work-notifier.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { ShutdownContext } from "../runtime/shutdown-context.js";
import type { BindingProvisioningWorkflowPort } from "./binding-provisioning-workflow.js";
import type { CardInteractionWorkflowPort } from "./card-interaction-workflow.js";
import type { HerdrRuntimeReconcilerPort } from "./herdr-runtime-reconciler.js";
import type { ModelSelectionWorkflowPort } from "./model-selection-workflow.js";
import type { PaneControlWorkflowPort } from "./pane-control-workflow.js";
import type { OperationsQueryWorkflowPort } from "./operations-query-workflow.js";
import type { SessionAdministrationWorkflowPort } from "./session-administration-workflow.js";
import type { DeliveryRecoveryWorkflowPort } from "./delivery-recovery-workflow.js";
import type { PaneClosureWorkflowPort } from "./pane-closure-workflow.js";
import type { PromptRunWorkflowPort } from "./prompt-run-workflow.js";
import type { RetiredPaneCleanupWorkflowPort } from "./retired-pane-cleanup-workflow.js";
import type { StartupViewConvergerPort } from "./startup-view-converger.js";
import type { InstanceInteractionWorkflow } from "./instance-interaction-workflow.js";

export interface InboundRouterPort {
  start(): Promise<void>;
  stop(context?: ShutdownContext): Promise<void>;
  handleMessage(message: IncomingLarkMessage): Promise<void>;
  handleCardAction(action: IncomingLarkCardAction): Promise<import("../domain/types.js").LarkCardActionResult | void>;
  snapshot(): StartupRecoveryDiagnostics;
}

type InboundRouterStore = InboundStore & PromptAcceptanceStore & InstanceStore;
export interface InboundRouterOptions {
  config: BridgeConfig;
  store: InboundRouterStore;
  herdr: { assertWorkspace(workspaceId: string, expectedSpaceName?: string): Promise<void> };
  lark: Pick<LarkPort, "start" | "stop">;
  lifecycleEvents: LifecycleEventPublisher;
  outbound: OutboundIntentPort;
  outboundWork: OutboundWorkNotifier;
  logger: Logger;
  scheduler: PromptWorkScheduler;
  inboundWork: InboundWorkNotifier;
  promptRun: PromptRunWorkflowPort;
  provisioning: BindingProvisioningWorkflowPort;
  cardInteractions: CardInteractionWorkflowPort;
  modelSelection: ModelSelectionWorkflowPort;
  paneControl: PaneControlWorkflowPort;
  operationsQuery: OperationsQueryWorkflowPort;
  sessionAdministration: SessionAdministrationWorkflowPort;
  deliveryRecovery: DeliveryRecoveryWorkflowPort;
  paneClosure: PaneClosureWorkflowPort;
  reconciler: HerdrRuntimeReconcilerPort;
  retiredPaneCleanup: RetiredPaneCleanupWorkflowPort;
  startupViews: StartupViewConvergerPort;
  instanceInteractions?: InstanceInteractionWorkflow;
}

export class InboundRouter implements InboundRouterPort {
  private inboundDrain: Promise<void> | null = null;
  private readonly cardActionTasks = new Set<Promise<void>>();
  private stopInboundSubscription: (() => void) | null = null;
  private stopControlSubscription: (() => void) | null = null;
  private readonly projectsById: Map<string, BridgeConfig["projects"][number]>;
  private readonly uniqueProjectByWorkspace: Map<string, BridgeConfig["projects"][number] | null>;
  private startupRecovery: StartupRecoveryDiagnostics = { state: "idle", startedAt: null, completedAt: null, stages: [] };

  constructor(private readonly options: InboundRouterOptions) {
    this.projectsById = new Map(options.config.projects.map((project) => [project.id, project]));
    this.uniqueProjectByWorkspace = uniqueProjectsByWorkspace(options.config.projects);
  }

  async start(): Promise<void> {
    const { config, store, herdr, lark, logger, promptRun, reconciler, paneControl, provisioning, retiredPaneCleanup, inboundWork, startupViews } = this.options;
    this.startupRecovery = { state: "running", startedAt: new Date().toISOString(), completedAt: null, stages: [] };
    promptRun.prepareRecovery();
    const recoveredLegacyCards = store.recoverLegacyElementIdDeadLetters();
    if (recoveredLegacyCards > 0) logger.warn({ event: "startup-legacy-answer-cards-recovered", recovered: recoveredLegacyCards, outcome: "requeued" }, "requeued answer cards rejected for the legacy element id format");
    await this.runStartupStage("view-convergence", () => startupViews.converge());
    const recoveredInbound = store.recoverProcessingInboundMessages();
    if (recoveredInbound > 0) logger.warn({ event: "startup-inbound-recovered", recovered: recoveredInbound, outcome: "requeued" }, "returned interrupted inbound messages to acceptance queue");
    await Promise.all(config.projects.map((project) => herdr.assertWorkspace(project.workspaceId, projectSpaceName(project))));
    await this.runStartupStage("runtime-baselines", () => reconciler.captureBaselines());
    this.stopControlSubscription = this.options.scheduler.subscribe((event) => {
      if (event.kind === "control-ready") void this.options.paneControl.drainPaneControls(event.bindingId).catch((error) => this.options.logger.error({ event: "pane-control-drain-failed", err: safeLogError(error), bindingId: event.bindingId, outcome: "deferred" }, "pane control drain failed"));
    });
    await this.runStartupStage("pane-controls", () => Promise.all([paneControl.recover(), this.options.paneClosure.recover()]).then(() => undefined));
    await this.runStartupStage("retired-pane-cleanup", () => retiredPaneCleanup.recover());
    await this.runStartupStage("runtime-reconciliation", () => reconciler.reconcile());
    promptRun.start();
    reconciler.start(config.reconcileIntervalMs);
    retiredPaneCleanup.start(config.reconcileIntervalMs);
    this.stopInboundSubscription = inboundWork.subscribe((event) => this.acceptInboundMessage(event.payload));
    await lark.start((message) => this.handleMessage(message), (action) => this.handleCardAction(action));
    await this.runStartupStage("provisioning", () => provisioning.recover());
    await this.runStartupStage("initial-project-prompts", () => this.recoverInitialProjectPrompts());
    await this.drainInboundMessages();
    this.startupRecovery = { ...this.startupRecovery, state: this.startupRecovery.stages.some((stage) => stage.state === "failed") ? "degraded" : "completed", completedAt: new Date().toISOString() };
  }

  snapshot(): StartupRecoveryDiagnostics { return { ...this.startupRecovery, stages: this.startupRecovery.stages.map((stage) => ({ ...stage })) }; }

  private async runStartupStage(stage: string, operation: () => Promise<void>): Promise<void> {
    const startedAt = Date.now();
    try {
      await operation();
      this.startupRecovery.stages.push({ name: stage, state: "completed", durationMs: Date.now() - startedAt });
      this.options.logger.info({ event: "startup-recovery-stage-completed", stage, durationMs: Date.now() - startedAt, outcome: "completed" }, "startup recovery stage completed");
    } catch (error) {
      this.startupRecovery.stages.push({ name: stage, state: "failed", durationMs: Date.now() - startedAt, error: errorMessage(error).slice(0, 500) });
      this.options.logger.warn({ event: "startup-recovery-stage-failed", stage, durationMs: Date.now() - startedAt, err: safeLogError(error), outcome: "deferred" }, "startup recovery stage failed; periodic convergence will retry durable work");
    }
  }

  async stop(context?: ShutdownContext): Promise<void> {
    this.stopInboundSubscription?.();
    this.stopControlSubscription?.();
    this.options.modelSelection.shutdown();
    await Promise.allSettled([
      this.options.lark.stop(), this.options.retiredPaneCleanup.stop(), this.options.reconciler.stop(), this.options.promptRun.stop(context),
      ...(this.inboundDrain ? [this.inboundDrain] : []), ...this.cardActionTasks
    ]);
  }

  reconcileHerdrWorkspaces(workspaceIds?: readonly string[]): Promise<void> { return this.options.reconciler.requestReconciliation(workspaceIds); }
  async reconcile(): Promise<void> { await Promise.all([this.options.reconciler.reconcile(), this.options.retiredPaneCleanup.requestScan()]); }

  async handleMessage(message: IncomingLarkMessage): Promise<void> {
    const { config, logger, store } = this.options;
    if (message.chatId !== config.lark.chatId) { logger.debug({ event: "lark-message-ignored", eventId: message.eventId, messageId: message.messageId, reason: "chat_not_allowed" }, "ignored Lark message"); return; }
    if (store.isBridgeMessage(message.messageId)) { logger.debug({ event: "lark-message-ignored", eventId: message.eventId, messageId: message.messageId, reason: "bridge_message" }, "ignored Lark message"); return; }
    if (!store.recordInboundMessage(message)) { logger.debug({ event: "lark-message-duplicate", eventId: message.eventId, messageId: message.messageId, outcome: "ignored" }, "ignored duplicate Lark message"); return; }
    await this.drainInboundMessages();
  }

  async handleCardAction(action: IncomingLarkCardAction): Promise<import("../domain/types.js").LarkCardActionResult | void> {
    if (action.chatId !== this.options.config.lark.chatId) return;
    const instanceInteraction = await this.options.instanceInteractions?.handleCardAction(action);
    if (instanceInteraction) return instanceInteraction;
    const interaction = await this.options.cardInteractions.handle(action);
    if (interaction) return interaction;
    const model = parseModelSelectionAction(action.value, action.option);
    if (model) {
      if (!this.isCreatorCardAction(action, model.bindingId)) return { toast: { type: "error", content: "只有会话创建者可以切换模型。" } };
      return this.options.modelSelection.selectModel(action, model.bindingId, model.model);
    }
    const mode = parseModelModeSelectionAction(action.value, action.option);
    if (mode) {
      if (!this.isCreatorCardAction(action, mode.bindingId)) return { toast: { type: "error", content: "只有会话创建者可以切换模型。" } };
      return this.options.modelSelection.selectModelMode(action, mode.bindingId, mode.operationId, mode.mode);
    }
    const open = parseOpenThreadAction(action.value);
    if (open) return this.options.deliveryRecovery.openThread(action, open.bindingId);
    const deadLetter = parseDeadLetterAction(action.value);
    if (deadLetter) return this.options.deliveryRecovery.decideDeadLetter(action, deadLetter.replyId, deadLetter.action);
    const paneClaim = parsePaneClaimAction(action.value);
    if (paneClaim) {
      const project = this.projectsById.get(paneClaim.projectId);
      if (!project || project.workspaceId !== paneClaim.workspaceId) return;
      const synthetic: IncomingLarkMessage = { eventId: `claim:${action.messageId}:${paneClaim.paneId}`, messageId: action.messageId, chatId: action.chatId, topicId: null, rootMessageId: action.messageId, actorOpenId: action.operatorOpenId, text: `/swarm attach ${projectSpaceName(project)} ${paneClaim.paneId}`, mentionsBot: true, isRootMessage: true };
      const attached = await this.options.provisioning.attach(synthetic, projectSpaceName(project), paneClaim.paneId);
      this.options.logger.info({ event: "space-pane-claim-decided", projectId: project.id, workspaceId: project.workspaceId, paneId: paneClaim.paneId, outcome: attached ? "attached" : "rejected" }, "processed Space pane claim");
      return;
    }
    const selection = parseProjectAction(action.value);
    if (selection) {
      this.trackCardActionTask(this.options.provisioning.completeSelection(action, selection.selectionId, selection.projectId)
        .then(async (completed) => { if (completed) await this.enqueueInitialProjectPrompt(completed.binding, completed.selection); })
        .catch((error) => this.options.logger.error({ event: "project-selection-background-failed", err: safeLogError(error), selectionId: selection.selectionId, projectId: selection.projectId, outcome: "checkpointed" }, "background project selection failed after the card callback returned")));
      return { toast: { type: "success", content: "项目创建已开始。" } };
    }
  }

  private trackCardActionTask(task: Promise<void>): void {
    this.cardActionTasks.add(task);
    void task.finally(() => this.cardActionTasks.delete(task));
  }

  private async recoverInitialProjectPrompts(): Promise<void> {
    for (const selection of this.options.store.listCompletedProjectSelectionsWithInitialPrompt()) {
      if (!selection.bindingId) continue;
      const binding = this.options.store.getBinding(selection.bindingId);
      if (binding) await this.enqueueInitialProjectPrompt(binding, selection);
    }
  }

  private async enqueueInitialProjectPrompt(binding: Binding, selection: ProjectSelection): Promise<void> {
    if (!selection.initialPromptText) return;
    await this.enqueue(binding, {
      eventId: `project-selection:${selection.id}`, messageId: selection.commandMessageId, chatId: selection.chatId,
      topicId: binding.topicId, rootMessageId: binding.rootMessageId, actorOpenId: selection.actorOpenId,
      text: selection.initialPromptText, mentionsBot: true, isRootMessage: false
    });
  }

  private async drainInboundMessages(): Promise<void> {
    const previous = this.inboundDrain ?? Promise.resolve(); const drain = previous.catch(() => undefined).then(() => this.drainInboundMessagesOnce()); this.inboundDrain = drain;
    try { await drain; } finally { if (this.inboundDrain === drain) this.inboundDrain = null; }
  }

  private async drainInboundMessagesOnce(): Promise<void> {
    for (let message = this.options.store.claimNextInboundMessage(); message; message = this.options.store.claimNextInboundMessage()) {
      try { await this.options.inboundWork.notify({ eventId: message.eventId, type: "InboundMessageReceived", origin: "lark", occurredAt: new Date().toISOString(), payload: message }); this.options.store.markInboundMessageAccepted(message.eventId); }
      catch (error) { this.options.store.releaseInboundMessage(message.eventId, errorMessage(error)); this.options.logger.error({ event: "lark-message-acceptance-failed", err: safeLogError(error), eventId: message.eventId, messageId: message.messageId, outcome: "retry" }, "inbound message acceptance failed; retained for retry"); return; }
    }
  }

  private async acceptInboundMessage(message: IncomingLarkMessage): Promise<void> {
    const instanceCommand = parseInstanceCommand(message.text);
    const command = parseCommand(message.text); const binding = this.options.store.findBindingByLarkScope(message.topicId, message.rootMessageId);
    const decision = instanceCommand ? `instance-command:${instanceCommand.kind}` : command ? `command:${command.kind}` : binding?.state === "active" && binding.lifecycle === "active" ? "prompt" : this.options.store.getConversationTarget(message.chatId) ? "instance-prompt" : message.isRootMessage && message.mentionsBot ? "create_binding" : binding?.state === "archived" ? "archived_feedback" : "unbound_feedback";
    this.options.logger.info({ event: "lark-message-routed", eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, workspaceId: binding?.workspaceId, paneId: binding?.paneId, decision, outcome: "accepted" }, "routed persisted Lark message");
    let disposition: "prompt_queued" | "command_completed" | "user_feedback" | "rejected" = "command_completed";
    try {
      if (instanceCommand) { if (this.options.instanceInteractions) await this.options.instanceInteractions.handleCommand(message, instanceCommand); }
      else if (command?.kind === "help") await this.reply(message.rootMessageId ?? message.messageId, renderHelpCard());
      else if (command?.kind === "stop") disposition = await this.requireCreator(message, binding) && await this.options.paneControl.stop(message, binding) ? "command_completed" : "rejected";
      else if (command?.kind === "steer") disposition = await this.options.paneControl.steer(message, binding, command.text) ? "command_completed" : "rejected";
      else if (command?.kind === "model") disposition = await this.requireCreator(message, binding) && await this.options.modelSelection.runModel(message, binding, command.name) ? "command_completed" : "rejected";
      else if (command?.kind === "reset") disposition = await this.requireCreator(message, binding) && await this.options.provisioning.reset(message, binding, command.title) ? "command_completed" : "rejected";
      else if (command?.kind === "new" || command?.kind === "projects") await this.options.provisioning.selectProject(message, command.kind === "new" ? command.title : null);
      else if (command?.kind === "spaces") await this.options.operationsQuery.listSpaces(message);
      else if (command?.kind === "sessions") await this.options.operationsQuery.listSessions(message);
      else if (command?.kind === "failures") await this.options.operationsQuery.listFailures(message);
      else if (command?.kind === "attach") disposition = await this.options.provisioning.attach(message, command.spaceName, command.paneId) ? "command_completed" : "rejected";
      else if (command?.kind === "status") { if (!binding) { await this.reject(message, "这个话题尚未连接 Herdr。请发送 `/swarm new` 创建项目。"); disposition = "rejected"; } else await this.options.sessionAdministration.emitStatus(binding); }
      else if (command?.kind === "rename") disposition = await this.requireCreator(message, binding) && await this.options.sessionAdministration.rename(message, binding, command.title) ? "command_completed" : "rejected";
      else if (command?.kind === "close") disposition = await this.requireCreator(message, binding) && await this.options.sessionAdministration.archive(message, binding) ? "command_completed" : "rejected";
      else if (command?.kind === "pane_close_request") disposition = await this.requireCreator(message, binding) && await this.options.paneClosure.requestPaneClose(message, binding) ? "command_completed" : "rejected";
      else if (command?.kind === "pane_close_confirm") disposition = await this.requireCreator(message, binding) && await this.options.paneClosure.confirmPaneClose(message, binding, command.code) ? "command_completed" : "rejected";
      else if (command?.kind === "reattach") { if (!await this.requireCreator(message, binding) || !binding || binding.attachment !== "orphaned") { if (binding?.creatorOpenId === message.actorOpenId) await this.reject(message, "当前会话不处于 orphaned 状态，无需重新连接。"); disposition = "rejected"; } else await this.options.provisioning.reattach(binding, command.paneId, message.actorOpenId); }
      else if (command?.kind === "replace") { if (!await this.requireCreator(message, binding) || !binding || binding.attachment !== "orphaned") { if (binding?.creatorOpenId === message.actorOpenId) await this.reject(message, "只有 orphaned 会话可以创建 replacement Pane。"); disposition = "rejected"; } else await this.options.provisioning.replace(binding, message.actorOpenId); }
      else if (command?.kind === "resume") disposition = await this.requireCreator(message, binding) && await this.options.sessionAdministration.resume(message, binding) ? "command_completed" : "rejected";
      else if (binding?.state === "active" && binding.lifecycle === "active") disposition = await this.enqueue(binding, message) ? "prompt_queued" : "rejected";
      else if (this.options.instanceInteractions && await this.options.instanceInteractions.handleOrdinaryMessage(message)) disposition = "prompt_queued";
      else if (message.isRootMessage && message.mentionsBot) { await this.options.provisioning.selectProject(message, deriveTopicTitle(message.text), message.text); disposition = "command_completed"; }
      else { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `disconnected-topic:${message.messageId}`, renderDisconnectedTopicCard(binding?.state === "archived" ? "archived" : "unbound")); disposition = "user_feedback"; }
    } catch (error) { this.options.logger.error({ event: "lark-message-handling-failed", err: safeLogError(error), eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, outcome: "failed" }, "Lark message handling failed"); throw error; }
    this.options.logger.info({ event: "lark-message-accepted", eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, disposition, outcome: "accepted" }, "completed durable inbound handling");
  }

  private async enqueue(binding: Binding, message: IncomingLarkMessage, body = message.text, forcedParentPromptId?: string): Promise<boolean> {
    if (!binding.rootMessageId) throw new Error("This binding has no Lark root message");
    if (!forcedParentPromptId) return this.enqueueClassified(binding, message, body);
    const promptId = randomUUID(); const occurredAt = new Date().toISOString(); const parentPromptId = forcedParentPromptId; const dispatchKind = "steering" as const;
    const view = createQueuedRunCard({ promptId, bindingId: binding.id, bindingGeneration: binding.generation, conversionParentPromptId: null, title: requestTitle(body), sessionTitle: binding.title, workspaceId: binding.workspaceId, paneId: binding.paneId, spaceName: this.spaceNameFor(binding), requestText: body, queuePosition: 0, occurredAt });
    const { prompt, inserted } = this.options.store.acceptPrompt({ prompt: { id: promptId, bindingId: binding.id, larkMessageId: message.messageId, actorOpenId: message.actorOpenId, body, dispatchKind, parentPromptId }, view, rootMessageId: binding.rootMessageId, answerCard: renderRequestAnswerCard(view) });
    this.options.outboundWork.wake();
    if (!inserted) { if (prompt.dispatchKind === "steering" && prompt.parentPromptId) this.options.scheduler.wake({ kind: "steering-ready", bindingId: binding.id, parentPromptId: prompt.parentPromptId }); else this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id }); return true; }
    const depth = this.options.store.countPendingPrompts(binding.id);
    this.options.logger.info({ event: "prompt-dispatch-decided", eventId: message.eventId, messageId: message.messageId, bindingId: binding.id, promptId: prompt.id, parentPromptId, workspaceId: binding.workspaceId, paneId: binding.paneId, dispatchKind, queueDepth: depth, outcome: "accepted" }, "accepted Lark prompt dispatch decision");
    this.options.scheduler.wake({ kind: "steering-ready", bindingId: binding.id, parentPromptId });
    await this.publish(binding.id, "SteeringQueued", "lark", { promptId: prompt.id, parentPromptId, actorOpenId: message.actorOpenId });
    this.options.store.audit({ actorOpenId: message.actorOpenId, action: "prompt.steer", target: binding.id, outcome: "success" });
    return true;
  }

  private async enqueueClassified(binding: Binding, message: IncomingLarkMessage, body: string): Promise<boolean> {
    if (!binding.rootMessageId) throw new Error("This binding has no Lark root message");
    const classification = classifyContinuation({ text: body, hasUnsupportedContent: message.hasUnsupportedContent ?? false });
    if (!classification.eligible && this.options.store.countPendingPrompts(binding.id) >= this.options.config.maxQueueDepth) throw new Error("This topic's prompt queue is full");
    const promptId = randomUUID();
    const acceptedAt = new Date().toISOString();
    const capturedParentPromptId = this.options.promptRun.activeTurn(binding.id)?.promptId ?? null;
    const common = { promptId, bindingId: binding.id, bindingGeneration: binding.generation, title: requestTitle(body), sessionTitle: binding.title, workspaceId: binding.workspaceId, paneId: binding.paneId, spaceName: this.spaceNameFor(binding), requestText: body, occurredAt: acceptedAt };
    const result = this.options.store.acceptClassifiedPrompt({
      prompt: { id: promptId, bindingId: binding.id, larkMessageId: message.messageId, actorOpenId: message.actorOpenId, body },
      ordinaryView: createQueuedRunCard({ ...common, conversionParentPromptId: capturedParentPromptId, queuePosition: this.options.store.countPendingPrompts(binding.id) + 1 }),
      steeringView: createQueuedRunCard({ ...common, conversionParentPromptId: null, queuePosition: 0 }),
      rootMessageId: binding.rootMessageId, maxQueueDepth: this.options.config.maxQueueDepth, expectedBindingGeneration: binding.generation, candidateParentPromptId: null,
      activeAfter: new Date(Date.parse(acceptedAt) - 5 * 60_000).toISOString(), acceptedAt, answerCardFor: renderRequestAnswerCard
    });
    this.options.logger.info({ event: "auto-steering-classified", bindingId: binding.id, messageId: message.messageId, outcome: result.decision, reason: classification.eligible ? result.fallbackReason : classification.reason }, "classified continuation message");
    if (result.decision === "queue_full") {
      await this.reject(message, "This topic's prompt queue is full");
      return false;
    }
    if (!result.inserted) return true;
    this.options.outboundWork.wake();
    const depth = this.options.store.countPendingPrompts(binding.id);
    this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
    await this.publish(binding.id, "PromptQueued", "lark", { promptId: result.prompt.id, queueDepth: depth, actorOpenId: message.actorOpenId });
    this.options.store.audit({ actorOpenId: message.actorOpenId, action: "prompt.queue", target: binding.id, outcome: "success" });
    return true;
  }

  private async requireCreator(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> {
    if (binding && (binding.creatorOpenId === null || binding.creatorOpenId === message.actorOpenId)) return true;
    await this.reject(message, "只有会话创建者可以执行这项管理操作。");
    return false;
  }

  private isCreatorCardAction(action: IncomingLarkCardAction, bindingId: string): boolean {
    const binding = this.options.store.getBinding(bindingId);
    return Boolean(binding && binding.chatId === action.chatId && (binding.creatorOpenId === null || binding.creatorOpenId === action.operatorOpenId));
  }

  private spaceNameFor(binding: Binding): string {
    const project = binding.projectId ? this.projectsById.get(binding.projectId) : this.uniqueProjectByWorkspace.get(binding.workspaceId);
    return project ? projectSpaceName(project) : "legacy/unresolved";
  }
  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, renderMessageRejectedCard(reason)); }
  private async reply(rootMessageId: string, card: object): Promise<void> { await this.options.outbound.enqueueCard(rootMessageId, `standalone:${rootMessageId}:${JSON.stringify(card)}`, card); }
  private async publish<T extends BridgeEvent["type"]>(bindingId: string, type: T, origin: EventOrigin, payload: BridgeEventOf<T>["payload"]): Promise<void> { await this.options.lifecycleEvents.publish(createBridgeEvent<T>(bindingId, type, origin, payload)); }
}

function errorMessage(error: unknown): string { return error instanceof Error ? error.message : String(error); }
function uniqueProjectsByWorkspace(projects: readonly BridgeConfig["projects"][number][]): Map<string, BridgeConfig["projects"][number] | null> {
  const result = new Map<string, BridgeConfig["projects"][number] | null>();
  for (const project of projects) result.set(project.workspaceId, result.has(project.workspaceId) ? null : project);
  return result;
}
function requestTitle(body: string): string { const normalized = body.replace(/\s+/g, " " ).trim(); return normalized.length > 64 ? normalized.slice(0, 63) + "…" : normalized || "TraeX request"; }
function parseOpenThreadAction(value: unknown): { bindingId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return item.action === "open_project_thread" && typeof item.bindingId === "string" ? { bindingId: item.bindingId } : null; }
function parseModelSelectionAction(value: unknown, option?: string | null): { bindingId: string; model: string } | null { if (!value || typeof value !== "object" || !option) return null; const item = value as Record<string, unknown>; return item.action === "select_model" && typeof item.bindingId === "string" && /^[a-z0-9][a-z0-9._:+/-]{0,127}$/i.test(option) ? { bindingId: item.bindingId, model: option } : null; }
function parseModelModeSelectionAction(value: unknown, option?: string | null): { bindingId: string; operationId: string; mode: string } | null { if (!value || typeof value !== "object" || !option) return null; const item = value as Record<string, unknown>; return item.action === "select_model_mode" && typeof item.bindingId === "string" && typeof item.operationId === "string" && option.length <= 128 ? { bindingId: item.bindingId, operationId: item.operationId, mode: option } : null; }
function parseDeadLetterAction(value: unknown): { action: "retry_dead_letter" | "dismiss_dead_letter"; replyId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return (item.action === "retry_dead_letter" || item.action === "dismiss_dead_letter") && typeof item.replyId === "string" ? { action: item.action, replyId: item.replyId } : null; }
function parsePaneClaimAction(value: unknown): { projectId: string; workspaceId: string; paneId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return item.action === "claim_pane" && typeof item.projectId === "string" && typeof item.workspaceId === "string" && typeof item.paneId === "string" ? { projectId: item.projectId, workspaceId: item.workspaceId, paneId: item.paneId } : null; }
function parseProjectAction(value: unknown): { selectionId: string; projectId: string } | null { if (!value || typeof value !== "object") return null; const item = value as Record<string, unknown>; return item.action === "select_project" && typeof item.selectionId === "string" && typeof item.projectId === "string" ? { selectionId: item.selectionId, projectId: item.projectId } : null; }
