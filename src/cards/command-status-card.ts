import type { CommandStatusView } from "../domain/command-status-view.js";

const labels: Record<CommandStatusView["state"], string> = { accepted: "已受理", executing: "执行中", succeeded: "已完成", rejected: "已拒绝", failed: "执行失败", uncertain: "结果待确认" };
const templates: Record<CommandStatusView["state"], string> = { accepted: "blue", executing: "blue", succeeded: "green", rejected: "orange", failed: "red", uncertain: "orange" };

export function renderCommandStatusCard(view: CommandStatusView): object {
  const detail = safeDetail(view.outcome?.detail);
  const guidance = view.state === "uncertain"
    ? "外部操作可能已经开始，系统不会自动重试。请先检查 Herdr 当前状态。"
    : view.state === "failed" ? "外部操作未确认开始，可检查状态后重新发起命令。"
      : view.state === "rejected" ? "请求未执行；请检查权限或当前会话状态。"
        : view.state === "accepted" ? "命令已持久化，正在等待执行。"
          : view.state === "executing" ? "命令正在后台执行，请勿重复提交。" : "命令已执行完成。";
  const lines = [
    `**命令** ${view.summary}`,
    `**状态** ${labels[view.state]}`,
    `**来源** ${sourceLabel(view.source)} · **尝试** ${view.attemptCount}`,
    `**关联 ID** \`${view.intentId.slice(0, 8)}\``,
    guidance,
    ...(view.outcome?.code ? [`**结果** \`${view.outcome.code}\`${detail ? `\n${detail}` : ""}`] : [])
  ];
  return { schema: "2.0", config: { update_multi: true, summary: { content: `Swarm 命令：${labels[view.state]}` } }, header: { title: { tag: "plain_text", content: `Swarm 命令 · ${labels[view.state]}` }, template: templates[view.state] }, body: { elements: [{ tag: "markdown", content: lines.join("\n\n") }] } };
}

function sourceLabel(source: CommandStatusView["source"]): string {
  return ({ literal: "/swarm", "natural-language": "自然语言", card: "卡片操作", "primary-tool": "Primary Tool" })[source];
}

function safeDetail(value: string | null | undefined): string | null {
  if (!value) return null;
  return value.replace(/(?:token|secret|password|authorization)\s*[:=]\s*\S+/gi, "[redacted]").slice(0, 500);
}
