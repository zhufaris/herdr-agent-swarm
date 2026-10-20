import type { InputCardView } from "../domain/input-card-view.js";
import { normalizeLarkPreview, truncateLarkMarkdown } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";

const INPUT_PREVIEW_LIMIT = 8_000;

export function renderInputCard(view: InputCardView): object {
  const working = view.state === "working";
  const status = working
    ? { icon: "✅", label: "Working", color: "blue", detail: "已从 Herdr Core canonical JSONL 观察到对应 Human Message。" }
    : { icon: "⏳", label: "Pending", color: "orange", detail: "等待 Herdr 将对应 Human Message 写入 canonical JSONL。" };
  const text = safeInput(view.text);
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: `${status.label} · ${text.slice(0, 80)}` } },
    header: {
      title: { tag: "plain_text", content: `${status.icon} Input · ${status.label}` },
      subtitle: { tag: "plain_text", content: "HERDR AGENT INPUT · JSONL ORDERED" },
      template: status.color
    },
    body: {
      elements: [
        { tag: "markdown", content: `**${status.label}** · ${view.ownerKind === "worker" ? "Worker" : "Primary"} Input` },
        { tag: "column_set", background_style: status.color === "orange" ? "orange-50" : "blue-50", columns: [{ tag: "column", width: "weighted", weight: 1, elements: [{ tag: "markdown", content: status.detail }] }] },
        { tag: "hr" },
        { tag: "markdown", content: text }
      ]
    }
  };
}

function safeInput(value: string): string {
  return truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(value)), INPUT_PREVIEW_LIMIT) || "—";
}
