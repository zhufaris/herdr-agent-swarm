import { summarizeProgress, type RunProgressEvent, type RunProgressSummary } from "../domain/run-card-view.js";

type TimelinePhase = string;

const DEFAULT_VISIBLE_EVENT_COUNT = 3;

export function renderProgressTimeline(events: RunProgressEvent[], phase: TimelinePhase, options: { title?: string; summary?: RunProgressSummary; visibleCount?: number } = {}): object[] {
  if (!events.length) return [];
  const summary = options.summary ?? summarizeProgress(events);
  const visible = events.slice(-Math.max(1, options.visibleCount ?? DEFAULT_VISIBLE_EVENT_COUNT));
  const earlierCount = Math.max(0, summary.total - visible.length);
  const elements: object[] = [{ tag: "markdown", content: visible.map(progressLine).join("\n") }];
  if (earlierCount) elements.push({ tag: "markdown", content: `… 更早 ${earlierCount} 项已省略，可在 Herdr pane 查看完整过程。` });
  return [{
    tag: "collapsible_panel", expanded: true, border: { color: timelineColor(phase), corner_radius: "6px" },
    header: { title: { tag: "plain_text", content: options.title ? activityTitle(options.title, summary, phase) : timelineTitle(summary, phase) } },
    elements
  }];
}

function activityTitle(title: string, summary: RunProgressSummary, phase: TimelinePhase): string {
  if (phase === "blocked" || phase === "failed" || phase === "error") return `${title} · 需要处理 · ${summary.total} 项`;
  return `${title} · ${summary.total} 项`;
}

function timelineTitle(summary: RunProgressSummary, phase: TimelinePhase): string {
  if (phase === "blocked" || phase === "failed" || phase === "error") return `过程轨迹 · 需要处理 · ${summary.total} 项`;
  if (phase === "running") return summary.stepTotal ? `过程轨迹 · 进行中 · ${summary.stepDone}/${summary.stepTotal}` : `过程轨迹 · 进行中 · ${summary.total} 项`;
  if (phase === "completed" || phase === "done") return `过程轨迹 · 已完成 · ${summary.total} 项`;
  return `过程轨迹 · ${summary.total} 项`;
}

function timelineColor(phase: TimelinePhase): string {
  if (phase === "blocked") return "orange";
  if (phase === "failed" || phase === "error") return "red";
  if (phase === "completed" || phase === "done") return "green";
  return "blue";
}

function progressLine(event: RunProgressEvent): string {
  const label = boundedLabel(event.label);
  const state = { pending: "☐", active: "◌", done: "✓", failed: "✕" }[event.state];
  const icon = { analyze: "🧠", search: "🔎", read: "📖", edit: "🛠️", test: "🧪", step: "•" }[event.kind];
  return `${state} ${icon} ${label}`;
}

function boundedLabel(label: string): string {
  const normalized = label.replace(/\s+/g, " " ).trim();
  return normalized.length > 200 ? `${normalized.slice(0, 199).trimEnd()}…` : normalized || "未命名步骤";
}
