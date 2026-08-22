import { createServer, type Server } from "node:http";
import type { BindingStorePort, HerdrPort, LarkPort } from "../domain/ports.js";
import type { ProjectConfig } from "../domain/types.js";
import { validateProjectDirectories } from "../config.js";

export function startHealthServer(options: {
  host: string; port: number; store: BindingStorePort; herdr: HerdrPort; lark: LarkPort; projects: readonly ProjectConfig[];
}): Promise<Server> {
  const server = createServer(async (request, response) => {
    response.setHeader("content-type", "application/json");
    if (request.url === "/health") { response.statusCode = 200; response.end(JSON.stringify({ status: "ok" })); return; }
    if (request.url === "/ready") {
      try {
        options.store.listBindings();
        validateProjectDirectories(options.projects);
        for (const workspaceId of new Set(options.projects.map((project) => project.workspaceId))) await options.herdr.assertWorkspace(workspaceId);
        const ready = options.lark.isReady();
        response.statusCode = ready ? 200 : 503;
        response.end(JSON.stringify({ status: ready ? "ready" : "not_ready", larkConnected: ready }));
      } catch (error) {
        response.statusCode = 503;
        response.end(JSON.stringify({ status: "not_ready", error: error instanceof Error ? error.message : String(error) }));
      }
      return;
    }
    response.statusCode = 404; response.end(JSON.stringify({ error: "not_found" }));
  });
  return new Promise((resolve, reject) => {
    server.once("error", reject);
    server.listen(options.port, options.host, () => resolve(server));
  });
}
