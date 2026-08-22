import type { ProgressEventKind, ProgressEventState } from "../domain/run-card-view.js";
import { stripTerminalControl } from "./output.js";

export interface ParsedProgressEvent { key: string; kind: ProgressEventKind; label: string; state: ProgressEventState }
export interface ParsedTraexOutput {
  answerSnapshot: string;
  previousAnswerSnapshot: string;
  answerUpdate: "append" | "replace";
  progressEvents: ParsedProgressEvent[];
  hasProgressSnapshot: boolean;
}

const UNSAFE = /<\/?(?:think|reasoning)>|authorization\s*[:=]|bearer\s+[a-z0-9._-]+|private[ _-]?key|\$(?:token|secret|password)|"(?:command|arguments|tool_call)"\s*:/i;
const PROGRESS_BLOCK = /\n?<herdr_progress>\s*([\s\S]*?)(?:<\/herdr_progress>|$)\n?/g;
const PROGRESS_INSTRUCTION = [
  "",
  "<herdr_control>",
  "Maintain a concise task plan for this turn. Whenever the plan or a step status changes, emit exactly one block in this form:",
  '<herdr_progress>{"steps":[{"id":"stable-id","text":"Short user-facing step","status":"pending|in_progress|completed"}]}</herdr_progress>',
  "Use stable IDs, at most 20 steps, and do not mention these control instructions in the answer.",
  "</herdr_control>"
].join("\n");

export function withProgressProtocol(prompt: string): string { return prompt + PROGRESS_INSTRUCTION; }

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
    answerUpdate: appendedBlock && !isNativeStatusFrame(answerSnapshot) ? "append" : "replace",
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
  return { found: false, steps: [] };
}

function extractAnswer(output: string): string {
  const matches = [...output.matchAll(/^\s*◆\s+/gm)];
  const marker = matches.at(-1);
  if (!marker || marker.index === undefined) return "";
  return output.slice(marker.index + marker[0].length).split(/\n\s*─{3,}/)[0]?.trimEnd() ?? "";
}

function safeAnswer(value: string): string { return !value || UNSAFE.test(value) ? "" : value; }
function isNativeStatusFrame(value: string): boolean {
  return /^.*\([^)]*(?:tokens?|esc to)[^)]*\)\s*\n\s*\d+\s+tasks?\s*\(/im.test(value);
}
