export type PaneTopologyOwnerFence =
  | { kind: "primary"; id: string; generation: number; sessionGeneration: number }
  | {
      kind: "worker"; id: string; generation: number; sessionGeneration: number;
      parent: { id: string; generation: number; sessionGeneration: number; paneId: string };
    };

export interface PaneTopologyRuntimeIdentity {
  workspaceId: string;
  paneId: string;
  terminalId: string;
  agentSessionId: string;
  tabId: string;
  paneLabel: string;
  tabLabel: string;
}

export interface PaneTopologyTarget {
  tabId: string;
  anchorPaneId: string;
  paneLabel: string;
  tabLabel: string;
}

export type PaneTopologyIntentState = "pending" | "executing" | "uncertain" | "succeeded" | "stale";

export interface PaneTopologyIntent {
  id: string;
  idempotencyKey: string;
  owner: PaneTopologyOwnerFence;
  expected: PaneTopologyRuntimeIdentity;
  desired: PaneTopologyTarget;
  state: PaneTopologyIntentState;
  attemptCount: number;
  resultPreviousPaneId: string | null;
  resultPaneId: string | null;
  resultTabId: string | null;
  detail: string | null;
  createdAt: string;
  updatedAt: string;
  completedAt: string | null;
}

export interface ReservePaneTopologyIntentInput {
  id: string;
  idempotencyKey: string;
  owner: PaneTopologyOwnerFence;
  expected: PaneTopologyRuntimeIdentity;
  desired: PaneTopologyTarget;
}

export interface PaneTopologyMoveReceipt {
  previousPaneId: string;
  paneId: string;
  paneToken?: string | null;
  tabId: string;
  workspaceId: string;
}

export interface PaneTopologyMoveRequest {
  paneId: string;
  targetTabId: string;
  targetAnchorPaneId: string;
  paneLabel: string;
  tabLabel: string;
}

export interface PaneTopologyLabelRequest {
  workspaceId: string;
  paneId: string;
  paneToken?: string | null;
  tabId: string;
  paneLabel: string;
  tabLabel: string;
}
