import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import { renderAwakeStatusCard, renderDisconnectedTopicCard, renderHelpCard, renderMessageRejectedCard, renderRequestAnswerCard } from "../cards/run-card.js";
import { projectSpaceName, type BridgeConfig } from "../config.js";
import { deriveTopicTitle, parseCommand, parseInstanceCommand } from "../domain/commands.js";
import { classifyContinuation } from "../domain/continuation-classifier.js";
import { createBridgeEvent, type BridgeEventOf } from "../domain/create-bridge-event.js";
import { formatPromptTitle } from "../domain/prompt-title.js";
import type { BridgeEvent } from "../domain/events.js";
import type { InstanceStore } from "../domain/ports/instance.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { PromptAcceptanceStore } from "../domain/ports/prompt.js";
import type { InboundRoutingStore } from "../domain/ports/workflow.js";
import { createQueuedRunCard } from "../domain/run-card-view.js";
import type { Binding, EventOrigin, IncomingLarkMessage, ProjectSelection } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import { PermanentInboundMessageRejection } from "../domain/permanent-inbound-message-rejection.js";
import type { BindingProvisioningWorkflowPort } from "./binding-provisioning-workflow.js";
import type { InstanceInteractionWorkflow } from "./instance-interaction-workflow.js";
import type { ModelSelectionWorkflowPort } from "./model-selection-workflow.js";
import type { OperationsQueryWorkflowPort } from "./operations-query-workflow.js";
import type { PaneClosureWorkflowPort } from "./pane-closure-workflow.js";
import type { PaneControlWorkflowPort } from "./pane-control-workflow.js";
import type { PromptRunWorkflowPort } from "./prompt-run-workflow.js";
import type { SessionAdministrationWorkflowPort } from "./session-administration-workflow.js";

export interface InboundMessageRoutingWorkflowPort {
  handle(message: IncomingLarkMessage): Promise<void>;
  enqueueInitialProjectPrompt(binding: Binding, selection: ProjectSelection): Promise<void>;
}

type Store = InboundRoutingStore & PromptAcceptanceStore & InstanceStore;
interface Options {
  config: BridgeConfig; store: Store; lifecycleEvents: LifecycleEventPublisher; outbound: OutboundIntentPort; outboundWork: OutboundWorkNotifier; logger: Logger; scheduler: PromptWorkScheduler;
  promptRun: PromptRunWorkflowPort; provisioning: BindingProvisioningWorkflowPort; modelSelection: ModelSelectionWorkflowPort; paneControl: PaneControlWorkflowPort; operationsQuery: OperationsQueryWorkflowPort; sessionAdministration: SessionAdministrationWorkflowPort; paneClosure: PaneClosureWorkflowPort; instanceInteractions?: InstanceInteractionWorkflow;
}

export class InboundMessageRoutingWorkflow implements InboundMessageRoutingWorkflowPort {
  private readonly projectsById: Map<string, BridgeConfig["projects"][number]>;
  private readonly uniqueProjectByWorkspace: Map<string, BridgeConfig["projects"][number] | null>;

  constructor(private readonly options: Options) {
    this.projectsById = new Map(options.config.projects.map((project) => [project.id, project]));
    this.uniqueProjectByWorkspace = uniqueProjectsByWorkspace(options.config.projects);
  }

  async enqueueInitialProjectPrompt(binding: Binding, selection: ProjectSelection): Promise<void> {
    if (!selection.initialPromptText) return;
    await this.enqueue(binding, { eventId: `project-selection:${selection.id}`, messageId: selection.commandMessageId, parentMessageId: null, chatId: selection.chatId, topicId: binding.topicId, rootMessageId: binding.rootMessageId, actorOpenId: selection.actorOpenId, text: selection.initialPromptText, mentionsBot: true, isRootMessage: false });
  }

  async handle(message: IncomingLarkMessage): Promise<void> {
    const instanceCommand = parseInstanceCommand(message.text);
    const command = parseCommand(message.text); const binding = this.options.store.findBindingByLarkScope(message.topicId, message.rootMessageId);
    if (command && requiresAdministrator(command.kind) && !(this.options.config.lark.adminOpenIds ?? []).includes(message.actorOpenId)) {
      await this.reject(message, "你没有管理权限。");
      this.options.logger.warn({ event: "lark-message-rejected", eventId: message.eventId, messageId: message.messageId, actorOpenId: message.actorOpenId, route: command.kind, reason: "administrator_required" }, "rejected unauthorized Lark management command");
      return;
    }
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
      else if (command?.kind === "awake") await this.awake(message, binding).then((result) => { disposition = result ? "command_completed" : "rejected"; });
      else if (binding?.state === "active" && binding.lifecycle === "active") disposition = await this.enqueue(binding, message) ? "prompt_queued" : "rejected";
      else if (this.options.instanceInteractions && await this.options.instanceInteractions.handleOrdinaryMessage(message)) disposition = "prompt_queued";
      else if (message.isRootMessage && message.mentionsBot) { await this.options.provisioning.selectProject(message, deriveTopicTitle(message.text), message.text); disposition = "command_completed"; }
      else { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `disconnected-topic:${message.messageId}`, renderDisconnectedTopicCard(binding?.state === "archived" ? "archived" : "unbound")); disposition = "user_feedback"; }
    } catch (error) {
      const rejection = this.options.instanceInteractions ? permanentInstanceCommandRejection(error) : null;
      if (rejection) {
        await this.reject(message, rejection);
        this.options.logger.info({ event: "lark-message-rejected", eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, route: decision, reason: rejection, outcome: "accepted" }, "rejected unavailable instance command");
        throw new PermanentInboundMessageRejection(rejection);
      }
      this.options.logger.error({ event: "lark-message-handling-failed", err: safeLogError(error), eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, outcome: "failed" }, "Lark message handling failed");
      throw error;
    }
    this.options.logger.info({ event: "lark-message-accepted", eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, disposition, outcome: "accepted" }, "completed durable inbound handling");
  }

  private async awake(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> {
    if (!await this.requireCreator(message, binding) || !binding) return false;
    const result = await this.options.promptRun.awake(binding.id); const recovered = result.outcome === "recovered";
    const detail = recovered ? `已从 Herdr transcript 恢复 ${result.recoveredTurns} 个遗漏 turn；每个 turn 使用新的 Answer Card，未向 TraeX 重发任务。` : result.outcome === "busy" ? "当前绑定仍在切换观察器，请稍后重试 `/swarm awake`。" : result.reason === "no_detached_prompt" ? "当前没有 detached prompt，无需唤醒。" : result.reason === "no_complete_later_turn" ? "没有找到可安全恢复的完整后续 Herdr turn；原任务保持 detached，不会重发。" : `无法安全恢复（${result.reason}）；原任务保持 detached，不会重发。`;
    await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `awake:${message.messageId}`, renderAwakeStatusCard(detail, recovered));
    return recovered || result.outcome === "none";
  }

  private async enqueue(binding: Binding, message: IncomingLarkMessage, body = message.text): Promise<boolean> {
    if (!binding.rootMessageId) throw new Error("This binding has no Lark root message");
    const classification = classifyContinuation({ text: body, hasUnsupportedContent: message.hasUnsupportedContent ?? false });
    if (!classification.eligible && this.options.store.countPendingPrompts(binding.id) >= this.options.config.maxQueueDepth) throw new Error("This topic's prompt queue is full");
    const promptId = randomUUID(); const acceptedAt = new Date().toISOString(); const capturedParentPromptId = this.options.promptRun.activeTurn(binding.id)?.promptId ?? null;
    const common = { promptId, bindingId: binding.id, bindingGeneration: binding.generation, title: formatPromptTitle(body), sessionTitle: binding.title, workspaceId: binding.workspaceId, paneId: binding.paneId, spaceName: this.spaceNameFor(binding), requestText: body, occurredAt: acceptedAt };
    const result = this.options.store.acceptClassifiedPrompt({ prompt: { id: promptId, bindingId: binding.id, larkMessageId: message.messageId, actorOpenId: message.actorOpenId, body }, ordinaryView: createQueuedRunCard({ ...common, conversionParentPromptId: capturedParentPromptId, queuePosition: this.options.store.countPendingPrompts(binding.id) + 1 }), steeringView: createQueuedRunCard({ ...common, conversionParentPromptId: null, queuePosition: 0 }), rootMessageId: binding.rootMessageId, maxQueueDepth: this.options.config.maxQueueDepth, expectedBindingGeneration: binding.generation, candidateParentPromptId: null, activeAfter: new Date(Date.parse(acceptedAt) - 5 * 60_000).toISOString(), acceptedAt, answerCardFor: renderRequestAnswerCard });
    this.options.logger.info({ event: "auto-steering-classified", bindingId: binding.id, messageId: message.messageId, outcome: result.decision, reason: classification.eligible ? result.fallbackReason : classification.reason }, "classified continuation message");
    if (result.decision === "queue_full") { await this.reject(message, "This topic's prompt queue is full"); return false; }
    if (!result.inserted) return true;
    this.options.outboundWork.wake(); const depth = this.options.store.countPendingPrompts(binding.id); this.options.scheduler.wake({ kind: "prompt-ready", bindingId: binding.id });
    await this.options.lifecycleEvents.publish(createBridgeEvent(binding.id, "PromptQueued", "lark", { promptId: result.prompt.id, queueDepth: depth, actorOpenId: message.actorOpenId }));
    this.options.store.audit({ actorOpenId: message.actorOpenId, action: "prompt.queue", target: binding.id, outcome: "success" });
    return true;
  }

  private async requireCreator(message: IncomingLarkMessage, binding: Binding | null): Promise<boolean> { if (binding && (binding.creatorOpenId === null || binding.creatorOpenId === message.actorOpenId)) return true; await this.reject(message, "只有会话创建者可以执行这项管理操作。"); return false; }
  private spaceNameFor(binding: Binding): string { const project = binding.projectId ? this.projectsById.get(binding.projectId) : this.uniqueProjectByWorkspace.get(binding.workspaceId); return project ? projectSpaceName(project) : "legacy/unresolved"; }
  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, renderMessageRejectedCard(reason)); }
  private async reply(rootMessageId: string, card: object): Promise<void> { await this.options.outbound.enqueueCard(rootMessageId, `standalone:${rootMessageId}:${JSON.stringify(card)}`, card); }
}

function uniqueProjectsByWorkspace(projects: readonly BridgeConfig["projects"][number][]): Map<string, BridgeConfig["projects"][number] | null> { const result = new Map<string, BridgeConfig["projects"][number] | null>(); for (const project of projects) result.set(project.workspaceId, result.has(project.workspaceId) ? null : project); return result; }
function requiresAdministrator(kind: NonNullable<ReturnType<typeof parseCommand>>["kind"]): boolean {
  return ["new", "projects", "stop", "steer", "model", "reset", "attach", "rename", "close", "pane_close_request", "pane_close_confirm", "reattach", "replace", "resume"].includes(kind);
}

function permanentInstanceCommandRejection(error: unknown): string | null {
  const message = error instanceof Error ? error.message : String(error);
  return [
    "Target instance is not running",
    "Target instance not found",
    "Target instance is not in the requested project"
  ].includes(message) ? message : null;
}
