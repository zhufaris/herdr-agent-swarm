import { createHash } from "node:crypto";

export const COMPLETION_ACTION_SELECTIONS = ["default", "approve", "continue", "reject"] as const;

export type CompletionActionSelection = typeof COMPLETION_ACTION_SELECTIONS[number];

export type CompletionActionOwnerKind = "primary-prompt" | "primary-segment" | "worker-turn";
const completionActionOwnerKinds = new Set<CompletionActionOwnerKind>(["primary-prompt", "primary-segment", "worker-turn"]);

export type CompletionReviewPresentationKind = "legacy-inline" | "fresh-card";

/**
 * Stable Completion Review identity. The input is length-delimited so distinct
 * owner tuples cannot share the same serialized representation.
 */
export function completionReviewActionSetIdentity(ownerKind: CompletionActionOwnerKind, ownerId: string, ownerGeneration: number): string {
  if (!completionActionOwnerKinds.has(ownerKind)) throw new Error("Completion Review ownerKind is invalid");
  if (!ownerId || ownerId !== ownerId.trim()) throw new Error("Completion Review ownerId is required and must not have surrounding whitespace");
  if (!Number.isSafeInteger(ownerGeneration) || ownerGeneration < 1) {
    throw new Error("Completion Review ownerGeneration must be a positive integer");
  }
  const canonical = [ownerKind, ownerId, String(ownerGeneration)]
    .map((value) => `${Buffer.byteLength(value, "utf8")}:${value}`)
    .join("|");
  return `completion-review:v3:${createHash("sha256").update(canonical).digest("hex")}`;
}

export const COMPLETION_ACTION_MESSAGES: Record<CompletionActionSelection, string> = {
  default: "default",
  approve: "批准，按当前方案继续执行。",
  continue: "继续。",
  reject: "拒绝，请停止当前方案并等待进一步指示。"
};

export const COMPLETION_ACTION_LABELS: Record<CompletionActionSelection, string> = {
  default: "default",
  approve: "批准",
  continue: "继续",
  reject: "拒绝"
};

type CompletionActionSetRenderIdentity = {
  id: string;
  ownerKind: CompletionActionOwnerKind;
  ownerId: string;
  ownerGeneration: number;
  cardMessageId: string;
};

export interface CompletionReviewCardInput {
  actionSetId: string;
  mentionOpenId: string;
  /** Present only for a Worker-owned review surface. */
  subjectLabel?: string;
  choicePrompt?: import("./completion-choice.js").ChoicePrompt;
  /** @deprecated Forwarding alias retained for unmodified workflow callers. */
  choiceSpecification?: import("./completion-choice.js").ChoicePrompt;
}

export interface CompletionActionIgnoreResult {
  ownerId: string;
  changed: boolean;
}

export type CompletionActionSetRenderState = CompletionActionSetRenderIdentity & (
  | { state: "available"; mentionOpenId: string; choicePrompt?: import("./completion-choice.js").ChoicePrompt; choiceSpecification?: import("./completion-choice.js").ChoicePrompt; presentationKind?: CompletionReviewPresentationKind }
  | { state: "consumed"; selectedAction: CompletionActionSelection; selectedChoice?: never }
  | { state: "consumed"; selectedChoice: { id: string; label: string }; selectedAction?: never }
  | { state: "consumed"; ignored: true; selectedAction?: never; selectedChoice?: never }
);
