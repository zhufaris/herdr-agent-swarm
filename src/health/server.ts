import { createServer, type Server } from "node:http";
import type { HerdrPort, LarkPort } from "../domain/ports/external.js";
import type { HealthStore } from "../domain/ports/health.js";
import type { HerdrCircuitBreakerStatus, InboundDispatcherDiagnostics, InstanceLeaseStatus, InstanceWorkerDiagnostics, OutboxDispatcherDiagnostics, ProjectConfig, PromptWorkerDiagnostics, ReconciliationDiagnostics, SessionOperationDispatcherDiagnostics, SqliteIntegrityDiagnostics, StartupRecoveryDiagnostics, WorkspaceCacheStatus } from "../domain/types.js";
import { validateProjectDirectories } from "../config.js";
import type { BuildIdentity } from "../runtime/build-identity.js";
import type { LifecycleEventDiagnostics } from "../events/bridge-event-bus.js";
import type { CardUpdateSchedulerDiagnostics } from "../events/card-update-scheduler.js";
import type { HerdrSocketStatus } from "../runtime/herdr-socket-subscriber.js";

interface ComponentState { ok: boolean; error?: string }
const diagnosticFailure = Symbol("diagnosticFailure");
type DiagnosticFailure = { error: string; [diagnosticFailure]: true };
type HerdrReadiness = ComponentState & { workspaces: Array<{ workspaceId: string; ok: boolean; error?: string }> };
interface Readiness {
  status: "ready" | "not_ready";
  components: {
    database: ComponentState; projects: ComponentState; lark: ComponentState;
    lease: InstanceLeaseStatus & { ok: boolean };
    herdr: HerdrReadiness;
    instanceRuntime?: ComponentState;
  };
}

export function startHealthServer(options: {
  host: string; port: number; store: HealthStore; herdr: HerdrPort; lark: LarkPort; projects: readonly ProjectConfig[];
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
}): Promise<Server> {
  const workspaceReadinessCache = new ReadinessCache(() => inspectHerdrReadiness(options.herdr, options.projects), options.readinessTtlMs ?? 2_000);
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      const { serviceId, version, buildId } = options.buildIdentity;
      response.statusCode = 200; response.end(JSON.stringify({ status: "ok", serviceId, version, buildId })); return;
    }
    if (request.url === "/ready") {
      const { readiness } = inspectReadiness(options, await workspaceReadinessCache.read());
      response.statusCode = readiness.status === "ready" ? 200 : 503;
      response.end(JSON.stringify(readiness));
      return;
    }
    if (request.url === "/status") {
      const { readiness, instanceRuntime } = inspectReadiness(options, await workspaceReadinessCache.read());
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
      const diagnosticCollectionFailed = [outboxDispatcher, promptWorker, instanceWorker, herdrCircuitBreaker, startupRecovery, inboundDispatcher, sessionOperationDispatcher, sqliteIntegrity, bindingRuntime, instanceRuntime, cardConvergence, lifecycleEvents, workspaceCache, herdrSocket].some(isDiagnosticError);
      response.statusCode = 200;
      const operationalDegraded = "error" in operational
        || operational.retiredPaneCleanup.oldestActiveAgeSeconds !== null && operational.retiredPaneCleanup.oldestActiveAgeSeconds >= 300
        || operational.eligibleDeadLetterRecoveries > 0
        || operational.outboxQuarantines.active > 0
        || operational.outboxLanes.stalled > 0
        || operational.inbound.oldestPendingAgeSeconds !== null && operational.inbound.oldestPendingAgeSeconds >= 300;
      const sessionOperationsDegraded = !("error" in operational) && operational.sessionOperations.oldestAcceptedAgeSeconds !== null && operational.sessionOperations.oldestAcceptedAgeSeconds >= 300;
      response.end(JSON.stringify({
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
        ...(outboxDispatcher ? { outboxDispatcher } : {}),
        ...(promptWorker ? { promptWorker } : {}),
        ...(instanceWorker ? { instanceWorker } : {}),
        ...(workspaceCache ? { workspaceCache } : {}),
        ...(herdrCircuitBreaker ? { herdrCircuitBreaker } : {}),
        ...(startupRecovery ? { startupRecovery } : {}),
        ...(inboundDispatcher ? { inboundDispatcher } : {}),
        ...(sessionOperationDispatcher ? { sessionOperationDispatcher } : {}),
        ...(sqliteIntegrity ? { sqliteIntegrity } : {}),
        ...(reconciliation ? { reconciliation } : {}),
        ...(cardConvergence ? { cardConvergence } : {}),
        ...(herdrSocket ? { herdrSocket } : {}),
        ...(lifecycleEvents ? { lifecycleEvents } : {})
      }));
      return;
    }
    response.statusCode = 404; response.end(JSON.stringify({ error: "not_found" }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
}

class ReadinessCache<T> {
  private value: T | null = null;
  private refreshedAt = 0;
  private refresh: Promise<T> | null = null;

  constructor(private readonly inspect: () => Promise<T>, private readonly ttlMs: number, private readonly clock: () => number = Date.now) {}

  async read(): Promise<T> {
    if (this.value && this.clock() - this.refreshedAt < this.ttlMs) return this.value;
    if (this.refresh) return this.refresh;
    const refresh = this.inspect().then((value) => { this.value = value; this.refreshedAt = this.clock(); return value; });
    this.refresh = refresh;
    try { return await refresh; } finally { if (this.refresh === refresh) this.refresh = null; }
  }
}

function inspectReadiness(options: { store: HealthStore; lark: LarkPort; projects: readonly ProjectConfig[]; lease: { snapshot(): InstanceLeaseStatus }; instanceRuntime?: { snapshot(): { ready: boolean; lastError: string | null } & Partial<ReconciliationDiagnostics> } }, herdr: HerdrReadiness): { readiness: Readiness; instanceRuntime: ({ ready: boolean; lastError: string | null } & Partial<ReconciliationDiagnostics>) | DiagnosticFailure | undefined } {
  const database = check(() => options.store.listBindings());
  const projects = check(() => validateProjectDirectories(options.projects));
  const larkResult = collectDiagnostic(() => options.lark.isReady());
  const lark = isDiagnosticError(larkResult)
    ? { ok: false, error: larkResult.error }
    : larkResult ? { ok: true } : { ok: false, error: "Lark WebSocket is not connected" };
  const leaseResult = collectDiagnostic<InstanceLeaseStatus>(() => options.lease.snapshot());
  const lease = isDiagnosticError(leaseResult)
    ? { ok: false, held: false, ownerSuffix: "", fencingToken: null, expiresAt: null, lastRenewedAt: null, error: leaseResult.error }
    : { ...leaseResult, ok: leaseResult.held, ...(leaseResult.held ? {} : { error: leaseResult.error ?? "Instance lease is not held" }) };
  const instanceRuntime = collectDiagnostic<{ ready: boolean; lastError: string | null } & Partial<ReconciliationDiagnostics>>(() => options.instanceRuntime?.snapshot());
  const instanceRuntimeComponent = isDiagnosticError(instanceRuntime)
    ? { ok: false, error: instanceRuntime.error }
    : instanceRuntime ? { ok: instanceRuntime.ready, ...(instanceRuntime.ready ? {} : { error: instanceRuntime.lastError ?? "Instance runtime reconciliation has not completed" }) } : undefined;
  const components = { database, projects, herdr, lark, lease, ...(instanceRuntimeComponent ? { instanceRuntime: instanceRuntimeComponent } : {}) };
  return { readiness: { status: Object.values(components).every((component) => component.ok) ? "ready" : "not_ready", components }, instanceRuntime };
}

async function inspectHerdrReadiness(herdr: HerdrPort, projects: readonly ProjectConfig[]): Promise<HerdrReadiness> {
  const workspaces = await Promise.all([...new Set(projects.map((project) => project.workspaceId))].map(async (workspaceId) => {
    try { await herdr.assertWorkspace(workspaceId); return { workspaceId, ok: true }; }
    catch (error) { return { workspaceId, ok: false, error: boundedError(error) }; }
  }));
  const failedWorkspace = workspaces.find((workspace) => !workspace.ok);
  return failedWorkspace ? { ok: false, error: "One or more Herdr workspaces are unavailable", workspaces } : { ok: true, workspaces };
}

function check(operation: () => void): ComponentState {
  try { operation(); return { ok: true }; }
  catch (error) { return { ok: false, error: boundedError(error) }; }
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}

function collectDiagnostic<T>(read: () => T): T | DiagnosticFailure;
function collectDiagnostic<T>(read: () => T | undefined): T | DiagnosticFailure | undefined;
function collectDiagnostic<T>(read: () => T | undefined): T | DiagnosticFailure | undefined {
  try { return read(); }
  catch (error) { return { error: boundedError(error), [diagnosticFailure]: true }; }
}

function isDiagnosticError(value: unknown): value is DiagnosticFailure {
  return typeof value === "object" && value !== null && diagnosticFailure in value;
}

function leaseStatus(lease: InstanceLeaseStatus & { ok: boolean }): InstanceLeaseStatus {
  return { held: lease.held, ownerSuffix: lease.ownerSuffix, fencingToken: lease.fencingToken, expiresAt: lease.expiresAt, lastRenewedAt: lease.lastRenewedAt, error: lease.error };
}
