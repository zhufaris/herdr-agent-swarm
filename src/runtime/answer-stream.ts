export const ANSWER_STREAM_PAGE_LIMIT = 28_000;

export function splitAnswerStreamPage(content: string, limit = ANSWER_STREAM_PAGE_LIMIT): { page: string; remainder: string } {
  if (content.length <= limit) return { page: content, remainder: "" };
  const newline = content.lastIndexOf("\n", limit);
  const boundary = newline > Math.floor(limit * 0.6) ? newline : limit;
  const separator = content[boundary] === "\n" ? 1 : 0;
  return { page: content.slice(0, boundary), remainder: content.slice(boundary + separator) };
}
