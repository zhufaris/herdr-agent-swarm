import type { FailureSummary, SessionSummary } from "../domain/types.js";

export function renderSessionCards(sessions: SessionSummary[]): object[] {
  const rows = sessions.map(({ binding, queueDepth }) => {
    const content = `**${escape(binding.title)}**\nSpace: \`${escape(binding.projectId ?? binding.workspaceId)}\` · Pane: \`${escape(binding.paneId ?? "-")}\`\n${binding.lifecycle}/${binding.attachment} · ${binding.lastAgentState} · generation ${binding.generation} · queue ${queueDepth} · ${binding.lastActivityAt}`;
    return [{ tag: "markdown", content }, ...(binding.rootMessageId ? [button("打开项目话题", { action: "open_project_thread", bindingId: binding.id })] : [])];
  });
  return paginate("Herdr Sessions", "当前群没有会话。", rows, "blue");
}

export function renderFailureCards(failures: FailureSummary[], notice?: string): object[] {
  const rows = failures.map((failure) => {
    const heading = failure.kind === "outbound" ? "消息发送失败" : failure.kind === "prompt" ? "任务未完成（不可自动重试）" : "会话需要处理";
    const content = `**${heading}** · \`${escape(failure.id)}\`\n${escape(failure.error)}\n${failure.updatedAt}`;
    if (failure.kind !== "outbound") return [{ tag: "markdown", content }];
    return [{ tag: "markdown", content }, { tag: "column_set", columns: [
      { tag: "column", width: "auto", elements: [button("重试发送", { action: "retry_dead_letter", replyId: failure.id })] },
      { tag: "column", width: "auto", elements: [button("忽略", { action: "dismiss_dead_letter", replyId: failure.id })] }
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

function button(content: string, value: object): object { return { tag: "button", text: { tag: "plain_text", content }, type: "primary", value }; }
function escape(value: string): string { return value.slice(0, 500).replace(/[\`*_{}[\]()#+.!|>-]/g, "\\$&"); }
