import type { Logger } from "pino";
import type { HerdrPort } from "../domain/ports.js";
import type { HerdrPane, WorkspaceCacheStatus } from "../domain/types.js";
import { safeLogError } from "./safe-error.js";

interface Snapshot { panes: HerdrPane[]; capturedAt: number }

export class WorkspaceSnapshotCache implements HerdrPort {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly refreshes = new Map<string, Promise<HerdrPane[]>>();
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
    const refresh = this.refresh(workspaceId);
    this.refreshes.set(workspaceId, refresh);
    try { return clonePanes(await refresh); }
    finally { this.refreshes.delete(workspaceId); }
  }

  invalidate(workspaceId: string): void { this.snapshots.delete(workspaceId); }

  status(): WorkspaceCacheStatus {
    const now = this.clock();
    const ages = [...this.snapshots.values()].map((snapshot) => Math.max(0, now - snapshot.capturedAt));
    return {
      ttlMs: this.ttlMs, entries: this.snapshots.size, hits: this.hits, misses: this.misses,
      coalescedRefreshes: this.coalescedRefreshes, refreshFailures: this.refreshFailures,
      oldestSnapshotAgeMs: ages.length > 0 ? Math.max(...ages) : null
    };
  }

  async assertWorkspace(workspaceId: string): Promise<void> { await this.listPanes(workspaceId); }
  async getPane(paneId: string): Promise<HerdrPane | null> { return this.delegate.getPane(paneId); }
  async createPane(workspaceId: string, cwd: string, identity?: { bindingId: string; generation: number; projectId: string }): Promise<HerdrPane> {
    const pane = await this.delegate.createPane(workspaceId, cwd, identity);
    this.invalidate(workspaceId);
    return pane;
  }
  async startTraex(paneId: string, executable: string): Promise<void> { await this.delegate.startTraex(paneId, executable); }
  async runPrompt(paneId: string, text: string, timeoutMs: number, onObservation?: Parameters<HerdrPort["runPrompt"]>[3], signal?: AbortSignal): Promise<import("../domain/types.js").AgentState> {
    return this.delegate.runPrompt(paneId, text, timeoutMs, onObservation, signal);
  }
  async steerPrompt(paneId: string, text: string): Promise<"injected" | "not_working"> {
    return this.delegate.steerPrompt ? this.delegate.steerPrompt(paneId, text) : "not_working";
  }
  async readOutput(paneId: string, lines: number): Promise<string> { return this.delegate.readOutput(paneId, lines); }
  async renamePane(paneId: string, title: string): Promise<void> {
    await this.delegate.renamePane(paneId, title);
    const workspaceId = paneId.split(":", 1)[0];
    if (workspaceId) this.invalidate(workspaceId);
  }

  private async refresh(workspaceId: string): Promise<HerdrPane[]> {
    try {
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
  return panes.map((pane) => ({ ...pane, foregroundExecutables: [...pane.foregroundExecutables] }));
}
