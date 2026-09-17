import type { BridgeCommand, InstanceCommand } from "./types.js";
import type { AgentKind } from "./agent-instance.js";

export type ControlActor =
  | { kind: "human"; userId: string; channel?: "feishu" | "local" }
  | { kind: "thread-primary"; projectId: string; bindingId: string; bindingGeneration: number; parentPromptId: string };

export interface CreateWorkerCommand {
  actor: ControlActor; projectId: string; name: string; agentKind: AgentKind; model: string | null; start: boolean; bindingId?: string | null;
}

const MAX_TOPIC_TITLE_LENGTH = 80;

export function parseCommand(text: string): BridgeCommand | null {
  const trimmed = text.trim();
  if (!/^\/swarm(?:\s|$)/i.test(trimmed)) return null;

  const match = /^\/swarm(?:\s+([a-z]+))?(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return { kind: "help" };

  const action = (match[1] ?? "help").toLowerCase();
  const argument = (match[2] ?? "").trim();
  switch (action) {
    case "model":
      return { kind: "model", name: argument || null };
    case "stop":
      return argument ? { kind: "help" } : { kind: "stop" };
    case "steer":
      return argument ? { kind: "steer", text: argument } : { kind: "help" };
    case "new":
      return parseNewCommand(argument) ?? { kind: "help" };
    case "reset":
      return { kind: "reset", title: argument || null };
    case "projects":
      return { kind: "projects" };
    case "spaces":
      return argument ? { kind: "help" } : { kind: "spaces" };
    case "panes":
      return argument ? { kind: "help" } : { kind: "panes" };
    case "sessions":
      return argument ? { kind: "help" } : { kind: "sessions" };
    case "failures":
      return argument ? { kind: "help" } : { kind: "failures" };
    case "status":
      return { kind: "status" };
    case "attach": {
      const parts = argument.split(/\s+/).filter(Boolean);
      return parts.length === 2 ? { kind: "attach", spaceName: parts[0]!, paneId: parts[1]! } : { kind: "help" };
    }
    case "rename":
      return argument ? { kind: "rename", title: argument } : { kind: "help" };
    case "close":
      if (!argument) return { kind: "pane_close_request" };
      {
        const confirm = /^confirm\s+(\S+)$/i.exec(argument);
        return confirm ? { kind: "pane_close_confirm", code: confirm[1]! } : { kind: "help" };
      }
    case "pane": {
      if (argument === "close") return { kind: "pane_close_request" };
      const confirm = /^close\s+confirm\s+(\S+)$/i.exec(argument);
      return confirm ? { kind: "pane_close_confirm", code: confirm[1]! } : { kind: "help" };
    }
    case "reattach":
      return argument ? { kind: "reattach", paneId: argument } : { kind: "help" };
    case "replace":
      return { kind: "replace" };
    case "resume":
      return { kind: "resume" };
    case "awake":
      return argument ? { kind: "help" } : { kind: "awake" };
    case "skip":
      return argument ? { kind: "help" } : { kind: "skip" };
    case "worker":
      return parseWorkerCommand(argument) ?? { kind: "help" };
    case "help":
    default:
      return { kind: "help" };
  }
}

function parseNewCommand(argument: string): Extract<BridgeCommand, { kind: "new" }> | null {
  const tokens = argument.split(/\s+/).filter(Boolean);
  const agentOptionIndex = tokens.indexOf("--agent");
  if (agentOptionIndex === -1) {
    if (tokens.some((token) => token.startsWith("--"))) return null;
    return { kind: "new", title: tokens.join(" ") || null, agentKind: "traex" };
  }
  const agentKind = tokens[agentOptionIndex + 1];
  if (agentOptionIndex + 2 !== tokens.length) return null;
  if (agentKind !== "traex" && agentKind !== "pi" && agentKind !== "codex" && agentKind !== "claude-code") return null;
  const titleTokens = tokens.slice(0, agentOptionIndex);
  if (titleTokens.some((token) => token.startsWith("--"))) return null;
  return { kind: "new", title: titleTokens.join(" ") || null, agentKind };
}

function parseWorkerCommand(argument: string): Extract<BridgeCommand, { kind: "worker_create" }> | null {
  const tokens = argument.match(/"(?:[^"\\]|\\.)*"|'(?:[^'\\]|\\.)*'|\S+/g)?.map(unquote) ?? [];
  if (tokens[0]?.toLowerCase() !== "create" || !tokens[1] || tokens[1].startsWith("--")) return null;
  const name = tokens[1];
  let agentKind: AgentKind = "traex";
  let model: string | null = null;
  let start = false;
  const seen = new Set<string>();
  for (let index = 2; index < tokens.length; index += 1) {
    const option = tokens[index]!;
    if (seen.has(option)) return null;
    if (option === "--start") { seen.add(option); start = true; continue; }
    if (option !== "--agent" && option !== "--model") return null;
    const value = tokens[++index];
    if (!value || value.startsWith("--")) return null;
    seen.add(option);
    if (option === "--agent") {
      if (value !== "traex" && value !== "codex" && value !== "claude-code" && value !== "pi") return null;
      agentKind = value;
    } else model = value;
  }
  return { kind: "worker_create", name, agentKind, model, start };
}

function unquote(value: string): string {
  if ((value.startsWith("\"") && value.endsWith("\"")) || (value.startsWith("'") && value.endsWith("'"))) return value.slice(1, -1).replace(/\\([\\"'])/g, "$1");
  return value;
}

export function parseInstanceCommand(text: string): InstanceCommand | null {
  const trimmed = text.trim();
  const match = /^\/(projects|project|instances|instance|to|steer|stop|interrupt)(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return null;
  const action = match[1]!.toLowerCase();
  const argument = (match[2] ?? "").trim();
  if (action === "projects") return argument ? null : { kind: "projects" };
  if (action === "instances") return argument ? null : { kind: "instances" };
  if (action === "project") return argument && !/\s/.test(argument) ? { kind: "project", projectId: argument } : null;
  if (action === "instance") return argument && !/\s/.test(argument) ? { kind: "instance", name: argument } : null;
  const parts = /^(\S+)\s+([\s\S]+)$/.exec(argument);
  if (action === "to") return parts ? { kind: "to", name: parts[1]!, text: parts[2]!.trim() } : null;
  if (action === "steer") return parts ? { kind: "steer_instance", name: parts[1]!, text: parts[2]!.trim() } : null;
  return argument && !/\s/.test(argument) ? { kind: "stop_instance", name: argument } : null;
}
export function deriveTopicTitle(text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "TraeX task";
  return firstLine.slice(0, MAX_TOPIC_TITLE_LENGTH) || "TraeX task";
}
export function splitMessage(text: string, chunkSize: number): string[] {
  if (text.length <= chunkSize) return [text];
  const chunks: string[] = [];
  let rest = text;
  while (rest.length > chunkSize) {
    let splitAt = rest.lastIndexOf("\n", chunkSize);
    if (splitAt < Math.floor(chunkSize / 2)) splitAt = chunkSize;
    chunks.push(rest.slice(0, splitAt));
    rest = rest.slice(splitAt).replace(/^\n/, "");
  }
  if (rest) chunks.push(rest);
  return chunks;
}
