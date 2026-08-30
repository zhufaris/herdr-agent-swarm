const FENCE = /^ {0,3}(`{3,})([^`]*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const TRAEX_DIFF_ROW = /^\s*\d+\s+[+-](?:\s|$)/u;
const TRUNCATION_MARKER = "…（内容已截断）";
const LEADING_TRUNCATION_MARKER = "…（较早内容已省略）";
const TOOL_RESULT_LINE_LIMIT = 20;
const TOOL_RESULT_HEAD_LINES = 10;
const TOOL_RESULT_TAIL_LINES = 9;

export interface RenderedLarkMarkdownPage {
  page: string;
  nextPageStart: number | null;
}

interface MarkdownBlock {
  kind: "prose" | "code" | "table" | "diff";
  start: number;
  end: number;
  opening?: string;
  marker?: string;
  closed?: boolean;
}

/** Produces the conservative Markdown subset accepted by Lark CardKit. */
export function normalizeLarkMarkdown(source: string): string {
  const lines = source.replace(/\r\n?/g, "\n").split("\n");
  const output: string[] = [];
  let prose: string[] = [];
  let fenceMarker: string | null = null;

  const flushProse = (): void => {
    if (!prose.length) return;
    output.push(...normalizeProse(prose.join("\n")).split("\n"));
    prose = [];
  };

  for (const line of lines) {
    const opening = FENCE.exec(line);
    if (!fenceMarker && opening) {
      flushProse();
      fenceMarker = opening[1]!;
      output.push(line);
    } else if (fenceMarker) {
      output.push(line);
      if (isClosingFence(line, fenceMarker.length)) fenceMarker = null;
    } else {
      prose.push(line);
    }
  }
  flushProse();
  if (fenceMarker) output.push(fenceMarker);
  return output.join("\n");
}

/** Renders one bounded page while keeping continuation offsets in the source string. */
export function renderLarkMarkdownPage(source: string, pageStart: number, limit: number): RenderedLarkMarkdownPage {
  const start = Math.max(0, Math.min(pageStart, source.length));
  const boundedLimit = Math.max(0, limit);
  const complete = renderCardMarkdownRange(source, start, source.length);
  if (complete.length <= boundedLimit) return { page: complete, nextPageStart: null };

  const lineEnds: number[] = [];
  for (let index = source.indexOf("\n", start); index >= 0; index = source.indexOf("\n", index + 1)) {
    const end = index + 1;
    if (end < source.length) lineEnds.push(end);
  }
  const protectedRanges = atomicToolActivityRanges(source, boundedLimit);
  const candidates = lineEnds.filter((end) => !protectedRanges.some((range) => end > range.start && end < range.end));
  const lineEnd = latestFittingEnd(source, start, boundedLimit, candidates);
  if (lineEnd !== null) return { page: renderCardMarkdownRange(source, start, lineEnd), nextPageStart: lineEnd };

  let low = start + 1;
  let high = source.length - 1;
  let hardEnd: number | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    if (renderCardMarkdownRange(source, start, middle).length <= boundedLimit) {
      hardEnd = middle;
      low = middle + 1;
    } else high = middle - 1;
  }
  if (hardEnd !== null) return { page: renderCardMarkdownRange(source, start, hardEnd), nextPageStart: hardEnd };

  const forcedEnd = Math.min(source.length, start + Math.max(1, boundedLimit));
  return { page: source.slice(start, forcedEnd).slice(0, boundedLimit), nextPageStart: forcedEnd < source.length ? forcedEnd : null };
}

function atomicToolActivityRanges(source: string, limit: number): Array<{ start: number; end: number }> {
  const ranges: Array<{ start: number; end: number }> = [];
  const pattern = /^◆ \*\*Ran\*\*(?: · .+)?\n\n```bash\n[\s\S]*?\n```(?:\n\n```text\n[\s\S]*?\n```)?(?=\n|$)/gmu;
  for (const match of source.matchAll(pattern)) {
    const start = match.index;
    const end = start + match[0].length;
    if (renderToolActivityResults(match[0]).length <= limit) ranges.push({ start, end });
  }
  return ranges;
}

/** Normalizes first, then applies a bounded render-only copy. */
export function truncateLarkMarkdown(source: string, maxLength: number): string {
  const normalized = normalizeLarkMarkdown(source);
  if (normalized.length <= maxLength) return normalized;
  const suffix = `\n\n${TRUNCATION_MARKER}`;
  let room = Math.max(0, maxLength - suffix.length);
  let truncated = normalized.slice(0, room).trimEnd();
  let closingFence = hasOpenFence(truncated) ? "\n```" : "";
  if (closingFence) {
    room = Math.max(0, room - closingFence.length);
    truncated = normalized.slice(0, room).trimEnd();
    closingFence = hasOpenFence(truncated) ? "\n```" : "";
  }
  return `${truncated}${closingFence}${suffix}`.slice(0, maxLength);
}

/** Normalizes first, then keeps the newest render-safe Markdown window. */
export function truncateLarkMarkdownTail(source: string, maxLength: number): string {
  const normalized = normalizeLarkMarkdown(source);
  if (normalized.length <= maxLength) return normalized;
  const prefix = `${LEADING_TRUNCATION_MARKER}\n\n`;
  const room = Math.max(0, maxLength - prefix.length);
  let tail = normalized.slice(-room);
  const firstLineBreak = tail.indexOf("\n");
  if (firstLineBreak >= 0 && firstLineBreak < Math.floor(room / 2)) tail = tail.slice(firstLineBreak + 1);
  tail = normalizeLarkMarkdown(tail).slice(-room);
  return `${prefix}${tail}`.slice(0, maxLength);
}

/** Normalizes first, then keeps both ends around a bounded omission marker. */
export function truncateLarkMarkdownMiddle(source: string, maxLength: number): string {
  const normalized = normalizeLarkMarkdown(source);
  const limit = Math.max(0, maxLength);
  if (normalized.length <= limit) return normalized;
  if (limit === 0) return "";

  const markerFor = (characters: number, lines: number) => `… 已省略中间 ${lines} 行 / ${characters} 字符 …`;
  let headLength = Math.max(1, Math.floor(limit / 4));
  let tailLength = Math.max(1, Math.floor(limit / 4));
  for (let attempt = 0; attempt < 8; attempt += 1) {
    const omittedStart = headLength;
    const omittedEnd = Math.max(omittedStart, normalized.length - tailLength);
    const omitted = normalized.slice(omittedStart, omittedEnd);
    const marker = markerFor(omitted.length, omitted ? omitted.split("\n").length : 0);
    const separator = "\n\n";
    const available = limit - marker.length - separator.length * 2;
    if (available < 2) return normalized.slice(0, limit);
    const nextHeadLength = Math.max(1, Math.floor(available / 2));
    const nextTailLength = Math.max(1, available - nextHeadLength);
    if (nextHeadLength === headLength && nextTailLength === tailLength) {
      let headEnd = preferredHeadEnd(normalized, headLength);
      let tailStart = preferredTailStart(normalized, normalized.length - tailLength);
      for (let repair = 0; repair < 16 && headEnd < tailStart; repair += 1) {
        const head = renderMarkdownRange(normalized, 0, headEnd).trimEnd();
        const tail = renderMarkdownRange(normalized, tailStart, normalized.length).trimStart();
        const hidden = normalized.slice(headEnd, tailStart);
        const finalMarker = markerFor(hidden.length, hidden ? hidden.split("\n").length : 0);
        const result = `${head}${separator}${finalMarker}${separator}${tail}`;
        if (result.length <= limit) return result;
        const overflow = result.length - limit;
        headEnd = Math.max(1, headEnd - Math.ceil(overflow / 2));
        tailStart = Math.min(normalized.length - 1, tailStart + Math.floor(overflow / 2));
      }
      return truncateLarkMarkdown(normalized, limit);
    }
    headLength = nextHeadLength;
    tailLength = nextTailLength;
  }
  return normalized.slice(0, limit);
}

/** Removes terminal-width wrapping from prose without flattening Markdown blocks. */
export function normalizeLarkPreview(source: string): string {
  const lines = normalizeLarkMarkdown(source).split("\n");
  const output: string[] = [];
  let prose: string[] = [];
  let inFence = false;

  const flushProse = (): void => {
    if (!prose.length) return;
    output.push(prose.reduce((joined, line) => joined + proseSeparator(joined, line) + line.trim()));
    prose = [];
  };

  for (const line of lines) {
    if (/^ {0,3}`{3,}/.test(line)) {
      flushProse();
      output.push(line);
      inFence = !inFence;
    } else if (inFence) {
      output.push(line);
    } else if (!line.trim()) {
      flushProse();
      if (output.at(-1) !== "") output.push("");
    } else if (isMarkdownBlockLine(line)) {
      flushProse();
      output.push(line);
    } else {
      prose.push(line);
    }
  }
  flushProse();
  return output.join("\n");
}

function preferredHeadEnd(source: string, length: number): number {
  const exact = source.slice(0, length);
  const boundary = exact.lastIndexOf("\n");
  return boundary > 0 && boundary >= Math.floor(length / 2) ? boundary + 1 : exact.length;
}

function preferredTailStart(source: string, start: number): number {
  const exact = source.slice(start);
  const boundary = exact.indexOf("\n");
  return boundary >= 0 && boundary < Math.floor(exact.length / 2) ? start + boundary + 1 : start;
}

function normalizeProse(source: string): string {
  const inlineCode: string[] = [];
  let value = source.replace(/(`+)([^\n]*?)\1/g, (match) => {
    const token = `\uE000${inlineCode.length}\uE001`;
    inlineCode.push(match);
    return token;
  });
  value = value
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "")
    .replace(/<[^>]*>/g, "")
    .replace(/[ \t]+$/gm, "");

  const lines = value.split("\n");
  const output: string[] = [];
  for (let index = 0; index < lines.length;) {
    const diffEnd = traexDiffEnd(lines, index);
    if (diffEnd !== null) {
      output.push("```diff", ...lines.slice(index, diffEnd), "```");
      index = diffEnd;
      continue;
    }
    if (index + 1 < lines.length && isTableRow(lines[index]!) && TABLE_DELIMITER.test(lines[index + 1]!)) {
      const table: string[] = [lines[index]!, lines[index + 1]!];
      index += 2;
      while (index < lines.length && isTableRow(lines[index]!)) table.push(lines[index++]!);
      output.push("```text", ...table, "```");
      continue;
    }
    output.push(normalizeLinks(lines[index]!));
    index += 1;
  }
  value = output.join("\n");
  return value.replace(/\uE000(\d+)\uE001/g, (_, index: string) => inlineCode[Number(index)] ?? "");
}

function latestFittingEnd(source: string, start: number, limit: number, candidates: readonly number[]): number | null {
  let low = 0;
  let high = candidates.length - 1;
  let result: number | null = null;
  while (low <= high) {
    const middle = Math.floor((low + high) / 2);
    const end = candidates[middle]!;
    if (renderCardMarkdownRange(source, start, end).length <= limit) {
      result = end;
      low = middle + 1;
    } else high = middle - 1;
  }
  return result;
}

function renderCardMarkdownRange(source: string, start: number, end: number): string {
  return renderToolActivityResults(renderMarkdownRange(source, start, end));
}

/** Applies Answer Card-only tool result folding without changing source offsets. */
function renderToolActivityResults(markdown: string): string {
  const lines = markdown.split("\n");
  const rendered: string[] = [];
  for (let index = 0; index < lines.length;) {
    rendered.push(lines[index]!);
    if (!/^◆ \*\*Ran\*\*(?: · .+)?$/.test(lines[index]!)) { index += 1; continue; }
    index += 1;
    while (index < lines.length && lines[index] === "") rendered.push(lines[index++]!);
    if (!/^```bash\s*$/.test(lines[index] ?? "")) continue;
    do {
      rendered.push(lines[index]!);
      index += 1;
    } while (index < lines.length && lines[index - 1] !== "```");
    while (index < lines.length && lines[index] === "") rendered.push(lines[index++]!);
    if (!/^```text\s*$/.test(lines[index] ?? "")) continue;
    rendered.push(lines[index++]!);
    const detail: string[] = [];
    while (index < lines.length && lines[index] !== "```") detail.push(lines[index++]!);
    const bounded = detail.length <= TOOL_RESULT_LINE_LIMIT ? detail : [
      ...detail.slice(0, TOOL_RESULT_HEAD_LINES),
      `… 已省略中间 ${detail.length - TOOL_RESULT_HEAD_LINES - TOOL_RESULT_TAIL_LINES} 行 …`,
      ...detail.slice(-TOOL_RESULT_TAIL_LINES)
    ];
    rendered.push(...bounded);
    if (index < lines.length) rendered.push(lines[index++]!);
  }
  return rendered.join("\n");
}

function renderMarkdownRange(source: string, start: number, end: number): string {
  const output: string[] = [];
  for (const block of markdownBlocks(source)) {
    const from = Math.max(start, block.start);
    const to = Math.min(end, block.end);
    if (from >= to) continue;
    const raw = source.slice(from, to).replace(/\r\n?/g, "\n");
    if (block.kind === "prose") {
      output.push(normalizeProse(raw));
      continue;
    }
    if (block.kind === "table" || block.kind === "diff") {
      const trailingNewline = raw.endsWith("\n");
      const language = block.kind === "diff" ? "diff" : "text";
      output.push(`\`\`\`${language}\n${trailingNewline ? raw.slice(0, -1) : raw}\n\`\`\`${trailingNewline ? "\n" : ""}`);
      continue;
    }
    const prefix = from > block.start ? `${block.opening}\n` : "";
    const needsClosure = to < block.end || block.closed !== true;
    const suffix = needsClosure ? `${raw.endsWith("\n") ? "" : "\n"}${block.marker}` : "";
    output.push(`${prefix}${raw}${suffix}`);
  }
  return output.join("");
}

function markdownBlocks(source: string): MarkdownBlock[] {
  const lines = sourceLines(source);
  const lineTexts = lines.map(({ text }) => text);
  const blocks: MarkdownBlock[] = [];
  let index = 0;
  while (index < lines.length) {
    const line = lines[index]!;
    const fence = FENCE.exec(line.text);
    if (fence) {
      let cursor = index + 1;
      while (cursor < lines.length && !isClosingFence(lines[cursor]!.text, fence[1]!.length)) cursor += 1;
      const closed = cursor < lines.length;
      const last = closed ? cursor : lines.length - 1;
      blocks.push({ kind: "code", start: line.start, end: lines[last]!.end, opening: line.text, marker: fence[1]!, closed });
      index = last + 1;
      continue;
    }
    if (index + 1 < lines.length && isTableRow(line.text) && TABLE_DELIMITER.test(lines[index + 1]!.text)) {
      let cursor = index + 2;
      while (cursor < lines.length && isTableRow(lines[cursor]!.text)) cursor += 1;
      blocks.push({ kind: "table", start: line.start, end: lines[cursor - 1]!.end });
      index = cursor;
      continue;
    }
    const diffEnd = traexDiffEnd(lineTexts, index);
    if (diffEnd !== null) {
      blocks.push({ kind: "diff", start: line.start, end: lines[diffEnd - 1]!.end });
      index = diffEnd;
      continue;
    }
    let cursor = index + 1;
    while (cursor < lines.length) {
      if (FENCE.test(lines[cursor]!.text)) break;
      if (cursor + 1 < lines.length && isTableRow(lines[cursor]!.text) && TABLE_DELIMITER.test(lines[cursor + 1]!.text)) break;
      if (traexDiffEnd(lineTexts, cursor) !== null) break;
      cursor += 1;
    }
    blocks.push({ kind: "prose", start: line.start, end: lines[cursor - 1]!.end });
    index = cursor;
  }
  return blocks;
}

function sourceLines(source: string): Array<{ start: number; end: number; text: string }> {
  if (!source) return [];
  const lines: Array<{ start: number; end: number; text: string }> = [];
  let start = 0;
  while (start < source.length) {
    const newline = source.indexOf("\n", start);
    const end = newline < 0 ? source.length : newline + 1;
    lines.push({ start, end, text: source.slice(start, newline < 0 ? end : newline).replace(/\r$/, "") });
    start = end;
  }
  return lines;
}

function normalizeLinks(line: string): string {
  let output = "";
  for (let index = 0; index < line.length;) {
    const image = line[index] === "!" && line[index + 1] === "[";
    const start = image ? index + 1 : index;
    if (line[start] !== "[") { output += line[index++]; continue; }
    const labelEnd = findUnescaped(line, "]", start + 1);
    if (labelEnd < 0 || line[labelEnd + 1] !== "(") { output += line[index++]; continue; }
    const destinationEnd = findClosingParenthesis(line, labelEnd + 2);
    if (destinationEnd < 0) { output += line[index++]; continue; }
    const label = line.slice(start + 1, labelEnd);
    const destination = linkDestination(line.slice(labelEnd + 2, destinationEnd));
    const visible = image ? (label ? `图片：${label}` : "图片") : label;
    output += destination && isSafeHttpUrl(destination) ? `[${visible}](${destination})` : visible;
    index = destinationEnd + 1;
  }
  return output;
}

function findUnescaped(value: string, target: string, start: number): number {
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === target && value[index - 1] !== "\\") return index;
  }
  return -1;
}

function findClosingParenthesis(value: string, start: number): number {
  let depth = 1;
  for (let index = start; index < value.length; index += 1) {
    if (value[index] === "\\") { index += 1; continue; }
    if (value[index] === "(") depth += 1;
    if (value[index] === ")" && --depth === 0) return index;
  }
  return -1;
}

function linkDestination(raw: string): string {
  const trimmed = raw.trim();
  const destination = trimmed.startsWith("<") && trimmed.includes(">")
    ? trimmed.slice(1, trimmed.indexOf(">"))
    : trimmed.split(/\s+["']/)[0]!;
  return destination.trim();
}

function isSafeHttpUrl(value: string): boolean {
  try {
    const url = new URL(value);
    return url.protocol === "http:" || url.protocol === "https:";
  } catch { return false; }
}

function isTableRow(line: string): boolean {
  const trimmed = line.trim();
  return trimmed.includes("|") && (trimmed.startsWith("|") || trimmed.endsWith("|"));
}

function traexDiffEnd(lines: readonly string[], start: number): number | null {
  if (!TRAEX_DIFF_ROW.test(lines[start] ?? "")) return null;
  let end = start + 1;
  while (end < lines.length && TRAEX_DIFF_ROW.test(lines[end]!)) end += 1;
  return end - start >= 2 ? end : null;
}

function isMarkdownBlockLine(line: string): boolean {
  return /^\s*(?:#{1,6}\s|[-*+]\s|\d+[.)]\s|>\s|-{3,}\s*$)/.test(line) || isTableRow(line) || / {2}$/.test(line);
}

function proseSeparator(previous: string, next: string): string {
  return /[A-Za-z0-9]$/.test(previous.trimEnd()) && /^[A-Za-z0-9]/.test(next.trimStart()) ? " " : "";
}

function hasOpenFence(source: string): boolean {
  let marker: string | null = null;
  for (const line of source.split("\n")) {
    const match = FENCE.exec(line);
    if (!marker && match) marker = match[1]!;
    else if (marker && isClosingFence(line, marker.length)) marker = null;
  }
  return marker !== null;
}

function isClosingFence(line: string, minimumLength: number): boolean {
  const trimmed = line.trim();
  return trimmed.length >= minimumLength && /^`+$/.test(trimmed);
}
