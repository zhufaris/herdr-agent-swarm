import { workerTurnProgressElementId, workerTurnStreamContent, type WorkerTurnCardPage, type WorkerTurnCardView } from "../domain/worker-turn-card-view.js";
import { normalizeLarkPreview, renderLarkMarkdownPage, truncateLarkMarkdown } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";
import { callbackButton } from "./cardkit-button.js";
import { cardSection, lifecycleMarker } from "./card-style.js";
import { workerTaskInteraction } from "../domain/worker-task-interaction.js";

const STATE = {
  queued: { label: "已排队", icon: "⏳", color: "blue" },
  preparing: { label: "正在准备", icon: "⏳", color: "blue" },
  running: { label: "Worker 正在处理", icon: "🧠", color: "blue" },
  blocked: { label: "等待本地处理", icon: "⚠️", color: "orange" },
  completed: { label: "任务完成", icon: "✅", color: "green" },
  failed: { label: "执行失败", icon: "❌", color: "red" },
  cancelled: { label: "任务已取消", icon: "⏹️", color: "purple" },
  "dispatch-uncertain": { label: "派发状态不确定", icon: "⚠️", color: "orange" }
} as const;

const REQUEST_PREVIEW_LIMIT = 2_000;

export function renderWorkerTurnCard(view: WorkerTurnCardView, page?: WorkerTurnCardPage, options: { snapshot?: boolean } = {}): object {
  const state = STATE[view.phase];
  const pageIndex = page?.pageIndex ?? view.pageIndex;
  const elementId = page?.elementId ?? view.elementId;
  const actionMessageId = page ? page.messageId : view.messageId;
  const showOutput = view.phase === "completed";
  const content = showOutput
    ? page?.state === "active"
      ? "正在整理最终输出…"
      : renderLarkMarkdownPage(workerTurnContent(view), page?.pageStart ?? view.pageStart, 9_000).page || workerTurnStatusContent(view)
    : "";
  const metadata = [
    `${state.icon} ${state.label}`,
    view.phase === "queued" ? `队列第 ${view.queuePosition} 位` : null,
    `Turn \`${escapeCode(view.turnId)}\``,
    pageIndex > 0 ? `第 ${pageIndex + 1} 页` : null
  ].filter(Boolean).join("  ·  " );
  const elements: object[] = [
    { tag: "markdown", content: metadata },
    { tag: "markdown", content: `${cardSection("💬", "请求")}\n\n${truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(view.requestText)), REQUEST_PREVIEW_LIMIT)}` }
  ];
  elements.push({ tag: "markdown", element_id: workerTurnProgressElementId(view.turnId, pageIndex), content: workerTurnProgressContent(view) });
  if (view.parentTurnId) elements.push({ tag: "markdown", content: `${cardSection("🔗", "承接任务")}  \`${escapeCode(view.parentTurnId)}\`` });
  if (view.notice) elements.push(callout(view.phase === "failed" ? "red" : "orange", redactSecrets(view.notice)));
  if (showOutput) elements.push({ tag: "hr" }, { tag: "markdown", element_id: elementId, content });
  const interaction = workerTaskInteraction(view.phase);
  elements.push({ tag: "markdown", content: options.snapshot ? "📸 这是只读状态快照；如需继续或补充任务，请使用原 Worker Task Card。" : interaction.guidance });
  if (!options.snapshot && interaction.actionLabel && actionMessageId) elements.push({ tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: [
    { tag: "column", width: "auto", elements: [callbackButton(interaction.actionLabel, { action: "worker_task_instruction_form", turnId: view.turnId, instanceId: view.instanceId, generation: view.instanceGeneration, workerSessionGeneration: view.workerSessionGeneration, sourceCardMessageId: actionMessageId }, "primary")] },
    ...(interaction.canInterrupt ? [{ tag: "column", width: "auto", elements: [callbackButton("停止当前任务", { action: "worker_task_interrupt", turnId: view.turnId, instanceId: view.instanceId, generation: view.instanceGeneration, workerSessionGeneration: view.workerSessionGeneration, sourceCardMessageId: actionMessageId }, "danger")] }] : [])
  ] });
  const targets = [
    view.workerMain.messageId ? callbackButton("View Worker Main", { action: "card_target_open", ...view.workerMain }, "primary") : null,
    view.primaryAnswer?.messageId ? callbackButton("View Primary Answer", { action: "card_target_open", ...view.primaryAnswer }, "default") : null
  ].filter((button): button is object => button !== null);
  if (targets.length > 0) elements.push({ tag: "column_set", flex_mode: "none", horizontal_spacing: "8px", columns: targets.map((button) => ({ tag: "column", width: "auto", elements: [button] })) });
  return {
    schema: "2.0",
    config: { update_multi: true, streaming_mode: !options.snapshot && ["preparing", "running", "blocked"].includes(view.phase), summary: { content: `${view.workerName} · ${state.label}` } },
    header: {
      title: { tag: "plain_text", content: `🎯 ${view.workerName} · Task ${view.turnId.slice(0, 8)}` },
      subtitle: { tag: "plain_text", content: "HERDR WORKER TASK" },
      template: state.color
    },
    body: { elements }
  };
}

export function renderWorkerNoTaskCard(workerName: string): object {
  const name = truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(workerName)), 300);
  return {
    schema: "2.0",
    config: { update_multi: false, summary: { content: `${name} · 暂无 Task` } },
    header: { title: { tag: "plain_text", content: `🎯 ${name} · 暂无 Task` }, subtitle: { tag: "plain_text", content: "HERDR WORKER TASK" }, template: "grey" },
    body: { elements: [{ tag: "markdown", content: "该 Worker 当前还没有任务记录。" }] }
  };
}

function workerTurnContent(view: WorkerTurnCardView): string {
  if (view.phase !== "completed") return "";
  const output = workerTurnStreamContent(view);
  if (output.trim()) return normalizeLarkPreview(redactSecrets(output));
  return "";
}

function workerTurnStatusContent(view: WorkerTurnCardView): string {
  if (view.phase === "completed") return "✅ Worker 已完成任务。";
  if (view.phase === "failed") return "❌ Worker 执行失败。";
  if (view.phase === "cancelled") return "⏹️ Worker 任务已取消。";
  if (view.phase === "dispatch-uncertain") return "⚠️ 无法确认任务是否已到达 Worker；为避免重复执行，系统不会自动重放。";
  if (view.phase === "blocked") return "⚠️ Worker 正在等待 Herdr 中的本地操作。";
  return view.phase === "queued" ? "⏳ 任务已进入 Worker FIFO 队列。" : "⏳ 等待 Worker 输出，本卡片会持续更新。";
}

export function workerTurnProgressContent(view: WorkerTurnCardView): string {
  const status = view.statusTitle ? `${cardSection("📈", "进度")}  ${normalizeLarkPreview(redactSecrets(view.statusTitle))}` : cardSection("📈", "进度");
  const steps = view.progressEvents.map((event) => {
    const icon = lifecycleMarker(event.state === "done" ? "completed" : event.state === "active" ? "running" : event.state);
    return `${icon} ${normalizeLarkPreview(redactSecrets(event.label))}`;
  });
  return steps.length > 0 ? [status, ...steps].join("\n") : `${status}\n\n等待 Worker 更新。`;
}

function callout(type: "orange" | "red", content: string): object {
  return { tag: "column_set", background_style: type === "red" ? "red-50" : "orange-50", columns: [{ tag: "column", width: "weighted", weight: 1, elements: [{ tag: "markdown", content }] }] };
}

function escapeCode(value: string): string { return value.replace(/`/g, "'"); }
