import { createConnection, type Socket } from "node:net";
import type { Logger } from "pino";
import type {
  CoreSessionEventMultiplexAck,
  CoreSessionEventMultiplexFrame,
  CoreSessionEventMultiplexTarget
} from "../domain/herdr-events.js";

const DEFAULT_RECONNECT_BASE_MS = 250;
const DEFAULT_RECONNECT_MAX_MS = 10_000;
const DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS = 5_000;
const DEFAULT_MAX_FRAME_BYTES = 2 * 1024 * 1024;

interface HerdrSessionEventSubscriberOptions {
  socketPath: string;
  supportsMultiplex(): Promise<boolean>;
  onFrame(frame: CoreSessionEventMultiplexFrame, generation: number): void;
  onActivated?(targets: readonly CoreSessionEventMultiplexTarget[], generation: number): void;
  onTransportState?(state: "connected" | "disconnected", generation: number): void | Promise<void>;
  refreshTargets?(): Promise<readonly CoreSessionEventMultiplexTarget[]>;
  normalizeAck(value: unknown): CoreSessionEventMultiplexAck;
  normalizeFrame(value: unknown): CoreSessionEventMultiplexFrame;
  logger: Pick<Logger, "debug" | "warn">;
  reconnectBaseMs?: number;
  reconnectMaxMs?: number;
  acknowledgementTimeoutMs?: number;
  maxFrameBytes?: number;
  reconnectJitterRatio?: number;
  healthyDwellMs?: number;
  random?: () => number;
}

export interface HerdrSessionEventSubscriberStatus {
  connected: boolean;
  generation: number;
  activeTargetCount: number;
}

type FeedPhase = "subscribe" | "active" | "closed";

interface Feed {
  socket: Socket;
  targets: readonly CoreSessionEventMultiplexTarget[];
  phase: FeedPhase;
  buffer: string;
  generation: number;
  subscribeRequestId: string;
  acknowledgementTimer: NodeJS.Timeout;
  intentionalClose: boolean;
  settled: boolean;
  resolve(): void;
  reject(error: Error): void;
}

export class HerdrSessionEventSubscriber {
  private readonly reconnectBaseMs: number;
  private readonly reconnectMaxMs: number;
  private readonly acknowledgementTimeoutMs: number;
  private readonly maxFrameBytes: number;
  private readonly reconnectJitterRatio: number;
  private readonly healthyDwellMs: number;
  private readonly random: () => number;
  private started = false;
  private stopped = false;
  private active: Feed | null = null;
  private candidate: Feed | null = null;
  private reconnectTimer: NodeJS.Timeout | null = null;
  private reconnectAttempt = 0;
  private stableSinceMs: number | null = null;
  private desiredTargets: readonly CoreSessionEventMultiplexTarget[] | null = null;
  private generation = 0;
  private nextRequestId = 1;
  private replacementTail: Promise<void> = Promise.resolve();

  constructor(private readonly options: HerdrSessionEventSubscriberOptions) {
    this.reconnectBaseMs = positiveMilliseconds(options.reconnectBaseMs, DEFAULT_RECONNECT_BASE_MS, "reconnectBaseMs");
    this.reconnectMaxMs = positiveMilliseconds(options.reconnectMaxMs, DEFAULT_RECONNECT_MAX_MS, "reconnectMaxMs");
    this.acknowledgementTimeoutMs = positiveMilliseconds(options.acknowledgementTimeoutMs, DEFAULT_ACKNOWLEDGEMENT_TIMEOUT_MS, "acknowledgementTimeoutMs");
    this.maxFrameBytes = positiveInteger(options.maxFrameBytes, DEFAULT_MAX_FRAME_BYTES, "maxFrameBytes");
    this.reconnectJitterRatio = Math.min(1, Math.max(0, options.reconnectJitterRatio ?? 0.2));
    this.healthyDwellMs = Math.max(0, options.healthyDwellMs ?? 1_000);
    this.random = options.random ?? Math.random;
    if (this.reconnectMaxMs < this.reconnectBaseMs) throw new Error("reconnectMaxMs must be at least reconnectBaseMs");
  }

  start(): void {
    if (this.stopped) throw new Error("Herdr session event subscriber is stopped");
    this.started = true;
  }

  replaceTargets(targets: readonly CoreSessionEventMultiplexTarget[]): Promise<void> {
    let replacement: readonly CoreSessionEventMultiplexTarget[];
    try { replacement = validateTargets(targets); }
    catch (error) { return Promise.reject(error); }

    const operation = this.replacementTail.then(async () => {
      if (!this.started) throw new Error("Herdr session event subscriber is not started");
      if (this.stopped) throw new Error("Herdr session event subscriber is stopped");
      this.cancelReconnect();
      this.reconnectAttempt = 0;
      this.stableSinceMs = null;
      this.closeCandidate(new Error("Herdr session event subscription was superseded"));
      this.desiredTargets = replacement;
      await this.establish(replacement);
    });
    this.replacementTail = operation.catch(() => undefined);
    return operation;
  }

  clearTargets(): Promise<void> {
    const operation = this.replacementTail.then(() => {
      if (!this.started) throw new Error("Herdr session event subscriber is not started");
      if (this.stopped) throw new Error("Herdr session event subscriber is stopped");
      this.cancelReconnect();
      this.desiredTargets = null;
      this.closeCandidate(new Error("Herdr session event subscription was cleared"));
      const active = this.active;
      this.active = null;
      if (active) this.closeFeed(active);
    });
    this.replacementTail = operation.catch(() => undefined);
    return operation;
  }

  status(): HerdrSessionEventSubscriberStatus {
    return {
      connected: this.active !== null && this.active.phase === "active" && !this.active.socket.destroyed,
      generation: this.generation,
      activeTargetCount: this.active?.targets.length ?? 0
    };
  }

  async stop(): Promise<void> {
    if (this.stopped) return;
    this.stopped = true;
    this.cancelReconnect();
    this.closeCandidate(new Error("Herdr session event subscriber stopped"));
    const active = this.active;
    this.active = null;
    this.desiredTargets = null;
    if (active) this.closeFeed(active);
  }

  private async establish(targets: readonly CoreSessionEventMultiplexTarget[]): Promise<void> {
    if (this.stopped) throw new Error("Herdr session event subscriber is stopped");
    let supported: boolean;
    try { supported = await this.options.supportsMultiplex(); }
    catch (error) {
      this.scheduleReconnect();
      throw asError(error, "Herdr session event multiplex capability probe failed");
    }
    if (!supported) {
      this.scheduleReconnect();
      throw new Error("Herdr session event multiplex capability is unavailable");
    }
    if (this.stopped) throw new Error("Herdr session event subscriber is stopped");
    await new Promise<void>((resolve, reject) => {
      const requestPrefix = `herdr-agent-swarm:session-events:${this.nextRequestId++}`;
      const socket = createConnection({ path: this.options.socketPath });
      socket.setEncoding("utf8");
      const feed: Feed = {
        socket,
        targets,
        phase: "subscribe",
        buffer: "",
        generation: 0,
        subscribeRequestId: `${requestPrefix}:subscribe`,
        acknowledgementTimer: setTimeout(() => this.failFeed(feed, new Error("Herdr session event subscription acknowledgement timed out")), this.acknowledgementTimeoutMs),
        intentionalClose: false,
        settled: false,
        resolve,
        reject
      };
      feed.acknowledgementTimer.unref();
      this.candidate = feed;

      socket.once("connect", () => {
        if (feed.phase !== "subscribe" || this.candidate !== feed || this.stopped) return;
        socket.write(`${JSON.stringify({
          id: feed.subscribeRequestId,
          method: "session.events.subscribe.v3",
          params: { targets: feed.targets.map(target => ({
            ring_id: target.ringId,
            epoch: target.epoch,
            after: target.after,
            limit: target.limit
          })) }
        })}\n`);
      });
      socket.on("data", (chunk: string) => this.receive(feed, chunk));
      socket.once("error", (error) => this.failFeed(feed, asError(error, "Herdr session event socket failed")));
      socket.once("close", () => this.feedClosed(feed));
    });
  }

  private receive(feed: Feed, chunk: string): void {
    if (feed.phase === "closed" || this.stopped) return;
    feed.buffer += chunk;
    while (true) {
      const newline = feed.buffer.indexOf("\n");
      if (newline < 0) {
        if (Buffer.byteLength(feed.buffer) > this.maxFrameBytes) {
          this.failFeed(feed, new Error("Herdr session event frame exceeded the byte limit"));
        }
        return;
      }
      const line = feed.buffer.slice(0, newline);
      feed.buffer = feed.buffer.slice(newline + 1);
      if (Buffer.byteLength(line) > this.maxFrameBytes) {
        this.failFeed(feed, new Error("Herdr session event frame exceeded the byte limit"));
        return;
      }
      if (line.length === 0) continue;
      let value: unknown;
      try { value = JSON.parse(line) as unknown; }
      catch {
        this.failFeed(feed, new Error("Herdr session event frame was malformed"));
        return;
      }
      const phase = feed.phase;
      if (!this.handleValue(feed, value)) return;
      if (phase === "subscribe" && feed.phase === "active" && feed.buffer.length > 0 && !this.options.onActivated) {
        setImmediate(() => this.receive(feed, ""));
        return;
      }
    }
  }

  private handleValue(feed: Feed, value: unknown): boolean {
    try {
      if (feed.phase === "subscribe") {
        const acknowledgement = this.options.normalizeAck(rpcResult(value, feed.subscribeRequestId));
        if (acknowledgement.targetCount !== feed.targets.length) throw new Error("Herdr session event acknowledgement target count did not match");
        this.activate(feed);
        return true;
      }
      if (feed.phase === "active") {
        const frame = this.options.normalizeFrame(value);
        if (feed !== this.active || feed.generation !== this.generation) return true;
        if (this.stableSinceMs !== null && Date.now() - this.stableSinceMs >= this.healthyDwellMs) {
          this.reconnectAttempt = 0;
          this.stableSinceMs = null;
        }
        try { this.options.onFrame(frame, feed.generation); }
        catch (error) { this.options.logger.warn({ error: asError(error, "frame callback failed") }, "Herdr session event frame callback failed"); }
        return true;
      }
      return false;
    } catch (error) {
      this.failFeed(feed, asError(error, "Invalid Herdr session event frame"));
      return false;
    }
  }

  private activate(feed: Feed): void {
    if (this.candidate !== feed || this.stopped) {
      this.failFeed(feed, new Error("Herdr session event subscription is stale"));
      return;
    }
    clearTimeout(feed.acknowledgementTimer);
    const previous = this.active;
    this.generation += 1;
    feed.generation = this.generation;
    feed.phase = "active";
    this.active = feed;
    this.candidate = null;
    this.desiredTargets = feed.targets;
    this.stableSinceMs = Date.now();
    this.options.onActivated?.(feed.targets, feed.generation);
    void this.options.onTransportState?.("connected", feed.generation);
    this.settleFeed(feed);
    if (previous && previous !== feed) this.closeFeed(previous);
  }

  private feedClosed(feed: Feed): void {
    if (feed.phase === "closed" && feed.intentionalClose) return;
    const wasActive = this.active === feed;
    const wasCandidate = this.candidate === feed;
    feed.phase = "closed";
    clearTimeout(feed.acknowledgementTimer);
    if (wasCandidate) {
      this.candidate = null;
      if (!feed.settled) {
        feed.settled = true;
        feed.reject(new Error("Herdr session event socket closed before acknowledgement"));
      }
      if (!this.stopped && !feed.intentionalClose) this.scheduleReconnect();
    }
    if (wasActive) {
      this.active = null;
      void this.options.onTransportState?.("disconnected", feed.generation);
      if (!this.stopped && !feed.intentionalClose) this.scheduleReconnect();
    }
  }

  private failFeed(feed: Feed, error: Error): void {
    if (feed.phase === "closed") return;
    const wasActive = this.active === feed;
    const wasCandidate = this.candidate === feed;
    feed.phase = "closed";
    clearTimeout(feed.acknowledgementTimer);
    if (wasCandidate) this.candidate = null;
    if (wasActive) {
      this.active = null;
      void this.options.onTransportState?.("disconnected", feed.generation);
    }
    if (!feed.settled) {
      feed.settled = true;
      feed.reject(error);
    }
    feed.socket.destroy();
    if ((wasActive || wasCandidate) && !this.stopped && !feed.intentionalClose) this.scheduleReconnect();
  }

  private settleFeed(feed: Feed): void {
    if (feed.settled) return;
    feed.settled = true;
    feed.resolve();
  }

  private closeFeed(feed: Feed): void {
    if (feed.phase === "closed") return;
    feed.intentionalClose = true;
    feed.phase = "closed";
    clearTimeout(feed.acknowledgementTimer);
    feed.socket.destroy();
  }

  private closeCandidate(error: Error): void {
    const candidate = this.candidate;
    if (!candidate) return;
    this.candidate = null;
    if (!candidate.settled) {
      candidate.settled = true;
      candidate.reject(error);
    }
    this.closeFeed(candidate);
  }

  private scheduleReconnect(): void {
    if (this.stopped || this.reconnectTimer || !this.desiredTargets) return;
    const exponential = Math.min(this.reconnectMaxMs, this.reconnectBaseMs * (2 ** Math.min(this.reconnectAttempt, 30)));
    const jitter = 1 + ((this.random() * 2) - 1) * this.reconnectJitterRatio;
    const delay = Math.max(1, Math.min(this.reconnectMaxMs, Math.round(exponential * jitter)));
    this.reconnectAttempt += 1;
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      const desiredTargets = this.desiredTargets;
      if (!desiredTargets || this.stopped || this.candidate || sameTargets(this.active?.targets, desiredTargets)) return;
      void this.refreshTargets(desiredTargets).then((targets) => this.establish(targets)).catch((error: unknown) => {
        if (!this.stopped) {
          this.options.logger.debug({ error: asError(error, "reconnect failed"), delay }, "Herdr session event reconnect failed");
          this.scheduleReconnect();
        }
      });
    }, delay);
    this.reconnectTimer.unref();
  }

  private async refreshTargets(fallback: readonly CoreSessionEventMultiplexTarget[]): Promise<readonly CoreSessionEventMultiplexTarget[]> {
    return validateTargets(await (this.options.refreshTargets?.() ?? Promise.resolve(fallback)));
  }

  private cancelReconnect(): void {
    if (this.reconnectTimer) clearTimeout(this.reconnectTimer);
    this.reconnectTimer = null;
  }
}

function sameTargets(left: readonly CoreSessionEventMultiplexTarget[] | undefined, right: readonly CoreSessionEventMultiplexTarget[]): boolean {
  return !!left && left.length === right.length && left.every((target, index) => {
    const candidate = right[index];
    return !!candidate && target.ringId === candidate.ringId && target.epoch === candidate.epoch
      && target.after === candidate.after && target.limit === candidate.limit;
  });
}

function validateTargets(targets: readonly CoreSessionEventMultiplexTarget[]): readonly CoreSessionEventMultiplexTarget[] {
  if (!Array.isArray(targets) || targets.length < 1 || targets.length > 128) throw new Error("Herdr session event targets must contain 1..128 entries");
  const rings = new Set<string>();
  return targets.map((target) => {
    if (!target || typeof target.ringId !== "string" || target.ringId.length === 0 || typeof target.epoch !== "string" || target.epoch.length === 0 || typeof target.after !== "string" || target.after.length === 0) {
      throw new Error("Herdr session event target identity and cursor must be non-empty strings");
    }
    if (rings.has(target.ringId)) throw new Error(`Duplicate Herdr session event ring: ${target.ringId}`);
    rings.add(target.ringId);
    if (!Number.isInteger(target.limit) || target.limit < 1 || target.limit > 128) throw new Error("Herdr session event target limit must be an integer from 1..128");
    return { ringId: target.ringId, epoch: target.epoch, after: target.after, limit: target.limit };
  });
}

function rpcResult(value: unknown, expectedId: string): unknown {
  if (!value || typeof value !== "object" || Array.isArray(value)) throw new Error("Invalid Herdr RPC response");
  const response = value as Record<string, unknown>;
  if (response.id !== expectedId || !Object.hasOwn(response, "result")) throw new Error("Unexpected Herdr RPC response");
  return response.result;
}

function positiveMilliseconds(value: number | undefined, fallback: number, name: string): number {
  return positiveInteger(value, fallback, name);
}

function positiveInteger(value: number | undefined, fallback: number, name: string): number {
  const resolved = value ?? fallback;
  if (!Number.isInteger(resolved) || resolved < 1) throw new Error(`${name} must be a positive integer`);
  return resolved;
}

function asError(error: unknown, fallback: string): Error {
  return error instanceof Error ? error : new Error(fallback);
}
