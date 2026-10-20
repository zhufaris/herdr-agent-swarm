import type {
  CoreEventInboxStore,
  CoreEventIngestResult
} from "../../domain/core-event-inbox.js";
import type { CoreEventBatch } from "../../domain/herdr-events.js";
import { toCoreEventEnvelope } from "./identity.js";

export const CORE_EVENT_INGRESS_CAPACITY = 512;

export interface CoreEventIngressIdentity {
  streamId: string;
  laneId: string;
  sourceId: string;
  agentKind: "traex" | "pi";
  sessionId: string;
  store: CoreEventInboxStore;
}

export interface CoreEventIngressBatch extends CoreEventBatch {
  streamId: string;
  afterCursor: string;
}

interface QueuedBatch {
  batch: CoreEventIngressBatch;
  capacityCost: number;
}

/**
 * Process-local backpressure between one Core stream epoch and the durable
 * inbox. It never owns a cursor: only the inbox transaction can advance the
 * checkpoint returned by resumeCursor.
 */
export class CoreEventIngress {
  private readonly queue: QueuedBatch[] = [];
  private occupied = 0;

  constructor(
    private readonly identity: CoreEventIngressIdentity,
    private readonly capacity = CORE_EVENT_INGRESS_CAPACITY
  ) {
    if (!identity.streamId || !identity.laneId || !identity.sourceId || capacity < 1) throw new Error("Invalid Core event ingress configuration");
  }

  get pendingEventCount(): number {
    return this.queue.reduce((total, item) => total + item.batch.events.length, 0);
  }

  get pendingBatchCount(): number { return this.queue.length; }

  get resumeCursor(): string {
    return this.identity.store.getCheckpoint(this.identity.laneId)?.readCursor ?? "start";
  }

  enqueue(batch: CoreEventIngressBatch): "accepted" | "full" {
    if (batch.streamId !== this.identity.streamId) throw new Error("Core event ingress stream epoch mismatch");
    const tail = this.queue.at(-1)?.batch;
    if (tail && batch.afterCursor !== tail.nextCursor) throw new Error("Core event ingress batch order mismatch");
    if (batch.events.some((event) => event.sourceId !== this.identity.sourceId
      || event.agentKind !== this.identity.agentKind
      || event.sessionId !== this.identity.sessionId)) throw new Error("Core event ingress identity mismatch");
    const capacityCost = Math.max(1, batch.events.length);
    if (capacityCost > this.capacity - this.occupied) return "full";
    this.queue.push({ batch, capacityCost });
    this.occupied += capacityCost;
    return "accepted";
  }

  drainOne(): CoreEventIngestResult | null {
    const queued = this.queue[0];
    if (!queued) return null;
    const result = this.identity.store.ingestBatch({
      laneId: this.identity.laneId,
      sourceId: this.identity.sourceId,
      agentKind: this.identity.agentKind,
      sessionId: this.identity.sessionId,
      afterCursor: queued.batch.afterCursor,
      nextCursor: queued.batch.nextCursor,
      latestCursor: queued.batch.latestCursor,
      events: queued.batch.events.map(toCoreEventEnvelope),
      ingestedAt: new Date().toISOString()
    });
    this.queue.shift();
    this.occupied -= queued.capacityCost;
    return result;
  }

  drainAll(): CoreEventIngestResult[] {
    const results: CoreEventIngestResult[] = [];
    while (this.queue.length > 0) results.push(this.drainOne()!);
    return results;
  }
}
