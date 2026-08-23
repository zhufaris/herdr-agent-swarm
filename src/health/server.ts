import { createServer, type Server } from "node:http";
import type { BindingStorePort, HerdrPort, LarkPort } from "../domain/ports.js";
import type { InstanceLeaseStatus, ProjectConfig, WorkspaceCacheStatus } from "../domain/types.js";
import { validateProjectDirectories } from "../config.js";
import type { BuildIdentity } from "../runtime/build-identity.js";

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
  host: string; port: number; store: BindingStorePort; herdr: HerdrPort; lark: LarkPort; projects: readonly ProjectConfig[];
  lease: { snapshot(): InstanceLeaseStatus };
  workspaceCache?: { status(): WorkspaceCacheStatus };
  buildIdentity: BuildIdentity;
}): Promise<Server> {
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") {
      const { serviceId, version, buildId } = options.buildIdentity;
      response.statusCode = 200; response.end(JSON.stringify({ status: "ok", serviceId, version, buildId })); return;
    }
    if (request.url === "/ready") {
      const readiness = await inspectReadiness(options);
      response.statusCode = readiness.status === "ready" ? 200 : 503;
      response.end(JSON.stringify(readiness));
      return;
    }
    if (request.url === "/status") {
      const readiness = await inspectReadiness(options);
      let operational: ReturnType<BindingStorePort["getOperationalSummary"]> | { error: string };
      try { operational = options.store.getOperationalSummary(); }
      catch (error) { operational = { error: boundedError(error) }; }
      response.statusCode = 200;
      response.end(JSON.stringify({
        status: readiness.status === "ready" && !("error" in operational) ? "ok" : "degraded", identity: options.buildIdentity,
        timestamp: new Date().toISOString(), uptimeSeconds: Math.floor(process.uptime()), readiness, operational, lease: options.lease.snapshot(),
        ...(options.workspaceCache ? { workspaceCache: options.workspaceCache.status() } : {})
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

async function inspectReadiness(options: { store: BindingStorePort; herdr: HerdrPort; lark: LarkPort; projects: readonly ProjectConfig[]; lease: { snapshot(): InstanceLeaseStatus }; workspaceCache?: { status(): WorkspaceCacheStatus } }): Promise<Readiness> {
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
