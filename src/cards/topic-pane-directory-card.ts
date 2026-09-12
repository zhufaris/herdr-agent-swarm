import type { TopicPaneDirectoryEntry } from "../domain/ports/presentation.js";
import { callbackButton } from "./cardkit-button.js";

const MAX_ENTRIES = 40;

export function renderTopicPaneDirectoryCard(entries: TopicPaneDirectoryEntry[]): object {
  const visible = entries.slice(0, MAX_ENTRIES);
  const elements: object[] = visible.length
    ? visible.flatMap((entry) => [
      { tag: "markdown", content: "**" + escapeMarkdown(entry.title) + "**  ·  " + escapeMarkdown(entry.spaceName) + "\nPane `" + escapeCode(entry.paneId) + "` · " + escapeMarkdown(entry.agentState) },
      callbackButton("发送卡片到群", { action: "pane_card_send", bindingId: entry.bindingId, bindingGeneration: entry.bindingGeneration, paneId: entry.paneId, sourceMainMessageId: entry.sourceMainMessageId }, "primary"),
      { tag: "hr" }
    ]).slice(0, -1)
    : [{ tag: "markdown", content: "当前群中没有可发送的 active Pane 卡片。" }];
  if (entries.length > visible.length) elements.push({ tag: "markdown", content: "仅展示前 " + MAX_ENTRIES + " 个 active Pane。" });
  return { schema: "2.0", config: { update_multi: true, summary: { content: "Active Pane 卡片" } }, header: { title: { tag: "plain_text", content: "Active Panes" }, subtitle: { tag: "plain_text", content: "发送最新 Primary Main Card" }, template: "blue" }, body: { elements } };
}

function escapeCode(value: string): string { return value.replaceAll("`", "'"); }
function escapeMarkdown(value: string): string { return value.replace(/[\\`*_{}[\]()#+.!|>-]/g, "\\$&"); }
