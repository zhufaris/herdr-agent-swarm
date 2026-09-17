import type { TopicViewPhase, TopicViewState } from "../domain/topic-view.js";
import { summarizeProgress, type RunCardView, type RunProgressEvent, type RunProgressSummary } from "../domain/run-card-view.js";
import type { ProjectConfig } from "../domain/types.js";
import type { AgentKind } from "../domain/agent-instance.js";
import { normalizeLarkPreview, truncateLarkMarkdown, truncateLarkMarkdownMiddle } from "../runtime/lark-markdown.js";
import { stripNativeTaskFrame } from "../runtime/native-task-frame.js";
import { stripTraexConsoleStatus } from "../runtime/traex-output-parser.js";
import { appendWithinCardLimit } from "./card-payload.js";
import { callbackButton, formSubmitButton } from "./cardkit-button.js";
import { actionRow, cardSection, lifecycleMarker, passiveCardElements, recentItems } from "./card-style.js";
import { renderProgressTimeline } from "./progress-timeline.js";
import { foldFinalAnswerContent, type FinalAnswerElement } from "./final-answer-content.js";

const RUN_STATE_VIEW = {
  queued: { label: "已排队", icon: "⏳", color: "blue" },
  running: { label: "TraeX 正在处理", icon: "🧠", color: "blue" },
  blocked: { label: "等待用户处理", icon: "⚠️", color: "orange" },
  completed: { label: "任务完成", icon: "✅", color: "green" },
  failed: { label: "执行失败", icon: "❌", color: "red" }
} as const;

const STATE_VIEW: Record<TopicViewPhase, { label: string; icon: string; color: string }> = {
  provisioning: { label: "正在创建 Pane", icon: "◌", color: "blue" },
  ready: { label: "已就绪", icon: "✓", color: "green" },
  queued: { label: "已排队", icon: "⏱", color: "blue" },
  running: { label: "TraeX 正在处理", icon: "◌", color: "blue" },
  blocked: { label: "等待用户处理", icon: "⚠", color: "orange" },
  done: { label: "已完成", icon: "✓", color: "green" },
  error: { label: "执行失败", icon: "×", color: "red" },
  degraded: { label: "连接降级", icon: "!", color: "orange" },
  draining: { label: "正在归档", icon: "◌", color: "orange" },
  archived: { label: "已归档", icon: "□", color: "purple" },
  orphaned: { label: "绑定异常", icon: "!", color: "orange" }
};

const MAIN_CARD_PREVIEW_LIMIT = 2_000;
const PROJECT_ENTRY_PREVIEW_LINE_LIMIT = 6;
const PROJECT_ENTRY_PREVIEW_CHARACTER_LIMIT = 3_000;
const ANSWER_CARD_PREVIEW_LIMIT = 9_000;
const HUMAN_INTERRUPTION_NOTICE = "TraeX turn was interrupted by a human operator";
const AGENT_LABEL: Record<AgentKind, string> = { traex: "TraeX", pi: "Pi", codex: "Codex", "claude-code": "Claude Code" };

export function renderProjectSelectorCard(input: { selectionId: string; projects: ProjectConfig[] }, payloadLimit = 12_000): object {
  const elements: object[] = [];
  let visible = 0;
  for (const project of input.projects) {
    const entry = [
      { tag: "markdown", content: `**${escapeMarkdown(project.displayName)}**\n${escapeMarkdown(project.description)}` },
      callbackButton(`打开 ${project.displayName}`, { action: "select_project", selectionId: input.selectionId, projectId: project.id }, "primary")
    ];
    if (!appendWithinCardLimit(elements, entry, 800, payloadLimit)) break;
    elements.push(...entry);
    visible += 1;
  }
  const omitted = input.projects.length - visible;
  if (omitted > 0) elements.push({ tag: "markdown", content: `… 另有 ${omitted} 个项目未在本卡展示，请缩小项目注册表后重试。` });
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "选择 Herdr 项目" } },
    header: { title: { tag: "plain_text", content: "选择项目" }, subtitle: { tag: "plain_text", content: "HERDR PROJECTS" }, template: "blue" },
    body: { elements }
  };
}

export function renderProjectSelectionStatusCard(input: { status: "processing" | "recoverable" | "completed" | "failed" | "expired" | "unauthorized"; projectName?: string; spaceName?: string; paneId?: string; bindingId?: string; message?: string }): object {
  const views = {
    processing: { title: "正在创建项目 Pane", template: "blue", icon: "⏳" },
    recoverable: { title: "项目创建已暂停", template: "orange", icon: "⚠" },
    completed: { title: "项目已打开", template: "green", icon: "✅" },
    failed: { title: "项目创建失败", template: "red", icon: "❌" },
    expired: { title: "项目选择已过期", template: "orange", icon: "⌛" },
    unauthorized: { title: "无法使用此选择器", template: "orange", icon: "🔒" }
  } as const;
  const view = views[input.status];
  const details = [input.projectName ? `**项目**  ${escapeMarkdown(input.projectName)}` : null, input.spaceName ? `**Space**  \`${escapeCode(input.spaceName)}\`` : null, input.paneId ? `**Pane**  \`${escapeCode(input.paneId)}\`` : null, input.message ?? (input.status === "completed" ? "点击“发送话题入口”后，请打开群里随后出现的话题卡片，并在其中发送第一条任务。" : null)].filter(Boolean).join("\n\n");
  const elements: object[] = [{ tag: "markdown", content: details || view.title }];
  if (input.status === "completed" && input.bindingId) elements.push(callbackButton("发送话题入口", { action: "open_project_thread", bindingId: input.bindingId }, "primary"));
  return { schema: "2.0", config: { update_multi: true, summary: { content: view.title } }, header: { title: { tag: "plain_text", content: `${view.icon} ${view.title}` }, template: view.template }, body: { elements } };
}

export function renderAttachStatusCard(input: { spaceName: string; paneId: string; bindingId?: string; alreadyAttached?: boolean; resumeRequired?: boolean }): object {
  const title = input.resumeRequired ? "Pane 已恢复连接" : input.alreadyAttached ? "Pane 已连接" : "Pane 连接成功";
  const message = input.resumeRequired
    ? "已安全恢复原会话连接，未重放任何任务。点击“发送话题入口”进入原话题，再发送 `/swarm resume` 恢复队列。"
    : input.alreadyAttached ? "该 Pane 已经连接，无需重复连接。" : "已连接现有 TraeX Pane。";
  const elements: object[] = [{
    tag: "markdown",
    content: `**Space**  \`${escapeCode(input.spaceName)}\`\n\n**Pane**  \`${escapeCode(input.paneId)}\`\n\n${message}${input.bindingId && !input.resumeRequired ? " 点击“发送话题入口”后，请打开群里随后出现的话题卡片。" : ""}`
  }];
  if (input.bindingId) elements.push(callbackButton("发送话题入口", { action: "open_project_thread", bindingId: input.bindingId }, "primary"));
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: title } },
    header: { title: { tag: "plain_text", content: `✅ ${title}` }, template: "green" },
    body: { elements }
  };
}

export function renderRunCard(input: TopicViewState): object {
  const view = STATE_VIEW[input.phase];
  const elements: object[] = [
    { tag: "markdown", content: verticalMetrics(input) },
    { tag: "hr" }
  ];

  const recentProgress = input.recentProgress ?? [];
  if (recentProgress.length) elements.push(...renderProgressTimeline(recentProgress, input.phase, { summary: effectiveProgressSummary(input.progressSummary, recentProgress) }));
  else if (input.phase === "running") elements.push({ tag: "markdown", content: "**执行进度**\n🧠 正在分析请求" });

  if (input.answer?.trim()) {
    elements.push({ tag: "markdown", content: `**最近输出**\n\n${truncateLarkMarkdownMiddle(input.answer.trim(), MAIN_CARD_PREVIEW_LIMIT)}` });
  } else if (input.phase === "blocked") {
    elements.push(callout("orange", safeRecoveryNotice(input.notice)));
  } else if (input.phase === "error" || input.phase === "degraded" || input.phase === "orphaned") {
    elements.push(callout(input.phase === "error" ? "red" : "orange", input.phase === "degraded" || input.phase === "orphaned" ? safeRecoveryNotice(input.notice) : input.notice ?? "请检查 bridge 日志与 Herdr pane。"));
  } else if (input.phase === "running") {
    elements.push({ tag: "markdown", content: `正在等待 ${agentLabel(input.agentKind)} 完成。本卡片会在状态变化时更新。` });
  } else if (input.phase === "queued") {
    elements.push({ tag: "markdown", content: "消息已进入该话题的 FIFO 队列。" });
  }

  elements.push({ tag: "markdown", content: `${topicStateLine(input)} · ${input.title}` });

  return {
    schema: "2.0",
    config: { update_multi: true, streaming_mode: input.phase === "running", summary: { content: view.label } },
    header: {
      title: { tag: "plain_text", content: agentPaneTitle(input.agentKind, input.spaceName, input.paneId) },
      subtitle: { tag: "plain_text", content: "HERDR REMOTE PANEL" },
      template: view.color
    },
    body: { elements }
  };
}

export function renderProjectEntryCard(input: TopicViewState): object {
  const view = STATE_VIEW[input.phase];
  const actionable = input.phase === "blocked" || input.phase === "error" || input.phase === "degraded" || input.phase === "orphaned" || input.phase === "draining" || input.phase === "archived";
  const progress = input.recentProgress ?? [];
  const visibleAnswer = stripNativeTraexStatus(input.answer ?? "");
  const preview = actionable ? null : latestLines(visibleAnswer, PROJECT_ENTRY_PREVIEW_LINE_LIMIT);
  const elements: object[] = [];
  if (!input.liveStatus) elements.push({ tag: "markdown", content: projectWorkSummary(input) });
  if (input.liveStatus) elements.push(...renderLiveStatus(input.liveStatus, input.phase));
  const planKeys = new Set(input.liveStatus?.planSteps.map((step) => step.key) ?? []);
  if (actionable) elements.push(callout(input.phase === "error" ? "red" : "orange", input.phase === "blocked" || input.phase === "degraded" || input.phase === "orphaned" ? safeRecoveryNotice(input.notice) : input.notice ?? "请回到对应 Herdr pane 检查并完成所需处理。"));
  if (input.primaryToolsAvailable === false && input.primaryToolsNotice) elements.push(callout("orange", input.primaryToolsNotice));
  if (preview) elements.push({ tag: "markdown", content: `${cardSection("💬", "最新消息")}\n\n${truncateLarkMarkdownMiddle(preview, PROJECT_ENTRY_PREVIEW_CHARACTER_LIMIT)}` });
  const createWorker = { tag: "form", name: "primary_worker_create_form", elements: [
    { tag: "input", name: "name", input_type: "text", required: true, placeholder: { tag: "plain_text", content: "Worker name，例如 reviewer" } },
    formSubmitButton("创建并启动 Worker", "primary_worker_create_submit", {
      action: "primary_worker_create_submit",
      bindingId: input.bindingId,
      bindingGeneration: input.bindingGeneration,
      conversationKey: `binding:${input.bindingId}`
    }, "primary")
  ] };
  const canCreateWorker = input.phase === "ready" || input.phase === "queued" || input.phase === "running" || input.phase === "blocked" || input.phase === "done";
  if (input.workers.length > 0) {
    elements.push({ tag: "hr" }, { tag: "markdown", content: `${cardSection("🤖", "Workers")}\n${input.workers.map((worker) => `- ${lifecycleMarker(worker.state)} ${worker.name} · ${worker.state}${worker.currentTaskTitle ? ` · ${worker.currentTaskTitle}` : ""}${worker.queueCount > 0 ? ` · queue ${worker.queueCount}` : ""}`).join("\n")}${input.workerOverflowCount > 0 ? `\n- … 另有 ${input.workerOverflowCount} 个 Worker` : ""}` });
    const workerButtons = [
      ...input.workers.flatMap((worker) => worker.workerMain.messageId ? [callbackButton(`打开 ${worker.name}`, { action: "card_target_open", ...worker.workerMain }, "default")] : [])
    ];
    const row = actionRow(workerButtons);
    if (row) elements.push(row);
    if (canCreateWorker) elements.push(createWorker);
  } else elements.push({ tag: "hr" }, { tag: "markdown", content: `${cardSection("🤖", "Workers")}\n暂无 Worker。` }, ...(canCreateWorker ? [createWorker] : []));
  const recentActivity = recentItems(progress.filter((event) => !planKeys.has(event.key)), 5);
  if (recentActivity.length) elements.push(...renderProgressTimeline(recentActivity, input.phase, { title: "⚙️ 最新活动", summary: summarizeProgress(recentActivity), visibleCount: 5 }));
  elements.push({ tag: "hr" }, { tag: "markdown", content: runtimeFooter(input) });
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: boundedTitle(input.title) } },
    header: {
      title: { tag: "plain_text", content: `🧭 ${agentTitle(input.title)}` },
      subtitle: { tag: "plain_text", content: `HERDR PROJECT · ${lifecycleMarker(input.phase)} ${view.label}` },
      template: view.color
    },
    body: { elements }
  };
}

export function renderPaneThreadEntryCard(input: TopicViewState): object {
  const card = renderProjectEntryCard(input) as { body: { elements: object[] }; header: { subtitle: { content: string } } };
  const passiveElements = passiveCardElements(card.body.elements);
  return { ...card, header: { ...card.header, subtitle: { tag: "plain_text", content: "HERDR PANE ENTRY · 回复此话题继续交互" } }, body: { elements: [...passiveElements, { tag: "hr" }, { tag: "markdown", content: "回复此话题即可向该 Pane 的 Agent 发送新请求；此卡片会同步当前 Pane 状态。" }] } };
}

export function renderRequestRunCard(input: RunCardView): object {
  const state = RUN_STATE_VIEW[input.phase];
  const duration = formatRunDuration(input);
  const elements: object[] = [
    { tag: "markdown", content: truncateLarkMarkdown(input.requestText, 2_000) },
    { tag: "hr" },
    { tag: "markdown", content: conversationalMetadata(input, duration) }
  ];
  if (input.phase === "blocked") elements.push(callout("orange", safeRecoveryNotice(input.notice)));
  if (input.phase === "failed") elements.push(callout("red", input.notice ?? "执行失败，请检查 Herdr pane。"));
  return {
    schema: "2.0", config: { update_multi: true, streaming_mode: input.phase === "running", summary: { content: `${requestSummaryLabel(input.phase)} · ${boundedTitle(input.title)}` } },
    header: { title: { tag: "plain_text", content: "💬 你的请求" }, subtitle: { tag: "plain_text", content: boundedTitle(input.title) }, template: state.color },
    body: { elements }
  };
}

export function renderRequestAnswerCard(input: RunCardView, options: { pageNumber?: number; initialContent?: string; streaming?: boolean } = {}): object {
  const state = RUN_STATE_VIEW[input.phase];
  const pageNumber = options.pageNumber ?? 1;
  const streaming = options.streaming ?? input.phase !== "completed";
  const summary = effectiveProgressSummary(input.progressSummary, input.progressEvents);
  const stepProgress = { done: summary.stepDone, total: summary.stepTotal };
  const content = options.initialContent !== undefined
    ? options.initialContent
    : defaultAnswerContent(input, stepProgress);
  const firstPage = pageNumber === 1;
  const showProgress = firstPage && (input.phase === "queued" || input.phase === "running" || input.phase === "blocked");
  const elements: object[] = [{ tag: "markdown", content: conversationalMetadata(input, formatRunDuration(input), pageNumber) }];
  if (showProgress) elements.push(...renderProgressTimeline(input.progressEvents, input.phase, { summary }));
  if (firstPage && input.phase === "blocked") elements.push(callout("orange", safeRecoveryNotice(input.notice)));
  if (firstPage && input.phase === "failed") elements.push(callout("red", input.notice ?? "执行失败，请检查 Herdr pane。"));
  if (firstPage) elements.push(...workerActivityElements(input));
  if (firstPage && isHumanInterruptedPrimaryAnswer(input)) elements.push(callbackButton("继续这个任务", { action: "primary_continue_form", bindingId: input.bindingId, bindingGeneration: input.bindingGeneration, parentPromptId: input.promptId, sourceAnswerMessageId: input.answerMessageId! }, "primary"));
  elements.push({ tag: "hr" }, { tag: "markdown", element_id: input.answerElementId, content });
  return {
    schema: "2.0", config: {
      update_multi: true, streaming_mode: streaming,
      summary: { content: `${requestSummaryLabel(input.phase)} · ${boundedTitle(input.title)}` }
    },
    header: {
      title: { tag: "plain_text", content: input.phase === "completed" && !streaming ? (pageNumber > 1 ? `✅ ${agentLabel(input.agentKind)} 回复已完成 · 第 ${pageNumber} 页` : `✅ ${agentLabel(input.agentKind)} 回复已完成`) : (pageNumber > 1 ? `✨ ${agentLabel(input.agentKind)} 继续回复 · 第 ${pageNumber} 页` : `✨ ${agentLabel(input.agentKind)} 回复`) },
      subtitle: { tag: "plain_text", content: answerCardSubtitle(input) },
      template: input.phase === "completed" && !streaming ? "green" : state.color
    },
    body: { elements }
  };
}

function isHumanInterruptedPrimaryAnswer(input: RunCardView): boolean {
  return input.phase === "failed" && input.notice === HUMAN_INTERRUPTION_NOTICE && input.answerMessageId !== null;
}

function defaultAnswerContent(input: RunCardView, stepProgress: { done: number; total: number }): string {
  const structuredAnswer = structuredAnswerContent(input);
  const answer = structuredAnswer || input.answer;
  const prose = stripNativeTraexStatus(answer);
  const baseContent = prose
    ? normalizeLarkPreview(prose)
    : input.phase === "running" && stepProgress.total > 0
      ? `${agentLabel(input.agentKind)} 正在执行 · ${stepProgress.done}/${stepProgress.total}`
    : input.phase === "running" ? "⏳ 已接收请求"
      : input.phase === "queued" ? "⏳ 已接收请求"
        : input.phase === "completed" ? "本次未产生可展示的回答。"
          : input.phase === "failed" ? "本次未产生可展示的回答。"
            : "暂无回答。";
  return truncateLarkMarkdownMiddle(baseContent, ANSWER_CARD_PREVIEW_LIMIT);
}

function effectiveProgressSummary(summary: RunProgressSummary, events: readonly RunProgressEvent[]): RunProgressSummary {
  return summary.total === 0 && events.length > 0 ? summarizeProgress(events) : summary;
}

export function renderFinalAnswerCard(input: RunCardView, options: { pageNumber?: number; initialContent: string; answerElementId?: string }, payloadLimit = 12_000): object | null {
  const elements = foldFinalAnswerContent(options.initialContent, payloadLimit);
  if (options.answerElementId) attachElementIdToFirstMarkdown(elements, options.answerElementId);
  const pageNumber = options.pageNumber ?? 1;
  const workerElements = pageNumber === 1 ? workerActivityElements(input) : [];
  return {
    schema: "2.0",
    config: { update_multi: true, streaming_mode: false, summary: { content: `${requestSummaryLabel(input.phase)} · ${boundedTitle(input.title)}` } },
    header: {
      title: { tag: "plain_text", content: input.phase === "completed" ? (pageNumber > 1 ? `✅ ${agentLabel(input.agentKind)} 回复已完成 · 第 ${pageNumber} 页` : `✅ ${agentLabel(input.agentKind)} 回复已完成`) : (pageNumber > 1 ? `✨ ${agentLabel(input.agentKind)} 回复 · 第 ${pageNumber} 页` : `✨ ${agentLabel(input.agentKind)} 回复`) },
      subtitle: { tag: "plain_text", content: answerCardSubtitle(input) },
      template: input.phase === "completed" ? "green" : RUN_STATE_VIEW[input.phase].color
    },
    body: { elements: [
      { tag: "markdown", content: conversationalMetadata(input, formatRunDuration(input), pageNumber) },
      ...workerElements,
      ...elements
    ] }
  };
}

function workerActivityElements(input: RunCardView): object[] {
  const workers = input.workerActivity.slice(0, 3);
  if (workers.length === 0) return [];
  const elements: object[] = [{ tag: "markdown", content: `${cardSection("🤖", "Worker 动态")}\n${workers.map((worker) => `- ${worker.name} · ${worker.latestPhase} · ${worker.latestTaskTitle}${worker.taskCount > 1 ? ` · ${worker.taskCount} 个任务` : ""}`).join("\n")}` }];
  for (const worker of workers) if (worker.latestTaskCard.messageId) elements.push(callbackButton(`打开 ${worker.name} Task`, { action: "card_target_open", ...worker.latestTaskCard }, "default"));
  return elements;
}

function attachElementIdToFirstMarkdown(elements: FinalAnswerElement[], elementId: string): boolean {
  for (const element of elements) {
    if (element.tag === "markdown") {
      element.element_id = elementId;
      return true;
    }
    const nested = element.elements;
    if (Array.isArray(nested) && attachElementIdToFirstMarkdown(nested as FinalAnswerElement[], elementId)) return true;
  }
  return false;
}

function renderLiveStatus(status: NonNullable<TopicViewState["liveStatus"]>, phase: TopicViewPhase): object[] {
  const metadata = [formatElapsed(status.elapsedSeconds), formatTokenCount(status.tokenCount)].filter(Boolean).join(" · " );
  const title = status.statusTitle ? `◈ **${escapeMarkdown(truncate(status.statusTitle, 160))}**` : "◈ **TraeX 正在处理**";
  const lines = status.planSteps.map((step) => `${{ pending: "◻", active: "■", done: "✔", failed: "✕" }[step.state]} ${escapeMarkdown(truncate(step.label, 300))}`);
  const done = lines.filter((line) => line.startsWith("✔")).length;
  const content: object[] = [{ tag: "markdown", content: [title, metadata].filter(Boolean).join("\n") }];
  if (lines.length && lines.length <= 6) content.push({ tag: "markdown", content: lines.join("\n") });
  if (lines.length > 6) content.push({
    tag: "collapsible_panel", expanded: false,
    header: { title: { tag: "plain_text", content: `完整计划 · ${done}/${lines.length}` } },
    elements: [{ tag: "markdown", content: lines.join("\n") }]
  });
  return [{
    tag: "collapsible_panel", expanded: true, border: { color: phase === "done" ? "green" : phase === "error" || phase === "blocked" ? "orange" : "blue", corner_radius: "6px" },
    header: { title: { tag: "plain_text", content: lines.length ? `🎯 当前任务 · ${done}/${lines.length}` : "🎯 当前任务" } },
    elements: content
  }];
}

function formatElapsed(seconds: number | null): string | null {
  if (seconds === null) return null;
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : null, minutes ? `${minutes}m` : null, `${remainder}s`].filter(Boolean).join(" " );
}

function formatTokenCount(tokens: number | null): string | null {
  if (tokens === null) return null;
  return `↑ ${tokens >= 1_000 ? `${(tokens / 1_000).toFixed(tokens >= 10_000 ? 1 : 2)}K` : tokens} tokens`;
}

export function renderHelpCard(): object {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "HerdrSwarm 帮助" } },
    header: { title: { tag: "plain_text", content: "HerdrSwarm" }, template: "blue" },
    body: { elements: [
      { tag: "markdown", content: [
        "**直接开始**",
        "@机器人 描述任务 → 选择项目 → 自动开始。",
        "话题里的普通消息始终按 FIFO 排队；需要调整活动 turn 时使用显式 steer。", "",
        "**紧急操作**",
        "`/swarm stop` 停止当前任务 · `/swarm status` 刷新状态"
      ].join("\n") },
      { tag: "collapsible_panel", expanded: false, header: { title: { tag: "plain_text", content: "高级命令与恢复" } }, elements: [
      { tag: "markdown", content: [
        "`/swarm new [标题] [--agent traex|pi|codex|claude-code]`  选择项目和 Primary Agent（默认 traex）",
        "`/swarm reset [标题]`  使用当前 Agent 类型安全切换到新会话（旧 pane 仅在确认空闲后自动关闭）",
        "`/swarm stop`  中断 exact active turn，不停止 pane、不取消 FIFO",
        "`/swarm steer <文本>`  active 时注入 exact turn，idle 时优先于普通队列执行",
        "`/swarm projects`  打开项目选择卡片",
        "`/swarm spaces`  按 Space 查看全部 Pane",
        "`/swarm panes`  列出当前 Space 的 active Pane，并将所选入口卡片发送到群聊",
        "`/swarm sessions`  查看当前群的会话",
        "`/swarm failures`  查看并处理发送失败",
        "`/swarm attach <space> <pane>`  按 ID 或唯一名称连接已有受支持 Agent pane",
        "`/swarm status`  查看当前绑定",
        "`/swarm model [name]`  查看或切换当前 Pane 的 TraeX 模型",
        "`/swarm worker create <name> [--agent <kind>] [--model <name>] [--start]`  在当前 Primary 下创建 Worker",
        "`/swarm rename <标题>`  重命名当前 pane",
        "`/swarm close`  请求关闭当前 Primary 拓扑（需要 60 秒内二次确认）",
        "`/swarm close confirm <code>`  best-effort 关闭安全 Worker，再关闭 Primary",
        "`/swarm pane close [confirm <code>]`  兼容别名",
        "`/swarm reattach <pane>`  重新连接已验证的原 Pane",
        "`/swarm replace`  创建新的 Pane generation（不会重放任务）",
        "`/swarm resume`  验证后恢复已归档会话",
        "`/swarm awake`  从 detached turn 后补投影遗漏的 Herdr Answer Card（不会重发任务）",
        "`/swarm skip`  人工跳过当前话题最早的 detached Primary 任务并继续 FIFO（此前结果仍不确定）",
        "`/swarm help`  显示本卡片", "",
        "只有 `/swarm …` 会由 HerdrSwarm 处理；其它 slash 命令会原样提交给 TraeX。"
      ].join("\n") }
      ] },
      { tag: "markdown", content: "高风险审批必须在 Herdr 终端完成" }
    ] }
  };
}

export function renderAwakeStatusCard(message: string, recovered = false): object {
  return {
    schema: "2.0", config: { update_multi: true, summary: { content: recovered ? "恢复完成" : "无需恢复" } },
    header: { title: { tag: "plain_text", content: recovered ? "✓ Answer Card 恢复完成" : "ℹ Answer Card 恢复" }, template: recovered ? "green" : "blue" },
    body: { elements: [{ tag: "markdown", content: message }] }
  };
}

export function renderSkipStatusCard(message: string, outcome: "skipped" | "none" | "stale"): object {
  const skipped = outcome === "skipped";
  return {
    schema: "2.0", config: { update_multi: true, summary: { content: skipped ? "Detached prompt 已跳过" : "未跳过 prompt" } },
    header: { title: { tag: "plain_text", content: skipped ? "✓ Detached prompt 已跳过" : "ℹ Detached prompt 未变化" }, template: skipped ? "orange" : "blue" },
    body: { elements: [{ tag: "markdown", content: message }] }
  };
}

export function renderDisconnectedTopicCard(reason: "archived" | "unbound"): object {
  const archived = reason === "archived";
  const title = archived ? "话题已归档" : "话题未连接";
  const message = archived
    ? "这个话题对应的 Herdr 项目已归档，消息没有提交给 TraeX。请打开群里的新项目卡片继续，或发送 `/swarm new` 新建项目。"
    : "这个话题没有连接到 Herdr，消息没有提交给 TraeX。请在已创建的项目卡片话题中继续，或发送 `/swarm new` 新建项目。";
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: title } },
    header: { title: { tag: "plain_text", content: archived ? `□ ${title}` : `⚠ ${title}` }, template: "orange" },
    body: { elements: [{ tag: "markdown", content: message }] }
  };
}

export function renderMessageRejectedCard(message: string): object {
  return {
    schema: "2.0", config: { update_multi: true, summary: { content: "请求未执行" } },
    header: { title: { tag: "plain_text", content: "⚠ 请求未执行" }, template: "orange" },
    body: { elements: [{ tag: "markdown", content: message }] }
  };
}

function verticalMetrics(input: Pick<TopicViewState, "agentKind" | "spaceName" | "tabId" | "paneId" | "worktreeName" | "model" | "context" | "queueDepth">): string {
  const entries: Array<[label: string, value: string]> = [
    ["SPACE", input.spaceName],
    ["TAB", input.tabId ?? "—"],
    ["PANE", input.paneId ?? "provisioning"]
  ];
  const identity = entries.map(([label, value]) => `**${label}**  \`${escapeCode(truncate(value, 28))}\``).join("   " );
  const metrics: Array<[label: string, value: string]> = [
    ["AGENT", agentLabel(input.agentKind)],
    ["MODEL", input.model ?? "—"],
    ["CONTEXT", input.context ?? "—"],
    ["QUEUE", String(input.queueDepth)]
  ];
  const runtime = metrics.map(([label, value]) => `**${label}**  \`${escapeCode(truncate(value, 28))}\``).join("   " );
  return [identity, runtime, `**WORKTREE**  \`${escapeCode(truncate(input.worktreeName ?? "—", 64))}\``].join("\n");
}

function runtimeFooter(input: TopicViewState): string {
  const identity = [input.spaceName, input.tabId, input.paneId].filter(Boolean).map((value) => `\`${escapeCode(value!)}\``).join(" · " );
  const preference = modelPreferenceHint(input);
  const runtime = [`agent \`${escapeCode(agentLabel(input.agentKind))}\``, input.model ? `\`${escapeCode(input.model)}\`` : null, preference, input.context ? `context \`${escapeCode(input.context)}\`` : null, `queue \`${input.queueDepth}\``].filter(Boolean).join(" · " );
  const updated = relativeTime(input.activityAt);
  const worktree = input.worktreeName ? `worktree \`${escapeCode(input.worktreeName)}\`` : null;
  return [cardSection("🖥️", "Runtime"), identity, runtime, [worktree, updated ? `${updated}更新` : null].filter(Boolean).join(" · " )].filter(Boolean).join("\n");
}

function modelPreferenceHint(input: TopicViewState): string | null {
  if (!input.modelPreference) return null;
  const prefix = { pending: "next", applying: "applying", uncertain: "uncertain", effective: "applied" }[input.modelPreference.state];
  return `${prefix} ${escapeCode(input.modelPreference.model)}`;
}

function callout(color: string, content: string): object {
  return { tag: "collapsible_panel", expanded: true, border: { color, corner_radius: "6px" },
    header: { title: { tag: "plain_text", content: "需要处理" } },
    elements: [{ tag: "markdown", content }] };
}

function escapeCode(value: string): string { return value.replaceAll("`", "'"); }
function escapeMarkdown(value: string): string { return value.replace(/[\\`*_{}[\]()#+.!|>-]/g, "\\$&"); }
function truncate(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function agentPaneTitle(agentKind: AgentKind, spaceName: string, paneId: string | null): string {
  return truncate(`${agentLabel(agentKind)} · ${spaceName} / ${paneId ?? "provisioning"}`, 96);
}
function agentLabel(kind: AgentKind | undefined): string { return AGENT_LABEL[kind ?? "traex"]; }
function agentTitle(title: string): string {
  return boundedTitle(title);
}
function boundedTitle(title: string): string { return truncate(title.replace(/\s+/g, " " ).trim() || "未命名任务", 64); }
function answerCardSubtitle(input: RunCardView): string {
  const sessionTitle = input.sessionTitle?.trim() || [input.spaceName, input.paneId].filter(Boolean).join(" / " ) || "unknown";
  return boundedTitle(`${sessionTitle} · ${input.title}`);
}
function requestSummaryLabel(phase: RunCardView["phase"]): string {
  return { queued: "排队中", running: "执行中", blocked: "等待处理", completed: "完成", failed: "失败" }[phase];
}
function conversationalMetadata(input: RunCardView, duration: string | null, pageNumber?: number): string {
  const state = RUN_STATE_VIEW[input.phase];
  if (input.phase === "queued" && input.queueFeedback) {
    const feedback = input.queueFeedback;
    const lines = [`⏳ 已排队 · 前方 ${feedback.aheadCount} 条`];
    if (feedback.activeElapsedSeconds !== null) lines.push(`当前任务已运行 ${feedback.activeElapsedSeconds} 秒`);
    if (feedback.estimateLowerSeconds !== null && feedback.estimateUpperSeconds !== null) lines.push(`预计等待约 ${Math.floor(feedback.estimateLowerSeconds / 60)}–${Math.ceil(feedback.estimateUpperSeconds / 60)} 分钟`);
    return lines.join("\n");
  }
  const details = input.phase === "queued"
    ? `队列第 ${input.queuePosition} 位`
    : duration ? `用时 ${duration}` : null;
  const outputState = outputStateLabel(input.phase);
  const updated = relativeTime(input.updatedAt);
  return [outputState, `${state.icon} ${state.label}`, `Pane \`${escapeCode(input.paneId ?? "provisioning")}\``, details, pageNumber && pageNumber > 1 ? `第 ${pageNumber} 页` : null, updated ? `最后更新 ${updated}` : null].filter(Boolean).join("  ·  " );
}
function outputStateLabel(phase: RunCardView["phase"]): string | null {
  return phase === "running" ? "实时更新中" : phase === "completed" ? "最终结果" : null;
}
function topicStateLine(input: TopicViewState): string {
  const view = STATE_VIEW[input.phase];
  const updated = relativeTime(input.activityAt);
  return [`${view.icon} ${view.label}`, updated ? `最后更新 ${updated}` : null].filter(Boolean).join("  ·  " );
}
function relativeTime(value: string | null | undefined): string | null {
  if (!value) return null;
  const timestamp = Date.parse(value);
  if (!Number.isFinite(timestamp)) return null;
  const seconds = Math.max(0, Math.floor((Date.now() - timestamp) / 1_000));
  if (seconds < 60) return "刚刚";
  if (seconds < 3_600) return `${Math.floor(seconds / 60)} 分钟前`;
  if (seconds < 86_400) return `${Math.floor(seconds / 3_600)} 小时前`;
  if (seconds < 604_800) return `${Math.floor(seconds / 86_400)} 天前`;
  return new Date(timestamp).toISOString().slice(0, 10);
}
function safeRecoveryNotice(diagnostic: string | null | undefined): string {
  const guidance = "桥已保留当前任务并停止自动派发。请前往对应 Herdr Pane 完成审批或检查 TraeX；处理后桥会自动重新同步。";
  return diagnostic?.trim() ? `${diagnostic.trim()}\n\n${guidance}` : guidance;
}
function formatRunDuration(input: RunCardView): string | null {
  if (!input.startedAt || !input.finishedAt) return null;
  const elapsed = Date.parse(input.finishedAt) - Date.parse(input.startedAt);
  if (!Number.isFinite(elapsed) || elapsed < 0) return null;
  const seconds = Math.floor(elapsed / 1_000);
  const hours = Math.floor(seconds / 3_600);
  const minutes = Math.floor((seconds % 3_600) / 60);
  const remainder = seconds % 60;
  return [hours ? `${hours}h` : null, minutes ? `${minutes}m` : null, `${remainder}s`].filter(Boolean).join(" " );
}
function stripNativeTraexStatus(source: string): string {
  return stripTraexConsoleStatus(stripNativeTaskFrame(source));
}
function structuredAnswerContent(input: RunCardView): string {
  if (!Array.isArray(input.answerSegments) || typeof input.answerDraft !== "string") return "";
  const parts: string[] = [];
  for (const part of input.answerSegments) if (part.trim()) parts.push(part);
  if (input.answerDraft.trim()) parts.push(input.answerDraft);
  return parts.join("\n\n");
}
function latestLines(source: string, limit: number): string | null {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  while (lines.length && !lines.at(-1)?.trim()) lines.pop();
  const tail = lines.slice(-limit).join("\n").trim();
  return tail || null;
}
function projectWorkSummary(input: TopicViewState): string {
  if (input.phase === "running") return `${cardSection("🎯", "当前任务")}\n${agentLabel(input.agentKind)} 正在处理当前请求${input.queueDepth > 0 ? `；后续还有 ${input.queueDepth} 条请求等待。` : "。"}`;
  if (input.phase === "queued") return `${cardSection("🎯", "当前任务")}\n当前请求正在 FIFO 队列中等待${input.queueDepth > 0 ? `（队列共 ${input.queueDepth} 条）。` : "。"}`;
  if (input.phase === "done") return `${cardSection("🎯", "当前任务")}\n当前 Pane 没有正在执行的请求${input.queueDepth > 0 ? `；下一条请求正在等待调度（${input.queueDepth} 条）。` : "。"}`;
  return `${cardSection("🎯", "当前任务")}\n${STATE_VIEW[input.phase].label}`;
}
function progressLine(event: RunCardView["progressEvents"][number]): string {
  const label = progressLabel(event.label);
  if (event.kind === "step") return `${event.state === "pending" ? "☐" : event.state === "active" ? "◌" : event.state === "done" ? "✓" : "✕"} ${label}`;
  if (event.state === "failed") return `❌ ${label}`;
  if (event.kind === "test" && event.state === "done") return `✅ ${label}`;
  const icon = { analyze: "🧠", search: "🔍", read: "📖", edit: "✏️", test: "🧪" }[event.kind];
  return `${icon} ${label}`;
}
function progressLabel(label: string): string {
  const normalized = label.replace(/\s+/g, " " ).trim();
  return normalized.length > 200 ? `${normalized.slice(0, 199).trimEnd()}…` : normalized;
}
