import { createConnection, type Socket } from "node:net";
import type { Logger } from "pino";
import { z } from "zod";
import { extractHerdrEventIds } from "./herdr-event-inbox.js";
import { safeLogError } from "./safe-error.js";

const MAX_FRAME_BYTES = 256 * 1024;
const eventSchema = z.object({ event: z.string(), data: z.unknown() });

export interface HerdrNativeEventHint {
  event: string;
  workspaceIds: string[];
  paneIds: string[];
}

export class HerdrSocketSubscriber {
  private socket: Socket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private attempt = 0;
  private buffer = "";

  constructor(
    private readonly socketPath: string,
    private readonly paneIds: () => Promise<readonly string[]>,
    private readonly onEvent: (hint: HerdrNativeEventHint) => void | Promise<void>,
    private readonly logger: Pick<Logger, "info" | "warn" | "debug">,
    private readonly reconnectBaseMs = 250,
    private readonly reconnectMaxMs = 10_000,
    private readonly maxFrameBytes = MAX_FRAME_BYTES
  ) {}

  start(): void {
    if (!this.stopped && !this.socket && !this.reconnectTimer) void this.connect();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
    const socket = this.socket;
    this.socket = null;
    if (socket && !socket.destroyed) await new Promise<void>((resolve) => { socket.once("close", resolve); socket.destroy(); });
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.socket) return;
    let paneIds: readonly string[];
    try { paneIds = await this.paneIds(); }
    catch (error) { this.failed(error); return; }
    if (this.stopped) return;
    const socket = createConnection({ path: this.socketPath });
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      this.attempt = 0;
      const subscriptions: object[] = [
        { type: "pane.created" }, { type: "pane.updated" }, { type: "pane.closed" },
        { type: "pane.exited" }, { type: "pane.moved" }, { type: "pane.agent_detected" },
        ...[...new Set(paneIds)].map((pane_id) => ({ type: "pane.agent_status_changed", pane_id }))
      ];
      socket.write(`${JSON.stringify({ id: "herdr-lark-bridge-events", method: "events.subscribe", params: { subscriptions } })}\n`);
      this.logger.info({ event: "herdr-socket-connected", subscriptionCount: subscriptions.length, paneCount: paneIds.length, outcome: "connected" }, "connected to Herdr native event stream");
      this.emit({ event: "socket.connected", workspaceIds: [], paneIds: [] });
    });
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", (error) => this.logger.warn({ event: "herdr-socket-error", err: safeLogError(error), outcome: "reconnecting" }, "Herdr native event stream failed"));
    socket.once("close", () => {
      if (this.socket === socket) this.socket = null;
      this.buffer = "";
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private receive(chunk: string): void {
    this.buffer += chunk;
    for (;;) {
      const newline = this.buffer.indexOf("\n");
      if (newline < 0) break;
      const line = this.buffer.slice(0, newline);
      this.buffer = this.buffer.slice(newline + 1);
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.maxFrameBytes) {
        this.invalidFrame("herdr-socket-frame-too-large", "discarded oversized Herdr socket frame");
        continue;
      }
      try {
        const value: unknown = JSON.parse(line);
        const parsed = eventSchema.safeParse(value);
        if (!parsed.success) continue; // subscription acknowledgement or unrelated response
        const ids = extractHerdrEventIds(parsed.data.data);
        this.emit({ event: parsed.data.event, ...ids });
        if (isPaneTopologyEvent(parsed.data.event)) this.refreshSubscriptions();
      } catch (error) {
        this.logger.warn({ event: "herdr-socket-frame-invalid", err: safeLogError(error), outcome: "full_reconciliation" }, "ignored malformed Herdr socket frame");
        this.emit({ event: "socket.invalid", workspaceIds: [], paneIds: [] });
      }
    }
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) {
      this.buffer = "";
      this.invalidFrame("herdr-socket-frame-too-large", "discarded oversized Herdr socket frame");
    }
  }

  private invalidFrame(event: string, message: string): void {
    this.logger.warn({ event, outcome: "full_reconciliation" }, message);
    this.emit({ event: "socket.invalid", workspaceIds: [], paneIds: [] });
  }

  private emit(hint: HerdrNativeEventHint): void {
    void Promise.resolve(this.onEvent(hint)).catch((error) => {
      this.logger.warn({ event: "herdr-socket-event-handler-failed", err: safeLogError(error), sourceEvent: hint.event, outcome: "periodic_reconciliation_fallback" }, "Herdr native event handler failed");
    });
  }

  private refreshSubscriptions(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.destroy();
  }

  private failed(error: unknown): void {
    this.logger.warn({ event: "herdr-socket-connect-failed", err: safeLogError(error), outcome: "reconnecting" }, "could not prepare Herdr native event subscription");
    this.scheduleReconnect();
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** Math.min(this.attempt++, 6));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, delay);
    this.reconnectTimer.unref();
  }
}

function isPaneTopologyEvent(event: string): boolean {
  return event === "pane.created" || event === "pane_created" || event === "pane.moved" || event === "pane_moved";
}
