import type { OutboundReplyKind, RequestCardRole } from "../domain/types.js";

export function outboundLaneKeySql(workerTurnIdExpression = "worker_turn_id"): string {
  return `CASE WHEN ${workerTurnIdExpression} IS NOT NULL THEN 'worker-turn:' || ${workerTurnIdExpression} WHEN card_role = 'answer' AND prompt_id IS NOT NULL THEN 'answer:' || prompt_id WHEN kind IN ('stream_content','stream_finish') THEN 'stream:' || root_message_id WHEN kind IN ('card_reply','text') THEN 'reply:' || id ELSE 'message:' || root_message_id END`;
}

export function outboundLaneKey(input: { id?: string; cardRole?: RequestCardRole | null; promptId?: string | null; workerTurnId?: string | null; kind: OutboundReplyKind; rootMessageId: string }): string {
  if (input.workerTurnId) return `worker-turn:${input.workerTurnId}`;
  if (input.cardRole === "answer" && input.promptId) return `answer:${input.promptId}`;
  if (input.kind === "stream_content" || input.kind === "stream_finish") return `stream:${input.rootMessageId}`;
  if (input.kind === "card_reply" || input.kind === "text") {
    if (!input.id) throw new Error(`Independent ${input.kind} requires an outbound reply id`);
    return `reply:${input.id}`;
  }
  return `message:${input.rootMessageId}`;
}
