import type { Logger } from "pino";
import type { HerdrPort } from "../domain/ports.js";
import type { HerdrPane, HerdrPaneCreationOptions, RuntimeObservation, WorkspaceCacheStatus } from "../domain/types.js";
import { safeLogError } from "./safe-error.js";

interface Snapshot { panes: HerdrPane[]; capturedAt: number }

export class WorkspaceSnapshotCache implements HerdrPort {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly refreshes = new Map<string, Promise<HerdrPane[]>>();
  private allRefresh: Promise<HerdrPane[]> | null = null;
  private allSnapshot: Snapshot | null = null;
  private hits = 0;
  private misses = 0;
  private coalescedRefreshes = 0;
  private refreshFailures = 0;

  constructor(
    private readonly delegate: HerdrPort,
    private readonly ttlMs = 2_000,
    private readonly logger?: Pick<Logger, "debug" | "warn">,
    private readonly clock: () => number = Date.now
  ) {}

  async listPanes(workspaceId: string, options: { forceRefresh?: boolean } = {}): Promise<HerdrPane[]> {
    const snapshot = this.snapshots.get(workspaceId);
    if (!options.forceRefresh && snapshot && this.clock() - snapshot.capturedAt < this.ttlMs) {
      this.hits += 1;
      return clonePanes(snapshot.panes);
    }
    const active = this.refreshes.get(workspaceId);
    if (active) {
      this.coalescedRefreshes += 1;
      return clonePanes(await active);
    }
    this.misses += 1;
    const refresh = this.refresh(workspaceId, options);
    this.refreshes.set(workspaceId, refresh);
    try { return clonePanes(await refresh); }
    finally { this.refreshes.delete(workspaceId); }
  }

  async listAllPanes(options: { forceRefresh?: boolean } = {}): Promise<HerdrPane[]> {
    if (!this.delegate.listAllPanes) {
      throw new Error("Herdr adapter does not support an all-workspace snapshot");
    }
    if (!options.forceRefresh && this.allSnapshot && this.clock() - this.allSnapshot.capturedAt < this.ttlMs) {
      this.hits += 1;
      return clonePanes(this.allSnapshot.panes);
    }
    if (this.allRefresh) {
      this.coalescedRefreshes += 1;
      return clonePanes(await this.allRefresh);
    }
    this.misses += 1;
    const refresh = this.delegate.listAllPanes();
    this.allRefresh = refresh;
    let panes: HerdrPane[];
    try { panes = await refresh; }
    catch (error) { this.refreshFailures += 1; throw error; }
    finally { this.allRefresh = null; }
    const capturedAt = this.clock();
    const byWorkspace = new Map<string, HerdrPane[]>();
    for (const pane of panes) {
      const group = byWorkspace.get(pane.workspaceId) ?? [];
      group.push(pane);
      byWorkspace.set(pane.workspaceId, group);
    }
    this.allSnapshot = { panes: clonePanes(panes), capturedAt };
    for (const [workspaceId, workspacePanes] of byWorkspace) this.snapshots.set(workspaceId, { panes: clonePanes(workspacePanes), capturedAt });
    return clonePanes(panes);
  }

  invalidate(workspaceId: string): void {
    this.snapshots.delete(workspaceId);
    this.allSnapshot = null;
  }

  status(): WorkspaceCacheStatus {
    const now = this.clock();
    const ages = [...this.snapshots.values()].map((snapshot) => Math.max(0, now - snapshot.capturedAt));
    return {
      ttlMs: this.ttlMs, entries: this.snapshots.size, hits: this.hits, misses: this.misses,
      coalescedRefreshes: this.coalescedRefreshes, refreshFailures: this.refreshFailures,
      oldestSnapshotAgeMs: ages.length > 0 ? Math.max(...ages) : null
    };
  }

  async assertWorkspace(workspaceId: string): Promise<void> { await this.delegate.assertWorkspace(workspaceId); }
  async getPane(paneId: string): Promise<HerdrPane | null> { return this.delegate.getPane(paneId); }
  async observeRuntime(paneId: string): Promise<RuntimeObservation> {
    const observation = await this.delegate.observeRuntime(paneId);
    const pane = observation.pane;
    if (pane) {
      const snapshot = this.snapshots.get(pane.workspaceId);
      if (snapshot) this.snapshots.set(pane.workspaceId, { ...snapshot, panes: snapshot.panes.map((candidate) => candidate.paneId === pane.paneId ? { ...pane } : candidate) });
      if (this.allSnapshot) this.allSnapshot = { ...this.allSnapshot, panes: this.allSnapshot.panes.map((candidate) => candidate.paneId === pane.paneId ? { ...pane } : candidate) };
    }
    return observation;
  }
  async waitForRuntimeChange(paneId: string, timeoutMs: number, signal?: AbortSignal): Promise<void> {
    if (this.delegate.waitForRuntimeChange) await this.delegate.waitForRuntimeChange(paneId, timeoutMs, signal);
    else await new Promise<void>((resolve) => setTimeout(resolve, timeoutMs));
  }
  async createPane(workspaceId: string, cwd: string, options?: HerdrPaneCreationOptions): Promise<HerdrPane> {
    const pane = await this.delegate.createPane(workspaceId, cwd, options);
    this.invalidate(workspaceId);
    return pane;
  }
  async startTraex(paneId: string, executable: string): Promise<void> { await this.delegate.startTraex(paneId, executable); }
  async runPrompt(paneId: string, text: string, timeoutMs: number, onObservation?: Parameters<HerdrPort["runPrompt"]>[3], signal?: AbortSignal, onDispatched?: Parameters<HerdrPort["runPrompt"]>[5]): Promise<import("../domain/types.js").AgentState> {
    return this.delegate.runPrompt(paneId, text, timeoutMs, onObservation, signal, onDispatched);
  }
  async runPaneCommand(paneId: string, command: string, timeoutMs: number): Promise<string> {
    if (!this.delegate.runPaneCommand) throw new Error("Herdr adapter does not support Pane commands");
    return this.delegate.runPaneCommand(paneId, command, timeoutMs);
  }
  async beginPaneModelSelection(paneId: string, model: string, timeoutMs: number): Promise<{ kind: "mode_required"; modes: string[] } | { kind: "composer_ready" }> {
    if (!this.delegate.beginPaneModelSelection) throw new Error("Herdr adapter does not support model selection");
    return this.delegate.beginPaneModelSelection(paneId, model, timeoutMs);
  }
  async completePaneModelMode(paneId: string, mode: string, timeoutMs: number): Promise<void> {
    if (!this.delegate.completePaneModelMode) throw new Error("Herdr adapter does not support model mode selection");
    await this.delegate.completePaneModelMode(paneId, mode, timeoutMs);
  }

  async steerPrompt(paneId: string, text: string): Promise<"injected" | "not_working"> {
    return this.delegate.steerPrompt ? this.delegate.steerPrompt(paneId, text) : "not_working";
  }
  async readOutput(paneId: string, lines: number): Promise<string> { return this.delegate.readOutput(paneId, lines); }
  async renamePane(paneId: string, title: string, options?: Parameters<HerdrPort["renamePane"]>[2]): Promise<void> {
    await this.delegate.renamePane(paneId, title, options);
    const workspaceId = paneId.split(":", 1)[0];
    if (workspaceId) this.invalidate(workspaceId);
  }
  async closePane(paneId: string): Promise<void> {
    if (!this.delegate.closePane) throw new Error("Herdr adapter does not support closing panes");
    await this.delegate.closePane(paneId);
    const workspaceId = paneId.split(":", 1)[0];
    if (workspaceId) this.invalidate(workspaceId);
  }

  private async refresh(workspaceId: string, options: { forceRefresh?: boolean }): Promise<HerdrPane[]> {
    try {
      if (this.delegate.listAllPanes) {
        try {
          return (await this.listAllPanes(options)).filter((pane) => pane.workspaceId === workspaceId);
        } catch (error) {
          this.logger?.debug({ event: "workspace-snapshot-fallback", workspaceId, err: safeLogError(error), outcome: "fallback" }, "all-workspace snapshot unavailable; falling back to workspace snapshot");
        }
      }
      const panes = await this.delegate.listPanes(workspaceId, { forceRefresh: true });
      const capturedAt = this.clock();
      this.snapshots.set(workspaceId, { panes: clonePanes(panes), capturedAt });
      this.logger?.debug({ event: "workspace-snapshot-refreshed", workspaceId, paneCount: panes.length, outcome: "refreshed" }, "refreshed Herdr workspace snapshot");
      return panes;
    } catch (error) {
      this.refreshFailures += 1;
      this.logger?.warn({ event: "workspace-snapshot-refresh-failed", workspaceId, err: safeLogError(error), outcome: "failed" }, "failed to refresh Herdr workspace snapshot");
      throw error;
    }
  }
}

function clonePanes(panes: readonly HerdrPane[]): HerdrPane[] {
  return panes.map((pane) => ({ ...pane, ...(pane.agentSession ? { agentSession: { ...pane.agentSession } } : {}), foregroundExecutables: [...pane.foregroundExecutables] }));
}
