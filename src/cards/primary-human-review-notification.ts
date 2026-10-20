import type { PrimaryHumanReviewNotificationInput } from "../domain/human-review.js";
import { canMentionFeishuOpenId } from "../domain/human-review.js";
import { displayPaneIdentity } from "../domain/pane-display-identity.js";
import { normalizeLarkPreview, truncateLarkMarkdown } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";
import { cardSection, compactMetadata } from "./card-style.js";

export function renderPrimaryHumanReviewNotification(input: PrimaryHumanReviewNotificationInput): object {
  const waiting = input.state === "waiting";
  const mention = waiting && canMentionFeishuOpenId(input.creatorOpenId)
    ? `<at id=${input.creatorOpenId}></at> `
    : "";
  const pane = safe(displayPaneIdentity({ paneId: input.paneId, paneToken: input.paneToken }));
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: `${safe(input.primaryName)} · ${waiting ? "等待用户处理" : "已恢复运行"}` } },
    header: {
      title: { tag: "plain_text", content: `${waiting ? "⚠️ Primary 需要处理" : "✅ Primary 已恢复"} · ${safe(input.primaryName)}` },
      subtitle: { tag: "plain_text", content: `HERDR PRIMARY · ${pane}` },
      template: waiting ? "orange" : "green"
    },
    body: {
      elements: [
        { tag: "markdown", content: `${mention}Primary **${safe(input.primaryName)}** ${waiting ? "正在等待用户处理。" : "已离开等待状态，之前的处理提醒现已失效。"}` },
        { tag: "markdown", content: `${cardSection("🎯", "请求")}\n${safe(input.requestText, 1_500)}\n\n${compactMetadata([`Prompt \`${safe(input.promptId)}\``, `Pane \`${pane}\``, `Generation \`${input.bindingGeneration}\``])}` },
        { tag: "collapsible_panel", expanded: waiting, border: { color: waiting ? "orange" : "green", corner_radius: "6px" }, header: { title: { tag: "plain_text", content: waiting ? "需要本地处理" : "恢复状态" } }, elements: [{ tag: "markdown", content: safe(input.notice, 1_500) }] },
        { tag: "markdown", content: waiting
          ? "审批和本地操作仍须在对应 Herdr Pane 完成；此通知不提供远程审批或输入能力。"
          : "此消息仅用于撤销之前的等待提醒；请以最新 Primary Main/Answer Card 为准。" }
      ]
    }
  };
}

function safe(value: string, limit = 300): string {
  return truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(value)), limit);
}
