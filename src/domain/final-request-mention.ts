import { selectCompletionChoiceTerminalAnswer } from "./completion-choice.js";

export interface FinalRequestMentionProjection {
  markdown: string;
  requested: boolean;
  /** Native syntax requests the current actor; its embedded ID is not recipient authority. */
  request?: { kind: "role-marker" } | { kind: "native-mention" };
}

const MARKER = "@_user_1";
const CHOICE_INVOCATION = "$herdr-choice-list:herdr-choice-list";

/** Removes the exact requester marker outside Markdown code while preserving code verbatim. */
export function projectFinalRequestMention(
  markdown: string,
  options?: { preserveReservedRegions?: boolean; allowTrailingChoiceBlock?: boolean }
): FinalRequestMentionProjection {
  const visibleMarkdown = options?.preserveReservedRegions ? markdown : selectCompletionChoiceTerminalAnswer(markdown, "");
  const native = terminalNativeMention(visibleMarkdown, options?.allowTrailingChoiceBlock === true);
  const source = native
    ? options?.allowTrailingChoiceBlock
      ? joinRequesterMarkdown(visibleMarkdown.slice(0, native.start), visibleMarkdown.slice(native.end))
      : visibleMarkdown.slice(0, native.start).trimEnd()
    : visibleMarkdown;
  let output = "";
  let index = 0;
  let inlineTicks = 0;
  let fenceTicks = 0;
  let fenceContainers: FenceContainerToken[] = [];
  let requested = false;

  while (index < source.length) {
    const atLineStart = index === 0 || source[index - 1] === "\n";
    if (atLineStart) {
      const lineEnd = source.indexOf("\n", index);
      const line = source.slice(index, lineEnd < 0 ? source.length : lineEnd);
      if (fenceTicks !== 0) {
        const scoped = fenceContent(line, fenceContainers);
        if (!scoped.belongs && line.trim().length > 0) {
          fenceTicks = 0;
          fenceContainers = [];
          continue;
        }
        const close = scoped.belongs ? scoped.content.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/) : null;
        if (close) {
          const ticks = close[2]![0] === "`" ? close[2]!.length : -close[2]!.length;
          if (Math.sign(fenceTicks) === Math.sign(ticks) && Math.abs(ticks) >= Math.abs(fenceTicks)) {
            fenceTicks = 0;
            fenceContainers = [];
            output += line;
            index += line.length;
            continue;
          }
        }
      } else if (inlineTicks === 0) {
        const fence = line.match(/^((?:[ \t]|>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+)*)(`{3,}|~{3,})(.*)$/);
        if (fence) {
          const ticks = fence[2]![0] === "`" ? fence[2]!.length : -fence[2]!.length;
          const rest = fence[3]!;
          if (ticks < 0 || !rest.includes("`")) {
            const container = fenceContainer(fence[1]!);
            fenceTicks = ticks;
            fenceContainers = container;
            const delimiterLength = fence[1]!.length + fence[2]!.length;
            output += source.slice(index, index + delimiterLength);
            index += delimiterLength;
            continue;
          }
        }
      }
    }

    if (fenceTicks === 0 && source[index] === "`") {
      let end = index + 1;
      while (source[end] === "`") end += 1;
      const count = end - index;
      if (inlineTicks === 0) inlineTicks = count;
      else if (count === inlineTicks) inlineTicks = 0;
      output += source.slice(index, end);
      index = end;
      continue;
    }

    if (fenceTicks === 0 && inlineTicks === 0 && source.startsWith(MARKER, index)
      && !isMarkerWord(source[index - 1]) && !isMarkerWord(source[index + MARKER.length])) {
      requested = true;
      const next = source[index + MARKER.length];
      if (output.endsWith(" ") && (next === undefined || /[.,;:!?，。；：！？)\]}\n]/.test(next))) {
        output = output.slice(0, -1);
      }
      index += MARKER.length;
      if ((output.length === 0 || output.endsWith("\n")) && (source[index] === " " || source[index] === "\t")) index += 1;
      continue;
    }

    output += source[index];
    index += 1;
  }

  if (native) return {
    markdown: requested ? output : source,
    requested: true,
    ...(requested ? { request: { kind: "role-marker" } as const } : { request: { kind: "native-mention" } as const })
  };
  return requested ? { markdown: output, requested } : { markdown: source, requested };
}

/** The caller supplies the trusted current actor; this reports only protocol intent. */
export function requestsFinalRequestMention(projection: FinalRequestMentionProjection): boolean {
  return projection.requested;
}

function terminalNativeMention(markdown: string, allowTrailingChoiceBlock = false): { start: number; end: number } | null {
  const candidates: Array<{ start: number; end: number }> = [];
  let index = 0;
  let fenceTicks = 0;
  let fenceContainers: FenceContainerToken[] = [];
  while (index <= markdown.length) {
    const lineEnd = markdown.indexOf("\n", index);
    const end = lineEnd < 0 ? markdown.length : lineEnd;
    const line = markdown.slice(index, end);
    if (fenceTicks !== 0) {
      const scoped = fenceContent(line, fenceContainers);
      if (!scoped.belongs && line.trim().length > 0) {
        fenceTicks = 0;
        fenceContainers = [];
        if (lineEnd < 0) break;
        index = lineEnd + 1;
        continue;
      }
      const close = scoped.belongs ? scoped.content.match(/^( {0,3})(`{3,}|~{3,})[ \t]*$/) : null;
      if (close) {
        const ticks = close[2]![0] === "`" ? close[2]!.length : -close[2]!.length;
        if (Math.sign(fenceTicks) === Math.sign(ticks) && Math.abs(ticks) >= Math.abs(fenceTicks)) {
          fenceTicks = 0;
          fenceContainers = [];
        }
      }
    } else {
      const fence = line.match(/^((?:[ \t]|>[ \t]?|(?:[-+*]|\d+[.)])[ \t]+)*)(`{3,}|~{3,})(.*)$/);
      if (fence) {
        const ticks = fence[2]![0] === "`" ? fence[2]!.length : -fence[2]!.length;
        if (ticks < 0 || !fence[3]!.includes("`")) {
          fenceTicks = ticks;
          fenceContainers = fenceContainer(fence[1]!);
        }
      } else {
        const match = line.match(/^<at id=(ou_[A-Za-z0-9_-]{1,128})><\/at>$/);
        if (match) candidates.push({ start: index, end });
      }
    }
    if (lineEnd < 0) break;
    index = lineEnd + 1;
  }
  if (candidates.length !== 1) return null;
  const candidate = candidates[0]!;
  const suffix = markdown.slice(candidate.end).trim();
  if (suffix.length === 0 || suffix === CHOICE_INVOCATION) return candidate;
  if (!allowTrailingChoiceBlock) return null;
  return /^(?:\$herdr-choice-list:herdr-choice-list\s*)?```herdr-choice-list[\s\S]*$/.test(suffix) ? candidate : null;
}

function joinRequesterMarkdown(left: string, right: string): string {
  const trimmedLeft = left.trimEnd();
  const trimmedRight = right.trimStart();
  if (!trimmedLeft) return trimmedRight;
  if (!trimmedRight) return trimmedLeft;
  return `${trimmedLeft}\n\n${trimmedRight}`;
}

function isMarkerWord(value: string | undefined): boolean {
  return value !== undefined && /[A-Za-z0-9_]/.test(value);
}

type FenceContainerToken = { kind: "quote" } | { kind: "indent"; columns: number };

function fenceContainer(prefix: string): FenceContainerToken[] {
  const tokens: FenceContainerToken[] = [];
  let offset = 0;
  while (offset < prefix.length) {
    const remaining = prefix.slice(offset);
    const quote = remaining.match(/^[ \t]{0,3}>[ \t]?/);
    if (quote) { tokens.push({ kind: "quote" }); offset += quote[0].length; continue; }
    const list = remaining.match(/^[ \t]{0,3}(?:[-+*]|\d+[.)])[ \t]+/);
    if (list) { tokens.push({ kind: "indent", columns: indentationColumns(list[0]) }); offset += list[0].length; continue; }
    const whitespace = remaining.match(/^[ \t]+/)?.[0] ?? "";
    if (whitespace && indentationColumns(whitespace) > 3) tokens.push({ kind: "indent", columns: indentationColumns(whitespace) });
    break;
  }
  return tokens;
}

function fenceContent(line: string, containers: FenceContainerToken[]): { belongs: boolean; content: string } {
  let offset = 0;
  for (const container of containers) {
    if (container.kind === "quote") {
      const quote = line.slice(offset).match(/^[ \t]{0,3}>[ \t]?/);
      if (!quote) return { belongs: line.trim().length === 0, content: line };
      offset += quote[0].length;
      continue;
    }
    const indent = consumeIndent(line, offset, container.columns);
    if (!indent) return { belongs: line.trim().length === 0, content: line.slice(offset) };
    offset = indent.offset;
  }
  return { belongs: true, content: line.slice(offset) };
}

function consumeIndent(line: string, offset: number, requiredColumns: number): { offset: number } | null {
  let columns = 0;
  let cursor = offset;
  while (cursor < line.length && columns < requiredColumns && (line[cursor] === " " || line[cursor] === "\t")) {
    columns += line[cursor] === "\t" ? 4 - (columns % 4) : 1;
    cursor += 1;
  }
  return columns >= requiredColumns ? { offset: cursor } : null;
}

function indentationColumns(value: string): number {
  let columns = 0;
  for (const character of value) columns += character === "\t" ? 4 - (columns % 4) : 1;
  return columns;
}
