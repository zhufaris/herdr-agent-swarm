import type { ProgressEventKind, ProgressEventState } from "../domain/run-card-view.js";
import type { AgentState } from "../domain/types.js";
import { stripTerminalControl } from "./output.js";
import { findNativeTaskFrame } from "./native-task-frame.js";
import { normalizeLarkPreview } from "./lark-markdown.js";

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

interface ParsedTerminalStreamDelta { delta: string; snapshot: string; update: "append" | "replace-all" }

/** True when TraeX is visibly waiting at its composer despite missing structured agent state. */
export function isTraexComposerReady(output: string): boolean {
  const lines = stripTerminalControl(output).replace(/\r/g, "").split("\n");
  return lines.slice(-8).some((line) => /^\s*[❯›](?:\s+\S.*)?$/u.test(line));
}

/** Infer state only from strong markers near the live end of a TraeX terminal. */
export function inferTraexAgentState(output: string): AgentState {
  const tail = stripTerminalControl(output).replace(/\r/g, "").split("\n").slice(-12).join("\n");
  if (isTraexComposerReady(tail)) return "idle";
  if (/(?:Approve (?:command|action)?|approval required|waiting for (?:approval|user))/i.test(tail)) return "blocked";
  if (/[✧◆]\s*Work(?:ing|i…)|\bAuto Mode\b.*\bactive turn\b/iu.test(tail)) return "working";
  return "unknown";
}

/** Convert two Herdr terminal snapshots into a safe append or active-window replacement. */
export function parseTerminalStreamDelta(previousRaw: string, currentRaw: string, promptEcho: string): ParsedTerminalStreamDelta {
  const previous = stripTerminalControl(previousRaw).replace(/\r/g, "");
  const current = stripTerminalControl(currentRaw).replace(/\r/g, "");
  if (current === previous) return { delta: "", snapshot: currentRaw, update: "append" };

  const overlap = terminalDelta(previous, current, promptEcho);
  let update: ParsedTerminalStreamDelta["update"] = previous && overlap.fullSnapshot ? "replace-all" : "append";
  const visible = redactTerminalSecrets(
    normalizeTerminalForLark(overlap.value, promptEcho)
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
  return { delta, snapshot: currentRaw, update };
}

function newestTerminalWindow(value: string): string {
  const prefix = `${LIVE_WINDOW_NOTICE}\n\n`;
  const tail = value.slice(-(MAX_TERMINAL_DELTA_CHARS - prefix.length)).trimStart();
  return `${prefix}${tail}`;
}

function terminalDelta(previous: string, current: string, promptEcho: string): { value: string; fullSnapshot: boolean } {
  if (current.startsWith(previous)) return { value: current.slice(previous.length).replace(/^\n/, ""), fullSnapshot: false };
  const limit = Math.min(previous.length, current.length);
  for (let size = limit; size >= Math.min(MIN_RELIABLE_TERMINAL_OVERLAP, limit); size -= 1) {
    if (previous.endsWith(current.slice(0, size))) return { value: current.slice(size).replace(/^\n/, ""), fullSnapshot: false };
  }
  const afterPrompt = outputAfterPromptEcho(current, promptEcho);
  const value = afterPrompt || (/^\s*(?:◆|✧|╭)/mu.test(current) ? current : "");
  return { value, fullSnapshot: true };
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

function normalizeTerminalForLark(source: string, promptEcho: string): string {
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
    if (isTerminalChrome(line)) { index += 1; continue; }
    if (/^\s*◆\s+/.test(line)) {
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
    if (/^\s*╭[─-]+╮\s*$/.test(lines[index]!)) {
      const end = lines.findIndex((line, candidate) => candidate >= index && /^\s*╰[─-]+╯\s*$/.test(line));
      if (end >= index && lines.slice(index, end + 1).some((line) => /TraeCode CLI/.test(line))) { index = end + 1; continue; }
    }
    output.push(lines[index++]!);
  }
  return output.join("\n");
}

function isWrappedAnswerContinuation(line: string): boolean {
  const trimmed = line.trim();
  return Boolean(trimmed) && !/^(?:[◆•✧✦◇◈⋄❯›>]|[│└├])\s*/u.test(trimmed) && !/^\s*[─━-]{3,}\s*$/.test(line) && !/^GPT-[^\n]*Auto Mode/i.test(trimmed);
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
  const previousAnswer = safeAnswer(visibleAnswer(previous));
  const currentAnswer = visibleAnswer(current);
  const progress = nativeProgress(currentAnswer);
  const unchangedPriorAnswer = current.startsWith(previous) && !/^\s*◆\s+/m.test(rawDelta) && currentAnswer === previousAnswer;
  const answerSnapshot = unchangedPriorAnswer ? "" : safeAnswer(currentAnswer);
  const appendedBlock = Boolean(previousAnswer) && current.startsWith(previous) && /^\s*◆\s+/m.test(rawDelta);
  return {
    answerSnapshot, previousAnswerSnapshot: previousAnswer,
    answerUpdate: isNativeStatusFrame(answerSnapshot) ? "replace-status" : appendedBlock ? "append" : "replace",
    progressEvents: progress.steps, hasProgressSnapshot: progress.found
  };
}

export function extractFinalTraexAnswer(output: string): string { return safeAnswer(visibleAnswer(stripTerminalControl(output))).trim(); }

function visibleAnswer(output: string): string { return extractAnswer(output).trimEnd(); }

function nativeProgress(answer: string): { found: boolean; steps: ParsedProgressEvent[] } {
  const frame = findNativeTaskFrame(answer);
  return frame ? { found: true, steps: frame.steps.map((step) => ({ ...step, kind: "step" })) } : { found: false, steps: [] };
}

function extractAnswer(output: string): string {
  const matches = [...output.matchAll(/^\s*◆\s+/gm)];
  const marker = matches.at(-1);
  if (!marker || marker.index === undefined) return "";
  return output.slice(marker.index + marker[0].length).split(/\n\s*─{3,}/)[0]?.trimEnd() ?? "";
}

function safeAnswer(value: string): string { return !value || UNSAFE.test(value) ? "" : value; }
function isNativeStatusFrame(value: string): boolean {
  return findNativeTaskFrame(value) !== null;
}
