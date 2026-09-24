import { createServer, type Server } from "node:http";
import { HealthSnapshotCollector, type HealthSnapshotOptions } from "./health-snapshot-collector.js";

export function startHealthServer(options: HealthSnapshotOptions & { host: string; port: number }): Promise<Server> {
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
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
}
