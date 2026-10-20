import type { Logger } from "pino";
import { transcriptObserverIdentity, transcriptSourceFor } from "../domain/transcript-observer-identity.js";
import type { AgentTranscriptSource } from "../domain/ports/external.js";
import type { CanonicalInputRecoverySummary } from "../domain/ports/agent-input.js";
import type { Binding } from "../domain/types.js";
import type { AgentInstance } from "../domain/agent-instance.js";
import type { HerdrPane } from "../domain/types.js";
import type { CoreSessionIngestionDiagnostics } from "../domain/types.js";
import { CoreSessionUnrecoverableCursorError, type CoreSessionEventMultiplexBatch, type CoreSessionEventMultiplexFrame, type CoreSessionEventMultiplexTarget } from "../domain/herdr-events.js";
import { mapWithConcurrency } from "../runtime/map-with-concurrency.js";
import { safeLogError } from "../runtime/safe-error.js";

interface SessionIngestionResult { laneId: string; sourceId?: string; ingestedEvents: number; caughtUp: boolean }
interface SessionIngestionRetry { attempt: number; nextAttemptAtMs: number }
interface SourceNotification { sourceId: string; latestCursor: string }
interface SourceOwnerRoute {
  ownerId: string;
  paneId: string;
  source: AgentTranscriptSource;
  identity: string;
  ownerKey: string;
  ownerKind: "primary" | "worker";
  generation: number;
  onIngested: () => void | Promise<void> | undefined;
}
interface MultiplexOwnerTarget {
  route: SourceOwnerRoute;
  target: CoreSessionEventMultiplexTarget;
}
interface MultiplexIngestionResult extends SessionIngestionResult {
  outcome: "accepted" | "stale_rebase";
  readCursor: string;
}
const MAX_INGESTION_PAGES_PER_WAKE = 8;
const SESSION_INGESTION_CONCURRENCY = 4;
const MULTIPLEX_REFRESH_DEADLINE_MS = 30_000;
const HEALTHY_FALLBACK_INTERVAL_MS = 30_000;
export interface CoreSessionIngestionSupervisorOptions {
  routes: { listBindingsByState(state: Binding["state"]): Binding[] };
  ingestor: {
    ingestCurrentSession(source: AgentTranscriptSource): Promise<SessionIngestionResult>;
    prepareMultiplexTarget?(source: AgentTranscriptSource): Promise<CoreSessionEventMultiplexTarget>;
    ingestMultiplexBatch?(source: AgentTranscriptSource, target: CoreSessionEventMultiplexTarget, batch: CoreSessionEventMultiplexBatch): Promise<MultiplexIngestionResult> | MultiplexIngestionResult;
  };
  replaceMultiplexTargets?(targets: readonly CoreSessionEventMultiplexTarget[]): Promise<number | void>;
  clearMultiplexTargets?(): Promise<void>;
  resolveSource?(binding: Binding): Promise<AgentTranscriptSource | null>;
  onIngested(bindingId: string): void | Promise<void>;
  workers?: { listWorkerSessions(): AgentInstance[] };
  resolveWorkerSource?(instance: AgentInstance): Promise<AgentTranscriptSource | null>;
  onWorkerIngested?(instanceId: string, paneId: string): void | Promise<void>;
  reconcileCanonicalHumanMessages?(): number | Promise<number>;
  retireLegacyInputCards?(limit?: number): number | Promise<number>;
  wakeOutbound?(): void;
  recoverCanonicalTurns?(): CanonicalInputRecoverySummary | void | Promise<CanonicalInputRecoverySummary | void>;
  requiresIngestion?(ownerKind: "primary" | "worker", ownerId: string, generation: number): boolean;
  logger?: Pick<Logger, "debug" | "warn">;
  pollIntervalMs?: number;
  retryBaseMs?: number;
  retryMaxMs?: number;
  multiplexRefreshDeadlineMs?: number;
}

export class CoreSessionIngestionSupervisor {
  private readonly tails = new Map<string, Promise<void>>();
  private scan: Promise<void> | null = null;
  private timer: NodeJS.Timeout | null = null;
  private fallbackIntervalMs: number;
  private fallbackDelayMs: number | null = null;
  private nextFallbackAt: string | null = null;
  private started = false;
  private stopping = false;
  private readonly requiredFailureOwners = new Set<string>();
  private readonly awaitingOwners = new Set<string>();
  private readonly laggingOwners = new Set<string>();
  private readonly laggingSince = new Map<string, number>();
  private readonly retries = new Map<string, SessionIngestionRetry>();
  private readonly cursorCooldownOwners = new Set<string>();
  private readonly sourceOwners = new Map<string, SourceOwnerRoute>();
  private desiredMultiplexTargets = new Map<string, MultiplexOwnerTarget>();
  private currentMultiplexTargets = new Map<string, MultiplexOwnerTarget>();
  private readonly suspendedMultiplexOwners = new Set<string>();
  private readonly multiplexRefreshDeadlineMs: number;
  private multiplexOverflow = 0;
  private multiplexGeneration = 0;
  private multiplexTransportActive = false;
  private readonly sourceNotificationCursors = new Map<string, string>();
  private readonly ingestionPermitWaiters: Array<() => void> = [];
  private activeIngestionPermits = 0;
  private runCount = 0;
  private activeSessions = 0;
  private indexingRecoveries = 0;
  private needsHumanRecoveries = 0;
  private lastRunAt: string | null = null;
  private lastSuccessfulIngestAt: string | null = null;
  private lastFailureAt: string | null = null;
  private lastFailureCode: CoreSessionIngestionDiagnostics["lastFailureCode"] = null;
  private lastFailure: string | null = null;

  constructor(private readonly options: CoreSessionIngestionSupervisorOptions) {
    this.fallbackIntervalMs = options.pollIntervalMs ?? 2_000;
    this.multiplexRefreshDeadlineMs = Math.max(1, options.multiplexRefreshDeadlineMs ?? MULTIPLEX_REFRESH_DEADLINE_MS);
  }

  snapshot(): CoreSessionIngestionDiagnostics {
    const retryStates = [...this.retries.values()];
    const oldestLagStartedAt = this.laggingSince.size > 0 ? Math.min(...this.laggingSince.values()) : null;
    return {
      ready: this.requiredFailureOwners.size === 0,
      state: this.stopping ? "stopped" : this.scan ? "running" : this.awaitingOwners.size > 0 ? "awaiting_session" : "idle",
      recoveryState: this.indexingRecoveries > 0 ? "indexing" : "idle",
      runCount: this.runCount,
      activeSessions: this.activeSessions,
      awaitingSessions: this.awaitingOwners.size,
      laggingSessions: this.laggingOwners.size,
      oldestLagAgeSeconds: oldestLagStartedAt === null ? null : Math.max(0, Math.floor((Date.now() - oldestLagStartedAt) / 1_000)),
      requiredFailures: this.requiredFailureOwners.size,
      retryingSessions: retryStates.length,
      maxRetryAttempt: retryStates.reduce((maximum, retry) => Math.max(maximum, retry.attempt), 0),
      nextRetryAt: retryStates.length > 0 ? new Date(Math.min(...retryStates.map(({ nextAttemptAtMs }) => nextAttemptAtMs))).toISOString() : null,
      indexingRecoveries: this.indexingRecoveries,
      needsHumanRecoveries: this.needsHumanRecoveries,
      fallbackDelayMs: this.fallbackDelayMs,
      nextFallbackAt: this.nextFallbackAt,
      pendingReprojections: 0,
      activeIngestionPermits: this.activeIngestionPermits,
      pendingReprojectionRuns: 0,
      pendingReprojectedEvents: 0,
      pendingReprojectionRetries: 0,
      pendingReprojectionQuarantined: 0,
      pendingReprojectionNoPending: 0,
      pendingReprojectionNoCandidate: 0,
      pendingReprojectionIdentityMismatch: 0,
      pendingReprojectionRouteUnavailable: 0,
      multiplexTargets: this.currentMultiplexTargets.size,
      multiplexOverflow: this.multiplexOverflow,
      multiplexGeneration: this.multiplexGeneration,
      lastPendingReprojectionSkipReason: null,
      lastPendingReprojectionAt: null,
      lastRunAt: this.lastRunAt,
      lastSuccessfulIngestAt: this.lastSuccessfulIngestAt,
      lastFailureAt: this.lastFailureAt,
      lastFailureCode: this.lastFailureCode,
      lastFailure: this.lastFailure
    };
  }

  start(intervalMs = this.options.pollIntervalMs ?? 2_000): void {
    if (this.stopping || this.started) return;
    this.started = true;
    this.fallbackIntervalMs = intervalMs;
    this.runScheduledReconcile(intervalMs);
  }

  reconcile(): Promise<void> {
    this.cursorCooldownOwners.clear();
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.fallbackDelayMs = null;
    this.nextFallbackAt = null;
    const scan = this.reconcileInternal();
    if (this.started) this.scheduleAfter(scan);
    return scan;
  }

  private reconcilePeriodic(): Promise<void> {
    return this.reconcileInternal();
  }

  private runScheduledReconcile(intervalMs: number): void {
    this.scheduleAfter(this.reconcilePeriodic(), intervalMs);
  }

  private scheduleAfter(scan: Promise<void>, intervalMs = this.fallbackIntervalMs): void {
    void scan.then(
      () => this.scheduleFallback(intervalMs),
      () => this.scheduleFallback(intervalMs)
    );
  }

  private scheduleFallback(intervalMs = this.fallbackIntervalMs): void {
    if (this.stopping || !this.started) return;
    if (this.timer) clearTimeout(this.timer);
    const delay = this.isDegraded() ? intervalMs : HEALTHY_FALLBACK_INTERVAL_MS;
    this.fallbackDelayMs = delay;
    this.nextFallbackAt = new Date(Date.now() + delay).toISOString();
    this.timer = setTimeout(() => {
      this.timer = null;
      this.fallbackDelayMs = null;
      this.nextFallbackAt = null;
      this.runScheduledReconcile(intervalMs);
    }, delay);
    this.timer.unref();
  }

  private reconcileInternal(): Promise<void> {
    if (this.stopping) return Promise.resolve();
    if (this.scan) return this.scan;
    const scan = this.reconcileOnce();
    this.scan = scan;
    const release = () => { if (this.scan === scan) this.scan = null; };
    void scan.then(release, release);
    return scan;
  }

  async notifySources(sources: readonly SourceNotification[]): Promise<void> {
    if (this.stopping) return;
    const owners = new Map<string, SourceOwnerRoute>();
    let unknownSource = false;
    for (const notification of sources) {
      const owner = this.sourceOwners.get(notification.sourceId);
      if (!owner) { unknownSource = true; continue; }
      const releasedCooldown = this.cursorCooldownOwners.delete(owner.ownerKey);
      if (releasedCooldown) this.retries.delete(owner.ownerKey);
      if (!releasedCooldown && this.sourceNotificationCursors.get(notification.sourceId) === notification.latestCursor) continue;
      this.sourceNotificationCursors.set(notification.sourceId, notification.latestCursor);
      owners.set(owner.ownerKey, owner);
    }
    if (unknownSource) return this.reconcile();
    await mapWithConcurrency([...owners.values()], SESSION_INGESTION_CONCURRENCY, (owner) => this.enqueue(
      owner.ownerId, owner.paneId, owner.source, owner.identity, owner.ownerKey,
      owner.ownerKind, owner.generation, owner.onIngested
    ));
  }

  async handleMultiplexFrame(frame: CoreSessionEventMultiplexFrame, generation: number): Promise<void> {
    if (this.stopping || generation !== this.multiplexGeneration) return;
    const identity = frame.outcome === "batch" ? frame.batch : frame.gap;
    const entry = [...this.currentMultiplexTargets.values()].find(({ target }) => target.ringId === identity.ringId);
    if (!entry || entry.target.epoch !== identity.epoch || this.suspendedMultiplexOwners.has(entry.route.ownerKey)) return;
    if (frame.outcome === "batch") return this.enqueueMultiplexBatch(entry, frame.batch, generation);
    this.suspendedMultiplexOwners.add(entry.route.ownerKey);
    this.currentMultiplexTargets.delete(entry.route.ownerKey);
    this.desiredMultiplexTargets.delete(entry.route.ownerKey);
    await this.enqueue(entry.route.ownerId, entry.route.paneId, entry.route.source, entry.route.identity,
      entry.route.ownerKey, entry.route.ownerKind, entry.route.generation, entry.route.onIngested);
  }

  activateMultiplexTargets(targets: readonly CoreSessionEventMultiplexTarget[], generation: number): void {
    if (this.stopping || !Number.isSafeInteger(generation) || generation < 1 || generation < this.multiplexGeneration) return;
    const activated = new Map<string, MultiplexOwnerTarget>();
    for (const target of targets) {
      const desired = [...this.desiredMultiplexTargets.entries()].find(([, candidate]) =>
        candidate.target.ringId === target.ringId && candidate.target.epoch === target.epoch);
      if (desired) activated.set(desired[0], { ...desired[1], target });
    }
    if (activated.size !== targets.length) return;
    this.currentMultiplexTargets = activated;
    this.multiplexGeneration = generation;
    this.multiplexTransportActive = true;
    for (const ownerKey of activated.keys()) this.suspendedMultiplexOwners.delete(ownerKey);
  }

  async handleMultiplexTransportState(state: "connected" | "disconnected", generation: number): Promise<void> {
    if (this.stopping || generation < this.multiplexGeneration) return;
    if (state === "connected") {
      this.multiplexTransportActive = true;
      return;
    }
    this.multiplexTransportActive = false;
    const fallbackOwners = [...this.currentMultiplexTargets.values()];
    this.currentMultiplexTargets.clear();
    await mapWithConcurrency(fallbackOwners, SESSION_INGESTION_CONCURRENCY, (entry) => {
      this.suspendedMultiplexOwners.add(entry.route.ownerKey);
      return this.enqueue(entry.route.ownerId, entry.route.paneId, entry.route.source, entry.route.identity,
        entry.route.ownerKey, entry.route.ownerKind, entry.route.generation, entry.route.onIngested);
    });
  }

  async refreshMultiplexTargets(): Promise<readonly CoreSessionEventMultiplexTarget[]> {
    const selected = this.selectMultiplexTargets(this.desiredMultiplexTargets, true);
    const refresh = mapWithConcurrency([...selected.entries()], SESSION_INGESTION_CONCURRENCY, async ([ownerKey, candidate]) => {
      const prepared = await this.prepareMultiplexRoute(candidate.route);
      return prepared ? [ownerKey, prepared] as const : null;
    });
    let timeoutHandle: NodeJS.Timeout | null = null;
    const deadline = new Promise<never>((_, reject) => {
      timeoutHandle = setTimeout(() => reject(new Error("Core multiplex target refresh deadline exceeded")), this.multiplexRefreshDeadlineMs);
      timeoutHandle.unref();
    });
    let refreshedEntries: Array<readonly [string, MultiplexOwnerTarget] | null>;
    try { refreshedEntries = await Promise.race([refresh, deadline]); }
    finally { if (timeoutHandle) clearTimeout(timeoutHandle); }
    const refreshed = new Map(refreshedEntries.filter((entry): entry is readonly [string, MultiplexOwnerTarget] => entry !== null));
    if (refreshed.size === 0) throw new Error("No durable Core session multiplex targets are available");
    for (const [ownerKey, candidate] of refreshed) this.desiredMultiplexTargets.set(ownerKey, candidate);
    return [...refreshed.values()].map(({ target }) => target);
  }

  async stop(): Promise<void> {
    if (this.stopping) return;
    this.stopping = true;
    this.started = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.fallbackDelayMs = null;
    this.nextFallbackAt = null;
    await Promise.allSettled([...(this.scan ? [this.scan] : []), ...this.tails.values()]);
    this.tails.clear();
  }

  private async reconcileOnce(): Promise<void> {
    this.runCount += 1;
    this.lastRunAt = new Date().toISOString();
    let activeSessions = 0;
    const currentOwnerKeys = new Set<string>();
    const multiplexCandidates = new Map<string, MultiplexOwnerTarget>();
    const bindings = this.options.routes.listBindingsByState("active").filter((binding) => binding.agentKind === "traex" || binding.agentKind === "pi");
    await mapWithConcurrency(bindings, SESSION_INGESTION_CONCURRENCY, async (binding) => {
      const ownerKey = `primary:${binding.id}:${binding.generation}`;
      currentOwnerKeys.add(ownerKey);
      this.refreshRequiredFailure("primary", binding.id, binding.generation, ownerKey);
      const routeState = hasPersistedExactSession(binding) ? "route_unavailable" : "awaiting_first_session";
      if (this.cursorCooldownOwners.has(ownerKey) || this.retryPending(ownerKey) && routeState === "route_unavailable") return;
      let source: AgentTranscriptSource | null;
      try { source = this.options.resolveSource ? await this.options.resolveSource(binding) : transcriptSourceFor(binding); }
      catch (error) { this.recordFailure("primary", binding.id, binding.generation, ownerKey, binding.paneId, "route_resolution_failed", error); return; }
      if (!source || !hasExactSource(source)) {
        this.markUnavailable("primary", binding.id, binding.generation, ownerKey, routeState);
        return;
      }
      this.awaitingOwners.delete(ownerKey);
      activeSessions += 1;
      const route = this.ownerRoute(binding.id, source.paneId!, source, sessionProducerIdentity(source) ?? transcriptObserverIdentity(binding)!, ownerKey, "primary", binding.generation, () => this.options.onIngested(binding.id));
      await this.enqueueRoute(route);
      await this.collectMultiplexCandidate(route, multiplexCandidates);
    });
    const workers = this.options.workers?.listWorkerSessions().filter(hasExactWorkerSession) ?? [];
    await mapWithConcurrency(workers, SESSION_INGESTION_CONCURRENCY, async (worker) => {
      const ownerKey = `worker:${worker.id}:${worker.generation}:${worker.workerSessionGeneration}`;
      currentOwnerKeys.add(ownerKey);
      this.refreshRequiredFailure("worker", worker.id, worker.generation, ownerKey);
      if (this.cursorCooldownOwners.has(ownerKey) || this.retryPending(ownerKey)) return;
      let source: AgentTranscriptSource | null | undefined;
      try { source = await this.options.resolveWorkerSource?.(worker); }
      catch (error) { this.recordFailure("worker", worker.id, worker.generation, ownerKey, worker.runtimeRef?.paneId, "route_resolution_failed", error); return; }
      if (!source?.paneId || !hasExactSource(source)) { this.markUnavailable("worker", worker.id, worker.generation, ownerKey, "route_unavailable"); return; }
      this.awaitingOwners.delete(ownerKey);
      activeSessions += 1;
      const route = this.ownerRoute(worker.id, source.paneId, source, workerProducerIdentity(worker, source), ownerKey, "worker", worker.generation, () => this.options.onWorkerIngested?.(worker.id, source.paneId!));
      await this.enqueueRoute(route);
      await this.collectMultiplexCandidate(route, multiplexCandidates);
    });
    this.activeSessions = activeSessions;
    for (const key of this.requiredFailureOwners) if (!currentOwnerKeys.has(key)) this.requiredFailureOwners.delete(key);
    for (const key of this.awaitingOwners) if (!currentOwnerKeys.has(key)) this.awaitingOwners.delete(key);
    for (const key of this.laggingOwners) if (!currentOwnerKeys.has(key)) this.laggingOwners.delete(key);
    for (const key of this.laggingSince.keys()) if (!currentOwnerKeys.has(key)) this.laggingSince.delete(key);
    for (const key of this.retries.keys()) if (!currentOwnerKeys.has(key)) this.retries.delete(key);
    for (const key of this.cursorCooldownOwners) if (!currentOwnerKeys.has(key)) this.cursorCooldownOwners.delete(key);
    for (const key of this.suspendedMultiplexOwners) if (!currentOwnerKeys.has(key)) this.suspendedMultiplexOwners.delete(key);
    await this.replaceDesiredMultiplexTargets(multiplexCandidates);
    const recovery = await this.options.recoverCanonicalTurns?.();
    this.indexingRecoveries = recovery?.indexing ?? 0;
    this.needsHumanRecoveries = 0;
    if (recovery?.hasMore && !this.stopping) setImmediate(() => { void this.reconcilePeriodic(); });
    await this.options.reconcileCanonicalHumanMessages?.();
    try {
      const reserved = await this.options.retireLegacyInputCards?.(100) ?? 0;
      if (reserved > 0) this.options.wakeOutbound?.();
    } catch (error) {
      this.options.logger?.warn({ event: "legacy-input-card-retirement-scan-failed", err: safeLogError(error), outcome: "deferred" }, "deferred legacy Input Card retirement scan");
    }
  }

  private enqueue(ownerId: string, paneId: string, source: AgentTranscriptSource, identity: string, ownerKey: string, ownerKind: "primary" | "worker", generation: number, onIngested: () => void | Promise<void> | undefined): Promise<void> {
    return this.enqueueRoute(this.ownerRoute(ownerId, paneId, source, identity, ownerKey, ownerKind, generation, onIngested));
  }

  private ownerRoute(ownerId: string, paneId: string, source: AgentTranscriptSource, identity: string, ownerKey: string, ownerKind: "primary" | "worker", generation: number, onIngested: () => void | Promise<void> | undefined): SourceOwnerRoute {
    return { ownerId, paneId, source, identity, ownerKey, ownerKind, generation, onIngested };
  }

  private enqueueRoute(ownerRoute: SourceOwnerRoute): Promise<void> {
    const { ownerId, paneId, source, identity, ownerKey, ownerKind, generation, onIngested } = ownerRoute;
    const previous = this.tails.get(ownerKey) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(async () => {
      if (this.stopping) return;
      await this.acquireIngestionPermit();
      try {
        if (this.stopping) return;
        let caughtUp = false;
        let ingestedPages = 0;
        while (!this.stopping && !caughtUp && ingestedPages < MAX_INGESTION_PAGES_PER_WAKE) {
          ingestedPages += 1;
          const result = await this.options.ingestor.ingestCurrentSession(source);
          if (result.sourceId) this.rememberSource(result.sourceId, ownerRoute);
          this.requiredFailureOwners.delete(ownerKey);
          this.retries.delete(ownerKey);
          this.cursorCooldownOwners.delete(ownerKey);
          caughtUp = result.caughtUp;
          const repairedGap = caughtUp && this.suspendedMultiplexOwners.delete(ownerKey);
          if (caughtUp) this.clearLag(ownerKey); else this.markLag(ownerKey);
          this.lastSuccessfulIngestAt = new Date().toISOString();
          if (result.ingestedEvents > 0) await onIngested();
          if (repairedGap) await this.restoreMultiplexRoute(ownerRoute);
          this.options.logger?.debug({ event: "core-session-ingestion-converged", ownerId, laneId: result.laneId, ingestedEvents: result.ingestedEvents, caughtUp, outcome: "succeeded" }, "converged Core session ingestion");
          if (!caughtUp) await new Promise<void>((resolve) => setImmediate(resolve));
        }
        if (!caughtUp && !this.stopping) {
          setImmediate(() => {
            if (!this.stopping) void this.enqueue(ownerId, paneId, source, identity, ownerKey, ownerKind, generation, onIngested);
          });
        }
      } catch (error) {
        if (error instanceof CoreSessionUnrecoverableCursorError) this.rememberSource(error.sourceId, ownerRoute);
        const failureCode = ingestionFailureCode(error);
        this.recordFailure(ownerKind, ownerId, generation, ownerKey, paneId, failureCode, error);
      } finally { this.releaseIngestionPermit(); }
    });
    this.tails.set(ownerKey, work);
    void work.finally(() => { if (this.tails.get(ownerKey) === work) this.tails.delete(ownerKey); });
    return work;
  }

  private async collectMultiplexCandidate(route: SourceOwnerRoute, candidates: Map<string, MultiplexOwnerTarget>): Promise<void> {
    if (!this.options.ingestor.prepareMultiplexTarget || !this.options.replaceMultiplexTargets
      || this.retries.has(route.ownerKey) || this.cursorCooldownOwners.has(route.ownerKey) || this.suspendedMultiplexOwners.has(route.ownerKey)) return;
    const prepared = await this.prepareMultiplexRoute(route);
    if (prepared) candidates.set(route.ownerKey, prepared);
    else {
      const current = this.currentMultiplexTargets.get(route.ownerKey);
      if (current && current.route.identity === route.identity) candidates.set(route.ownerKey, { route, target: current.target });
    }
  }

  private async prepareMultiplexRoute(route: SourceOwnerRoute): Promise<MultiplexOwnerTarget | null> {
    if (!this.options.ingestor.prepareMultiplexTarget) return null;
    try {
      return { route, target: await this.options.ingestor.prepareMultiplexTarget(route.source) };
    } catch (error) {
      this.options.logger?.warn({ event: "core-session-multiplex-target-failed", ownerId: route.ownerId,
        err: safeLogError(error), outcome: "v2_fallback" }, "kept Core session owner on v2 fallback");
      return null;
    }
  }

  private async restoreMultiplexRoute(route: SourceOwnerRoute): Promise<void> {
    const repaired = await this.prepareMultiplexRoute(route);
    if (!repaired) return;
    const desired = new Map(this.desiredMultiplexTargets);
    desired.set(route.ownerKey, repaired);
    await this.replaceDesiredMultiplexTargets(desired);
  }

  private async replaceDesiredMultiplexTargets(desired: Map<string, MultiplexOwnerTarget>): Promise<void> {
    if (!this.options.replaceMultiplexTargets) return;
    this.desiredMultiplexTargets = desired;
    const selected = this.selectMultiplexTargets(desired);
    this.multiplexOverflow = Math.max(0, desired.size - selected.size);
    if (selected.size === 0) {
      this.currentMultiplexTargets = selected;
      if (this.multiplexTransportActive) {
        await this.options.clearMultiplexTargets?.();
        this.multiplexTransportActive = false;
      }
      return;
    }
    await this.replaceSelectedMultiplexTargets(selected);
  }

  private selectMultiplexTargets(desired: Map<string, MultiplexOwnerTarget>, includeSuspended = false): Map<string, MultiplexOwnerTarget> {
    const selected = new Map<string, MultiplexOwnerTarget>();
    for (const [ownerKey, current] of this.currentMultiplexTargets) {
      const candidate = desired.get(ownerKey);
      if (candidate && (includeSuspended || !this.suspendedMultiplexOwners.has(ownerKey))) selected.set(ownerKey, candidate);
    }
    for (const [ownerKey, candidate] of [...desired].sort(([left], [right]) => left.localeCompare(right))) {
      if (selected.size >= 128) break;
      if (!selected.has(ownerKey) && (includeSuspended || !this.suspendedMultiplexOwners.has(ownerKey))) selected.set(ownerKey, candidate);
    }
    return selected;
  }

  private async replaceSelectedMultiplexTargets(selected: Map<string, MultiplexOwnerTarget>): Promise<void> {
    const replaceTargets = this.options.replaceMultiplexTargets;
    if (!replaceTargets) return;
    const changed = !sameMultiplexTargets(this.currentMultiplexTargets, selected);
    if (!changed) {
      this.currentMultiplexTargets = selected;
      return;
    }
    try {
      const previousGeneration = this.multiplexGeneration;
      const generation = await replaceTargets([...selected.values()].map(({ target }) => target));
      if (this.multiplexGeneration === previousGeneration) {
        this.currentMultiplexTargets = selected;
        this.multiplexGeneration = typeof generation === "number" && Number.isSafeInteger(generation) && generation > 0
          ? generation
          : previousGeneration + 1;
        this.multiplexTransportActive = true;
        for (const ownerKey of selected.keys()) this.suspendedMultiplexOwners.delete(ownerKey);
      }
    } catch (error) {
      this.options.logger?.warn({ event: "core-session-multiplex-replacement-failed", targetCount: selected.size,
        err: safeLogError(error), outcome: "v2_fallback" }, "kept previous Core session multiplex generation");
    }
  }

  private enqueueMultiplexBatch(entry: MultiplexOwnerTarget, batch: CoreSessionEventMultiplexBatch, generation: number): Promise<void> {
    const { route } = entry;
    const previous = this.tails.get(route.ownerKey) ?? Promise.resolve();
    const work = previous.catch(() => undefined).then(async () => {
      if (this.stopping || generation !== this.multiplexGeneration || this.suspendedMultiplexOwners.has(route.ownerKey)) return;
      const current = this.currentMultiplexTargets.get(route.ownerKey);
      if (!current || current.target.ringId !== batch.ringId || current.target.epoch !== batch.epoch || !this.options.ingestor.ingestMultiplexBatch) return;
      await this.acquireIngestionPermit();
      try {
        const result = await this.options.ingestor.ingestMultiplexBatch(route.source, current.target, batch);
        const updated = { ...current, target: { ...current.target, after: result.readCursor } };
        if (result.outcome === "stale_rebase") {
          this.suspendedMultiplexOwners.add(route.ownerKey);
          this.currentMultiplexTargets.delete(route.ownerKey);
          const replacement = await this.prepareMultiplexRoute(route) ?? updated;
          this.desiredMultiplexTargets.set(route.ownerKey, replacement);
          await this.replaceSelectedMultiplexTargets(this.selectMultiplexTargets(this.desiredMultiplexTargets, true));
          return;
        }
        this.currentMultiplexTargets.set(route.ownerKey, updated);
        if (this.desiredMultiplexTargets.has(route.ownerKey)) this.desiredMultiplexTargets.set(route.ownerKey, updated);
        this.requiredFailureOwners.delete(route.ownerKey);
        this.retries.delete(route.ownerKey);
        this.cursorCooldownOwners.delete(route.ownerKey);
        if (result.caughtUp) this.clearLag(route.ownerKey); else this.markLag(route.ownerKey);
        this.lastSuccessfulIngestAt = new Date().toISOString();
        if (result.ingestedEvents > 0) await route.onIngested();
      } catch (error) {
        this.recordFailure(route.ownerKind, route.ownerId, route.generation, route.ownerKey, route.paneId, ingestionFailureCode(error), error);
      } finally { this.releaseIngestionPermit(); }
    });
    this.tails.set(route.ownerKey, work);
    void work.finally(() => { if (this.tails.get(route.ownerKey) === work) this.tails.delete(route.ownerKey); });
    return work;
  }

  private acquireIngestionPermit(): Promise<void> {
    if (this.activeIngestionPermits < SESSION_INGESTION_CONCURRENCY) {
      this.activeIngestionPermits += 1;
      return Promise.resolve();
    }
    return new Promise<void>((resolve) => { this.ingestionPermitWaiters.push(resolve); });
  }

  private releaseIngestionPermit(): void {
    const next = this.ingestionPermitWaiters.shift();
    if (next) next();
    else this.activeIngestionPermits -= 1;
  }

  private markUnavailable(ownerKind: "primary" | "worker", ownerId: string, generation: number, ownerKey: string, routeState: "awaiting_first_session" | "route_unavailable"): void {
    this.retries.delete(ownerKey);
    const required = this.options.requiresIngestion?.(ownerKind, ownerId, generation) ?? false;
    if (routeState === "awaiting_first_session" && !required) {
      this.awaitingOwners.add(ownerKey);
      this.requiredFailureOwners.delete(ownerKey);
      this.clearLag(ownerKey);
      return;
    }
    this.awaitingOwners.delete(ownerKey);
    this.markLag(ownerKey);
    if (required) this.requiredFailureOwners.add(ownerKey);
    else this.requiredFailureOwners.delete(ownerKey);
    this.lastFailureAt = new Date().toISOString();
    this.lastFailureCode = "route_unavailable";
    this.lastFailure = "Exact Core session ingestion route is unavailable";
  }

  private rememberSource(sourceId: string, route: SourceOwnerRoute): void {
    for (const [knownSourceId, knownRoute] of this.sourceOwners) {
      if (knownRoute.ownerKey === route.ownerKey && knownSourceId !== sourceId) {
        this.sourceOwners.delete(knownSourceId);
        this.sourceNotificationCursors.delete(knownSourceId);
      }
    }
    this.sourceOwners.delete(sourceId);
    this.sourceOwners.set(sourceId, route);
    while (this.sourceOwners.size > 256) {
      const oldestSourceId = this.sourceOwners.keys().next().value!;
      this.sourceOwners.delete(oldestSourceId);
      this.sourceNotificationCursors.delete(oldestSourceId);
    }
  }

  private recordFailure(ownerKind: "primary" | "worker", ownerId: string, generation: number, ownerKey: string, paneId: string | null | undefined, failureCode: NonNullable<CoreSessionIngestionDiagnostics["lastFailureCode"]>, error: unknown): void {
    this.awaitingOwners.delete(ownerKey);
    this.lastFailureAt = new Date().toISOString();
    this.lastFailureCode = failureCode;
    this.lastFailure = safeLogError(error).message;
    this.markLag(ownerKey);
    const unrecoverableCursor = failureCode === "unrecoverable_cursor";
    if (unrecoverableCursor) {
      this.cursorCooldownOwners.add(ownerKey);
      this.retries.delete(ownerKey);
    }
    const retry = unrecoverableCursor ? null : this.scheduleRetry(ownerKey);
    if (this.options.requiresIngestion?.(ownerKind, ownerId, generation)) this.requiredFailureOwners.add(ownerKey);
    else this.requiredFailureOwners.delete(ownerKey);
    this.options.logger?.warn({ event: "core-session-ingestion-failed", ownerId, paneId, failureCode,
      retryAttempt: retry?.attempt ?? null, nextRetryAt: retry ? new Date(retry.nextAttemptAtMs).toISOString() : null,
      cooldown: unrecoverableCursor, err: safeLogError(error), outcome: "deferred" }, "deferred Core session ingestion");
  }

  private retryPending(ownerKey: string): boolean {
    const retry = this.retries.get(ownerKey);
    return Boolean(retry && retry.nextAttemptAtMs > Date.now());
  }

  private refreshRequiredFailure(ownerKind: "primary" | "worker", ownerId: string, generation: number, ownerKey: string): void {
    const required = this.options.requiresIngestion?.(ownerKind, ownerId, generation) ?? false;
    if (required && (this.retries.has(ownerKey) || this.cursorCooldownOwners.has(ownerKey))) this.requiredFailureOwners.add(ownerKey);
    else if (!required) this.requiredFailureOwners.delete(ownerKey);
  }

  private scheduleRetry(ownerKey: string): SessionIngestionRetry {
    const attempt = (this.retries.get(ownerKey)?.attempt ?? 0) + 1;
    const baseMs = this.options.retryBaseMs ?? Math.max(1_000, this.options.pollIntervalMs ?? 2_000);
    const maxMs = this.options.retryMaxMs ?? 30_000;
    const retry = { attempt, nextAttemptAtMs: Date.now() + Math.min(baseMs * (2 ** (attempt - 1)), maxMs) };
    this.retries.set(ownerKey, retry);
    return retry;
  }

  private isDegraded(): boolean {
    return this.awaitingOwners.size > 0 || this.laggingOwners.size > 0
      || this.retries.size > 0 || this.requiredFailureOwners.size > 0;
  }

  private markLag(ownerKey: string): void {
    this.laggingOwners.add(ownerKey);
    if (!this.laggingSince.has(ownerKey)) this.laggingSince.set(ownerKey, Date.now());
  }

  private clearLag(ownerKey: string): void {
    this.laggingOwners.delete(ownerKey);
    this.laggingSince.delete(ownerKey);
  }
}

function ingestionFailureCode(error: unknown): NonNullable<CoreSessionIngestionDiagnostics["lastFailureCode"]> {
  if (error instanceof CoreSessionUnrecoverableCursorError) return "unrecoverable_cursor";
  return error instanceof Error && error.name === "CoreSessionCursorExpiredError" ? "cursor_expired" : "session_ingestion_failed";
}

function hasPersistedExactSession(binding: Binding): boolean {
  const session = transcriptSourceFor(binding).nativeSession;
  return Boolean(session?.kind === "id" && session.source && session.agent && session.value);
}

function hasExactWorkerSession(instance: AgentInstance): boolean {
  return instance.role === "worker" && instance.workerSessionLifecycle === "active"
    && instance.desiredState === "running" && (instance.agentKind === "traex" || instance.agentKind === "pi")
    && Boolean(instance.runtimeRef?.paneId && instance.runtimeRef.nativeSessionId && instance.parent?.bindingId
      && instance.parent.bindingGeneration && instance.parent.paneId);
}

function workerProducerIdentity(instance: AgentInstance, source: AgentTranscriptSource): string {
  const parent = instance.parent!;
  const session = source.nativeSession!;
  return [instance.id, String(instance.generation), String(instance.workerSessionGeneration), parent.bindingId,
    String(parent.bindingGeneration), parent.paneId, source.paneId!, source.terminalId!, source.agentKind,
    session.source, session.agent, session.kind, session.value]
    .map((field) => `${field.length}:${field}`).join("");
}

export async function resolvePrimarySessionIngestionSource(candidate: Binding, dependencies: {
  getBinding(id: string): Binding | null;
  getPane(paneId: string): Promise<HerdrPane | null>;
}): Promise<AgentTranscriptSource | null> {
  if (candidate.state !== "active" || !candidate.paneId) return null;
  const pane = await dependencies.getPane(candidate.paneId);
  const binding = dependencies.getBinding(candidate.id);
  if (!binding || binding.state !== "active" || binding.generation !== candidate.generation
    || binding.paneId !== candidate.paneId || binding.agentKind !== candidate.agentKind) return null;
  const source = transcriptSourceFor(binding);
  if (!pane?.terminalId || pane.agentSession?.kind !== "id" || source.nativeSession?.kind !== "id"
    || pane.paneId !== source.paneId || pane.agentKind !== source.agentKind
    || pane.agentSession.value !== source.nativeSession.value) return null;
  return { ...source, terminalId: pane.terminalId };
}

export async function resolveWorkerSessionIngestionSource(candidate: AgentInstance, dependencies: {
  getAgentInstance(id: string): AgentInstance | null;
  getBinding(id: string): Binding | null;
  getPane(paneId: string): Promise<HerdrPane | null>;
}): Promise<AgentTranscriptSource | null> {
  const candidateParent = candidate.parent;
  const candidateRuntime = candidate.runtimeRef;
  if (candidate.role !== "worker" || candidate.workerSessionLifecycle !== "active"
    || (candidate.agentKind !== "traex" && candidate.agentKind !== "pi")
    || !candidateParent?.bindingGeneration || !candidateRuntime?.nativeSessionId) return null;
  const pane = await dependencies.getPane(candidateRuntime.paneId);
  const instance = dependencies.getAgentInstance(candidate.id);
  const parent = instance?.parent;
  const runtime = instance?.runtimeRef;
  if (!instance || instance.generation !== candidate.generation || instance.workerSessionGeneration !== candidate.workerSessionGeneration
    || instance.workerSessionLifecycle !== "active" || (instance.agentKind !== "traex" && instance.agentKind !== "pi")
    || !parent?.bindingGeneration || !runtime?.nativeSessionId
    || parent.bindingId !== candidateParent.bindingId || parent.bindingGeneration !== candidateParent.bindingGeneration
    || parent.paneId !== candidateParent.paneId || runtime.generation !== candidateRuntime.generation
    || runtime.paneId !== candidateRuntime.paneId || runtime.nativeSessionId !== candidateRuntime.nativeSessionId) return null;
  const binding = dependencies.getBinding(parent.bindingId);
  if (!binding || binding.generation !== parent.bindingGeneration || binding.paneId !== parent.paneId) return null;
  if (!pane?.terminalId || pane.paneId !== runtime.paneId
    || pane.agentKind !== instance.agentKind || pane.agentSession?.kind !== "id"
    || pane.agentSession.value !== runtime.nativeSessionId) return null;
  return {
    agentKind: instance.agentKind, bindingId: instance.id, generation: instance.generation,
    paneId: runtime.paneId, terminalId: pane.terminalId,
    nativeSession: { source: pane.agentSession.source, agent: pane.agentSession.agent, kind: "id", value: runtime.nativeSessionId },
    sessionActivityContext: {
      scope: { kind: "pane", workspaceId: binding.workspaceId, paneId: parent.paneId },
      ownerFence: {
        kind: "worker", id: instance.id, generation: instance.generation, sessionGeneration: instance.workerSessionGeneration,
        parent: { id: binding.id, generation: binding.generation, sessionGeneration: binding.sessionEpoch }
      },
      producer: {
        kind: "worker", id: instance.id, runtimeGeneration: runtime.generation,
        sessionGeneration: instance.workerSessionGeneration, runtimePaneId: runtime.paneId
      }
    }
  };
}

function sessionProducerIdentity(source: AgentTranscriptSource): string | null {
  const session = source.nativeSession;
  if (!source.bindingId || !source.paneId || !source.terminalId || session?.kind !== "id") return null;
  return [source.bindingId, String(source.generation), source.paneId, source.terminalId, source.agentKind, session.source, session.agent, session.value]
    .map((field) => `${field.length}:${field}`).join("");
}

function hasExactSource(source: AgentTranscriptSource): boolean {
  return Boolean(source.paneId && source.terminalId && source.nativeSession?.kind === "id");
}

function sameMultiplexTargets(left: ReadonlyMap<string, MultiplexOwnerTarget>, right: ReadonlyMap<string, MultiplexOwnerTarget>): boolean {
  if (left.size !== right.size) return false;
  for (const [ownerKey, candidate] of right) {
    const current = left.get(ownerKey);
    if (!current || current.target.ringId !== candidate.target.ringId || current.target.epoch !== candidate.target.epoch
      || current.target.after !== candidate.target.after || current.target.limit !== candidate.target.limit) return false;
  }
  return true;
}
