const FENCE = /^ {0,3}(`{3,})([^`]*)$/;
const TABLE_DELIMITER = /^\s*\|?\s*:?-{3,}:?\s*(?:\|\s*:?-{3,}:?\s*)+\|?\s*$/;
const TRUNCATION_MARKER = "…（内容已截断）";

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
