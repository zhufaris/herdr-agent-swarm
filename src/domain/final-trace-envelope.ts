import { inspectTraceEndReviewProtocol, type ChoicePrompt, type TraceEndReviewDecision } from "./completion-choice.js";
import { projectFinalRequestMention, type FinalRequestMentionProjection } from "./final-request-mention.js";

const CHOICE_INVOCATION = "$herdr-choice-list:herdr-choice-list";

export type FinalTraceChoiceInspection =
  | { kind: "none" }
  | { kind: "invalid"; reason: string }
  | { kind: "valid"; decision: TraceEndReviewDecision };

export interface NormalizedFinalTraceEnvelope {
  projectionMarkdown: string;
  presentationMarkdown: string;
  requesterSyntax: FinalRequestMentionProjection;
  compatibilityChoice: FinalTraceChoiceInspection;
}

export interface FinalTraceChoiceEvidence {
  order: number;
  text: string;
  truncated?: boolean;
}

export type FoldedFinalTraceChoice =
  | { decision: "selected"; choice: ChoicePrompt }
  | { decision: "explicit-none" }
  | { decision: "none" };

export function normalizeFinalTraceEnvelope(input: {
  finalMarkdown?: string;
  accumulatedMarkdown?: string;
}): NormalizedFinalTraceEnvelope {
  const markdown = input.finalMarkdown ?? input.accumulatedMarkdown ?? "";
  const terminalCitation = extractTerminalMemoryCitation(markdown);
  const markdownWithoutCitation = terminalCitation?.prefix ?? markdown;
  const normalizedMarkdownWithoutCitation = markdownWithoutCitation.replace(/\r\n?/g, "\n");
  const inspected = inspectTraceEndReviewProtocol(normalizedMarkdownWithoutCitation, { terminal: true });
  const choice = inspected.kind === "valid"
    ? { kind: "valid", decision: inspected.decision } as const
    : inspected.kind === "invalid"
      ? { kind: "invalid", reason: inspected.reason } as const
    : { kind: "none" } as const;
  const withoutChoice = inspected.kind === "valid" ? inspected.visibleMarkdown : normalizedMarkdownWithoutCitation;
  const withoutInvocation = inspected.kind === "valid" || inspected.kind === "invalid"
    ? removeAssociatedChoiceInvocation(withoutChoice, normalizedMarkdownWithoutCitation)
    : removeTerminalChoiceInvocationTail(withoutChoice);
  const requesterSyntax = inspected.kind === "invalid"
    ? projectFinalRequestMention(withoutInvocation, { preserveReservedRegions: true, allowTrailingChoiceBlock: true })
    : projectFinalRequestMention(withoutInvocation);
  const projectionMarkdown = appendTerminalCitation(requesterSyntax.markdown, terminalCitation?.citation);

  return {
    projectionMarkdown,
    presentationMarkdown: requesterSyntax.markdown.trimEnd(),
    requesterSyntax,
    compatibilityChoice: choice
  };
}

/** Folds canonical Core-lane text evidence without participating in native metadata precedence. */
export function foldFinalTraceChoiceEvidence(evidence: readonly FinalTraceChoiceEvidence[]): FoldedFinalTraceChoice {
  const duplicateOrders = new Set<number>();
  const seenOrders = new Set<number>();
  for (const item of evidence) {
    if (!Number.isSafeInteger(item.order)) continue;
    if (seenOrders.has(item.order)) duplicateOrders.add(item.order);
    seenOrders.add(item.order);
  }

  let result: FoldedFinalTraceChoice = { decision: "none" };
  for (const item of evidence
    .map((value, index) => ({ value, index }))
    .sort((left, right) => left.value.order - right.value.order || left.index - right.index)) {
    if (item.value.truncated || !Number.isSafeInteger(item.value.order) || duplicateOrders.has(item.value.order)) continue;
    const choice = normalizeFinalTraceEnvelope({ finalMarkdown: item.value.text }).compatibilityChoice;
    if (choice.kind !== "valid" || choice.decision.protocolVersion === 1) continue;
    result = choice.decision.intent === "none"
      ? { decision: "explicit-none" }
      : { decision: "selected", choice: choice.decision.choice };
  }
  return result;
}

interface TerminalMemoryCitation {
  prefix: string;
  citation: string;
}

/** Finds one complete terminal citation outside Markdown code; duplicate citations are ordinary visible text. */
function extractTerminalMemoryCitation(markdown: string): TerminalMemoryCitation | undefined {
  const lines = scanMarkdownLines(markdown);
  const citations: Array<{ start: number; end: number }> = [];
  let fence: { marker: "`" | "~"; length: number } | undefined;

  for (let index = 0; index < lines.length; index += 1) {
    const line = lines[index]!;
    if (fence) {
      if (closesMarkdownFence(line.text, fence)) fence = undefined;
      continue;
    }
    const opener = markdownFenceOpener(line.text);
    if (opener) {
      fence = opener;
      continue;
    }
    if (!markdown.startsWith("<oai-mem-citation>", line.start)) continue;
    const parsed = parseTerminalCitation(markdown, line.start);
    if (!parsed) continue;
    citations.push(parsed);
    while (index + 1 < lines.length && lines[index + 1]!.start < parsed.end) index += 1;
  }

  if (citations.length !== 1) return undefined;
  const citation = citations[0]!;
  if (markdown.slice(citation.end).trim().length > 0) return undefined;
  return {
    prefix: markdown.slice(0, citation.start),
    citation: markdown.slice(citation.start, citation.end)
  };
}

function removeAssociatedChoiceInvocation(markdown: string, originalMarkdown: string): string {
  const range = findAssociatedChoiceInvocationRange(originalMarkdown);
  if (!range) return markdown.trimEnd();
  return `${markdown.slice(0, range.start)}${markdown.slice(range.end)}`.trimEnd();
}

function removeTerminalChoiceInvocationTail(markdown: string): string {
  const range = findTerminalChoiceInvocationTailRange(markdown);
  if (!range) return markdown.trimEnd();
  return markdown.slice(0, range.start).trimEnd();
}

function appendTerminalCitation(markdown: string, citation: string | undefined): string {
  if (!citation) return markdown.trimEnd();
  const visible = markdown.trimEnd();
  return visible ? `${visible}\n\n${citation}` : citation;
}

interface MarkdownLine {
  start: number;
  end: number;
  next: number;
  text: string;
}

function scanMarkdownLines(markdown: string): MarkdownLine[] {
  const lines: MarkdownLine[] = [];
  let start = 0;
  while (start < markdown.length) {
    let end = start;
    while (end < markdown.length && markdown[end] !== "\n" && markdown[end] !== "\r") end += 1;
    let next = end;
    if (next < markdown.length && markdown[next] === "\r") next += markdown[next + 1] === "\n" ? 2 : 1;
    else if (next < markdown.length && markdown[next] === "\n") next += 1;
    lines.push({ start, end, next, text: markdown.slice(start, end) });
    start = next;
  }
  if (markdown.length === 0) lines.push({ start: 0, end: 0, next: 0, text: "" });
  return lines;
}

function markdownFenceOpener(line: string): { marker: "`" | "~"; length: number } | undefined {
  const match = /^ {0,3}(`{3,}|~{3,})(.*)$/.exec(line);
  if (!match || (match[1]![0] === "`" && match[2]!.includes("`"))) return undefined;
  return { marker: match[1]![0] as "`" | "~", length: match[1]!.length };
}

function closesMarkdownFence(line: string, fence: { marker: "`" | "~"; length: number }): boolean {
  return new RegExp(`^ {0,3}${fence.marker}{${fence.length},}[ \\t]*$`).test(line);
}

function parseTerminalCitation(markdown: string, start: number): { start: number; end: number } | undefined {
  let cursor = start;
  cursor = parseLiteral(markdown, cursor, "<oai-mem-citation>");
  if (cursor < 0) return undefined;
  cursor = skipCitationWhitespace(markdown, cursor);
  cursor = parseSection(markdown, cursor, "citation_entries");
  if (cursor < 0) return undefined;
  cursor = skipCitationWhitespace(markdown, cursor);
  cursor = parseSection(markdown, cursor, "rollout_ids");
  if (cursor < 0) return undefined;
  cursor = skipCitationWhitespace(markdown, cursor);
  cursor = parseLiteral(markdown, cursor, "</oai-mem-citation>");
  return cursor < 0 ? undefined : { start, end: cursor };
}

function parseSection(markdown: string, start: number, name: "citation_entries" | "rollout_ids"): number {
  let cursor = parseLiteral(markdown, start, `<${name}>`);
  if (cursor < 0) return -1;
  while (cursor < markdown.length) {
    if (markdown.startsWith(`</${name}>`, cursor)) return cursor + name.length + 3;
    if (markdown[cursor] === "<" || markdown[cursor] === ">") return -1;
    cursor += 1;
  }
  return -1;
}

function parseLiteral(markdown: string, start: number, literal: string): number {
  return markdown.startsWith(literal, start) ? start + literal.length : -1;
}

function skipCitationWhitespace(markdown: string, start: number): number {
  let cursor = start;
  while (cursor < markdown.length && /\s/.test(markdown[cursor]!)) cursor += 1;
  return cursor;
}

function findAssociatedChoiceInvocationRange(markdown: string): { start: number; end: number } | undefined {
  const lines = scanMarkdownLines(markdown);
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let pending: { start: number; end: number } | undefined;
  let associated: { start: number; end: number } | undefined;

  for (const line of lines) {
    if (fence) {
      if (closesMarkdownFence(line.text, fence)) fence = undefined;
      continue;
    }

    if (isChoiceFenceLine(line.text)) {
      if (pending) associated = pending;
      fence = { marker: "`", length: 3 };
      pending = undefined;
      continue;
    }

    const opener = markdownFenceOpener(line.text);
    if (opener) {
      fence = opener;
      pending = undefined;
      continue;
    }

    if (line.text.trim().length === 0) continue;
    if (isStandaloneChoiceInvocationLine(line.text)) {
      pending = { start: line.start, end: line.next };
      continue;
    }
    pending = undefined;
  }
  return associated;
}

function findTerminalChoiceInvocationTailRange(markdown: string): { start: number; end: number } | undefined {
  const lines = scanMarkdownLines(markdown);
  let fence: { marker: "`" | "~"; length: number } | undefined;
  let candidate: { start: number; end: number } | undefined;
  let terminalInvocation = false;

  for (const line of lines) {
    if (fence) {
      if (closesMarkdownFence(line.text, fence)) fence = undefined;
      continue;
    }

    const opener = markdownFenceOpener(line.text);
    if (opener) {
      fence = opener;
      terminalInvocation = false;
      continue;
    }

    if (line.text.trim().length === 0) continue;
    if (isStandaloneChoiceInvocationLine(line.text)) {
      candidate = { start: line.start, end: line.next };
      terminalInvocation = true;
      continue;
    }
    terminalInvocation = false;
  }

  return terminalInvocation ? candidate : undefined;
}

function isStandaloneChoiceInvocationLine(line: string): boolean {
  return line.trim() === CHOICE_INVOCATION;
}

function isChoiceFenceLine(line: string): boolean {
  return line === "```herdr-choice-list";
}
