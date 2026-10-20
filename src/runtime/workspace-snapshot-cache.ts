import type { Logger } from "pino";
import type { HerdrPort } from "../domain/ports/external.js";
import type { RuntimeObservationPort } from "../domain/ports/runtime-observation.js";
import type { RemovedPaneIdentity, SemanticPaneSnapshotRead, SemanticSnapshotCursor } from "../domain/runtime-observation.js";
import type { HerdrActiveTurn, HerdrPane, HerdrPaneCreationOptions, RuntimeObservation, WorkspaceCacheStatus } from "../domain/types.js";
import { mapWithConcurrency } from "./map-with-concurrency.js";
import { safeLogError } from "./safe-error.js";

interface Snapshot { panes: HerdrPane[]; capturedAt: number }
interface Refresh<T> { generation: number; resetGeneration: number; promise: Promise<T> }
const MAX_TARGETED_READS = 256;
const RUNTIME_OBSERVATION_CONCURRENCY = 4;
const SEMANTIC_DELTA_HISTORY_LIMIT = 32;
const SEMANTIC_FULL_REFRESH_MAX_STALENESS_MS = 60_000;

interface SemanticDelta {
  generation: number;
  added: HerdrPane[];
  changed: HerdrPane[];
  removed: RemovedPaneIdentity[];
}

export class WorkspaceSnapshotCache implements HerdrPort, RuntimeObservationPort {
  private readonly snapshots = new Map<string, Snapshot>();
  private readonly paneWorkspaceIds = new Map<string, string>();
  private readonly refreshes = new Map<string, Refresh<HerdrPane[]>>();
  private readonly workspaceGenerations = new Map<string, number>();
  private allRefresh: Refresh<HerdrPane[]> | null = null;
  private readonly paneReads = new Map<string, Promise<HerdrPane | null>>();
  private allSnapshot: Snapshot | null = null;
  private allGeneration = 0;
  private resetGeneration = 0;
  private hits = 0;
  private misses = 0;
  private coalescedRefreshes = 0;
  private refreshFailures = 0;
  private startupReuseScopes = 0;
  private semanticPanes = new Map<string, HerdrPane>();
  private semanticEpoch = 0;
  private semanticGeneration = 0;
  private semanticInitialized = false;
  private semanticInvalidatedAll = true;
  private readonly semanticInvalidatedWorkspaces = new Set<string>();
  private semanticInvalidationVersion = 0;
  private semanticRefresh: Promise<void> | null = null;
  private semanticHistory: SemanticDelta[] = [];
  private semanticLastFullRefreshAt: number | null = null;

  constructor(
    private readonly delegate: HerdrPort,
    private readonly ttlMs = 2_000,
    private readonly logger?: Pick<Logger, "debug" | "warn">,
    private readonly clock: () => number = Date.now,
    private readonly startupReuseMaxAgeMs = 10_000
  ) {}

  async listPanes(workspaceId: string, options: { forceRefresh?: boolean; skipAllWorkspaceSnapshot?: boolean } = {}): Promise<HerdrPane[]> {
    const snapshot = this.snapshots.get(workspaceId);
    if (!options.forceRefresh && snapshot && this.isReusable(snapshot)) {
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
    if (!options.forceRefresh && this.allSnapshot && this.isReusable(this.allSnapshot)) {
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

  async readSemanticSnapshot(input: { cursor: SemanticSnapshotCursor | null; workspaceIds: readonly string[] }): Promise<SemanticPaneSnapshotRead> {
    await this.ensureSemanticSnapshot(input.workspaceIds);
    const cursor = this.semanticCursor();
    if (!input.cursor || input.cursor.epoch !== cursor.epoch) return { kind: "rebuild-required", cursor, panes: this.cloneSemanticPanes() };
    if (input.cursor.generation === cursor.generation) return { kind: "current", cursor };
    if (input.cursor.generation > cursor.generation) return { kind: "rebuild-required", cursor, panes: this.cloneSemanticPanes() };
    const history = this.semanticHistory.filter((delta) => delta.generation > input.cursor!.generation);
    if (history.length === 0 || history[0]!.generation !== input.cursor.generation + 1) return { kind: "rebuild-required", cursor, panes: this.cloneSemanticPanes() };
    const delta = mergeSemanticDeltas(history);
    return { kind: "delta", cursor, ...delta, workspaces: this.semanticWorkspaces(delta) };
  }

  canAcknowledgeSemanticGeneration(cursor: SemanticSnapshotCursor): boolean {
    return this.semanticInitialized && !this.semanticInvalidatedAll && this.semanticInvalidatedWorkspaces.size === 0
      && cursor.epoch === this.semanticEpoch && cursor.generation === this.semanticGeneration;
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
    this.invalidateSemanticWorkspace(workspaceId);
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

  async withStartupSnapshotReuse<T>(operation: () => Promise<T>): Promise<T> {
    if (this.startupReuseScopes === 0) this.invalidateAll();
    this.startupReuseScopes += 1;
    try { return await operation(); }
    finally { this.startupReuseScopes -= 1; }
  }

  private isReusable(snapshot: Snapshot): boolean {
    const maximumAge = this.startupReuseScopes > 0 ? this.startupReuseMaxAgeMs : this.ttlMs;
    return this.clock() - snapshot.capturedAt < maximumAge;
  }

  async assertWorkspace(workspaceId: string, expectedSpaceName?: string): Promise<void> {
    await (expectedSpaceName === undefined ? this.delegate.assertWorkspace(workspaceId) : this.delegate.assertWorkspace(workspaceId, expectedSpaceName));
  }
  async listWorkspaces(): Promise<Awaited<ReturnType<NonNullable<HerdrPort["listWorkspaces"]>>>> {
    if (!this.delegate.listWorkspaces) throw new Error("Herdr adapter does not support Workspace discovery");
    return this.delegate.listWorkspaces();
  }
  async getPane(paneId: string): Promise<HerdrPane | null> {
    let read = this.paneReads.get(paneId);
    if (!read) {
      read = this.readPane(paneId);
      if (this.paneReads.size < MAX_TARGETED_READS) {
        this.paneReads.set(paneId, read);
        void read.finally(() => { if (this.paneReads.get(paneId) === read) this.paneReads.delete(paneId); }).catch(() => {});
      }
    }
    const pane = await read;
    return pane ? clonePane(pane) : null;
  }
  async getActiveTurn(paneId: string): Promise<HerdrActiveTurn | null> {
    if (!this.delegate.getActiveTurn) return null;
    return this.delegate.getActiveTurn(paneId);
  }

  private async readPane(paneId: string): Promise<HerdrPane | null> {
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
  async observeRuntimes(paneIds: readonly string[]): Promise<ReadonlyMap<string, RuntimeObservation>> {
    if (!this.delegate.observeRuntimes) {
      const observations = await mapWithConcurrency(paneIds, RUNTIME_OBSERVATION_CONCURRENCY, async (paneId) => [paneId, await this.observeRuntime(paneId)] as const);
      return new Map(observations);
    }
    const observations = await this.delegate.observeRuntimes(paneIds);
    for (const observation of observations.values()) {
      if (!observation.pane) continue;
      this.rememberPane(observation.pane);
      const snapshot = this.snapshots.get(observation.pane.workspaceId);
      if (snapshot) replaceCachedPane(snapshot, observation.pane);
      if (this.allSnapshot) replaceCachedPane(this.allSnapshot, observation.pane);
    }
    return new Map([...observations].map(([paneId, observation]) => [paneId, cloneObservation(observation)]));
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
  async movePane(input: Parameters<NonNullable<HerdrPort["movePane"]>>[0]): Promise<Awaited<ReturnType<NonNullable<HerdrPort["movePane"]>>>> {
    if (!this.delegate.movePane) throw new Error("Herdr pane move is unavailable");
    const workspaceIds = new Set<string>();
    const observedWorkspaceId = this.paneWorkspaceIds.get(input.paneId);
    if (observedWorkspaceId) workspaceIds.add(observedWorkspaceId);
    try {
      const receipt = await this.delegate.movePane(input);
      workspaceIds.add(receipt.workspaceId);
      return receipt;
    } finally {
      if (workspaceIds.size === 0) this.invalidateAll();
      else for (const workspaceId of workspaceIds) this.invalidate(workspaceId);
    }
  }
  async labelPane(input: Parameters<NonNullable<HerdrPort["labelPane"]>>[0]): Promise<Awaited<ReturnType<NonNullable<HerdrPort["labelPane"]>>>> {
    if (!this.delegate.labelPane) throw new Error("Herdr pane identity labeling is unavailable");
    const workspaceIds = new Set([input.workspaceId]);
    try {
      const receipt = await this.delegate.labelPane(input);
      workspaceIds.add(receipt.workspaceId);
      return receipt;
    } finally {
      for (const workspaceId of workspaceIds) this.invalidate(workspaceId);
    }
  }
  async supportsPaneCreationV2(): Promise<boolean> { return this.delegate.supportsPaneCreationV2 ? this.delegate.supportsPaneCreationV2() : false; }
  async createPaneV2(input: Parameters<NonNullable<HerdrPort["createPaneV2"]>>[0]): Promise<Awaited<ReturnType<NonNullable<HerdrPort["createPaneV2"]>>>> {
    if (!this.delegate.createPaneV2) return { outcome: "capability-unavailable", capability: "tab.create.v2", reason: "Herdr adapter does not support tab.create.v2" };
    const result = await this.delegate.createPaneV2(input);
    this.invalidate(input.workspaceId);
    return result;
  }
  async supportsPaneIdentityReconcileV1(): Promise<boolean> { return this.delegate.supportsPaneIdentityReconcileV1 ? this.delegate.supportsPaneIdentityReconcileV1() : false; }
  async reconcilePaneIdentityV1(input: Parameters<NonNullable<HerdrPort["reconcilePaneIdentityV1"]>>[0]): Promise<Awaited<ReturnType<NonNullable<HerdrPort["reconcilePaneIdentityV1"]>>>> {
    if (!this.delegate.reconcilePaneIdentityV1) return { outcome: "capability-unavailable", capability: "pane.identity_reconcile.v1", reason: "Herdr adapter does not support pane.identity_reconcile.v1" };
    const result = await this.delegate.reconcilePaneIdentityV1(input);
    this.invalidate(input.expected.workspaceId);
    this.invalidate(input.target.workspaceId);
    return result;
  }
  async startTraex(paneId: string, executable: string, args?: string[]): Promise<void> { await this.delegate.startTraex(paneId, executable, args); }
  async startAgent(paneId: string, input: { name: string; kind: "pi" | "claude" | "codex" | "traex"; executable: string; args?: string[]; useConfiguredPermissionMode?: boolean; rotatable?: boolean }): Promise<void> {
    if (!this.delegate.startAgent) throw new Error("Herdr adapter does not support managed agent startup");
    await this.delegate.startAgent(paneId, input);
  }
  async runPrompt(paneId: string, text: string, timeoutMs: number, onObservation?: Parameters<HerdrPort["runPrompt"]>[3], signal?: AbortSignal, onDispatched?: Parameters<HerdrPort["runPrompt"]>[5]): Promise<import("../domain/types.js").AgentState> {
    return this.delegate.runPrompt(paneId, text, timeoutMs, onObservation, signal, onDispatched);
  }
  async supportsPromptQueue(): Promise<boolean> {
    return this.delegate.supportsPromptQueue ? this.delegate.supportsPromptQueue() : false;
  }
  async queuePrompt(paneId: string, text: string, input: { submissionId: string; expectedSessionId: string }, signal?: AbortSignal): Promise<{ submissionId: string }> {
    if (!this.delegate.queuePrompt) throw new Error("Herdr adapter does not support native prompt queueing");
    return this.delegate.queuePrompt(paneId, text, input, signal);
  }
  async supportsModelPrompt(): Promise<boolean> {
    return this.delegate.supportsModelPrompt ? this.delegate.supportsModelPrompt() : false;
  }
  async queueModelPrompt(paneId: string, text: string, input: { model: string; submissionId: string; expectedSessionId: string }, signal?: AbortSignal): Promise<{ submissionId: string }> {
    if (!this.delegate.queueModelPrompt) throw new Error("Herdr adapter does not support native model prompt queueing");
    return this.delegate.queueModelPrompt(paneId, text, input, signal);
  }
  async supportsSessionRotation(): Promise<boolean> { return this.delegate.supportsSessionRotation ? this.delegate.supportsSessionRotation() : false; }
  async rotateSession(input: import("../domain/orchestrator-clear.js").SessionRotationRequest): Promise<import("../domain/orchestrator-clear.js").SessionRotationResult> {
    if (!this.delegate.rotateSession) throw new Error("Herdr adapter does not support session rotation");
    const result = await this.delegate.rotateSession(input);
    this.invalidatePanes([input.paneId]);
    return result;
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

  private async refresh(
    workspaceId: string,
    options: { forceRefresh?: boolean; skipAllWorkspaceSnapshot?: boolean },
    generation: number,
    resetGeneration: number,
  ): Promise<HerdrPane[]> {
    try {
      if (this.delegate.listAllPanes && !options.skipAllWorkspaceSnapshot) {
        try {
          return (await this.listAllPanes(options)).filter((pane) => pane.workspaceId === workspaceId);
        } catch (error) {
          this.logger?.debug({ event: "workspace-snapshot-fallback", workspaceId, err: safeLogError(error), outcome: "fallback" }, "all-workspace snapshot unavailable; falling back to workspace snapshot");
        }
      }
      const panes = await this.delegate.listPanes(workspaceId, { forceRefresh: true, ...(options.skipAllWorkspaceSnapshot ? { skipAllWorkspaceSnapshot: true } : {}) });
      if (generation !== this.workspaceGeneration(workspaceId) || resetGeneration !== this.resetGeneration) return panes;
      const capturedAt = this.clock();
      this.allGeneration += 1;
      this.allSnapshot = null;
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

  invalidateAll(): void {
    this.invalidateSemanticAll();
    this.resetGeneration += 1;
    this.allGeneration += 1;
    this.workspaceGenerations.clear();
    this.snapshots.clear();
    this.allSnapshot = null;
    this.paneWorkspaceIds.clear();
  }

  private async ensureSemanticSnapshot(workspaceIds: readonly string[]): Promise<void> {
    if (this.semanticInitialized && !this.semanticInvalidatedAll && this.semanticInvalidatedWorkspaces.size === 0 && !this.isSemanticFullRefreshStale()) return;
    if (this.semanticRefresh) return this.semanticRefresh;
    const promise = this.refreshSemanticUntilStable(workspaceIds);
    this.semanticRefresh = promise;
    try { await promise; }
    finally { if (this.semanticRefresh === promise) this.semanticRefresh = null; }
  }

  private async refreshSemanticUntilStable(workspaceIds: readonly string[]): Promise<void> {
    while (!this.semanticInitialized || this.semanticInvalidatedAll || this.semanticInvalidatedWorkspaces.size > 0 || this.isSemanticFullRefreshStale()) {
      const version = this.semanticInvalidationVersion;
      await this.refreshSemanticSnapshot(workspaceIds, version);
      if (version === this.semanticInvalidationVersion) return;
    }
  }

  private async refreshSemanticSnapshot(workspaceIds: readonly string[], version: number): Promise<void> {
    if (!this.semanticInitialized || this.semanticInvalidatedAll || this.isSemanticFullRefreshStale()) {
      const panes = await this.readSemanticFullSnapshot(workspaceIds);
      if (version !== this.semanticInvalidationVersion) return;
      this.applySemanticSnapshot(new Map(panes.map((pane) => [pane.paneId, clonePane(pane)])), { fullRefresh: true });
      return;
    }

    const invalidatedWorkspaces = [...this.semanticInvalidatedWorkspaces].sort();
    const next = new Map([...this.semanticPanes].map(([paneId, pane]) => [paneId, clonePane(pane)]));
    const refreshed = await mapWithConcurrency(
      invalidatedWorkspaces,
      4,
      async (workspaceId) => [workspaceId, await this.delegate.listPanes(workspaceId, { forceRefresh: true, skipAllWorkspaceSnapshot: true })] as const,
    );
    if (version !== this.semanticInvalidationVersion) return;
    for (const [workspaceId, panes] of refreshed) {
      removeWorkspacePanes(next, workspaceId);
      for (const pane of panes) next.set(pane.paneId, clonePane(pane));
    }
    this.applySemanticSnapshot(next, { fullRefresh: false, refreshedWorkspaceIds: invalidatedWorkspaces });
  }

  private async readSemanticFullSnapshot(workspaceIds: readonly string[]): Promise<HerdrPane[]> {
    if (this.delegate.listAllPanes) return this.delegate.listAllPanes({ forceRefresh: true });
    return (await mapWithConcurrency(
      this.semanticWorkspaceIds(workspaceIds),
      4,
      (workspaceId) => this.delegate.listPanes(workspaceId, { forceRefresh: true, skipAllWorkspaceSnapshot: true }),
    )).flat();
  }

  private applySemanticSnapshot(
    next: ReadonlyMap<string, HerdrPane>,
    mode: { fullRefresh: true } | { fullRefresh: false; refreshedWorkspaceIds: readonly string[] },
  ): void {
    const delta = semanticDelta(this.semanticPanes, next, this.semanticGeneration + 1);
    if (!this.semanticInitialized || delta.added.length > 0 || delta.changed.length > 0 || delta.removed.length > 0) {
      this.semanticGeneration += 1;
      if (this.semanticInitialized) {
        delta.generation = this.semanticGeneration;
        this.semanticHistory.push(delta);
        if (this.semanticHistory.length > SEMANTIC_DELTA_HISTORY_LIMIT) this.semanticHistory.splice(0, this.semanticHistory.length - SEMANTIC_DELTA_HISTORY_LIMIT);
      }
    }
    this.semanticPanes = new Map([...next].map(([paneId, pane]) => [paneId, clonePane(pane)]));
    this.semanticInitialized = true;
    this.semanticInvalidatedAll = false;
    this.semanticInvalidatedWorkspaces.clear();
    if (mode.fullRefresh) this.publishSemanticSnapshot([...next.values()]);
    else this.publishTargetedSemanticSnapshots(mode.refreshedWorkspaceIds);
  }

  private publishTargetedSemanticSnapshots(workspaceIds: readonly string[]): void {
    const capturedAt = this.clock();
    this.allSnapshot = null;
    for (const workspaceId of workspaceIds) {
      const panes = this.semanticWorkspacePanes(workspaceId);
      this.rememberWorkspaceSnapshot(workspaceId, panes);
      this.snapshots.set(workspaceId, { panes: clonePanes(panes), capturedAt });
    }
  }

  private isSemanticFullRefreshStale(): boolean {
    return this.semanticLastFullRefreshAt !== null && this.clock() - this.semanticLastFullRefreshAt >= SEMANTIC_FULL_REFRESH_MAX_STALENESS_MS;
  }

  private publishSemanticSnapshot(panes: readonly HerdrPane[]): void {
    const capturedAt = this.clock();
    const byWorkspace = new Map<string, HerdrPane[]>();
    for (const pane of panes) {
      const group = byWorkspace.get(pane.workspaceId) ?? [];
      group.push(clonePane(pane));
      byWorkspace.set(pane.workspaceId, group);
    }
    this.snapshots.clear();
    this.paneWorkspaceIds.clear();
    this.allSnapshot = { panes: clonePanes(panes), capturedAt };
    for (const [workspaceId, workspacePanes] of byWorkspace) this.snapshots.set(workspaceId, { panes: workspacePanes, capturedAt });
    for (const pane of panes) this.paneWorkspaceIds.set(pane.paneId, pane.workspaceId);
    this.semanticLastFullRefreshAt = capturedAt;
  }

  private semanticWorkspaceIds(requested: readonly string[]): string[] {
    const workspaceIds = new Set(requested);
    for (const pane of this.semanticPanes.values()) workspaceIds.add(pane.workspaceId);
    for (const workspaceId of this.semanticInvalidatedWorkspaces) workspaceIds.add(workspaceId);
    return [...workspaceIds];
  }

  private invalidateSemanticWorkspace(workspaceId: string): void {
    this.semanticInvalidatedWorkspaces.add(workspaceId);
    this.semanticInvalidationVersion += 1;
  }

  private invalidateSemanticAll(): void {
    if (this.semanticInitialized) this.semanticEpoch += 1;
    this.semanticInvalidatedAll = true;
    this.semanticInvalidatedWorkspaces.clear();
    this.semanticHistory = [];
    this.semanticInvalidationVersion += 1;
  }

  private semanticCursor(): SemanticSnapshotCursor { return { epoch: this.semanticEpoch, generation: this.semanticGeneration }; }
  private cloneSemanticPanes(): HerdrPane[] { return [...this.semanticPanes.values()].sort((left, right) => left.paneId.localeCompare(right.paneId)).map(clonePane); }
  private semanticWorkspacePanes(workspaceId: string): HerdrPane[] {
    return [...this.semanticPanes.values()].filter((pane) => pane.workspaceId === workspaceId).sort(comparePane).map(clonePane);
  }
  private semanticWorkspaces(delta: Omit<SemanticDelta, "generation">): Array<{ workspaceId: string; panes: HerdrPane[] }> {
    const workspaceIds = new Set([...delta.added, ...delta.changed].map((pane) => pane.workspaceId));
    for (const pane of delta.removed) workspaceIds.add(pane.workspaceId);
    return [...workspaceIds].sort().map((workspaceId) => ({
      workspaceId,
      panes: [...this.semanticPanes.values()].filter((pane) => pane.workspaceId === workspaceId).sort(comparePane).map(clonePane)
    }));
  }
}

function clonePanes(panes: readonly HerdrPane[]): HerdrPane[] {
  return panes.map(clonePane);
}

function clonePane(pane: HerdrPane): HerdrPane {
  return { ...pane, ...(pane.agentSession ? { agentSession: { ...pane.agentSession } } : {}), foregroundExecutables: [...pane.foregroundExecutables] };
}

function cloneObservation(observation: RuntimeObservation): RuntimeObservation {
  return { ...observation, pane: observation.pane ? clonePane(observation.pane) : null };
}

function replaceCachedPane(snapshot: Snapshot, pane: HerdrPane): void {
  const index = snapshot.panes.findIndex((candidate) => candidate.paneId === pane.paneId);
  if (index >= 0) snapshot.panes[index] = { ...pane };
}

function removeWorkspacePanes(panes: Map<string, HerdrPane>, workspaceId: string): void {
  for (const [paneId, pane] of panes) {
    if (pane.workspaceId === workspaceId) panes.delete(paneId);
  }
}

function semanticDelta(previous: ReadonlyMap<string, HerdrPane>, next: ReadonlyMap<string, HerdrPane>, generation: number): SemanticDelta {
  const added: HerdrPane[] = [];
  const changed: HerdrPane[] = [];
  const removed: RemovedPaneIdentity[] = [];
  for (const [paneId, pane] of next) {
    const prior = previous.get(paneId);
    if (!prior) added.push(clonePane(pane));
    else if (semanticPaneFingerprint(prior) !== semanticPaneFingerprint(pane)) changed.push(clonePane(pane));
  }
  for (const [paneId, pane] of previous) if (!next.has(paneId)) removed.push({ paneId, workspaceId: pane.workspaceId });
  added.sort(comparePane); changed.sort(comparePane); removed.sort((left, right) => left.paneId.localeCompare(right.paneId));
  return { generation, added, changed, removed };
}

function mergeSemanticDeltas(history: readonly SemanticDelta[]): Omit<SemanticDelta, "generation"> {
  const changes = new Map<string, { kind: "added" | "changed"; pane: HerdrPane } | { kind: "removed"; pane: RemovedPaneIdentity }>();
  for (const delta of history) {
    for (const pane of delta.added) {
      const prior = changes.get(pane.paneId);
      changes.set(pane.paneId, { kind: prior?.kind === "removed" ? "changed" : "added", pane: clonePane(pane) });
    }
    for (const pane of delta.changed) changes.set(pane.paneId, { kind: changes.get(pane.paneId)?.kind === "added" ? "added" : "changed", pane: clonePane(pane) });
    for (const pane of delta.removed) {
      if (changes.get(pane.paneId)?.kind === "added") changes.delete(pane.paneId);
      else changes.set(pane.paneId, { kind: "removed", pane: { ...pane } });
    }
  }
  const added: HerdrPane[] = [];
  const changed: HerdrPane[] = [];
  const removed: RemovedPaneIdentity[] = [];
  for (const change of changes.values()) {
    if (change.kind === "added") added.push(change.pane);
    else if (change.kind === "changed") changed.push(change.pane);
    else removed.push(change.pane);
  }
  added.sort(comparePane); changed.sort(comparePane); removed.sort((left, right) => left.paneId.localeCompare(right.paneId));
  return { added, changed, removed };
}

function semanticPaneFingerprint(pane: HerdrPane): string {
  return JSON.stringify({
    paneId: pane.paneId, paneToken: pane.paneToken ?? null, paneName: pane.paneName ?? null,
    tabId: pane.tabId ?? null, tabLabel: pane.tabLabel ?? null, terminalId: pane.terminalId ?? null,
    agentSession: pane.agentSession ?? null, agentKind: pane.agentKind ?? null,
    steeringCapability: pane.steeringCapability ?? null, stateChangeSeq: pane.stateChangeSeq ?? null,
    workspaceId: pane.workspaceId, cwd: pane.cwd, foregroundCwd: pane.foregroundCwd ?? null,
    label: pane.label, agentState: pane.agentState, foregroundExecutables: [...pane.foregroundExecutables].sort()
  });
}

function comparePane(left: HerdrPane, right: HerdrPane): number { return left.paneId.localeCompare(right.paneId); }
