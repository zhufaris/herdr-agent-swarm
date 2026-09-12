import type { InstanceCommand, IncomingLarkMessage, ProjectConfig } from "../../domain/types.js";
import type { InstanceStore } from "../../domain/ports/instance.js";
import type { InstanceMessagingWorkflow } from "../instance-messaging-workflow.js";
import { InstanceConversationContext } from "./conversation-context.js";
import { InstanceViewQuery } from "./instance-view-query.js";

interface InstanceCommandPresentation { requestRejected(reason: string): object; commandResult(input: { title: string; text: string }): object; projectDirectory(input: { projects: readonly ProjectConfig[]; selectedProjectId?: string }): object; }

export class InstanceCommandActions {
  private readonly projects: ReadonlyMap<string, ProjectConfig>;

  constructor(private readonly options: {
    projects: readonly ProjectConfig[];
    store: InstanceStore;
    messaging: InstanceMessagingWorkflow;
    context: InstanceConversationContext;
    views: InstanceViewQuery;
    presentation: InstanceCommandPresentation;
    reply(message: IncomingLarkMessage, card: object): Promise<void>;
  }) { this.projects = new Map(options.projects.map((project) => [project.id, project])); }

  async handle(message: IncomingLarkMessage, command: InstanceCommand): Promise<void> {
    const actor = { kind: "human" as const, userId: message.actorOpenId, channel: "feishu" as const };
    const context = this.options.context.resolve(message);
    const current = this.options.context.selected(context, message.chatId);
    if (command.kind === "projects") return this.options.reply(message, this.options.presentation.projectDirectory({ projects: this.options.projects, ...(current?.projectId ? { selectedProjectId: current.projectId } : {}) }));
    if (command.kind === "project") {
      const project = this.projects.get(command.projectId);
      if (!project) return this.reject(message, "项目不存在。");
      if (context.boundProjectId && context.boundProjectId !== project.id) return this.reject(message, `当前话题已固定到项目 ${context.boundProjectId}，不能切换到 ${project.id}。`);
      this.options.store.setConversationTarget({ chatId: context.conversationKey, projectId: project.id, target: { kind: "primary" } });
      return this.options.reply(message, this.options.views.directory(project, context.conversationKey));
    }
    if (context.bindingPresent && !context.boundProjectId) return this.reject(message, "当前话题绑定缺少有效项目，请联系管理员修复绑定。");
    const projectId = context.boundProjectId ?? current?.projectId;
    if (!projectId || !this.projects.has(projectId)) return this.reject(message, "请先使用 `/project <id>` 选择项目。");
    if (command.kind === "instances") return this.options.reply(message, this.options.views.directory(this.projects.get(projectId)!, context.conversationKey));
    const instance = this.options.context.findByName(context.conversationKey, command.name);
    if (!instance) return this.reject(message, `实例不存在：${command.name}`);
    if (command.kind === "instance") return this.options.reply(message, this.options.views.detail(instance, context.conversationKey));
    if (command.kind === "to") {
      await this.options.messaging.submit({ idempotencyKey: `lark:${message.messageId}`, actor, projectId, targetInstanceId: instance.id, content: { kind: "turn", text: command.text }, source: { messageId: message.messageId, rootMessageId: message.rootMessageId ?? message.messageId } });
      return;
    }
    if (command.kind === "steer_instance") {
      const result = await this.options.messaging.steer({ idempotencyKey: `lark:${message.messageId}:steer`, actor, targetInstanceId: instance.id, text: command.text, resultTargetMessageId: message.rootMessageId ?? message.messageId });
      if (result.durableResult === false) await this.options.reply(message, this.options.presentation.commandResult({ title: "Agent control", text: `Steer: ${result.status}` }));
      return;
    }
    const result = await this.options.messaging.interrupt({ idempotencyKey: `lark:${message.messageId}:interrupt`, actor, targetInstanceId: instance.id });
    return this.options.reply(message, this.options.presentation.commandResult({ title: "Agent control", text: `Stop: ${result.status}` }));
  }

  private reject(message: IncomingLarkMessage, reason: string): Promise<void> { return this.options.reply(message, this.options.presentation.requestRejected(reason)); }
}
