import type { ProgressEventKind, ProgressEventState } from "../domain/run-card-view.js";
import type { AgentState } from "../domain/types.js";
import { stripTerminalControl } from "./output.js";
import { findNativeTaskFrame } from "./native-task-frame.js";

export interface ParsedProgressEvent { key: string; kind: ProgressEventKind; label: string; state: ProgressEventState }
export interface ParsedTraexOutput {
  answerSnapshot: string;
  previousAnswerSnapshot: string;
  answerUpdate: "append" | "replace" | "replace-status";
  progressEvents: ParsedProgressEvent[];
  hasProgressSnapshot: boolean;
}

const UNSAFE = /<\/?(?:think|reasoning)>|authorization\s*[:=]|bearer\s+[a-z0-9._-]+|private[ _-]?key|\$(?:token|secret|password)|"(?:command|arguments|tool_call)"\s*:/i;
const PROGRESS_BLOCK = /\n?<herdr_progress>\s*([\s\S]*?)(?:<\/herdr_progress>|$)\n?/g;
const CONTROL_BLOCK = /\n?<herdr_(?:control|progress)>[\s\S]*?(?:<\/herdr_(?:control|progress)>|$)\n?/gi;
const REASONING_BLOCK = /\n?<(?:think|reasoning)>[\s\S]*?(?:<\/(?:think|reasoning)>|$)\n?/gi;
const MAX_TERMINAL_DELTA_CHARS = 12_000;
const MIN_RELIABLE_TERMINAL_OVERLAP = 64;

export interface ParsedTerminalStreamDelta { delta: string; snapshot: string; update: "append" | "replace" }

/** True when TraeX is visibly waiting at its composer despite missing structured agent state. */
export function isTraexComposerReady(output: string): boolean {
  const lines = stripTerminalControl(output).replace(/\r/g, "").split("\n");
  return lines.slice(-8).some((line) => /^\s*[❯›]\s*(?:Use \/skills\b.*)?$/u.test(line));
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
  if (current === previous) return { delta: "", snapshot: currentRaw, update: "replace" };

  const continuous = current.startsWith(previous) || hasSuffixPrefixOverlap(previous, current);
  const rawDelta = current.startsWith(previous)
    ? current.slice(previous.length).replace(/^\n/, "")
    : continuous ? appendAfterOverlap(previous, current) : outputAfterPromptEcho(current, promptEcho);
  const visible = redactTerminalSecrets(
    rawDelta
      .replace(REASONING_BLOCK, "\n")
      .replace(CONTROL_BLOCK, "\n")
      .split("\n")
      .filter((line) => line.trim() !== promptEcho.trim() && !/^\s*[─━-]{3,}\s*$/.test(line))
      .join("\n")
      .replace(/\n{3,}/g, "\n\n")
      .trim()
  );
  const delta = visible.length <= MAX_TERMINAL_DELTA_CHARS
    ? visible
    : `${visible.slice(0, MAX_TERMINAL_DELTA_CHARS)}\n… [OUTPUT TRUNCATED]`;
  return { delta, snapshot: currentRaw, update: continuous || !previous ? "append" : "replace" };
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

function hasSuffixPrefixOverlap(previous: string, current: string): boolean {
  const limit = Math.min(previous.length, current.length);
  for (let size = limit; size >= Math.min(MIN_RELIABLE_TERMINAL_OVERLAP, limit); size -= 1) {
    if (previous.endsWith(current.slice(0, size))) return true;
  }
  return false;
}

function appendAfterOverlap(previous: string, current: string): string {
  const limit = Math.min(previous.length, current.length);
  for (let size = limit; size >= Math.min(MIN_RELIABLE_TERMINAL_OVERLAP, limit); size -= 1) {
    if (previous.endsWith(current.slice(0, size))) return current.slice(size).replace(/^\n/, "");
  }
  return current;
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
  const progress = structuredProgress(current);
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

function visibleAnswer(output: string): string { return stripProgressBlocks(extractAnswer(output)).trimEnd(); }

function stripProgressBlocks(answer: string): string {
  return answer.replace(PROGRESS_BLOCK, "\n");
}

function structuredProgress(output: string): { found: boolean; steps: ParsedProgressEvent[] } {
  const answer = extractAnswer(output);
  const blocks = [...answer.matchAll(new RegExp(PROGRESS_BLOCK.source, "g"))];
  for (const match of blocks.reverse()) {
    if (!match[0].includes("</herdr_progress>")) continue;
    try {
      const value = JSON.parse(match[1]!.trim()) as { steps?: unknown };
      if (!Array.isArray(value.steps) || value.steps.length > 20) continue;
      const steps: ParsedProgressEvent[] = [];
      for (const item of value.steps) {
        if (!item || typeof item !== "object") throw new Error("invalid step");
        const step = item as Record<string, unknown>;
        if (typeof step.id !== "string" || !step.id || step.id.length > 64 || typeof step.text !== "string" || !step.text || step.text.length > 240) throw new Error("invalid step");
        const states = { pending: "pending", in_progress: "active", completed: "done" } as const;
        if (typeof step.status !== "string" || !(step.status in states)) throw new Error("invalid step");
        steps.push({ key: `step:${step.id}`, kind: "step", label: step.text, state: states[step.status as keyof typeof states] });
      }
      return { found: true, steps };
    } catch { /* ignore malformed protocol blocks */ }
  }
  return nativeProgress(visibleAnswer(output));
}

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
