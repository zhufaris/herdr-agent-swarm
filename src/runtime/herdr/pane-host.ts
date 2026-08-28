import type { HerdrPort } from "../../domain/ports.js";
import type { HerdrPane, HerdrPaneCreationOptions } from "../../domain/types.js";

export interface PaneHost {
  ensureWorkspace(workspaceId: string): Promise<void>;
  listPanes(workspaceId: string): Promise<HerdrPane[]>;
  allocatePane(workspaceId: string, cwd: string, options: HerdrPaneCreationOptions): Promise<HerdrPane>;
  inspectPane(paneId: string): Promise<HerdrPane | null>;
  readPane(paneId: string, lines: number): Promise<string>;
  interruptPane(paneId: string): Promise<void>;
  releasePane(paneId: string): Promise<void>;
}

export class HerdrPaneHost implements PaneHost {
  constructor(private readonly herdr: HerdrPort) {}

  ensureWorkspace(workspaceId: string): Promise<void> { return this.herdr.assertWorkspace(workspaceId); }
  listPanes(workspaceId: string): Promise<HerdrPane[]> { return this.herdr.listPanes(workspaceId); }
  allocatePane(workspaceId: string, cwd: string, options: HerdrPaneCreationOptions): Promise<HerdrPane> {
    return this.herdr.createPane(workspaceId, cwd, options);
  }
  inspectPane(paneId: string): Promise<HerdrPane | null> { return this.herdr.getPane(paneId); }
  readPane(paneId: string, lines: number): Promise<string> { return this.herdr.readOutput(paneId, lines); }
  interruptPane(paneId: string): Promise<void> {
    if (!this.herdr.sendEscape) throw new Error("Herdr pane interruption is unavailable");
    return this.herdr.sendEscape(paneId);
  }
  releasePane(paneId: string): Promise<void> { return this.herdr.closePane(paneId); }
}
