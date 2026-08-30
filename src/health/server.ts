import { createServer, type Server } from "node:http";
import type { HealthStore, HerdrPort, LarkPort } from "../domain/ports.js";
import type { HerdrCircuitBreakerStatus, InstanceLeaseStatus, InstanceWorkerDiagnostics, OutboxDispatcherDiagnostics, ProjectConfig, PromptWorkerDiagnostics, ReconciliationDiagnostics, SqliteIntegrityDiagnostics, StartupRecoveryDiagnostics, WorkspaceCacheStatus } from "../domain/types.js";
import { validateProjectDirectories } from "../config.js";
import type { BuildIdentity } from "../runtime/build-identity.js";
import type { LifecycleEventDiagnostics } from "../events/bridge-event-bus.js";
import type { CardUpdateSchedulerDiagnostics } from "../events/card-update-scheduler.js";
import type { HerdrSocketStatus } from "../runtime/herdr-socket-subscriber.js";

interface ComponentState { ok: boolean; error?: string }
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
      const readiness = inspectReadiness(options, await workspaceReadinessCache.read());
      response.statusCode = readiness.status === "ready" ? 200 : 503;
      response.end(JSON.stringify(readiness));
      return;
    }
    if (request.url === "/status") {
      const readiness = inspectReadiness(options, await workspaceReadinessCache.read());
      let operational: ReturnType<HealthStore["getOperationalSummary"]> | { error: string };
      try { operational = options.store.getOperationalSummary(); }
      catch (error) { operational = { error: boundedError(error) }; }
      let outboxDispatcher: OutboxDispatcherDiagnostics | { error: string } | undefined;
      try { outboxDispatcher = options.outboxDispatcher?.snapshot(); }
      catch (error) { outboxDispatcher = { error: boundedError(error) }; }
      let promptWorker: PromptWorkerDiagnostics | { error: string } | undefined;
      try { promptWorker = options.promptWorker?.snapshot(); }
      catch (error) { promptWorker = { error: boundedError(error) }; }
      let instanceWorker: InstanceWorkerDiagnostics | { error: string } | undefined;
      try { instanceWorker = options.instanceWorker?.snapshot(); }
      catch (error) { instanceWorker = { error: boundedError(error) }; }
      let herdrCircuitBreaker: HerdrCircuitBreakerStatus | { error: string } | undefined;
      try { herdrCircuitBreaker = options.herdrCircuitBreaker?.status(); }
      catch (error) { herdrCircuitBreaker = { error: boundedError(error) }; }
      let startupRecovery: StartupRecoveryDiagnostics | { error: string } | undefined;
      try { startupRecovery = options.startupRecovery?.snapshot(); }
      catch (error) { startupRecovery = { error: boundedError(error) }; }
      let sqliteIntegrity: SqliteIntegrityDiagnostics | { error: string } | undefined;
      try { sqliteIntegrity = options.sqliteIntegrity?.snapshot(); }
      catch (error) { sqliteIntegrity = { error: boundedError(error) }; }
      let bindingRuntime: ReconciliationDiagnostics | { error: string } | undefined;
      try { bindingRuntime = options.bindingRuntime?.snapshot(); }
      catch (error) { bindingRuntime = { error: boundedError(error) }; }
      let instanceRuntime: ({ ready: boolean; lastError: string | null } & Partial<ReconciliationDiagnostics>) | { error: string } | undefined;
      try { instanceRuntime = options.instanceRuntime?.snapshot(); }
      catch (error) { instanceRuntime = { error: boundedError(error) }; }
      let cardConvergence: CardUpdateSchedulerDiagnostics | { error: string } | undefined;
      try { cardConvergence = options.cardConvergence?.snapshot(); }
      catch (error) { cardConvergence = { error: boundedError(error) }; }
      const reconciliation = bindingRuntime || instanceRuntime ? { ...(bindingRuntime ? { bindingRuntime } : {}), ...(instanceRuntime ? { instanceRuntime } : {}) } : undefined;
      response.statusCode = 200;
      const operationalDegraded = "error" in operational
        || operational.retiredPaneCleanup.oldestActiveAgeSeconds !== null && operational.retiredPaneCleanup.oldestActiveAgeSeconds >= 300
        || operational.eligibleDeadLetterRecoveries > 0
        || operational.outboxQuarantines.active > 0
        || operational.outboxLanes.stalled > 0;
      response.end(JSON.stringify({
        status: readiness.status === "ready" && !operationalDegraded
          && !(outboxDispatcher && "error" in outboxDispatcher) && !(promptWorker && "error" in promptWorker)
          && !(outboxDispatcher && "lastScanOutcome" in outboxDispatcher && outboxDispatcher.lastScanOutcome === "failed")
          && !(instanceWorker && ("error" in instanceWorker || instanceWorker.activeDispatchWorkers > 0 || instanceWorker.activeObservers > 0 || instanceWorker.activeTurns > 0 || instanceWorker.uncertainTurns > 0))
          && !(herdrCircuitBreaker && ("error" in herdrCircuitBreaker || herdrCircuitBreaker.state !== "closed"))
          && !(startupRecovery && ("error" in startupRecovery || startupRecovery.state === "degraded"))
          && !(bindingRuntime && "error" in bindingRuntime) && !(instanceRuntime && "error" in instanceRuntime)
          && !(sqliteIntegrity && (!("quickCheck" in sqliteIntegrity) || sqliteIntegrity.state === "idle" || sqliteIntegrity.state === "degraded" || sqliteIntegrity.state === "running" && (sqliteIntegrity.quickCheck !== "ok" || sqliteIntegrity.issues.length > 0 || sqliteIntegrity.error !== null))) ? "ok" : "degraded", identity: options.buildIdentity,
        timestamp: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()), readiness, operational, lease: options.lease.snapshot(),
        ...(outboxDispatcher ? { outboxDispatcher } : {}),
        ...(promptWorker ? { promptWorker } : {}),
        ...(instanceWorker ? { instanceWorker } : {}),
        ...(options.workspaceCache ? { workspaceCache: options.workspaceCache.status() } : {}),
        ...(herdrCircuitBreaker ? { herdrCircuitBreaker } : {}),
        ...(startupRecovery ? { startupRecovery } : {}),
        ...(sqliteIntegrity ? { sqliteIntegrity } : {}),
        ...(reconciliation ? { reconciliation } : {}),
        ...(cardConvergence ? { cardConvergence } : {}),
        ...(options.herdrSocket ? { herdrSocket: options.herdrSocket.status() } : {}),
        ...(options.lifecycleEvents ? { lifecycleEvents: options.lifecycleEvents.snapshot() } : {})
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

function inspectReadiness(options: { store: HealthStore; lark: LarkPort; projects: readonly ProjectConfig[]; lease: { snapshot(): InstanceLeaseStatus }; instanceRuntime?: { snapshot(): { ready: boolean; lastError: string | null } } }, herdr: HerdrReadiness): Readiness {
  const database = check(() => options.store.listBindings());
  const projects = check(() => validateProjectDirectories(options.projects));
  const lark = options.lark.isReady() ? { ok: true } : { ok: false, error: "Lark WebSocket is not connected" };
  const leaseStatus = options.lease.snapshot();
  const lease = { ...leaseStatus, ok: leaseStatus.held, ...(leaseStatus.held ? {} : { error: leaseStatus.error ?? "Instance lease is not held" }) };
  const runtime = options.instanceRuntime?.snapshot();
  const instanceRuntime = runtime ? { ok: runtime.ready, ...(runtime.ready ? {} : { error: runtime.lastError ?? "Instance runtime reconciliation has not completed" }) } : undefined;
  const components = { database, projects, herdr, lark, lease, ...(instanceRuntime ? { instanceRuntime } : {}) };
  return { status: Object.values(components).every((component) => component.ok) ? "ready" : "not_ready", components };
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
