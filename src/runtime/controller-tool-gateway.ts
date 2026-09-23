import { createHash } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { Logger } from "pino";
import { z } from "zod";
import { controllerInterpretationResultSchema } from "../domain/controller-interpretation.js";
import type { ControllerInterpretationStore } from "../domain/ports/controller-interpretation.js";
import type { ProjectConfig } from "../domain/types.js";
import { safeLogError } from "./safe-error.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 64;
const requestSchema = z.object({ jobId: z.string().min(1).max(128), capability: z.string().min(32).max(256), tool: z.enum(["getInterpretationContext", "inspectSwarmTarget", "submitInterpretation"]), arguments: z.record(z.unknown()).default({}) }).strict();
export interface ControllerToolGatewayOptions { idleTimeoutMs?: number; maxConnections?: number }
export interface ControllerToolContext {
  findBindingByLarkScope(topicId: string | null, rootMessageId: string | null): { id: string; projectId: string | null; generation: number; paneId: string | null; title: string } | null;
  listAgentInstances(projectId: string): Array<{ id: string; name: string; role: string; generation: number; runtimeRef: { paneId: string } | null; observedState: string }>;
}
export class ControllerToolGateway {
  private server: Server | null = null; private readonly sockets = new Set<Socket>();
  private accepting = false;
  constructor(private readonly socketPath: string, private readonly store: ControllerInterpretationStore, private readonly projects: readonly ProjectConfig[], private readonly logger: Pick<Logger, "warn">, private readonly context?: ControllerToolContext, private readonly options: ControllerToolGatewayOptions = {}) {}
  async start(): Promise<void> { if (this.server) return; await rm(this.socketPath, { force: true }); const server = createServer((socket) => this.accept(socket)); this.server = server; await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.socketPath, () => { server.off("error", reject); resolve(); }); }); await chmod(this.socketPath, 0o600); this.accepting = true; }
  async stop(): Promise<void> { this.accepting = false; const server = this.server; this.server = null; for (const socket of this.sockets) socket.destroy(); if (server) await new Promise<void>((resolve) => server.close(() => resolve())); await rm(this.socketPath, { force: true }); }
  private accept(socket: Socket): void {
    if (!this.accepting || this.sockets.size >= Math.max(1, this.options.maxConnections ?? DEFAULT_MAX_CONNECTIONS)) { socket.destroy(); return; }
    this.sockets.add(socket);
    socket.on("error", () => undefined);
    const idleTimer = setTimeout(() => socket.destroy(), Math.max(1, this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS));
    idleTimer.unref();
    socket.once("close", () => { clearTimeout(idleTimer); this.sockets.delete(socket); });
    socket.setEncoding("utf8");
    let input = ""; let handled = false;
    const onData = (chunk: string): void => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) { socket.destroy(); return; }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      handled = true; clearTimeout(idleTimer); socket.removeListener("data", onData); socket.pause();
      void this.handle(input.slice(0, newline)).then((result) => { if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: true, result })}\n`); }, (error) => { this.logger.warn({ event: "controller-tool-call-rejected", err: safeLogError(error), outcome: "rejected" }, "Controller tool call rejected"); if (!socket.destroyed) socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`); });
    };
    socket.on("data", onData);
  }
  private async handle(raw: string): Promise<unknown> { const request = requestSchema.parse(JSON.parse(raw)); const job = this.store.getControllerInterpretation(request.jobId); const runtime = this.store.getControllerRuntime(); if (!job || job.capabilityHash !== hash(request.capability) || !["dispatching", "observing", "uncertain"].includes(job.state) || !runtime || runtime.state !== "active" || runtime.generation !== job.controllerGeneration) throw new Error("Controller capability is invalid or stale"); if (request.tool === "getInterpretationContext") { const binding = this.context?.findBindingByLarkScope(job.message.topicId, job.message.rootMessageId) ?? null; const instances = binding?.projectId ? this.context?.listAgentInstances(binding.projectId) ?? [] : []; return { requestId: job.id, text: job.message.text, conversation: { chatId: job.message.chatId, topicId: job.message.topicId, rootMessageId: job.message.rootMessageId }, projects: this.projects.map(({ id, displayName, spaceName }) => ({ id, displayName, spaceName: spaceName ?? "herdr" })), scope: binding ? { bindingId: binding.id, bindingGeneration: binding.generation, projectId: binding.projectId, paneId: binding.paneId, title: binding.title } : null, instances: instances.map(({ id, name, role, generation, runtimeRef, observedState }) => ({ id, name, role, generation, paneId: runtimeRef?.paneId ?? null, observedState })) }; } if (request.tool === "inspectSwarmTarget") { const name = z.object({ name: z.string().min(1).max(128) }).parse(request.arguments).name.toLowerCase(); const projects = this.projects.filter((item) => item.id.toLowerCase() === name || item.displayName.toLowerCase() === name || item.spaceName?.toLowerCase() === name); return { projects: projects.map(({ id, displayName, workspaceId }) => ({ id, displayName, workspaceId })), instances: projects.flatMap((project) => (this.context?.listAgentInstances(project.id) ?? []).filter((item) => item.id.toLowerCase() === name || item.name.toLowerCase() === name).map(({ id, name, role, generation, runtimeRef, observedState }) => ({ projectId: project.id, id, name, role, generation, paneId: runtimeRef?.paneId ?? null, observedState }))) }; } const result = controllerInterpretationResultSchema.parse(z.object({ result: z.unknown() }).parse(request.arguments).result); const saved = this.store.finishControllerInterpretation(job.id, job.controllerGeneration, result, new Date().toISOString()); if (!saved) throw new Error("Controller interpretation is no longer accepting results"); return { accepted: true }; }
}
function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
