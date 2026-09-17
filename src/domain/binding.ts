import type { AttachmentState, ProvisioningCheckpoint, SessionLifecycle } from "./pane-thread-lifecycle.js";
import type { AgentState } from "./runtime-observation.js";
import type { AgentKind } from "./agent-instance.js";

export type BindingState = "pending" | "active" | "archived" | "orphaned" | "failed";
export interface Binding {
  id: string; gatewayId: string; creatorOpenId: string | null; projectId: string | null; workspaceId: string; chatId: string; topicId: string | null;
  rootMessageId: string | null; retiredTopicId: string | null; retiredRootMessageId: string | null; replacesBindingId: string | null;
  reservedTopicId: string | null; reservedRootMessageId: string | null; resetMessageId: string | null; paneId: string | null; traexSessionId: string | null;
  agentSessionSource?: string | null; agentSessionAgent?: string | null; agentSessionKind?: "id" | "path" | null; agentSessionValue?: string | null;
  title: string; agentKind: AgentKind; state: BindingState; statusMessageId: string | null; statusCardSequence: number; lastAgentState: AgentState;
  lastOutputFingerprint: string | null; lifecycle: SessionLifecycle; attachment: AttachmentState; generation: number; provisioningCheckpoint: ProvisioningCheckpoint;
  degradationCount: number; hasCompletedTurn: boolean; lastObservedAt: string | null; archivedAt: string | null; lastActivityAt: string; createdAt: string; updatedAt: string;
}
export type BindingMetadataPatch = Partial<Pick<Binding,
  | "gatewayId" | "projectId" | "topicId" | "rootMessageId" | "retiredTopicId" | "retiredRootMessageId"
  | "reservedTopicId" | "reservedRootMessageId" | "resetMessageId" | "paneId" | "traexSessionId"
  | "agentSessionSource" | "agentSessionAgent" | "agentSessionKind" | "agentSessionValue"
  | "title" | "statusMessageId" | "lastOutputFingerprint" | "lastActivityAt"
>>;
