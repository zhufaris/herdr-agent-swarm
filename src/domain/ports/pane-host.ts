import type { HerdrPane, HerdrPaneCreationOptions } from "../types.js";
import type { PaneTopologyLabelRequest, PaneTopologyMoveReceipt, PaneTopologyMoveRequest } from "../pane-topology-intent.js";

export interface PaneHost {
  ensureWorkspace(workspaceId: string): Promise<void>;
  listPanes(workspaceId: string): Promise<HerdrPane[]>;
  allocatePane(workspaceId: string, cwd: string, options: HerdrPaneCreationOptions): Promise<HerdrPane>;
  movePane(input: PaneTopologyMoveRequest): Promise<PaneTopologyMoveReceipt>;
  labelPane(input: PaneTopologyLabelRequest): Promise<PaneTopologyMoveReceipt>;
  inspectPane(paneId: string): Promise<HerdrPane | null>;
  snapshotPanes?(): Promise<HerdrPane[]>;
  interruptPane(paneId: string): Promise<void>;
  releasePane(paneId: string): Promise<void>;
}
