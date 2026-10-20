import type { CoreEventInboxStore, CoreEventIngestResult } from "../../domain/core-event-inbox.js";
import type { AgentEvent, CoreEventBatch } from "../../domain/herdr-events.js";
import type { AgentTranscriptCursorPort, AgentTranscriptObservation } from "../../domain/ports/external.js";
import { HerdrEventProjector, type EventProjectorSnapshot } from "./event-projector.js";
import { fromCoreEventEnvelope } from "./identity.js";
import { CoreEventIngress } from "./core-event-ingress.js";

export interface HerdrEventInbox {
  store: CoreEventInboxStore;
  laneId: string;
  sourceId?: string;
  agentKind: "traex" | "pi";
  sessionId: string;
  owner: { kind: "binding" | "worker_turn"; id: string };
}

export class HerdrEventCursor implements AgentTranscriptCursorPort {
  private pending: AgentEvent[];
  private pendingAcknowledgement: string[] = [];
  private pendingProjectionState: EventProjectorSnapshot | undefined;
  private readonly projector: HerdrEventProjector;
  private complete: boolean;
  private ingress: CoreEventIngress | undefined;

  constructor(
    private readonly readBatch: (after: string) => Promise<CoreEventBatch>,
    private after: string,
    initial: AgentEvent[] = [],
    private readonly inbox?: HerdrEventInbox,
    initialComplete = false,
    projectorOptions: ConstructorParameters<typeof HerdrEventProjector>[0] = {}
  ) {
    this.pending = initial;
    this.complete = initialComplete;
    this.projector = new HerdrEventProjector(projectorOptions);
  }

  async readDelta(): Promise<string> { return (await this.readObservation()).answerDelta; }

  async readObservation(): Promise<AgentTranscriptObservation> {
    if (this.pendingAcknowledgement.length > 0) throw new Error("Core event observation must be acknowledged before reading again");
    let events = this.inbox ? this.loadPending() : this.takePending();
    if (events.length === 0 && (!this.complete || Boolean(this.ingress?.pendingBatchCount))) events = await this.readNextBatch();
    if (this.inbox) {
      events = events.slice(0, 1);
    } else {
      const nextTurn = events.findIndex((event, index) => index > 0 && event.payload.type === "turn_started");
      if (nextTurn > 0) {
        this.pending = events.slice(nextTurn);
        events = events.slice(0, nextTurn);
      }
    }
    if (this.inbox) {
      this.pendingAcknowledgement = events.map((event) => event.eventId);
      this.pendingProjectionState = this.projector.snapshot();
    }
    try {
      this.restoreSettledTurnStart(events);
      const observation = this.projector.project(events);
      if (!this.inbox || this.pendingAcknowledgement.length === 0) return observation;
      return {
        ...observation,
        coreEventSettlement: {
          laneId: this.inbox.laneId,
          eventIds: [...this.pendingAcknowledgement],
          occurredAt: new Date().toISOString(),
          owner: this.inbox.owner
        }
      };
    } catch (error) {
      if (!this.inbox || this.pendingAcknowledgement.length === 0) throw error;
      this.restorePendingProjectionState();
      this.inbox.store.acknowledge(
        this.inbox.laneId,
        this.pendingAcknowledgement,
        "quarantined",
        new Date().toISOString(),
        error instanceof Error ? error.message : String(error),
        this.inbox.owner
      );
      this.pendingAcknowledgement = [];
      this.pendingProjectionState = undefined;
      return { answerDelta: "" };
    }
  }

  async acknowledge(outcome: "projected" | "ignored" | "quarantined", error?: string): Promise<void> {
    if (!this.inbox || this.pendingAcknowledgement.length === 0) return;
    const result = this.inbox.store.acknowledge(
      this.inbox.laneId,
      this.pendingAcknowledgement,
      outcome,
      new Date().toISOString(),
      error,
      this.inbox.owner
    );
    // Another lifecycle subscriber may fail after the transactional view
    // projector has already committed this frame. In that case a later
    // quarantine request is a no-op and must not roll back reducer memory.
    if (outcome === "quarantined" && result !== "settled") this.restorePendingProjectionState();
    this.pendingAcknowledgement = [];
    this.pendingProjectionState = undefined;
  }

  private restorePendingProjectionState(): void {
    if (this.pendingProjectionState) this.projector.restore(this.pendingProjectionState);
  }

  private restoreSettledTurnStart(events: AgentEvent[]): void {
    if (!this.inbox || events.length !== 1) return;
    const event = events[0]!;
    if (!event.turnId || event.payload.type === "turn_started") return;
    const state = this.projector.snapshot();
    if (state.turnId === event.turnId && state.startedAt) return;
    const start = this.inbox.store.loadSettledTurnStart({
      laneId: this.inbox.laneId,
      agentKind: this.inbox.agentKind,
      sessionId: this.inbox.sessionId,
      turnId: event.turnId
    });
    if (start) this.projector.project([fromCoreEventEnvelope(start)]);
  }

  private takePending(): AgentEvent[] {
    const events = this.pending;
    this.pending = [];
    return events;
  }

  private loadPending(): AgentEvent[] {
    if (!this.inbox) return [];
    return this.inbox.store.loadPending(this.inbox.laneId, 1).events.map((event) => {
      if (event.agentKind !== this.inbox!.agentKind || event.sessionId !== this.inbox!.sessionId) {
        throw new Error("Core event inbox identity mismatch");
      }
      return fromCoreEventEnvelope(event);
    });
  }

  private async readNextBatch(): Promise<AgentEvent[]> {
    for (let attempt = 0; attempt < 2; attempt += 1) {
      if (this.ingress?.pendingBatchCount) {
        const ingestResult = this.ingress.drainOne();
        this.after = this.inbox!.store.getCheckpoint(this.inbox!.laneId)?.readCursor ?? this.after;
        const pending = this.loadPending();
        if (ingestResult !== "stale_rebase" || pending.length > 0) return pending;
      }
      const batch = await this.readBatch(this.after);
      this.complete = batch.complete === true;
      if (!this.inbox) {
        this.after = batch.nextCursor;
        return batch.events;
      }
      const sourceId = this.inbox.sourceId ?? batch.events[0]?.sourceId;
      if (batch.events.length > 0 && !sourceId) throw new Error("Core event batch source identity missing");
      let ingestResult: CoreEventIngestResult = "accepted";
      if (sourceId) {
        this.ingress ??= new CoreEventIngress({
          streamId: sourceId, laneId: this.inbox.laneId, sourceId,
          agentKind: this.inbox.agentKind, sessionId: this.inbox.sessionId, store: this.inbox.store
        });
        if (this.ingress.enqueue({ streamId: sourceId, afterCursor: this.after, ...batch }) === "full") {
          throw new Error("Core event ingress is full");
        }
        ingestResult = this.ingress.drainOne()!;
        this.inbox.sourceId = sourceId;
      }
      this.after = this.inbox.store.getCheckpoint(this.inbox.laneId)?.readCursor ?? batch.nextCursor;
      const pending = this.loadPending();
      if (ingestResult !== "stale_rebase" || pending.length > 0) return pending;
      // A stale reader may have observed an overlapping batch with an unseen
      // tail. Opaque Core cursors do not prove where that tail belongs, so the
      // store rejects it and we reread once from the durable lane checkpoint.
      this.complete = false;
    }
    return this.loadPending();
  }
}
