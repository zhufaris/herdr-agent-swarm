import { createServer, type Server } from "node:http";
import type { HealthStore, HerdrPort, LarkPort } from "../domain/ports.js";
import type { InstanceLeaseStatus, OutboxDispatcherDiagnostics, ProjectConfig, PromptWorkerDiagnostics, WorkspaceCacheStatus } from "../domain/types.js";
import { validateProjectDirectories } from "../config.js";
import type { BuildIdentity } from "../runtime/build-identity.js";
import type { LifecycleEventDiagnostics } from "../events/bridge-event-bus.js";
import type { HerdrSocketStatus } from "../runtime/herdr-socket-subscriber.js";

interface ComponentState { ok: boolean; error?: string }
interface Readiness {
  status: "ready" | "not_ready";
  components: {
    database: ComponentState; projects: ComponentState; lark: ComponentState;
    lease: InstanceLeaseStatus & { ok: boolean };
    herdr: ComponentState & { workspaces: Array<{ workspaceId: string; ok: boolean; error?: string }> };
  };
}

export function startHealthServer(options: {
  host: string; port: number; store: HealthStore; herdr: HerdrPort; lark: LarkPort; projects: readonly ProjectConfig[];
  lease: { snapshot(): InstanceLeaseStatus };
  workspaceCache?: { status(): WorkspaceCacheStatus };
  lifecycleEvents?: LifecycleEventDiagnostics;
  outboxDispatcher?: { snapshot(): OutboxDispatcherDiagnostics };
  promptWorker?: { snapshot(): PromptWorkerDiagnostics };
  herdrSocket?: { status(): HerdrSocketStatus };
  buildIdentity: BuildIdentity;
  readinessTtlMs?: number;
}): Promise<Server> {
  const readinessCache = new ReadinessCache(() => inspectReadiness(options), options.readinessTtlMs ?? 2_000);
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      const { serviceId, version, buildId } = options.buildIdentity;
      response.statusCode = 200; response.end(JSON.stringify({ status: "ok", serviceId, version, buildId })); return;
    }
    if (request.url === "/ready") {
      const readiness = await readinessCache.read();
      response.statusCode = readiness.status === "ready" ? 200 : 503;
      response.end(JSON.stringify(readiness));
      return;
    }
    if (request.url === "/status") {
      const readiness = await readinessCache.read();
      let operational: ReturnType<HealthStore["getOperationalSummary"]> | { error: string };
      try { operational = options.store.getOperationalSummary(); }
      catch (error) { operational = { error: boundedError(error) }; }
      let outboxDispatcher: OutboxDispatcherDiagnostics | { error: string } | undefined;
      try { outboxDispatcher = options.outboxDispatcher?.snapshot(); }
      catch (error) { outboxDispatcher = { error: boundedError(error) }; }
      let promptWorker: PromptWorkerDiagnostics | { error: string } | undefined;
      try { promptWorker = options.promptWorker?.snapshot(); }
      catch (error) { promptWorker = { error: boundedError(error) }; }
      response.statusCode = 200;
      const operationalDegraded = "error" in operational
        || operational.retiredPaneCleanup.oldestActiveAgeSeconds !== null && operational.retiredPaneCleanup.oldestActiveAgeSeconds >= 300
        || operational.eligibleDeadLetterRecoveries > 0;
      response.end(JSON.stringify({
        status: readiness.status === "ready" && !operationalDegraded
          && !(outboxDispatcher && "error" in outboxDispatcher) && !(promptWorker && "error" in promptWorker) ? "ok" : "degraded", identity: options.buildIdentity,
        timestamp: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()), readiness, operational, lease: options.lease.snapshot(),
        ...(outboxDispatcher ? { outboxDispatcher } : {}),
        ...(promptWorker ? { promptWorker } : {}),
        ...(options.workspaceCache ? { workspaceCache: options.workspaceCache.status() } : {}),
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

class ReadinessCache {
  private value: Readiness | null = null;
  private refreshedAt = 0;
  private refresh: Promise<Readiness> | null = null;

  constructor(private readonly inspect: () => Promise<Readiness>, private readonly ttlMs: number, private readonly clock: () => number = Date.now) {}

  async read(): Promise<Readiness> {
    if (this.value && this.clock() - this.refreshedAt < this.ttlMs) return this.value;
    if (this.refresh) return this.refresh;
    const refresh = this.inspect().then((value) => { this.value = value; this.refreshedAt = this.clock(); return value; });
    this.refresh = refresh;
    try { return await refresh; } finally { if (this.refresh === refresh) this.refresh = null; }
  }
}

async function inspectReadiness(options: { store: HealthStore; herdr: HerdrPort; lark: LarkPort; projects: readonly ProjectConfig[]; lease: { snapshot(): InstanceLeaseStatus }; workspaceCache?: { status(): WorkspaceCacheStatus } }): Promise<Readiness> {
  const database = check(() => options.store.listBindings());
  const projects = check(() => validateProjectDirectories(options.projects));
  const lark = options.lark.isReady() ? { ok: true } : { ok: false, error: "Lark WebSocket is not connected" };
  const leaseStatus = options.lease.snapshot();
  const lease = { ...leaseStatus, ok: leaseStatus.held, ...(leaseStatus.held ? {} : { error: leaseStatus.error ?? "Instance lease is not held" }) };
  const workspaces = await Promise.all([...new Set(options.projects.map((project) => project.workspaceId))].map(async (workspaceId) => {
    try { await options.herdr.assertWorkspace(workspaceId); return { workspaceId, ok: true }; }
    catch (error) { return { workspaceId, ok: false, error: boundedError(error) }; }
  }));
  const failedWorkspace = workspaces.find((workspace) => !workspace.ok);
  const herdr = failedWorkspace ? { ok: false, error: "One or more Herdr workspaces are unavailable", workspaces } : { ok: true, workspaces };
  const components = { database, projects, herdr, lark, lease };
  return { status: Object.values(components).every((component) => component.ok) ? "ready" : "not_ready", components };
}

function check(operation: () => void): ComponentState {
  try { operation(); return { ok: true }; }
  catch (error) { return { ok: false, error: boundedError(error) }; }
}

function boundedError(error: unknown): string {
  return (error instanceof Error ? error.message : String(error)).slice(0, 500);
}
