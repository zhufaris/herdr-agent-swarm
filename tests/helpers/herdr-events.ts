import type {
  CoreEventEnvelope,
  CoreEventInboxBatch,
  CoreEventInboxCheckpoint,
  CoreEventInboxStore,
  CoreEventIngestResult
} from "../../src/domain/core-event-inbox.js";

export function coreEventResponse(result: object) {
  return { stdout: JSON.stringify({ id: "test", result }), stderr: "" };
}

export function agentEvent(cursor: string, turnId: string, occurredAt: string, payload: object) {
  return {
    schema_version: 1 as const,
    event_id: cursor,
    cursor,
    source_id: "source-1",
    agent_kind: "traex" as const,
    session_id: "session-1",
    turn_id: turnId,
    occurred_at: occurredAt,
    payload
  };
}

export function attachedSource(sourceId: string, state: string, latestCursor: string) {
  return {
    source_id: sourceId,
    terminal_id: "terminal-1",
    agent_kind: "traex",
    session_id: "session-1",
    state,
    checkpoint_offset: 10,
    latest_cursor: latestCursor
  };
}

export class MemoryCoreEventInbox implements CoreEventInboxStore {
  readonly pending = new Map<string, CoreEventEnvelope[]>();
  readonly checkpoints = new Map<string, CoreEventInboxCheckpoint>();
  readonly projectionAttempts = new Map<string, number>();

  ingestBatch(batch: CoreEventInboxBatch): CoreEventIngestResult {
    const events = this.pending.get(batch.laneId) ?? [];
    const known = new Set(events.map((item) => item.eventId));
    events.push(...batch.events.filter((item) => !known.has(item.eventId)));
    this.pending.set(batch.laneId, events);
    this.checkpoints.set(batch.laneId, {
      sourceId: batch.sourceId,
      agentKind: batch.agentKind,
      sessionId: batch.sessionId,
      readCursor: batch.nextCursor,
      latestCursor: batch.latestCursor
    });
    return "accepted";
  }

  loadPending(laneId: string, limit = 128) {
    const events = (this.pending.get(laneId) ?? []).slice(0, limit);
    return { events, eventIds: events.map((item) => item.eventId) };
  }

  loadSettledTurnStart() { return null; }
  loadProjectedTurnViewEvents() { return []; }

  getCheckpoint(laneId: string) { return this.checkpoints.get(laneId) ?? null; }
  countOpenProjectionGaps() { return 0; }

  acknowledge(laneId: string, eventIds: readonly string[], outcome: "projected" | "ignored" | "quarantined"): void {
    const acknowledged = new Set(eventIds);
    if (outcome === "quarantined") {
      for (const eventId of acknowledged) {
        const attempts = (this.projectionAttempts.get(eventId) ?? 0) + 1;
        this.projectionAttempts.set(eventId, attempts);
        if (attempts < 3) acknowledged.delete(eventId);
      }
    }
    this.pending.set(laneId, (this.pending.get(laneId) ?? []).filter((item) => !acknowledged.has(item.eventId)));
  }
}
