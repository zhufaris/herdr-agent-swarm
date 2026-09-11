import type { BridgeConfig } from "../config.js";
import type { BridgeCommand, Binding, IncomingLarkMessage, ProjectConfig } from "../domain/types.js";
import { swarmCommandPolicy, type SwarmCommandContext } from "../domain/swarm-command.js";
import { ProjectCatalog } from "./project-catalog.js";

interface Store { findBindingByLarkScope(topicId: string | null, rootMessageId: string | null): Binding | null; getBinding?(id: string): Binding | null }
interface Options {
  config: Pick<BridgeConfig, "defaultProjectId" | "projects" | "lark">;
  store: Store;
  activeTurn(bindingId: string): { promptId: string; paneId: string } | null;
}

export type SwarmCommandContextResolution =
  | { outcome: "resolved"; context: SwarmCommandContext; laneKey: string; binding: Binding | null }
  | { outcome: "rejected"; code: "administrator_required" | "creator_required" | "binding_required" | "project_required"; message: string };

export class SwarmCommandContextResolver {
  private readonly projects: ProjectCatalog;

  constructor(private readonly options: Options) {
    this.projects = new ProjectCatalog(options.config.projects);
  }

  resolve(message: IncomingLarkMessage, command: BridgeCommand, explicitBindingId?: string): SwarmCommandContextResolution {
    const policy = swarmCommandPolicy(command);
    const binding = explicitBindingId
      ? this.bindingById(explicitBindingId)
      : this.options.store.findBindingByLarkScope(message.topicId, message.rootMessageId);
    if (requiresAdministrator(policy.authorization) && !this.options.config.lark.adminOpenIds.includes(message.actorOpenId)) {
      return { outcome: "rejected", code: "administrator_required", message: "你没有管理权限。" };
    }
    if (requiresCreator(policy.authorization) && (!binding || (binding.creatorOpenId !== null && binding.creatorOpenId !== message.actorOpenId))) {
      return { outcome: "rejected", code: "creator_required", message: "只有会话创建者可以执行这项管理操作。" };
    }
    if ((policy.scope === "primary-session" || policy.scope === "active-turn") && !binding) {
      return { outcome: "rejected", code: "binding_required", message: "这个话题尚未连接 Herdr。请发送 `/swarm new` 创建项目。" };
    }
    const project = this.resolveProject(command, binding);
    if (policy.scope === "project" && !project) {
      const matches = command.kind === "attach" ? this.projects.projectsForSpaceName(command.spaceName) : [];
      const message = matches.length > 1 ? `空间 ${command.kind === "attach" ? command.spaceName : ""} 对应多个项目，无法确定要连接哪一个。`
        : command.kind === "attach" ? `未找到空间 ${command.spaceName}。` : "无法唯一确定命令所属项目。";
      return { outcome: "rejected", code: "project_required", message };
    }
    const active = binding ? this.options.activeTurn(binding.id) : null;
    const includesProject = policy.scope !== "global";
    const includesPrimary = policy.scope === "primary-session" || policy.scope === "active-turn";
    const context: SwarmCommandContext = {
      chatId: message.chatId, topicId: message.topicId, rootMessageId: message.rootMessageId, sourceMessageId: message.messageId, actorOpenId: message.actorOpenId,
      projectId: includesProject ? project?.id ?? binding?.projectId ?? null : null, workspaceId: includesProject ? project?.workspaceId ?? binding?.workspaceId ?? null : null,
      primary: includesPrimary && binding ? {
        bindingId: binding.id, bindingGeneration: binding.generation, paneId: binding.paneId, terminalId: binding.traexSessionId,
        nativeSession: binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
          ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue } : null,
        activePromptId: policy.scope === "active-turn" ? active?.promptId ?? null : null
      } : null
    };
    return { outcome: "resolved", context, laneKey: laneKey(policy.scope, context), binding };
  }

  private bindingById(id: string): Binding | null {
    return this.options.store.getBinding?.(id) ?? null;
  }

  private resolveProject(command: BridgeCommand, binding: Binding | null): ProjectConfig | null {
    if (binding?.projectId) return this.projects.projectById(binding.projectId) ?? null;
    if (command.kind === "attach") {
      const matches = this.projects.projectsForSpaceName(command.spaceName);
      return matches.length === 1 ? matches[0]! : null;
    }
    if (command.kind === "spaces") return this.projects.projectById(this.options.config.defaultProjectId) ?? null;
    return null;
  }
}

function requiresAdministrator(authorization: ReturnType<typeof swarmCommandPolicy>["authorization"]): boolean { return authorization === "administrator" || authorization === "creator-and-administrator"; }
function requiresCreator(authorization: ReturnType<typeof swarmCommandPolicy>["authorization"]): boolean { return authorization === "creator" || authorization === "creator-and-administrator"; }
function laneKey(scope: ReturnType<typeof swarmCommandPolicy>["scope"], context: SwarmCommandContext): string {
  if (scope === "primary-session" || scope === "active-turn") return `binding:${context.primary!.bindingId}`;
  if (scope === "project") return `project:${context.projectId}`;
  return `chat:${context.chatId}`;
}
