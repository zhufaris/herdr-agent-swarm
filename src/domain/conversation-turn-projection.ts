import { createHash } from "node:crypto";
import type { RunCardView } from "./run-card-view.js";

export interface ConversationTurnIdentity {
  agentKind: "traex" | "pi";
  sessionId: string;
  turnId: string;
  startedAt: string;
}

export interface ConversationTurnProjection extends ConversationTurnIdentity {
  projectionId: string;
  origin: "herdr" | "feishu";
  bindingId: string;
  bindingGeneration: number;
  paneId: string;
  view: RunCardView;
}

export function conversationTurnProjectionId(identity: ConversationTurnIdentity): string {
  const digest = createHash("sha256").update(JSON.stringify(identity)).digest("hex");
  return `conversation-turn:v1:${digest}`;
}
