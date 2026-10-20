import type { DeliveryQuarantineReviewInput } from "../domain/delivery-quarantine-review.js";
import { canMentionFeishuOpenId } from "../domain/human-review.js";
import { normalizeLarkPreview, truncateLarkMarkdown } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";
import { actionRow, cardSection, compactMetadata } from "./card-style.js";
import { callbackButton } from "./cardkit-button.js";

export function renderDeliveryQuarantineReview(input: DeliveryQuarantineReviewInput): object {
  const mention = canMentionFeishuOpenId(input.creatorOpenId) ? `<at id=${input.creatorOpenId}></at> ` : "";
  const actions = [
    ...(input.retryAllowed ? [callbackButton("重试发送", { action: "retry_dead_letter", replyId: input.failedReplyId }, "primary")] : []),
    callbackButton("保留审计并忽略", { action: "dismiss_dead_letter", replyId: input.failedReplyId }, "default")
  ];
  const elements: object[] = [
    { tag: "markdown", content: `${mention}一项 Delivery 已隔离，不再阻塞同 Pane/Global Ring 中的独立卡片，但仍需要人工复核。` },
    { tag: "markdown", content: `${cardSection("⚠️", "需要人工复核")}\n${safe(input.reason)}\n\n${compactMetadata([
      `Delivery \`${safe(input.failedReplyId, 160)}\``,
      `Kind \`${input.replyKind}\``,
      `Certainty \`${input.effectCertainty}\``,
      safe(input.scopeLabel, 240)
    ])}` },
    { tag: "markdown", content: input.retryAllowed
      ? "网关已持久确认原效果未发生；允许人工重试这项 Delivery，不会重放 Agent 任务。"
      : "远端效果仍不确定或操作不可安全重放，因此不提供直接重试；原 Delivery 与 quarantine 审计记录保持不变。" }
  ];
  const row = actionRow(actions);
  if (row) elements.push(row);
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: "Delivery 需要人工复核" } },
    header: { title: { tag: "plain_text", content: "⚠️ Delivery 需要人工复核" }, template: "orange" },
    body: { elements }
  };
}

function safe(value: string, limit = 500): string {
  return truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(value)), limit);
}
