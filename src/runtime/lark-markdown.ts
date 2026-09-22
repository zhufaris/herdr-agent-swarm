import { compactAnswerToolActivity } from "../cards/final-answer-content.js";

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

interface LarkMarkdownPageDiagnostics {
  sourceCharactersIndexed: number;
  sourceCharactersRendered: number;
  rangeRenderCount: number;
}

interface LarkMarkdownPageOptions {
  onDiagnostics?: (diagnostics: LarkMarkdownPageDiagnostics) => void;
}

interface MarkdownBlock {
  kind: "prose" | "code" | "table" | "diff";
  start: number;
  end: number;
  opening?: string;
  marker?: string;
  closed?: boolean;
  requiresPrefixNormalization?: boolean;
}

interface MarkdownPageIndex {
  lines: Array<{ start: number; end: number; text: string }>;
  blocks: MarkdownBlock[];
  toolActivities: ToolActivityRange[];
}

interface ToolActivityRange {
  start: number;
  contentEnd: number;
  boundaryEnd: number;
  renderedLength: number;
  boundaryRenderedLength: number;
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
  return renderLarkMarkdownPageMode(source, pageStart, limit, true);
}

/** Renders one page and reserves a suffix only when the source actually overflows. */
export function renderLarkMarkdownPageWithSuffix(source: string, pageStart: number, limit: number, suffix: string): RenderedLarkMarkdownPage {
  return renderLarkMarkdownPageMode(source, pageStart, limit, true, suffix);
}

/** @internal Test-only work characterization; production render APIs stay pure. */
export function renderLarkMarkdownPageForTest(source: string, pageStart: number, limit: number): { result: RenderedLarkMarkdownPage; diagnostics: LarkMarkdownPageDiagnostics } {
  let diagnostics: LarkMarkdownPageDiagnostics | null = null;
  const result = renderLarkMarkdownPageMode(source, pageStart, limit, true, "", { onDiagnostics: (value) => { diagnostics = value; } });
  if (!diagnostics) throw new Error("Markdown renderer did not report diagnostics");
  return { result, diagnostics };
}

/** Renders one proven canonical range with safe Markdown normalization and command detail. */
export function renderDetailedLarkMarkdownRange(source: string, pageStart: number, pageEnd: number): string {
  const start = Math.max(0, Math.min(pageStart, source.length));
  const end = Math.max(start, Math.min(pageEnd, source.length));
  return renderDetailedMarkdownRange(source, start, end);
}

function renderLarkMarkdownPageMode(source: string, pageStart: number, limit: number, compactTools: boolean, continuationSuffix = "", options: LarkMarkdownPageOptions = {}): RenderedLarkMarkdownPage {
  const start = Math.max(0, Math.min(pageStart, source.length));
  const boundedLimit = Math.max(0, limit);
  const index = markdownPageIndex(source);
  const blocks = index.blocks;
  const suffix = boundedLimit > continuationSuffix.length ? continuationSuffix : "";
  const pageLimit = boundedLimit - suffix.length;
  const selected = selectIndexedPageEnd(source, start, pageLimit, boundedLimit, index);
  if (!selected.overflow) return renderIndexedPage(source, start, source.length, null, blocks, compactTools, options);
  if (selected.end !== null) return renderIndexedPage(source, start, selected.end, selected.end, blocks, compactTools, options, suffix);
  const hardEnd = hardProgressEnd(source, start, pageLimit, blocks);
  const page = renderPageRange(source, start, hardEnd, blocks, compactTools).slice(0, pageLimit);
  options.onDiagnostics?.({ sourceCharactersIndexed: source.length, sourceCharactersRendered: hardEnd - start, rangeRenderCount: 1 });
  return { page: `${page}${suffix}`, nextPageStart: hardEnd < source.length ? hardEnd : null };
}

function renderIndexedPage(source: string, start: number, end: number, nextPageStart: number | null, blocks: readonly MarkdownBlock[], compactTools: boolean, options: LarkMarkdownPageOptions, suffix = ""): RenderedLarkMarkdownPage {
  const page = renderPageRange(source, start, end, blocks, compactTools);
  options.onDiagnostics?.({ sourceCharactersIndexed: source.length, sourceCharactersRendered: end - start, rangeRenderCount: 1 });
  return { page: `${page}${suffix}`, nextPageStart };
}

function renderPageRange(source: string, start: number, end: number, blocks: readonly MarkdownBlock[], compactTools: boolean): string {
  const detailed = renderDetailedMarkdownRange(source, start, end, blocks);
  return compactTools ? compactAnswerToolActivity(detailed) : detailed;
}

function hardProgressEnd(source: string, start: number, pageLimit: number, blocks: readonly MarkdownBlock[]): number {
  const block = blocks[firstOverlappingBlock(blocks, start)];
  if (block?.requiresPrefixNormalization) {
    const hidden = htmlHiddenRange(source, block.start, block.end);
    if (hidden) {
      if (start < hidden.start) return Math.min(hidden.start, start + Math.max(1, pageLimit));
      if (start < hidden.end) return hidden.end;
    }
  }
  let overhead = 0;
  if (block?.kind === "table") overhead = 12;
  else if (block?.kind === "diff") overhead = 12;
  else if (block?.kind === "code") {
    overhead = (start > block.start ? (block.opening?.length ?? 0) + 1 : 0) + 1 + (block.marker?.length ?? 0);
  }
  return Math.min(source.length, block?.end ?? source.length, start + Math.max(1, pageLimit - overhead));
}

function htmlHiddenRange(source: string, start: number, end: number): { start: number; end: number } | null {
  const slice = source.slice(start, end);
  const opening = /<!--|<(script|style)\b[^>]*>/i.exec(slice);
  if (!opening) return null;
  const hiddenStart = start + opening.index;
  if (opening[0] === "<!--") {
    const closing = source.indexOf("-->", hiddenStart + opening[0].length);
    return { start: hiddenStart, end: closing < 0 || closing >= end ? end : closing + 3 };
  }
  const closingPattern = new RegExp(`</${opening[1]!}\\s*>`, "ig");
  closingPattern.lastIndex = hiddenStart + opening[0].length;
  const closing = closingPattern.exec(source);
  return { start: hiddenStart, end: !closing || closing.index >= end ? end : closing.index + closing[0].length };
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
  let value = protectInlineCode(source, (match) => {
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

function protectInlineCode(source: string, protect: (match: string) => string): string {
  let output = "";
  let cursor = 0;
  while (cursor < source.length) {
    const opening = source.indexOf("`", cursor);
    if (opening < 0) { output += source.slice(cursor); break; }
    output += source.slice(cursor, opening);
    let markerEnd = opening + 1;
    while (source[markerEnd] === "`") markerEnd += 1;
    const marker = source.slice(opening, markerEnd);
    const lineEnd = source.indexOf("\n", markerEnd);
    const searchEnd = lineEnd < 0 ? source.length : lineEnd;
    let closing = source.indexOf(marker, markerEnd);
    while (closing >= 0 && closing < searchEnd && (source[closing - 1] === "`" || source[closing + marker.length] === "`")) {
      closing = source.indexOf(marker, closing + 1);
    }
    if (closing < 0 || closing >= searchEnd) {
      output += marker;
      cursor = markerEnd;
      continue;
    }
    const end = closing + marker.length;
    output += protect(source.slice(opening, end));
    cursor = end;
  }
  return output;
}

function renderDetailedMarkdownRange(source: string, start: number, end: number, blocks: readonly MarkdownBlock[] = markdownBlocks(source)): string {
  return renderToolActivityResults(renderMarkdownRange(source, start, end, blocks));
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

function renderMarkdownRange(source: string, start: number, end: number, blocks: readonly MarkdownBlock[] = markdownBlocks(source)): string {
  const output: string[] = [];
  for (let index = firstOverlappingBlock(blocks, start); index < blocks.length; index += 1) {
    const block = blocks[index]!;
    if (block.start >= end) break;
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

function firstOverlappingBlock(blocks: readonly MarkdownBlock[], start: number): number {
  let low = 0;
  let high = blocks.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (blocks[middle]!.end <= start) low = middle + 1;
    else high = middle;
  }
  return low;
}

function markdownBlocks(source: string): MarkdownBlock[] {
  return markdownBlocksFromLines(sourceLines(source));
}

function markdownBlocksFromLines(lines: Array<{ start: number; end: number; text: string }>): MarkdownBlock[] {
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
    const htmlEnd = htmlSensitiveEnd(lines, index);
    if (htmlEnd !== null) {
      blocks.push({ kind: "prose", start: line.start, end: lines[htmlEnd - 1]!.end, requiresPrefixNormalization: true });
      index = htmlEnd;
      continue;
    }
    let cursor = index + 1;
    while (cursor < lines.length) {
      if (FENCE.test(lines[cursor]!.text)) break;
      if (cursor + 1 < lines.length && isTableRow(lines[cursor]!.text) && TABLE_DELIMITER.test(lines[cursor + 1]!.text)) break;
      if (traexDiffEnd(lineTexts, cursor) !== null) break;
      if (htmlSensitiveEnd(lines, cursor) !== null) break;
      cursor += 1;
    }
    const start = line.start;
    const end = lines[cursor - 1]!.end;
    blocks.push({ kind: "prose", start, end });
    index = cursor;
  }
  return blocks;
}

function markdownPageIndex(source: string): MarkdownPageIndex {
  const lines = sourceLines(source);
  const blocks = markdownBlocksFromLines(lines);
  const toolActivities = parseToolActivityRanges(source, lines);
  return { lines, blocks, toolActivities };
}

function selectIndexedPageEnd(source: string, start: number, pageLimit: number, fullLimit: number, index: MarkdownPageIndex): { end: number | null; overflow: boolean } {
  let consumed = 0;
  let selectedEnd: number | null = null;
  let lineIndex = firstLineEndingAfter(index.lines, start);
  let toolIndex = firstToolActivityEndingAfter(index.toolActivities, start);
  for (let blockIndex = firstOverlappingBlock(index.blocks, start); blockIndex < index.blocks.length; blockIndex += 1) {
    const block = index.blocks[blockIndex]!;
    const from = Math.max(start, block.start);
    if (block.requiresPrefixNormalization) {
      const length = consumed + normalizeProse(source.slice(from, block.end).replace(/\r\n?/g, "\n")).length;
      if (length > fullLimit) return { end: selectedEnd, overflow: true };
      consumed = length;
      if (length <= pageLimit && block.end < source.length) selectedEnd = block.end;
      lineIndex = firstLineEndingAfter(index.lines, block.end);
      continue;
    }
    let blockLength = 0;
    while (lineIndex < index.lines.length && index.lines[lineIndex]!.end <= from) lineIndex += 1;
    for (; lineIndex < index.lines.length && index.lines[lineIndex]!.start < block.end; lineIndex += 1) {
      const line = index.lines[lineIndex]!;
      const lineStart = Math.max(from, line.start);
      const end = Math.min(line.end, block.end);
      while (toolIndex < index.toolActivities.length && index.toolActivities[toolIndex]!.boundaryEnd <= lineStart) toolIndex += 1;
      const tool = index.toolActivities[toolIndex];
      let candidateEnd = end;
      if (tool && tool.start === lineStart && tool.renderedLength <= pageLimit) {
        blockLength += tool.boundaryRenderedLength;
        candidateEnd = tool.boundaryEnd;
        lineIndex = firstLineEndingAfter(index.lines, tool.boundaryEnd) - 1;
        toolIndex += 1;
      } else {
        blockLength += blockLineRenderedLength(source, block, lineStart, end, lineStart === from, end === block.end);
      }
      const length = consumed + blockLength + candidateClosureLength(source, block, candidateEnd);
      if (length > fullLimit) return { end: selectedEnd, overflow: true };
      if (length <= pageLimit && candidateEnd < source.length) selectedEnd = candidateEnd;
    }
    consumed += blockLength;
  }
  return { end: selectedEnd, overflow: false };
}

function firstLineEndingAfter(lines: MarkdownPageIndex["lines"], offset: number): number {
  let low = 0;
  let high = lines.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (lines[middle]!.end <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function firstToolActivityEndingAfter(activities: MarkdownPageIndex["toolActivities"], offset: number): number {
  let low = 0;
  let high = activities.length;
  while (low < high) {
    const middle = Math.floor((low + high) / 2);
    if (activities[middle]!.boundaryEnd <= offset) low = middle + 1;
    else high = middle;
  }
  return low;
}

function parseToolActivityRanges(source: string, lines: MarkdownPageIndex["lines"]): ToolActivityRange[] {
  const activities: ToolActivityRange[] = [];
  for (let index = 0; index < lines.length;) {
    const heading = /^◆ \*\*Ran\*\*(?: · (.+))?$/.exec(lines[index]!.text);
    if (!heading) { index += 1; continue; }
    const startIndex = index;
    index += 1;
    while (index < lines.length && lines[index]!.text === "") index += 1;
    if (lines[index]?.text !== "```bash") { index = startIndex + 1; continue; }
    index += 1;
    const commandIndex = index;
    while (index < lines.length && lines[index]!.text !== "```") index += 1;
    if (index >= lines.length) break;
    if (index !== commandIndex + 1 || !lines[commandIndex]!.text) { index = startIndex + 1; continue; }
    let endIndex = index++;
    const afterBash = index;
    let outputStart: number | null = null;
    let outputEnd: number | null = null;
    while (index < lines.length && lines[index]!.text === "") index += 1;
    if (lines[index]?.text === "```text") {
      outputStart = ++index;
      while (index < lines.length && lines[index]!.text !== "```") index += 1;
      if (index < lines.length) { outputEnd = index; endIndex = index++; }
      else index = afterBash;
    } else index = afterBash;
    const start = lines[startIndex]!.start;
    const endLine = lines[endIndex]!;
    const contentEnd = endLine.end - (source[endLine.end - 1] === "\n" ? 1 : 0) - (source[endLine.end - 2] === "\r" ? 1 : 0);
    const boundaryEnd = endLine.end;
    const renderedLength = toolActivityRenderedLength(lines, startIndex, endIndex, outputStart, outputEnd);
    const boundaryRenderedLength = renderedLength + (boundaryEnd - contentEnd);
    activities.push({ start, contentEnd, boundaryEnd, renderedLength, boundaryRenderedLength });
  }
  return activities;
}

function toolActivityRenderedLength(lines: MarkdownPageIndex["lines"], startIndex: number, endIndex: number, outputStart: number | null, outputEnd: number | null): number {
  const rendered = lines.slice(startIndex, endIndex + 1).map(({ text }) => text);
  rendered[0] = normalizeProse(rendered[0]!);
  if (outputStart !== null && outputEnd !== null && outputEnd - outputStart > TOOL_RESULT_LINE_LIMIT) {
    const relativeStart = outputStart - startIndex;
    const detail = rendered.slice(relativeStart, outputEnd - startIndex);
    rendered.splice(relativeStart, detail.length,
      ...detail.slice(0, TOOL_RESULT_HEAD_LINES),
      `… 已省略中间 ${detail.length - TOOL_RESULT_HEAD_LINES - TOOL_RESULT_TAIL_LINES} 行 …`,
      ...detail.slice(-TOOL_RESULT_TAIL_LINES));
  }
  return rendered.reduce((length, line, index) => length + line.length + (index < rendered.length - 1 ? 1 : 0), 0);
}

function blockLineRenderedLength(source: string, block: MarkdownBlock, from: number, to: number, firstSlice: boolean, finalSlice: boolean): number {
  const raw = source.slice(from, to).replace(/\r\n?/g, "\n");
  const rawLength = block.kind === "prose" ? normalizeProse(raw).length : raw.length;
  if (block.kind === "prose") return rawLength;
  const trailingNewline = source[to - 1] === "\n";
  if (block.kind === "table" || block.kind === "diff") {
    const language = block.kind === "diff" ? "diff" : "text";
    const prefixLength = firstSlice ? language.length + 4 : 0;
    const suffixLength = finalSlice ? 4 + (trailingNewline ? 1 : 0) : 0;
    return prefixLength + rawLength - (finalSlice && trailingNewline ? 1 : 0) + suffixLength;
  }
  const prefixLength = firstSlice && from > block.start ? (block.opening?.length ?? 0) + 1 : 0;
  const needsClosure = finalSlice && (to < block.end || block.closed !== true);
  const suffixLength = needsClosure ? (trailingNewline ? 0 : 1) + (block.marker?.length ?? 0) : 0;
  return prefixLength + rawLength + suffixLength;
}

function candidateClosureLength(source: string, block: MarkdownBlock, end: number): number {
  if (end >= block.end) return 0;
  if (block.kind === "table" || block.kind === "diff") return 4;
  if (block.kind !== "code") return 0;
  return (source[end - 1] === "\n" ? 0 : 1) + (block.marker?.length ?? 0);
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

function htmlSensitiveEnd(lines: MarkdownPageIndex["lines"], start: number): number | null {
  const opening = /<!--|<(script|style)\b/i.exec(lines[start]?.text ?? "");
  if (!opening) return null;
  const kind = opening[0] === "<!--" ? "comment" : opening[1]!.toLowerCase();
  const closing = kind === "comment" ? "-->" : `</${kind}`;
  for (let index = start; index < lines.length; index += 1) {
    const searchStart = index === start ? opening.index + opening[0].length : 0;
    if (lines[index]!.text.toLowerCase().indexOf(closing, searchStart) >= 0) return index + 1;
  }
  return lines.length;
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
