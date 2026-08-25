import type { RunProgressEvent } from "../domain/run-card-view.js";

type TimelinePhase = string;

const VISIBLE_EVENT_COUNT = 3;

export function renderProgressTimeline(events: RunProgressEvent[], phase: TimelinePhase): object[] {
  if (!events.length) return [];
  const visible = events.slice(-VISIBLE_EVENT_COUNT);
  const earlier = events.slice(0, -VISIBLE_EVENT_COUNT);
  const elements: object[] = [{ tag: "markdown", content: visible.map(progressLine).join("\n") }];
  if (earlier.length) {
    elements.push({
      tag: "collapsible_panel", expanded: false,
      header: { title: { tag: "plain_text", content: `查看完整过程（${earlier.length}）` } },
      elements: [{ tag: "markdown", content: earlier.map(progressLine).join("\n") }]
    });
  }
  return [{
    tag: "collapsible_panel", expanded: true, border: { color: timelineColor(phase), corner_radius: "6px" },
    header: { title: { tag: "plain_text", content: timelineTitle(events, phase) } },
    elements
  }];
}

function timelineTitle(events: RunProgressEvent[], phase: TimelinePhase): string {
  const steps = events.filter((event) => event.kind === "step");
  const done = steps.filter((event) => event.state === "done").length;
  if (phase === "blocked" || phase === "failed" || phase === "error") return `过程轨迹 · 需要处理 · ${events.length} 项`;
  if (phase === "running") return steps.length ? `过程轨迹 · 进行中 · ${done}/${steps.length}` : `过程轨迹 · 进行中 · ${events.length} 项`;
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
