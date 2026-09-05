import type { BridgeConfig } from "../config.js";
import type { BridgeCommand, Binding, IncomingLarkMessage, ProjectConfig } from "../domain/types.js";
import { swarmCommandPolicy, type SwarmCommandContext } from "../domain/swarm-command.js";

interface Store { findBindingByLarkScope(topicId: string | null, rootMessageId: string | null): Binding | null }
interface Options {
  config: Pick<BridgeConfig, "defaultProjectId" | "projects" | "lark">;
  store: Store;
  activeTurn(bindingId: string): { promptId: string; paneId: string } | null;
}

export type SwarmCommandContextResolution =
  | { outcome: "resolved"; context: SwarmCommandContext; laneKey: string }
  | { outcome: "rejected"; code: "administrator_required" | "creator_required" | "binding_required" | "project_required"; message: string };

export class SwarmCommandContextResolver {
  private readonly projectsById: ReadonlyMap<string, ProjectConfig>;
  private readonly projectsBySpaceName: ReadonlyMap<string, readonly ProjectConfig[]>;

  constructor(private readonly options: Options) {
    this.projectsById = new Map(options.config.projects.map((project) => [project.id, project]));
    const bySpace = new Map<string, ProjectConfig[]>();
    for (const project of options.config.projects) {
      const key = project.spaceName ?? project.displayName;
      bySpace.set(key, [...(bySpace.get(key) ?? []), project]);
    }
    this.projectsBySpaceName = bySpace;
  }

  resolve(message: IncomingLarkMessage, command: BridgeCommand): SwarmCommandContextResolution {
    const policy = swarmCommandPolicy(command);
    const binding = this.options.store.findBindingByLarkScope(message.topicId, message.rootMessageId);
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
      return { outcome: "rejected", code: "project_required", message: "无法唯一确定命令所属项目。" };
    }
    const active = binding ? this.options.activeTurn(binding.id) : null;
    const context: SwarmCommandContext = {
      chatId: message.chatId, topicId: message.topicId, rootMessageId: message.rootMessageId, sourceMessageId: message.messageId, actorOpenId: message.actorOpenId,
      projectId: project?.id ?? binding?.projectId ?? null, workspaceId: project?.workspaceId ?? binding?.workspaceId ?? null,
      primary: binding ? {
        bindingId: binding.id, bindingGeneration: binding.generation, paneId: binding.paneId ?? "", terminalId: binding.traexSessionId,
        nativeSession: binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
          ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue } : null,
        activePromptId: active?.promptId ?? null
      } : null
    };
    return { outcome: "resolved", context, laneKey: laneKey(policy.scope, context) };
  }

  private resolveProject(command: BridgeCommand, binding: Binding | null): ProjectConfig | null {
    if (binding?.projectId) return this.projectsById.get(binding.projectId) ?? null;
    if (command.kind === "attach") {
      const matches = this.projectsBySpaceName.get(command.spaceName) ?? [];
      return matches.length === 1 ? matches[0]! : null;
    }
    if (command.kind === "spaces") return this.projectsById.get(this.options.config.defaultProjectId) ?? null;
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
