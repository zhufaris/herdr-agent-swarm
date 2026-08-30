import type { AgentInstance } from "../domain/agent-instance.js";
import type { InstanceCommand, IncomingLarkCardAction, IncomingLarkMessage, LarkCardActionResult, ProjectConfig } from "../domain/types.js";
import type { InstanceStore, OutboundIntentPort } from "../domain/ports.js";
import type { InstanceControlWorkflow } from "./instance-control-workflow.js";
import type { InstanceMessagingWorkflow } from "./instance-messaging-workflow.js";
import type { AgentDriverRegistry } from "../runtime/agents/agent-driver.js";
import { renderInstanceDirectoryCard } from "../cards/instance-directory-card.js";
import { renderInstanceDetailCard } from "../cards/instance-detail-card.js";
import { renderInstanceCreateCard, renderInstanceRemovalPlanCard, renderInstanceSteerCard } from "../cards/instance-control-card.js";
import { renderMessageRejectedCard } from "../cards/run-card.js";

interface Options { projects: readonly ProjectConfig[]; operatorOpenIds?: readonly string[]; store: InstanceStore; control: InstanceControlWorkflow; messaging: InstanceMessagingWorkflow; drivers: AgentDriverRegistry; outbound: OutboundIntentPort }
export class InstanceInteractionWorkflow {
  private readonly projects: ReadonlyMap<string, ProjectConfig>;
  constructor(private readonly options: Options) { this.projects = new Map(options.projects.map((project) => [project.id, project])); }

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
    const instance = this.findByName(projectId, command.name);
    if (!instance) return this.reject(message, `实例不存在：${command.name}`);
    if (command.kind === "instance") return this.showDetail(message, instance, context.conversationKey);
    if (command.kind === "to") { await this.options.messaging.submit({ idempotencyKey: `lark:${message.messageId}`, actor, projectId, targetInstanceId: instance.id, content: { kind: "turn", text: command.text } }); return this.reply(message, statusCard(`已提交给 ${instance.name}`)); }
    if (command.kind === "steer_instance") { const result = await this.options.messaging.steer({ idempotencyKey: `lark:${message.messageId}:steer`, actor, targetInstanceId: instance.id, text: command.text }); return this.reply(message, statusCard(`Steer: ${result.status}`)); }
    const result = await this.options.messaging.interrupt({ idempotencyKey: `lark:${message.messageId}:interrupt`, actor, targetInstanceId: instance.id });
    return this.reply(message, statusCard(`Interrupt: ${result.status}`));
  }

  async handleOrdinaryMessage(message: IncomingLarkMessage): Promise<boolean> {
    const context = this.resolveConversationContext(message);
    const selected = this.getSelectedTarget(context, message.chatId);
    const projectId = context.boundProjectId ?? selected?.projectId;
    if (!projectId) return false;
    const current = selected?.projectId === projectId ? selected : { projectId, target: { kind: "primary" as const } };
    if (!this.isOperator(message.actorOpenId)) { await this.reject(message, "你没有 Agent 管理权限。"); return true; }
    const instances = this.options.control.list(current.projectId);
    const fixedTargetId = current.target.kind === "instance" ? current.target.instanceId : null;
    const target = fixedTargetId === null
      ? instances.find(({ role }) => role === "primary") ?? null
      : instances.find(({ id }) => id === fixedTargetId) ?? null;
    if (!target) { await this.showDirectory(message, current.projectId, context.conversationKey); return true; }
    if (current.target.kind === "instance" && current.target.expectedGeneration !== undefined && current.target.expectedGeneration !== target.generation) {
      await this.reject(message, "当前目标实例已重新启动，请从实例目录重新选择。"); return true;
    }
    await this.options.messaging.submit({ idempotencyKey: `lark:${message.messageId}`, actor: { kind: "human", userId: message.actorOpenId, channel: "feishu" }, projectId: current.projectId, targetInstanceId: target.id, content: { kind: "turn", text: message.text } });
    return true;
  }

  async handleCardAction(action: IncomingLarkCardAction): Promise<LarkCardActionResult | void> {
    if (!action.value || typeof action.value !== "object") return;
    const value = action.value as Record<string, unknown>;
    if (typeof value.action !== "string" || !value.action.startsWith("instance_")) return;
    if (!this.isOperator(action.operatorOpenId)) return { toast: { type: "error", content: "你没有 Agent 管理权限。" } };
    const actor = { kind: "human" as const, userId: action.operatorOpenId, channel: "feishu" as const };
    const conversationKey = typeof value.conversationKey === "string" && value.conversationKey.length <= 200 ? value.conversationKey : action.chatId;
    const bindingContext = this.boundProjectForConversationKey(conversationKey, action.chatId);
    if (bindingContext === "invalid") return warning("话题上下文已失效，请重新打开实例目录。");
    if (value.action === "instance_create_form") {
      const projectId = typeof value.projectId === "string" ? value.projectId : "";
      if (!this.projects.has(projectId)) return warning("项目不存在或已移除。");
      if (bindingContext && bindingContext !== projectId) return warning("当前话题已固定到其他项目。");
      return { card: renderInstanceCreateCard({ projectId, requestedBy: action.operatorOpenId, conversationKey }) };
    }
    if (value.action === "instance_create_submit") {
      if (!sameOperator(value, action)) return forbidden();
      const projectId = typeof value.projectId === "string" ? value.projectId : "";
      if (!this.projects.has(projectId)) return warning("项目不存在或已移除。");
      if (bindingContext && bindingContext !== projectId) return warning("当前话题已固定到其他项目。");
      const form = action.formValues ?? {};
      const role = form.role === "primary" || form.role === "worker" ? form.role : null;
      const agentKind = form.agent_kind === "pi" || form.agent_kind === "claude-code" || form.agent_kind === "codex" || form.agent_kind === "traex" ? form.agent_kind : null;
      const name = form.name?.trim() ?? "";
      if (!name || !role || !agentKind) return { toast: { type: "error", content: "请填写有效的实例名、角色和 Agent。" } };
      try {
        const created = await this.options.control.create({ actor, projectId, name, role, agentKind, model: form.model?.trim() || null, start: form.start === "true" });
        return { toast: { type: "success", content: `实例 ${created.name} 已创建。` }, card: this.detailCard(created, conversationKey) };
      } catch (error) { return failed(error); }
    }
    const instance = typeof value.instanceId === "string" ? this.options.store.getAgentInstance(value.instanceId) : null;
    if (!instance || instance.generation !== Number(value.generation)) return { toast: { type: "warning", content: "实例状态已变化，请刷新后重试。" } };
    if (bindingContext && bindingContext !== instance.projectId) return warning("实例不属于当前话题项目。");
    if (value.action === "instance_open") return { card: this.detailCard(instance, conversationKey) };
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
    if (value.action === "instance_set_primary") {
      const result = this.options.control.setPrimary({ actor, projectId: instance.projectId, instanceId: instance.id });
      return { toast: { type: result.ok ? "success" : "error", content: result.ok ? "Primary 已更新。" : "只有用户可以设置 Primary。" } };
    }
    if (value.action === "instance_interrupt") {
      const result = await this.options.messaging.interrupt({ idempotencyKey: `card:${action.messageId}:interrupt:${instance.generation}`, actor, targetInstanceId: instance.id });
      return { toast: { type: result.status === "interrupted" ? "success" : "warning", content: `Interrupt: ${result.status}` } };
    }
    if (value.action === "instance_steer_form") return { card: renderInstanceSteerCard({ instance, requestedBy: action.operatorOpenId, conversationKey }) };
    if (value.action === "instance_steer_submit") {
      if (!sameOperator(value, action)) return forbidden();
      const text = action.formValues?.steer_text?.trim() ?? "";
      if (!text) return { toast: { type: "error", content: "Steer 内容不能为空。" } };
      try {
        const result = await this.options.messaging.steer({ idempotencyKey: `card:${action.messageId}:steer:${instance.generation}`, actor, targetInstanceId: instance.id, text });
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
        return { card: renderInstanceRemovalPlanCard({ instance: current, workspace, plan, requestedBy: action.operatorOpenId, conversationKey }) };
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

  private async showDirectory(message: IncomingLarkMessage, projectId: string, conversationKey: string): Promise<void> {
    const project = this.projects.get(projectId)!; const selected = this.options.store.getConversationTarget(conversationKey); const target = selected?.projectId === projectId ? selected.target : { kind: "primary" as const };
    const entries = this.options.control.list(projectId).map((instance) => ({ instance, workspace: this.options.control.inspect(instance.id).workspace, capabilities: this.options.drivers.describe(instance.agentKind), queueDepth: this.options.store.countPendingInstanceTurns(instance.id) }));
    await this.reply(message, renderInstanceDirectoryCard({ project, entries, target, conversationKey }));
  }
  private async showDetail(message: IncomingLarkMessage, instance: AgentInstance, conversationKey: string): Promise<void> { await this.reply(message, this.detailCard(instance, conversationKey)); }
  private detailCard(instance: AgentInstance, conversationKey: string): object { const view = this.options.control.inspect(instance.id); return renderInstanceDetailCard({ ...view, capabilities: this.options.drivers.describe(instance.agentKind), turns: this.options.store.listInstanceTurns(instance.id, { limit: 25 }).items, queueDepth: this.options.store.countPendingInstanceTurns(instance.id), conversationKey }); }
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
  private findByName(projectId: string, name: string): AgentInstance | null { return this.options.control.list(projectId).find((item) => item.name === name) ?? null; }
  private isOperator(openId: string): boolean { const allowed = this.options.operatorOpenIds ?? []; return allowed.length === 0 || allowed.includes(openId); }
  private reply(message: IncomingLarkMessage, card: object): Promise<void> { return this.options.outbound.enqueueCard(message.rootMessageId ?? message.messageId, `instance:${message.messageId}:${JSON.stringify(card)}`, card); }
  private reject(message: IncomingLarkMessage, reason: string): Promise<void> { return this.reply(message, renderMessageRejectedCard(reason)); }
}

function projectCard(projects: readonly ProjectConfig[], selected?: string): object { return { schema: "2.0", header: { title: { tag: "plain_text", content: "Projects" }, template: "blue" }, body: { elements: projects.map((project) => ({ tag: "markdown", content: `${project.id === selected ? "▶ " : ""}**${project.displayName}** · \`${project.id}\`\n${project.description}` })) } }; }
function statusCard(text: string): object { return { schema: "2.0", header: { title: { tag: "plain_text", content: "Agent control" }, template: "blue" }, body: { elements: [{ tag: "markdown", content: text }] } }; }
function sameOperator(value: Record<string, unknown>, action: IncomingLarkCardAction): boolean { return typeof value.requestedBy === "string" && value.requestedBy === action.operatorOpenId; }
function forbidden(): LarkCardActionResult { return { toast: { type: "error", content: "只有发起此操作的用户可以提交。" } }; }
function warning(content: string): LarkCardActionResult { return { toast: { type: "warning", content } }; }
function failed(error: unknown): LarkCardActionResult { return { toast: { type: "error", content: error instanceof Error ? error.message : "操作失败。" } }; }
