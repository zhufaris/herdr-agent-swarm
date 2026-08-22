import type { TopicViewPhase, TopicViewState } from "../domain/topic-view.js";

const STATE_VIEW: Record<TopicViewPhase, { label: string; icon: string; color: string }> = {
  provisioning: { label: "正在创建 Pane", icon: "◌", color: "blue" },
  queued: { label: "已排队", icon: "⏱", color: "blue" },
  running: { label: "TraeX 正在处理", icon: "◌", color: "blue" },
  blocked: { label: "等待终端审批", icon: "⚠", color: "orange" },
  done: { label: "已完成", icon: "✓", color: "green" },
  error: { label: "执行失败", icon: "×", color: "red" },
  archived: { label: "已归档", icon: "□", color: "grey" },
  orphaned: { label: "绑定异常", icon: "!", color: "orange" }
};

export function renderRunCard(input: TopicViewState): object {
  const view = STATE_VIEW[input.phase];
  const elements: object[] = [
    {
      tag: "column_set",
      horizontal_spacing: "8px",
      columns: [
        metric("WORKSPACE", input.workspaceId),
        metric("PANE", input.paneId ?? "provisioning"),
        metric("QUEUE", String(input.queueDepth))
      ]
    },
    { tag: "hr" }
  ];

  if (input.answer?.trim()) {
    elements.push({ tag: "markdown", content: truncate(input.answer.trim(), 12_000) });
  } else if (input.phase === "blocked") {
    elements.push(callout("orange", "TraeX 需要人工审批。请回到对应 Herdr pane 完成审批；Lark 端不会绕过安全限制。"));
  } else if (input.phase === "error" || input.phase === "orphaned") {
    elements.push(callout(input.phase === "error" ? "red" : "orange", input.notice ?? "请检查 bridge 日志与 Herdr pane。"));
  } else if (input.phase === "running") {
    elements.push({ tag: "markdown", content: "正在等待 TraeX 完成。本卡片会在状态变化时更新。" });
  } else if (input.phase === "queued") {
    elements.push({ tag: "markdown", content: "消息已进入该话题的 FIFO 队列。" });
  }

  elements.push({
    tag: "note",
    elements: [{ tag: "plain_text", content: `${view.icon} ${view.label} · ${input.title}` }]
  });

  return {
    schema: "2.0",
    config: { update_multi: true, streaming_mode: input.phase === "running", summary: { content: view.label } },
    header: {
      title: { tag: "plain_text", content: `TraeX · ${truncate(input.title, 64)}` },
      subtitle: { tag: "plain_text", content: "HERDR REMOTE PANEL" },
      template: view.color,
      ud_icon: { tag: "standard_icon", token: "terminal_outlined" }
    },
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
        "`/herdr new <标题>`  创建一个 TraeX pane",
        "`/herdr status`  查看当前绑定",
        "`/herdr rename <标题>`  重命名当前 pane",
        "`/herdr close`  归档映射（不会强杀 TraeX）",
        "`/herdr help`  显示本卡片", "",
        "在已绑定话题中发送普通文本，即会按顺序提交给 TraeX。"
      ].join("\n") },
      { tag: "note", elements: [{ tag: "plain_text", content: "高风险审批必须在 Herdr 终端完成" }] }
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
function truncate(value: string, max: number): string { return value.length > max ? `${value.slice(0, max - 1)}…` : value; }
