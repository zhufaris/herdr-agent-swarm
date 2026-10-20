import { randomUUID } from "node:crypto";
import {
  assistantMessageFromFinalMessageCompletionChoice,
  choicePromptFromLegacySpecification,
  continueChoicePrompt,
  inspectTraceEndReviewProtocol,
  legacySpecificationFromChoicePrompt,
  type AssistantMessageV2,
  type ChoiceOption,
  type ChoicePrompt,
  type FinalMessageCompletionChoice
} from "../../domain/completion-choice.js";
import type { CompletionActionOwnerKind } from "../../domain/completion-action-set.js";
import type { SqliteContext } from "./context.js";

export interface StoredCompletionChoice {
  id: string;
  prompt: ChoicePrompt;
  /** @deprecated Forwarding alias for callers not yet renamed to `prompt`. */
  specification: ChoicePrompt & { options: ChoiceOption[] };
}

export interface CompletionChoiceResolution {
  visibleAnswer: string;
  prompt?: ChoicePrompt;
  source: "native" | "compatibility" | "terminal-fence" | "none";
  invalidReason?: string;
  decision: "selected" | "invalid" | "explicit-none" | "conflict" | "none";
}

export function resolveCompletionChoiceSource(input: Pick<Parameters<typeof normalizeAndPersistCompletionChoice>[0], "answer" | "assistantMessage" | "completionChoice">): CompletionChoiceResolution {
  const inspected = inspectTraceEndReviewProtocol(input.answer, { terminal: true });
  const visibleAnswer = inspected.kind === "valid" || inspected.kind === "invalid" ? inspected.visibleMarkdown : input.answer;
  const protocol = inspected.kind === "valid" && inspected.decision.intent === "human_review"
    ? inspected.decision.choice
    : undefined;
  const compatibility = input.completionChoice && "defaultOption" in input.completionChoice
    ? { schemaVersion: 2 as const, text: visibleAnswer, choice: input.completionChoice }
    : input.completionChoice
      ? assistantMessageFromFinalMessageCompletionChoice(visibleAnswer, input.completionChoice)
      : undefined;
  const native = input.assistantMessage;
  const prompt = native?.choice ?? compatibility?.choice ?? protocol;
  const invalidReason = native?.compatibilityReason ?? compatibility?.compatibilityReason
    ?? (!prompt && inspected.kind === "invalid" ? inspected.reason : undefined);

  if (invalidReason) return { visibleAnswer, source: "none", invalidReason, decision: "invalid" };
  if (inspected.kind === "valid" && inspected.decision.intent === "none") {
    return { visibleAnswer, prompt: continueChoicePrompt(), source: "terminal-fence", decision: "selected" };
  }
  const metadataChoice = native?.choice ?? compatibility?.choice;
  if (protocol && metadataChoice && !choicePromptsEqual(protocol, metadataChoice)) {
    return { visibleAnswer, source: "none", decision: "conflict" };
  }
  if (!prompt) return { visibleAnswer, source: "none", decision: "none" };
  return {
    visibleAnswer,
    prompt,
    source: native?.choice ? "native" : compatibility?.choice ? "compatibility" : "terminal-fence",
    decision: "selected"
  };
}

export function normalizeAndPersistCompletionChoice(input: {
  context: SqliteContext;
  ownerKind: CompletionActionOwnerKind;
  ownerId: string;
  ownerGeneration: number;
  answer: string;
  assistantMessage?: AssistantMessageV2;
  completionChoice?: ChoicePrompt | FinalMessageCompletionChoice;
  occurredAt: string;
}): { answer: string; choice: StoredCompletionChoice | null; invalidReason?: string } {
  const resolved = resolveCompletionChoiceSource(input);

  if (resolved.invalidReason) {
    persistInvalidReason(input, resolved.invalidReason);
    return { answer: resolved.visibleAnswer, choice: null, invalidReason: resolved.invalidReason };
  }
  if (!resolved.prompt) return { answer: resolved.visibleAnswer, choice: null };

  const existing = loadCompletionChoice(input.context, input.ownerKind, input.ownerId, input.ownerGeneration);
  if (existing) {
    if (JSON.stringify(existing.prompt) !== JSON.stringify(resolved.prompt)) {
      throw new Error(`Completion choice prompt changed for ${input.ownerKind}:${input.ownerId}`);
    }
    return { answer: resolved.visibleAnswer, choice: existing };
  }

  const invalid = loadCompletionChoiceInvalidReason(input.context, input.ownerKind, input.ownerId, input.ownerGeneration);
  if (invalid) return { answer: resolved.visibleAnswer, choice: null, invalidReason: invalid };
  const specification = legacySpecificationFromChoicePrompt(resolved.prompt);
  const id = randomUUID();
  input.context.database.prepare(`INSERT INTO completion_choice_specifications(
    id, owner_kind, owner_id, owner_generation, version, question, default_option_id, invalid_reason, created_at
  ) VALUES (?, ?, ?, ?, 1, ?, ?, NULL, ?)`).run(
    id, input.ownerKind, input.ownerId, input.ownerGeneration, specification.question ?? null,
    specification.defaultOptionId, input.occurredAt
  );
  const insertOption = input.context.database.prepare(`INSERT INTO completion_choice_options(
    specification_id, ordinal, option_id, label, message
  ) VALUES (?, ?, ?, ?, ?)`);
  specification.options.forEach((option, ordinal) => {
    insertOption.run(id, ordinal, option.id, option.label, option.message);
  });
  return { answer: resolved.visibleAnswer, choice: { id, prompt: resolved.prompt, specification: withForwardingOptions(resolved.prompt) } };
}

function persistInvalidReason(input: Parameters<typeof normalizeAndPersistCompletionChoice>[0], reason: string): void {
  const existing = input.context.database.prepare(`SELECT invalid_reason FROM completion_choice_specifications
    WHERE owner_kind=? AND owner_id=? AND owner_generation=?`).get(
    input.ownerKind, input.ownerId, input.ownerGeneration
  ) as { invalid_reason: string | null } | undefined;
  if (existing) {
    if (existing.invalid_reason !== reason) throw new Error(`Completion choice compatibility reason changed for ${input.ownerKind}:${input.ownerId}`);
    return;
  }
  input.context.database.prepare(`INSERT INTO completion_choice_specifications(
    id, owner_kind, owner_id, owner_generation, version, question, default_option_id, invalid_reason, created_at
  ) VALUES (?, ?, ?, ?, 1, NULL, '', ?, ?)`).run(
    randomUUID(), input.ownerKind, input.ownerId, input.ownerGeneration, reason, input.occurredAt
  );
}

export function loadCompletionChoice(
  context: SqliteContext,
  ownerKind: CompletionActionOwnerKind,
  ownerId: string,
  ownerGeneration: number
): StoredCompletionChoice | null {
  const row = context.database.prepare(`SELECT id, version, question, default_option_id, invalid_reason
    FROM completion_choice_specifications WHERE owner_kind = ? AND owner_id = ? AND owner_generation = ?`).get(
    ownerKind, ownerId, ownerGeneration
  ) as { id: string; version: 1; question: string | null; default_option_id: string; invalid_reason: string | null } | undefined;
  if (!row || row.invalid_reason) return null;
  const options = context.database.prepare(`SELECT option_id, label, message FROM completion_choice_options
    WHERE specification_id = ? ORDER BY ordinal`).all(row.id) as Array<{ option_id: string; label: string; message: string }>;
  const prompt = choicePromptFromLegacySpecification({
    question: row.question,
    defaultOptionId: row.default_option_id,
    options: options.map((option) => ({ id: option.option_id, label: option.label, message: option.message }))
  });
  return {
    id: row.id,
    prompt,
    specification: withForwardingOptions(prompt)
  };
}

function withForwardingOptions(prompt: ChoicePrompt): ChoicePrompt & { options: ChoiceOption[] } {
  return { ...prompt, options: [prompt.defaultOption, ...prompt.alternatives] };
}

function choicePromptsEqual(left: ChoicePrompt, right: ChoicePrompt): boolean {
  return left.question === right.question
    && choiceOptionsEqual(left.defaultOption, right.defaultOption)
    && left.alternatives.length === right.alternatives.length
    && left.alternatives.every((option, index) => choiceOptionsEqual(option, right.alternatives[index]!));
}

function choiceOptionsEqual(left: ChoiceOption, right: ChoiceOption): boolean {
  return left.id === right.id && left.label === right.label && left.submitText === right.submitText;
}

export function loadCompletionChoiceInvalidReason(
  context: SqliteContext,
  ownerKind: CompletionActionOwnerKind,
  ownerId: string,
  ownerGeneration: number
): string | null {
  const row = context.database.prepare(`SELECT invalid_reason FROM completion_choice_specifications
    WHERE owner_kind=? AND owner_id=? AND owner_generation=?`).get(ownerKind, ownerId, ownerGeneration) as { invalid_reason: string | null } | undefined;
  return row?.invalid_reason ?? null;
}
