export const MAX_PROMPT_INPUT_CHARS = 12_000;
export const MAX_PROMPT_INPUT_BYTES = 32 * 1_024;
export type PromptInputTooLargeCode = "prompt_input_too_large";

export class PromptInputTooLargeError extends Error {
  readonly code: PromptInputTooLargeCode = "prompt_input_too_large";
  constructor() {
    super(`Prompt input exceeds ${MAX_PROMPT_INPUT_CHARS} characters or 32 KiB`);
    this.name = "PromptInputTooLargeError";
  }
}

export function isPromptInputTooLarge(value: string): boolean {
  return value.length > MAX_PROMPT_INPUT_CHARS || Buffer.byteLength(value, "utf8") > MAX_PROMPT_INPUT_BYTES;
}

export function compactPromptInput(value: string): { text: string; inputTooLarge: boolean } {
  const inputTooLarge = isPromptInputTooLarge(value);
  return { text: inputTooLarge ? "" : value, inputTooLarge };
}

export function assertPromptInputSize(value: string): void {
  if (isPromptInputTooLarge(value)) throw new PromptInputTooLargeError();
}

export function isPromptInputTooLargeError(error: unknown): error is PromptInputTooLargeError { return error instanceof PromptInputTooLargeError; }
