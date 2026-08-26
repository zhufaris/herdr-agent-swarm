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
    if (isBlockBoundary(lines[index]!)) { lastMarker = index; break; }
  }
  if (lastMarker < 0) return NONE;
  if (isEditedHeading(lines[lastMarker]!)) {
    return lines.slice(lastMarker + 1).every((line) => !line.trim() || isEditedBodyRow(line))
      ? { kind: "diff", title: lines[lastMarker]!.trim() }
      : NONE;
  }
  if (!isCommandHeading(lines[lastMarker]!)) return NONE;
  const heading = parseCommandHeading(lines, lastMarker);
  return { kind: "command", title: heading.title, command: heading.command };
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
  } else if (continuation.kind === "command") {
    const end = commandOutputEnd(lines, index);
    if (end > index) {
      output.push({ kind: "command", title: continuation.title, command: null, output: lines.slice(index, end).map(stripOutputBranch) });
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
    if (isCommandHeading(line)) {
      flushProse();
      const heading = parseCommandHeading(lines, index);
      index = heading.next;
      const end = commandOutputEnd(lines, index);
      output.push({
        kind: "command", title: heading.title, command: heading.command,
        output: lines.slice(index, end).map(stripOutputBranch)
      });
      index = end;
      continue;
    }
    if (isEditedHeading(line)) {
      flushProse();
      const title = line.trim();
      index += 1;
      const end = editedBodyEnd(lines, index);
      if (end === index) output.push({ kind: "prose", lines: [line] });
      else output.push({ kind: "diff", title, lines: lines.slice(index, end) });
      index = end;
      continue;
    }
    if (isStatusLine(line)) {
      flushProse();
      output.push({ kind: "status", lines: [line] });
      index += 1;
      continue;
    }
    if (/^\s*◆\s+/u.test(line)) {
      flushProse();
      const block = [line];
      index += 1;
      while (index < lines.length && !isBlockBoundary(lines[index]!)) block.push(lines[index++]!);
      output.push({ kind: "prose", lines: block });
      continue;
    }
    prose.push(line);
    index += 1;
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
    const command = block.command ? `\`\`\`bash\n${block.command}\n\`\`\`` : "";
    const stdout = block.output.length ? `\`\`\`text\n${block.output.join("\n")}\n\`\`\`` : "";
    return [block.title, command, stdout].filter(Boolean).join("\n");
  }).filter(Boolean).join("\n");
}

function isEditedHeading(line: string): boolean {
  return /^\s*◆\s+Edited\b/u.test(line);
}

function isCommandHeading(line: string): boolean {
  return /^\s*(?:◆\s+Ran|•\s+Bash)(?:\s|$)/u.test(line);
}

function isBlockBoundary(line: string): boolean {
  return /^\s*(?:◆|•|✧|❯|›)/u.test(line) || /^\s*[─━-]{3,}\s*$/u.test(line);
}

function isStatusLine(line: string): boolean {
  return /^\s*(?:✧|•)\s+/u.test(line) || /^\s*[╭│╰]/u.test(line);
}

function parseCommandHeading(lines: readonly string[], start: number): { title: string; command: string | null; next: number } {
  const match = /^\s*(◆\s+Ran|•\s+Bash)(?:\s+(.*))?$/u.exec(lines[start]!);
  const title = match?.[1] ?? lines[start]!.trim();
  let command = match?.[2] ?? "";
  let next = start + 1;
  while (next < lines.length && /^\s*│/.test(lines[next]!)) {
    command += lines[next]!.replace(/^\s*│ ?/, "");
    next += 1;
  }
  return { title, command: command || null, next };
}

function commandOutputEnd(lines: readonly string[], start: number): number {
  let end = start;
  while (end < lines.length && !isBlockBoundary(lines[end]!)) end += 1;
  return end;
}

function stripOutputBranch(line: string): string {
  return line.replace(/^\s*└ ?/, "");
}

function isEditedBodyRow(line: string): boolean {
  return /^\s*\d+(?:\s+[+-](?:\s|$)|\s+⋮(?:\s|$)|\s{2,}\S)/u.test(line);
}

function editedBodyEnd(lines: readonly string[], start: number): number {
  let end = start;
  while (end < lines.length && isEditedBodyRow(lines[end]!)) end += 1;
  return end;
}
