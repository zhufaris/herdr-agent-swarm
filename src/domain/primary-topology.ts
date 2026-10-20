import type { AgentState } from "./runtime-observation.js";
import type { BindingKind } from "./binding.js";

export interface PrimaryTopologySpace {
  projectId: string;
  displayName: string;
  description: string;
  spaceName: string;
  workspaceId: string;
  directories: string[];
}

export type PrimaryTopologyPaneOwnership =
  | { kind: "binding"; bindingId: string; bindingKind: BindingKind; generation: number }
  | { kind: "worker"; instanceId: string; workerName: string; generation: number };

export interface PrimaryTopologyPane {
  paneId: string;
  paneToken: string | null;
  name: string;
  workspaceId: string;
  cwd: string | null;
  agentKind: string | null;
  agentState: AgentState;
  foregroundExecutables: string[];
  ownership: PrimaryTopologyPaneOwnership | null;
}

export interface PrimaryTopologyQueryPort {
  listSpaces(projectId: string): PrimaryTopologySpace[];
  listPanes(projectId: string): Promise<PrimaryTopologyPane[]>;
}
