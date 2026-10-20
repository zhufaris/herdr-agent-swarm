import {
  COMPLETION_ACTION_LABELS,
  type CompletionActionSelection,
  type CompletionReviewCardInput,
  type CompletionActionSetRenderState
} from "../domain/completion-action-set.js";
import { normalizeLarkPreview, truncateLarkMarkdown } from "../runtime/lark-markdown.js";
import { redactSecrets } from "../runtime/redact-secrets.js";
import { callbackButton } from "./cardkit-button.js";
import { actionRow } from "./card-style.js";

export function completionActionElements(actionSet: CompletionActionSetRenderState | null | undefined): object[] {
  if (!actionSet) return [];
  if (actionSet.state === "available" && actionSet.presentationKind === "fresh-card") return [];
  if (actionSet.state === "consumed" && "ignored" in actionSet) return [{ tag: "markdown", content: "已忽略" }];
  if (actionSet.state === "consumed") return [{ tag: "markdown", content: `已选择：${actionSet.selectedChoice?.label ?? COMPLETION_ACTION_LABELS[actionSet.selectedAction!]}` }];
  const prompt = actionSet.choicePrompt ?? actionSet.choiceSpecification;
  if (prompt) {
    const row = actionRow([...([prompt.defaultOption, ...prompt.alternatives]).map((option) => callbackButton(
      option.label,
      {
        action: "completion_action",
        actionSetId: actionSet.id,
        optionId: option.id,
        ownerKind: actionSet.ownerKind,
        ownerId: actionSet.ownerId,
        ownerGeneration: actionSet.ownerGeneration,
        cardMessageId: actionSet.cardMessageId
      },
      option.id === prompt.defaultOption.id ? "primary" : "default"
    )), callbackButton("忽略", {
      action: "completion_action",
      actionSetId: actionSet.id,
      optionId: "ignore",
      ownerKind: actionSet.ownerKind,
      ownerId: actionSet.ownerId,
      ownerGeneration: actionSet.ownerGeneration,
      cardMessageId: actionSet.cardMessageId
    }, "default")]);
    return [
      { tag: "markdown", content: prompt.question },
      ...(row ? [row] : [])
    ];
  }
  const value = (selection: CompletionActionSelection) => ({
    action: "completion_action",
    actionSetId: actionSet.id,
    selection,
    ownerKind: actionSet.ownerKind,
    ownerId: actionSet.ownerId,
    ownerGeneration: actionSet.ownerGeneration,
    cardMessageId: actionSet.cardMessageId
  });
  const row = actionRow([
    callbackButton("default", value("default"), "default"),
    callbackButton("批准", value("approve"), "primary"),
    callbackButton("继续", value("continue"), "default"),
    callbackButton("拒绝", value("reject"), "danger")
  ]);
  return [
    { tag: "markdown", content: `<at id=${actionSet.mentionOpenId}></at> 已完成，等待你的下一条消息。` },
    ...(row ? [row] : [])
  ];
}

export function renderCompletionReviewCard(input: CompletionReviewCardInput): object {
  const prompt = input.choicePrompt ?? input.choiceSpecification;
  if (!prompt) return {};
  const value = (optionId: string) => ({ action: "completion_action", actionSetId: input.actionSetId, optionId });
  const row = actionRow([
    ...[prompt.defaultOption, ...prompt.alternatives].map((option) => callbackButton(
      option.label,
      value(option.id),
      option.id === prompt.defaultOption.id ? "primary" : "default"
    )),
    callbackButton("忽略", value("ignore"), "default")
  ]);
  return {
    schema: "2.0",
    config: { width_mode: "fill", update_multi: true, summary: { content: "需要你的选择" } },
    header: { title: { tag: "plain_text", content: input.subjectLabel ? `${input.subjectLabel} · 需要你的选择` : "需要你的选择" }, template: "orange" },
    body: { elements: [
      { tag: "markdown", content: `<at id=${input.mentionOpenId}></at> ${safeReviewMarkdown(prompt.question, 1_000)}\n\n请参考上方最终回复` },
      ...(row ? [row] : [])
    ] }
  };
}

function safeReviewMarkdown(value: string, limit: number): string {
  return truncateLarkMarkdown(normalizeLarkPreview(redactSecrets(value)), limit) || "—";
}
