import type { AnswerTimelineItem, AnswerTimelineToolCategory, AnswerTimelineToolState } from "../domain/answer-timeline.js";
import { redactSecrets } from "./redact-secrets.js";

const ANSI = /[\u001B\u009B][[\]\(\)#;?]*(?:(?:(?:[a-zA-Z\d]*(?:;[-a-zA-Z\d\/#&.:=?%@~_]+)*)?\u0007)|(?:(?:\d{1,4}(?:;\d{0,4})*)?[\dA-PR-TZcf-nq-uy=><~]))/g;
const SHORT_TARGET_LIMIT = 88;
const COMMAND_DETAIL_LIMIT = 1_000;
const RESULT_DETAIL_LIMIT = 4_000;

export const ANSWER_TOOL_CATEGORY: Record<AnswerTimelineToolCategory, { icon: string; label: string }> = {
  skill: { icon: "🧩", label: "Skill" },
  read: { icon: "📖", label: "Read" },
  search: { icon: "🔎", label: "Search" },
  edit: { icon: "✏️", label: "Edited" },
  command: { icon: "🖥️", label: "Ran" },
  input: { icon: "⌨️", label: "Input" },
  test: { icon: "🧪", label: "Tested" },
  agent: { icon: "🤖", label: "Delegated" },
  step: { icon: "🔧", label: "Tool" }
};

export const ANSWER_TOOL_STATE: Record<AnswerTimelineToolState, { icon: string; border: string; empty: string }> = {
  running: { icon: "⏳", border: "blue", empty: "工具仍在运行，暂无可展示结果。" },
  succeeded: { icon: "✅", border: "grey", empty: "工具已完成，无可展示输出。" },
  failed: { icon: "❌", border: "red", empty: "工具执行失败，无可展示详情。" }
};

export function answerToolPresentation(item: Extract<AnswerTimelineItem, { kind: "tool" }>): {
  title: string; border: string; empty: string; command: string; result: string;
} {
  const category = ANSWER_TOOL_CATEGORY[item.category] ?? ANSWER_TOOL_CATEGORY.step;
  const state = ANSWER_TOOL_STATE[item.state];
  const target = answerToolShortTarget(item);
  return {
    title: [category.icon + " " + category.label, target, state.icon].filter(Boolean).join(" · "),
    border: state.border,
    empty: state.empty,
    command: item.command ? safeAnswerFence(item.command, COMMAND_DETAIL_LIMIT) : "",
    result: item.category !== "skill" && item.resultPreview ? safeAnswerFence(item.resultPreview, RESULT_DETAIL_LIMIT) : ""
  };
}

export function answerStatusPresentation(item: Extract<AnswerTimelineItem, { kind: "status" }>): { title: string; color: string; empty: string } {
  const view = item.state === "blocked"
    ? { icon: "⚠️", label: "等待用户处理", color: "orange" }
    : item.state === "failed"
      ? { icon: "❌", label: "执行失败", color: "red" }
      : { icon: "💭", label: "正在生成", color: "blue" };
  const detail = safeAnswerInline(item.label, 160);
  return { title: [view.icon + " " + view.label, detail].filter(Boolean).join(" · "), color: view.color, empty: detail || view.label };
}

export function answerToolShortTarget(item: Extract<AnswerTimelineItem, { kind: "tool" }>): string {
  const source = (item.category === "command" || item.category === "test") && item.command
    ? item.command.split(/\r?\n/u).find((line) => line.trim()) ?? item.label
    : item.label;
  return safeAnswerInline(source, SHORT_TARGET_LIMIT);
}

export function safeAnswerInline(value: string, limit: number): string {
  const safe = redactSecrets(stripAnsi(value))
    .replace(/[\u0000-\u001f\u007f]+/gu, " ")
    .replace(/\s+/gu, " ")
    .trim();
  const characters = [...safe];
  return characters.length <= limit ? safe : `${characters.slice(0, Math.max(0, limit - 1)).join("").trimEnd()}…`;
}

export function safeAnswerFence(value: string, limit: number): string {
  const safe = redactSecrets(stripAnsi(value))
    .replace(/\r\n?/gu, "\n")
    .replace(/[\u0000-\u0008\u000b\u000c\u000e-\u001f\u007f]/gu, "")
    .trim();
  const characters = [...safe];
  if (characters.length <= limit) return safe;
  const suffix = "\n… 内容已截断，请在对应 Herdr Pane 查看完整内容。";
  return `${characters.slice(0, Math.max(0, limit - [...suffix].length)).join("").trimEnd()}${suffix}`;
}

function stripAnsi(value: string): string { return value.replace(ANSI, ""); }
