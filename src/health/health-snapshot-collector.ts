import type { HerdrPort } from "../domain/ports/external.js";
import type { DatabaseDiagnosticsStore, HealthStore } from "../domain/ports/health.js";
import type { CoreSessionIngestionDiagnostics, DatabaseDiagnosticsFailureClass, DatabaseDiagnosticsInspection, DatabaseDiagnosticsStatus, HerdrCircuitBreakerStatus, InboundDispatcherDiagnostics, InstanceLeaseStatus, InstanceWorkerDiagnostics, OperationalSummary, ProjectConfig, PromptWorkerDiagnostics, ReconciliationDiagnostics, SessionOperationDispatcherDiagnostics, SqliteIntegrityDiagnostics, StartupRecoveryDiagnostics, WorkspaceCacheStatus } from "../domain/types.js";
import type { LifecycleEventDiagnostics } from "../events/bridge-event-bus.js";
import type { CardUpdateSchedulerDiagnostics } from "../events/card-update-scheduler.js";
import type { GatewaySession, GatewayStatus } from "../gateways/contract/plugin.js";
import { validateProjectDirectories } from "../config.js";
import type { BuildIdentity } from "../runtime/build-identity.js";
import type { HerdrSocketStatus } from "../runtime/herdr-socket-subscriber.js";
import { mapWithConcurrency } from "../runtime/map-with-concurrency.js";
import { safeLogError } from "../runtime/safe-error.js";
import type { RecoverySupervisorDiagnostics } from "../domain/recovery.js";
import type { AgentInputCapabilityStatus } from "../runtime/agent-input-capability.js";
import type { DeliverySnapshot } from "../domain/delivery-engine.js";
import type { ShutdownContext } from "../runtime/shutdown-context.js";

interface ComponentState { ok: boolean; error?: string }
const diagnosticFailure = Symbol("diagnosticFailure");
type DiagnosticFailure = { error: string; [diagnosticFailure]: true };
type HerdrReadiness = ComponentState & { workspaces: Array<{ workspaceId: string; ok: boolean; error?: string }> };
export interface HealthReadiness {
  status: "ready" | "not_ready";
  components: {
    database: ComponentState; projects: ComponentState; gateway: ComponentState; lark: ComponentState;
    lease: InstanceLeaseStatus & { ok: boolean };
    herdr: HerdrReadiness;
    core?: ComponentState;
    agentInput?: ComponentState & Pick<AgentInputCapabilityStatus, "required" | "detected" | "supported">;
    sqliteIntegrity?: ComponentState;
    instanceRuntime?: ComponentState;
    deliveryEngine?: ComponentState;
  };
}

export interface HealthSnapshotOptions {
  store: HealthStore; herdr: HerdrPort; gateway?: Pick<GatewaySession, "snapshot">; /** @deprecated test compatibility */ lark?: { isReady(): boolean }; projects: readonly ProjectConfig[];
  lease: { snapshot(): InstanceLeaseStatus };
  workspaceCache?: { status(): WorkspaceCacheStatus };
  herdrCircuitBreaker?: { status(): HerdrCircuitBreakerStatus };
  agentInputCapability?: { snapshot(): AgentInputCapabilityStatus };
  coreSessionIngestion?: { snapshot(): CoreSessionIngestionDiagnostics };
  startupRecovery?: { snapshot(): StartupRecoveryDiagnostics };
  inboundDispatcher?: { snapshot(): InboundDispatcherDiagnostics };
  sessionOperationDispatcher?: { snapshot(): SessionOperationDispatcherDiagnostics };
  sqliteIntegrity?: { snapshot(): SqliteIntegrityDiagnostics };
  lifecycleEvents?: LifecycleEventDiagnostics;
  cardConvergence?: { snapshot(): CardUpdateSchedulerDiagnostics };
  deliveryEngine?: { snapshot(): DeliverySnapshot };
  promptWorker?: { snapshot(): PromptWorkerDiagnostics };
  recoverySupervisor?: { snapshot(): RecoverySupervisorDiagnostics };
  instanceWorker?: { snapshot(): InstanceWorkerDiagnostics };
  bindingRuntime?: { snapshot(): ReconciliationDiagnostics };
  instanceRuntime?: { snapshot(): { ready: boolean; lastError: string | null } & Partial<ReconciliationDiagnostics> };
  herdrSocket?: { status(): HerdrSocketStatus };
  buildIdentity: BuildIdentity;
  diagnostics: DatabaseDiagnosticsStore;
  clock?: () => number;
  diagnosticsTtlMs?: number;
  diagnosticsTimeoutMs?: number;
  diagnosticsIssueLimit?: number;
  retryBackoffMinMs?: number;
  retryBackoffMaxMs?: number;
  readinessTtlMs?: number;
  workspaceReadinessRetryBackoffMinMs?: number;
  workspaceReadinessRetryBackoffMaxMs?: number;
  /** @deprecated status now uses diagnostics stale-while-revalidate caching. */ statusTtlMs?: number;
}

type StatusSnapshot = { body: Record<string, unknown>; cacheable: boolean };
type DatabaseDiagnosticsView = { operational: OperationalSummary | { error: string }; status: DatabaseDiagnosticsStatus };
const WORKSPACE_READINESS_CONCURRENCY = 4;
const DEFAULT_DIAGNOSTICS_TTL_MS = 1_000;
const DEFAULT_DIAGNOSTICS_TIMEOUT_MS = 10_000;
const DEFAULT_RETRY_BACKOFF_MIN_MS = 250;
const DEFAULT_RETRY_BACKOFF_MAX_MS = 5_000;

export class HealthSnapshotCollector {
  private readonly workspaceReadinessCache: SnapshotCache<HerdrReadiness>;
  private readonly clock: () => number;
  private diagnosticsValue: { inspection: DatabaseDiagnosticsInspection; collectedAt: number } | null = null;
  private diagnosticsRefresh: Promise<void> | null = null;
  private diagnosticsFailureClass: DatabaseDiagnosticsFailureClass | null = null;
  private diagnosticsRetryAt: number | null = null;
  private diagnosticsFailureCount = 0;
  private diagnosticsAbort: AbortController | null = null;
  private stopping = false;

  constructor(private readonly options: HealthSnapshotOptions) {
    this.clock = options.clock ?? Date.now;
    this.workspaceReadinessCache = new SnapshotCache(
      () => inspectHerdrReadiness(options.herdr, options.projects),
      options.readinessTtlMs ?? 2_000,
      this.clock,
      {
        retryBackoffMinMs: options.workspaceReadinessRetryBackoffMinMs ?? DEFAULT_RETRY_BACKOFF_MIN_MS,
        retryBackoffMaxMs: options.workspaceReadinessRetryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS,
        shouldCache: (value) => value.ok,
        failureOf: (value) => value.ok ? null : value.error ?? "Herdr workspace readiness refresh failed"
      }
    );
  }

  async readiness(): Promise<HealthReadiness> {
    return inspectReadiness(this.options, await this.workspaceReadinessCache.read()).readiness;
  }

  async status(): Promise<Record<string, unknown>> {
    const [databaseDiagnostics, herdrReadiness] = await Promise.all([
      this.readDatabaseDiagnostics(),
      this.workspaceReadinessCache.readStaleWhileRefreshing()
    ]);
    return this.collectStatus(databaseDiagnostics, herdrReadiness).body;
  }

  async stop(context: ShutdownContext): Promise<void> {
    this.stopping = true;
    const workspaceRefresh = this.workspaceReadinessCache.stop();
    const refresh = this.diagnosticsRefresh;
    if (refresh) {
      const reason = context.signal.aborted
        ? context.signal.reason
        : Object.assign(new Error("SQLite diagnostics stopped"), { failureClass: "other" as const });
      this.diagnosticsAbort?.abort(reason);
    }
    await Promise.all([workspaceRefresh, refresh ?? Promise.resolve()]);
  }

  private collectStatus(databaseDiagnostics: DatabaseDiagnosticsView, herdrReadiness: HerdrReadiness): StatusSnapshot {
    const options = this.options;
    const { readiness, instanceRuntime, herdrCircuitBreaker, coreSessionIngestion, sqliteIntegrity, deliveryEngine } = inspectReadiness(options, herdrReadiness);
    const workspaceSnapshot = this.workspaceReadinessCache.status();
    const herdrReadinessSnapshot = {
      state: workspaceSnapshot.state,
      refreshing: workspaceSnapshot.refreshing,
      collectedAt: workspaceSnapshot.collectedAt === null ? null : new Date(workspaceSnapshot.collectedAt).toISOString(),
      lastFailure: workspaceSnapshot.lastFailure === null ? null : boundedError(workspaceSnapshot.lastFailure),
      failedWorkspaceIds: workspaceSnapshot.lastFailedValue?.workspaces
        .filter((workspace) => !workspace.ok).slice(0, 8).map((workspace) => workspace.workspaceId) ?? [],
      retryAt: workspaceSnapshot.retryAt === null ? null : new Date(workspaceSnapshot.retryAt).toISOString()
    };
    const sqliteDiagnostics = { ...databaseDiagnostics.status, ...sqlitePhysicalStatus(sqliteIntegrity) };
    const operational = databaseDiagnostics.operational;
    const promptWorker = collectDiagnostic<PromptWorkerDiagnostics>(() => options.promptWorker?.snapshot());
    const recovery = collectDiagnostic<RecoverySupervisorDiagnostics>(() => options.recoverySupervisor?.snapshot());
    const instanceWorker = collectDiagnostic<InstanceWorkerDiagnostics>(() => options.instanceWorker?.snapshot());
    const startupRecovery = collectDiagnostic<StartupRecoveryDiagnostics>(() => options.startupRecovery?.snapshot());
    const inboundDispatcher = collectDiagnostic<InboundDispatcherDiagnostics>(() => options.inboundDispatcher?.snapshot());
    const sessionOperationDispatcher = collectDiagnostic<SessionOperationDispatcherDiagnostics>(() => options.sessionOperationDispatcher?.snapshot());
    const bindingRuntime = collectDiagnostic<ReconciliationDiagnostics>(() => options.bindingRuntime?.snapshot());
    const cardConvergence = collectDiagnostic<CardUpdateSchedulerDiagnostics>(() => options.cardConvergence?.snapshot());
    const lifecycleEvents = collectDiagnostic(() => options.lifecycleEvents?.snapshot());
    const workspaceCache = collectDiagnostic<WorkspaceCacheStatus>(() => options.workspaceCache?.status());
    const herdrSocket = collectDiagnostic<HerdrSocketStatus>(() => options.herdrSocket?.status());
    const reconciliation = bindingRuntime || instanceRuntime ? { ...(bindingRuntime ? { bindingRuntime } : {}), ...(instanceRuntime ? { instanceRuntime } : {}) } : undefined;
    const diagnostics = [deliveryEngine, promptWorker, recovery, instanceWorker, herdrCircuitBreaker, coreSessionIngestion, startupRecovery, inboundDispatcher, sessionOperationDispatcher, sqliteIntegrity, bindingRuntime, instanceRuntime, cardConvergence, lifecycleEvents, workspaceCache, herdrSocket];
    const diagnosticCollectionFailed = diagnostics.some(isDiagnosticError);
    const operationalDegraded = "error" in operational
      || operational.semanticDeliveryRollout.phase !== "expansion" && operational.semanticDeliveryRollout.blockers.some((blocker) => blocker !== "backup_restore_rehearsal_missing")
      || operational.coreProjection.oldestPendingAgeSeconds !== null && operational.coreProjection.oldestPendingAgeSeconds >= 300
      || operational.retiredPaneCleanup.oldestActiveAgeSeconds !== null && operational.retiredPaneCleanup.oldestActiveAgeSeconds >= 300
      || operational.eligibleDeadLetterRecoveries > 0
      || operational.projectionDeliveryRecovery.backlog > 0
      || operational.larkDeliveryCooldown.active
      || operational.deliveryRings.isolatedConflicts > 0
      || operational.deliveryRings.pendingHumanReviews > 0
      || operational.paneTopology.uncertain > 0
      || (operational.outboxQuarantines.current ?? operational.outboxQuarantines.active) > 0
      || (operational.projectionGaps.current ?? operational.projectionGaps.open) > 0
      || operational.turnRecovery.pending > 0
      || operational.inbound.oldestPendingAgeSeconds !== null && operational.inbound.oldestPendingAgeSeconds >= 300;
    const sessionOperationsDegraded = !("error" in operational) && operational.sessionOperations.oldestAcceptedAgeSeconds !== null && operational.sessionOperations.oldestAcceptedAgeSeconds >= 300;
    const body = {
      status: readiness.status === "ready" && !operationalDegraded && !sessionOperationsDegraded
        && workspaceSnapshot.lastFailure === null
        && sqliteDiagnostics.state === "fresh" && sqliteDiagnostics.physicalState !== "failed" && sqliteDiagnostics.semanticIssueCount === 0
        && !(promptWorker && "error" in promptWorker)
        && !(inboundDispatcher && "error" in inboundDispatcher)
        && !(sessionOperationDispatcher && "error" in sessionOperationDispatcher)
        && !(recovery && ("error" in recovery || recovery.lastPassOutcome === "failed"))
        && !(instanceWorker && ("error" in instanceWorker || instanceWorker.activeDispatchWorkers > 0 || instanceWorker.activeObservers > 0 || instanceWorker.activeTurns > 0 || instanceWorker.uncertainTurns > 0))
        && !(herdrCircuitBreaker && ("error" in herdrCircuitBreaker || herdrCircuitBreaker.state !== "closed" || herdrCircuitBreaker.consecutiveFailures > 0))
        && !(startupRecovery && ("error" in startupRecovery || startupRecovery.state === "degraded"))
        && !(bindingRuntime && ("error" in bindingRuntime || bindingRuntime.lastOutcome === "failed")) && !(instanceRuntime && "error" in instanceRuntime)
        && !diagnosticCollectionFailed
        && !(sqliteIntegrity && (!("quickCheck" in sqliteIntegrity) || sqliteIntegrity.state === "idle" || sqliteIntegrity.state === "degraded" || sqliteIntegrity.state === "running" && (sqliteIntegrity.quickCheck !== "ok" || sqliteIntegrity.issues.length > 0 || sqliteIntegrity.error !== null))) ? "ok" : "degraded", identity: options.buildIdentity,
      timestamp: new Date(this.clock()).toISOString(), uptimeSeconds: Math.floor(process.uptime()), readiness, herdrReadinessSnapshot, operational, sqliteDiagnostics, lease: leaseStatus(readiness.components.lease),
      ...(deliveryEngine ? { deliveryEngine } : {}), ...(promptWorker ? { promptWorker } : {}), ...(recovery ? { recovery } : {}), ...(instanceWorker ? { instanceWorker } : {}),
      ...(workspaceCache ? { workspaceCache } : {}), ...(herdrCircuitBreaker ? { herdrCircuitBreaker } : {}), ...(startupRecovery ? { startupRecovery } : {}),
      ...(coreSessionIngestion ? { coreSessionIngestion } : {}),
      ...(inboundDispatcher ? { inboundDispatcher } : {}), ...(sessionOperationDispatcher ? { sessionOperationDispatcher } : {}), ...(sqliteIntegrity ? { sqliteIntegrity } : {}),
      ...(reconciliation ? { reconciliation } : {}), ...(cardConvergence ? { cardConvergence } : {}), ...(herdrSocket ? { herdrSocket } : {}), ...(lifecycleEvents ? { lifecycleEvents } : {})
    };
    return { body, cacheable: !("error" in operational) && !diagnosticCollectionFailed };
  }

  private async readDatabaseDiagnostics(): Promise<DatabaseDiagnosticsView> {
    const now = this.clock();
    let refreshed = false;
    if (!this.diagnosticsValue && !this.stopping) {
      if (this.diagnosticsRetryAt === null || now >= this.diagnosticsRetryAt) {
        await this.startDiagnosticsRefresh();
        refreshed = true;
      }
    } else if (this.diagnosticsValue && !this.stopping && now - this.diagnosticsValue.collectedAt > this.diagnosticsTtlMs()
      && (this.diagnosticsRetryAt === null || now >= this.diagnosticsRetryAt)) {
      void this.startDiagnosticsRefresh();
    }
    return this.databaseDiagnosticsView(refreshed);
  }

  private startDiagnosticsRefresh(): Promise<void> {
    if (this.diagnosticsRefresh) return this.diagnosticsRefresh;
    if (this.stopping) return Promise.resolve();
    const controller = new AbortController();
    this.diagnosticsAbort = controller;
    const timeout = setTimeout(
      () => controller.abort(Object.assign(new Error("SQLite diagnostics timeout"), { failureClass: "timeout" as const })),
      this.options.diagnosticsTimeoutMs ?? DEFAULT_DIAGNOSTICS_TIMEOUT_MS
    );
    timeout.unref?.();
    const refresh = this.options.diagnostics.inspectDiagnostics({
      issueLimit: this.options.diagnosticsIssueLimit ?? 20,
      includePhysical: false
    }, controller.signal).then((inspection) => {
      const collectedAt = this.clock();
      this.diagnosticsValue = { inspection, collectedAt };
      this.diagnosticsFailureClass = null;
      this.diagnosticsRetryAt = null;
      this.diagnosticsFailureCount = 0;
    }).catch((error) => {
      this.diagnosticsFailureClass = classifyDiagnosticsFailure(error);
      this.diagnosticsFailureCount += 1;
      const minimum = Math.max(1, this.options.retryBackoffMinMs ?? DEFAULT_RETRY_BACKOFF_MIN_MS);
      const maximum = Math.max(minimum, this.options.retryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS);
      const delay = Math.min(maximum, minimum * 2 ** Math.min(20, this.diagnosticsFailureCount - 1));
      this.diagnosticsRetryAt = this.clock() + delay;
    }).finally(() => {
      clearTimeout(timeout);
      if (this.diagnosticsAbort === controller) this.diagnosticsAbort = null;
      if (this.diagnosticsRefresh === refresh) this.diagnosticsRefresh = null;
    });
    this.diagnosticsRefresh = refresh;
    return refresh;
  }

  private databaseDiagnosticsView(refreshed: boolean): DatabaseDiagnosticsView {
    const now = this.clock();
    const current = this.diagnosticsValue;
    const age = current ? now - current.collectedAt : Number.POSITIVE_INFINITY;
    const fresh = current !== null && (refreshed || age <= this.diagnosticsTtlMs());
    const state: DatabaseDiagnosticsStatus["state"] = !current ? "unavailable" : fresh ? "fresh" : "stale";
    const status: DatabaseDiagnosticsStatus = {
      state,
      refreshing: this.diagnosticsRefresh !== null,
      collectedAt: current ? new Date(current.collectedAt).toISOString() : null,
      failureClass: this.diagnosticsFailureClass,
      retryAt: this.diagnosticsRetryAt === null ? null : new Date(this.diagnosticsRetryAt).toISOString(),
      physicalState: "unknown",
      physicalCheckedAt: null,
      semanticIssueCount: current?.inspection.semantic.issues.reduce((total, issue) => total + issue.count, 0) ?? 0,
      semanticTruncated: current?.inspection.semantic.truncated ?? false
    };
    return {
      operational: current?.inspection.operational ?? { error: "SQLite diagnostics unavailable" },
      status
    };
  }

  private diagnosticsTtlMs(): number {
    return Math.max(0, this.options.diagnosticsTtlMs ?? this.options.statusTtlMs ?? DEFAULT_DIAGNOSTICS_TTL_MS);
  }
}

interface SnapshotCachePolicy<T> {
  retryBackoffMinMs?: number;
  retryBackoffMaxMs?: number;
  shouldCache?: (value: T) => boolean;
  failureOf?: (value: T) => unknown | null;
}

class SnapshotCache<T> {
  private value: T | null = null;
  private refreshedAt = 0;
  private refresh: Promise<T> | null = null;
  private lastFailure: unknown | null = null;
  private lastFailedValue: T | null = null;
  private retryAt: number | null = null;
  private failureCount = 0;
  private stopping = false;

  constructor(
    private readonly inspect: () => Promise<T>,
    private readonly ttlMs: number,
    private readonly clock: () => number = Date.now,
    private readonly policy: SnapshotCachePolicy<T> = {}
  ) {}

  async read(): Promise<T> {
    const value = this.value;
    if (value !== null && this.isFresh()) return value;
    if (this.stopping) throw new Error("Snapshot cache is stopping");
    return this.refreshValue();
  }

  async readStaleWhileRefreshing(): Promise<T> {
    const value = this.value;
    if (value === null) {
      const failedValue = this.lastFailedValue;
      if (failedValue !== null) {
        if (!this.stopping && (this.retryAt === null || this.clock() >= this.retryAt)) void this.refreshValue().catch(() => undefined);
        return failedValue;
      }
      if (this.stopping) throw new Error("Snapshot cache is stopping");
      return this.refreshValue();
    }
    if (this.isFresh()) return value;
    if (!this.stopping && (this.retryAt === null || this.clock() >= this.retryAt)) void this.refreshValue().catch(() => undefined);
    return value;
  }

  status(): { state: "fresh" | "stale" | "unavailable"; refreshing: boolean; collectedAt: number | null; lastFailure: unknown | null; lastFailedValue: T | null; retryAt: number | null } {
    return {
      state: this.value === null ? "unavailable" : this.isFresh() ? "fresh" : "stale",
      refreshing: this.refresh !== null,
      collectedAt: this.value === null ? null : this.refreshedAt,
      lastFailure: this.lastFailure,
      lastFailedValue: this.lastFailedValue,
      retryAt: this.retryAt
    };
  }

  async stop(): Promise<void> {
    this.stopping = true;
    const refresh = this.refresh;
    if (refresh) await refresh.then(() => undefined, () => undefined);
  }

  private isFresh(): boolean {
    return this.clock() - this.refreshedAt < this.ttlMs;
  }

  private refreshValue(): Promise<T> {
    const existingRefresh = this.refresh;
    if (existingRefresh !== null) return existingRefresh;
    const refresh = this.inspect().then(
      (value) => {
        if (this.policy.shouldCache?.(value) ?? true) {
          this.value = value;
          this.refreshedAt = this.clock();
        }
        const failure = this.policy.failureOf?.(value) ?? null;
        if (failure === null) {
          this.lastFailure = null;
          this.lastFailedValue = null;
          this.retryAt = null;
          this.failureCount = 0;
        } else {
          this.lastFailedValue = value;
          this.recordFailure(failure);
        }
        return value;
      },
      (error) => {
        this.lastFailedValue = null;
        this.recordFailure(error);
        throw error;
      }
    );
    this.refresh = refresh;
    void refresh.then(
      () => { if (this.refresh === refresh) this.refresh = null; },
      () => { if (this.refresh === refresh) this.refresh = null; }
    );
    return refresh;
  }

  private recordFailure(error: unknown): void {
    this.lastFailure = error;
    this.failureCount += 1;
    const minimum = Math.max(1, this.policy.retryBackoffMinMs ?? DEFAULT_RETRY_BACKOFF_MIN_MS);
    const maximum = Math.max(minimum, this.policy.retryBackoffMaxMs ?? DEFAULT_RETRY_BACKOFF_MAX_MS);
    const delay = Math.min(maximum, minimum * 2 ** Math.min(20, this.failureCount - 1));
    this.retryAt = this.clock() + delay;
  }
}

function inspectReadiness(options: Pick<HealthSnapshotOptions, "store" | "gateway" | "lark" | "projects" | "lease" | "instanceRuntime" | "herdrCircuitBreaker" | "agentInputCapability" | "coreSessionIngestion" | "sqliteIntegrity" | "deliveryEngine">, herdr: HerdrReadiness): {
  readiness: HealthReadiness;
  instanceRuntime: ({ ready: boolean; lastError: string | null } & Partial<ReconciliationDiagnostics>) | DiagnosticFailure | undefined;
  herdrCircuitBreaker: HerdrCircuitBreakerStatus | DiagnosticFailure | undefined;
  coreSessionIngestion: CoreSessionIngestionDiagnostics | DiagnosticFailure | undefined;
  sqliteIntegrity: SqliteIntegrityDiagnostics | DiagnosticFailure | undefined;
  deliveryEngine: DeliverySnapshot | DiagnosticFailure | undefined;
} {
  const database = check(() => options.store.probeReadiness());
  const projects = check(() => validateProjectDirectories(options.projects));
  const gatewayResult = collectDiagnostic<GatewayStatus | boolean>(() => options.gateway?.snapshot() ?? options.lark?.isReady() ?? false);
  const gateway = isDiagnosticError(gatewayResult)
    ? { ok: false, error: gatewayResult.error }
    : typeof gatewayResult === "boolean"
      ? gatewayResult ? { ok: true } : { ok: false, error: "Conversation Gateway ingress is not connected" }
      : gatewayResult.ingress.ready && gatewayResult.delivery.ready ? { ok: true } : { ok: false, error: gatewayResult.ingress.detail ?? gatewayResult.delivery.detail ?? "Conversation Gateway is not ready" };
  const lark = gateway;
  const leaseResult = collectDiagnostic<InstanceLeaseStatus>(() => options.lease.snapshot());
  const lease = isDiagnosticError(leaseResult)
    ? { ok: false, held: false, ownerSuffix: "", fencingToken: null, expiresAt: null, lastRenewedAt: null, error: leaseResult.error }
    : { ...leaseResult, ok: leaseResult.held, ...(leaseResult.held ? {} : { error: leaseResult.error ?? "Instance lease is not held" }) };
  const instanceRuntime = collectDiagnostic<{ ready: boolean; lastError: string | null } & Partial<ReconciliationDiagnostics>>(() => options.instanceRuntime?.snapshot());
  const instanceRuntimeComponent = isDiagnosticError(instanceRuntime)
    ? { ok: false, error: instanceRuntime.error }
    : instanceRuntime ? { ok: instanceRuntime.ready, ...(instanceRuntime.ready ? {} : { error: instanceRuntime.lastError ?? "Instance runtime reconciliation has not completed" }) } : undefined;
  const herdrCircuitBreaker = collectDiagnostic<HerdrCircuitBreakerStatus>(() => options.herdrCircuitBreaker?.status());
  const core = isDiagnosticError(herdrCircuitBreaker)
    ? { ok: false, error: herdrCircuitBreaker.error }
    : herdrCircuitBreaker ? herdrCircuitBreaker.state === "closed"
      ? { ok: true }
      : { ok: false, error: boundedError(herdrCircuitBreaker.lastFailure ?? `Herdr Core transport circuit is ${herdrCircuitBreaker.state}`) }
      : undefined;
  const agentInputCapability = collectDiagnostic<AgentInputCapabilityStatus>(() => options.agentInputCapability?.snapshot());
  const coreSessionIngestion = collectDiagnostic<CoreSessionIngestionDiagnostics>(() => options.coreSessionIngestion?.snapshot());
  const agentInput = isDiagnosticError(agentInputCapability)
    ? { ok: false, required: true, detected: false, supported: false, error: agentInputCapability.error }
    : agentInputCapability ? {
      ok: agentInputCapability.ready && !isDiagnosticError(coreSessionIngestion) && (coreSessionIngestion?.ready ?? true),
      required: agentInputCapability.required,
      detected: agentInputCapability.detected,
      supported: agentInputCapability.supported,
      ...(agentInputCapability.error ? { error: agentInputCapability.error }
        : isDiagnosticError(coreSessionIngestion) ? { error: coreSessionIngestion.error }
          : coreSessionIngestion && !coreSessionIngestion.ready ? { error: coreSessionIngestion.lastFailure ?? "Required Core session ingestion is unavailable" } : {})
    } : undefined;
  const sqliteIntegrity = collectDiagnostic<SqliteIntegrityDiagnostics>(() => options.sqliteIntegrity?.snapshot());
  const sqliteIntegrityComponent = isDiagnosticError(sqliteIntegrity)
    ? { ok: false, error: sqliteIntegrity.error }
    : sqliteIntegrity ? sqliteIntegrity.quickCheck === "ok" && sqliteIntegrity.issues.length === 0 && sqliteIntegrity.error === null
      ? { ok: true }
      : { ok: false, error: sqliteIntegrity.error ?? `SQLite integrity check reported ${sqliteIntegrity.issues.length} issue(s)` }
      : undefined;
  const deliveryEngine = collectDiagnostic<DeliverySnapshot>(() => options.deliveryEngine?.snapshot());
  const deliveryEngineComponent = isDiagnosticError(deliveryEngine)
    ? { ok: false, error: deliveryEngine.error }
    : deliveryEngine ? deliveryEngine.state !== "degraded" && deliveryEngine.recoveryReady
      ? { ok: true }
      : { ok: false, error: deliveryEngine.state === "degraded" ? "Delivery Engine is degraded" : "Delivery Engine recovery is not ready" }
      : undefined;
  const components = { database, projects, herdr, gateway, lark, lease, ...(core ? { core } : {}), ...(agentInput ? { agentInput } : {}), ...(sqliteIntegrityComponent ? { sqliteIntegrity: sqliteIntegrityComponent } : {}), ...(instanceRuntimeComponent ? { instanceRuntime: instanceRuntimeComponent } : {}), ...(deliveryEngineComponent ? { deliveryEngine: deliveryEngineComponent } : {}) };
  return { readiness: { status: Object.values(components).every((component) => component.ok) ? "ready" : "not_ready", components }, instanceRuntime, herdrCircuitBreaker, coreSessionIngestion, sqliteIntegrity, deliveryEngine };
}

async function inspectHerdrReadiness(herdr: HerdrPort, projects: readonly ProjectConfig[]): Promise<HerdrReadiness> {
  const workspaces = await mapWithConcurrency([...new Set(projects.map((project) => project.workspaceId))], WORKSPACE_READINESS_CONCURRENCY, async (workspaceId) => {
    try { await herdr.assertWorkspace(workspaceId); return { workspaceId, ok: true }; }
    catch (error) { return { workspaceId, ok: false, error: boundedError(error) }; }
  });
  return workspaces.some((workspace) => !workspace.ok) ? { ok: false, error: "One or more Herdr workspaces are unavailable", workspaces } : { ok: true, workspaces };
}

function check(operation: () => void): ComponentState {
  try { operation(); return { ok: true }; }
  catch (error) { return { ok: false, error: boundedError(error) }; }
}
function boundedError(error: unknown): string { return safeLogError(error).message; }
function collectDiagnostic<T>(read: () => T): T | DiagnosticFailure;
function collectDiagnostic<T>(read: () => T | undefined): T | DiagnosticFailure | undefined;
function collectDiagnostic<T>(read: () => T | undefined): T | DiagnosticFailure | undefined {
  try { return read(); }
  catch (error) { return { error: boundedError(error), [diagnosticFailure]: true }; }
}
function isDiagnosticError(value: unknown): value is DiagnosticFailure { return typeof value === "object" && value !== null && diagnosticFailure in value; }
function sqlitePhysicalStatus(value: SqliteIntegrityDiagnostics | DiagnosticFailure | undefined): Pick<DatabaseDiagnosticsStatus, "physicalState" | "physicalCheckedAt"> {
  if (!value || isDiagnosticError(value) || value.completedAt === null) return { physicalState: "unknown", physicalCheckedAt: null };
  const failed = value.quickCheck !== "ok" || value.issues.some((issue) => issue.rule === "sqlite_quick_check" || issue.rule === "sqlite_foreign_key");
  return { physicalState: failed ? "failed" : "healthy", physicalCheckedAt: value.completedAt };
}
function classifyDiagnosticsFailure(error: unknown): DatabaseDiagnosticsFailureClass {
  if (typeof error !== "object" || error === null) return "other";
  const shape = error as { failureClass?: unknown; code?: unknown; errcode?: unknown; name?: unknown };
  if (shape.failureClass === "busy" || shape.failureClass === "locked" || shape.failureClass === "timeout" || shape.failureClass === "other") return shape.failureClass;
  if (shape.errcode === 5 || shape.code === "SQLITE_BUSY" || shape.code === "ERR_SQLITE_BUSY") return "busy";
  if (shape.errcode === 6 || shape.code === "SQLITE_LOCKED" || shape.code === "ERR_SQLITE_LOCKED") return "locked";
  if (shape.name === "AbortError" || shape.name === "TimeoutError") return "timeout";
  return "other";
}
function leaseStatus(lease: InstanceLeaseStatus & { ok: boolean }): InstanceLeaseStatus {
  return { held: lease.held, ownerSuffix: lease.ownerSuffix, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt, lastRenewedAt: lease.lastRenewedAt, error: lease.error };
}
