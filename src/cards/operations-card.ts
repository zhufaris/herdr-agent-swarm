import type { AgentState, Binding, FailureSummary, SessionSummary } from "../domain/types.js";
import { callbackButton } from "./cardkit-button.js";

const LIFECYCLE_LABEL: Record<Binding["lifecycle"], string> = {
  provisioning: "创建中", active: "活跃", draining: "归档中", archived: "已归档", closed: "已关闭", failed: "失败"
};
const ATTACHMENT_LABEL: Record<Binding["attachment"], string> = {
  unattached: "未连接", attached: "已连接", degraded: "连接降级", orphaned: "连接异常"
};
const AGENT_LABEL: Record<AgentState, string> = { idle: "空闲", working: "执行中", blocked: "等待处理", done: "已完成", unknown: "未知" };

export function renderSessionCards(sessions: SessionSummary[]): object[] {
  const rows = sessions.map(({ binding, queueDepth, spaceName }) => {
    const scope = spaceName ?? binding.projectId ?? binding.workspaceId;
    const content = [
      `**${escape(binding.title)}**`,
      `Space: \`${escape(scope)}\` · Pane: \`${escape(binding.paneId ?? "-")}\``,
      `${LIFECYCLE_LABEL[binding.lifecycle]} · ${ATTACHMENT_LABEL[binding.attachment]} · ${AGENT_LABEL[binding.lastAgentState]} · 第 ${binding.generation} 代 · 队列 ${queueDepth} · ${relativeTime(binding.lastActivityAt)}`
    ].join("\n");
    return [{ tag: "markdown", content }, ...(binding.rootMessageId ? [button("发送话题入口", { action: "open_project_thread", bindingId: binding.id })] : [])];
  });
  return paginate("Herdr Sessions", "当前群没有会话。", rows, "blue");
}

export function renderFailureCards(failures: FailureSummary[], notice?: string): object[] {
  const rows = failures.map((failure) => {
    const heading = failure.kind === "outbound" ? "消息发送失败" : failure.kind === "prompt" ? "任务未完成（不可自动重试）" : "会话需要处理";
    const stage = failure.kind === "outbound" ? "发送阶段" : failure.kind === "prompt" ? "任务阶段" : "会话阶段";
    const context = [failure.spaceName ? `Space: \`${escape(failure.spaceName)}\`` : null, failure.paneId ? `Pane: \`${escape(failure.paneId)}\`` : null].filter(Boolean).join(" · " );
    const content = [
      `**${heading}** · ${stage} · \`${escape(shortId(failure.id))}\``,
      failure.title ? escape(failure.title) : null,
      context || null,
      escape(failure.error),
      relativeTime(failure.updatedAt)
    ].filter(Boolean).join("\n");
    if (failure.kind !== "outbound") return [{ tag: "markdown", content }];
    return [{ tag: "markdown", content }, { tag: "column_set", columns: [
      { tag: "column", width: "auto", elements: [button("重试发送", { action: "retry_dead_letter", replyId: failure.id })] },
      { tag: "column", width: "auto", elements: [button("忽略", { action: "dismiss_dead_letter", replyId: failure.id }, "default")] }
    ] }];
  });
  if (notice) rows.unshift([{ tag: "markdown", content: escape(notice) }]);
  return paginate("Herdr Failures", "当前群没有需要处理的失败。", rows, failures.length ? "orange" : "green");
}

function paginate(title: string, empty: string, rows: object[][], template: string): object[] {
  const pages: object[][] = [];
  for (let index = 0; index < rows.length; index += 20) pages.push(rows.slice(index, index + 20).flatMap((row, offset) => [...row, ...((offset < 19 && index + offset < rows.length - 1) ? [{ tag: "hr" }] : [])]));
  if (!pages.length) pages.push([{ tag: "markdown", content: empty }]);
  return pages.map((elements, index) => ({ schema: "2.0", config: { update_multi: true, summary: { content: title } }, header: { title: { tag: "plain_text", content: pages.length > 1 ? `${title} · ${index + 1}/${pages.length}` : title }, template }, body: { elements } }));
}

function button(content: string, value: object, type: "primary" | "default" = "primary"): object { return callbackButton(content, value, type); }
function escape(value: string): string { return value.slice(0, 500).replace(/[\`*_{}[\]()#+.!|>-]/g, "\\$&"); }
function shortId(value: string): string { return value.length <= 12 ? value : `${value.slice(0, 8)}…${value.slice(-4)}`; }
function relativeTime(value: string): string {
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return value;
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} 小时前`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)} 天前`;
  return new Date(timestamp).toISOString().slice(0, 10);
}
