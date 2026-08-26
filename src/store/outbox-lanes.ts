import type { OutboundReplyKind, RequestCardRole } from "../domain/types.js";

export function outboundLaneKeySql(): string {
  return "CASE WHEN card_role = 'answer' AND prompt_id IS NOT NULL THEN 'answer:' || prompt_id WHEN kind IN ('stream_content','stream_finish') THEN 'stream:' || root_message_id ELSE 'message:' || root_message_id END";
}

export function outboundLaneKey(input: { cardRole?: RequestCardRole | null; promptId?: string | null; kind: OutboundReplyKind; rootMessageId: string }): string {
  if (input.cardRole === "answer" && input.promptId) return `answer:${input.promptId}`;
  if (input.kind === "stream_content" || input.kind === "stream_finish") return `stream:${input.rootMessageId}`;
  return `message:${input.rootMessageId}`;
}
