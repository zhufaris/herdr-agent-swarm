export const PROMPT_QUEUE_FULL_MESSAGE = "This topic's prompt queue is full";

export class PromptCapacityExceeded extends Error {
  constructor() {
    super(PROMPT_QUEUE_FULL_MESSAGE);
    this.name = "PromptCapacityExceeded";
  }
}

export function isPromptCapacityExceeded(error: unknown): error is PromptCapacityExceeded {
  return error instanceof PromptCapacityExceeded;
}
