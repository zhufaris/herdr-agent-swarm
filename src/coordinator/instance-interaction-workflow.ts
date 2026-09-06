import type { AgentInstance } from "../domain/agent-instance.js";
import type { InstanceCommand, IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult, ProjectConfig } from "../domain/types.js";
import type { InstanceStore } from "../domain/ports/instance.js";
import type { OutboundIntentPort } from "../domain/ports/outbox.js";
import type { InstanceControlWorkflow } from "./instance-control-workflow.js";
import type { InstanceMessagingWorkflow } from "./instance-messaging-workflow.js";
import type { AgentDriverRegistry } from "../runtime/agents/agent-driver.js";
import { renderInstanceDirectoryCard } from "../cards/instance-directory-card.js";
import { renderInstanceDetailCard } from "../cards/instance-detail-card.js";
import { renderInstanceCreateCard, renderInstanceRemovalPlanCard, renderInstanceSteerCard, renderWorkerNewTaskCard, renderWorkerTaskInstructionCard } from "../cards/instance-control-card.js";
import { renderMessageRejectedCard } from "../cards/run-card.js";
import { renderWorkerTurnCard } from "../cards/worker-turn-card.js";
import { renderWorkerMainCard } from "../cards/worker-main-card.js";
import { renderProjectEntryCard, renderRequestAnswerCard } from "../cards/run-card.js";
import { safeLogError } from "../runtime/safe-error.js";
import { workerTaskInteraction, type WorkerTaskReplyIntent } from "../domain/worker-task-interaction.js";
import { canSubmitWorkerMainTask } from "../domain/worker-main-view.js";
import { randomUUID } from "node:crypto";

interface WorkerCreationGateway { createWorkerFromCard(action: IncomingLarkCardAction, bindingId: string, command: { kind: "worker_create"; name: string; agentKind: import("../domain/agent-instance.js").AgentKind; model: string | null; start: boolean }): Promise<import("../domain/agent-instance.js").CreateWorkerResult> }
interface Options { projects: readonly ProjectConfig[]; adminOpenIds: readonly string[]; store: InstanceStore; control: InstanceControlWorkflow; messaging: InstanceMessagingWorkflow; drivers: AgentDriverRegistry; outbound: OutboundIntentPort; workerCreation?: WorkerCreationGateway; idFactory?: () => string }
export class InstanceInteractionWorkflow {
  private readonly projects: ReadonlyMap<string, ProjectConfig>;
  private readonly idFactory: () => string;
  constructor(private readonly options: Options) { this.projects = new Map(options.projects.map((project) => [project.id, project])); this.idFactory = options.idFactory ?? randomUUID; }

  async handleCommand(message: IncomingLarkMessage, command: InstanceCommand): Promise<void> {
    if (!this.isOperator(message.actorOpenId)) return this.reject(message, "你没有 Agent 管理权限。");
    const actor = { kind: "human" as const, userId: message.actorOpenId, channel: "feishu" as const };
    const context = this.resolveConversationContext(message);
    const current = this.getSelectedTarget(context, message.chatId);
    if (command.kind === "projects") return this.reply(message, projectCard(this.options.projects, current?.projectId));
    if (command.kind === "project") {
      const project = this.projects.get(command.projectId);
      if (!project) return this.reject(message, "项目不存在。");
      if (context.boundProjectId && context.boundProjectId !== project.id) return this.reject(message, `当前话题已固定到项目 ${context.boundProjectId}，不能切换到 ${project.id}。`);
      this.options.store.setConversationTarget({ chatId: context.conversationKey, projectId: project.id, target: { kind: "primary" } });
      return this.showDirectory(message, project.id, context.conversationKey);
    }
    if (context.bindingPresent && !context.boundProjectId) return this.reject(message, "当前话题绑定缺少有效项目，请联系管理员修复绑定。");
    const projectId = context.boundProjectId ?? current?.projectId;
    if (!projectId || !this.projects.has(projectId)) return this.reject(message, "请先使用 `/project <id>` 选择项目。");
    if (command.kind === "instances") return this.showDirectory(message, projectId, context.conversationKey);
    const instance = this.findByName(context.conversationKey, command.name);
    if (!instance) return this.reject(message, `实例不存在：${command.name}`);
    if (command.kind === "instance") return this.showDetail(message, instance, context.conversationKey);
    if (command.kind === "to") {
      await this.options.messaging.submit({ idempotencyKey: `lark:${message.messageId}`, actor, projectId, targetInstanceId: instance.id, content: { kind: "turn", text: command.text }, source: { messageId: message.messageId, rootMessageId: message.rootMessageId ?? message.messageId } });
      return;
    }
    if (command.kind === "steer_instance") {
      const result = await this.options.messaging.steer({ idempotencyKey: `lark:${message.messageId}:steer`, actor, targetInstanceId: instance.id, text: command.text, resultTargetMessageId: message.rootMessageId ?? message.messageId });
      if (result.durableResult === false) await this.reply(message, statusCard(`Steer: ${result.status}`));
      return;
    }
    const result = await this.options.messaging.interrupt({ idempotencyKey: `lark:${message.messageId}:interrupt`, actor, targetInstanceId: instance.id });
    return this.reply(message, statusCard(`Stop: ${result.status}`));
  }

  async handleOrdinaryMessage(message: IncomingLarkMessage): Promise<boolean> {
    if (message.parentMessageId) return this.handleWorkerCardReply(message);
    const context = this.resolveConversationContext(message);
    const selected = this.getSelectedTarget(context, message.chatId);
    const projectId = context.boundProjectId ?? selected?.projectId;
    if (!projectId) return false;
    const current = selected?.projectId === projectId ? selected : null;
    if (!this.isOperator(message.actorOpenId)) { await this.reject(message, "你没有 Agent 管理权限。"); return true; }
    if (!current || current.target.kind === "primary") return false;
    const selectedTarget = current.target;
    const target = this.listScopedWorkers(context.conversationKey).find(({ id }) => id === selectedTarget.instanceId) ?? null;
    if (!target) { await this.showDirectory(message, projectId, context.conversationKey); return true; }
    if (selectedTarget.expectedGeneration !== undefined && selectedTarget.expectedGeneration !== target.generation) {
      await this.reject(message, "当前目标实例已重新启动，请从实例目录重新选择。"); return true;
    }
    await this.options.messaging.submit({ idempotencyKey: `lark:${message.messageId}`, actor: { kind: "human", userId: message.actorOpenId, channel: "feishu" }, projectId, targetInstanceId: target.id, content: { kind: "turn", text: message.text }, source: { messageId: message.messageId, rootMessageId: message.rootMessageId ?? message.messageId } });
    return true;
  }

  private async handleWorkerCardReply(message: IncomingLarkMessage): Promise<boolean> {
    const matched = this.options.store.findWorkerTurnByCardMessage(message.parentMessageId!);
    if (!matched) return false;
    if (!message.mentionsBot) return false;
    if (!this.isOperator(message.actorOpenId)) { await this.reject(message, "你没有 Agent 管理权限。"); return true; }
    const { turn, view } = matched;
    const context = this.resolveConversationContext(message);
    const instance = this.listScopedWorkers(context.conversationKey).find(({ id }) => id === turn.instanceId);
    if (!instance || turn.instanceGeneration !== instance.generation || view.instanceId !== instance.id || view.instanceGeneration !== instance.generation
      || view.workerSessionGeneration !== instance.workerSessionGeneration) {
      await this.reject(message, "任务卡片已过期，或不属于当前 Primary/Worker session。"); return true;
    }
    const actor = { kind: "human" as const, userId: message.actorOpenId, channel: "feishu" as const };
    const interaction = workerTaskInteraction(view.phase);
    if (interaction.replyIntent === "steer") {
      const result = await this.options.messaging.steer({ idempotencyKey: `lark:${message.messageId}:steer`, actor, targetInstanceId: turn.instanceId, targetTurnId: turn.id, text: message.text, resultTargetMessageId: message.rootMessageId ?? message.messageId });
      if (result.durableResult === false) await this.reply(message, statusCard(`Steer: ${result.status}`));
      return true;
    }
    if (interaction.replyIntent === "followup") {
      await this.options.messaging.submit({
        idempotencyKey: `lark:${message.messageId}`, actor, projectId: turn.projectId, targetInstanceId: turn.instanceId,
        content: { kind: "followup", text: message.text },
        source: { messageId: message.messageId, rootMessageId: message.rootMessageId ?? message.messageId, parentTurnId: turn.id }
      });
      return true;
    }
    await this.reject(message, interaction.guidance);
    return true;
  }

  async handleCardAction(action: IncomingLarkCardAction): Promise<LarkCardActionResult | void> {
    if (!action.value || typeof action.value !== "object") return;
    const value = action.value as Record<string, unknown>;
    if (typeof value.action !== "string" || (!value.action.startsWith("instance_") && !value.action.startsWith("worker_") && value.action !== "card_target_open")) return;
    if (!this.isOperator(action.operatorOpenId)) return { toast: { type: "error", content: "你没有 Agent 管理权限。" } };
    if (value.action === "card_target_open") return this.openCardTarget(value, action.chatId);
    if (value.action.startsWith("worker_task_")) return this.handleWorkerTaskAction(action, value);
    if (value.action.startsWith("worker_new_task_")) return this.handleWorkerNewTaskAction(action, value);
    const actor = { kind: "human" as const, userId: action.operatorOpenId, channel: "feishu" as const };
    const conversationKey = typeof value.conversationKey === "string" && value.conversationKey.length <= 200 ? value.conversationKey : action.chatId;
    const bindingContext = this.boundProjectForConversationKey(conversationKey, action.chatId);
    if (bindingContext === "invalid") return warning("话题上下文已失效，请重新打开实例目录。");
    if (conversationKey.startsWith("binding:") && !this.isCurrentBindingCard(value, conversationKey, action.chatId)) return warning("话题上下文已变化，请重新打开实例目录。");
    if (value.action === "instance_create_form") {
      const projectId = typeof value.projectId === "string" ? value.projectId : "";
      if (!this.projects.has(projectId)) return warning("项目不存在或已移除。");
      if (bindingContext && bindingContext !== projectId) return warning("当前话题已固定到其他项目。");
      return { card: renderInstanceCreateCard({ projectId, requestedBy: action.operatorOpenId, conversationKey, ...bindingCardContext(value) }) };
    }
    if (value.action === "instance_create_submit") {
      if (!sameOperator(value, action)) return forbidden();
      const projectId = typeof value.projectId === "string" ? value.projectId : "";
      if (!this.projects.has(projectId)) return warning("项目不存在或已移除。");
      if (bindingContext && bindingContext !== projectId) return warning("当前话题已固定到其他项目。");
      const form = action.formValues ?? {};
      const agentKind: import("../domain/agent-instance.js").AgentKind | null = form.agent_kind === "pi" || form.agent_kind === "claude-code" || form.agent_kind === "codex" || form.agent_kind === "traex" ? form.agent_kind : null;
      const name = form.name?.trim() ?? "";
      if (!name || !agentKind) return { toast: { type: "error", content: "请填写有效的 Worker 名和 Agent。" } };
      try {
        const bindingId = conversationKey.startsWith("binding:") ? conversationKey.slice("binding:".length) : null;
        const command = { kind: "worker_create" as const, name, agentKind, model: form.model?.trim() || null, start: form.start === "true" };
        const result = this.options.workerCreation
          ? bindingId ? await this.options.workerCreation.createWorkerFromCard(action, bindingId, command) : (() => { throw new Error("Worker 创建需要活动的 Primary 话题。"); })()
          : await this.options.control.createWorker({ actor, projectId, ...command, bindingId });
        if (result.status === "created-start-failed") return { toast: { type: "warning", content: `Worker ${result.instance.name} 已创建，但启动失败：${result.error}` }, card: this.detailCard(result.instance, conversationKey) };
        return { toast: { type: "success", content: `Worker ${result.instance.name} 已创建。` }, card: this.detailCard(result.instance, conversationKey) };
      } catch (error) { return failed(error); }
    }
    const instance = typeof value.instanceId === "string" ? this.options.store.getAgentInstance(value.instanceId) : null;
    if (!instance || instance.generation !== Number(value.generation)) return { toast: { type: "warning", content: "实例状态已变化，请刷新后重试。" } };
    if (instance.role !== "worker") return warning("仅支持管理 Worker；当前 Thread 是唯一 Primary。");
    if (bindingContext && bindingContext !== instance.projectId) return warning("实例不属于当前话题项目。");
    if (!this.workerBelongsToConversation(instance, conversationKey)) return warning("实例状态已变化，请刷新后重试。");
    if (value.action === "instance_open") return { card: this.detailCard(instance, conversationKey) };
    if (value.action === "instance_turn_open") {
      const turnId = typeof value.turnId === "string" ? value.turnId : "";
      const turn = this.options.store.getInstanceTurn(turnId);
      const view = this.options.store.loadWorkerTurnCard(turnId);
      if (!turn || !view || turn.instanceId !== instance.id || turn.instanceGeneration !== instance.generation || view.instanceId !== instance.id || view.instanceGeneration !== instance.generation) return warning("任务不存在或不属于当前 Worker。");
      return { card: renderWorkerTurnCard(view) };
    }
    if (value.action === "instance_set_target") {
      this.options.store.setConversationTarget({ chatId: conversationKey, projectId: instance.projectId, target: { kind: "instance", instanceId: instance.id, expectedGeneration: instance.generation } });
      return { toast: { type: "success", content: `当前目标已设为 ${instance.name}` } };
    }
    if (value.action === "instance_start") {
      await this.options.control.start({ actor, instanceId: instance.id });
      return { toast: { type: "success", content: "实例启动已完成。" } };
    }
    if (value.action === "instance_stop") {
      await this.options.control.stop({ actor, instanceId: instance.id });
      return { toast: { type: "success", content: "实例已停止，worktree 已保留。" } };
    }
    if (value.action === "instance_interrupt") {
      const result = await this.options.messaging.interrupt({ idempotencyKey: `card:${action.messageId}:interrupt:${instance.generation}`, actor, targetInstanceId: instance.id });
      return { toast: { type: result.status === "interrupted" ? "success" : "warning", content: `Stop: ${result.status}` } };
    }
    if (value.action === "instance_steer_form") return { card: renderInstanceSteerCard({ instance, requestedBy: action.operatorOpenId, conversationKey, ...bindingCardContext(value) }) };
    if (value.action === "instance_steer_submit") {
      if (!sameOperator(value, action)) return forbidden();
      const text = action.formValues?.steer_text?.trim() ?? "";
      if (!text) return { toast: { type: "error", content: "Steer 内容不能为空。" } };
      try {
        const result = await this.options.messaging.steer({ idempotencyKey: `card:${action.messageId}:steer:${instance.generation}`, actor, targetInstanceId: instance.id, text, resultTargetMessageId: action.messageId });
        return { toast: { type: result.status === "delivered" ? "success" : "warning", content: `Steer: ${result.status}` } };
      } catch (error) { return failed(error); }
    }
    if (value.action === "instance_plan_removal") {
      try {
        const plan = await this.options.control.planRemoval({ actor, instanceId: instance.id });
        const current = this.options.store.getAgentInstance(instance.id);
        if (!current || current.generation !== plan.instanceGeneration) return warning("实例状态已变化，请重新生成删除计划。");
        const workspace = this.options.store.getWorkspaceLease(current.workspaceLeaseId);
        if (!workspace || workspace.generation !== plan.workspaceGeneration) return warning("Worktree 状态已变化，请重新生成删除计划。");
        return { card: renderInstanceRemovalPlanCard({ instance: current, workspace, plan, requestedBy: action.operatorOpenId, conversationKey, ...bindingCardContext(value) }) };
      } catch (error) { return failed(error); }
    }
    if (value.action === "instance_confirm_removal") {
      if (!sameOperator(value, action)) return forbidden();
      const plan = typeof value.planId === "string" ? this.options.store.getInstanceRemovalPlan(value.planId) : null;
      const workspace = this.options.store.getWorkspaceLease(instance.workspaceLeaseId);
      if (!plan || plan.state !== "pending" || !plan.safe || plan.instanceId !== instance.id || plan.instanceGeneration !== instance.generation || !workspace || plan.workspaceGeneration !== workspace.generation) return warning("删除计划不安全或已失效，实例和 worktree 已保留。");
      try {
        const removed = await this.options.control.confirmRemoval({ actor, planId: plan.id });
        return { toast: { type: removed ? "success" : "warning", content: removed ? `实例 ${instance.name} 已删除。` : "实例未删除，请刷新后重试。" } };
      } catch (error) { return failed(error); }
    }
  }

  private async handleWorkerTaskAction(action: IncomingLarkCardAction, value: Record<string, unknown>): Promise<LarkCardActionResult> {
    const owned = this.resolveOwnedTaskAction(action, value);
    if (!owned) return warning("Worker Task 卡片已过期、状态已变化或不属于当前 Primary。");
    const { instance, turn, view, intent } = owned;
    if (value.action === "worker_task_instruction_form") {
      if (intent === "reject") return warning(workerTaskInteraction(view.phase).guidance);
      return { card: renderWorkerTaskInstructionCard({ workerName: instance.name, turnId: turn.id, intent, interactionId: this.idFactory(), requestedBy: action.operatorOpenId, sourceCardMessageId: view.messageId!, instanceId: instance.id, generation: instance.generation, workerSessionGeneration: instance.workerSessionGeneration }) };
    }
    if (value.action === "worker_task_interrupt") {
      if (!workerTaskInteraction(view.phase).canInterrupt) return warning("任务已不处于可停止的运行状态。");
      const result = await this.options.messaging.interrupt({ idempotencyKey: `card:${action.messageId}:interrupt:${turn.id}`, actor: { kind: "human", userId: action.operatorOpenId, channel: "feishu" }, targetInstanceId: instance.id, targetTurnId: turn.id });
      return { toast: { type: result.status === "interrupted" ? "success" : "warning", content: result.status === "interrupted" ? `已停止 ${instance.name} 的当前任务。` : `停止当前任务：${result.status}` } };
    }
    if (value.action !== "worker_task_instruction_submit") return warning("未知的 Worker Task 操作。");
    if (!sameOperator(value, action)) return forbidden();
    const interactionId = validInteractionId(value.interactionId);
    if (!interactionId) return warning("操作标识无效，请重新打开表单。");
    const requestedIntent = value.intent === "steer" || value.intent === "followup" ? value.intent : null;
    if (!requestedIntent || requestedIntent !== intent) return warning("任务状态已变化，请重新打开 Task Card 后再操作。");
    const text = action.formValues?.instruction_text?.trim() ?? "";
    if (!text) return { toast: { type: "error", content: "任务要求不能为空。" } };
    const actor = { kind: "human" as const, userId: action.operatorOpenId, channel: "feishu" as const };
    try {
      if (intent === "steer") {
        const result = await this.options.messaging.steer({ idempotencyKey: `card:${interactionId}:task-steer:${turn.id}`, actor, targetInstanceId: instance.id, targetTurnId: turn.id, text, resultTargetMessageId: action.messageId });
        return { toast: { type: result.status === "delivered" ? "success" : "warning", content: result.status === "delivered" ? `已补充到 ${instance.name} 的当前任务。` : `补充当前任务：${result.status}` } };
      }
      const submitted = await this.options.messaging.submit({ idempotencyKey: `card:${interactionId}:task-followup:${turn.id}`, actor, projectId: turn.projectId, targetInstanceId: instance.id, content: { kind: "followup", text }, source: { messageId: action.messageId, rootMessageId: view.rootMessageId, parentTurnId: turn.id } });
      return { toast: { type: "success", content: `已创建 ${instance.name} 的后续任务，当前排队位置 ${submitted.card?.queuePosition ?? 1}。` } };
    } catch (error) { return failed(error); }
  }

  private async handleWorkerNewTaskAction(action: IncomingLarkCardAction, value: Record<string, unknown>): Promise<LarkCardActionResult> {
    const owned = this.resolveOwnedMainAction(action, value);
    if (!owned) return warning("Worker Main 卡片已过期、状态已变化或不属于当前 Primary。");
    const { instance, view } = owned;
    if (value.action === "worker_new_task_form") return { card: renderWorkerNewTaskCard({ workerName: instance.name, interactionId: this.idFactory(), requestedBy: action.operatorOpenId, sourceCardMessageId: view.messageId!, instanceId: instance.id, generation: instance.generation, workerSessionGeneration: instance.workerSessionGeneration }) };
    if (value.action !== "worker_new_task_submit") return warning("未知的 Worker 新任务操作。");
    if (!sameOperator(value, action)) return forbidden();
    const interactionId = validInteractionId(value.interactionId);
    if (!interactionId) return warning("操作标识无效，请重新打开表单。");
    const text = action.formValues?.task_text?.trim() ?? "";
    if (!text) return { toast: { type: "error", content: "新任务内容不能为空。" } };
    try {
      const submitted = await this.options.messaging.submit({ idempotencyKey: `card:${interactionId}:worker-new-task:${instance.id}`, actor: { kind: "human", userId: action.operatorOpenId, channel: "feishu" }, projectId: instance.projectId, targetInstanceId: instance.id, content: { kind: "turn", text }, source: { messageId: action.messageId, rootMessageId: view.messageId! } });
      return { toast: { type: "success", content: `已向 ${instance.name} 发起新任务，当前排队位置 ${submitted.card?.queuePosition ?? 1}。` } };
    } catch (error) { return failed(error); }
  }

  private resolveOwnedTaskAction(action: IncomingLarkCardAction, value: Record<string, unknown>): { instance: AgentInstance; turn: NonNullable<ReturnType<InstanceStore["getInstanceTurn"]>>; view: NonNullable<ReturnType<InstanceStore["loadWorkerTurnCard"]>>; intent: WorkerTaskReplyIntent } | null {
    const turnId = typeof value.turnId === "string" ? value.turnId : "";
    const sourceCardMessageId = typeof value.sourceCardMessageId === "string" ? value.sourceCardMessageId : "";
    const turn = this.options.store.getInstanceTurn(turnId); const view = this.options.store.loadWorkerTurnCard(turnId);
    const instance = turn ? this.options.store.getAgentInstance(turn.instanceId) : null;
    if (!turn || !view || !instance || instance.role !== "worker" || action.chatId !== this.options.store.getBinding(instance.parent?.bindingId ?? "")?.chatId
      || view.messageId !== sourceCardMessageId || action.messageId !== sourceCardMessageId || view.instanceId !== instance.id || turn.instanceId !== instance.id
      || instance.generation !== Number(value.generation) || turn.instanceGeneration !== instance.generation || view.instanceGeneration !== instance.generation
      || instance.workerSessionGeneration !== Number(value.workerSessionGeneration) || view.workerSessionGeneration !== instance.workerSessionGeneration || !instance.parent) return null;
    const binding = this.options.store.getBinding(instance.parent.bindingId);
    if (!binding || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached" || binding.paneId !== instance.parent.paneId || binding.generation !== (instance.parent.bindingGeneration ?? 1)) return null;
    return { instance, turn, view, intent: workerTaskInteraction(view.phase).replyIntent };
  }

  private resolveOwnedMainAction(action: IncomingLarkCardAction, value: Record<string, unknown>): { instance: AgentInstance; view: NonNullable<ReturnType<InstanceStore["loadWorkerMainView"]>> } | null {
    const instanceId = typeof value.instanceId === "string" ? value.instanceId : ""; const generation = Number(value.generation); const sessionGeneration = Number(value.workerSessionGeneration);
    const sourceCardMessageId = typeof value.sourceCardMessageId === "string" ? value.sourceCardMessageId : "";
    const instance = this.options.store.getAgentInstance(instanceId); const view = this.options.store.loadWorkerMainView(instanceId, sessionGeneration);
    if (!instance || !view || instance.role !== "worker" || instance.generation !== generation || instance.workerSessionGeneration !== sessionGeneration || view.runtimeGeneration !== generation
      || view.messageId !== sourceCardMessageId || action.messageId !== sourceCardMessageId || !instance.parent) return null;
    const binding = this.options.store.getBinding(instance.parent.bindingId);
    const parentActive = Boolean(binding && binding.chatId === action.chatId && binding.lifecycle === "active" && binding.state === "active" && binding.attachment === "attached" && binding.paneId === instance.parent.paneId && binding.generation === view.parentBindingGeneration);
    if (!canSubmitWorkerMainTask({ ...view, runtimeAttached: instance.runtimeRef !== null, desiredState: instance.desiredState, parentActive })) return null;
    return { instance, view };
  }

  private openCardTarget(value: Record<string, unknown>, chatId: string): LarkCardActionResult {
    const kind = value.aggregateKind; const id = typeof value.aggregateId === "string" ? value.aggregateId : ""; const generation = Number(value.generation); const messageId = typeof value.messageId === "string" ? value.messageId : "";
    if (!id || !Number.isInteger(generation) || !messageId) return warning("卡片入口尚未完成投递，请稍后重试。");
    if (kind === "worker-session") {
      const view = this.options.store.loadWorkerMainView(id, generation);
      const instance = this.options.store.getAgentInstance(id);
      if (!view || view.messageId !== messageId || !instance || instance.role !== "worker" || instance.workerSessionGeneration !== generation
        || instance.parent?.bindingId !== view.parentBindingId || instance.parent.paneId !== view.parentPaneId
        || !this.isOwnedCardBinding(value, chatId, view.parentBindingId, view.parentBindingGeneration, view.parentPaneId)) return warning("Worker 卡片已过期或不属于当前 Primary。");
      return { card: renderWorkerMainCard(view) };
    }
    if (kind === "worker-turn") {
      const view = this.options.store.loadWorkerTurnCard(id); const instance = view ? this.options.store.getAgentInstance(view.instanceId) : null;
      if (!view || view.instanceGeneration !== generation || view.messageId !== messageId || !instance || instance.role !== "worker"
        || instance.workerSessionGeneration !== view.workerSessionGeneration || !instance.parent
        || !this.isOwnedCardBinding(value, chatId, instance.parent.bindingId, instance.parent.bindingGeneration ?? 1, instance.parent.paneId)) return warning("Worker Task 卡片已过期或不属于当前 Primary。");
      return { card: renderWorkerTurnCard(view) };
    }
    if (kind === "primary-session") {
      const binding = this.options.store.getBinding(id); const view = this.options.store.loadTopicView(id);
      if (!binding || binding.chatId !== chatId || binding.generation !== generation || binding.statusMessageId !== messageId || !view) return warning("Primary 卡片已过期或不属于当前会话。");
      return { card: renderProjectEntryCard(view) };
    }
    if (kind === "primary-turn") {
      const view = this.options.store.loadRunCard(id); const binding = view ? this.options.store.getBinding(view.bindingId) : null;
      if (!view || !binding || binding.chatId !== chatId || view.bindingGeneration !== generation || view.answerMessageId !== messageId) return warning("Primary Answer 卡片已过期或不属于当前会话。");
      return { card: renderRequestAnswerCard(view, { streaming: view.workerContextFrozenAt === null }) };
    }
    return warning("未知的卡片入口。");
  }

  private isOwnedCardBinding(value: Record<string, unknown>, chatId: string, bindingId: string, bindingGeneration: number, parentPaneId: string): boolean {
    const binding = this.options.store.getBinding(bindingId);
    if (!binding || binding.chatId !== chatId || binding.generation !== bindingGeneration || binding.paneId !== parentPaneId) return false;
    if (typeof value.conversationKey === "string" && value.conversationKey !== `binding:${bindingId}`) return false;
    if (typeof value.bindingId === "string" && value.bindingId !== bindingId) return false;
    if (value.bindingGeneration !== undefined && Number(value.bindingGeneration) !== bindingGeneration) return false;
    return true;
  }

  private async showDirectory(message: IncomingLarkMessage, projectId: string, conversationKey: string): Promise<void> {
    const project = this.projects.get(projectId)!; const selected = this.options.store.getConversationTarget(conversationKey); const target = selected?.projectId === projectId ? selected.target : { kind: "primary" as const };
    const binding = conversationKey.startsWith("binding:") ? this.options.store.getBinding(conversationKey.slice("binding:".length)) : null;
    const entries = binding?.paneId ? this.options.control.listWorkersForParent({ bindingId: binding.id, paneId: binding.paneId }).map((instance) => ({ instance, workspace: this.options.control.inspect(instance.id).workspace, capabilities: this.options.drivers.describe(instance.agentKind), queueDepth: this.options.store.countPendingInstanceTurns(instance.id) })) : [];
    const primary = binding ? { bindingId: binding.id, generation: binding.generation, paneId: binding.paneId, state: binding.state } : null;
    await this.reply(message, renderInstanceDirectoryCard({ project, entries, target, primary, conversationKey }));
  }
  private async showDetail(message: IncomingLarkMessage, instance: AgentInstance, conversationKey: string): Promise<void> { await this.reply(message, this.detailCard(instance, conversationKey)); }
  private detailCard(instance: AgentInstance, conversationKey: string): object {
    const view = this.options.control.inspect(instance.id);
    const binding = conversationKey.startsWith("binding:") ? this.options.store.getBinding(conversationKey.slice("binding:".length)) : null;
    return renderInstanceDetailCard({ ...view, capabilities: this.options.drivers.describe(instance.agentKind), turns: this.options.store.listRecentInstanceTurnSummaries(instance.id), activeTurnId: this.options.store.getActiveInstanceTurn(instance.id, instance.generation)?.id ?? null, queueDepth: this.options.store.countPendingInstanceTurns(instance.id), conversationKey, ...(binding ? { bindingId: binding.id, bindingGeneration: binding.generation } : {}) });
  }
  private resolveConversationContext(message: IncomingLarkMessage): { bindingPresent: boolean; boundProjectId: string | null; conversationKey: string } {
    const binding = this.options.store.findBindingByLarkScope(message.topicId, message.rootMessageId);
    if (binding) return { bindingPresent: true, boundProjectId: binding.projectId, conversationKey: `binding:${binding.id}` };
    if (message.topicId) return { bindingPresent: false, boundProjectId: null, conversationKey: `topic:${message.topicId}` };
    if (message.rootMessageId) return { bindingPresent: false, boundProjectId: null, conversationKey: `root:${message.rootMessageId}` };
    return { bindingPresent: false, boundProjectId: null, conversationKey: message.chatId };
  }
  private getSelectedTarget(context: { bindingPresent: boolean; conversationKey: string }, chatId: string): ReturnType<InstanceStore["getConversationTarget"]> {
    return this.options.store.getConversationTarget(context.conversationKey) ?? (!context.bindingPresent && context.conversationKey !== chatId ? this.options.store.getConversationTarget(chatId) : null);
  }
  private boundProjectForConversationKey(conversationKey: string, chatId: string): string | "invalid" | null {
    if (!conversationKey.startsWith("binding:")) return null;
    const binding = this.options.store.getBinding(conversationKey.slice("binding:".length));
    if (!binding || binding.chatId !== chatId || !binding.projectId) return "invalid";
    return binding.projectId;
  }
  private isCurrentBindingCard(value: Record<string, unknown>, conversationKey: string, chatId: string): boolean {
    const bindingId = conversationKey.slice("binding:".length);
    const binding = this.options.store.getBinding(bindingId);
    return Boolean(binding && binding.chatId === chatId && binding.state === "active" && binding.lifecycle === "active" && binding.attachment === "attached" && value.bindingId === binding.id && Number(value.bindingGeneration) === binding.generation);
  }
  private listScopedWorkers(conversationKey: string): AgentInstance[] {
    if (!conversationKey.startsWith("binding:")) return [];
    const binding = this.options.store.getBinding(conversationKey.slice("binding:".length));
    if (!binding?.paneId || binding.lifecycle !== "active" || binding.state !== "active" || binding.attachment !== "attached") return [];
    return this.options.control.listWorkersForParent({ bindingId: binding.id, paneId: binding.paneId });
  }
  private workerBelongsToConversation(instance: AgentInstance, conversationKey: string): boolean {
    return this.listScopedWorkers(conversationKey).some(({ id }) => id === instance.id);
  }
  private findByName(conversationKey: string, name: string): AgentInstance | null { return this.listScopedWorkers(conversationKey).find((item) => item.name === name) ?? null; }
  private isOperator(openId: string): boolean { return this.options.adminOpenIds.includes(openId); }
  private reply(message: IncomingLarkMessage, card: object): Promise<void> { return this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `instance:${message.messageId}:${JSON.stringify(card)}`, card); }
  private reject(message: IncomingLarkMessage, reason: string): Promise<void> { return this.reply(message, renderMessageRejectedCard(reason)); }
}

function projectCard(projects: readonly ProjectConfig[], selected?: string): object { return { schema: "2.0", header: { title: { tag: "plain_text", content: "Projects" }, template: "blue" }, body: { elements: projects.map((project) => ({ tag: "markdown", content: `${project.id === selected ? "▶ " : ""}**${project.displayName}** · \`${project.id}\`\n${project.description}` })) } }; }
function statusCard(text: string): object { return { schema: "2.0", header: { title: { tag: "plain_text", content: "Agent control" }, template: "blue" }, body: { elements: [{ tag: "markdown", content: text }] } }; }
function sameOperator(value: Record<string, unknown>, action: IncomingLarkCardAction): boolean { return typeof value.requestedBy === "string" && value.requestedBy === action.operatorOpenId; }
function validInteractionId(value: unknown): string | null { return typeof value === "string" && /^[A-Za-z0-9_-]{1,128}$/.test(value) ? value : null; }
function forbidden(): LarkCardActionResult { return { toast: { type: "error", content: "只有发起此操作的用户可以提交。" } }; }
function warning(content: string): LarkCardActionResult { return { toast: { type: "warning", content } }; }
function bindingCardContext(value: Record<string, unknown>): { bindingId?: string; bindingGeneration?: number } {
  return typeof value.bindingId === "string" && Number.isInteger(Number(value.bindingGeneration)) ? { bindingId: value.bindingId, bindingGeneration: Number(value.bindingGeneration) } : {};
}
function failed(error: unknown): LarkCardActionResult { return { toast: { type: "error", content: safeLogError(error).message } }; }
