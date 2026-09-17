import type { AgentKind } from "./agent-instance.js";

export type ProjectSelectionState = "pending" | "processing" | "completed" | "failed" | "expired";
export interface ProjectSelection {
  id: string; commandMessageId: string; selectorMessageId: string | null; chatId: string; topicId: string | null;
  rootMessageId: string; actorOpenId: string; requestedTitle: string | null; initialPromptText: string | null; agentKind: AgentKind;
  selectedProjectId: string | null; bindingId: string | null; state: ProjectSelectionState; error: string | null;
  expiresAt: string; createdAt: string; updatedAt: string;
}
export type ProjectSelectionClaim =
  | { outcome: "claimed" | "processing" | "completed"; selection: ProjectSelection }
  | { outcome: "missing" | "invalid" | "unauthorized" | "expired"; selection: ProjectSelection | null };
