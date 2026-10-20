import { randomUUID } from "node:crypto";
import type { InstanceStore } from "../domain/ports/instance.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { Binding, InstanceCommand, IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult, ProjectConfig } from "../domain/types.js";
import type { AgentInstance } from "../domain/agent-instance.js";
import type { ResolvedCommandTarget } from "../domain/natural-language-command-confirmation.js";
import type { AgentDriverCatalog } from "../domain/agent-runtime.js";
import type { WorkerSessionThreadWorkflowPort } from "../domain/ports/worker-session-thread.js";
import type { InstanceControlPort, InstanceMessagingPort } from "../domain/ports/instance-workflows.js";
import { InstanceCommandActions } from "./instance-interactions/instance-command-actions.js";
import { InstanceConversationContext } from "./instance-interactions/conversation-context.js";
import { InstanceViewQuery } from "./instance-interactions/instance-view-query.js";
import { WorkerCardActions } from "./instance-interactions/worker-card-actions.js";
import { WorkerLifecycleActions, type WorkerCreationGateway } from "./instance-interactions/worker-lifecycle-actions.js";
import type { InstanceCardActionCommand } from "./card-action-command.js";
import { contentIdempotencyKey } from "../domain/content-idempotency-key.js";
export type { InstanceCardActionCommand } from "./card-action-command.js";

export interface InstanceInteractionWorkflowPort {
  handleCommand(message: IncomingLarkMessage, command: InstanceCommand): Promise<void>;
  resolveNaturalLanguageMutationTarget(message: IncomingLarkMessage, command: Extract<InstanceCommand, { kind: "to" | "steer_instance" | "stop_instance" }>): { outcome: "resolved"; instance: AgentInstance; binding: Binding; target: ResolvedCommandTarget } | { outcome: "rejected"; message: string };
  handleOrdinaryMessage(message: IncomingLarkMessage): Promise<boolean>;
  handleCardAction(action: IncomingLarkCardAction, command: InstanceCardActionCommand | Extract<import("./card-action-command.js").CardActionCommand, { kind: "completion-action" }>): Promise<LarkCardActionResult>;
}

interface Options {
  projects: readonly ProjectConfig[]; adminOpenIds: readonly string[]; store: InstanceStore;
  control: Pick<InstanceControlPort, "createWorker" | "start" | "stop" | "planRemoval" | "confirmRemoval" | "inspect" | "listWorkersForParent">;
  messaging: Pick<InstanceMessagingPort, "submit" | "steer" | "interrupt" | "acceptWorkerCompletionAction" | "ignoreWorkerCompletionAction">; drivers: AgentDriverCatalog; outbound: OutboundIntentPort;
  presentation: Pick<ApplicationPresentation, "answerCard" | "commandResult" | "projectDirectory" | "instanceCreate" | "instanceDetail" | "instanceDirectory" | "instanceRemovalPlan" | "instanceSteer" | "mainCard" | "requestRejected" | "workerMain" | "workerStatusSnapshot" | "workerThreadEntry" | "workerNewTask" | "workerTaskInstruction" | "workerTurn">;
  workerCreation?: WorkerCreationGateway; idFactory?: () => string;
  wakeOutbound?: () => void;
  workerSessionThreads?: Pick<WorkerSessionThreadWorkflowPort, "publishFromCard">;
}

export class InstanceInteractionWorkflow implements InstanceInteractionWorkflowPort {
  private readonly context: InstanceConversationContext;
  private readonly commands: InstanceCommandActions;
  private readonly workerCards: WorkerCardActions;
  private readonly workerLifecycle: WorkerLifecycleActions;

  constructor(private readonly options: Options) {
    const idFactory = options.idFactory ?? randomUUID;
    this.context = new InstanceConversationContext(options.store, options.control);
    const views = new InstanceViewQuery(options);
    const reply = (message: IncomingLarkMessage, card: object) => this.reply(message, card);
    this.commands = new InstanceCommandActions({ projects: options.projects, store: options.store, messaging: options.messaging, context: this.context, views, presentation: options.presentation, reply });
    this.workerCards = new WorkerCardActions({ store: options.store, messaging: options.messaging, presentation: options.presentation, idFactory });
    this.workerLifecycle = new WorkerLifecycleActions({ projects: options.projects, store: options.store, control: options.control, messaging: options.messaging, context: this.context, views, presentation: options.presentation, outbound: options.outbound, ...(options.workerCreation ? { workerCreation: options.workerCreation } : {}), ...(options.wakeOutbound ? { wakeOutbound: options.wakeOutbound } : {}) });
  }

  async handleCommand(message: IncomingLarkMessage, command: InstanceCommand): Promise<void> {
    if (!this.isOperator(message.actorOpenId)) return this.reject(message, "你没有 Agent 管理权限。");
    return this.commands.handle(message, command);
  }

  resolveNaturalLanguageMutationTarget(message: IncomingLarkMessage, command: Extract<InstanceCommand, { kind: "to" | "steer_instance" | "stop_instance" }>): { outcome: "resolved"; instance: AgentInstance; binding: Binding; target: ResolvedCommandTarget } | { outcome: "rejected"; message: string } {
    if (!this.isOperator(message.actorOpenId)) return { outcome: "rejected", message: "你没有 Agent 管理权限。" };
    const context = this.context.resolve(message);
    const binding = context.conversationKey.startsWith("binding:") ? this.options.store.getBinding(context.conversationKey.slice(8)) : null;
    const instance = this.context.findByName(context.conversationKey, command.name);
    if (!instance) return { outcome: "rejected", message: `实例不存在或不属于当前 Primary：${command.name}` };
    if (!binding || !binding.paneId || !instance.parent || instance.parent.bindingId !== binding.id || instance.parent.bindingGeneration !== binding.generation || instance.parent.paneId !== binding.paneId) {
      return { outcome: "rejected", message: `实例身份不完整或已过期：${command.name}` };
    }
    return { outcome: "resolved", instance, binding, target: { version: 1, kind: "worker", instanceId: instance.id, instanceGeneration: instance.generation, workerSessionGeneration: instance.workerSessionGeneration, parentBindingId: binding.id, parentBindingGeneration: binding.generation, parentPaneId: instance.parent.paneId } };
  }

  async handleOrdinaryMessage(message: IncomingLarkMessage): Promise<boolean> {
    if (message.parentMessageId) return false;
    const context = this.context.resolve(message);
    const selected = this.context.selected(context, message.chatId);
    const projectId = context.boundProjectId ?? selected?.projectId;
    if (!projectId) return false;
    const current = selected?.projectId === projectId ? selected : null;
    if (!this.isOperator(message.actorOpenId)) { await this.reject(message, "你没有 Agent 管理权限。"); return true; }
    if (!current || current.target.kind === "primary") return false;
    const selectedTarget = current.target;
    const target = this.context.workers(context.conversationKey).find(({ id }) => id === selectedTarget.instanceId) ?? null;
    if (!target) {
      const project = this.options.projects.find(({ id }) => id === projectId);
      if (project) await this.reply(message, new InstanceViewQuery(this.options).directory(project, context.conversationKey));
      return true;
    }
    if (selectedTarget.expectedGeneration !== undefined && selectedTarget.expectedGeneration !== target.generation) {
      await this.reject(message, "当前目标实例已重新启动，请从实例目录重新选择。"); return true;
    }
    await this.options.messaging.submit({ idempotencyKey: `lark:${message.messageId}`, actor: { kind: "human", userId: message.actorOpenId, channel: "feishu" }, projectId, targetInstanceId: target.id, content: { kind: "turn", text: message.text }, source: { messageId: message.messageId, rootMessageId: message.rootMessageId ?? message.messageId } });
    return true;
  }

  async handleCardAction(action: IncomingLarkCardAction, command: InstanceCardActionCommand | Extract<import("./card-action-command.js").CardActionCommand, { kind: "completion-action" }>): Promise<LarkCardActionResult> {
    if (command.kind === "completion-action") return this.submitWorkerCompletionAction(action, command);
    if (!this.isOperator(action.operatorOpenId)) return { toast: { type: "error", content: "你没有 Agent 管理权限。" } };
    if (command.action === "worker_thread_send" && this.options.workerSessionThreads) return this.options.workerSessionThreads.publishFromCard(action, { instanceId: command.instanceId, runtimeGeneration: command.generation, workerSessionGeneration: command.workerSessionGeneration, conversationKey: command.conversationKey, ...(command.bindingId ? { bindingId: command.bindingId, bindingGeneration: command.bindingGeneration } : {}), ...(command.parentPaneId && command.sourceMainMessageId ? { parentPaneId: command.parentPaneId, sourceMainMessageId: command.sourceMainMessageId } : {}) });
    if (command.action === "worker_thread_send") return this.workerLifecycle.handle(action, command);
    if ("turnId" in command && "workerSessionGeneration" in command) return this.workerCards.handleTask(action, command);
    if ("workerSessionGeneration" in command) return this.workerCards.handleNewTask(action, command);
    return this.workerLifecycle.handle(action, command);
  }

  private async submitWorkerCompletionAction(action: IncomingLarkCardAction, command: Extract<import("./card-action-command.js").CardActionCommand, { kind: "completion-action" }>): Promise<LarkCardActionResult> {
    if (command.ownerKind !== "worker-turn" || action.messageId !== command.cardMessageId) return { toast: { type: "warning", content: "该快捷操作已失效，请发送新的消息。" } };
    try {
      if ("ignore" in command) {
        await this.options.messaging.ignoreWorkerCompletionAction({
          actionSetId: command.actionSetId, ownerTurnId: command.ownerId, ownerGeneration: command.ownerGeneration,
          cardMessageId: command.cardMessageId, chatId: action.chatId, actor: { kind: "human", userId: action.operatorOpenId, channel: "feishu" }
        });
        return { toast: { type: "success", content: "已忽略。" } };
      }
      const receipt = await this.options.messaging.acceptWorkerCompletionAction({
        actionSetId: command.actionSetId, ...("selection" in command ? { selection: command.selection } : { optionId: command.optionId }), ownerTurnId: command.ownerId, ownerGeneration: command.ownerGeneration,
        cardMessageId: command.cardMessageId, chatId: action.chatId, actor: { kind: "human", userId: action.operatorOpenId, channel: "feishu" }
      });
      return { toast: { type: "success", content: receipt.inserted ? `快捷消息已提交，当前队列第 ${receipt.card.queuePosition} 位。` : "这条快捷消息已提交。" } };
    } catch {
      return { toast: { type: "warning", content: "该快捷操作已失效，请发送新的消息。" } };
    }
  }

  private isOperator(openId: string): boolean { return this.options.adminOpenIds.includes(openId); }
  private reply(message: IncomingLarkMessage, card: object): Promise<void> { return this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, contentIdempotencyKey(`instance:${message.messageId}`, card), card); }
  private reject(message: IncomingLarkMessage, reason: string): Promise<void> { return this.reply(message, this.options.presentation.requestRejected(reason)); }
}
