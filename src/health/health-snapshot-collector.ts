import type { HerdrPort } from "../domain/ports/external.js";
import type { HealthStore } from "../domain/ports/health.js";
import type { HerdrCircuitBreakerStatus, InboundDispatcherDiagnostics, InstanceLeaseStatus, InstanceWorkerDiagnostics, OutboxDispatcherDiagnostics, ProjectConfig, PromptWorkerDiagnostics, ReconciliationDiagnostics, SessionOperationDispatcherDiagnostics, SqliteIntegrityDiagnostics, StartupRecoveryDiagnostics, WorkspaceCacheStatus } from "../domain/types.js";
import type { LifecycleEventDiagnostics } from "../events/bridge-event-bus.js";
import type { CardUpdateSchedulerDiagnostics } from "../events/card-update-scheduler.js";
import type { GatewaySession, GatewayStatus } from "../gateways/contract/plugin.js";
import { validateProjectDirectories } from "../config.js";
import type { BuildIdentity } from "../runtime/build-identity.js";
import type { HerdrSocketStatus } from "../runtime/herdr-socket-subscriber.js";
import { mapWithConcurrency } from "../runtime/map-with-concurrency.js";
import { safeLogError } from "../runtime/safe-error.js";

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
    instanceRuntime?: ComponentState;
  };
}

export interface HealthSnapshotOptions {
  store: HealthStore; herdr: HerdrPort; gateway?: Pick<GatewaySession, "snapshot">; /** @deprecated test compatibility */ lark?: { isReady(): boolean }; projects: readonly ProjectConfig[];
  lease: { snapshot(): InstanceLeaseStatus };
  workspaceCache?: { status(): WorkspaceCacheStatus };
  herdrCircuitBreaker?: { status(): HerdrCircuitBreakerStatus };
  startupRecovery?: { snapshot(): StartupRecoveryDiagnostics };
  inboundDispatcher?: { snapshot(): InboundDispatcherDiagnostics };
  sessionOperationDispatcher?: { snapshot(): SessionOperationDispatcherDiagnostics };
  sqliteIntegrity?: { snapshot(): SqliteIntegrityDiagnostics };
  lifecycleEvents?: LifecycleEventDiagnostics;
  cardConvergence?: { snapshot(): CardUpdateSchedulerDiagnostics };
  outboxDispatcher?: { snapshot(): OutboxDispatcherDiagnostics };
  promptWorker?: { snapshot(): PromptWorkerDiagnostics };
  instanceWorker?: { snapshot(): InstanceWorkerDiagnostics };
  bindingRuntime?: { snapshot(): ReconciliationDiagnostics };
  instanceRuntime?: { snapshot(): { ready: boolean; lastError: string | null } & Partial<ReconciliationDiagnostics> };
  herdrSocket?: { status(): HerdrSocketStatus };
  buildIdentity: BuildIdentity;
  readinessTtlMs?: number;
  statusTtlMs?: number;
}

type StatusSnapshot = { body: Record<string, unknown>; cacheable: boolean };
const WORKSPACE_READINESS_CONCURRENCY = 4;

export class HealthSnapshotCollector {
  private readonly workspaceReadinessCache: SnapshotCache<HerdrReadiness>;
  private readonly statusCache: SnapshotCache<StatusSnapshot>;

  constructor(private readonly options: HealthSnapshotOptions) {
    this.workspaceReadinessCache = new SnapshotCache(() => inspectHerdrReadiness(options.herdr, options.projects), options.readinessTtlMs ?? 2_000);
    this.statusCache = new SnapshotCache(
      () => this.collectStatus(), options.statusTtlMs ?? 1_000, Date.now, (snapshot) => snapshot.cacheable
    );
  }

  async readiness(): Promise<HealthReadiness> {
    return inspectReadiness(this.options, await this.workspaceReadinessCache.read()).readiness;
  }

  async status(): Promise<Record<string, unknown>> {
    return (await this.statusCache.read()).body;
  }

  private async collectStatus(): Promise<StatusSnapshot> {
    const options = this.options;
    const { readiness, instanceRuntime } = inspectReadiness(options, await this.workspaceReadinessCache.read());
    let operational: ReturnType<HealthStore["getOperationalSummary"]> | { error: string };
    try { operational = options.store.getOperationalSummary(); }
    catch (error) { operational = { error: boundedError(error) }; }
    const outboxDispatcher = collectDiagnostic<OutboxDispatcherDiagnostics>(() => options.outboxDispatcher?.snapshot());
    const promptWorker = collectDiagnostic<PromptWorkerDiagnostics>(() => options.promptWorker?.snapshot());
    const instanceWorker = collectDiagnostic<InstanceWorkerDiagnostics>(() => options.instanceWorker?.snapshot());
    const herdrCircuitBreaker = collectDiagnostic<HerdrCircuitBreakerStatus>(() => options.herdrCircuitBreaker?.status());
    const startupRecovery = collectDiagnostic<StartupRecoveryDiagnostics>(() => options.startupRecovery?.snapshot());
    const inboundDispatcher = collectDiagnostic<InboundDispatcherDiagnostics>(() => options.inboundDispatcher?.snapshot());
    const sessionOperationDispatcher = collectDiagnostic<SessionOperationDispatcherDiagnostics>(() => options.sessionOperationDispatcher?.snapshot());
    const sqliteIntegrity = collectDiagnostic<SqliteIntegrityDiagnostics>(() => options.sqliteIntegrity?.snapshot());
    const bindingRuntime = collectDiagnostic<ReconciliationDiagnostics>(() => options.bindingRuntime?.snapshot());
    const cardConvergence = collectDiagnostic<CardUpdateSchedulerDiagnostics>(() => options.cardConvergence?.snapshot());
    const lifecycleEvents = collectDiagnostic(() => options.lifecycleEvents?.snapshot());
    const workspaceCache = collectDiagnostic<WorkspaceCacheStatus>(() => options.workspaceCache?.status());
    const herdrSocket = collectDiagnostic<HerdrSocketStatus>(() => options.herdrSocket?.status());
    const reconciliation = bindingRuntime || instanceRuntime ? { ...(bindingRuntime ? { bindingRuntime } : {}), ...(instanceRuntime ? { instanceRuntime } : {}) } : undefined;
    const diagnostics = [outboxDispatcher, promptWorker, instanceWorker, herdrCircuitBreaker, startupRecovery, inboundDispatcher, sessionOperationDispatcher, sqliteIntegrity, bindingRuntime, instanceRuntime, cardConvergence, lifecycleEvents, workspaceCache, herdrSocket];
    const diagnosticCollectionFailed = diagnostics.some(isDiagnosticError);
    const operationalDegraded = "error" in operational
      || operational.retiredPaneCleanup.oldestActiveAgeSeconds !== null && operational.retiredPaneCleanup.oldestActiveAgeSeconds >= 300
      || operational.eligibleDeadLetterRecoveries > 0
      || operational.larkDeliveryCooldown.active
      || operational.outboxQuarantines.active > 0
      || operational.outboxLanes.stalled > 0
      || operational.inbound.oldestPendingAgeSeconds !== null && operational.inbound.oldestPendingAgeSeconds >= 300;
    const sessionOperationsDegraded = !("error" in operational) && operational.sessionOperations.oldestAcceptedAgeSeconds !== null && operational.sessionOperations.oldestAcceptedAgeSeconds >= 300;
    const body = {
      status: readiness.status === "ready" && !operationalDegraded && !sessionOperationsDegraded
        && !(outboxDispatcher && "error" in outboxDispatcher) && !(promptWorker && "error" in promptWorker)
        && !(inboundDispatcher && "error" in inboundDispatcher)
        && !(sessionOperationDispatcher && "error" in sessionOperationDispatcher)
        && !(outboxDispatcher && "lastScanOutcome" in outboxDispatcher && outboxDispatcher.lastScanOutcome === "failed")
        && !(instanceWorker && ("error" in instanceWorker || instanceWorker.activeDispatchWorkers > 0 || instanceWorker.activeObservers > 0 || instanceWorker.activeTurns > 0 || instanceWorker.uncertainTurns > 0))
        && !(herdrCircuitBreaker && ("error" in herdrCircuitBreaker || herdrCircuitBreaker.state !== "closed"))
        && !(startupRecovery && ("error" in startupRecovery || startupRecovery.state === "degraded"))
        && !(bindingRuntime && ("error" in bindingRuntime || bindingRuntime.lastOutcome === "failed")) && !(instanceRuntime && "error" in instanceRuntime)
        && !diagnosticCollectionFailed
        && !(sqliteIntegrity && (!("quickCheck" in sqliteIntegrity) || sqliteIntegrity.state === "idle" || sqliteIntegrity.state === "degraded" || sqliteIntegrity.state === "running" && (sqliteIntegrity.quickCheck !== "ok" || sqliteIntegrity.issues.length > 0 || sqliteIntegrity.error !== null))) ? "ok" : "degraded", identity: options.buildIdentity,
      timestamp: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()), readiness, operational, lease: leaseStatus(readiness.components.lease),
      ...(outboxDispatcher ? { outboxDispatcher } : {}), ...(promptWorker ? { promptWorker } : {}), ...(instanceWorker ? { instanceWorker } : {}),
      ...(workspaceCache ? { workspaceCache } : {}), ...(herdrCircuitBreaker ? { herdrCircuitBreaker } : {}), ...(startupRecovery ? { startupRecovery } : {}),
      ...(inboundDispatcher ? { inboundDispatcher } : {}), ...(sessionOperationDispatcher ? { sessionOperationDispatcher } : {}), ...(sqliteIntegrity ? { sqliteIntegrity } : {}),
      ...(reconciliation ? { reconciliation } : {}), ...(cardConvergence ? { cardConvergence } : {}), ...(herdrSocket ? { herdrSocket } : {}), ...(lifecycleEvents ? { lifecycleEvents } : {})
    };
    return { body, cacheable: !("error" in operational) && !diagnosticCollectionFailed };
  }
}

class SnapshotCache<T> {
  private value: T | null = null;
  private refreshedAt = 0;
  private refresh: Promise<T> | null = null;
  constructor(private readonly inspect: () => Promise<T>, private readonly ttlMs: number, private readonly clock: () => number = Date.now, private readonly shouldCache: (value: T) => boolean = () => true) {}
  async read(): Promise<T> {
    if (this.value && this.clock() - this.refreshedAt < this.ttlMs) return this.value;
    if (this.refresh) return this.refresh;
    const refresh = this.inspect().then((value) => {
      if (this.shouldCache(value)) { this.value = value; this.refreshedAt = this.clock(); }
      return value;
    });
    this.refresh = refresh;
    try { return await refresh; } finally { if (this.refresh === refresh) this.refresh = null; }
  }
}

function inspectReadiness(options: Pick<HealthSnapshotOptions, "store" | "gateway" | "lark" | "projects" | "lease" | "instanceRuntime">, herdr: HerdrReadiness): { readiness: HealthReadiness; instanceRuntime: ({ ready: boolean; lastError: string | null } & Partial<ReconciliationDiagnostics>) | DiagnosticFailure | undefined } {
  const database = check(() => options.store.listBindings());
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
  const components = { database, projects, herdr, gateway, lark, lease, ...(instanceRuntimeComponent ? { instanceRuntime: instanceRuntimeComponent } : {}) };
  return { readiness: { status: Object.values(components).every((component) => component.ok) ? "ready" : "not_ready", components }, instanceRuntime };
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
function leaseStatus(lease: InstanceLeaseStatus & { ok: boolean }): InstanceLeaseStatus {
  return { held: lease.held, ownerSuffix: lease.ownerSuffix, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt, lastRenewedAt: lease.lastRenewedAt, error: lease.error };
}
