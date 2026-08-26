import type { ProgressEventKind, ProgressEventState } from "../domain/run-card-view.js";
import type { AgentState } from "../domain/types.js";
import { stripTerminalControl } from "./output.js";
import { findNativeTaskFrame } from "./native-task-frame.js";
import { normalizeLarkPreview } from "./lark-markdown.js";
import { deriveTerminalContinuation, parseTraexTerminalBlocks, renderTraexTerminalBlocks } from "./traex-terminal-blocks.js";

interface ParsedProgressEvent { key: string; kind: ProgressEventKind; label: string; state: ProgressEventState }
interface ParsedTraexOutput {
  answerSnapshot: string;
  previousAnswerSnapshot: string;
  answerUpdate: "append" | "replace" | "replace-status";
  progressEvents: ParsedProgressEvent[];
  hasProgressSnapshot: boolean;
}

const UNSAFE = /<\/?(?:think|reasoning)>|authorization\s*[:=]|bearer\s+[a-z0-9._-]+|private[ _-]?key|\$(?:token|secret|password)|"(?:command|arguments|tool_call)"\s*:/i;
const REASONING_BLOCK = /\n?<(?:think|reasoning)>[\s\S]*?(?:<\/(?:think|reasoning)>|$)\n?/gi;
const MAX_TERMINAL_DELTA_CHARS = 12_000;
const MIN_RELIABLE_TERMINAL_OVERLAP = 64;
const LIVE_WINDOW_NOTICE = "较早的实时输出已省略，以下为最新状态。";

interface ParsedTerminalStreamDelta { delta: string; snapshot: string; update: "append" | "replace-all"; model?: string; context?: string }

/** True when TraeX is visibly waiting at its composer despite missing structured agent state. */
export function isTraexComposerReady(output: string): boolean {
  return hasTraexComposerReady(stripTerminalControl(output).split("\n"));
}

/** Infer state only from strong markers near the live end of a TraeX terminal. */
export function inferTraexAgentState(output: string): AgentState {
  const tail = stripTerminalControl(output).split("\n").slice(-12);
  if (hasTraexComposerReady(tail)) return "idle";
  const tailText = tail.join("\n");
  if (/(?:Approve (?:command|action)?|approval required|waiting for (?:approval|user))/i.test(tailText)) return "blocked";
  if (/[✧◆]\s*Work(?:ing|i…)|\bAuto Mode\b.*\bactive turn\b/iu.test(tailText)) return "working";
  return "unknown";
}

function hasTraexComposerReady(lines: readonly string[]): boolean {
  for (let index = lines.length - 1, seen = 0; index >= 0 && seen < 8; index -= 1, seen += 1) {
    if (/^\s*[❯›](?:\s+\S.*)?$/u.test(lines[index]!)) return true;
  }
  return false;
}

/** Convert two Herdr terminal snapshots into a safe append or active-window replacement. */
export function parseTerminalStreamDelta(previousRaw: string, currentRaw: string, promptEcho: string): ParsedTerminalStreamDelta {
  const previous = stripTerminalControl(previousRaw);
  const current = stripTerminalControl(currentRaw);
  if (current === previous) return { delta: "", snapshot: currentRaw, update: "append", ...extractTraexTelemetry(current) };

  const overlap = terminalDelta(previous, current, promptEcho);
  let update: ParsedTerminalStreamDelta["update"] = previous && overlap.fullSnapshot ? "replace-all" : "append";
  const visible = redactTerminalSecrets(
    renderTraexTerminalBlocks(parseTraexTerminalBlocks(
      cleanTerminalForBlockParsing(overlap.value, promptEcho),
      deriveTerminalContinuation(previous)
    ))
      .replace(REASONING_BLOCK, "\n")
      .split("\n")
      .filter((line) => line.trim() !== promptEcho.trim() && !/^\s*[─━-]{3,}\s*$/.test(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
  const delta = visible.length <= MAX_TERMINAL_DELTA_CHARS
    ? visible
    : newestTerminalWindow(visible);
  if (visible.length > MAX_TERMINAL_DELTA_CHARS) update = "replace-all";
  return { delta, snapshot: currentRaw, update, ...extractTraexTelemetry(current) };
}

function extractTraexTelemetry(source: string): { model?: string; context?: string } {
  const lines = lastTerminalLines(source, 40);
  let model: string | undefined;
  let context: string | undefined;
  for (const line of lines) {
    const clean = line.replace(/\x1b\[[0-?]*[ -\/]*[@-~]/g, "").trim();
    const namedModel = /(?:^|\b)(?:model\s*[:=]\s*)?((?:GPT|Claude|Gemini|DeepSeek|Seed|Qwen|Llama|o\d)[A-Za-z0-9._-]*(?:\s+[A-Za-z0-9._-]+){0,2})(?=\s*(?:[·|]|Auto Mode|context|$))/i.exec(clean);
    if (namedModel) model = namedModel[1]!.trim();
    const usage = /(?:↓\s*)?(\d+(?:\.\d+)?\s*[KMG]?)\s+tokens?\b/i.exec(clean);
    const window = /(\d+(?:\.\d+)?\s*[KMG]?)\s+context(?:\s+window)?\b/i.exec(clean);
    if (usage) context = `${usage[1]!.replace(/\s+/g, "")} tokens`;
    else if (window) context = `${window[1]!.replace(/\s+/g, "")} context`;
  }
  return { ...(model ? { model } : {}), ...(context ? { context } : {}) };
}

function lastTerminalLines(source: string, count: number): string[] {
  let start = source.length;
  for (let seen = 0; seen < count && start > 0; seen += 1) {
    const newline = source.lastIndexOf("\n", start - 1);
    if (newline < 0) { start = 0; break; }
    start = newline;
  }
  return source.slice(start === 0 ? 0 : start + 1).split("\n");
}

function newestTerminalWindow(value: string): string {
  const prefix = `${LIVE_WINDOW_NOTICE}\n\n`;
  const tail = value.slice(-(MAX_TERMINAL_DELTA_CHARS - prefix.length)).trimStart();
  return `${prefix}${tail}`;
}

function terminalDelta(previous: string, current: string, promptEcho: string): { value: string; fullSnapshot: boolean } {
  if (current.startsWith(previous)) return { value: current.slice(previous.length).replace(/^\n/, ""), fullSnapshot: false };
  const limit = Math.min(previous.length, current.length);
  const overlap = longestTerminalOverlap(previous, current);
  if (overlap >= Math.min(MIN_RELIABLE_TERMINAL_OVERLAP, limit) && (limit >= MIN_RELIABLE_TERMINAL_OVERLAP || overlap === limit)) {
    return { value: current.slice(overlap).replace(/^\n/, ""), fullSnapshot: false };
  }
  const afterPrompt = outputAfterPromptEcho(current, promptEcho);
  const value = afterPrompt || (/^\s*(?:◆|✧|╭)/mu.test(current) ? current : "");
  return { value, fullSnapshot: true };
}

/** Longest prefix of current that is also a suffix of previous, in linear time. */
function longestTerminalOverlap(previous: string, current: string): number {
  if (!previous || !current) return 0;
  const prefix = new Uint32Array(current.length);
  for (let index = 1, matched = 0; index < current.length; index += 1) {
    while (matched > 0 && current[index] !== current[matched]) matched = prefix[matched - 1]!;
    if (current[index] === current[matched]) matched += 1;
    prefix[index] = matched;
  }

  let matched = 0;
  for (let index = 0; index < previous.length; index += 1) {
    while (matched > 0 && previous[index] !== current[matched]) matched = prefix[matched - 1]!;
    if (previous[index] === current[matched]) matched += 1;
    if (matched === current.length && index + 1 < previous.length) matched = prefix[matched - 1]!;
  }
  return matched;
}

function outputAfterPromptEcho(current: string, promptEcho: string): string {
  const prompt = promptEcho.trim();
  if (!prompt) return "";
  const lines = current.split("\n");
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    const line = lines[index]!.trim().replace(/^[›❯▍]\s*/, "");
    if (line === prompt) return lines.slice(index + 1).join("\n");
  }
  return "";
}

function cleanTerminalForBlockParsing(source: string, promptEcho: string): string {
  const withoutBanner = stripTraeCodeBanner(source);
  const lines = withoutBanner.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const composer = /^\s*▍\s?(.*)$/.exec(lines[index]!);
    if (composer) {
      const parts: string[] = [];
      while (index < lines.length) {
        const part = /^\s*▍\s?(.*)$/.exec(lines[index]!);
        if (!part) break;
        parts.push(part[1]!);
        index += 1;
      }
      if (compact(parts.join("")) !== compact(promptEcho)) output.push(parts.join(""));
      continue;
    }
    const line = lines[index]!;
    if (isSubagentConsoleLine(line)) { index += 1; continue; }
    if (isTerminalChrome(line)) { index += 1; continue; }
    if (/^\s*◆\s+/.test(line)) {
      if (/^\s*◆\s+(?:Edited|Ran)\b/u.test(line)) { output.push(line); index += 1; continue; }
      if (index + 1 < lines.length && isToolHeadingContinuation(lines[index + 1]!)) {
        const heading = [line];
        index += 1;
        while (index < lines.length && isToolHeadingContinuation(lines[index]!)) heading.push(lines[index++]!);
        output.push(joinToolHeading(heading));
        continue;
      }
      const block = [line];
      index += 1;
      while (index < lines.length && isWrappedAnswerContinuation(lines[index]!)) block.push(lines[index++]!);
      output.push(normalizeLarkPreview(block.join("\n")));
      continue;
    }
    output.push(line);
    index += 1;
  }
  return output.join("\n");
}

/** Remove TraeX's orchestration UI; it is not part of the agent's answer. */
function isSubagentConsoleLine(line: string): boolean {
  const trimmed = line.trim();
  return /^(?:\d+\s+agents?\s+running\b)/iu.test(trimmed)
    || /^(?:↓\s+to\s+select\s+agents|…\s*\+\d+\s+completed)$/u.test(trimmed)
    || /^\s*[●○]\s+[^\n]+\[(?:default|subagent|worker|explorer|reviewer|plan)\]\s+(?:running|idle|done|blocked)\b[^\n]*$/iu.test(line);
}

export function stripTraexConsoleStatus(source: string): string {
  return source.replace(/\r\n?/g, "\n").split("\n").filter((line) => !isSubagentConsoleLine(line)).join("\n").trim();
}

function isToolHeadingContinuation(line: string): boolean {
  return /^\s*│/.test(line);
}

function joinToolHeading(lines: string[]): string {
  return lines[0]! + lines.slice(1).map((line) => line.replace(/^\s*│ ?/, "")).join("");
}

function stripTraeCodeBanner(source: string): string {
  const lines = source.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    if (!/^\s*╭[─-]+╮\s*$/.test(lines[index]!)) {
      output.push(lines[index++]!);
      continue;
    }

    const box: string[] = [];
    let containsTraeCode = false;
    while (index < lines.length) {
      const line = lines[index++]!;
      box.push(line);
      containsTraeCode ||= /TraeCode CLI/.test(line);
      if (/^\s*╰[─-]+╯\s*$/.test(line)) break;
    }
    if (!containsTraeCode || !/^\s*╰[─-]+╯\s*$/.test(box.at(-1)!)) output.push(...box);
  }
  return output.join("\n");
}

function isWrappedAnswerContinuation(line: string): boolean {
  const trimmed = line.trim();
  return Boolean(trimmed) && !isSubagentConsoleLine(line) && !/^(?:[◆•✧✦◇◈⋄❯›>]|[│└├])\s*/u.test(trimmed) && !/^\s*[─━-]{3,}\s*$/.test(line) && !/^GPT-[^\n]*Auto Mode/i.test(trimmed);
}

function isTerminalChrome(line: string): boolean {
  const trimmed = line.trim();
  return /^\[terminal snapshot boundary\]$/.test(trimmed) || /^❯\s*(?:Use \/|$)/u.test(trimmed) || /^GPT-[^\n]*Auto Mode/i.test(trimmed);
}

function compact(value: string): string {
  return value.replace(/\s+/gu, "");
}

function redactTerminalSecrets(value: string): string {
  return value
    .replace(/((?:proxy-)?authorization\s*[:=]\s*(?:bearer\s+)?)([^\s'";,}]+)/gi, "$1[REDACTED]")
    .replace(/(bearer\s+)([a-z0-9._~+\/-]+)/gi, "$1[REDACTED]")
    .replace(/((?:access[_-]?token|api[_-]?key|token|secret|password)\s*[=:]\s*["']?)([^\s"'&,;}]+)/gi, "$1[REDACTED]")
    .replace(/([?&](?:access_token|api_key|token|secret|password)=)[^&#\s]+/gi, "$1[REDACTED]")
    .replace(/-----BEGIN (?:[A-Z ]+ )?PRIVATE KEY-----[\s\S]*?-----END (?:[A-Z ]+ )?PRIVATE KEY-----/gi, "[REDACTED PRIVATE KEY]");
}
export function parseTraexOutput(previousRaw: string, currentRaw: string, _workspaceRoot: string): ParsedTraexOutput {
  const previous = stripTerminalControl(previousRaw).trim();
  const current = stripTerminalControl(currentRaw).trim();
  const rawDelta = current.startsWith(previous) ? current.slice(previous.length) : current;
  if (UNSAFE.test(rawDelta)) return { answerSnapshot: "", previousAnswerSnapshot: "", answerUpdate: "replace", progressEvents: [], hasProgressSnapshot: false };
  const previousAnswer = safeAnswer(stripTraexConsoleStatus(visibleAnswer(previous)));
  const currentAnswer = visibleAnswer(current);
  const progress = nativeProgress(currentAnswer);
  const unchangedPriorAnswer = current.startsWith(previous) && !/^\s*◆\s+/m.test(rawDelta) && currentAnswer === previousAnswer;
  const answerSnapshot = unchangedPriorAnswer ? "" : safeAnswer(stripTraexConsoleStatus(currentAnswer));
  const appendedBlock = Boolean(previousAnswer) && current.startsWith(previous) && /^\s*◆\s+/m.test(rawDelta);
  return {
    answerSnapshot, previousAnswerSnapshot: previousAnswer,
    answerUpdate: progress.found ? "replace-status" : appendedBlock ? "append" : "replace",
    progressEvents: progress.steps, hasProgressSnapshot: progress.found
  };
}

export function extractFinalTraexAnswer(output: string): string { return safeAnswer(stripTraexConsoleStatus(visibleAnswer(stripTerminalControl(output)))).trim(); }

function visibleAnswer(output: string): string { return extractAnswer(output).trimEnd(); }

function nativeProgress(answer: string): { found: boolean; steps: ParsedProgressEvent[] } {
  const frame = findNativeTaskFrame(answer);
  return frame ? { found: true, steps: frame.steps.map((step) => ({ ...step, kind: "step" })) } : { found: false, steps: [] };
}

function extractAnswer(output: string): string {
  const markerPattern = /^\s*◆\s+/gm;
  let marker: RegExpExecArray | null = null;
  for (let match = markerPattern.exec(output); match; match = markerPattern.exec(output)) marker = match;
  if (!marker || marker.index === undefined) return "";
  const answerStart = marker.index + marker[0].length;
  const separator = /\n\s*─{3,}/g;
  separator.lastIndex = answerStart;
  const answerEnd = separator.exec(output)?.index ?? output.length;
  return output.slice(answerStart, answerEnd).trimEnd();
}

function safeAnswer(value: string): string { return !value || UNSAFE.test(value) ? "" : value; }
