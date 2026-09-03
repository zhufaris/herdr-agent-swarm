import { createHash, randomBytes } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import type { Logger } from "pino";
import { z } from "zod";
import type { InstanceStore } from "../domain/ports/instance.js";
import type { PrimaryToolMessagingPort } from "../domain/primary-tool-messaging.js";
import { PrimaryToolBroker } from "./primary-tool-broker.js";
import { safeLogError } from "./safe-error.js";

const MAX_REQUEST_BYTES = 64 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 30_000;
const DEFAULT_MAX_CONNECTIONS = 64;
const requestSchema = z.object({
  bindingId: z.string().min(1).max(128), generation: z.number().int().positive(), capability: z.string().regex(/^[a-f0-9]{64}$/),
  tool: z.enum(["listInstances", "promptInstance", "followUpInstance", "steerInstance", "inspectInstance", "waitInstance", "interruptInstance"]),
  arguments: z.record(z.unknown()).default({})
}).strict();

export interface PrimaryToolLaunch { environment: Record<string, string>; command: string; args: string[]; agentArgs?: string[] }
export interface PrimaryToolGatewayOptions { idleTimeoutMs?: number; maxConnections?: number }

export class PrimaryToolGateway {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();

  constructor(private readonly socketPath: string, private readonly mcpCommand: string, private readonly mcpArgsPrefix: string[], private readonly store: InstanceStore, private readonly messaging: PrimaryToolMessagingPort, private readonly logger: Logger, private readonly agentArgs: string[] = [], private readonly options: PrimaryToolGatewayOptions = {}) {}

  issueBinding(bindingId: string, expectedGeneration: number): PrimaryToolLaunch {
    const capability = randomBytes(32).toString("hex");
    if (!this.store.setBindingPrimaryToolCapability({ bindingId, expectedGeneration, capabilityHash: hash(capability) })) throw new Error("Primary binding generation changed before tool credential issue");
    return { ...this.configurationForBinding(bindingId, expectedGeneration), environment: { SWARM_PRIMARY_CAPABILITY: capability } };
  }

  configurationForBinding(bindingId: string, generation: number): PrimaryToolLaunch {
    return { environment: {}, command: this.mcpCommand, args: [...this.mcpArgsPrefix, "--socket", this.socketPath, "--binding", bindingId, "--generation", String(generation)], ...(this.agentArgs.length ? { agentArgs: this.agentArgs } : {}) };
  }

  async start(): Promise<void> {
    if (this.server) return;
    await rm(this.socketPath, { force: true });
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.socketPath, () => { server.off("error", reject); resolve(); }); });
    await chmod(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.server; this.server = null;
    if (server) {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const socket of this.sockets) socket.destroy();
      await closed;
    }
    await rm(this.socketPath, { force: true });
  }

  private accept(socket: Socket): void {
    const maxConnections = Math.max(1, this.options.maxConnections ?? DEFAULT_MAX_CONNECTIONS);
    if (this.sockets.size >= maxConnections) { socket.destroy(); return; }
    this.sockets.add(socket);
    const idleTimer = setTimeout(() => socket.destroy(), Math.max(1, this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS));
    idleTimer.unref();
    socket.once("close", () => { clearTimeout(idleTimer); this.sockets.delete(socket); });
    socket.setEncoding("utf8");
    let input = "";
    let handled = false;
    const onData = (chunk: string): void => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input) > MAX_REQUEST_BYTES) { socket.destroy(); return; }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      clearTimeout(idleTimer);
      socket.removeListener("data", onData);
      socket.pause();
      void this.handle(input.slice(0, newline)).then((result) => socket.end(`${JSON.stringify({ ok: true, result })}\n`), (error) => {
        this.logger.warn({ event: "primary-tool-call-failed", err: safeLogError(error), outcome: "rejected" }, "Primary tool call failed");
        socket.end(`${JSON.stringify({ ok: false, error: error instanceof Error ? error.message : String(error) })}\n`);
      });
    };
    socket.on("data", onData);
  }

  private async handle(raw: string): Promise<unknown> {
    const request = requestSchema.parse(JSON.parse(raw));
    if (!this.store.verifyBindingPrimaryToolCapability({ bindingId: request.bindingId, expectedGeneration: request.generation, capabilityHash: hash(request.capability) })) throw new Error("Primary tool credential is invalid or stale");
    const binding = this.store.getBinding(request.bindingId);
    const prompt = this.store.getActiveOrdinaryPrompt(request.bindingId, request.generation);
    if (!binding?.projectId || !prompt) throw new Error("Primary tool calls require a current active ordinary binding prompt");
    const broker = new PrimaryToolBroker({ projectId: binding.projectId, bindingId: binding.id, bindingGeneration: binding.generation, parentPromptId: prompt.id }, this.messaging);
    return await (broker[request.tool] as (input: Record<string, unknown>) => unknown)(request.arguments);
  }
}

function hash(value: string): string { return createHash("sha256").update(value).digest("hex"); }
