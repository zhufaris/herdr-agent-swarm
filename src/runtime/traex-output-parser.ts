import type { AgentState } from "../domain/types.js";
import { stripTerminalControl } from "./output.js";

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
  if (/[✧◆]\s*Work(?:ing|i…)|^\s*◈[^\n]*\([^\n)]*\besc to interrupt\b[^\n)]*\)|\bAuto Mode\b.*\bactive turn\b/imu.test(tailText)) return "working";
  return "unknown";
}

function hasTraexComposerReady(lines: readonly string[]): boolean {
  for (let index = lines.length - 1, seen = 0; index >= 0 && seen < 8; index -= 1, seen += 1) {
    if (/^\s*[❯›](?:\s+\S.*)?$/u.test(lines[index]!)) return true;
  }
  return false;
}

export function extractTraexTelemetry(source: string): { model?: string; context?: string } {
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
