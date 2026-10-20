import type { TopicPaneDirectoryEntry } from "../domain/ports/presentation.js";
import { displayPaneIdentity } from "../domain/pane-display-identity.js";
import { createPaneIdentitySnapshot } from "../domain/worker-main-view.js";
import { callbackButton, linkButton } from "./cardkit-button.js";
import { feishuThreadLink } from "./feishu-thread-link.js";

const MAX_ENTRIES = 40;
const MAX_WORKERS_PER_PRIMARY = 8;

export function renderTopicPaneDirectoryCard(entries: TopicPaneDirectoryEntry[]): object {
  const visible = entries.slice(0, MAX_ENTRIES);
  const elements: object[] = visible.length
    ? visible.flatMap((entry) => [
      primaryPaneRow(entry),
      ...workerPaneElements(entry),
      { tag: "hr" }
    ]).slice(0, -1)
    : [{ tag: "markdown", content: "当前群中没有可发送的 active Pane 卡片。" }];
  if (entries.length > visible.length) elements.push({ tag: "markdown", content: "仅展示前 " + MAX_ENTRIES + " 个 active Pane。" });
  return { schema: "2.0", config: { update_multi: true, summary: { content: "活跃会话导航" } }, header: { title: { tag: "plain_text", content: "🧭 活跃会话" }, subtitle: { tag: "plain_text", content: "PRIMARY 会话 · 按最近活动排序" }, template: "blue" }, body: { elements } };
}

function escapeCode(value: string): string { return value.replaceAll("`", "'"); }
function escapeMarkdown(value: string): string { return value.replace(/[\\`*_{}[\]()#+.!|>-]/g, "\\$&"); }
function primaryPaneRow(entry: TopicPaneDirectoryEntry): object {
  const identity = entry.paneIdentity ?? createPaneIdentitySnapshot({ paneId: entry.paneId, paneToken: entry.paneToken });
  const task = entry.taskSummary?.trim() ? "\n" + escapeMarkdown(entry.taskSummary.trim().slice(0, 180)) : "";
  const identityDetails = [identity.worktreeName ? ` · Worktree \`${escapeCode(identity.worktreeName)}\`` : "", identity.branch ? ` · Branch \`${escapeCode(identity.branch)}\`` : ""].join("");
  const link = feishuThreadLink(entry.chatId, entry.threadId);
  return { tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: [
    { tag: "column", width: "weighted", weight: 7, elements: [{ tag: "markdown", content: "**🧭 " + escapeMarkdown(entry.title) + "**  ·  " + escapeMarkdown(entry.agentState) + "\n" + escapeMarkdown(entry.spaceName) + " · Primary `" + escapeCode(displayPaneIdentity(identity)) + "`" + identityDetails + task }] },
    { tag: "column", width: "auto", elements: [link
      ? linkButton("打开会话", link, "primary", { size: "small" })
      : callbackButton("打开会话", { action: "pane_primary_thread_forward", bindingId: entry.bindingId, bindingGeneration: entry.bindingGeneration, paneId: entry.paneId, sourceMainMessageId: entry.sourceMainMessageId }, "primary", { size: "small" })] }
  ] };
}
function workerPaneElements(entry: TopicPaneDirectoryEntry): object[] {
  if (!entry.workers.length) return [];
  const visible = entry.workers.slice(0, MAX_WORKERS_PER_PRIMARY);
  const elements: object[] = visible.flatMap((worker) => {
    const identity = worker.paneIdentity ?? createPaneIdentitySnapshot({ paneId: worker.paneId, paneToken: worker.paneToken });
    const identityDetails = [identity.worktreeName ? ` · Worktree \`${escapeCode(identity.worktreeName)}\`` : "", identity.branch ? ` · Branch \`${escapeCode(identity.branch)}\`` : ""].join("");
    const link = feishuThreadLink(entry.chatId, worker.threadId);
    return [{ tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: [
      { tag: "column", width: "weighted", weight: 7, elements: [{ tag: "markdown", content: `↳ 🤖 **${escapeMarkdown(worker.workerName)}**  ·  ${escapeMarkdown(worker.state)}\n　 Pane \`${escapeCode(displayPaneIdentity(identity, "未分配"))}\`${identityDetails}` }] },
      { tag: "column", width: "auto", elements: [link
        ? linkButton("打开 Worker Thread", link, "default", { size: "small" })
        : callbackButton("转发 Worker Thread", { action: "pane_worker_thread_forward", instanceId: worker.workerId, generation: worker.runtimeGeneration, workerSessionGeneration: worker.workerSessionGeneration, bindingId: entry.bindingId, bindingGeneration: entry.bindingGeneration, parentPaneId: entry.paneId, sourceMainMessageId: entry.sourceMainMessageId }, "default", { size: "small" })] }
    ] }];
  });
  if (entry.workers.length > visible.length) elements.push({ tag: "markdown", content: `↳ … 另有 ${entry.workers.length - visible.length} 个 Worker Pane 未展示。` });
  return elements;
}
