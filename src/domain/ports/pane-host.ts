import type { HerdrPane, HerdrPaneCreationOptions } from "../types.js";

export interface PaneHost {
  ensureWorkspace(workspaceId: string): Promise<void>;
  listPanes(workspaceId: string): Promise<HerdrPane[]>;
  allocatePane(workspaceId: string, cwd: string, options: HerdrPaneCreationOptions): Promise<HerdrPane>;
  inspectPane(paneId: string): Promise<HerdrPane | null>;
  snapshotPanes?(): Promise<HerdrPane[]>;
  interruptPane(paneId: string): Promise<void>;
  releasePane(paneId: string): Promise<void>;
}
