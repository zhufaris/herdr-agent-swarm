import { randomBytes } from "node:crypto";
import { chmod, rm } from "node:fs/promises";
import { createServer, type Server, type Socket } from "node:net";
import { z } from "zod";
import type { Logger } from "pino";
import type { BindingStorePort } from "../domain/ports.js";
import { safeLogError } from "./safe-error.js";

const MAX_REPORT_BYTES = 4096;
const reportSchema = z.object({
  paneId: z.string().min(1).max(256), bindingId: z.string().uuid(), generation: z.number().int().positive(),
  sessionId: z.string().regex(/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i),
  source: z.enum(["startup", "resume"]), capability: z.string().regex(/^[a-f0-9]{64}$/)
}).strict();

export class TraexSessionReporter {
  private server: Server | null = null;
  private readonly sockets = new Set<Socket>();
  private readonly capability = randomBytes(32).toString("hex");

  constructor(private readonly socketPath: string, private readonly store: BindingStorePort, private readonly logger: Logger) {}

  environment(bindingId: string, generation: number): Record<string, string> {
    return { HERDR_BRIDGE_SESSION_SOCKET: this.socketPath, HERDR_BRIDGE_SESSION_CAPABILITY: this.capability, HERDR_BRIDGE_BINDING_ID: bindingId, HERDR_BRIDGE_GENERATION: String(generation) };
  }

  async start(): Promise<void> {
    if (this.server) return;
    await rm(this.socketPath, { force: true });
    const server = createServer((socket) => {
      this.sockets.add(socket);
      socket.once("close", () => this.sockets.delete(socket));
      let input = "";
      socket.setEncoding("utf8");
      socket.on("data", (chunk: string) => {
        input += chunk;
        if (Buffer.byteLength(input) > MAX_REPORT_BYTES) { socket.destroy(); return; }
        const newline = input.indexOf("\n");
        if (newline < 0) return;
        let outcome: "recorded" | "duplicate" | "rejected" = "rejected";
        let paneId: string | undefined;
        try {
          const report = reportSchema.safeParse(JSON.parse(input.slice(0, newline)));
          if (report.success && report.data.capability === this.capability) {
            paneId = report.data.paneId;
            outcome = this.store.recordReportedTraexSession({ bindingId: report.data.bindingId, paneId, generation: report.data.generation, sessionId: report.data.sessionId, reportedAt: new Date().toISOString() });
          }
        } catch (error) {
          this.logger.warn({ event: "traex-session-report-failed", err: safeLogError(error), outcome: "rejected" }, "TraeX session report failed");
        }
        if (outcome === "recorded") this.logger.info({ event: "traex-session-reported", outcome, paneId }, "recorded TraeX session identity");
        socket.end(JSON.stringify({ outcome }) + "\n");
      });
    });
    this.server = server;
    await new Promise<void>((resolve, reject) => { server.once("error", reject); server.listen(this.socketPath, () => { server.off("error", reject); resolve(); }); });
    await chmod(this.socketPath, 0o600);
  }

  async stop(): Promise<void> {
    const server = this.server;
    this.server = null;
    if (server) {
      const closed = new Promise<void>((resolve, reject) => server.close((error) => error ? reject(error) : resolve()));
      for (const socket of this.sockets) socket.destroy();
      await closed;
    }
    await rm(this.socketPath, { force: true });
  }
}
