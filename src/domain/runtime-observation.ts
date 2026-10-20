import type { PaneIdentityRole } from "./pane-title.js";

export type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";
export interface HerdrAgentSession { source: string; agent: string; kind: "id" | "path"; value: string }
export interface HerdrActiveTurn { turnId: string; startedAt?: string | null }
export interface HerdrPane { paneId: string; paneToken?: string | null; paneName?: string | null; tabId?: string | null; tabLabel?: string | null; terminalId?: string | null; agentSession?: HerdrAgentSession | null; agentKind?: string | null; steeringCapability?: "native" | "terminal-input" | "unsupported"; activeTurnId?: string | null; outputRevision?: number | null; stateChangeSeq?: number | null; workspaceId: string; cwd: string | null; foregroundCwd?: string | null; label: string | null; agentState: AgentState; foregroundExecutables: string[] }
export interface RuntimeObservation { pane: HerdrPane | null; traexProcess: boolean; composerReady: boolean; evidenceSource: "structured" | "process" | "none"; processProbe?: "observed" | "unavailable" }
export interface RuntimeTurnObservation { state: AgentState; stateSource: "structured" | "unknown" }
export interface SemanticSnapshotCursor { epoch: number; generation: number }
export interface RemovedPaneIdentity { paneId: string; workspaceId: string }
export interface SemanticWorkspaceSnapshot { workspaceId: string; panes: HerdrPane[] }
export type SemanticPaneSnapshotRead =
  | { kind: "current"; cursor: SemanticSnapshotCursor }
  | { kind: "rebuild-required"; cursor: SemanticSnapshotCursor; panes: HerdrPane[] }
  | { kind: "delta"; cursor: SemanticSnapshotCursor; added: HerdrPane[]; changed: HerdrPane[]; removed: RemovedPaneIdentity[]; workspaces: SemanticWorkspaceSnapshot[] };
export interface HerdrPaneCreationOptions { bindingId: string; generation: number; projectId: string; placement?: "split" | "dedicated-tab"; anchorPaneId?: string; displayIdentity?: { groupToken?: string; role: PaneIdentityRole }; title?: string; titlePolicy?: "lark-prefixed" | "complete"; environment?: Record<string, string> }
