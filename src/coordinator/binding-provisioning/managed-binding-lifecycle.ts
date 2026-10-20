import type { BridgeConfig } from "../../config.js";
import type { BindingProvisioningStore, RuntimeIdentityTransitionApplication, RuntimeIdentityTransitionFence } from "../../domain/ports/binding.js";
import type { HerdrPort } from "../../domain/ports/external.js";
import type { Binding, ProjectConfig } from "../../domain/types.js";
import { createPrimaryPaneToken } from "../../domain/pane-title.js";
import { requireMatchingPane } from "../pane-runtime-identity.js";
import type { ProjectCatalog } from "../project-catalog.js";
import type { AgentKind } from "../../domain/agent-instance.js";

export interface PrimaryToolConfiguration { environment: Record<string, string>; command: string; args: string[]; agentArgs?: string[] }

export class ManagedBindingLifecycle {
  constructor(private readonly options: {
    config: BridgeConfig; store: BindingProvisioningStore; herdr: HerdrPort; projects: ProjectCatalog;
    primaryTools: { issueBinding(bindingId: string, expectedGeneration: number): PrimaryToolConfiguration };
    requireStartedPane(project: ProjectConfig, paneId: string, expectedTerminalId: string | null, agentKind: AgentKind): Promise<import("../../domain/types.js").HerdrPane>;
    startPrimaryAgent(binding: Binding, pane: import("../../domain/types.js").HerdrPane, tools: PrimaryToolConfiguration): Promise<void>;
    publish(bindingId: string, type: "BindingArchived" | "PrimaryToolAvailabilityChanged", origin: "lark" | "bridge", payload: Record<string, unknown>): Promise<void>;
  }) {}

  async reattach(binding: Binding, paneId: string, actorOpenId: string): Promise<void> {
    const pane = await requireMatchingPane(this.options.herdr, this.options.projects, binding, paneId);
    const next = requireBindingUpdate(this.options.store.applyRuntimeIdentityTransition({ kind: "attach_binding_pane", expected: runtimeIdentityFence(binding), pane, replacement: false }));
    await this.options.publish(next.id, "BindingArchived", "lark", { reason: "Pane 已验证并连接；为避免重放不确定任务，发送 `/swarm resume` 后才继续队列。" });
    await this.options.publish(next.id, "PrimaryToolAvailabilityChanged", "bridge", { available: false, reason: PRIMARY_TOOLS_UNAVAILABLE_NOTICE });
    this.options.store.audit({ actorOpenId, action: "binding.reattach", target: binding.id, outcome: "success" });
  }

  async replace(binding: Binding, actorOpenId: string): Promise<void> {
    const project = this.options.projects.projectForBinding(binding);
    if (!project) throw new Error(`Project configuration missing for binding ${binding.id}`);
    const paneTitle = createPrimaryPaneToken();
    const nextGeneration = binding.generation + 1;
    const tools = binding.agentKind === "traex" ? this.options.primaryTools.issueBinding(binding.id, nextGeneration) : emptyPrimaryToolConfiguration();
    const pane = await this.options.herdr.createPane(project.workspaceId, project.cwd, paneCreationOptions(binding.id, nextGeneration, project.id, paneTitle, tools));
    await this.options.startPrimaryAgent(binding, pane, tools);
    const startedPane = await this.options.requireStartedPane(project, pane.paneId, pane.terminalId ?? null, binding.agentKind);
    const attached = requireBindingUpdate(this.options.store.applyRuntimeIdentityTransition({ kind: "attach_binding_pane", expected: runtimeIdentityFence(binding), pane: startedPane, replacement: true }));
    const next = this.options.store.transitionBinding(attached.id, { type: "pane_observed", runtime: startedPane.agentState });
    await this.options.publish(next.id, "BindingArchived", "lark", { reason: "Replacement Pane 已创建；为避免重放不确定任务，发送 `/swarm resume` 后才继续队列。" });
    await this.options.publish(next.id, "PrimaryToolAvailabilityChanged", "bridge", binding.agentKind === "traex"
      ? { available: true, reason: null }
      : { available: false, reason: `${binding.agentKind} Primary 当前不支持 Bridge Primary 工具；请直接通过飞书命令管理 Worker。` });
    this.options.store.audit({ actorOpenId, action: "binding.replace", target: binding.id, outcome: "success" });
  }
}

export const PRIMARY_TOOLS_UNAVAILABLE_NOTICE = "当前 Pane 并非由 Bridge 使用 Primary 工具凭证启动；Primary 工具暂不可用。请使用 `/swarm reset` 或 `/swarm replace` 创建新的受管 Pane。";
export function paneCreationOptions(bindingId: string, generation: number, projectId: string, title: string, tools: PrimaryToolConfiguration): import("../../domain/types.js").HerdrPaneCreationOptions { return { bindingId, generation, projectId, placement: "dedicated-tab", title, displayIdentity: { role: { kind: "managed-primary" } }, environment: tools.environment }; }
export function primaryToolAgentArgs(tools: PrimaryToolConfiguration): string[] { return [...(tools.agentArgs ?? []), "-c", `mcp_servers.herdr_agent_swarm.command=${JSON.stringify(tools.command)}`, "-c", `mcp_servers.herdr_agent_swarm.args=${JSON.stringify(tools.args)}`, "-c", 'mcp_servers.herdr_agent_swarm.env_vars=["SWARM_PRIMARY_CAPABILITY"]']; }
function emptyPrimaryToolConfiguration(): PrimaryToolConfiguration { return { environment: {}, command: "", args: [] }; }
function requireBindingUpdate(result: RuntimeIdentityTransitionApplication): Binding {
  if (result.outcome !== "binding_updated") throw new Error(`Expected Binding identity update, received ${result.outcome}`);
  return result.binding;
}
function runtimeIdentityFence(binding: Binding): RuntimeIdentityTransitionFence {
  return {
    owner: { bindingId: binding.id, bindingGeneration: binding.generation, sessionEpoch: binding.sessionEpoch },
    workspaceId: binding.workspaceId, paneId: binding.paneId, terminalId: binding.traexSessionId, attachment: binding.attachment,
    nativeIdentity: binding.agentSessionSource && binding.agentSessionAgent && binding.agentSessionKind && binding.agentSessionValue
      ? { source: binding.agentSessionSource, agent: binding.agentSessionAgent, kind: binding.agentSessionKind, value: binding.agentSessionValue }
      : null
  };
}
