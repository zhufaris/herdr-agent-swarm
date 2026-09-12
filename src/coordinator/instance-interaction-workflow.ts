import { randomUUID } from "node:crypto";
import type { InstanceStore } from "../domain/ports/instance.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { ApplicationPresentation } from "../domain/ports/presentation.js";
import type { InstanceCommand, IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult, ProjectConfig } from "../domain/types.js";
import type { AgentDriverRegistry } from "../runtime/agents/agent-driver.js";
import type { WorkerSessionThread } from "../domain/worker-session-thread.js";
import type { InstanceControlWorkflow } from "./instance-control-workflow.js";
import type { InstanceMessagingWorkflow } from "./instance-messaging-workflow.js";
import { InstanceCommandActions } from "./instance-interactions/instance-command-actions.js";
import { InstanceConversationContext } from "./instance-interactions/conversation-context.js";
import { InstanceViewQuery } from "./instance-interactions/instance-view-query.js";
import { WorkerCardActions } from "./instance-interactions/worker-card-actions.js";
import { WorkerLifecycleActions, type WorkerCreationGateway } from "./instance-interactions/worker-lifecycle-actions.js";
import type { InstanceCardActionCommand } from "./card-action-command.js";
export type { InstanceCardActionCommand } from "./card-action-command.js";

interface Options {
  projects: readonly ProjectConfig[]; adminOpenIds: readonly string[]; store: InstanceStore; control: InstanceControlWorkflow; messaging: InstanceMessagingWorkflow; drivers: AgentDriverRegistry; outbound: OutboundIntentPort;
  presentation: Pick<ApplicationPresentation, "answerCard" | "instanceCreate" | "instanceDetail" | "instanceDirectory" | "instanceRemovalPlan" | "instanceSteer" | "mainCard" | "requestRejected" | "workerMain" | "workerStatusSnapshot" | "workerThreadEntry" | "workerThreadAccepted" | "workerNewTask" | "workerTaskInstruction" | "workerTurn">;
  workerCreation?: WorkerCreationGateway; idFactory?: () => string;
  wakeOutbound?: () => void;
}

export class InstanceInteractionWorkflow {
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
    this.workerLifecycle = new WorkerLifecycleActions({ projects: options.projects, store: options.store, control: options.control, messaging: options.messaging, context: this.context, views, presentation: options.presentation, ...(options.workerCreation ? { workerCreation: options.workerCreation } : {}), ...(options.wakeOutbound ? { wakeOutbound: options.wakeOutbound } : {}) });
  }

  async handleCommand(message: IncomingLarkMessage, command: InstanceCommand): Promise<void> {
    if (!this.isOperator(message.actorOpenId)) return this.reject(message, "你没有 Agent 管理权限。");
    return this.commands.handle(message, command);
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

  async handleWorkerThreadMessage(message: IncomingLarkMessage, thread: WorkerSessionThread): Promise<void> {
    if (!this.isOperator(message.actorOpenId)) return this.reject(message, "你没有 Agent 管理权限。");
    if (thread.state !== "active") return this.reject(message, "Worker 对话已失效，请从 Primary 的 `/instances` 重新进入。");
    const instance = this.options.store.getAgentInstance(thread.workerId);
    const binding = this.options.store.getBinding(thread.parentBindingId);
    if (!instance || instance.role !== "worker" || instance.workerSessionLifecycle !== "active" || instance.workerSessionGeneration !== thread.workerSessionGeneration || instance.parent?.bindingId !== thread.parentBindingId || (instance.parent.bindingGeneration ?? 1) !== thread.parentBindingGeneration || instance.parent.paneId !== thread.parentPaneId || !binding || binding.chatId !== thread.chatId || binding.generation !== thread.parentBindingGeneration || binding.paneId !== thread.parentPaneId || binding.state !== "active" || binding.lifecycle !== "active" || binding.attachment !== "attached") return this.reject(message, "Worker 对话已失效，请从 Primary 的 `/instances` 重新进入。");
    const rootMessageId = thread.rootMessageId;
    if (!rootMessageId) return this.reject(message, "Worker 对话仍在创建，请稍后重试。");
    const text = message.text.trim();
    const actor = { kind: "human" as const, userId: message.actorOpenId, channel: "feishu" as const };
    if (/^\/status$/i.test(text)) {
      const view = this.options.store.loadWorkerMainView(instance.id, thread.workerSessionGeneration);
      if (!view) return this.reject(message, "Worker 状态尚未生成，请稍后重试。");
      return this.options.outbound.enqueueCard(rootMessageId, `worker-thread:status:${message.messageId}`, this.options.presentation.workerStatusSnapshot(view, new Date().toISOString()));
    }
    const steer = /^\/steer\s+([\s\S]+)$/i.exec(text);
    if (steer) {
      const active = this.options.store.getActiveInstanceTurn(instance.id, instance.generation);
      if (!active || !["running", "blocked"].includes(active.state)) return this.reject(message, "当前没有可补充的 active Worker task。");
      const result = await this.options.messaging.steer({ idempotencyKey: `lark:${message.messageId}:worker-thread-steer`, actor, targetInstanceId: instance.id, targetTurnId: active.id, text: steer[1]!.trim(), resultTargetMessageId: rootMessageId });
      if (result.durableResult === false) await this.reject(message, `补充当前任务：${result.status}`);
      return;
    }
    if (/^\/stop$/i.test(text)) {
      const active = this.options.store.getActiveInstanceTurn(instance.id, instance.generation);
      if (!active || active.state !== "running") return this.reject(message, "当前没有可停止的 active Worker task。");
      const result = await this.options.messaging.interrupt({ idempotencyKey: `lark:${message.messageId}:worker-thread-stop`, actor, targetInstanceId: instance.id, targetTurnId: active.id, resultTargetMessageId: rootMessageId });
      if (result.status !== "interrupted" && result.durableResult === false) await this.reject(message, `停止当前任务：${result.status}`);
      return;
    }
    if (text.startsWith("/")) return this.reject(message, "Worker 对话仅支持 `/status`、`/steer <文本>`、`/stop`；管理命令请回到 Primary Thread。");
    const submitted = await this.options.messaging.submit({ idempotencyKey: `lark:${message.messageId}`, actor, projectId: instance.projectId, targetInstanceId: instance.id, content: { kind: "turn", text: message.text }, source: { messageId: message.messageId, rootMessageId } });
    await this.options.outbound.enqueueCard(rootMessageId, `worker-thread:accepted:${message.messageId}`, this.options.presentation.workerThreadAccepted({ workerName: instance.name, queuePosition: submitted.card?.queuePosition ?? 1, duplicate: !submitted.inserted }));
  }

  async handleCardAction(action: IncomingLarkCardAction, command: InstanceCardActionCommand): Promise<LarkCardActionResult> {
    if (!this.isOperator(action.operatorOpenId)) return { toast: { type: "error", content: "你没有 Agent 管理权限。" } };
    if (command.action === "worker_thread_send") return this.workerLifecycle.handle(action, command);
    if ("turnId" in command && "workerSessionGeneration" in command) return this.workerCards.handleTask(action, command);
    if ("workerSessionGeneration" in command) return this.workerCards.handleNewTask(action, command);
    return this.workerLifecycle.handle(action, command);
  }

  private isOperator(openId: string): boolean { return this.options.adminOpenIds.includes(openId); }
  private reply(message: IncomingLarkMessage, card: object): Promise<void> { return this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `instance:${message.messageId}:${JSON.stringify(card)}`, card); }
  private reject(message: IncomingLarkMessage, reason: string): Promise<void> { return this.reply(message, this.options.presentation.requestRejected(reason)); }
}
