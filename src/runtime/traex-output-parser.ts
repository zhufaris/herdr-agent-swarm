import type { ProgressEventKind, ProgressEventState } from "../domain/run-card-view.js";
import { stripTerminalControl } from "./output.js";

export interface ParsedProgressEvent { key: string; kind: ProgressEventKind; label: string; state: ProgressEventState }
export interface ParsedTraexOutput { answerDelta: string; progressEvents: ParsedProgressEvent[] }

const UNSAFE = /<\/?(?:think|reasoning)>|authorization\s*[:=]|bearer\s+[a-z0-9._-]+|private[ _-]?key|\$(?:token|secret|password)|"(?:command|arguments|tool_call)"\s*:/i;

export function parseTraexOutput(previousRaw: string, currentRaw: string, workspaceRoot: string): ParsedTraexOutput {
  const previous = stripTerminalControl(previousRaw).trim();
  const current = stripTerminalControl(currentRaw).trim();
  const rawDelta = current.startsWith(previous) ? current.slice(previous.length) : current;
  if (UNSAFE.test(rawDelta)) return { answerDelta: "", progressEvents: [] };
  const previousAnswer = extractAnswer(previous);
  const currentAnswer = extractAnswer(current);
  const answerDelta = currentAnswer.startsWith(previousAnswer) ? currentAnswer.slice(previousAnswer.length) : currentAnswer;
  const previousKeys = new Set(progressFrom(previous, workspaceRoot).map((event) => event.key));
  return { answerDelta: safeAnswer(answerDelta), progressEvents: progressFrom(rawDelta, workspaceRoot).filter((event) => !previousKeys.has(event.key)) };
}

export function extractFinalTraexAnswer(output: string): string { return safeAnswer(extractAnswer(stripTerminalControl(output))).trim(); }

function extractAnswer(output: string): string {
  const matches = [...output.matchAll(/^\s*◆\s+/gm)];
  const marker = matches.at(-1);
  if (!marker || marker.index === undefined) return "";
  return output.slice(marker.index + marker[0].length).split(/\n\s*─{3,}/)[0]?.trimEnd() ?? "";
}

function safeAnswer(value: string): string { return !value || UNSAFE.test(value) ? "" : value; }

function progressFrom(output: string, workspaceRoot: string): ParsedProgressEvent[] {
  const events: ParsedProgressEvent[] = [];
  for (const line of output.split("\n")) {
    if (UNSAFE.test(line)) continue;
    const operation = /^\s*[•✓◌]?\s*(Read|Edit|Search|Grep|Bash)\s+(.+)$/i.exec(line);
    if (!operation) continue;
    const verb = operation[1]!.toLowerCase();
    const argument = operation[2]!.trim();
    if (verb === "bash") {
      if (/\b(?:npm|pnpm|yarn|bun|vitest|pytest|cargo|go)\b.*\btest\b/i.test(argument)) events.push({ key: "test:run", kind: "test", label: "正在运行测试", state: "active" });
      continue;
    }
    const path = safePath(argument, workspaceRoot);
    if (!path) continue;
    if (verb === "read") events.push({ key: "read:" + path, kind: "read", label: "已读取 " + path, state: "done" });
    else if (verb === "edit") events.push({ key: "edit:" + path, kind: "edit", label: "已修改 " + path, state: "done" });
    else events.push({ key: "search:" + path, kind: "search", label: "已查找 " + path, state: "done" });
  }
  return events;
}

function safePath(value: string, workspaceRoot: string): string | null {
  const withoutLocation = value.split(":")[0]!.trim();
  const rootPrefix = workspaceRoot.endsWith("/") ? workspaceRoot : workspaceRoot + "/";
  const relative = withoutLocation.startsWith(rootPrefix) ? withoutLocation.slice(rootPrefix.length) : withoutLocation;
  if (!relative || relative.startsWith("/") || relative.includes("..") || /[?$]/.test(relative)) return null;
  return relative.replace(/^\.\//, "");
}
