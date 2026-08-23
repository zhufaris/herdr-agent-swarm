import { createSocket, type Socket } from "node:dgram";
import type { Logger } from "pino";
import { safeLogError } from "./safe-error.js";

export const MAX_HERDR_EVENT_BYTES = 8_192;
export interface HerdrEventHint { event: string; workspaceIds: string[]; paneIds: string[]; receivedAt: string }

export class HerdrEventInbox {
  private socket: Socket | null = null;
  private timer: NodeJS.Timeout | null = null;
  private running: Promise<void> | null = null;
  private stopped = false;
  private active = false;
  private requiresFullScan = false;
  private readonly workspaceIds = new Set<string>();

  constructor(
    private readonly port: number,
    private readonly reconcile: (workspaceIds?: readonly string[]) => Promise<void>,
    private readonly logger: Logger,
    private readonly debounceMs = 100,
    private readonly host = "127.0.0.1"
  ) {}

  async start(): Promise<void> {
    if (this.stopped || this.socket) return;
    const socket = createSocket("udp4");
    this.socket = socket;
    socket.on("message", (message) => this.receive(message));
    socket.on("error", (error) => this.logger.error({ event: "herdr-event-receiver-failed", err: safeLogError(error), outcome: "failed" }, "Herdr event receiver failed"));
    await new Promise<void>((resolve, reject) => {
      socket.once("error", reject);
      socket.bind(this.port, this.host, () => { socket.off("error", reject); resolve(); });
    });
  }

  activate(): void { this.active = true; }

  async stop(): Promise<void> {
    this.stopped = true;
    this.active = false;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket) await new Promise<void>((resolve) => socket.close(() => resolve()));
    if (this.running) await this.running;
  }

  address(): { address: string; port: number } | null {
    const address = this.socket?.address();
    return address && typeof address !== "string" ? { address: address.address, port: address.port } : null;
  }

  private receive(message: Buffer): void {
    if (!this.active || this.stopped) return;
    if (message.byteLength > MAX_HERDR_EVENT_BYTES) { this.requiresFullScan = true; this.schedule(); return; }
    try {
      const hint = parseHerdrEventHint(JSON.parse(message.toString("utf8")));
      if (hint.workspaceIds.length === 0) this.requiresFullScan = true;
      for (const workspaceId of hint.workspaceIds) this.workspaceIds.add(workspaceId);
    } catch (error) {
      this.requiresFullScan = true;
      this.logger.warn({ event: "herdr-event-hint-invalid", err: safeLogError(error), outcome: "full_reconciliation" }, "ignored invalid Herdr event hint");
    }
    this.schedule();
  }

  private schedule(): void {
    if (this.timer || this.stopped) return;
    this.timer = setTimeout(() => {
      this.timer = null;
      const targets = this.requiresFullScan ? undefined : [...this.workspaceIds];
      this.requiresFullScan = false;
      this.workspaceIds.clear();
      const work = this.reconcile(targets).catch((error) => this.logger.error({ event: "herdr-event-reconciliation-failed", err: safeLogError(error), outcome: "failed" }, "Herdr event reconciliation failed"));
      this.running = work;
      void work.finally(() => { if (this.running === work) this.running = null; });
    }, this.debounceMs);
    this.timer.unref();
  }
}

export function parseHerdrEventHint(value: unknown): HerdrEventHint {
  if (!value || typeof value !== "object") throw new Error("event hint must be an object");
  const record = value as Record<string, unknown>;
  if (typeof record.event !== "string" || !record.event || record.event.length > 128) throw new Error("invalid event name");
  return {
    event: record.event,
    workspaceIds: boundedStrings(record.workspaceIds),
    paneIds: boundedStrings(record.paneIds),
    receivedAt: typeof record.receivedAt === "string" ? record.receivedAt.slice(0, 64) : new Date().toISOString()
  };
}

export function extractHerdrEventIds(value: unknown): { workspaceIds: string[]; paneIds: string[] } {
  const workspaceIds = new Set<string>();
  const paneIds = new Set<string>();
  visit(value, workspaceIds, paneIds, 0);
  return { workspaceIds: [...workspaceIds].slice(0, 64), paneIds: [...paneIds].slice(0, 128) };
}

function boundedStrings(value: unknown): string[] {
  return Array.isArray(value) ? [...new Set(value.filter((item): item is string => typeof item === "string" && item.length > 0 && item.length <= 256))].slice(0, 128) : [];
}

function visit(value: unknown, workspaces: Set<string>, panes: Set<string>, depth: number): void {
  if (depth > 5 || !value || typeof value !== "object") return;
  if (Array.isArray(value)) { for (const item of value.slice(0, 100)) visit(item, workspaces, panes, depth + 1); return; }
  for (const [key, item] of Object.entries(value)) {
    if ((key === "workspace_id" || key === "workspaceId") && typeof item === "string" && item.length <= 256) workspaces.add(item);
    else if ((key === "pane_id" || key === "paneId") && typeof item === "string" && item.length <= 256) panes.add(item);
    else visit(item, workspaces, panes, depth + 1);
  }
}
