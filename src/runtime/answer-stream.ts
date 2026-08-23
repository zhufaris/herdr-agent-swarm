export const ANSWER_STREAM_PAGE_LIMIT = 28_000;

const FENCE = /^ {0,3}(`{3,})([A-Za-z0-9_+.-]{0,32})\s*$/;

export interface RenderedAnswerStreamPage {
  page: string;
  nextPageStart: number | null;
}

/** Builds a render-safe page without changing the canonical Answer stream. */
export function renderAnswerStreamPage(content: string, pageStart: number, limit = ANSWER_STREAM_PAGE_LIMIT): RenderedAnswerStreamPage {
  const start = Math.max(0, Math.min(pageStart, content.length));
  const inheritedFence = openFence(content.slice(0, start));
  const prefix = inheritedFence ? `${inheritedFence.opening}\n` : "";
  const available = Math.max(0, limit - prefix.length);
  const remaining = content.slice(start);
  let rawLength = Math.min(remaining.length, available);

  if (rawLength < remaining.length) {
    const newline = remaining.lastIndexOf("\n", rawLength);
    if (newline >= 0) rawLength = newline + 1;
  }

  let raw = remaining.slice(0, rawLength);
  let activeFence = openFence(`${prefix}${raw}`);
  let suffix = activeFence ? `${raw.endsWith("\n") ? "" : "\n"}${activeFence.marker}` : "";
  while (prefix.length + raw.length + suffix.length > limit && raw.length) {
    const newline = raw.lastIndexOf("\n", raw.endsWith("\n") ? raw.length - 2 : raw.length - 1);
    rawLength = newline >= 0 ? newline + 1 : Math.max(0, rawLength - (prefix.length + raw.length + suffix.length - limit));
    raw = remaining.slice(0, rawLength);
    activeFence = openFence(`${prefix}${raw}`);
    suffix = activeFence ? `${raw.endsWith("\n") ? "" : "\n"}${activeFence.marker}` : "";
  }

  if (rawLength >= remaining.length) return { page: `${prefix}${raw}${suffix}`, nextPageStart: null };
  return { page: `${prefix}${raw}${suffix}`, nextPageStart: start + rawLength };
}

export function splitAnswerStreamPage(content: string, limit = ANSWER_STREAM_PAGE_LIMIT): { page: string; remainder: string } {
  if (content.length <= limit) return { page: content, remainder: "" };
  const newline = content.lastIndexOf("\n", limit);
  const boundary = newline > Math.floor(limit * 0.6) ? newline : limit;
  const separator = content[boundary] === "\n" ? 1 : 0;
  return { page: content.slice(0, boundary), remainder: content.slice(boundary + separator) };
}

function openFence(source: string): { marker: string; opening: string } | null {
  let active: { marker: string; opening: string } | null = null;
  for (const line of source.split("\n")) {
    if (!active) {
      const opening = FENCE.exec(line);
      if (opening) active = { marker: opening[1]!, opening: line };
      continue;
    }
    const trimmed = line.trim();
    if (trimmed.length >= active.marker.length && /^`+$/.test(trimmed)) active = null;
  }
  return active;
}
