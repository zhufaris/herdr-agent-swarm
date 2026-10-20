import { createServer, type Server } from "node:http";
import { HealthSnapshotCollector, type HealthSnapshotOptions } from "./health-snapshot-collector.js";
import type { ShutdownContext } from "../runtime/shutdown-context.js";

export interface HealthServer extends Server {
  stop(context: ShutdownContext): Promise<void>;
}

export function startHealthServer(options: HealthSnapshotOptions & { host: string; port: number }): Promise<HealthServer> {
  const snapshots = new HealthSnapshotCollector(options);
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    const knownReadEndpoint = request.url === "/health" || request.url === "/ready" || request.url === "/status";
    if (knownReadEndpoint && request.method !== "GET" && request.method !== "HEAD") {
      response.setHeader("allow", "GET, HEAD");
      response.statusCode = 405; response.end(JSON.stringify({ error: "method_not_allowed" })); return;
    }
    if (request.url === "/health") {
      const { serviceId, version, buildId } = options.buildIdentity;
      response.statusCode = 200; response.end(JSON.stringify({ status: "ok", serviceId, version, buildId })); return;
    }
    if (request.url === "/ready") {
      const readiness = await snapshots.readiness();
      response.statusCode = readiness.status === "ready" ? 200 : 503;
      response.end(JSON.stringify(readiness)); return;
    }
    if (request.url === "/status") {
      response.statusCode = 200; response.end(JSON.stringify(await snapshots.status())); return;
    }
    response.statusCode = 404; response.end(JSON.stringify({ error: "not_found" }));
  }) as HealthServer;
  let stopPromise: Promise<void> | null = null;
  server.stop = (context) => {
    if (stopPromise) return stopPromise;
    stopPromise = stopHealthServer(server, snapshots, context);
    return stopPromise;
  };
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
}

async function stopHealthServer(server: Server, snapshots: HealthSnapshotCollector, context: ShutdownContext): Promise<void> {
  const closing = new Promise<void>((resolve, reject) => {
    server.close((error) => error ? reject(error) : resolve());
  });
  const results = await Promise.allSettled([snapshots.stop(context), closing]);
  const failure = results.find((result): result is PromiseRejectedResult => result.status === "rejected");
  if (failure) throw failure.reason;
}
