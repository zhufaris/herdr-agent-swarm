import { workerTurnStreamContent, type WorkerTurnCardPage, type WorkerTurnCardView } from "../domain/worker-turn-card-view.js";
import { normalizeLarkPreview, renderLarkMarkdownPage, truncateLarkMarkdown } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";
import { callbackButton } from "./cardkit-button.js";

const STATE = {
  queued: { label: "已排队", icon: "⏳", color: "blue" },
  preparing: { label: "正在准备", icon: "◌", color: "blue" },
  running: { label: "Worker 正在处理", icon: "🧠", color: "blue" },
  blocked: { label: "等待本地处理", icon: "⚠️", color: "orange" },
  completed: { label: "任务完成", icon: "✅", color: "green" },
  failed: { label: "执行失败", icon: "❌", color: "red" },
  cancelled: { label: "任务已取消", icon: "⏹", color: "grey" },
  "dispatch-uncertain": { label: "派发状态不确定", icon: "⚠️", color: "orange" }
} as const;

const REQUEST_PREVIEW_LIMIT = 2_000;

export function renderWorkerTurnCard(view: WorkerTurnCardView, page?: WorkerTurnCardPage): object {
  const state = STATE[view.phase];
  const pageIndex = page?.pageIndex ?? view.pageIndex;
  const elementId = page?.elementId ?? view.elementId;
  const content = renderLarkMarkdownPage(workerTurnContent(view), page?.pageStart ?? view.pageStart, 9_000).page || workerTurnStatusContent(view);
  const metadata = [
    `${state.icon} ${state.label}`,
    view.phase === "queued" ? `队列第 ${view.queuePosition} 位` : null,
    `Turn \`${escapeCode(view.turnId)}\``,
    pageIndex > 0 ? `第 ${pageIndex + 1} 页` : null
  ].filter(Boolean).join("  ·  " );
  const elements: object[] = [
    { tag: "markdown", content: metadata },
    { tag: "markdown", content: `**请求**\n\n${truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(view.requestText)), REQUEST_PREVIEW_LIMIT)}` }
  ];
  if (view.parentTurnId) elements.push({ tag: "markdown", content: `**承接任务**  \`${escapeCode(view.parentTurnId)}\`` });
  if (view.notice) elements.push(callout(view.phase === "failed" ? "red" : "orange", redactSecrets(view.notice)));
  elements.push({ tag: "hr" }, { tag: "markdown", element_id: elementId, content });
  elements.push({
    tag: "column_set", flex_mode: "none", horizontal_spacing: "8px",
    columns: [{ tag: "column", width: "auto", elements: [callbackButton("View Worker", { action: "instance_view", instanceId: view.instanceId, instanceGeneration: view.instanceGeneration }, "primary")] }]
  });
  return {
    schema: "2.0",
    config: { update_multi: true, streaming_mode: ["preparing", "running", "blocked"].includes(view.phase), summary: { content: `${view.workerName} · ${state.label}` } },
    header: {
      title: { tag: "plain_text", content: `${view.workerName} · Task ${view.turnId.slice(0, 8)}` },
      subtitle: { tag: "plain_text", content: "HERDR WORKER TASK" },
      template: state.color
    },
    body: { elements }
  };
}

function workerTurnContent(view: WorkerTurnCardView): string {
  const output = workerTurnStreamContent(view);
  if (output.trim()) return normalizeLarkPreview(redactSecrets(output));
  return "";
}

function workerTurnStatusContent(view: WorkerTurnCardView): string {
  if (view.phase === "completed") return "✅ Worker 已完成任务。";
  if (view.phase === "failed") return "❌ Worker 执行失败。";
  if (view.phase === "cancelled") return "⏹ Worker 任务已取消。";
  if (view.phase === "dispatch-uncertain") return "⚠️ 无法确认任务是否已到达 Worker；为避免重复执行，系统不会自动重放。";
  if (view.phase === "blocked") return "⚠️ Worker 正在等待 Herdr 中的本地操作。";
  return view.phase === "queued" ? "⏳ 任务已进入 Worker FIFO 队列。" : "⏳ 等待 Worker 输出，本卡片会持续更新。";
}

function callout(type: "orange" | "red", content: string): object {
  return { tag: "column_set", background_style: type === "red" ? "red-50" : "orange-50", columns: [{ tag: "column", width: "weighted", weight: 1, elements: [{ tag: "markdown", content }] }] };
}

function escapeCode(value: string): string { return value.replace(/`/g, "'"); }
