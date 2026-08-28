import type { AgentInstance, InstanceTarget, WorkspaceLease } from "../domain/agent-instance.js";
import type { AgentCapabilities } from "../domain/agent-runtime.js";
import type { ProjectConfig } from "../domain/types.js";
import { callbackButton } from "./cardkit-button.js";

export interface InstanceDirectoryEntry { instance: AgentInstance; workspace: WorkspaceLease; capabilities: AgentCapabilities; queueDepth: number; approvalCount?: number }

export function renderInstanceDirectoryCard(input: { project: ProjectConfig; entries: InstanceDirectoryEntry[]; target: InstanceTarget }): object {
  const primary = input.entries.find(({ instance }) => instance.role === "primary")?.instance.name ?? "未设置";
  const targetInstanceId = input.target.kind === "instance" ? input.target.instanceId : null;
  const target = targetInstanceId === null ? `Primary (${primary})` : input.entries.find(({ instance }) => instance.id === targetInstanceId)?.instance.name ?? "未知实例";
  const rows = input.entries.map(({ instance, workspace, queueDepth, approvalCount = 0 }) => ({
    tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", vertical_align: "center", columns: [
      column(`**${escape(instance.name)}**\n${instance.role === "primary" ? "PRIMARY" : "WORKER"}`, 3),
      column(`\`${instance.agentKind}\`\n${instance.observedState}`, 2),
      column(`queue ${queueDepth} · approvals ${approvalCount}\n${workspace.kind === "git-worktree" ? `\`${escape(workspace.branch ?? "detached")}\`` : workspace.kind}`, 3),
      { tag: "column", width: "weighted", weight: 2, elements: [callbackButton("详情", { action: "instance_open", instanceId: instance.id, generation: instance.generation }, "primary", { size: "small" })] }
    ]
  }));
  return { schema: "2.0", config: { update_multi: true, summary: { content: `${input.project.displayName} 实例` } }, header: { title: { tag: "plain_text", content: `${input.project.displayName} · Agent Instances` }, template: "blue" }, body: { elements: [
    { tag: "markdown", content: `**PRIMARY**  ${escape(primary)}   **TARGET**  ${escape(target)}   **INSTANCES**  ${input.entries.length}` },
    ...(rows.length ? rows : [{ tag: "markdown", content: "暂无实例。请由用户显式创建 Primary 或 Worker。" }]),
    callbackButton("创建实例", { action: "instance_create_form", projectId: input.project.id }, "primary")
  ] } };
}

function column(content: string, weight: number): object { return { tag: "column", width: "weighted", weight, elements: [{ tag: "markdown", content }] }; }
function escape(value: string): string { return value.replace(/[\`*_{}[\]()#+.!|>-]/g, "\\$&").slice(0, 160); }
