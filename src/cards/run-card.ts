import type { TopicViewPhase, TopicViewState } from "../domain/topic-view.js";
import type { RunCardView, RunProgressEvent } from "../domain/run-card-view.js";
import type { ProjectConfig } from "../domain/types.js";
import { normalizeLarkPreview, truncateLarkMarkdown, truncateLarkMarkdownMiddle, truncateLarkMarkdownTail } from "../runtime/lark-markdown.js";
import { stripNativeTaskFrame } from "../runtime/native-task-frame.js";
import { stripTraexConsoleStatus } from "../runtime/traex-output-parser.js";
import { renderProgressTimeline } from "./progress-timeline.js";

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

const MAIN_CARD_PREVIEW_LIMIT = 2_000;
const ANSWER_CARD_PREVIEW_LIMIT = 9_000;
const CODE_FOLD_LINE_LIMIT = 80;
const CODE_FOLD_CHARACTER_LIMIT = 6_000;

interface TopicCardRenderOptions {
  lastActivityAt?: string | null;
}

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

export function renderAttachStatusCard(input: { spaceName: string; paneId: string; bindingId?: string; alreadyAttached?: boolean; resumeRequired?: boolean }): object {
  const title = input.resumeRequired ? "Pane 已恢复连接" : input.alreadyAttached ? "Pane 已连接" : "Pane 连接成功";
  const message = input.resumeRequired
    ? "已安全恢复原会话连接，未重放任何任务。点击“发送话题入口”进入原话题，再发送 `/swarm resume` 恢复队列。"
    : input.alreadyAttached ? "该 Pane 已经连接，无需重复连接。" : "已连接现有 TraeX Pane。";
  const elements: object[] = [{
    tag: "markdown",
    content: `**Space**  \`${escapeCode(input.spaceName)}\`\n\n**Pane**  \`${escapeCode(input.paneId)}\`\n\n${message}${input.bindingId && !input.resumeRequired ? " 点击“发送话题入口”后，请打开群里随后出现的话题卡片。" : ""}`
  }];
  if (input.bindingId) elements.push({ tag: "button", text: { tag: "plain_text", content: "发送话题入口" }, type: "primary", value: { action: "open_project_thread", bindingId: input.bindingId } });
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: title } },
    header: { title: { tag: "plain_text", content: `✅ ${title}` }, template: "green" },
    body: { elements }
  };
}

export function renderRunCard(input: TopicViewState, options: TopicCardRenderOptions = {}): object {
  const view = STATE_VIEW[input.phase];
  const elements: object[] = [
    { tag: "markdown", content: verticalMetrics(input) },
    { tag: "hr" }
  ];

  const recentProgress = input.recentProgress ?? [];
  if (recentProgress.length) elements.push(...renderProgressTimeline(recentProgress, input.phase));
  else if (input.phase === "running") elements.push({ tag: "markdown", content: "**执行进度**\n🧠 正在分析请求" });

  if (input.answer?.trim()) {
    elements.push({ tag: "markdown", content: `**最近输出**\n\n${truncateLarkMarkdownMiddle(input.answer.trim(), MAIN_CARD_PREVIEW_LIMIT)}` });
  } else if (input.phase === "blocked") {
    elements.push(callout("orange", safeRecoveryNotice(input.notice)));
  } else if (input.phase === "error" || input.phase === "orphaned") {
    elements.push(callout(input.phase === "error" ? "red" : "orange", input.phase === "orphaned" ? safeRecoveryNotice(input.notice) : input.notice ?? "请检查 bridge 日志与 Herdr pane。"));
  } else if (input.phase === "running") {
    elements.push({ tag: "markdown", content: "正在等待 TraeX 完成。本卡片会在状态变化时更新。" });
  } else if (input.phase === "queued") {
    elements.push({ tag: "markdown", content: "消息已进入该话题的 FIFO 队列。" });
  }

  elements.push({ tag: "markdown", content: `${topicStateLine(input, options)} · ${input.title}` });

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

export function renderProjectEntryCard(input: TopicViewState, options: TopicCardRenderOptions = {}): object {
  const view = STATE_VIEW[input.phase];
  const actionable = input.phase === "blocked" || input.phase === "error" || input.phase === "orphaned" || input.phase === "draining" || input.phase === "archived";
  const progress = input.recentProgress ?? [];
  const visibleAnswer = stripNativeTraexStatus(input.answer ?? "");
  const preview = actionable
    ? null
    : visibleAnswer.length > MAIN_CARD_PREVIEW_LIMIT
      ? visibleAnswer
      : latestLines(visibleAnswer, 20) ?? (progress.at(-1) ? projectProgressLine(progress.at(-1)!) : null);
  const elements: object[] = [
    { tag: "markdown", content: verticalMetrics(input) },
    { tag: "hr" }
  ];
  elements.push({ tag: "markdown", content: projectWorkSummary(input) });
  if (progress.length) elements.push(...renderProgressTimeline(progress, input.phase));
  if (actionable) elements.push(callout(input.phase === "error" ? "red" : "orange", input.phase === "blocked" || input.phase === "orphaned" ? safeRecoveryNotice(input.notice) : input.notice ?? "请回到对应 Herdr pane 检查并完成所需处理。"));
  if (preview) elements.push({ tag: "markdown", content: `**最新消息**\n\n${truncateLarkMarkdownMiddle(preview, MAIN_CARD_PREVIEW_LIMIT)}` });
  elements.push({ tag: "markdown", content: topicStateLine(input, options) });
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: boundedTitle(input.title) } },
    header: {
      title: { tag: "plain_text", content: agentTitle(input.title) },
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
  const structuredAnswer = structuredAnswerContent(input);
  const answer = structuredAnswer || input.answer;
  const prose = stripNativeTraexStatus(answer);
  const stepProgress = progressSummary(input.progressEvents);
  const baseContent = prose
    ? normalizeLarkPreview(prose)
    : input.phase === "running" && stepProgress.total > 0
      ? `TraeX 正在执行 · ${stepProgress.done}/${stepProgress.total}`
    : input.phase === "running" ? "⏳ 已接收请求"
      : input.phase === "queued" ? "⏳ 已接收请求"
        : input.phase === "completed" ? "本次未产生可展示的回答。"
          : input.phase === "failed" ? "本次未产生可展示的回答。"
            : "暂无回答。";
  const content = options.initialContent ?? truncateLarkMarkdownMiddle(baseContent, ANSWER_CARD_PREVIEW_LIMIT);
  const elements: object[] = [
    { tag: "markdown", content: conversationalMetadata(input, formatRunDuration(input), pageNumber) },
    ...renderProgressTimeline(input.progressEvents, input.phase)
  ];
  if (input.phase === "blocked") elements.push(callout("orange", safeRecoveryNotice(input.notice)));
  if (input.phase === "failed") elements.push(callout("red", input.notice ?? "执行失败，请检查 Herdr pane。"));
  elements.push({ tag: "hr" }, { tag: "markdown", element_id: input.answerElementId, content });
  return {
    schema: "2.0", config: {
      update_multi: true, streaming_mode: streaming,
      ...(streaming ? { streaming_config: { print_frequency_ms: { default: 40 }, print_step: { default: 50 }, print_strategy: "fast" } } : {}),
      summary: { content: `${requestSummaryLabel(input.phase)} · ${boundedTitle(input.title)}` }
    },
    header: {
      title: { tag: "plain_text", content: input.phase === "completed" && !streaming ? (pageNumber > 1 ? `✅ TraeX 回复已完成 · 第 ${pageNumber} 页` : "✅ TraeX 回复已完成") : (pageNumber > 1 ? `✨ TraeX 继续回复 · 第 ${pageNumber} 页` : "✨ TraeX 回复") },
      subtitle: { tag: "plain_text", content: boundedTitle(input.title) },
      template: input.phase === "completed" && !streaming ? "green" : state.color
    },
    body: { elements }
  };
}

export function renderFinalAnswerCard(input: RunCardView, options: { pageNumber?: number; initialContent: string }): object | null {
  const elements = foldFinalAnswerContent(options.initialContent);
  if (!elements.some((element) => element.tag === "collapsible_panel")) return null;
  const pageNumber = options.pageNumber ?? 1;
  return {
    schema: "2.0",
    config: { update_multi: true, streaming_mode: false, summary: { content: `${requestSummaryLabel(input.phase)} · ${boundedTitle(input.title)}` } },
    header: {
      title: { tag: "plain_text", content: pageNumber > 1 ? `✅ TraeX 回复已完成 · 第 ${pageNumber} 页` : "✅ TraeX 回复已完成" },
      subtitle: { tag: "plain_text", content: boundedTitle(input.title) },
      template: "green"
    },
    body: { elements: [
      { tag: "markdown", content: conversationalMetadata(input, formatRunDuration(input), pageNumber) },
      ...elements
    ] }
  };
}

function progressSummary(events: readonly RunProgressEvent[]): { done: number; total: number } {
  let done = 0;
  let total = 0;
  for (const event of events) {
    if (event.kind !== "step") continue;
    total += 1;
    if (event.state === "done") done += 1;
  }
  return { done, total };
}

type FinalAnswerElement = { tag: string; [key: string]: unknown };

function foldFinalAnswerContent(content: string): FinalAnswerElement[] {
  const blocks = splitFinalAnswerBlocks(content);
  return blocks.map((block) => {
    if (block.kind === "markdown") return { tag: "markdown", content: block.content };
    const lineCount = block.code.length === 0 ? 0 : block.code.split("\n").length;
    if (lineCount <= CODE_FOLD_LINE_LIMIT && block.code.length <= CODE_FOLD_CHARACTER_LIMIT) return { tag: "markdown", content: block.source };
    return {
      tag: "collapsible_panel",
      expanded: false,
      border: { color: "grey", corner_radius: "6px" },
      header: { title: { tag: "plain_text", content: foldedCodeTitle(block.language, lineCount, block.code.length) } },
      elements: [{ tag: "markdown", content: block.source }]
    };
  });
}

function splitFinalAnswerBlocks(content: string): Array<{ kind: "markdown"; content: string } | { kind: "code"; source: string; language: string; code: string }> {
  const lines = content.split("\n");
  const result: Array<{ kind: "markdown"; content: string } | { kind: "code"; source: string; language: string; code: string }> = [];
  let markdown: string[] = [];
  for (let index = 0; index < lines.length;) {
    const opening = /^```([^`]*)$/.exec(lines[index]!);
    if (!opening) { markdown.push(lines[index]!); index += 1; continue; }
    const closingIndex = lines.findIndex((line, candidate) => candidate > index && line === "```");
    if (closingIndex < 0) { markdown.push(...lines.slice(index)); break; }
    if (markdown.length) { result.push({ kind: "markdown", content: markdown.join("\n").trim() }); markdown = []; }
    const language = opening[1]!.trim();
    const code = lines.slice(index + 1, closingIndex).join("\n");
    result.push({ kind: "code", source: lines.slice(index, closingIndex + 1).join("\n"), language, code });
    index = closingIndex + 1;
  }
  if (markdown.length) result.push({ kind: "markdown", content: markdown.join("\n").trim() });
  return result.filter((block) => block.kind === "code" || block.content.length > 0);
}

function foldedCodeTitle(language: string, lineCount: number, characterCount: number): string {
  return `${fencedBlockLabel(language)} · ${lineCount} 行 · ${characterCount} 字符`;
}

function fencedBlockLabel(language: string): string {
  const normalized = language.toLowerCase();
  if (["bash", "sh", "shell", "zsh"].includes(normalized)) return "命令";
  if (normalized === "text") return "执行输出";
  if (["diff", "patch"].includes(normalized)) return "变更 Diff";
  if (["json", "yaml", "yml", "toml", "ini", "conf"].includes(normalized)) return "配置 / JSON";
  const languages: Record<string, string> = {
    c: "C", cpp: "C++", csharp: "C#", cs: "C#", css: "CSS", dart: "Dart", go: "Go",
    html: "HTML", java: "Java", javascript: "JavaScript", js: "JavaScript", jsx: "JSX", kotlin: "Kotlin",
    lua: "Lua", php: "PHP", py: "Python", python: "Python", r: "R", ruby: "Ruby", rust: "Rust",
    scala: "Scala", sql: "SQL", swift: "Swift", ts: "TypeScript", tsx: "TSX", typescript: "TypeScript", xml: "XML"
  };
  return languages[normalized] ? `${languages[normalized]} 代码` : "代码块";
}

export function renderHelpCard(): object {
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "HerdrSwarm 帮助" } },
    header: { title: { tag: "plain_text", content: "HerdrSwarm" }, template: "blue" },
    body: { elements: [
      { tag: "markdown", content: [
        "**HerdrSwarm：从飞书协调 Herdr 中的 TraeX pane**", "",
        "`/swarm new [标题]`  选择项目并创建 TraeX pane",
        "`/swarm reset [标题]`  在当前话题安全切换到新的 TraeX 会话（旧 pane 仅在确认空闲后自动关闭）",
        "`/swarm stop`  向活动 TraeX pane 发送 Herdr Esc，不进入任务队列",
        "`/swarm steer <文本>`  将文本注入当前活动 turn，不降级为普通任务",
        "`/swarm projects`  打开项目选择卡片",
        "`/swarm spaces`  按 Space 查看全部 Pane",
        "`/swarm sessions`  查看当前群的会话",
        "`/swarm failures`  查看并处理发送失败",
        "`/swarm attach <space> <pane>`  按 ID 或唯一名称连接已有 TraeX pane",
        "`/swarm status`  查看当前绑定",
        "`/swarm model [name]`  查看或切换当前 Pane 的 TraeX 模型",
        "`/swarm rename <标题>`  重命名当前 pane",
        "`/swarm close`  归档映射（不会强杀 TraeX）",
        "`/swarm pane close`  请求关闭空闲 Pane（需要 60 秒内二次确认）",
        "`/swarm pane close confirm <code>`  确认关闭当前话题绑定的 Pane",
        "`/swarm reattach <pane>`  重新连接已验证的原 Pane",
        "`/swarm replace`  创建新的 Pane generation（不会重放任务）",
        "`/swarm resume`  验证后恢复已归档会话",
        "`/swarm help`  显示本卡片", "",
        "只有 `/swarm …` 会由 HerdrSwarm 处理；其它 slash 命令会原样提交给 TraeX。"
      ].join("\n") },
      { tag: "markdown", content: "高风险审批必须在 Herdr 终端完成" }
    ] }
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

function verticalMetrics(input: Pick<TopicViewState, "spaceName" | "tabId" | "paneId" | "worktreeName" | "model" | "context" | "queueDepth">): string {
  const entries: Array<[label: string, value: string]> = [
    ["SPACE", input.spaceName],
    ["TAB", input.tabId ?? "—"],
    ["PANE", input.paneId ?? "provisioning"]
  ];
  const identity = entries.map(([label, value]) => `**${label}**  \`${escapeCode(truncate(value, 28))}\``).join("   " );
  const metrics: Array<[label: string, value: string]> = [
    ["MODEL", input.model ?? "—"],
    ["CONTEXT", input.context ?? "—"],
    ["QUEUE", String(input.queueDepth)]
  ];
  const runtime = metrics.map(([label, value]) => `**${label}**  \`${escapeCode(truncate(value, 28))}\``).join("   " );
  return [identity, runtime, `**WORKTREE**  \`${escapeCode(truncate(input.worktreeName ?? "—", 64))}\``].join("\n");
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
function agentTitle(title: string): string {
  return boundedTitle(title);
}
function boundedTitle(title: string): string { return truncate(title.replace(/\s+/g, " " ).trim() || "未命名任务", 64); }
function requestSummaryLabel(phase: RunCardView["phase"]): string {
  return { queued: "排队中", running: "执行中", blocked: "等待处理", completed: "完成", failed: "失败" }[phase];
}
function conversationalMetadata(input: RunCardView, duration: string | null, pageNumber?: number): string {
  const state = RUN_STATE_VIEW[input.phase];
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
function topicStateLine(input: TopicViewState, options: TopicCardRenderOptions): string {
  const view = STATE_VIEW[input.phase];
  const updated = relativeTime(options.lastActivityAt);
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
function projectProgressLine(event: RunCardView["progressEvents"][number]): string {
  return event.kind === "step" ? progressLine(event) : `🛠️ ${progressLabel(event.label)}`;
}
function projectWorkSummary(input: TopicViewState): string {
  if (input.phase === "running") return `**当前工作**\nTraeX 正在处理当前请求${input.queueDepth > 0 ? `；后续还有 ${input.queueDepth} 条请求等待。` : "。"}`;
  if (input.phase === "queued") return `**队列状态**\n当前请求正在 FIFO 队列中等待${input.queueDepth > 0 ? `（队列共 ${input.queueDepth} 条）。` : "。"}`;
  if (input.phase === "done") return `**最近完成**\n当前 Pane 没有正在执行的请求${input.queueDepth > 0 ? `；下一条请求正在等待调度（${input.queueDepth} 条）。` : "。"}`;
  return `**会话状态**\n${STATE_VIEW[input.phase].label}`;
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
