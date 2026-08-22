import type { BridgeCommand } from "./types.js";

const MAX_TOPIC_TITLE_LENGTH = 80;

export function parseCommand(text: string): BridgeCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/herdr")) return null;

  const match = /^\/herdr(?:\s+([a-z]+))?(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return { kind: "help" };

  const action = (match[1] ?? "help").toLowerCase();
  const argument = (match[2] ?? "").trim();
  switch (action) {
    case "new":
      return { kind: "new", title: argument || null };
    case "projects":
      return { kind: "projects" };
    case "spaces":
      return argument ? { kind: "help" } : { kind: "spaces" };
    case "status":
      return { kind: "status" };
    case "attach": {
      const parts = argument.split(/\s+/).filter(Boolean);
      return parts.length === 2 ? { kind: "attach", spaceName: parts[0]!, paneId: parts[1]! } : { kind: "help" };
    }
    case "rename":
      return argument ? { kind: "rename", title: argument } : { kind: "help" };
    case "close":
      return { kind: "close" };
    case "reattach":
      return argument ? { kind: "reattach", paneId: argument } : { kind: "help" };
    case "replace":
      return { kind: "replace" };
    case "resume":
      return { kind: "resume" };
    case "help":
    default:
      return { kind: "help" };
  }
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
