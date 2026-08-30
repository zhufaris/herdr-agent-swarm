import type { RunProgressEvent } from "../domain/run-card-view.js";

type TimelinePhase = string;

const VISIBLE_EVENT_COUNT = 3;

export function renderProgressTimeline(events: RunProgressEvent[], phase: TimelinePhase, options: { title?: string } = {}): object[] {
  if (!events.length) return [];
  const visible = events.slice(-VISIBLE_EVENT_COUNT);
  const earlierCount = Math.max(0, events.length - VISIBLE_EVENT_COUNT);
  const elements: object[] = [{ tag: "markdown", content: visible.map(progressLine).join("\n") }];
  if (earlierCount) elements.push({ tag: "markdown", content: `… 更早 ${earlierCount} 项已省略，可在 Herdr pane 查看完整过程。` });
  return [{
    tag: "collapsible_panel", expanded: true, border: { color: timelineColor(phase), corner_radius: "6px" },
    header: { title: { tag: "plain_text", content: options.title ? activityTitle(options.title, events, phase) : timelineTitle(events, phase) } },
    elements
  }];
}

function activityTitle(title: string, events: RunProgressEvent[], phase: TimelinePhase): string {
  if (phase === "blocked" || phase === "failed" || phase === "error") return `${title} · 需要处理 · ${events.length} 项`;
  if (phase === "running") return `${title} · ${events.length} 项`;
  return `${title} · ${events.length} 项`;
}

function timelineTitle(events: RunProgressEvent[], phase: TimelinePhase): string {
  let stepCount = 0;
  let doneStepCount = 0;
  for (const event of events) {
    if (event.kind !== "step") continue;
    stepCount += 1;
    if (event.state === "done") doneStepCount += 1;
  }
  if (phase === "blocked" || phase === "failed" || phase === "error") return `过程轨迹 · 需要处理 · ${events.length} 项`;
  if (phase === "running") return stepCount ? `过程轨迹 · 进行中 · ${doneStepCount}/${stepCount}` : `过程轨迹 · 进行中 · ${events.length} 项`;
  if (phase === "completed" || phase === "done") return `过程轨迹 · 已完成 · ${events.length} 项`;
  return `过程轨迹 · ${events.length} 项`;
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
