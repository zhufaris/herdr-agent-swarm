import { sessionActivityDisplay, type SessionActivityView } from "../domain/session-activity.js";
import type { TurnSessionStateView } from "../domain/turn-session-state.js";
import { cardSection } from "./card-style.js";

/** Pure, bounded Subagents/Compaction presentation shared by current cards. */
export function renderSessionActivity(activity: SessionActivityView): object[] {
  const display = sessionActivityDisplay(activity);
  const subagents = display.groups.flatMap(({ items }) => items);
  return [
    ...(subagents.length ? [renderSubagentsPanel(subagents)] : []),
    ...(display.compactionCount !== null ? [{ tag: "markdown", content: `${cardSection("🧹", "Compaction")}\nCompacted ${display.compactionCount}` }] : [])
  ];
}

/** One compact, bounded Session State section for the mutable primary Turn Card. */
export function renderTurnSessionState(state: TurnSessionStateView): object[] {
  const location: string[] = [];
  const usage: string[] = [];
  const identity = state.paneIdentity;
  if (identity?.workspace) location.push(`Workspace\n${escapeActivityMarkdown(identity.workspace)}`);
  if (identity?.worktreeName) location.push(`Worktree\n${escapeActivityMarkdown(identity.worktreeName)}`);
  if (identity?.branch) location.push(`Branch\n${escapeActivityMarkdown(identity.branch)}`);
  if (state.lastTurnState) location.push(`Turn\n${formatTurnState(state.lastTurnState)}`);
  const activeSubagents = state.activeSubagents ?? [];
  if (state.modelUsage.model) usage.push(`Model\n${escapeActivityMarkdown(state.modelUsage.model)}`);
  if (state.modelUsage.contextRemainingPercent != null) usage.push(`Context\n${state.modelUsage.contextRemainingPercent}% remaining`);
  if (state.modelUsage.inputTokens != null || state.modelUsage.outputTokens != null) {
    usage.push(`Tokens\n${formatCount(state.modelUsage.inputTokens)} in · ${formatCount(state.modelUsage.outputTokens)} out`);
  }
  if (state.tokenUsage != null) usage.push(`Session tokens\n${formatCount(state.tokenUsage)}`);
  if (state.contextUsage != null) usage.push(`Session context\n${state.contextUsage}%`);
  if (state.modelUsage.waitMs != null) usage.push(`Wait\n${formatDuration(state.modelUsage.waitMs)}`);
  if (state.modelUsage.firstVisibleMs != null) usage.push(`First visible\n${formatDuration(state.modelUsage.firstVisibleMs)}`);
  if (state.compactionCount != null) usage.push(`Compaction\n${state.compactionCount}x`);
  const columns = [location, usage]
    .filter((lines) => lines.length > 0)
    .map((lines) => ({ tag: "column", width: "weighted", weight: 1, elements: [{ tag: "markdown", content: lines.join("\n\n") }] }));
  return [
    { tag: "markdown", content: cardSection("🧭", "Session State") },
    { tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", vertical_align: "top", columns: columns.length ? columns : [{ tag: "column", width: "weighted", weight: 1, elements: [{ tag: "markdown", content: "Unavailable" }] }] },
    ...(activeSubagents.length ? [renderSubagentsPanel(activeSubagents)] : [])
  ];
}

function renderSubagentsPanel(items: ReadonlyArray<{ label: string; state: string; terminal?: boolean }>): object {
  const content = items
    .map((item) => `- ${item.terminal ? "✅" : "🟢"} ${escapeActivityMarkdown(item.label)} · ${formatSubagentState(item.state)}`)
    .join("\n");
  return {
    tag: "collapsible_panel", expanded: true, border: { color: "blue", corner_radius: "6px" },
    header: { title: { tag: "plain_text", content: `🤖 Subagents · ${items.length}` } },
    elements: [{ tag: "markdown", content }]
  };
}

function formatTurnState(state: string): string {
  return state === "active" ? "🟢 运行中" : state === "completed" ? "✅ 已完成" : "⏹️ 已中止";
}

function formatSubagentState(state: string): string {
  return state === "running" || state === "active" ? "运行中" : state === "completed" ? "已完成" : escapeActivityMarkdown(state);
}

function formatCount(value: number | null): string { return value === null ? "—" : value >= 1_000_000 ? `${(value / 1_000_000).toFixed(1)}M` : value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}K` : String(value); }

function formatDuration(value: number): string { return value >= 1_000 ? `${(value / 1_000).toFixed(value >= 10_000 ? 1 : 2)}s` : `${value}ms`; }

function escapeActivityMarkdown(value: string): string {
  return value
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/[\\`*_{}[\]()#+.!|-]/g, "\\$&");
}
