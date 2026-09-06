import type { CardTargetRef } from "../domain/card-target-ref.js";
import type { WorkerMainTaskSummary, WorkerMainView } from "../domain/worker-main-view.js";
import { normalizeLarkPreview, truncateLarkMarkdown } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";
import { callbackButton } from "./cardkit-button.js";
import { cardSection, lifecycleMarker } from "./card-style.js";

const PHASE_LABEL: Record<WorkerMainTaskSummary["phase"], string> = { queued: "排队", preparing: "准备中", running: "执行中", blocked: "阻塞", completed: "完成", failed: "失败", cancelled: "取消", "dispatch-uncertain": "派发不确定" };
const RUNTIME_LABEL: Record<WorkerMainView["runtimeState"], string> = { unprovisioned: "未配置", starting: "启动中", idle: "空闲", working: "工作中", blocked: "阻塞", detached: "已脱离", stopped: "已停止", failed: "失败", terminated: "已终止" };

export function renderWorkerMainCard(view: WorkerMainView, options: { snapshot?: boolean } = {}): object {
  const elements: object[] = [
    { tag: "markdown", content: `**👤 Owner**  ${safe(view.ownerName)}  ·  **🖥️ Primary pane**  \`${safe(view.parentPaneId)}\`\n**🧾 Session**  ${view.workerSessionGeneration}  ·  **⚙️ Runtime**  ${lifecycleMarker(view.runtimeState)} ${RUNTIME_LABEL[view.runtimeState]}  ·  **Runtime gen**  ${view.runtimeGeneration}` },
    { tag: "markdown", content: `**📂 Workspace**  ${safe(view.workspace)}${view.branch ? `\n**🌿 Branch**  \`${safe(view.branch)}\`` : ""}${view.model ? `  ·  **🧠 Model**  ${safe(view.model)}` : ""}` },
    { tag: "hr" },
    { tag: "markdown", content: currentTaskContent(view.currentTask) }
  ];
  pushTaskLink(elements, view.currentTask?.taskCard ?? null, "打开当前 Task Card");
  elements.push({ tag: "markdown", content: `**📨 Queue**  ${view.queueCount} queued${view.nextTaskTitle ? `  ·  next: ${safe(view.nextTaskTitle)}` : ""}` });
  if (view.recentTasks.length > 0) {
    elements.push({ tag: "hr" }, { tag: "markdown", content: `${cardSection("🕘", "Recent Tasks")}\n${view.recentTasks.map(taskLine).join("\n")}` });
    for (const task of view.recentTasks) pushTaskLink(elements, task.taskCard, `打开 ${safe(task.title)}`);
  }
  if (!options.snapshot && !view.frozenAt && !["terminated", "failed", "stopped"].includes(view.runtimeState) && view.messageId) {
    elements.push(
      { tag: "markdown", content: view.currentTask ? `新任务将进入 FIFO 队列；当前还有 ${view.queueCount} 条等待。` : "新任务可立即执行，且与历史任务无父子关系。" },
      callbackButton("发起新任务", { action: "worker_new_task_form", instanceId: view.workerId, generation: view.runtimeGeneration, workerSessionGeneration: view.workerSessionGeneration, sourceCardMessageId: view.messageId }, "primary")
    );
  }
  if (view.frozenAt) elements.push({ tag: "markdown", content: `📦 Worker session 已终止并冻结 · ${view.frozenAt}` });
  return {
    schema: "2.0", config: { update_multi: true, summary: { content: `${view.workerName} · ${RUNTIME_LABEL[view.runtimeState]}` } },
    header: { title: { tag: "plain_text", content: `🤖 Worker · ${safe(view.workerName)}` }, subtitle: { tag: "plain_text", content: "HERDR WORKER SESSION" }, template: view.runtimeState === "failed" ? "red" : view.runtimeState === "blocked" ? "orange" : view.runtimeState === "terminated" ? "grey" : "blue" },
    body: { elements }
  };
}

function currentTaskContent(task: WorkerMainTaskSummary | null): string {
  return task ? `${cardSection("🎯", "Current Task")}\n${lifecycleMarker(task.phase)} ${safe(task.title)}  ·  ${PHASE_LABEL[task.phase]}${task.durationSeconds === null ? "" : `  ·  ${formatDuration(task.durationSeconds)}`}` : `${cardSection("🎯", "Current Task")}\nNo active task`;
}

function taskLine(task: WorkerMainTaskSummary): string {
  return `- ${lifecycleMarker(task.phase)} ${PHASE_LABEL[task.phase]}  ${safe(task.title)}${task.durationSeconds === null ? "" : `  ${formatDuration(task.durationSeconds)}`}`;
}

function pushTaskLink(elements: object[], target: CardTargetRef | null, label: string): void {
  if (!target?.messageId) return;
  elements.push({ tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "auto", elements: [callbackButton(label, { action: "card_target_open", ...target }, "default")] }] });
}

function safe(value: string): string { return truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(value)), 300); }
function formatDuration(seconds: number): string { const minutes = Math.floor(seconds / 60); const rest = seconds % 60; return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`; }
