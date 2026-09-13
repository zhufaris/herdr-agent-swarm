import { canSubmitWorkerMainTask, type WorkerMainTaskSummary, type WorkerMainView } from "../domain/worker-main-view.js";
import { normalizeLarkPreview, truncateLarkMarkdown } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";
import { callbackButton } from "./cardkit-button.js";
import { actionRow, cardSection, compactMetadata, lifecycleMarker, recentItems } from "./card-style.js";
import { workerTaskInteraction } from "../domain/worker-task-interaction.js";

const PHASE_LABEL: Record<WorkerMainTaskSummary["phase"], string> = { queued: "排队", preparing: "准备中", running: "执行中", blocked: "阻塞", completed: "完成", failed: "失败", cancelled: "取消", "dispatch-uncertain": "派发不确定" };
const RUNTIME_LABEL: Record<WorkerMainView["runtimeState"], string> = { unprovisioned: "未配置", starting: "启动中", idle: "空闲", working: "工作中", blocked: "阻塞", detached: "已脱离", stopped: "已停止", failed: "失败", terminated: "已终止" };

export function renderWorkerMainCard(view: WorkerMainView, options: { snapshot?: boolean; projectDisplayName?: string } = {}): object {
  const elements: object[] = [
    { tag: "markdown", content: compactMetadata([`${lifecycleMarker(view.runtimeState)} ${RUNTIME_LABEL[view.runtimeState]}`, `队列 \`${view.queueCount}\``, view.model ? `模型 \`${safe(view.model)}\`` : null]) },
  ];
  if (view.currentTask?.notice) elements.push({ tag: "markdown", content: `⚠️ ${safe(view.currentTask.notice)}` });
  elements.push({ tag: "markdown", content: currentTaskContent(view.currentTask) });
  if (view.currentTask?.statusTitle) elements.push({ tag: "markdown", content: `${cardSection("📈", "进度")}  ${safe(view.currentTask.statusTitle)}${progressLines(view.currentTask).join("")}` });
  if (view.currentTask?.answer) elements.push({ tag: "hr" }, { tag: "markdown", content: `${cardSection("📝", "当前输出")}\n\n${safeOutput(view.currentTask.answer)}` });
  pushActions(elements, view, options.snapshot === true);
  elements.push({ tag: "markdown", content: `${cardSection("📨", "队列")}\n${view.queueCount} 条等待${view.nextTaskTitle ? `  ·  下一项 ${safe(view.nextTaskTitle)}` : ""}` });
  if (view.recentTasks.length > 0) {
    elements.push({ tag: "markdown", content: `${cardSection("🕘", "最近任务")}\n${recentItems(view.recentTasks, 5).map(taskLine).join("\n")}` });
  }
  elements.push({ tag: "hr" }, { tag: "markdown", content: runtimeDetails(view) });
  if (view.frozenAt) elements.push({ tag: "markdown", content: `📦 Worker session 已终止并冻结 · ${view.frozenAt}` });
  return {
    schema: "2.0", config: { update_multi: true, summary: { content: `${view.workerName} · ${RUNTIME_LABEL[view.runtimeState]}` } },
    header: { title: { tag: "plain_text", content: `🤖 Worker · ${safe(view.workerName)} · ${safe(view.primaryPaneName ?? view.parentPaneId)} · ${safe(options.projectDisplayName ?? view.projectId ?? "Unknown project")}` }, subtitle: { tag: "plain_text", content: "HERDR WORKER SESSION" }, template: view.runtimeState === "failed" ? "red" : view.runtimeState === "blocked" ? "orange" : view.runtimeState === "terminated" ? "grey" : "blue" },
    body: { elements }
  };
}

export function renderWorkerStatusSnapshot(view: WorkerMainView, generatedAt: string): object {
  const card = renderWorkerMainCard(view, { snapshot: true }) as {
    schema: string;
    config: Record<string, unknown>;
    header: { title: { tag: string; content: string }; subtitle: { tag: string; content: string }; template: string };
    body: { elements: object[] };
  };
  const target = view.messageId
    ? callbackButton("查看持续更新的 Worker Main Card", { action: "card_target_open", aggregateKind: "worker-session", aggregateId: view.workerId, generation: view.workerSessionGeneration, messageId: view.messageId }, "primary")
    : null;
  return {
    ...card,
    config: { ...card.config, update_multi: true, summary: { content: `${view.workerName} · 状态快照` } },
    header: { ...card.header, title: { tag: "plain_text", content: `📸 Worker 状态快照 · ${safe(view.workerName)}` }, subtitle: { tag: "plain_text", content: "ONE-TIME · READ-ONLY" } },
    body: { elements: [
      { tag: "markdown", content: `**一次性快照，不会自动更新**  ·  生成于 ${safe(generatedAt)}\n持续状态请查看 canonical Worker Main Card。` },
      ...(target ? [{ tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "auto", elements: [target] }] }] : []),
      { tag: "hr" },
      ...card.body.elements
    ] }
  };
}

export function renderWorkerThreadEntryCard(view: WorkerMainView, generatedAt: string): object {
  const card = renderWorkerMainCard(view, { snapshot: true }) as {
    schema: string; config: Record<string, unknown>; header: Record<string, unknown>; body: { elements: object[] };
  };
  return {
    ...card,
    config: { ...card.config, update_multi: false, summary: { content: `${view.workerName} · Worker 对话入口` } },
    header: { ...card.header, title: { tag: "plain_text", content: `🤖 Worker 对话 · ${safe(view.workerName)}` }, subtitle: { tag: "plain_text", content: "LEGACY SESSION ENTRY · READ-ONLY" } },
    body: { elements: [
      { tag: "markdown", content: `**此入口卡是一次性快照，不会自动更新**  ·  生成于 ${safe(generatedAt)}\n在本 Thread 直接发消息可为该 Worker 创建新任务；使用 \`/status\` 获取最新状态。` },
      { tag: "hr" },
      ...card.body.elements
    ] }
  };
}

export function renderWorkerThreadEntryReadyCard(input: { workerName: string; workerId: string; workerSessionGeneration: number; messageId: string }): object {
  return {
    schema: "2.0", config: { update_multi: false, summary: { content: `Worker 已就绪 · ${input.workerName}` } },
    header: { title: { tag: "plain_text", content: `✅ Worker 已就绪 · ${safe(input.workerName)}` }, subtitle: { tag: "plain_text", content: "GROUP WORKER THREAD" }, template: "green" },
    body: { elements: [
      { tag: "markdown", content: "Worker 的实时状态、任务和后续交互都在群里的独立 Worker Thread 中。" },
      { tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "auto", elements: [callbackButton("打开 Worker Thread", { action: "card_target_open", aggregateKind: "worker-session", aggregateId: input.workerId, generation: input.workerSessionGeneration, messageId: input.messageId }, "primary")] }] }
    ] }
  };
}

function currentTaskContent(task: WorkerMainTaskSummary | null): string {
  return task ? `${cardSection("🎯", "当前任务")}\n${lifecycleMarker(task.phase)} ${safe(task.title)}  ·  ${PHASE_LABEL[task.phase]}${task.durationSeconds === null ? "" : `  ·  ${formatDuration(task.durationSeconds)}`}${task.requestText ? `\n\n${safeOutput(task.requestText)}` : ""}` : `${cardSection("🎯", "当前任务")}\n暂无任务记录`;
}

function taskLine(task: WorkerMainTaskSummary): string {
  return `- ${lifecycleMarker(task.phase)} ${PHASE_LABEL[task.phase]}  ${safe(task.title)}${task.durationSeconds === null ? "" : `  ${formatDuration(task.durationSeconds)}`}`;
}

function pushActions(elements: object[], view: WorkerMainView, snapshot: boolean): void {
  if (snapshot || !view.messageId) return;
  const task = view.currentTask;
  const buttons: object[] = []; const guidance: string[] = [];
  if (task) {
    const interaction = workerTaskInteraction(task.phase);
    const identity = { turnId: task.turnId, instanceId: view.workerId, generation: view.runtimeGeneration, workerSessionGeneration: view.workerSessionGeneration, sourceCardMessageId: view.messageId };
    if (interaction.actionLabel) { guidance.push(interaction.guidance); buttons.push(callbackButton(interaction.actionLabel, { action: "worker_task_instruction_form", ...identity }, "primary")); }
    if (interaction.canInterrupt) buttons.push(callbackButton("停止当前任务", { action: "worker_task_interrupt", ...identity }, "danger"));
  }
  if (canSubmitWorkerMainTask(view)) { guidance.push(task ? `新任务将进入 FIFO 队列；当前还有 ${view.queueCount} 条等待。` : "新任务可立即执行，且与历史任务无父子关系。"); buttons.push(callbackButton("发起新任务", { action: "worker_new_task_form", instanceId: view.workerId, generation: view.runtimeGeneration, workerSessionGeneration: view.workerSessionGeneration, sourceCardMessageId: view.messageId }, "primary")); }
  const row = actionRow(buttons);
  if (row) elements.push({ tag: "markdown", content: [...new Set(guidance)].join("\n") }, row);
}

function progressLines(task: WorkerMainTaskSummary): string[] {
  return recentItems(task.progressEvents ?? [], 3).map((event) => `\n${lifecycleMarker(event.state === "done" ? "completed" : event.state === "active" ? "running" : event.state)} ${safe(event.label)}`);
}
function runtimeDetails(view: WorkerMainView): string { return [cardSection("🖥️", "运行环境"), compactMetadata([`Owner ${safe(view.ownerName)}`, `Primary \`${safe(view.parentPaneId)}\``, `Session \`${view.workerSessionGeneration}\``, `Runtime \`${view.runtimeGeneration}\``]), `Workspace  ${safe(view.workspace)}${view.branch ? `\nBranch  \`${safe(view.branch)}\`` : ""}`].join("\n"); }
function safeOutput(value: string): string { return truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(value)), 6_000); }

function safe(value: string): string { return truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(value)), 300); }
function formatDuration(seconds: number): string { const minutes = Math.floor(seconds / 60); const rest = seconds % 60; return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`; }
