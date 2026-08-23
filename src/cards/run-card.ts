import type { TopicViewPhase, TopicViewState } from "../domain/topic-view.js";
import type { RunCardView } from "../domain/run-card-view.js";
import type { ProjectConfig } from "../domain/types.js";
import { normalizeLarkPreview, truncateLarkMarkdown, truncateLarkMarkdownTail } from "../runtime/lark-markdown.js";
import { normalizeLarkElementId } from "../runtime/lark-card-id.js";
import { stripNativeTaskFrame } from "../runtime/native-task-frame.js";

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
  draining: { label: "正在归档", icon: "◌", color: "orange" },
  archived: { label: "已归档", icon: "□", color: "grey" },
  orphaned: { label: "绑定异常", icon: "!", color: "orange" }
};

export function renderProjectSelectorCard(input: { selectionId: string; projects: ProjectConfig[] }): object {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "选择 Herdr 项目" } },
    header: { title: { tag: "plain_text", content: "选择项目" }, subtitle: { tag: "plain_text", content: "HERDR PROJECTS" }, template: "blue" },
    body: { elements: input.projects.flatMap((project) => [
      { tag: "markdown", content: `**${escapeMarkdown(project.displayName)}**\n${escapeMarkdown(project.description)}` },
      { tag: "button", text: { tag: "plain_text", content: `打开 ${project.displayName}` }, type: "primary",
        value: { action: "select_project", selectionId: input.selectionId, projectId: project.id } }
    ]) }
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
  if (input.status === "completed" && input.bindingId) elements.push({ tag: "button", text: { tag: "plain_text", content: "发送话题入口" }, type: "primary", value: { action: "open_project_thread", bindingId: input.bindingId } });
  return { schema: "2.0", config: { update_multi: true, summary: { content: view.title } }, header: { title: { tag: "plain_text", content: `${view.icon} ${view.title}` }, template: view.template }, body: { elements } };
}

export function renderAttachStatusCard(input: { spaceName: string; paneId: string; bindingId?: string; alreadyAttached?: boolean }): object {
  const title = input.alreadyAttached ? "Pane 已连接" : "Pane 连接成功";
  const elements: object[] = [{
    tag: "markdown",
    content: `**Space**  \`${escapeCode(input.spaceName)}\`\n\n**Pane**  \`${escapeCode(input.paneId)}\`\n\n${input.alreadyAttached ? "该 Pane 已经连接，无需重复连接。" : "已连接现有 TraeX Pane。"}${input.bindingId ? " 点击“发送话题入口”后，请打开群里随后出现的话题卡片。" : ""}`
  }];
  if (input.bindingId) elements.push({ tag: "button", text: { tag: "plain_text", content: "发送话题入口" }, type: "primary", value: { action: "open_project_thread", bindingId: input.bindingId } });
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
    {
      tag: "column_set",
      horizontal_spacing: "8px",
      columns: [
        metric("SPACE", input.spaceName),
        metric("PANE", input.paneId ?? "provisioning"),
        metric("QUEUE", String(input.queueDepth))
      ]
    },
    { tag: "hr" }
  ];

  const recentProgress = input.recentProgress ?? [];
  if (recentProgress.length) elements.push({ tag: "markdown", content: `**执行进度**\n${recentProgress.slice(-8).map(progressLine).join("\n")}` });
  else if (input.phase === "running") elements.push({ tag: "markdown", content: "**执行进度**\n🧠 正在分析请求" });

  if (input.answer?.trim()) {
    elements.push({ tag: "markdown", content: `**最近输出**\n\n${truncateLarkMarkdownTail(input.answer.trim(), 2_000)}` });
  } else if (input.phase === "blocked") {
    elements.push(callout("orange", input.notice ?? "TraeX 正在等待用户处理。请查看对应 Herdr panel 并完成所需交互。"));
  } else if (input.phase === "error" || input.phase === "orphaned") {
    elements.push(callout(input.phase === "error" ? "red" : "orange", input.notice ?? "请检查 bridge 日志与 Herdr pane。"));
  } else if (input.phase === "running") {
    elements.push({ tag: "markdown", content: "正在等待 TraeX 完成。本卡片会在状态变化时更新。" });
  } else if (input.phase === "queued") {
    elements.push({ tag: "markdown", content: "消息已进入该话题的 FIFO 队列。" });
  }

  elements.push({ tag: "markdown", content: `${view.icon} ${view.label} · ${input.title}` });

  return {
    schema: "2.0",
    config: { update_multi: true, streaming_mode: input.phase === "running", summary: { content: view.label } },
    header: {
      title: { tag: "plain_text", content: agentPaneTitle(input.spaceName, input.paneId) },
      subtitle: { tag: "plain_text", content: "HERDR REMOTE PANEL" },
      template: view.color
    },
    body: { elements }
  };
}

export function renderProjectEntryCard(input: TopicViewState): object {
  const view = STATE_VIEW[input.phase];
  const actionable = input.phase === "blocked" || input.phase === "error" || input.phase === "orphaned";
  const recentProgress = (input.recentProgress ?? []).slice(-3);
  const visibleAnswer = stripNativeTraexStatus(input.answer ?? "");
  const preview = actionable
    ? input.notice
    : latestParagraph(visibleAnswer) ?? (recentProgress.at(-1) ? projectProgressLine(recentProgress.at(-1)!) : null);
  const elements: object[] = [
    {
      tag: "column_set",
      horizontal_spacing: "8px",
      columns: [
        metric("SPACE", input.spaceName),
        metric("PANE", input.paneId ?? "provisioning"),
        metric("QUEUE", String(input.queueDepth))
      ]
    },
    { tag: "hr" },
    { tag: "markdown", content: `**项目任务**  ${escapeMarkdown(input.title)}` }
  ];
  if (recentProgress.length) {
    elements.push({ tag: "markdown", content: `**最近动态**\n${recentProgress.map(projectProgressLine).join("\n")}` });
  }
  if (preview) elements.push({ tag: "markdown", content: `**最新消息**\n\n${truncateLarkMarkdownTail(normalizeLarkPreview(preview), 2_500)}` });
  elements.push({ tag: "markdown", content: `${view.icon} ${view.label}` });
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: view.label } },
    header: {
      title: { tag: "plain_text", content: agentPaneTitle(input.spaceName, input.paneId) },
      subtitle: { tag: "plain_text", content: "HERDR PROJECT" },
      template: view.color
    },
    body: { elements }
  };
}

export function renderRequestRunCard(input: RunCardView): object {
  const state = RUN_STATE_VIEW[input.phase];
  const duration = formatRunDuration(input);
  const elements: object[] = [
    { tag: "markdown", content: truncateLarkMarkdown(input.requestText, 2_000) },
    { tag: "hr" },
    { tag: "markdown", content: conversationalMetadata(input, duration) }
  ];
  if (input.phase === "blocked") elements.push(callout("orange", input.notice ?? "TraeX 正在等待用户处理。请查看对应 Herdr panel 并完成所需交互。"));
  if (input.phase === "failed") elements.push(callout("red", input.notice ?? "执行失败，请检查 Herdr pane。"));
  return {
    schema: "2.0", config: { update_multi: true, streaming_mode: input.phase === "running", summary: { content: `${requestSummaryLabel(input.phase)} · ${boundedTitle(input.title)}` } },
    header: { title: { tag: "plain_text", content: "💬 你的请求" }, subtitle: { tag: "plain_text", content: boundedTitle(input.title) }, template: state.color },
    body: { elements }
  };
}

export function renderRequestAnswerCard(input: RunCardView, options: { pageNumber?: number; initialContent?: string } = {}): object {
  const state = RUN_STATE_VIEW[input.phase];
  const pageNumber = options.pageNumber ?? 1;
  const structuredAnswer = Array.isArray(input.answerSegments) && typeof input.answerDraft === "string"
    ? [...input.answerSegments, input.answerDraft].filter((part) => part.trim()).join("\n\n")
    : "";
  const answer = structuredAnswer || input.answer;
  const prose = stripNativeTraexStatus(answer);
  const baseContent = prose
    ? truncateLarkMarkdownTail(normalizeLarkPreview(prose), 12_000)
    : input.phase === "running" && input.progressEvents.some((event) => event.kind === "step")
      ? `TraeX 正在执行 · ${input.progressEvents.filter((event) => event.kind === "step" && event.state === "done").length}/${input.progressEvents.filter((event) => event.kind === "step").length}`
    : input.phase === "running" ? "⏳ 已接收请求"
      : input.phase === "queued" ? "⏳ 已接收请求"
        : input.phase === "failed" ? "本次执行未产生回答。"
          : "暂无回答。";
  const content = options.initialContent ?? (input.phase === "blocked" ? `${baseContent}\n\n⚠️ ${input.notice ?? "等待用户处理"}`
    : input.phase === "failed" ? `${baseContent}\n\n❌ ${input.notice ?? "执行失败"}` : baseContent);
  return {
    schema: "2.0", config: { update_multi: true, streaming_mode: true, summary: { content: `${requestSummaryLabel(input.phase)} · ${boundedTitle(input.title)}` } },
    header: {
      title: { tag: "plain_text", content: pageNumber > 1 ? `✨ TraeX 继续回复 · ${pageNumber}` : "✨ TraeX 回复" },
      subtitle: { tag: "plain_text", content: boundedTitle(input.title) },
      template: state.color
    },
    body: { elements: [
      { tag: "markdown", content: conversationalMetadata(input, formatRunDuration(input)) },
      { tag: "hr" },
      { tag: "markdown", element_id: input.answerElementId || answerElementId(input.promptId), content }
    ] }
  };
}

export function answerElementId(promptId: string): string {
  return normalizeLarkElementId(`answer-content-${promptId}`);
}

export function renderHelpCard(): object {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "Herdr Bridge 帮助" } },
    header: { title: { tag: "plain_text", content: "Herdr Bridge" }, template: "blue" },
    body: { elements: [
      { tag: "markdown", content: [
        "**从飞书控制 Herdr 中的 TraeX pane**", "",
        "`/herdr new [标题]`  选择项目并创建 TraeX pane",
        "`/herdr projects`  打开项目选择卡片",
        "`/herdr spaces`  按 Space 查看全部 Pane",
        "`/herdr sessions`  查看当前群的会话",
        "`/herdr failures`  查看并处理发送失败",
        "`/herdr attach <space> <pane>`  按 ID 或唯一名称连接已有 TraeX pane",
        "`/herdr status`  查看当前绑定",
        "`/model [name]`  查看或切换当前 Pane 的 TraeX 模型",
        "`/herdr model [name]`  `/model` 的等价别名",
        "`/herdr rename <标题>`  重命名当前 pane",
        "`/herdr close`  归档映射（不会强杀 TraeX）",
        "`/herdr pane close`  请求关闭空闲 Pane（需要 60 秒内二次确认）",
        "`/herdr pane close confirm <code>`  确认关闭当前话题绑定的 Pane",
        "`/herdr reattach <pane>`  重新连接已验证的原 Pane",
        "`/herdr replace`  创建新的 Pane generation（不会重放任务）",
        "`/herdr resume`  验证后恢复已归档会话",
        "`/herdr help`  显示本卡片", "",
        "在已绑定话题中发送普通文本，即会按顺序提交给 TraeX。"
      ].join("\n") },
      { tag: "markdown", content: "高风险审批必须在 Herdr 终端完成" }
    ] }
  };
}

export function renderDisconnectedTopicCard(reason: "archived" | "unbound"): object {
  const archived = reason === "archived";
  const title = archived ? "话题已归档" : "话题未连接";
  const message = archived
    ? "这个话题对应的 Herdr 项目已归档，消息没有提交给 TraeX。请打开群里的新项目卡片继续，或发送 `/herdr new` 新建项目。"
    : "这个话题没有连接到 Herdr，消息没有提交给 TraeX。请在已创建的项目卡片话题中继续，或发送 `/herdr new` 新建项目。";
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

function metric(label: string, value: string): object {
  return { tag: "column", width: "weighted", weight: 1, elements: [
    { tag: "markdown", content: `**${label}**\n\`${escapeCode(truncate(value, 28))}\`` }
  ] };
}

function callout(color: string, content: string): object {
  return { tag: "collapsible_panel", expanded: true, border: { color, corner_radius: "6px" },
    header: { title: { tag: "plain_text", content: "需要处理" } },
    elements: [{ tag: "markdown", content }] };
}

function escapeCode(value: string): string { return value.replaceAll("`", "'"); }
function escapeMarkdown(value: string): string { return value.replace(/[\\`*_{}[\]()#+.!|>-]/g, "\\$&"); }
function truncate(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
function agentPaneTitle(spaceName: string, paneId: string | null): string {
  return truncate(`TraeX · ${spaceName} / ${paneId ?? "provisioning"}`, 96);
}
function boundedTitle(title: string): string { return truncate(title.replace(/\s+/g, " " ).trim() || "未命名任务", 64); }
function requestStatusLabel(phase: RunCardView["phase"]): string {
  return { queued: "已排队", running: "运行中", blocked: "等待处理", completed: "已完成", failed: "失败" }[phase];
}
function requestSummaryLabel(phase: RunCardView["phase"]): string {
  return { queued: "排队中", running: "执行中", blocked: "等待处理", completed: "完成", failed: "失败" }[phase];
}
function conversationalMetadata(input: RunCardView, duration: string | null): string {
  const state = RUN_STATE_VIEW[input.phase];
  const details = input.phase === "queued"
    ? `队列第 ${input.queuePosition} 位`
    : duration ? `用时 ${duration}` : null;
  return [`${state.icon} ${state.label}`, `Pane \`${escapeCode(input.paneId ?? "provisioning")}\``, details].filter(Boolean).join("  ·  " );
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
  return stripNativeTaskFrame(source);
}
function latestParagraph(source: string): string | null {
  const paragraphs = source.split(/\n\s*\n/).map((value) => value.trim()).filter(Boolean);
  return paragraphs.at(-1) ?? null;
}
function projectProgressLine(event: RunCardView["progressEvents"][number]): string {
  return event.kind === "step" ? progressLine(event) : `🛠️ ${event.label}`;
}
function progressLine(event: RunCardView["progressEvents"][number]): string {
  if (event.kind === "step") return `${event.state === "pending" ? "☐" : event.state === "active" ? "◌" : event.state === "done" ? "✓" : "✕"} ${event.label}`;
  if (event.state === "failed") return `❌ ${event.label}`;
  if (event.kind === "test" && event.state === "done") return `✅ ${event.label}`;
  const icon = { analyze: "🧠", search: "🔍", read: "📖", edit: "✏️", test: "🧪" }[event.kind];
  return `${icon} ${event.label}`;
}
