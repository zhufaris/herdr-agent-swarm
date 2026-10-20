import { normalizeLarkPreview, truncateLarkMarkdown } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";
import { callbackButton } from "./cardkit-button.js";
import { actionRow, cardSection, compactMetadata } from "./card-style.js";
import { canMentionFeishuOpenId, type WorkerHumanReviewNotificationInput } from "../domain/worker-human-review.js";
import { displayPaneIdentity } from "../domain/pane-display-identity.js";

export function renderWorkerHumanReviewNotification(input: WorkerHumanReviewNotificationInput): object {
  const waiting = input.state === "waiting";
  const mention = canMentionFeishuOpenId(input.creatorOpenId)
    ? "<at id=" + input.creatorOpenId + "></at> "
    : "";
  const target = input.workerMainMessageId
    ? callbackButton("查看 Worker Main Card", { action: "card_target_open", aggregateKind: "worker-session", aggregateId: input.workerId, generation: input.workerSessionGeneration, messageId: input.workerMainMessageId }, "primary")
    : null;
  const elements: object[] = [
    { tag: "markdown", content: mention + (waiting ? "Worker **" + safe(input.workerName) + "** 正在等待用户处理。" : "Worker **" + safe(input.workerName) + "** 已离开等待状态。") },
    { tag: "markdown", content: cardSection("🎯", "任务") + "\n" + safe(input.taskTitle, 1_500) + "\n\n" + compactMetadata(["Turn `" + safe(input.turnId) + "`", "Primary `" + safe(displayPaneIdentity({ paneId: input.parentPaneId, paneToken: input.parentPaneToken })) + "`", "Worker `" + safe(displayPaneIdentity({ paneId: input.workerPaneId, paneToken: input.workerPaneToken })) + "`"]) },
    { tag: "collapsible_panel", expanded: waiting, border: { color: waiting ? "orange" : "green", corner_radius: "6px" }, header: { title: { tag: "plain_text", content: waiting ? "需要处理" : "已处理" } }, elements: [{ tag: "markdown", content: safe(input.notice, 1_500) }] },
    { tag: "markdown", content: waiting ? "审批和本地操作仍须在对应 Herdr Pane 完成；此通知不提供远程审批或输入能力。" : "之前的处理提醒现已失效；后续状态请查看 Worker Main Card。" }
  ];
  const row = actionRow(target ? [target] : []);
  if (row) elements.push(row);
  return {
    schema: "2.0",
    config: { update_multi: true, summary: { content: safe(input.workerName) + (waiting ? " · 等待用户处理" : " · 已处理") } },
    header: { title: { tag: "plain_text", content: (waiting ? "⚠️ Worker 需要处理 · " : "✅ Worker 已恢复 · ") + safe(input.workerName) }, subtitle: { tag: "plain_text", content: "HERDR WORKER · PRIMARY " + safe(input.primaryName) }, template: waiting ? "orange" : "green" },
    body: { elements }
  };
}

function safe(value: string, limit = 300): string {
  return truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(value)), limit);
}
