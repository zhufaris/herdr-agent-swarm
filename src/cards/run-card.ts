import type { TopicViewPhase, TopicViewState } from "../domain/topic-view.js";
import type { RunCardView } from "../domain/run-card-view.js";
import type { ProjectConfig } from "../domain/types.js";
import { truncateLarkMarkdown } from "../runtime/lark-markdown.js";

const RUN_STATE_VIEW = {
  queued: { label: "已排队", icon: "⏳", color: "blue" },
  running: { label: "TraeX 正在处理", icon: "🧠", color: "blue" },
  blocked: { label: "等待用户处理", icon: "⚠️", color: "orange" },
  completed: { label: "任务完成", icon: "✅", color: "green" },
  failed: { label: "执行失败", icon: "❌", color: "red" }
} as const;

const STATE_VIEW: Record<TopicViewPhase, { label: string; icon: string; color: string }> = {
  provisioning: { label: "正在创建 Pane", icon: "◌", color: "blue" },
  queued: { label: "已排队", icon: "⏱", color: "blue" },
  running: { label: "TraeX 正在处理", icon: "◌", color: "blue" },
  blocked: { label: "等待用户处理", icon: "⚠", color: "orange" },
  done: { label: "已完成", icon: "✓", color: "green" },
  error: { label: "执行失败", icon: "×", color: "red" },
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

export function renderProjectSelectionStatusCard(input: { status: "processing" | "completed" | "failed" | "expired" | "unauthorized"; projectName?: string; spaceName?: string; paneId?: string; message?: string }): object {
  const views = {
    processing: { title: "正在创建项目 Pane", template: "blue", icon: "⏳" },
    completed: { title: "项目已打开", template: "green", icon: "✅" },
    failed: { title: "项目创建失败", template: "red", icon: "❌" },
    expired: { title: "项目选择已过期", template: "orange", icon: "⌛" },
    unauthorized: { title: "无法使用此选择器", template: "orange", icon: "🔒" }
  } as const;
  const view = views[input.status];
  const details = [input.projectName ? `**项目**  ${escapeMarkdown(input.projectName)}` : null, input.spaceName ? `**Space**  \`${escapeCode(input.spaceName)}\`` : null, input.paneId ? `**Pane**  \`${escapeCode(input.paneId)}\`` : null, input.message ?? (input.status === "completed" ? "请在当前话题中发送第一条任务。" : null)].filter(Boolean).join("\n\n");
  return { schema: "2.0", config: { update_multi: true, summary: { content: view.title } }, header: { title: { tag: "plain_text", content: `${view.icon} ${view.title}` }, template: view.template }, body: { elements: [{ tag: "markdown", content: details || view.title }] } };
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

  if (input.answer?.trim()) {
    elements.push({ tag: "markdown", content: truncate(input.answer.trim(), 12_000) });
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
      title: { tag: "plain_text", content: `TraeX · ${truncate(input.title, 64)}` },
      subtitle: { tag: "plain_text", content: "HERDR REMOTE PANEL" },
      template: view.color
    },
    body: { elements }
  };
}

export function renderRequestRunCard(input: RunCardView): object {
  const state = RUN_STATE_VIEW[input.phase];
  const visibleProgress = input.progressEvents.slice(-60);
  const omittedProgress = input.progressEvents.length - visibleProgress.length;
  const lifecycleLine = input.phase === "queued"
    ? `⏳ 已进入队列 · 当前第 ${input.queuePosition} 位`
    : input.phase === "running" && visibleProgress.length === 0 ? "🧠 正在分析请求"
      : input.phase === "blocked" ? "⚠️ 等待用户处理"
        : input.phase === "completed" ? "✅ 任务完成"
          : input.phase === "failed" ? "❌ 执行失败" : null;
  const progressContent = [
    "📩 **已接收请求**", truncateLarkMarkdown(input.requestText, 2_000), "",
    lifecycleLine, omittedProgress > 0 ? `… 已省略 ${omittedProgress} 条较早记录` : null, ...visibleProgress.map(progressLine)
  ].filter((line) => line !== null).join("\n");
  const elements: object[] = [
    { tag: "column_set", horizontal_spacing: "8px", columns: [
      metric("SPACE", input.spaceName), metric("PANE", input.paneId ?? "provisioning"),
      metric("QUEUE", input.queuePosition > 0 ? String(input.queuePosition) : "—")
    ] },
    { tag: "hr" },
    { tag: "markdown", content: "**执行进度**" },
    { tag: "collapsible_panel", expanded: true, border: { color: input.phase === "failed" ? "red" : "grey", corner_radius: "6px" },
      header: { title: { tag: "plain_text", content: input.progressEvents.length ? `共 ${input.progressEvents.length} 项` : "请求详情" } },
      elements: [{ tag: "markdown", content: progressContent }] }
  ];
  if (input.answer) elements.push({ tag: "markdown", content: `**回答**\n\n${truncateLarkMarkdown(input.answer, 12_000)}` });
  else if (input.phase === "completed" && input.notice) elements.push({ tag: "markdown", content: `**结果**\n\n${truncateLarkMarkdown(input.notice, 2_000)}` });
  else if (input.phase === "running") elements.push({ tag: "markdown", content: "**回答**\n\n正在生成…" });
  if (input.phase === "blocked") elements.push(callout("orange", input.notice ?? "TraeX 正在等待用户处理。请查看对应 Herdr panel 并完成所需交互。"));
  if (input.phase === "failed") elements.push(callout("red", input.notice ?? "执行失败，请检查 Herdr pane。"));
  elements.push({ tag: "markdown", content: `${state.icon} ${state.label}` });
  return {
    schema: "2.0", config: { update_multi: true, streaming_mode: input.phase === "running", summary: { content: state.label } },
    header: { title: { tag: "plain_text", content: `TraeX · ${truncate(input.title, 64)}` }, subtitle: { tag: "plain_text", content: "HERDR REQUEST" }, template: state.color },
    body: { elements }
  };
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
        "`/herdr status`  查看当前绑定",
        "`/herdr rename <标题>`  重命名当前 pane",
        "`/herdr close`  归档映射（不会强杀 TraeX）",
        "`/herdr help`  显示本卡片", "",
        "在已绑定话题中发送普通文本，即会按顺序提交给 TraeX。"
      ].join("\n") },
      { tag: "markdown", content: "高风险审批必须在 Herdr 终端完成" }
    ] }
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
function progressLine(event: RunCardView["progressEvents"][number]): string {
  if (event.state === "failed") return `❌ ${event.label}`;
  if (event.kind === "test" && event.state === "done") return `✅ ${event.label}`;
  const icon = { analyze: "🧠", search: "🔍", read: "📖", edit: "✏️", test: "🧪" }[event.kind];
  return `${icon} ${event.label}`;
}
