import type { Logger } from "pino";
import type { HerdrPort } from "../domain/ports/external.js";
import type { HerdrPane, HerdrPaneCreationOptions, RuntimeObservation, WorkspaceCacheStatus } from "../domain/types.js";
import { safeLogError } from "./safe-error.js";

interface Snapshot { panes: HerdrPane[]; capturedAt: number }
interface Refresh<T> { generation: number; resetGeneration: number; promise: Promise<T> }

export class WorkspaceSnapshotCache implements HerdrPort {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly paneWorkspaceIds = new Map<string, string>();
  private readonly refreshes = new Map<string, Refresh<HerdrPane[]>>();
  private readonly workspaceGenerations = new Map<string, number>();
  private allRefresh: Refresh<HerdrPane[]> | null = null;
  private allSnapshot: Snapshot | null = null;
  private allGeneration = 0;
  private resetGeneration = 0;
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
    const generation = this.workspaceGeneration(workspaceId);
    const resetGeneration = this.resetGeneration;
    const active = this.refreshes.get(workspaceId);
    if (active && active.generation === generation && active.resetGeneration === resetGeneration) {
      this.coalescedRefreshes += 1;
      return clonePanes(await active.promise);
    }
    this.misses += 1;
    const refresh = this.refresh(workspaceId, options, generation, resetGeneration);
    this.refreshes.set(workspaceId, { generation, resetGeneration, promise: refresh });
    try { return clonePanes(await refresh); }
    finally { if (this.refreshes.get(workspaceId)?.promise === refresh) this.refreshes.delete(workspaceId); }
  }

  async listAllPanes(options: { forceRefresh?: boolean } = {}): Promise<HerdrPane[]> {
    if (!this.delegate.listAllPanes) {
      throw new Error("Herdr adapter does not support an all-workspace snapshot");
    }
    if (!options.forceRefresh && this.allSnapshot && this.clock() - this.allSnapshot.capturedAt < this.ttlMs) {
      this.hits += 1;
      return clonePanes(this.allSnapshot.panes);
    }
    const generation = this.allGeneration;
    const resetGeneration = this.resetGeneration;
    if (this.allRefresh?.generation === generation && this.allRefresh.resetGeneration === resetGeneration) {
      this.coalescedRefreshes += 1;
      return clonePanes(await this.allRefresh.promise);
    }
    this.misses += 1;
    const refresh = this.refreshAll(generation, resetGeneration);
    this.allRefresh = { generation, resetGeneration, promise: refresh };
    try { return clonePanes(await refresh); }
    finally { if (this.allRefresh?.promise === refresh) this.allRefresh = null; }
  }

  private async refreshAll(generation: number, resetGeneration: number): Promise<HerdrPane[]> {
    let panes: HerdrPane[];
    try { panes = await this.delegate.listAllPanes!(); }
    catch (error) { this.refreshFailures += 1; throw error; }
    if (generation !== this.allGeneration || resetGeneration !== this.resetGeneration) return panes;
    const capturedAt = this.clock();
    const byWorkspace = new Map<string, HerdrPane[]>();
    for (const pane of panes) {
      const group = byWorkspace.get(pane.workspaceId) ?? [];
      group.push(pane);
      byWorkspace.set(pane.workspaceId, group);
    }
    this.snapshots.clear();
    this.paneWorkspaceIds.clear();
    this.allSnapshot = { panes: clonePanes(panes), capturedAt };
    for (const [workspaceId, workspacePanes] of byWorkspace) this.snapshots.set(workspaceId, { panes: clonePanes(workspacePanes), capturedAt });
    for (const pane of panes) this.paneWorkspaceIds.set(pane.paneId, pane.workspaceId);
    return panes;
  }

  invalidate(workspaceId: string): void {
    this.workspaceGenerations.set(workspaceId, this.workspaceGeneration(workspaceId) + 1);
    this.allGeneration += 1;
    this.snapshots.delete(workspaceId);
    this.allSnapshot = null;
    this.forgetWorkspacePanes(workspaceId);
  }

  invalidatePanes(paneIds: readonly string[]): void {
    const workspaceIds = new Set<string>();
    for (const paneId of paneIds) {
      const workspaceId = this.paneWorkspaceIds.get(paneId);
      if (!workspaceId) { this.invalidateAll(); return; }
      workspaceIds.add(workspaceId);
    }
    for (const workspaceId of workspaceIds) this.invalidate(workspaceId);
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

  async assertWorkspace(workspaceId: string, expectedSpaceName?: string): Promise<void> {
    await (expectedSpaceName === undefined ? this.delegate.assertWorkspace(workspaceId) : this.delegate.assertWorkspace(workspaceId, expectedSpaceName));
  }
  async getPane(paneId: string): Promise<HerdrPane | null> {
    const pane = await this.delegate.getPane(paneId);
    if (pane) this.rememberPane(pane);
    return pane;
  }
  async observeRuntime(paneId: string): Promise<RuntimeObservation> {
    const observation = await this.delegate.observeRuntime(paneId);
    const pane = observation.pane;
    if (pane) {
      this.rememberPane(pane);
      const snapshot = this.snapshots.get(pane.workspaceId);
      if (snapshot) replaceCachedPane(snapshot, pane);
      if (this.allSnapshot) replaceCachedPane(this.allSnapshot, pane);
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
    this.rememberPane(pane);
    return pane;
  }
  async startTraex(paneId: string, executable: string, args?: string[]): Promise<void> { await this.delegate.startTraex(paneId, executable, args); }
  async startAgent(paneId: string, input: { name: string; kind: "pi" | "claude" | "codex" | "traex"; executable: string; args?: string[] }): Promise<void> {
    if (!this.delegate.startAgent) throw new Error("Herdr adapter does not support managed agent startup");
    await this.delegate.startAgent(paneId, input);
  }
  async runPrompt(paneId: string, text: string, timeoutMs: number, onObservation?: Parameters<HerdrPort["runPrompt"]>[3], signal?: AbortSignal, onDispatched?: Parameters<HerdrPort["runPrompt"]>[5]): Promise<import("../domain/types.js").AgentState> {
    return this.delegate.runPrompt(paneId, text, timeoutMs, onObservation, signal, onDispatched);
  }
  async waitForAgent(paneId: string, timeoutMs: number, onObservation?: Parameters<NonNullable<HerdrPort["waitForAgent"]>>[2], signal?: AbortSignal): Promise<import("../domain/types.js").AgentState> {
    if (!this.delegate.waitForAgent) throw new Error("Herdr adapter does not support native Agent wait");
    return this.delegate.waitForAgent(paneId, timeoutMs, onObservation, signal);
  }
  async sendEscape(paneId: string): Promise<void> {
    if (!this.delegate.sendEscape) throw new Error("Herdr adapter does not support Escape control");
    await this.delegate.sendEscape(paneId);
  }
  async interruptAgent(input: Parameters<NonNullable<HerdrPort["interruptAgent"]>>[0]): Promise<import("../domain/agent-runtime.js").InterruptReceipt> {
    if (!this.delegate.interruptAgent) return { status: "unsupported", reason: "Herdr adapter does not support native interruption" };
    const result = await this.delegate.interruptAgent(input);
    if (result.status === "interrupted") {
      const workspaceId = this.paneWorkspaceIds.get(input.paneId);
      if (workspaceId) this.invalidate(workspaceId);
      else this.invalidateAll();
    }
    return result;
  }

  async renamePane(paneId: string, title: string, options?: Parameters<HerdrPort["renamePane"]>[2]): Promise<void> {
    const workspaceId = this.paneWorkspaceIds.get(paneId);
    await this.delegate.renamePane(paneId, title, options);
    if (workspaceId) this.invalidate(workspaceId);
    else this.invalidateAll();
  }
  async closePane(paneId: string): Promise<void> {
    if (!this.delegate.closePane) throw new Error("Herdr adapter does not support closing panes");
    const workspaceId = this.paneWorkspaceIds.get(paneId);
    await this.delegate.closePane(paneId);
    if (workspaceId) this.invalidate(workspaceId);
    else this.invalidateAll();
    this.paneWorkspaceIds.delete(paneId);
  }

  private async refresh(workspaceId: string, options: { forceRefresh?: boolean }, generation: number, resetGeneration: number): Promise<HerdrPane[]> {
    try {
      if (this.delegate.listAllPanes) {
        try {
          return (await this.listAllPanes(options)).filter((pane) => pane.workspaceId === workspaceId);
        } catch (error) {
          this.logger?.debug({ event: "workspace-snapshot-fallback", workspaceId, err: safeLogError(error), outcome: "fallback" }, "all-workspace snapshot unavailable; falling back to workspace snapshot");
        }
      }
      const panes = await this.delegate.listPanes(workspaceId, { forceRefresh: true });
      if (generation !== this.workspaceGeneration(workspaceId) || resetGeneration !== this.resetGeneration) return panes;
      const capturedAt = this.clock();
      this.rememberWorkspaceSnapshot(workspaceId, panes);
      this.snapshots.set(workspaceId, { panes: clonePanes(panes), capturedAt });
      this.logger?.debug({ event: "workspace-snapshot-refreshed", workspaceId, paneCount: panes.length, outcome: "refreshed" }, "refreshed Herdr workspace snapshot");
      return panes;
    } catch (error) {
      this.refreshFailures += 1;
      this.logger?.warn({ event: "workspace-snapshot-refresh-failed", workspaceId, err: safeLogError(error), outcome: "failed" }, "failed to refresh Herdr workspace snapshot");
      throw error;
    }
  }

  private rememberPane(pane: HerdrPane): void {
    const previousWorkspaceId = this.paneWorkspaceIds.get(pane.paneId);
    if (previousWorkspaceId && previousWorkspaceId !== pane.workspaceId) this.invalidate(previousWorkspaceId);
    this.paneWorkspaceIds.set(pane.paneId, pane.workspaceId);
  }

  private rememberWorkspaceSnapshot(workspaceId: string, panes: readonly HerdrPane[]): void {
    this.forgetWorkspacePanes(workspaceId);
    for (const pane of panes) this.rememberPane(pane);
  }

  private forgetWorkspacePanes(workspaceId: string): void {
    for (const [paneId, indexedWorkspaceId] of this.paneWorkspaceIds) {
      if (indexedWorkspaceId === workspaceId) this.paneWorkspaceIds.delete(paneId);
    }
  }

  private workspaceGeneration(workspaceId: string): number { return this.workspaceGenerations.get(workspaceId) ?? 0; }

  private invalidateAll(): void {
    this.resetGeneration += 1;
    this.allGeneration += 1;
    this.workspaceGenerations.clear();
    this.snapshots.clear();
    this.allSnapshot = null;
    this.paneWorkspaceIds.clear();
  }
}

function clonePanes(panes: readonly HerdrPane[]): HerdrPane[] {
  return panes.map((pane) => ({ ...pane, ...(pane.agentSession ? { agentSession: { ...pane.agentSession } } : {}), foregroundExecutables: [...pane.foregroundExecutables] }));
}

function replaceCachedPane(snapshot: Snapshot, pane: HerdrPane): void {
  const index = snapshot.panes.findIndex((candidate) => candidate.paneId === pane.paneId);
  if (index >= 0) snapshot.panes[index] = { ...pane };
}
