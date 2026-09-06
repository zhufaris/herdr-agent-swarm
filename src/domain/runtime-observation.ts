export type AgentState = "idle" | "working" | "blocked" | "done" | "unknown";
export interface HerdrAgentSession { source: string; agent: string; kind: "id" | "path"; value: string }
export interface HerdrPane { paneId: string; tabId?: string | null; terminalId?: string | null; agentSession?: HerdrAgentSession | null; agentKind?: string | null; steeringCapability?: "native" | "terminal-input" | "unsupported"; activeTurnId?: string | null; outputRevision?: number | null; stateChangeSeq?: number | null; workspaceId: string; cwd: string | null; foregroundCwd?: string | null; label: string | null; agentState: AgentState; foregroundExecutables: string[] }
export interface RuntimeObservation { pane: HerdrPane | null; traexProcess: boolean; composerReady: boolean; evidenceSource: "structured" | "process" | "none" }
export interface RuntimeTurnObservation { state: AgentState; stateSource: "structured" | "unknown" }
export interface HerdrPaneCreationOptions { bindingId: string; generation: number; projectId: string; placement?: "split" | "dedicated-tab"; title?: string; titlePolicy?: "lark-prefixed" | "complete"; environment?: Record<string, string> }
