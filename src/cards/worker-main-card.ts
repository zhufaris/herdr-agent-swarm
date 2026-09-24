import { canSubmitWorkerMainTask, type WorkerMainTaskSummary, type WorkerMainView } from "../domain/worker-main-view.js";
import { normalizeLarkPreview, truncateLarkMarkdown } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";
import { callbackButton } from "./cardkit-button.js";
import { actionRow, cardSection, compactMetadata, lifecycleMarker, recentItems } from "./card-style.js";
import { renderProgressTimeline } from "./progress-timeline.js";
import { workerTaskInteraction } from "../domain/worker-task-interaction.js";
import { currentPageActionLabel } from "../domain/card-page-handoff.js";
import { currentMainCardActivity } from "../domain/main-card-activity.js";

const PHASE_LABEL: Record<WorkerMainTaskSummary["phase"], string> = { queued: "排队", preparing: "准备中", running: "执行中", blocked: "阻塞", completed: "完成", failed: "失败", cancelled: "取消", "dispatch-uncertain": "派发不确定" };
const RUNTIME_LABEL: Record<WorkerMainView["runtimeState"], string> = { unprovisioned: "未配置", starting: "启动中", idle: "空闲", working: "工作中", blocked: "阻塞", detached: "已脱离", stopped: "已停止", failed: "失败", terminated: "已终止" };

export function renderWorkerMainCard(view: WorkerMainView, options: { snapshot?: boolean; projectDisplayName?: string } = {}): object {
  const progressEvents = view.currentTask?.progressEvents ?? [];
  const planProgress = progressEvents.filter(({ key }) => key.startsWith("plan:"));
  const currentActivity = currentMainCardActivity(progressEvents, new Set(planProgress.map(({ key }) => key)));
  const elements: object[] = [
    { tag: "markdown", content: compactMetadata([`${lifecycleMarker(view.runtimeState)} ${RUNTIME_LABEL[view.runtimeState]}`, `Worker \`${workerPaneLabel(view)}\``, `队列 \`${view.queueCount}\``, view.model ? `模型 \`${safe(view.model)}\`` : null]) },
  ];
  if (view.currentTask?.phase === "blocked") elements.push(actionableNotice(view));
  else if (view.currentTask?.notice) elements.push({ tag: "markdown", content: `⚠️ ${safe(view.currentTask.notice)}` });
  elements.push({ tag: "markdown", content: currentTaskContent(view.currentTask) });
  if (planProgress.length && view.currentTask) elements.push(...renderProgressTimeline(planProgress, timelinePhase(view.currentTask.phase), { title: "📋 任务清单", visibleCount: 5 }));
  if (view.currentTask?.answer) elements.push({ tag: "hr" }, { tag: "markdown", content: `${cardSection("📝", "最新消息")}\n\n${safeOutput(view.currentTask.answer)}` });
  if (currentActivity.length && view.currentTask) elements.push(...renderProgressTimeline(currentActivity, timelinePhase(view.currentTask.phase), { title: "⚙️ 当前活动", visibleCount: 1 }));
  pushActions(elements, view, options.snapshot === true);
  elements.push({ tag: "markdown", content: `${cardSection("📨", "队列")}\n${view.queueCount} 条等待${view.nextTaskTitle ? `  ·  下一项 ${safe(view.nextTaskTitle)}` : ""}` });
  if (view.recentTasks.length > 0) {
    elements.push({ tag: "markdown", content: `${cardSection("🕘", "最近任务")}\n${recentItems(view.recentTasks, 5).map(taskLine).join("\n")}` });
  }
  elements.push({ tag: "hr" }, { tag: "markdown", content: runtimeDetails(view, options.projectDisplayName) });
  if (view.frozenAt) elements.push({ tag: "markdown", content: `📦 Worker session 已终止并冻结 · ${view.frozenAt}` });
  return {
    schema: "2.0", config: { update_multi: true, summary: { content: `${view.workerName} · ${workerSummaryLabel(view)}` } },
    header: { title: { tag: "plain_text", content: `🧭 Worker · ${safe(view.workerName)}` }, subtitle: { tag: "plain_text", content: `HERDR WORKER · PRIMARY ${primaryPaneLabel(view)} · ${lifecycleMarker(view.runtimeState)} ${RUNTIME_LABEL[view.runtimeState]}` }, template: runtimeTemplate(view.runtimeState) },
    body: { elements }
  };
}

function actionableNotice(view: WorkerMainView): object {
  const content = view.currentTask?.notice
    ? safe(view.currentTask.notice)
    : `Worker 正在等待本地处理。请前往 Herdr Pane \`${workerPaneLabel(view)}\` 完成审批或输入。`;
  return {
    tag: "collapsible_panel", expanded: true, border: { color: "orange", corner_radius: "6px" },
    header: { title: { tag: "plain_text", content: "需要处理" } },
    elements: [{ tag: "markdown", content }]
  };
}

function workerSummaryLabel(view: WorkerMainView): string {
  return view.currentTask?.phase === "blocked" ? "等待用户处理" : RUNTIME_LABEL[view.runtimeState];
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
    // This is immutable at the application layer, but Feishu rejects reply-card
    // payloads with update_multi disabled on this delivery path.
    config: { ...card.config, update_multi: true, summary: { content: `${view.workerName} · Worker 对话入口` } },
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
    // This is a one-time application-level entry card, but Feishu rejects a
    // reply-card payload with update_multi disabled on this delivery path.
    // We simply never enqueue a replacement for it; the platform capability
    // flag must remain enabled for the initial card to be accepted.
    schema: "2.0", config: { update_multi: true, summary: { content: `Worker 已就绪 · ${input.workerName}` } },
    header: { title: { tag: "plain_text", content: `✅ Worker 已就绪 · ${safe(input.workerName)}` }, subtitle: { tag: "plain_text", content: "GROUP WORKER THREAD" }, template: "green" },
    body: { elements: [
      { tag: "markdown", content: "Worker 的实时状态、任务和后续交互都在群里的独立 Worker Thread 中。" },
      { tag: "column_set", flex_mode: "none", columns: [{ tag: "column", width: "auto", elements: [callbackButton("打开 Worker Thread", { action: "card_target_open", aggregateKind: "worker-session", aggregateId: input.workerId, generation: input.workerSessionGeneration, messageId: input.messageId }, "primary")] }] }
    ] }
  };
}

function currentTaskContent(task: WorkerMainTaskSummary | null): string {
  if (!task) return `${cardSection("🎯", "当前任务")}\n暂无任务记录`;
  const metadata = compactMetadata([PHASE_LABEL[task.phase], task.durationSeconds === null ? null : formatDuration(task.durationSeconds), formatTokenCount(task.tokenCount)]);
  return `${cardSection("🎯", "当前任务")}\n${lifecycleMarker(task.phase)} ${safe(task.title)}${metadata ? `  ·  ${metadata}` : ""}${task.statusTitle ? `\n◈ **${safe(task.statusTitle)}**` : ""}${task.requestText ? `\n\n${safeOutput(task.requestText)}` : ""}`;
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
    if (task.taskCard.messageId) buttons.push(callbackButton(currentPageActionLabel("task"), { action: "card_target_open", ...task.taskCard }, "default"));
  }
  if (canSubmitWorkerMainTask(view)) { guidance.push(task ? `新任务将进入 FIFO 队列；当前还有 ${view.queueCount} 条等待。` : "新任务可立即执行，且与历史任务无父子关系。"); buttons.push(callbackButton("发起新任务", { action: "worker_new_task_form", instanceId: view.workerId, generation: view.runtimeGeneration, workerSessionGeneration: view.workerSessionGeneration, sourceCardMessageId: view.messageId }, "primary")); }
  const row = actionRow(buttons);
  if (row) elements.push({ tag: "markdown", content: [...new Set(guidance)].join("\n") }, row);
}

function timelinePhase(phase: WorkerMainTaskSummary["phase"]): "running" | "blocked" | "completed" | "failed" {
  if (phase === "blocked") return "blocked";
  if (phase === "completed") return "completed";
  if (phase === "failed" || phase === "cancelled" || phase === "dispatch-uncertain") return "failed";
  return "running";
}
function runtimeDetails(view: WorkerMainView, projectDisplayName?: string): string {
  const project = projectDisplayName
    ? `Project ${safe(projectDisplayName)}${view.projectId ? ` (\`${safe(view.projectId)}\`)` : ""}`
    : `Project ${safe(view.projectId ?? view.parentBindingId ?? "未关联项目")}`;
  return [
    cardSection("🖥️", "运行环境"),
    compactMetadata([project, `Primary ${primaryPaneLabel(view)} (\`${safe(view.parentPaneId)}\`)`, `Worker \`${workerPaneLabel(view)}\``]),
    compactMetadata([`Owner ${safe(view.ownerName)}`, `Session \`${view.workerSessionGeneration}\``, `Runtime \`${view.runtimeGeneration}\``]),
    `Workspace  ${safe(view.workspace)}${view.branch ? `\nBranch  \`${safe(view.branch)}\`` : ""}`
  ].join("\n");
}

function primaryPaneLabel(view: WorkerMainView): string { return safe(view.primaryPaneName ?? view.parentPaneId); }
function workerPaneLabel(view: WorkerMainView): string { return safe(view.paneId ?? "未绑定"); }
function runtimeTemplate(state: WorkerMainView["runtimeState"]): string {
  if (state === "failed") return "red";
  if (state === "blocked" || state === "detached") return "orange";
  if (state === "stopped" || state === "terminated") return "grey";
  return "blue";
}
function safeOutput(value: string): string { return truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(value)), 6_000); }

function safe(value: string): string { return truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(value)), 300); }
function formatDuration(seconds: number): string { const minutes = Math.floor(seconds / 60); const rest = seconds % 60; return minutes > 0 ? `${minutes}m ${rest}s` : `${rest}s`; }
function formatTokenCount(tokens: number | null | undefined): string | null { return tokens === null || tokens === undefined ? null : `↑ ${tokens >= 1_000 ? `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 1 : 2)}K` : tokens} tokens`; }
