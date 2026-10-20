import { chmod, rm } from "node:fs/promises";
import { createConnection, createServer, type Server, type Socket } from "node:net";
import type { Logger } from "pino";
import { z } from "zod";
import type { CompletionChoiceEligibilityPort, CompletionChoiceEligibilityRequest } from "../domain/ports/completion-choice-eligibility.js";
import { ActiveWorkTracker } from "./active-work-tracker.js";
import { safeLogError } from "./safe-error.js";

const DEFAULT_MAX_REQUEST_BYTES = 4 * 1024;
const DEFAULT_IDLE_TIMEOUT_MS = 1_000;
const DEFAULT_MAX_CONNECTIONS = 32;
const DEFAULT_CLIENT_TIMEOUT_MS = 500;
const MAX_RESPONSE_BYTES = 1_024;

const requestSchema = z.object({
  paneId: z.string().min(1).max(256)
}).passthrough();

export type { CompletionChoiceEligibilityPort, CompletionChoiceEligibilityRequest } from "../domain/ports/completion-choice-eligibility.js";
export interface CompletionChoiceEligibilityGatewayOptions { idleTimeoutMs?: number; eligibilityTimeoutMs?: number; maxConnections?: number; maxRequestBytes?: number }

export class CompletionChoiceEligibilityGateway {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly handlers = new ActiveWorkTracker();
  private readonly inFlightEligibility = new Map<string, Promise<boolean>>();
  private startPromise: Promise<void> | null = null;
  private accepting = false;

  constructor(
    private readonly socketPath: string,
    private readonly eligibility: CompletionChoiceEligibilityPort,
    private readonly logger: Logger,
    private readonly options: CompletionChoiceEligibilityGatewayOptions = {}
  ) {}

  async start(): Promise<void> {
    if (this.server && this.accepting) return;
    if (this.startPromise) return this.startPromise;
    const starting = this.startInternal();
    this.startPromise = starting;
    try { await starting; }
    finally { if (this.startPromise === starting) this.startPromise = null; }
  }

  private async startInternal(): Promise<void> {
    await rm(this.socketPath, { force: true });
    const server = createServer((socket) => this.accept(socket));
    this.server = server;
    try {
      await new Promise<void>((resolve, reject) => {
        server.once("error", reject);
        server.listen(this.socketPath, () => { server.off("error", reject); resolve(); });
      });
      await chmod(this.socketPath, 0o600);
      this.accepting = true;
    } catch (error) {
      this.accepting = false;
      if (this.server === server) this.server = null;
      if (server.listening) await new Promise<void>((resolve) => server.close(() => resolve()));
      throw error;
    }
  }

  async stop(): Promise<void> {
    await this.startPromise?.catch(() => undefined);
    this.accepting = false;
    const server = this.server;
    this.server = null;
    if (server) {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const socket of this.sockets) socket.destroy();
      await closed;
    }
    await this.handlers.settle();
    this.inFlightEligibility.clear();
    await rm(this.socketPath, { force: true });
  }

  private accept(socket: Socket): void {
    if (!this.accepting || this.sockets.size >= Math.max(1, this.options.maxConnections ?? DEFAULT_MAX_CONNECTIONS)) {
      socket.destroy();
      return;
    }
    this.sockets.add(socket);
    const timeout = setTimeout(() => socket.destroy(), Math.max(1, this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS));
    timeout.unref();
    socket.setEncoding("utf8");
    socket.once("close", () => { clearTimeout(timeout); this.sockets.delete(socket); });
    socket.on("error", (error) => this.logger.debug({ event: "completion-choice-eligibility-socket-error", err: safeLogError(error), outcome: "closed" }, "Completion choice eligibility socket closed with an error"));
    let input = "";
    let handled = false;
    const onData = (chunk: string): void => {
      if (handled) return;
      input += chunk;
      if (Buffer.byteLength(input, "utf8") > Math.max(1, this.options.maxRequestBytes ?? DEFAULT_MAX_REQUEST_BYTES)) {
        handled = true;
        socket.destroy();
        return;
      }
      const newline = input.indexOf("\n");
      if (newline < 0) return;
      handled = true;
      clearTimeout(timeout);
      socket.removeListener("data", onData);
      const handling = this.handlers.track(this.handle(input.slice(0, newline)));
      void handling.then((eligible) => { if (!socket.destroyed) socket.end(`${JSON.stringify({ eligible })}\n`); });
    };
    socket.on("data", onData);
  }

  private async handle(raw: string): Promise<boolean> {
    try {
      const request = requestSchema.parse(JSON.parse(raw));
      return await this.eligibleForPane(request.paneId);
    } catch {
      return false;
    }
  }

  private eligibleForPane(paneId: string): Promise<boolean> {
    const existing = this.inFlightEligibility.get(paneId);
    if (existing) return existing;

    const result = boundedEligibility(
      Promise.resolve(this.eligibility.isEligible({ paneId })),
      Math.max(1, this.options.eligibilityTimeoutMs ?? this.options.idleTimeoutMs ?? DEFAULT_IDLE_TIMEOUT_MS)
    );
    const inFlight = result.finally(() => {
      if (this.inFlightEligibility.get(paneId) === inFlight) this.inFlightEligibility.delete(paneId);
    });
    this.inFlightEligibility.set(paneId, inFlight);
    return inFlight;
  }
}

function boundedEligibility(result: Promise<boolean>, timeoutMs: number): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    const settle = (value: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      resolve(value);
    };
    const timer = setTimeout(() => settle(false), timeoutMs);
    timer.unref();
    void result.then((value) => settle(value === true), () => settle(false));
  });
}

export function callCompletionChoiceEligibilityGateway(
  socketPath: string,
  request: CompletionChoiceEligibilityRequest,
  options: { timeoutMs?: number } = {}
): Promise<boolean> {
  return new Promise((resolve) => {
    let settled = false;
    let output = "";
    let bytes = 0;
    const socket = createConnection(socketPath);
    const settle = (eligible: boolean): void => {
      if (settled) return;
      settled = true;
      clearTimeout(timer);
      socket.destroy();
      resolve(eligible);
    };
    const timer = setTimeout(() => settle(false), Math.max(1, options.timeoutMs ?? DEFAULT_CLIENT_TIMEOUT_MS));
    timer.unref();
    socket.setEncoding("utf8");
    socket.once("connect", () => socket.write(`${JSON.stringify(request)}\n`));
    socket.on("data", (chunk: string) => {
      bytes += Buffer.byteLength(chunk, "utf8");
      if (bytes > MAX_RESPONSE_BYTES) { settle(false); return; }
      output += chunk;
    });
    socket.once("end", () => {
      try {
        const decoded = JSON.parse(output) as { eligible?: unknown };
        settle(decoded.eligible === true);
      } catch { settle(false); }
    });
    socket.once("error", () => settle(false));
  });
}
