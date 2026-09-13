import type { IncomingLarkMessage } from "../adapters/lark-ingress.js";

/**
 * Durable inbound work is FIFO within the Lark conversation where it was sent.
 * A retryable failure in one conversation must not prevent unrelated topics or
 * root conversations from accepting their own work.
 */
export function inboundMessageScopeKey(message: Pick<IncomingLarkMessage, "topicId" | "rootMessageId" | "messageId">): string {
  if (message.topicId) return `topic:${message.topicId}`;
  if (message.rootMessageId) return `root:${message.rootMessageId}`;
  return `message:${message.messageId}`;
}
