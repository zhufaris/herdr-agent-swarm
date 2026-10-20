import { createHash } from "node:crypto";

const MAX_PROTOCOL_BYTES = 8 * 1024;
const MIN_OPTIONS = 2;
const MAX_OPTIONS = 5;
const MIN_REVIEW_OPTIONS = 1;
const MAX_REVIEW_OPTIONS = 4;
const MAX_OPTION_ID_LENGTH = 64;
const MAX_LABEL_LENGTH = 40;
const MAX_MESSAGE_LENGTH = 2_000;
const MAX_QUESTION_LENGTH = 2_000;
const RESERVED_IGNORE_OPTION_ID = "ignore";
const OPTION_ID_PATTERN = /^[A-Za-z0-9][A-Za-z0-9_-]*$/;

/** Gives one selected choice a stable Core-safe identity without carrying prior action text forward. */
export function completionChoiceSubmissionIdentity(actionSetId: string, optionId: string): string {
  const digest = createHash("sha256").update(JSON.stringify([actionSetId, optionId])).digest("hex");
  return `completion-choice:v2:${digest}`;
}

export interface CompletionChoiceOption {
  id: string;
  label: string;
  message: string;
}

/** The complete, producer-owned form of one review action. */
export interface ChoiceOption {
  id: string;
  label: string;
  submitText: string;
}

/** A review prompt always carries its default option as a complete value. */
export interface ChoicePrompt {
  question: string;
  defaultOption: ChoiceOption;
  alternatives: ChoiceOption[];
}

/** The durable fallback action for a valid terminal response with no review choices. */
export function continueChoicePrompt(): ChoicePrompt {
  return {
    question: "是否继续？",
    defaultOption: { id: "continue", label: "继续", submitText: "continue" },
    alternatives: []
  };
}

/** Canonical assistant output used after any compatibility input is normalized. */
export interface AssistantMessageV2 {
  schemaVersion: 2;
  text: string;
  choice?: ChoicePrompt;
  /** A bounded diagnostic for withheld compatibility transport. */
  compatibilityReason?: string;
}

/** Additive Core transport metadata carried only by a canonical final message. */
export interface FinalMessageCompletionChoice {
  version: 2;
  intent: "human_review";
  question: string;
  default: string;
  options: CompletionChoiceOption[];
}

/** Validates the bounded Core transport value before it can become durable action state. */
export function isFinalMessageCompletionChoice(value: unknown): value is FinalMessageCompletionChoice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 2 || record.intent !== "human_review" || typeof record.question !== "string" || record.question.trim().length === 0 || [...record.question].length > MAX_QUESTION_LENGTH || typeof record.default !== "string" || !hasValidReviewOptions(record.options)) return false;
  const defaultOption = record.options.find((option) => option.id === record.default);
  return defaultOption?.message === "default";
}

/**
 * A v3 fence is recovered locally, never accepted as Core-native metadata.
 * It intentionally permits a real default message in place of the legacy
 * transport sentinel after the v3 parser has already validated its source.
 */
export function isRecoveredCompletionChoice(value: unknown): value is FinalMessageCompletionChoice {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const record = value as Record<string, unknown>;
  if (record.version !== 2 || record.intent !== "human_review" || typeof record.question !== "string" || record.question.trim().length === 0 || [...record.question].length > MAX_QUESTION_LENGTH || typeof record.default !== "string" || !hasValidReviewOptions(record.options)) return false;
  return record.options.some((option) => option.id === record.default);
}

/** Shared native/recovered compatibility bounds; sentinel handling stays at each boundary. */
function hasValidReviewOptions(value: unknown): value is CompletionChoiceOption[] {
  if (!Array.isArray(value) || value.length < MIN_REVIEW_OPTIONS || value.length > MAX_REVIEW_OPTIONS) return false;
  const ids = new Set<string>();
  for (const item of value) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return false;
    const option = item as Record<string, unknown>;
    if (typeof option.id !== "string" || option.id === RESERVED_IGNORE_OPTION_ID || option.id.length > MAX_OPTION_ID_LENGTH || !OPTION_ID_PATTERN.test(option.id) || ids.has(option.id) || typeof option.label !== "string" || option.label.trim().length === 0 || [...option.label].length > MAX_LABEL_LENGTH || typeof option.message !== "string" || option.message.trim().length === 0 || [...option.message].length > MAX_MESSAGE_LENGTH) return false;
    ids.add(option.id);
  }
  return true;
}

/** @deprecated Legacy durable representation. Compatibility inputs only. */
export interface CompletionChoiceSpecification {
  version: 1;
  question?: string;
  defaultOptionId: string;
  options: CompletionChoiceOption[];
}

export type CompletionChoiceProtocolInspection =
  | { kind: "none"; visibleMarkdown: string }
  | { kind: "pending"; visibleMarkdown: string; withheldMarkdown: string }
  | { kind: "invalid"; visibleMarkdown: string; reason: string }
  | { kind: "valid"; visibleMarkdown: string; specification: CompletionChoiceSpecification };

export type TraceEndReviewDecision =
  | { protocolVersion: 2 | 3; intent: "none" }
  | {
    protocolVersion: 1 | 2 | 3;
    intent: "human_review";
    choice: ChoicePrompt;
  };

export function choicePromptFromLegacyCompletionChoice(value: FinalMessageCompletionChoice): ChoicePrompt {
  const defaultOption = value.options.find((option) => option.id === value.default);
  if (!defaultOption) throw new Error("Final completion choice has no default option");
  return {
    question: value.question,
    defaultOption: { id: defaultOption.id, label: defaultOption.label, submitText: defaultOption.message },
    alternatives: value.options.filter((option) => option.id !== value.default).map((option) => ({
      id: option.id, label: option.label, submitText: option.message
    }))
  };
}

export function finalMessageCompletionChoiceFromChoicePrompt(choice: ChoicePrompt): FinalMessageCompletionChoice {
  return {
    version: 2,
    intent: "human_review",
    question: choice.question,
    default: choice.defaultOption.id,
    options: [choice.defaultOption, ...choice.alternatives].map((option) => ({
      id: option.id, label: option.label, message: option.submitText
    }))
  };
}

export function assistantMessageFromFinalMessageCompletionChoice(
  text: string,
  value: unknown
): AssistantMessageV2 {
  if (!isFinalMessageCompletionChoice(value)) return { schemaVersion: 2, text, compatibilityReason: "invalid-native-completion-choice" };
  return { schemaVersion: 2, text, choice: choicePromptFromLegacyCompletionChoice(value) };
}

/** Converts only the current v2 Human Review protocol into Core final-message metadata. */
export function finalMessageCompletionChoiceFromTraceEndReviewDecision(
  decision: TraceEndReviewDecision
): FinalMessageCompletionChoice | undefined {
  if (decision.protocolVersion !== 2 || decision.intent !== "human_review") return undefined;
  const choice = decision.choice;
  if (choice.question.trim().length === 0 || [...choice.question].length > MAX_QUESTION_LENGTH) return undefined;
  return finalMessageCompletionChoiceFromChoicePrompt(choice);
}

/** Adapts a validated terminal compatibility fence into canonical assistant output. */
export function recoveredCompletionChoiceFromTraceEndReviewDecision(
  decision: TraceEndReviewDecision
): ChoicePrompt | undefined {
  if (decision.intent !== "human_review" || (decision.protocolVersion !== 2 && decision.protocolVersion !== 3)) return undefined;
  return decision.choice;
}

export type TraceEndReviewProtocolInspection =
  | { kind: "none"; visibleMarkdown: string }
  | { kind: "pending"; visibleMarkdown: string; withheldMarkdown: string }
  | { kind: "invalid"; visibleMarkdown: string; reason: string }
  | { kind: "valid"; visibleMarkdown: string; decision: TraceEndReviewDecision };

interface ReservedProtocolRegion {
  start: number;
  end: number;
  block: string;
  json: string;
  complete: boolean;
}

interface ReservedProtocolScan {
  regions: ReservedProtocolRegion[];
  visibleMarkdown: string;
}

interface MarkdownFence {
  marker: "`" | "~";
  length: number;
}

function markdownFenceOpener(line: string): MarkdownFence | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})[^\r\n]*\r?$/.exec(line);
  if (!match) return undefined;
  const marker = match[1]![0]!;
  return { marker: marker === "`" ? "`" : "~", length: match[1]!.length };
}

function closesMarkdownFence(line: string, fence: MarkdownFence): boolean {
  let cursor = 0;
  while (cursor < line.length && cursor < 3 && line[cursor] === " ") cursor += 1;
  let length = 0;
  while (line[cursor + length] === fence.marker) length += 1;
  return length >= fence.length && /^[ \t]*\r?$/.test(line.slice(cursor + length));
}

function scanReservedProtocol(markdown: string): ReservedProtocolScan {
  const regions: ReservedProtocolRegion[] = [];
  let outerFence: MarkdownFence | undefined;
  let cursor = 0;
  while (cursor < markdown.length) {
    const lineEnd = markdown.indexOf("\n", cursor);
    const end = lineEnd === -1 ? markdown.length : lineEnd;
    const nextLine = lineEnd === -1 ? markdown.length : lineEnd + 1;
    const line = markdown.slice(cursor, end);

    if (outerFence) {
      if (closesMarkdownFence(line, outerFence)) outerFence = undefined;
      cursor = nextLine;
      continue;
    }

    if (line === "```herdr-choice-list" || line === "```herdr-choice-list\r") {
      const start = cursor;
      const contentStart = nextLine;
      cursor = nextLine;
      while (cursor < markdown.length) {
        const protocolLineEnd = markdown.indexOf("\n", cursor);
        const protocolEnd = protocolLineEnd === -1 ? markdown.length : protocolLineEnd;
        const protocolLine = markdown.slice(cursor, protocolEnd);
        if (protocolLine === "```" || protocolLine === "```\r") {
          const regionEnd = cursor + 3;
          regions.push({
            start,
            end: regionEnd,
            block: markdown.slice(start, regionEnd),
            json: markdown.slice(contentStart, cursor),
            complete: true
          });
          cursor = protocolLineEnd === -1 ? markdown.length : protocolLineEnd + 1;
          break;
        }
        cursor = protocolLineEnd === -1 ? markdown.length : protocolLineEnd + 1;
      }
      if (regions.at(-1)?.start !== start) {
        regions.push({ start, end: markdown.length, block: markdown.slice(start), json: markdown.slice(contentStart), complete: false });
      }
      continue;
    }

    outerFence = markdownFenceOpener(line);
    cursor = nextLine;
  }
  return { regions, visibleMarkdown: visibleMarkdownWithoutReservedProtocolRegions(markdown, regions) };
}

function joinVisibleMarkdown(left: string, right: string): string {
  const leftHasContent = left.trim().length > 0;
  const rightHasContent = right.trim().length > 0;
  if (!leftHasContent) return right.replace(/^(?:[ \t]*\r?\n)+/, "");
  if (!rightHasContent) return left.replace(/(?:\r?\n[ \t]*)+$/, "");
  return `${left.replace(/[ \t]*(?:\r?\n[ \t]*)+$/, "")}\n\n${right.replace(/^(?:[ \t]*\r?\n)+/, "")}`;
}

function visibleMarkdownWithoutReservedProtocolRegions(markdown: string, regions: ReservedProtocolRegion[]): string {
  if (regions.length === 0) return markdown;
  let visible = markdown.slice(0, regions[0]!.start);
  for (let index = 0; index < regions.length; index += 1) {
    const region = regions[index]!;
    const nextStart = regions[index + 1]?.start ?? markdown.length;
    visible = joinVisibleMarkdown(visible, markdown.slice(region.end, nextStart));
  }
  return visible;
}

/** Removes transport-only regions without deciding whether any decision is valid. */
export function sanitizeCompletionChoiceMarkdown(markdown: string): string {
  return scanReservedProtocol(markdown).visibleMarkdown;
}

function invalidSpecificationReason(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid-shape";
  const record = value as Record<string, unknown>;
  if (record.version !== 1) return "unsupported-version";
  if (typeof record.default !== "string") return "invalid-default";
  if (!Array.isArray(record.options) || record.options.length < MIN_OPTIONS || record.options.length > MAX_OPTIONS) {
    return "invalid-option-count";
  }

  const ids = new Set<string>();
  for (const item of record.options) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return "invalid-option";
    const option = item as Record<string, unknown>;
    if (
      typeof option.id !== "string"
      || option.id.length > MAX_OPTION_ID_LENGTH
      || !OPTION_ID_PATTERN.test(option.id)
    ) return "invalid-option-id";
    if (ids.has(option.id)) return "duplicate-option-id";
    ids.add(option.id);
    if (typeof option.label === "string" && [...option.label].length > MAX_LABEL_LENGTH) return "oversized";
    if (typeof option.label !== "string" || option.label.trim().length === 0) {
      return "invalid-option-label";
    }
    if (typeof option.message === "string" && [...option.message].length > MAX_MESSAGE_LENGTH) return "oversized";
    if (typeof option.message !== "string" || option.message.trim().length === 0) {
      return "invalid-option-message";
    }
  }

  if (!ids.has(record.default)) return "invalid-default";
  const defaultOption = (record.options as Array<Record<string, unknown>>).find((option) => option.id === record.default);
  if (defaultOption?.message !== "default") return "invalid-default-message";
  return undefined;
}

function invalidReviewSpecificationReason(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid-shape";
  const record = value as Record<string, unknown>;
  if (record.version !== 2) return "unsupported-version";
  if (record.intent === "none") {
    return Object.keys(record).some((key) => key !== "version" && key !== "intent") ? "invalid-none-fields" : undefined;
  }
  if (record.intent !== "human_review") return "invalid-intent";
  if (typeof record.question !== "string" || record.question.trim().length === 0) return "invalid-question";
  if ([...record.question].length > MAX_QUESTION_LENGTH) return "oversized";
  if (typeof record.default !== "string") return "invalid-default";
  if (!Array.isArray(record.options) || record.options.length < MIN_REVIEW_OPTIONS || record.options.length > MAX_REVIEW_OPTIONS) {
    return "invalid-option-count";
  }
  const ids = new Set<string>();
  for (const item of record.options) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return "invalid-option";
    const option = item as Record<string, unknown>;
    if (typeof option.id !== "string" || option.id.length > MAX_OPTION_ID_LENGTH || !OPTION_ID_PATTERN.test(option.id)) return "invalid-option-id";
    if (option.id === RESERVED_IGNORE_OPTION_ID) return "reserved-option-id";
    if (ids.has(option.id)) return "duplicate-option-id";
    ids.add(option.id);
    if (typeof option.label !== "string" || option.label.trim().length === 0) return "invalid-option-label";
    if ([...option.label].length > MAX_LABEL_LENGTH) return "oversized";
    if (typeof option.message !== "string" || option.message.trim().length === 0) return "invalid-option-message";
    if ([...option.message].length > MAX_MESSAGE_LENGTH) return "oversized";
  }
  if (!ids.has(record.default)) return "invalid-default";
  const defaultOption = (record.options as Array<Record<string, unknown>>).find((option) => option.id === record.default);
  if (defaultOption?.message !== "default") return "invalid-default-message";
  return undefined;
}

/**
 * Validates the primary-owned v3 review transport.  Unlike the legacy fence,
 * its default is an ordinary complete option: its submit text is never a
 * transport sentinel.
 */
function invalidEmbeddedReviewSpecificationReason(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid-shape";
  const record = value as Record<string, unknown>;
  if (record.version !== 3) return "unsupported-version";
  if (Object.keys(record).some((key) => key !== "version" && key !== "choice")) return "invalid-v3-fields";
  if (!("choice" in record)) return undefined;
  if (typeof record.choice !== "object" || record.choice === null || Array.isArray(record.choice)) return "invalid-choice";
  const choice = record.choice as Record<string, unknown>;
  if (Object.keys(choice).some((key) => key !== "question" && key !== "defaultOption" && key !== "alternatives")) return "invalid-choice-fields";
  if (typeof choice.question !== "string" || choice.question.trim().length === 0) return "invalid-question";
  if ([...choice.question].length > MAX_QUESTION_LENGTH) return "oversized";
  if (!Array.isArray(choice.alternatives) || choice.alternatives.length > MAX_REVIEW_OPTIONS - 1) return "invalid-option-count";

  const options = [choice.defaultOption, ...choice.alternatives];
  const ids = new Set<string>();
  for (const item of options) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return "invalid-option";
    const option = item as Record<string, unknown>;
    if (Object.keys(option).some((key) => key !== "id" && key !== "label" && key !== "submitText")) return "invalid-option-fields";
    if (typeof option.id !== "string" || option.id.length > MAX_OPTION_ID_LENGTH || !OPTION_ID_PATTERN.test(option.id)) return "invalid-option-id";
    if (option.id === RESERVED_IGNORE_OPTION_ID) return "reserved-option-id";
    if (ids.has(option.id)) return "duplicate-option-id";
    ids.add(option.id);
    if (typeof option.label !== "string" || option.label.trim().length === 0) return "invalid-option-label";
    if ([...option.label].length > MAX_LABEL_LENGTH) return "oversized";
    if (typeof option.submitText !== "string" || option.submitText.trim().length === 0) return "invalid-option-submit-text";
    if ([...option.submitText].length > MAX_MESSAGE_LENGTH) return "oversized";
    if (option.submitText === "default") return "sentinel-submit-text";
  }
  return undefined;
}

/** Validates one bounded compatibility shape emitted by older review-list producers. */
function invalidAlternateEmbeddedReviewReason(value: unknown): string | undefined {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return "invalid-shape";
  const record = value as Record<string, unknown>;
  if (record.version !== 3) return "unsupported-version";
  if (Object.keys(record).some((key) => key !== "version" && key !== "intent" && key !== "choices")) return "invalid-review-list-fields";
  if (record.intent !== "review") return "invalid-intent";
  if (!Array.isArray(record.choices) || record.choices.length < MIN_REVIEW_OPTIONS || record.choices.length > MAX_REVIEW_OPTIONS) return "invalid-option-count";

  const ids = new Set<string>();
  for (const item of record.choices) {
    if (typeof item !== "object" || item === null || Array.isArray(item)) return "invalid-option";
    const option = item as Record<string, unknown>;
    if (Object.keys(option).some((key) => key !== "id" && key !== "label" && key !== "consequence")) return "invalid-option-fields";
    if (typeof option.id !== "string" || option.id.length > MAX_OPTION_ID_LENGTH || !OPTION_ID_PATTERN.test(option.id)) return "invalid-option-id";
    if (option.id === RESERVED_IGNORE_OPTION_ID) return "reserved-option-id";
    if (ids.has(option.id)) return "duplicate-option-id";
    ids.add(option.id);
    if (typeof option.label !== "string" || option.label.trim().length === 0) return "invalid-option-label";
    if ([...option.label].length > MAX_LABEL_LENGTH) return "oversized";
    if (typeof option.consequence !== "string" || option.consequence.trim().length === 0) return "invalid-option-submit-text";
    if ([...option.consequence].length > MAX_MESSAGE_LENGTH) return "oversized";
    if (option.consequence === "default") return "sentinel-submit-text";
  }
  return undefined;
}

function toSpecification(value: unknown): CompletionChoiceSpecification {
  const record = value as { default: string; options: CompletionChoiceOption[] };
  return {
    version: 1,
    defaultOptionId: record.default,
    options: record.options.map((option) => ({ id: option.id, label: option.label, message: option.message }))
  };
}

function embeddedDecision(value: Record<string, unknown>): TraceEndReviewDecision {
  if (!("choice" in value)) return { protocolVersion: 3, intent: "none" };
  const choice = value.choice as {
    question: string;
    defaultOption: { id: string; label: string; submitText: string };
    alternatives: Array<{ id: string; label: string; submitText: string }>;
  };
  return {
    protocolVersion: 3,
    intent: "human_review",
    choice: {
      question: choice.question,
      defaultOption: { ...choice.defaultOption },
      alternatives: choice.alternatives.map((option) => ({ ...option }))
    }
  };
}

function alternateEmbeddedDecision(value: Record<string, unknown>): TraceEndReviewDecision {
  const [defaultOption, ...alternatives] = value.choices as Array<{
    id: string;
    label: string;
    consequence: string;
  }>;
  return {
    protocolVersion: 3,
    intent: "human_review",
    choice: {
      question: "请选择下一步。",
      defaultOption: { id: defaultOption!.id, label: defaultOption!.label, submitText: defaultOption!.consequence },
      alternatives: alternatives.map((option) => ({ id: option.id, label: option.label, submitText: option.consequence }))
    }
  };
}

export function choicePromptFromLegacySpecification(value: { question: string | null | undefined; defaultOptionId: string; options: CompletionChoiceOption[] }): ChoicePrompt {
  const defaultOption = value.options.find((option) => option.id === value.defaultOptionId);
  if (!defaultOption) throw new Error("Legacy completion choice has no default option");
  return {
    question: value.question ?? "请选择下一步。",
    defaultOption: { id: defaultOption.id, label: defaultOption.label, submitText: defaultOption.message },
    alternatives: value.options.filter((option) => option.id !== value.defaultOptionId).map((option) => ({
      id: option.id, label: option.label, submitText: option.message
    }))
  };
}

export function legacySpecificationFromChoicePrompt(choice: ChoicePrompt): CompletionChoiceSpecification {
  return {
    version: 1,
    question: choice.question,
    defaultOptionId: choice.defaultOption.id,
    options: [choice.defaultOption, ...choice.alternatives].map((option) => ({
      id: option.id, label: option.label, message: option.submitText
    }))
  };
}

export function inspectCompletionChoiceProtocol(
  markdown: string,
  options: { terminal: boolean }
): CompletionChoiceProtocolInspection {
  const { regions, visibleMarkdown } = scanReservedProtocol(markdown);

  if (regions.length > 1) {
    return { kind: "invalid", visibleMarkdown, reason: "multiple-blocks" };
  }

  const candidate = regions[0];
  if (!candidate) return { kind: "none", visibleMarkdown: markdown };
  if (!candidate.complete) {
    if (Buffer.byteLength(candidate.block, "utf8") > MAX_PROTOCOL_BYTES) {
      return { kind: "invalid", visibleMarkdown, reason: "oversized" };
    }
    if (options.terminal) return { kind: "invalid", visibleMarkdown, reason: "unterminated" };

    return {
      kind: "pending",
      visibleMarkdown,
      withheldMarkdown: candidate.block
    };
  }

  if (markdown.slice(candidate.end).trim().length > 0) {
    return { kind: "invalid", visibleMarkdown, reason: "nonterminal" };
  }
  if (Buffer.byteLength(candidate.block, "utf8") > MAX_PROTOCOL_BYTES) {
    return { kind: "invalid", visibleMarkdown, reason: "oversized" };
  }
  if (!options.terminal) {
    return {
      kind: "pending",
      visibleMarkdown,
      withheldMarkdown: markdown.slice(candidate.start)
    };
  }
  let value: unknown;
  try {
    value = JSON.parse(candidate.json);
  } catch {
    return { kind: "invalid", visibleMarkdown, reason: "invalid-json" };
  }

  const reason = invalidSpecificationReason(value);
  if (reason) return { kind: "invalid", visibleMarkdown, reason };

  return {
    kind: "valid",
    visibleMarkdown,
    specification: toSpecification(value)
  };
}

export function inspectTraceEndReviewProtocol(
  markdown: string,
  options: { terminal: boolean }
): TraceEndReviewProtocolInspection {
  const { regions, visibleMarkdown } = scanReservedProtocol(markdown);
  if (regions.length > 1) {
    return { kind: "invalid", visibleMarkdown, reason: "multiple-blocks" };
  }

  const candidate = regions[0];
  if (!candidate) return { kind: "none", visibleMarkdown: markdown };
  if (!candidate.complete) {
    if (Buffer.byteLength(candidate.block, "utf8") > MAX_PROTOCOL_BYTES) {
      return { kind: "invalid", visibleMarkdown, reason: "oversized" };
    }
    if (options.terminal) return { kind: "invalid", visibleMarkdown, reason: "unterminated" };
    return { kind: "pending", visibleMarkdown, withheldMarkdown: candidate.block };
  }

  if (markdown.slice(candidate.end).trim().length > 0) return { kind: "invalid", visibleMarkdown, reason: "nonterminal" };
  if (Buffer.byteLength(candidate.block, "utf8") > MAX_PROTOCOL_BYTES) return { kind: "invalid", visibleMarkdown, reason: "oversized" };
  if (!options.terminal) return { kind: "pending", visibleMarkdown, withheldMarkdown: markdown.slice(candidate.start) };

  let value: unknown;
  try { value = JSON.parse(candidate.json); }
  catch { return { kind: "invalid", visibleMarkdown, reason: "invalid-json" }; }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    return { kind: "invalid", visibleMarkdown, reason: "invalid-shape" };
  }
  const record = value as Record<string, unknown>;
  if (record.version === 3) {
    const reason = invalidEmbeddedReviewSpecificationReason(value);
    if (!reason) return { kind: "valid", visibleMarkdown, decision: embeddedDecision(record) };
    if (record.intent === "review" || "choices" in record) {
      const alternateReason = invalidAlternateEmbeddedReviewReason(value);
      if (!alternateReason) return { kind: "valid", visibleMarkdown, decision: alternateEmbeddedDecision(record) };
      return { kind: "invalid", visibleMarkdown, reason: alternateReason };
    }
    return { kind: "invalid", visibleMarkdown, reason };
  }
  if (record.version === 1) {
    const reason = invalidSpecificationReason(value);
    if (reason) return { kind: "invalid", visibleMarkdown, reason };
    const specification = toSpecification(value);
    return {
      kind: "valid",
      visibleMarkdown,
      decision: {
        protocolVersion: 1,
        intent: "human_review",
        choice: choicePromptFromLegacySpecification({ question: null, ...specification })
      }
    };
  }
  const reason = invalidReviewSpecificationReason(value);
  if (reason) return { kind: "invalid", visibleMarkdown, reason };
  if (record.intent === "none") return { kind: "valid", visibleMarkdown, decision: { protocolVersion: 2, intent: "none" } };
  return {
    kind: "valid",
    visibleMarkdown,
    decision: {
      protocolVersion: 2,
      intent: "human_review",
      choice: choicePromptFromLegacySpecification({
        question: record.question as string,
        defaultOptionId: record.default as string,
        options: (record.options as CompletionChoiceOption[]).map((option) => ({ id: option.id, label: option.label, message: option.message }))
      })
    }
  };
}

export function selectCompletionChoiceTerminalAnswer(finalAnswer: string | undefined, accumulatedAnswer: string): string {
  if (!finalAnswer) return sanitizeCompletionChoiceMarkdown(accumulatedAnswer);
  const legacyTail = stripLegacyChoiceInvocationTail(finalAnswer);
  if (legacyTail !== finalAnswer) {
    if (!legacyTail) return sanitizeCompletionChoiceMarkdown(accumulatedAnswer);
    finalAnswer = legacyTail;
  }
  const inspected = inspectTraceEndReviewProtocol(finalAnswer, { terminal: true });
  if ((inspected.kind === "valid" || inspected.kind === "invalid") && inspected.visibleMarkdown.length === 0 && accumulatedAnswer) return sanitizeCompletionChoiceMarkdown(accumulatedAnswer);
  if (inspected.kind === "valid" || inspected.kind === "invalid") return inspected.visibleMarkdown;
  return finalAnswer;
}

function stripLegacyChoiceInvocationTail(markdown: string): string {
  const match = markdown.match(/(?:^|\r?\n)[ \t]*\$herdr-choice-list:herdr-choice-list[ \t]*\r?\n[ \t]*(\{[\s\S]*\})[ \t]*$/);
  if (!match || match.index === undefined) return markdown;
  try {
    const value = JSON.parse(match[1]!) as unknown;
    if (typeof value !== "object" || value === null || Array.isArray(value)
      || typeof (value as Record<string, unknown>).intent !== "string") return markdown;
  } catch { return markdown; }
  return markdown.slice(0, match.index).trimEnd();
}

export function selectCompletionChoiceTerminalInput(finalAnswer: string | undefined, accumulatedAnswer: string): string {
  if (!finalAnswer) return accumulatedAnswer;
  const legacyTail = stripLegacyChoiceInvocationTail(finalAnswer);
  if (legacyTail !== finalAnswer) {
    if (!legacyTail) return accumulatedAnswer;
    finalAnswer = legacyTail;
  }
  const inspected = inspectTraceEndReviewProtocol(finalAnswer, { terminal: true });
  if (inspected.kind === "none" && accumulatedAnswer) {
    const accumulatedInspection = inspectTraceEndReviewProtocol(accumulatedAnswer, { terminal: true });
    if (accumulatedInspection.kind === "valid" && accumulatedInspection.visibleMarkdown === finalAnswer.trimEnd()) return accumulatedAnswer;
  }
  if ((inspected.kind === "valid" || inspected.kind === "invalid") && inspected.visibleMarkdown.length === 0 && accumulatedAnswer) {
    const accumulatedInspection = inspectTraceEndReviewProtocol(accumulatedAnswer, { terminal: true });
    if (inspected.kind === "valid" && accumulatedInspection.kind === "valid") return accumulatedAnswer;
    const visibleAccumulated = sanitizeCompletionChoiceMarkdown(accumulatedAnswer);
    return visibleAccumulated ? `${visibleAccumulated.trimEnd()}\n\n${finalAnswer}` : finalAnswer;
  }
  return finalAnswer;
}
