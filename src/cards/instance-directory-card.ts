import type { AgentInstance, InstanceTarget, WorkspaceLease } from "../domain/agent-instance.js";
import type { AgentCapabilities } from "../domain/agent-runtime.js";
import type { ProjectConfig } from "../domain/types.js";
import { callbackButton } from "./cardkit-button.js";
import { appendWithinCardLimit } from "./card-payload.js";

const MAX_VISIBLE_INSTANCES = 16;

export interface InstanceDirectoryEntry { instance: AgentInstance; workspace: WorkspaceLease; capabilities: AgentCapabilities; queueDepth: number; approvalCount?: number }

export function renderInstanceDirectoryCard(input: { project: ProjectConfig; entries: InstanceDirectoryEntry[]; target: InstanceTarget; conversationKey?: string }): object {
  const primary = input.entries.find(({ instance }) => instance.role === "primary")?.instance.name ?? "未设置";
  const targetInstanceId = input.target.kind === "instance" ? input.target.instanceId : null;
  const target = targetInstanceId === null ? `Primary (${primary})` : input.entries.find(({ instance }) => instance.id === targetInstanceId)?.instance.name ?? "未知实例";
  const allRows = input.entries.map(({ instance, workspace, queueDepth, approvalCount = 0 }) => ({
    tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", vertical_align: "center", columns: [
      column(`**${escape(instance.name)}**\n${instance.role === "primary" ? "PRIMARY" : "WORKER"}`, 3),
      column(`\`${instance.agentKind}\`\n${instance.observedState}`, 2),
      column(`queue ${queueDepth} · approvals ${approvalCount}\n${workspace.kind === "git-worktree" ? `\`${escape(workspace.branch ?? "detached")}\`` : workspace.kind}`, 3),
      { tag: "column", width: "weighted", weight: 2, elements: [callbackButton("详情", { action: "instance_open", instanceId: instance.id, generation: instance.generation, ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}) }, "primary", { size: "small" })] }
    ]
  }));
  const summary = { tag: "markdown", content: `**PRIMARY**  ${escape(primary)}   **TARGET**  ${escape(target)}   **INSTANCES**  ${input.entries.length}` };
  const rows: object[] = [];
  for (const row of allRows.slice(0, MAX_VISIBLE_INSTANCES)) {
    if (!appendWithinCardLimit([summary, ...rows], [row])) break;
    rows.push(row);
  }
  const omitted = allRows.length - rows.length;
  return { schema: "2.0", config: { update_multi: true, summary: { content: `${input.project.displayName} 实例` } }, header: { title: { tag: "plain_text", content: `${input.project.displayName} · Agent Instances` }, template: "blue" }, body: { elements: [
    summary,
    ...(rows.length ? rows : [{ tag: "markdown", content: "暂无实例。请由用户显式创建 Primary 或 Worker。" }]),
    ...(omitted > 0 ? [{ tag: "markdown", content: `… 另有 ${omitted} 个实例未在本卡展示，请按名称打开实例详情。` }] : []),
    callbackButton("创建实例", { action: "instance_create_form", projectId: input.project.id, ...(input.conversationKey ? { conversationKey: input.conversationKey } : {}) }, "primary")
  ] } };
}

function column(content: string, weight: number): object { return { tag: "column", width: "weighted", weight, elements: [{ tag: "markdown", content }] }; }
function escape(value: string): string { return value.replace(/[\`*_{}[\]()#+.!|>-]/g, "\\$&").slice(0, 160); }
