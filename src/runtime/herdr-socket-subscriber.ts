import { createConnection, type Socket } from "node:net";
import type { Logger } from "pino";
import { z } from "zod";
import { extractHerdrEventIds } from "./herdr-event-ids.js";
import {
  mergeCoreSessionEventsAvailableHints,
  mergeHerdrRuntimeHints,
  normalizeHerdrEvent,
  type CoreSessionEventsAvailableHint,
  type HerdrNativeEventHint,
  type HerdrRuntimeHint
} from "./herdr-event-hint.js";
import { safeLogError } from "./safe-error.js";
import { FailureLogGate } from "./failure-log-gate.js";
import type { ShutdownContext } from "./shutdown-context.js";

// Match Core's bounded protocol frame budget. Session-event readers request a
// smaller page as an additional guard, but a valid Core response may still be
// larger than the former 256 KiB client-only ceiling.
const MAX_FRAME_BYTES = 2 * 1024 * 1024;
const MAX_FRAMES_PER_TICK = 256;
const eventSchema = z.object({ event: z.string(), data: z.unknown() });
const responseSchema = z.object({ id: z.string(), result: z.unknown() }).refine((value) => Object.hasOwn(value, "result"));
const errorResponseSchema = z.object({ id: z.string(), error: z.object({ code: z.string(), message: z.string() }).passthrough() });
const sessionEventsAvailableSchema = z.object({
  stream_id: z.string().min(1).max(512),
  latest_cursor: z.string().min(1).max(512)
});

export type { HerdrNativeEventHint } from "./herdr-event-hint.js";

export interface HerdrSocketStatus {
  connected: boolean;
  eventsConnected: boolean;
  requests: number;
  responses: number;
  requestFailures: number;
  transportFailures: number;
  pendingRequests: number;
}

export class HerdrSocketRequestError extends Error {
  constructor(readonly code: string, readonly written: boolean, message = code, readonly details?: Readonly<Record<string, unknown>>) {
    super(message);
    this.name = "HerdrSocketRequestError";
  }
}

interface PendingRequest {
  resolve(value: unknown): void;
  reject(error: HerdrSocketRequestError): void;
  timer: NodeJS.Timeout;
  socket: Socket;
  written: boolean;
}

interface PaneWaiter {
  resolve(changed: boolean): void;
  timer: NodeJS.Timeout;
}

export class HerdrSocketSubscriber {
  private socket: Socket | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private stopped = false;
  private attempt = 0;
  private buffer = "";
  private dispatching = false;
  private hintDrain: Promise<void> | null = null;
  private ingressClose: Promise<void> | null = null;
  private readonly eventAbort = new AbortController();
  private pendingRuntimeHint: HerdrRuntimeHint | null = null;
  private pendingCoreHint: CoreSessionEventsAvailableHint | null = null;
  private stableTimer: NodeJS.Timeout | null = null;
  private subscriptionAckTimer: NodeJS.Timeout | null = null;
  private subscriptionRefreshTimer: NodeJS.Timeout | null = null;
  private connected = false;
  private eventsConnected = false;
  private nextRequestId = 1;
  private nextSubscriptionId = 1;
  private subscriptionRequestId: string | null = null;
  private subscriptionAcknowledged = false;
  private globalStatusSubscription = false;
  private bufferedRuntimeHint: HerdrRuntimeHint | null = null;
  private bufferedCoreHint: CoreSessionEventsAvailableHint | null = null;
  private readonly pendingRequests = new Map<string, PendingRequest>();
  private readonly paneWaiters = new Map<string, Set<PaneWaiter>>();
  private readonly subscribedPaneIds = new Set<string>();
  private requests = 0;
  private responses = 0;
  private requestFailures = 0;
  private transportFailures = 0;
  private readonly failureLogs = new FailureLogGate();

  constructor(
    private readonly socketPath: string,
    private readonly paneIds: () => Promise<readonly string[]>,
    private readonly onEvent: (hint: HerdrNativeEventHint, signal: AbortSignal) => void | Promise<void>,
    private readonly logger: Pick<Logger, "info" | "warn" | "debug">,
    private readonly reconnectBaseMs = 250,
    private readonly reconnectMaxMs = 10_000,
    private readonly maxFrameBytes = MAX_FRAME_BYTES,
    private readonly subscriptionAckTimeoutMs = 5_000,
    private readonly supportsPaneAgentStatusAll: () => Promise<boolean> = async () => false
  ) {}

  start(): void {
    this.startEvents();
  }

  startEvents(): void {
    if (!this.stopped && !this.socket && !this.reconnectTimer) void this.connect();
  }

  async stop(): Promise<void> {
    this.eventAbort.abort("socket_stopped");
    this.stopIngress();
    await this.ingressClose;
    await this.drainEvents();
  }

  stopIngress(): void {
    if (this.stopped) return;
    this.stopped = true;
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    if (this.stableTimer) clearTimeout(this.stableTimer);
    if (this.subscriptionAckTimer) clearTimeout(this.subscriptionAckTimer);
    if (this.subscriptionRefreshTimer) clearTimeout(this.subscriptionRefreshTimer);
    this.reconnectTimer = null;
    this.stableTimer = null;
    this.subscriptionAckTimer = null;
    this.subscriptionRequestId = null;
    this.subscriptionAcknowledged = false;
    this.globalStatusSubscription = false;
    this.bufferedRuntimeHint = null;
    this.bufferedCoreHint = null;
    this.subscriptionRefreshTimer = null;
    this.connected = false;
    this.eventsConnected = false;
    this.rejectPending("socket_stopped");
    this.resolveAllPaneWaiters(false);
    this.subscribedPaneIds.clear();
    this.failureLogs.clear();
    const socket = this.socket;
    this.socket = null;
    for (const pending of this.pendingRequests.values()) pending.socket.destroy();
    if (socket && !socket.destroyed) {
      this.ingressClose = new Promise<void>((resolve) => { socket.once("close", resolve); socket.destroy(); });
    }
  }

  async drainEvents(context?: ShutdownContext): Promise<void> {
    const abortEvents = () => this.eventAbort.abort(context?.signal.reason);
    if (context?.signal.aborted) abortEvents();
    else context?.signal.addEventListener("abort", abortEvents, { once: true });
    try { await this.hintDrain; }
    finally { context?.signal.removeEventListener("abort", abortEvents); }
  }

  request(method: string, params: object, timeoutMs: number): Promise<unknown> {
    this.requests += 1;
    if (this.stopped) {
      this.requestFailures += 1;
      this.transportFailures += 1;
      return Promise.reject(new HerdrSocketRequestError("socket_unavailable", false));
    }
    const id = `herdr-agent-swarm:${this.nextRequestId++}`;
    return new Promise((resolve, reject) => {
      const socket = createConnection({ path: this.socketPath });
      let buffer = "";
      const timer = setTimeout(() => {
        const pending = this.pendingRequests.get(id);
        if (!pending) return;
        this.pendingRequests.delete(id);
        this.requestFailures += 1;
        this.transportFailures += 1;
        socket.destroy();
        reject(new HerdrSocketRequestError("socket_request_timeout", pending.written));
      }, timeoutMs);
      timer.unref();
      this.pendingRequests.set(id, { resolve, reject, timer, socket, written: false });
      socket.setEncoding("utf8");
      socket.once("connect", () => {
        const pending = this.pendingRequests.get(id);
        if (pending) pending.written = true;
        socket.write(`${JSON.stringify({ id, method, params })}\n`);
      });
      socket.on("data", (chunk: string) => {
        buffer += chunk;
        if (Buffer.byteLength(buffer) > this.maxFrameBytes) {
          this.rejectRequest(id, "socket_response_too_large", "Herdr RPC response exceeded the frame limit", true);
          socket.destroy();
          return;
        }
        const newline = buffer.indexOf("\n");
        if (newline < 0) return;
        try {
          const value: unknown = JSON.parse(buffer.slice(0, newline));
          const response = responseSchema.safeParse(value);
          if (response.success) this.resolveRequest(response.data.id, response.data.result);
          else {
            const failure = errorResponseSchema.parse(value);
            this.rejectRequest(failure.id, failure.error.code, failure.error.message, true, failure.error);
          }
        } catch { this.rejectRequest(id, "socket_response_invalid", "invalid Herdr RPC response"); }
        socket.end();
      });
      socket.once("error", () => this.rejectRequest(id, "socket_disconnected", "Herdr RPC connection failed"));
      socket.once("close", () => {
        if (this.pendingRequests.has(id)) this.rejectRequest(id, "socket_disconnected", "Herdr RPC connection closed");
      });
    });
  }

  status(): HerdrSocketStatus {
    return { connected: this.connected, eventsConnected: this.eventsConnected, requests: this.requests, responses: this.responses, requestFailures: this.requestFailures, transportFailures: this.transportFailures, pendingRequests: this.pendingRequests.size };
  }

  waitForPaneEvent(paneId: string, timeoutMs: number): Promise<boolean> {
    return new Promise((resolve) => {
      const waiter: PaneWaiter = {
        resolve,
        timer: setTimeout(() => this.resolvePaneWaiter(paneId, waiter, false), timeoutMs)
      };
      waiter.timer.unref();
      const waiters = this.paneWaiters.get(paneId) ?? new Set<PaneWaiter>();
      waiters.add(waiter);
      this.paneWaiters.set(paneId, waiters);
    });
  }

  private async connect(): Promise<void> {
    if (this.stopped || this.socket) return;
    let globalStatusSubscription = false;
    try { globalStatusSubscription = await this.supportsPaneAgentStatusAll(); }
    catch { globalStatusSubscription = false; }
    let paneIds: readonly string[] = [];
    if (!globalStatusSubscription) {
      try { paneIds = await this.paneIds(); }
      catch (error) { this.failed(error); return; }
    }
    if (this.stopped) return;
    this.globalStatusSubscription = globalStatusSubscription;
    this.subscriptionAcknowledged = false;
    this.bufferedRuntimeHint = null;
    this.bufferedCoreHint = null;
    this.subscribedPaneIds.clear();
    for (const paneId of paneIds) this.subscribedPaneIds.add(paneId);
    const socket = createConnection({ path: this.socketPath });
    this.socket = socket;
    socket.setEncoding("utf8");
    socket.once("connect", () => {
      const subscriptions: object[] = [
        { type: "session.events.available" },
        { type: "pane.created" }, { type: "pane.updated" }, { type: "pane.closed" },
        { type: "pane.exited" }, { type: "pane.moved" }, { type: "pane.agent_detected" },
        ...(this.globalStatusSubscription
          ? [{ type: "pane.agent_status_all" }]
          : [...this.subscribedPaneIds].map((pane_id) => ({ type: "pane.agent_status_changed", pane_id })))
      ];
      const subscriptionRequestId = `herdr-agent-swarm-events:${this.nextSubscriptionId++}`;
      this.subscriptionRequestId = subscriptionRequestId;
      socket.write(`${JSON.stringify({ id: subscriptionRequestId, method: "events.subscribe", params: { subscriptions } })}\n`);
      this.subscriptionAckTimer = setTimeout(() => {
        if (this.socket !== socket || this.subscriptionRequestId !== subscriptionRequestId) return;
        this.logConnectionFailure(new Error("Herdr event subscription acknowledgement timed out"), "herdr-socket-subscribe-timeout", "Herdr native event subscription timed out");
        socket.destroy();
      }, this.subscriptionAckTimeoutMs);
      this.subscriptionAckTimer.unref();
    });
    socket.on("data", (chunk: string) => this.receive(chunk));
    socket.on("error", (error) => this.logConnectionFailure(error, "herdr-socket-error", "Herdr native event stream failed"));
    socket.once("close", () => {
      if (this.socket === socket) this.socket = null;
      this.eventsConnected = false;
      this.subscriptionRequestId = null;
      this.subscriptionAcknowledged = false;
      this.globalStatusSubscription = false;
      this.bufferedRuntimeHint = null;
      this.bufferedCoreHint = null;
      if (this.subscriptionAckTimer) clearTimeout(this.subscriptionAckTimer);
      this.subscriptionAckTimer = null;
      this.resolveAllPaneWaiters(false);
      if (this.stableTimer) clearTimeout(this.stableTimer);
      this.stableTimer = null;
      this.buffer = "";
      if (!this.stopped) this.scheduleReconnect();
    });
  }

  private receive(chunk: string): void {
    if (this.stopped) return;
    this.buffer += chunk;
    let cursor = 0;
    let frames = 0;
    for (; frames < MAX_FRAMES_PER_TICK; frames += 1) {
      const newline = this.buffer.indexOf("\n", cursor);
      if (newline < 0) break;
      const line = this.buffer.slice(cursor, newline);
      cursor = newline + 1;
      if (!line.trim()) continue;
      if (Buffer.byteLength(line) > this.maxFrameBytes) {
        this.invalidFrame("herdr-socket-frame-too-large", "discarded oversized Herdr socket frame");
        continue;
      }
      try {
        const value: unknown = JSON.parse(line);
        const response = responseSchema.safeParse(value);
        if (response.success) {
          if (response.data.id === this.subscriptionRequestId) {
            if (!this.subscriptionAcknowledged) this.acknowledgeSubscription(this.socket);
            continue;
          }
          this.resolveRequest(response.data.id, response.data.result);
          continue;
        }
        const failure = errorResponseSchema.safeParse(value);
        if (failure.success) {
          if (failure.data.id === this.subscriptionRequestId) {
            const eventsLost = failure.data.error.code === "events_lost";
            this.logConnectionFailure(
              new Error(`${failure.data.error.code}: ${failure.data.error.message}`),
              eventsLost ? "herdr-socket-events-lost" : "herdr-socket-subscribe-failed",
              eventsLost ? "Herdr native event subscription lost retained events" : "Herdr native event subscription was rejected"
            );
            this.socket?.destroy();
            continue;
          }
          this.rejectRequest(failure.data.id, failure.data.error.code, failure.data.error.message, false, failure.data.error);
          continue;
        }
        const parsed = eventSchema.safeParse(value);
        if (!parsed.success) continue; // subscription acknowledgement or unrelated response
        this.attempt = 0;
        if (this.stableTimer) clearTimeout(this.stableTimer);
        this.stableTimer = null;
        if (parsed.data.event === "session.events.available") {
          const available = sessionEventsAvailableSchema.safeParse(parsed.data.data);
          if (available.success) {
            this.emitOrBuffer({
              kind: "session-events-available",
              sources: [{ sourceId: available.data.stream_id, latestCursor: available.data.latest_cursor }]
            });
          } else {
            this.invalidFrame("herdr-socket-session-events-available-invalid", "discarded invalid Core session availability event");
          }
          continue;
        }
        const ids = extractHerdrEventIds(parsed.data.data);
        for (const paneId of ids.paneIds) this.resolvePaneWaiters(paneId, true);
        const hint = normalizeHerdrEvent(parsed.data.event, ids);
        this.emitOrBuffer(hint);
        if (!this.globalStatusSubscription && (hint.kind === "pane-created" || hint.kind === "pane-moved")) {
          const newPaneIds = ids.paneIds.filter((paneId) => !this.subscribedPaneIds.has(paneId));
          if (newPaneIds.length > 0) {
            for (const paneId of newPaneIds) this.subscribedPaneIds.add(paneId);
            this.scheduleSubscriptionRefresh();
          }
        } else if (!this.globalStatusSubscription && (hint.kind === "pane-closed" || hint.kind === "pane-exited")) {
          const removed = ids.paneIds.filter((paneId) => this.subscribedPaneIds.delete(paneId));
          if (removed.length > 0) this.scheduleSubscriptionRefresh();
        }
      } catch (error) {
        this.logger.warn({ event: "herdr-socket-frame-invalid", err: safeLogError(error), outcome: "full_reconciliation" }, "ignored malformed Herdr socket frame");
        this.emitOrBuffer({ kind: "invalid", scope: "all", workspaceIds: [], paneIds: [] });
        if (this.subscriptionRequestId && !this.subscriptionAcknowledged) this.socket?.destroy();
      }
    }
    if (cursor > 0) this.buffer = this.buffer.slice(cursor);
    if (Buffer.byteLength(this.buffer) > this.maxFrameBytes) {
      this.buffer = "";
      this.invalidFrame("herdr-socket-frame-too-large", "discarded oversized Herdr socket frame");
    } else if (frames === MAX_FRAMES_PER_TICK && this.buffer.includes("\n")) {
      setImmediate(() => { if (!this.stopped) this.receive(""); });
    }
  }

  private invalidFrame(event: string, message: string): void {
    this.logger.warn({ event, outcome: "full_reconciliation" }, message);
    this.emitOrBuffer({ kind: "invalid", scope: "all", workspaceIds: [], paneIds: [] });
  }

  private emitOrBuffer(hint: HerdrNativeEventHint): void {
    if (!this.globalStatusSubscription || this.subscriptionAcknowledged) {
      this.emit(hint);
      return;
    }
    if (hint.kind === "session-events-available") {
      this.bufferedCoreHint = mergeCoreSessionEventsAvailableHints(this.bufferedCoreHint, hint);
    } else {
      this.bufferedRuntimeHint = mergeHerdrRuntimeHints(this.bufferedRuntimeHint, hint);
    }
  }

  private emit(hint: HerdrNativeEventHint): void {
    if (this.stopped) return;
    if (hint.kind === "session-events-available") {
      this.pendingCoreHint = mergeCoreSessionEventsAvailableHints(this.pendingCoreHint, hint);
    } else {
      this.pendingRuntimeHint = mergeHerdrRuntimeHints(this.pendingRuntimeHint, hint);
    }
    if (this.dispatching) return;
    this.dispatching = true;
    const drain = this.drainHints();
    this.hintDrain = drain;
    void drain.finally(() => { if (this.hintDrain === drain) this.hintDrain = null; });
  }

  private async drainHints(): Promise<void> {
    try {
      while (this.pendingRuntimeHint || this.pendingCoreHint) {
        if (this.eventAbort.signal.aborted) {
          this.pendingRuntimeHint = null;
          this.pendingCoreHint = null;
          break;
        }
        const hint = this.pendingCoreHint ?? this.pendingRuntimeHint;
        if (!hint) break;
        if (hint.kind === "session-events-available") this.pendingCoreHint = null;
        else this.pendingRuntimeHint = null;
        try { await this.onEvent(hint, this.eventAbort.signal); }
        catch (error) { this.logger.warn({ event: "herdr-socket-event-handler-failed", err: safeLogError(error), sourceEvent: hint.kind, outcome: "periodic_reconciliation_fallback" }, "Herdr native event handler failed"); }
      }
    } finally {
      this.dispatching = false;
      const pending = this.pendingCoreHint ?? this.pendingRuntimeHint;
      if (pending && !this.stopped) this.emit(pending);
    }
  }

  private refreshSubscriptions(): void {
    const socket = this.socket;
    if (!socket) return;
    this.socket = null;
    socket.destroy();
  }

  private acknowledgeSubscription(socket: Socket | null): void {
    if (!socket || this.socket !== socket || !this.subscriptionRequestId || this.subscriptionAcknowledged) return;
    this.subscriptionAcknowledged = true;
    if (this.subscriptionAckTimer) clearTimeout(this.subscriptionAckTimer);
    this.subscriptionAckTimer = null;
    this.eventsConnected = true;
    this.stableTimer = setTimeout(() => { this.attempt = 0; this.stableTimer = null; }, 1_000);
    this.stableTimer.unref();
    const recovery = this.failureLogs.recover("event-stream");
    this.logger.info({ event: recovery ? "herdr-socket-recovered" : "herdr-socket-connected", paneCount: this.subscribedPaneIds.size, ...(recovery ?? {}), outcome: "subscribed" }, recovery ? "Herdr native event stream recovered" : "subscribed to Herdr native event stream");
    this.emit({ kind: "socket-recovered", scope: "all", workspaceIds: [], paneIds: [] });
    const bufferedCoreHint = this.bufferedCoreHint;
    const bufferedRuntimeHint = this.bufferedRuntimeHint;
    this.bufferedCoreHint = null;
    this.bufferedRuntimeHint = null;
    if (bufferedCoreHint) this.emit(bufferedCoreHint);
    if (bufferedRuntimeHint) this.emit(bufferedRuntimeHint);
  }

  private scheduleSubscriptionRefresh(): void {
    if (this.subscriptionRefreshTimer) clearTimeout(this.subscriptionRefreshTimer);
    this.subscriptionRefreshTimer = setTimeout(() => {
      this.subscriptionRefreshTimer = null;
      this.refreshSubscriptions();
    }, 100);
    this.subscriptionRefreshTimer.unref();
  }

  private resolveRequest(id: string, result: unknown): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    clearTimeout(pending.timer);
    this.responses += 1;
    this.connected = true;
    pending.resolve(result);
  }

  private rejectRequest(id: string, code: string, message: string, transportReachable = false, details?: Readonly<Record<string, unknown>>): void {
    const pending = this.pendingRequests.get(id);
    if (!pending) return;
    this.pendingRequests.delete(id);
    clearTimeout(pending.timer);
    this.requestFailures += 1;
    this.connected = transportReachable;
    if (!transportReachable) this.transportFailures += 1;
    pending.reject(new HerdrSocketRequestError(code, pending.written, message, details));
  }

  private rejectPending(code: string): void {
    for (const [id, pending] of this.pendingRequests) {
      this.pendingRequests.delete(id);
      clearTimeout(pending.timer);
      this.requestFailures += 1;
      this.transportFailures += 1;
      pending.reject(new HerdrSocketRequestError(code, true));
    }
  }

  private resolvePaneWaiter(paneId: string, waiter: PaneWaiter, changed: boolean): void {
    const waiters = this.paneWaiters.get(paneId);
    if (!waiters?.delete(waiter)) return;
    clearTimeout(waiter.timer);
    if (waiters.size === 0) this.paneWaiters.delete(paneId);
    waiter.resolve(changed);
  }

  private resolvePaneWaiters(paneId: string, changed: boolean): void {
    for (const waiter of [...(this.paneWaiters.get(paneId) ?? [])]) this.resolvePaneWaiter(paneId, waiter, changed);
  }

  private resolveAllPaneWaiters(changed: boolean): void {
    for (const paneId of [...this.paneWaiters.keys()]) this.resolvePaneWaiters(paneId, changed);
  }

  private failed(error: unknown): void {
    this.logConnectionFailure(error, "herdr-socket-connect-failed", "could not prepare Herdr native event subscription");
    this.scheduleReconnect();
  }

  private logConnectionFailure(error: unknown, event: string, message: string): void {
    const safe = safeLogError(error);
    const decision = this.failureLogs.fail("event-stream", safe.message);
    if (decision.kind === "suppressed") return;
    this.logger.warn({ event: decision.kind === "summary" ? "herdr-socket-failure-summary" : event, err: safe, repeatCount: decision.count, firstFailureAt: decision.firstFailureAt, outcome: "reconnecting" }, message);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer) return;
    const delay = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * 2 ** Math.min(this.attempt++, 6));
    this.reconnectTimer = setTimeout(() => { this.reconnectTimer = null; void this.connect(); }, delay);
    this.reconnectTimer.unref();
  }

}
