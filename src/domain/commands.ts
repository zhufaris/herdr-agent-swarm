import type { BridgeCommand } from "./types.js";

export function parseCommand(text: string): BridgeCommand | null {
  const trimmed = text.trim();
  if (!trimmed.startsWith("/herdr")) return null;

  const match = /^\/herdr(?:\s+([a-z]+))?(?:\s+([\s\S]*))?$/i.exec(trimmed);
  if (!match) return { kind: "help" };

  const action = (match[1] ?? "help").toLowerCase();
  const argument = (match[2] ?? "").trim();
  switch (action) {
    case "new":
      return argument ? { kind: "new", title: argument } : { kind: "help" };
    case "status":
      return { kind: "status" };
    case "rename":
      return argument ? { kind: "rename", title: argument } : { kind: "help" };
    case "close":
      return { kind: "close" };
    case "help":
    default:
      return { kind: "help" };
  }
}

export function deriveTopicTitle(text: string): string {
  const firstLine = text.trim().split(/\r?\n/, 1)[0] ?? "TraeX task";
  return firstLine.slice(0, 80) || "TraeX task";
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
