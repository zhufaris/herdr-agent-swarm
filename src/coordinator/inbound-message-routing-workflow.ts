import { randomUUID } from "node:crypto";
import type { Logger } from "pino";
import type { BridgeConfig } from "../config.js";
import { deriveTopicTitle, parseCommand, parseInstanceCommand } from "../domain/commands.js";
import { formatPromptTitle } from "../domain/prompt-title.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { PromptAcceptanceStore } from "../domain/ports/prompt-acceptance.js";
import type { PrimaryPresentation } from "../domain/ports/presentation.js";
import type { InboundRoutingStore } from "../domain/ports/workflow.js";
import { createQueuedRunCard } from "../domain/run-card-view.js";
import type { Binding, BridgeCommand, IncomingLarkMessage, ProjectSelection } from "../domain/types.js";
import type { LifecycleEventPublisher } from "../events/bridge-event-bus.js";
import type { OutboundWorkNotifier } from "../events/outbound-work-notifier.js";
import type { PromptWorkScheduler } from "../events/prompt-work-scheduler.js";
import { safeLogError } from "../runtime/safe-error.js";
import { PermanentInboundMessageRejection } from "../domain/permanent-inbound-message-rejection.js";
import { isInstanceTurnCapacityExceeded } from "../domain/instance-turn-capacity-error.js";
import type { BindingProvisioningWorkflowPort } from "./binding-provisioning-workflow.js";
import type { InstanceInteractionWorkflow } from "./instance-interaction-workflow.js";
import type { PromptRunWorkflowPort } from "./prompt-run-workflow.js";
import type { SwarmCommandGatewayPort } from "./swarm-command-gateway.js";
import { ProjectCatalog } from "./project-catalog.js";
import { executePromptAcceptanceEffects } from "./prompt-acceptance-effects.js";

export interface InboundMessageRoutingWorkflowPort {
  handle(message: IncomingLarkMessage): Promise<void>;
  enqueueInitialProjectPrompt(binding: Binding, selection: ProjectSelection): Promise<void>;
}

export interface InboundMessageRoutingStore extends
  Pick<InboundRoutingStore, "findBindingByLarkScope" | "isBindingThreadAlias" | "findWorkerSessionThreadByScope" | "findWorkerSessionThreadRecordByScope">,
  PromptAcceptanceStore {}
interface Options {
  config: BridgeConfig; store: InboundMessageRoutingStore; lifecycleEvents: LifecycleEventPublisher; outbound: OutboundIntentPort; outboundWork: OutboundWorkNotifier; logger: Logger; scheduler: PromptWorkScheduler; presentation: Pick<PrimaryPresentation, "answerCard" | "disconnectedTopic" | "requestRejected">;
  promptRun: PromptRunWorkflowPort; provisioning: BindingProvisioningWorkflowPort; swarmCommands: SwarmCommandGatewayPort; instanceInteractions?: InstanceInteractionWorkflow;
}

export class InboundMessageRoutingWorkflow implements InboundMessageRoutingWorkflowPort {
  private readonly projectRoutes: ProjectCatalog;

  constructor(private readonly options: Options) {
    this.projectRoutes = new ProjectCatalog(options.config.projects);
  }

  async enqueueInitialProjectPrompt(binding: Binding, selection: ProjectSelection): Promise<void> {
    if (!selection.initialPromptText) return;
    await this.enqueue(binding, { eventId: `project-selection:${selection.id}`, messageId: selection.commandMessageId, parentMessageId: null, chatId: selection.chatId, topicId: binding.topicId, rootMessageId: binding.rootMessageId, actorOpenId: selection.actorOpenId, text: selection.initialPromptText, mentionsBot: true, isRootMessage: false });
  }

  async handle(message: IncomingLarkMessage): Promise<void> {
    const workerThread = this.options.store.findWorkerSessionThreadByScope(message.chatId, message.topicId, message.rootMessageId);
    const staleWorkerThread = workerThread ? null : this.options.store.findWorkerSessionThreadRecordByScope(message.chatId, message.topicId, message.rootMessageId);
    const instanceCommand = parseInstanceCommand(message.text);
    const command = parseCommand(message.text); const binding = this.options.store.findBindingByLarkScope(message.topicId, message.rootMessageId); const alias = this.options.store.isBindingThreadAlias(message.topicId, message.rootMessageId);
    let decision = "unresolved";
    let disposition: "prompt_queued" | "command_completed" | "user_feedback" | "rejected" = "command_completed";
    try {
      if (workerThread) {
        decision = "worker-session-thread";
        if (this.options.instanceInteractions) { await this.options.instanceInteractions.handleWorkerThreadMessage(message, workerThread); disposition = message.text.trim().startsWith("/") ? "command_completed" : "prompt_queued"; }
        else { await this.reject(message, "Worker 对话暂不可用，请稍后重试。"); disposition = "rejected"; }
      }
      else if (staleWorkerThread) { decision = "stale-worker-session-thread"; await this.reject(message, "Worker 对话已失效，请从 Primary 的 `/instances` 重新进入。"); disposition = "rejected"; }
      else if (instanceCommand && alias) { decision = `alias-instance-command-rejected:${instanceCommand.kind}`; await this.reject(message, "这个入口话题固定连接当前 Pane 的 Primary Agent；请回到原始 Main Card 话题管理项目或 Worker。"); disposition = "rejected"; }
      else if (instanceCommand) { decision = `instance-command:${instanceCommand.kind}`; if (this.options.instanceInteractions) await this.options.instanceInteractions.handleCommand(message, instanceCommand); }
      else if (command && alias && rejectsAliasCommand(command)) { decision = `alias-command-rejected:${command.kind}`; await this.reject(message, "这个入口话题只用于当前 Agent 交互；请回到原始 Main Card 话题执行会话或拓扑管理命令。"); disposition = "rejected"; }
      else if (command) { decision = `command:${command.kind}`; await this.options.swarmCommands.handle(message, command); }
      else if (binding?.state === "active" && binding.lifecycle === "active") { decision = "prompt"; disposition = await this.enqueue(binding, message) ? "prompt_queued" : "rejected"; }
      else if (this.options.instanceInteractions && await this.options.instanceInteractions.handleOrdinaryMessage(message)) { decision = "instance-prompt"; disposition = "prompt_queued"; }
      else if (message.isRootMessage && message.mentionsBot) { decision = "create_binding"; await this.options.provisioning.selectProject(message, deriveTopicTitle(message.text), message.text); disposition = "command_completed"; }
      else { decision = binding?.state === "archived" ? "archived_feedback" : "unbound_feedback"; await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `disconnected-topic:${message.messageId}`, this.options.presentation.disconnectedTopic(binding?.state === "archived" ? "archived" : "unbound")); disposition = "user_feedback"; }
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
    this.options.logger.info({ event: "lark-message-routed", eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, workspaceId: binding?.workspaceId, paneId: binding?.paneId, decision, outcome: "accepted" }, "routed persisted Lark message");
    this.options.logger.info({ event: "lark-message-accepted", eventId: message.eventId, messageId: message.messageId, bindingId: binding?.id, disposition, outcome: "accepted" }, "completed durable inbound handling");
  }

  private async enqueue(binding: Binding, message: IncomingLarkMessage, body = message.text): Promise<boolean> {
    const answerRootMessageId = this.options.store.isBindingThreadAlias(message.topicId, message.rootMessageId) ? message.rootMessageId : binding.rootMessageId;
    if (!answerRootMessageId) throw new Error("This binding has no Lark root message");
    const promptId = randomUUID(); const acceptedAt = new Date().toISOString(); const capturedParentPromptId = this.options.promptRun.activeTurn(binding.id)?.promptId ?? null;
    const common = { promptId, bindingId: binding.id, bindingGeneration: binding.generation, title: formatPromptTitle(body), sessionTitle: binding.title, workspaceId: binding.workspaceId, paneId: binding.paneId, spaceName: this.spaceNameFor(binding), requestText: body, occurredAt: acceptedAt };
    let receipt: ReturnType<PromptAcceptanceStore["acceptPromptWithEffects"]>;
    try {
      const view = createQueuedRunCard({ ...common, conversionParentPromptId: capturedParentPromptId, queuePosition: this.options.store.countPendingPrompts(binding.id) + 1 });
      receipt = this.options.store.acceptPromptWithEffects({ prompt: { id: promptId, bindingId: binding.id, larkMessageId: message.messageId, actorOpenId: message.actorOpenId, body }, view, rootMessageId: answerRootMessageId, answerCard: this.options.presentation.answerCard(view), maxQueueDepth: this.options.config.maxQueueDepth, expectedBindingGeneration: binding.generation });
    } catch (error) {
      if (error instanceof Error && error.message === "This topic's prompt queue is full") { await this.reject(message, error.message); return false; }
      throw error;
    }
    if (!receipt.result.inserted) return true;
    await executePromptAcceptanceEffects(receipt, this.options);
    this.options.store.audit({ actorOpenId: message.actorOpenId, action: "prompt.queue", target: binding.id, outcome: "success" });
    return true;
  }

  private spaceNameFor(binding: Binding): string { return this.projectRoutes.spaceNameForBinding(binding); }
  private async reject(message: IncomingLarkMessage, reason: string): Promise<void> { await this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `rejected:${message.messageId}`, this.options.presentation.requestRejected(reason)); }
}

function permanentInstanceCommandRejection(error: unknown): string | null {
  if (isInstanceTurnCapacityExceeded(error)) return error.message;
  const message = error instanceof Error ? error.message : String(error);
  return [
    "Target instance is not running",
    "Target instance not found",
    "Target instance is not in the requested project"
  ].includes(message) ? message : null;
}
export function rejectsAliasCommand(command: BridgeCommand): boolean {
  return command.kind === "new" || command.kind === "projects" || command.kind === "spaces" || command.kind === "reset" || command.kind === "attach" || command.kind === "rename" || command.kind === "close" || command.kind === "pane_close_request" || command.kind === "pane_close_confirm" || command.kind === "reattach" || command.kind === "replace" || command.kind === "resume" || command.kind === "worker_create" || command.kind === "model" && command.name !== null;
}
