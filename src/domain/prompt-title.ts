const MAX_PROMPT_TITLE_LENGTH = 64;
const EMPTY_PROMPT_TITLE = "TraeX request";

/** Compact, presentation-safe label for a durable prompt without changing its body. */
export function formatPromptTitle(body: string): string {
  const normalized = body.replace(/\s+/g, " " ).trim();
  return normalized.length > MAX_PROMPT_TITLE_LENGTH
    ? normalized.slice(0, MAX_PROMPT_TITLE_LENGTH - 1) + "…"
    : normalized || EMPTY_PROMPT_TITLE;
}
