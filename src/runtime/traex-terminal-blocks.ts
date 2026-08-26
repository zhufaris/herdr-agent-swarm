import { normalizeLarkPreview } from "./lark-markdown.js";

export type TerminalBlock =
  | { kind: "prose"; lines: string[] }
  | { kind: "diff"; title: string | null; lines: string[] }
  | { kind: "command"; title: string; command: string | null; output: string[] }
  | { kind: "status"; lines: string[] };

export type TerminalContinuation =
  | { kind: "none" }
  | { kind: "diff"; title: string | null }
  | { kind: "command"; title: string; command: string | null };

const NONE: TerminalContinuation = { kind: "none" };

export function deriveTerminalContinuation(previous: string): TerminalContinuation {
  const lines = previous.replace(/\r\n?/g, "\n").split("\n");
  let lastMarker = -1;
  for (let index = lines.length - 1; index >= 0; index -= 1) {
    if (/^\s*◆\s+/u.test(lines[index]!)) { lastMarker = index; break; }
  }
  if (lastMarker < 0 || !isEditedHeading(lines[lastMarker]!)) return NONE;
  return lines.slice(lastMarker + 1).every((line) => !line.trim() || isEditedBodyRow(line))
    ? { kind: "diff", title: lines[lastMarker]!.trim() }
    : NONE;
}

export function parseTraexTerminalBlocks(source: string, continuation: TerminalContinuation = NONE): TerminalBlock[] {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const output: TerminalBlock[] = [];
  let index = 0;

  if (continuation.kind === "diff") {
    const end = editedBodyEnd(lines, index);
    if (end > index) {
      output.push({ kind: "diff", title: null, lines: lines.slice(index, end) });
      index = end;
    }
  }

  let prose: string[] = [];
  const flushProse = (): void => {
    if (prose.length) output.push({ kind: "prose", lines: prose });
    prose = [];
  };

  while (index < lines.length) {
    const line = lines[index]!;
    if (!isEditedHeading(line)) {
      prose.push(line);
      index += 1;
      continue;
    }
    flushProse();
    const title = line.trim();
    index += 1;
    const end = editedBodyEnd(lines, index);
    if (end === index) output.push({ kind: "prose", lines: [line] });
    else output.push({ kind: "diff", title, lines: lines.slice(index, end) });
    index = end;
  }
  flushProse();
  return output;
}

export function renderTraexTerminalBlocks(blocks: readonly TerminalBlock[]): string {
  return blocks.map((block) => {
    if (block.kind === "prose") return normalizeLarkPreview(block.lines.join("\n"));
    if (block.kind === "status") return block.lines.join("\n");
    if (block.kind === "diff") {
      const fence = block.lines.length ? `\`\`\`diff\n${block.lines.join("\n")}\n\`\`\`` : "";
      return [block.title, fence].filter(Boolean).join("\n");
    }
    return block.title;
  }).filter(Boolean).join("\n");
}

function isEditedHeading(line: string): boolean {
  return /^\s*◆\s+Edited\b/u.test(line);
}

function isEditedBodyRow(line: string): boolean {
  return /^\s*\d+(?:\s+[+-](?:\s|$)|\s+⋮(?:\s|$)|\s{2,}\S)/u.test(line);
}

function editedBodyEnd(lines: readonly string[], start: number): number {
  let end = start;
  while (end < lines.length && isEditedBodyRow(lines[end]!)) end += 1;
  return end;
}
