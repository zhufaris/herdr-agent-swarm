import type { AgentKind, CreateWorkerResult } from "../../domain/agent-instance.js";
import type { InstanceStore } from "../../domain/ports/instance.js";
import type { OutboundIntentPort } from "../../domain/ports/outbox.js";
import type { IncomingLarkCardAction, LarkCardActionResult, ProjectConfig } from "../../domain/types.js";
import { decideWorkerCardBindingOwnership } from "../../domain/worker-card-ownership.js";
import { safeLogError } from "../../runtime/safe-error.js";
import type { InstanceControlWorkflow } from "../instance-control-workflow.js";
import type { InstanceMessagingWorkflow } from "../instance-messaging-workflow.js";
import type { BindingCardContext, InstanceCardActionCommand } from "../card-action-command.js";
import { InstanceConversationContext } from "./conversation-context.js";
import { InstanceViewQuery } from "./instance-view-query.js";

export interface WorkerCreationGateway { createWorkerFromCard(action: IncomingLarkCardAction, bindingId: string, command: { kind: "worker_create"; name: string; agentKind: AgentKind; model: string | null; start: boolean }): Promise<CreateWorkerResult> }
type WorkerCardOnlyAction = { action: "worker_new_task_form" | "worker_new_task_submit" | "worker_task_instruction_form" | "worker_task_instruction_submit" | "worker_task_interrupt" };
interface WorkerLifecyclePresentation {
  instanceCreate(input: Parameters<import("../../domain/ports/presentation.js").ApplicationPresentation["instanceCreate"]>[0]): object;
  instanceRemovalPlan(input: Parameters<import("../../domain/ports/presentation.js").ApplicationPresentation["instanceRemovalPlan"]>[0]): object;
  instanceSteer(input: Parameters<import("../../domain/ports/presentation.js").ApplicationPresentation["instanceSteer"]>[0]): object;
  workerTurn(view: Parameters<import("../../domain/ports/presentation.js").ApplicationPresentation["workerTurn"]>[0]): object;
  workerMain(view: Parameters<import("../../domain/ports/presentation.js").ApplicationPresentation["workerMain"]>[0]): object;
  workerThreadEntry(view: Parameters<import("../../domain/ports/presentation.js").ApplicationPresentation["workerThreadEntry"]>[0], generatedAt: string): object;
  mainCard(view: Parameters<import("../../domain/ports/presentation.js").ApplicationPresentation["mainCard"]>[0]): object;
  answerCard(view: Parameters<import("../../domain/ports/presentation.js").ApplicationPresentation["answerCard"]>[0], options?: Parameters<import("../../domain/ports/presentation.js").ApplicationPresentation["answerCard"]>[1]): object;
}

export class WorkerLifecycleActions {
  private readonly projects: ReadonlySet<string>;
  constructor(private readonly options: {
    projects: readonly ProjectConfig[]; store: InstanceStore; control: InstanceControlWorkflow; messaging: InstanceMessagingWorkflow;
    context: InstanceConversationContext; views: InstanceViewQuery; presentation: WorkerLifecyclePresentation; outbound: Pick<OutboundIntentPort, "enqueueCard">; workerCreation?: WorkerCreationGateway; wakeOutbound?: () => void;
  }) { this.projects = new Set(options.projects.map(({ id }) => id)); }

  async handle(action: IncomingLarkCardAction, command: Exclude<InstanceCardActionCommand, WorkerCardOnlyAction>): Promise<LarkCardActionResult> {
    if (command.action === "card_target_open") return this.openCardTarget(command, action.chatId);
    const actor = { kind: "human" as const, userId: action.operatorOpenId, channel: "feishu" as const };
    const conversationKey = command.conversationKey ?? action.chatId;
    const bindingContext = this.options.context.boundProject(conversationKey, action.chatId);
    if (bindingContext === "invalid") return warning("话题上下文已失效，请重新打开实例目录。");
    if (conversationKey.startsWith("binding:") && !this.options.context.isCurrentBindingCard(command, conversationKey, action.chatId)) return warning("话题上下文已变化，请重新打开实例目录。");
    if (command.action === "instance_create_form") {
      if (!this.projects.has(command.projectId)) return warning("项目不存在或已移除。");
      if (bindingContext && bindingContext !== command.projectId) return warning("当前话题已固定到其他项目。");
      const binding = command.bindingId ? this.options.store.getBinding(command.bindingId) : null;
      const rootMessageId = binding?.rootMessageId ?? action.messageId;
      const card = this.options.presentation.instanceCreate({ projectId: command.projectId, requestedBy: action.operatorOpenId, conversationKey, ...bindingCardContext(command) });
      await this.options.outbound.enqueueCard(rootMessageId, `instance-create-form:${action.messageId}:${action.operatorOpenId}:${command.projectId}`, card, binding?.id ?? null, "operation_result");
      this.options.wakeOutbound?.();
      return { toast: { type: "success", content: "创建 Worker 表单已发送到当前话题。" } };
    }
    if (command.action === "instance_create_submit") {
      if (command.requestedBy !== action.operatorOpenId) return forbidden();
      if (!this.projects.has(command.projectId)) return warning("项目不存在或已移除。");
      if (bindingContext && bindingContext !== command.projectId) return warning("当前话题已固定到其他项目。");
      const form = action.formValues ?? {};
      const agentKind: AgentKind | null = form.agent_kind === "pi" || form.agent_kind === "claude-code" || form.agent_kind === "codex" || form.agent_kind === "traex" ? form.agent_kind : null;
      const name = form.name?.trim() ?? "";
      if (!name || !agentKind) return { toast: { type: "error", content: "请填写有效的 Worker 名和 Agent。" } };
      try {
        const bindingId = conversationKey.startsWith("binding:") ? conversationKey.slice("binding:".length) : null;
        const createCommand = { kind: "worker_create" as const, name, agentKind, model: form.model?.trim() || null, start: form.start === "true" };
        const result = this.options.workerCreation
          ? bindingId ? await this.options.workerCreation.createWorkerFromCard(action, bindingId, createCommand) : (() => { throw new Error("Worker 创建需要活动的 Primary 话题。"); })()
          : await this.options.control.createWorker({ actor, projectId: command.projectId, ...createCommand, bindingId });
        this.options.wakeOutbound?.();
        if (result.status === "created-start-failed") return { toast: { type: "warning", content: `Worker ${result.instance.name} 已创建，但启动失败：${result.error}` }, card: this.options.views.detail(result.instance, conversationKey) };
        return { toast: { type: "success", content: `Worker ${result.instance.name} 已创建。` }, card: this.options.views.detail(result.instance, conversationKey) };
      } catch (error) { return failed(error); }
    }
    const instance = this.options.store.getAgentInstance(command.instanceId);
    if (!instance || instance.generation !== command.generation) return warning("实例状态已变化，请刷新后重试。");
    if (instance.role !== "worker") return warning("仅支持管理 Worker；当前 Thread 是唯一 Primary。");
    if (bindingContext && bindingContext !== instance.projectId) return warning("实例不属于当前话题项目。");
    if (!this.options.context.contains(instance, conversationKey)) return warning("实例状态已变化，请刷新后重试。");
    if (command.action === "instance_open") return { card: this.options.views.detail(instance, conversationKey) };
    if (command.action === "instance_turn_open") {
      const turn = this.options.store.getInstanceTurn(command.turnId); const view = this.options.store.loadWorkerTurnCard(command.turnId);
      if (!turn || !view || turn.instanceId !== instance.id || turn.instanceGeneration !== instance.generation || view.instanceId !== instance.id || view.instanceGeneration !== instance.generation) return warning("任务不存在或不属于当前 Worker。");
      return { card: this.options.presentation.workerTurn(view) };
    }
    if (command.action === "instance_set_target") {
      this.options.store.setConversationTarget({ chatId: conversationKey, projectId: instance.projectId, target: { kind: "instance", instanceId: instance.id, expectedGeneration: instance.generation } });
      return { toast: { type: "success", content: `当前目标已设为 ${instance.name}` } };
    }
    if (command.action === "instance_start") { await this.options.control.start({ actor, instanceId: instance.id }); return { toast: { type: "success", content: "实例启动已完成。" } }; }
    if (command.action === "instance_stop") { await this.options.control.stop({ actor, instanceId: instance.id }); return { toast: { type: "success", content: "实例已停止，worktree 已保留。" } }; }
    if (command.action === "instance_interrupt") {
      const result = await this.options.messaging.interrupt({ idempotencyKey: `card:${action.messageId}:interrupt:${instance.generation}`, actor, targetInstanceId: instance.id });
      return { toast: { type: result.status === "interrupted" ? "success" : "warning", content: `Stop: ${result.status}` } };
    }
    if (command.action === "instance_steer_form") return { card: this.options.presentation.instanceSteer({ instance, requestedBy: action.operatorOpenId, conversationKey, ...bindingCardContext(command) }) };
    if (command.action === "instance_steer_submit") {
      if (command.requestedBy !== action.operatorOpenId) return forbidden();
      const text = action.formValues?.steer_text?.trim() ?? "";
      if (!text) return { toast: { type: "error", content: "Steer 内容不能为空。" } };
      try {
        const result = await this.options.messaging.steer({ idempotencyKey: `card:${action.messageId}:steer:${instance.generation}`, actor, targetInstanceId: instance.id, text, resultTargetMessageId: action.messageId });
        return { toast: { type: result.status === "delivered" ? "success" : "warning", content: `Steer: ${result.status}` } };
      } catch (error) { return failed(error); }
    }
    if (command.action === "instance_plan_removal") {
      try {
        const plan = await this.options.control.planRemoval({ actor, instanceId: instance.id });
        const current = this.options.store.getAgentInstance(instance.id);
        if (!current || current.generation !== plan.instanceGeneration) return warning("实例状态已变化，请重新生成删除计划。");
        const workspace = this.options.store.getWorkspaceLease(current.workspaceLeaseId);
        if (!workspace || workspace.generation !== plan.workspaceGeneration) return warning("Worktree 状态已变化，请重新生成删除计划。");
        return { card: this.options.presentation.instanceRemovalPlan({ instance: current, workspace, plan, requestedBy: action.operatorOpenId, conversationKey, ...bindingCardContext(command) }) };
      } catch (error) { return failed(error); }
    }
    if (command.action === "instance_confirm_removal") {
      if (command.requestedBy !== action.operatorOpenId) return forbidden();
      const plan = this.options.store.getInstanceRemovalPlan(command.planId);
      const workspace = this.options.store.getWorkspaceLease(instance.workspaceLeaseId);
      if (!plan || plan.state !== "pending" || !plan.safe || plan.instanceId !== instance.id || plan.instanceGeneration !== instance.generation || !workspace || plan.workspaceGeneration !== workspace.generation) return warning("删除计划不安全或已失效，实例和 worktree 已保留。");
      try {
        const removed = await this.options.control.confirmRemoval({ actor, planId: plan.id });
        return { toast: { type: removed ? "success" : "warning", content: removed ? `实例 ${instance.name} 已删除。` : "实例未删除，请刷新后重试。" } };
      } catch (error) { return failed(error); }
    }
    return warning("未知的 Worker 操作。");
  }

  private openCardTarget(command: Extract<InstanceCardActionCommand, { action: "card_target_open" }>, chatId: string): LarkCardActionResult {
    const kind = command.aggregateKind; const id = command.aggregateId; const generation = command.generation; const messageId = command.messageId;
    if (kind === "worker-session") {
      const view = this.options.store.loadWorkerMainView(id, generation); const instance = this.options.store.getAgentInstance(id);
      if (!view || view.messageId !== messageId || !instance || instance.role !== "worker" || instance.workerSessionGeneration !== generation || instance.parent?.bindingId !== view.parentBindingId || instance.parent.paneId !== view.parentPaneId || !this.isOwnedCardBinding(command, chatId, view.parentBindingId, view.parentBindingGeneration, view.parentPaneId)) return warning("Worker 卡片已过期或不属于当前 Primary。");
      return { card: this.options.presentation.workerMain(view) };
    }
    if (kind === "worker-turn") {
      const view = this.options.store.loadWorkerTurnCard(id); const instance = view ? this.options.store.getAgentInstance(view.instanceId) : null;
      if (!view || view.instanceGeneration !== generation || view.messageId !== messageId || !instance || instance.role !== "worker" || instance.workerSessionGeneration !== view.workerSessionGeneration || !instance.parent || !this.isOwnedCardBinding(command, chatId, instance.parent.bindingId, instance.parent.bindingGeneration ?? 1, instance.parent.paneId)) return warning("Worker Task 卡片已过期或不属于当前 Primary。");
      return { card: this.options.presentation.workerTurn(view) };
    }
    if (kind === "primary-session") {
      const binding = this.options.store.getBinding(id); const view = this.options.store.loadTopicView(id);
      if (!binding || binding.chatId !== chatId || binding.generation !== generation || binding.statusMessageId !== messageId || !view) return warning("Primary 卡片已过期或不属于当前会话。");
      return { card: this.options.presentation.mainCard(view) };
    }
    if (kind === "primary-turn") {
      const view = this.options.store.loadRunCard(id); const binding = view ? this.options.store.getBinding(view.bindingId) : null;
      if (!view || !binding || binding.chatId !== chatId || view.bindingGeneration !== generation || view.answerMessageId !== messageId) return warning("Primary Answer 卡片已过期或不属于当前会话。");
      return { card: this.options.presentation.answerCard(view, { streaming: view.workerContextFrozenAt === null }) };
    }
    return warning("未知的卡片入口。");
  }

  private isOwnedCardBinding(value: BindingCardContext, chatId: string, bindingId: string, bindingGeneration: number, parentPaneId: string): boolean {
    return decideWorkerCardBindingOwnership({ chatId, conversationKey: value.conversationKey, suppliedBindingId: value.bindingId, suppliedBindingGeneration: value.bindingGeneration, bindingId, bindingGeneration, parentPaneId, binding: this.options.store.getBinding(bindingId) }).allowed;
  }
}

function forbidden(): LarkCardActionResult { return { toast: { type: "error", content: "只有发起此操作的用户可以提交。" } }; }
function warning(content: string): LarkCardActionResult { return { toast: { type: "warning", content } }; }
function bindingCardContext(value: BindingCardContext): { bindingId?: string; bindingGeneration?: number } { return value.bindingId ? { bindingId: value.bindingId, bindingGeneration: value.bindingGeneration! } : {}; }
function failed(error: unknown): LarkCardActionResult { return { toast: { type: "error", content: safeLogError(error).message } }; }
