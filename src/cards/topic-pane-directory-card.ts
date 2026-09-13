import type { TopicPaneDirectoryEntry } from "../domain/ports/presentation.js";
import { callbackButton } from "./cardkit-button.js";

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
  return { schema: "2.0", config: { update_multi: true, summary: { content: "Swarm Pane 目录" } }, header: { title: { tag: "plain_text", content: "🧭 Swarm Panes" }, subtitle: { tag: "plain_text", content: "PRIMARY 与关联 WORKER" }, template: "blue" }, body: { elements } };
}

function escapeCode(value: string): string { return value.replaceAll("`", "'"); }
function escapeMarkdown(value: string): string { return value.replace(/[\\`*_{}[\]()#+.!|>-]/g, "\\$&"); }
function primaryPaneRow(entry: TopicPaneDirectoryEntry): object {
  return { tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: [
    { tag: "column", width: "weighted", weight: 7, elements: [{ tag: "markdown", content: "**🧭 " + escapeMarkdown(entry.title) + "**  ·  " + escapeMarkdown(entry.agentState) + "\n" + escapeMarkdown(entry.spaceName) + " · Primary `" + escapeCode(entry.paneId) + "`" }] },
    { tag: "column", width: "auto", elements: [callbackButton("打开 Primary", { action: "pane_card_send", bindingId: entry.bindingId, bindingGeneration: entry.bindingGeneration, paneId: entry.paneId, sourceMainMessageId: entry.sourceMainMessageId }, "primary", { size: "small" })] }
  ] };
}
function workerPaneElements(entry: TopicPaneDirectoryEntry): object[] {
  if (!entry.workers.length) return [];
  const visible = entry.workers.slice(0, MAX_WORKERS_PER_PRIMARY);
  const elements: object[] = visible.flatMap((worker) => {
    return [{ tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: [
      { tag: "column", width: "weighted", weight: 7, elements: [{ tag: "markdown", content: `↳ 🤖 **${escapeMarkdown(worker.workerName)}**  ·  ${escapeMarkdown(worker.state)}\n　 Pane \`${escapeCode(worker.paneId ?? "未分配")}\`` }] },
      { tag: "column", width: "auto", elements: [callbackButton("打开 Thread", { action: "worker_thread_send", instanceId: worker.workerId, generation: worker.runtimeGeneration, workerSessionGeneration: worker.workerSessionGeneration, bindingId: entry.bindingId, bindingGeneration: entry.bindingGeneration, parentPaneId: entry.paneId, sourceMainMessageId: entry.sourceMainMessageId, conversationKey: `binding:${entry.bindingId}` }, "default", { size: "small" })] }
    ] }];
  });
  if (entry.workers.length > visible.length) elements.push({ tag: "markdown", content: `↳ … 另有 ${entry.workers.length - visible.length} 个 Worker Pane 未展示。` });
  return elements;
}
