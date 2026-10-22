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
  const summary: string[] = [];
  const details: string[] = [];
  const identity = state.paneIdentity;
  if (state.lastTurnState) summary.push(formatTurnState(state.lastTurnState));
  if (state.modelUsage.model) summary.push(escapeActivityMarkdown(state.modelUsage.model));
  if (state.modelUsage.contextRemainingPercent != null) summary.push(`ctx ${state.modelUsage.contextRemainingPercent}%`);
  if (state.modelUsage.inputTokens != null || state.modelUsage.outputTokens != null) {
    summary.push(`${formatCount(state.modelUsage.inputTokens)} in · ${formatCount(state.modelUsage.outputTokens)} out`);
  }
  if (state.compactionCount != null) summary.push(`🧹 ${state.compactionCount}x`);
  if (identity?.workspace) details.push(`Workspace · ${escapeActivityMarkdown(identity.workspace)}`);
  if (identity?.worktreeName) details.push(`Worktree · ${escapeActivityMarkdown(identity.worktreeName)}`);
  if (identity?.branch) details.push(`Branch · ${escapeActivityMarkdown(identity.branch)}`);
  const latency = [
    state.modelUsage.waitMs != null ? `Wait ${formatDuration(state.modelUsage.waitMs)}` : null,
    state.modelUsage.firstVisibleMs != null ? `First visible ${formatDuration(state.modelUsage.firstVisibleMs)}` : null
  ].filter((value): value is string => value !== null);
  if (latency.length) details.push(latency.join(" · "));
  const sessionUsage = [
    state.tokenUsage != null ? `Session tokens ${formatCount(state.tokenUsage)}` : null,
    state.contextUsage != null ? `Session context ${state.contextUsage}%` : null
  ].filter((value): value is string => value !== null);
  if (sessionUsage.length) details.push(sessionUsage.join(" · "));
  const activeSubagents = state.activeSubagents ?? [];
  return [
    { tag: "markdown", content: summary.length ? `${cardSection("🧭", "Session State")}  ·  ${summary.join("  ·  ")}` : `${cardSection("🧭", "Session State")}\nUnavailable` },
    ...(details.length ? [{
      tag: "collapsible_panel", expanded: false, border: { color: "grey", corner_radius: "6px" },
      header: { title: { tag: "plain_text", content: "Session details" } },
      elements: [{ tag: "markdown", content: details.join("\n") }]
    }] : []),
    ...(activeSubagents.length ? [renderSubagentsPanel(activeSubagents, false)] : [])
  ];
}

function renderSubagentsPanel(items: ReadonlyArray<{ label: string; state: string; terminal?: boolean }>, expanded = true): object {
  const content = items
    .map((item) => `- ${item.terminal ? "✅" : "🟢"} ${escapeActivityMarkdown(item.label)} · ${formatSubagentState(item.state)}`)
    .join("\n");
  return {
    tag: "collapsible_panel", expanded, border: { color: "blue", corner_radius: "6px" },
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
