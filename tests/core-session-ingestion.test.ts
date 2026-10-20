import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { CoreSessionUnrecoverableCursorError, type CoreSessionEventMultiplexBatch, type CoreSessionEventMultiplexGap, type CoreSessionEventMultiplexTarget, type HerdrEventsPort } from "../src/domain/herdr-events.js";
import { liveCoreSessionLaneId } from "../src/runtime/herdr-events/identity.js";
import { HerdrEventsReader } from "../src/runtime/herdr-events-reader.js";
import { CoreSessionIngestionSupervisor, resolvePrimarySessionIngestionSource, resolveWorkerSessionIngestionSource } from "../src/coordinator/core-session-ingestion-supervisor.js";
import type { Binding } from "../src/domain/types.js";
import type { AgentInstance } from "../src/domain/agent-instance.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";

function epochTransitionSource(bindingId = "binding-1") {
  return {
    agentKind: "traex" as const, bindingId, generation: 1, paneId: "wN:p6G", terminalId: "term-1",
    nativeSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" },
    coreEventOwner: { kind: "binding" as const, id: bindingId }
  };
}

function seedEpochCheckpoint(stores: ReturnType<typeof createTestStoreBundle>, source: ReturnType<typeof epochTransitionSource>, epoch = "epoch-3", cursor = "ring-1:epoch-3:164") {
  const laneId = liveCoreSessionLaneId(source);
  stores.coreEvents.ingestBatch({
    laneId, sourceId: "ring-1", sourceEpoch: epoch, agentKind: "traex", sessionId: "session-1",
    afterCursor: "start", nextCursor: cursor, latestCursor: cursor, events: [],
    ingestedAt: "2026-10-07T09:32:21.954Z"
  });
  return laneId;
}

describe("Core session ingestion", () => {
  it("ingests an idle Primary Human Message and creates its canonical Working Turn Card", async () => {
    const stores = createTestStoreBundle();
    activatePrimary(stores);
    stores.agentInputs.admit({
      submissionId: "submission-1", ingressSource: "feishu:primary", sourceMessageKey: "message-1",
      actor: { kind: "human", id: "user-1", gatewayId: "feishu:primary", chatId: "chat-1", topicId: "topic-1", rootMessageId: "root-1" },
      text: "continue", owner: { kind: "primary", id: "binding-1", generation: 1 },
      paneId: "w1:p1", terminalId: "terminal-1", expectedAgentKind: "traex", expectedSessionId: "session-1",
      recordedAt: "2026-10-04T12:00:00.000Z"
    });
    const readSession = vi.fn(async (_streamId: string, after: string) => ({ outcome: "batch" as const, batch: {
      streamId: "stream-1", earliestCursor: "cursor-0", nextCursor: "cursor-1", latestCursor: "cursor-1", complete: true,
      events: [{
        schemaVersion: 1 as const, eventId: "human-1", cursor: "cursor-1", sourceId: "stream-1",
        agentKind: "traex" as const, sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-04T12:00:01.000Z",
        payload: { type: "human_message" as const, messageId: "message-1", text: "continue", truncated: false, submissionId: "submission-1" }
      }]
    } }));
    const events = {
      async supportsSessionEventStream() { return true; },
      async openSession() { return { streamId: "stream-1", terminalId: "terminal-1", agentKind: "traex" as const, sessionId: "session-1", earliestCursor: "cursor-0", latestCursor: "cursor-1" }; },
      readSession
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);
    const source = {
      agentKind: "traex" as const, bindingId: "binding-1", generation: 1, paneId: "w1:p1",
      nativeSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }
    };

    await expect(reader.ingestCurrentSession(source)).resolves.toMatchObject({ ingestedEvents: 1, caughtUp: true });
    expect(readSession).toHaveBeenCalledWith("stream-1", "start");
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM input_card_views").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT state,human_event_id,start_lane_sequence FROM conversation_segments WHERE submission_id=?").get("submission-1"))
      .toEqual({ state: "working", human_event_id: "human-1", start_lane_sequence: 1 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key='turn-card:segment:submission-1:page:0'").get()).toEqual({ count: 1 });
    expect(stores.coreEvents.getCheckpoint(liveCoreSessionLaneId(source, "stream-1"))).toMatchObject({ readCursor: "cursor-1" });
    const opened = await reader.openActiveTurn(source);
    expect(opened.mode).toBe("typed");
    if (opened.mode !== "typed") throw new Error("expected typed session inbox cursor");
    await expect(opened.cursor.readObservation()).resolves.toMatchObject({ requestSubmissionId: "submission-1" });
    expect(readSession).toHaveBeenCalledTimes(1);
  });

  it("preserves the deployed active-lane digest", () => {
    expect(liveCoreSessionLaneId({
      agentKind: "traex", bindingId: "binding-1", generation: 1, paneId: "w1:p1",
      nativeSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }
    }, "stream-1")).toBe("core-events:efbe3539f2af03f9c5390c415d4685687bd79b12fdfcd6335eed92672270c27e");
  });

  it("uses one stable session lane when the Core transport source and terminal change", () => {
    const first = {
      agentKind: "traex" as const, bindingId: "binding-1", generation: 1, paneId: "w1:p1", terminalId: "terminal-1",
      nativeSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }
    };
    const rebound = { ...first, paneId: "w1:p2", terminalId: "terminal-2" };
    expect(liveCoreSessionLaneId(first)).toBe(liveCoreSessionLaneId(rebound));
    expect(liveCoreSessionLaneId(first)).not.toBe(liveCoreSessionLaneId(first, "source-1"));
  });

  it("ingests a v2 ring through one lane across a terminal/source rebind", async () => {
    const stores = createTestStoreBundle();
    let terminalId = "terminal-1";
    const readSessionRing = vi.fn(async (_ringId: string, after: string) => ({ outcome: "batch" as const, batch: {
      ringId: "ring-1", epoch: "epoch-1", earliestCursor: "ring-1:epoch-1:1",
      nextCursor: after === "start" ? "ring-1:epoch-1:1" : after,
      latestCursor: "ring-1:epoch-1:1",
      events: after === "start" ? [{
        schemaVersion: 1 as const, eventId: "event-1", cursor: "ring-1:epoch-1:1", sourceId: "transport-source-1",
        agentKind: "traex" as const, sessionId: "session-1", turnId: null, occurredAt: "2026-10-05T00:00:00Z",
        payload: { type: "runtime_status_changed" as const, paneId: "w1:p1", status: "working" }
      }] : []
    } }));
    const events = {
      async supportsSessionEventRingV2() { return true; },
      async supportsSessionEventStream() { return true; },
      async openSessionRing() { return { ringId: "ring-1", epoch: "epoch-1", terminalId, agentKind: "traex" as const, sessionId: "session-1", earliestCursor: "start", latestCursor: "latest" }; },
      readSessionRing
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);
    const source = (paneId: string, terminal: string) => ({
      agentKind: "traex" as const, bindingId: "binding-1", generation: 1, paneId, terminalId: terminal,
      nativeSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }
    });

    const first = source("w1:p1", "terminal-1");
    await reader.ingestCurrentSession(first);
    terminalId = "terminal-2";
    const rebound = source("w1:p2", "terminal-2");
    await reader.ingestCurrentSession(rebound);

    const laneId = liveCoreSessionLaneId(first);
    expect(liveCoreSessionLaneId(rebound)).toBe(laneId);
    expect(stores.coreEvents.getCheckpoint(laneId)).toMatchObject({ sourceId: "ring-1", readCursor: "ring-1:epoch-1:1" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM core_event_lane_items WHERE lane_id=?").get(laneId)).toEqual({ count: 1 });
    expect(readSessionRing.mock.calls.map((call) => call[1])).toEqual(["start", "ring-1:epoch-1:1"]);
  });

  it("derives reconnect targets from a fresh exact ring and the durable cursor", async () => {
    const stores = createTestStoreBundle();
    const source = epochTransitionSource();
    const laneId = seedEpochCheckpoint(stores, source, "epoch-1", "ring-1:epoch-1:9");
    let ringId = "ring-1";
    const openSessionRing = vi.fn(async () => ({
      ringId, epoch: "epoch-1", terminalId: "term-1", agentKind: "traex" as const,
      sessionId: "session-1", earliestCursor: "ring-1:epoch-1:1", latestCursor: "ring-1:epoch-1:10"
    }));
    const events = {
      async supportsSessionEventRingV2() { return true; }, async supportsSessionEventStream() { return true; }, openSessionRing
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.prepareMultiplexTarget(source)).resolves.toEqual({
      ringId: "ring-1", epoch: "epoch-1", after: "ring-1:epoch-1:9", limit: 128
    });
    ringId = "ring-other";
    await expect(reader.prepareMultiplexTarget(source)).rejects.toThrow("Core event inbox identity mismatch");
    expect(stores.coreEvents.getCheckpoint(laneId)).toMatchObject({ readCursor: "ring-1:epoch-1:9" });
    expect(openSessionRing).toHaveBeenCalledTimes(2);
    stores.lifecycle.close();
  });

  it("routes v3 overlap through the v2 lane CAS without appending an unseen stale tail", async () => {
    const stores = createTestStoreBundle();
    const source = epochTransitionSource();
    seedEpochCheckpoint(stores, source, "epoch-1", "ring-1:epoch-1:9");
    const reader = new HerdrEventsReader({} as HerdrEventsPort, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);
    const target = { ringId: "ring-1", epoch: "epoch-1", after: "ring-1:epoch-1:9", limit: 128 };
    const event = {
      schemaVersion: 1 as const, eventId: "multiplex-10", cursor: "ring-1:epoch-1:10", sourceId: "journal-source",
      agentKind: "traex" as const, sessionId: "session-1", turnId: null, occurredAt: "2026-10-17T00:00:00.000Z",
      payload: { type: "runtime_status_changed" as const, paneId: "wN:p6G", status: "working" }
    };
    const batch: CoreSessionEventMultiplexBatch = {
      ringId: "ring-1", epoch: "epoch-1", earliestCursor: event.cursor,
      nextCursor: event.cursor, latestCursor: event.cursor, events: [event]
    };

    expect(reader.ingestMultiplexBatch(source, target, batch)).toMatchObject({ outcome: "accepted", ingestedEvents: 1, readCursor: event.cursor });
    expect(reader.ingestMultiplexBatch(source, target, batch)).toMatchObject({ outcome: "stale_rebase", ingestedEvents: 0, readCursor: event.cursor });
    const unseen = { ...event, eventId: "multiplex-unseen", cursor: "ring-1:epoch-1:11" };
    expect(reader.ingestMultiplexBatch(source, target, { ...batch, events: [event, unseen], nextCursor: unseen.cursor, latestCursor: unseen.cursor }))
      .toMatchObject({ outcome: "stale_rebase", ingestedEvents: 0, readCursor: event.cursor });
    expect(stores.driver.database.prepare("SELECT event_id FROM core_event_inbox WHERE event_id=?").get(unseen.eventId)).toBeUndefined();
    expect(() => reader.ingestMultiplexBatch(source, target, { ...batch, events: [{ ...event, sessionId: "foreign-session" }] }))
      .toThrow("Core session event multiplex batch identity mismatch");
    await expect(new HerdrEventsReader({
      async supportsSessionEventRingV2() { return true; }, async supportsSessionEventStream() { return true; },
      async openSessionRing() { return { ringId: "ring-1", epoch: "epoch-1", terminalId: "term-1", agentKind: "traex" as const,
        sessionId: "session-1", earliestCursor: event.cursor, latestCursor: event.cursor }; }
    } as unknown as HerdrEventsPort, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents).prepareMultiplexTarget(source))
      .resolves.toMatchObject({ after: event.cursor });
    stores.lifecycle.close();
  });

  it("transitions a v2 physical ring only after fresh evidence preserves its session identity", async () => {
    const stores = createTestStoreBundle();
    const source = epochTransitionSource();
    const laneId = seedEpochCheckpoint(stores, source, "epoch-1", "ring-1:epoch-1:3");
    const readSessionRing = vi.fn(async (ringId: string, after: string) => ({ outcome: "batch" as const, batch: {
      ringId, epoch: "epoch-1", earliestCursor: "ring-2:epoch-1:0",
      nextCursor: after === "start" ? "ring-2:epoch-1:0" : after,
      latestCursor: "ring-2:epoch-1:0", events: []
    } }));
    const openSessionRing = vi.fn(async () => ({
      ringId: "ring-2", epoch: "epoch-1", terminalId: "term-1", agentKind: "traex" as const,
      sessionId: "session-1", earliestCursor: "ring-2:epoch-1:0", latestCursor: "ring-2:epoch-1:0"
    }));
    const events = {
      async supportsSessionEventRingV2() { return true; }, async supportsSessionEventStream() { return true; },
      openSessionRing, readSessionRing
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession(source)).resolves.toEqual({ laneId, sourceId: "ring-2", ingestedEvents: 0, caughtUp: true });
    expect(openSessionRing).toHaveBeenCalledTimes(2);
    expect(readSessionRing).toHaveBeenCalledWith("ring-2", "start");
    expect(stores.coreEvents.getCheckpoint(laneId)).toMatchObject({ sourceId: "ring-2", sourceEpoch: "epoch-1", readCursor: "ring-2:epoch-1:0" });
    expect(stores.driver.database.prepare("SELECT failure_code FROM projection_gaps WHERE owner_id='binding-1'").all())
      .toEqual([{ failure_code: "cursor_source_changed" }]);
  });

  it("fails closed when fresh v2 ring evidence changes during a physical source transition", async () => {
    const stores = createTestStoreBundle();
    const source = epochTransitionSource();
    const laneId = seedEpochCheckpoint(stores, source, "epoch-1", "ring-1:epoch-1:3");
    let opens = 0;
    const readSessionRing = vi.fn();
    const events = {
      async supportsSessionEventRingV2() { return true; }, async supportsSessionEventStream() { return true; },
      async openSessionRing() {
        opens += 1;
        return {
          ringId: opens === 1 ? "ring-2" : "ring-other", epoch: "epoch-1", terminalId: "term-1", agentKind: "traex" as const,
          sessionId: "session-1", earliestCursor: "ring-2:epoch-1:0", latestCursor: "ring-2:epoch-1:0"
        };
      }, readSessionRing
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession(source)).rejects.toThrow("session event ring identity changed during source transition");
    expect(readSessionRing).not.toHaveBeenCalled();
    expect(stores.coreEvents.getCheckpoint(laneId)).toMatchObject({ sourceId: "ring-1", readCursor: "ring-1:epoch-1:3" });
  });

  it("rebases the production-shaped durable epoch-3 cursor before reading an empty live epoch-2 ring", async () => {
    const stores = createTestStoreBundle();
    const source = {
      agentKind: "traex" as const, bindingId: "binding-1", generation: 1, paneId: "wN:p6G", terminalId: "term-1",
      nativeSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" },
      coreEventOwner: { kind: "binding" as const, id: "binding-1" }
    };
    const laneId = liveCoreSessionLaneId(source);
    stores.coreEvents.ingestBatch({
      laneId, sourceId: "ring-1", sourceEpoch: "epoch-3", agentKind: "traex", sessionId: "session-1",
      afterCursor: "start", nextCursor: "ring-1:epoch-3:164", latestCursor: "ring-1:epoch-3:164",
      events: [], ingestedAt: "2026-10-07T09:32:21.954Z"
    });
    const readSessionRing = vi.fn(async (_ringId: string, after: string) => {
      if (after !== "start") throw Object.assign(new Error("invalid_cursor"), { code: "invalid_cursor" });
      return { outcome: "batch" as const, batch: {
        ringId: "ring-1", epoch: "epoch-2", earliestCursor: "ring-1:epoch-2:0",
        nextCursor: "ring-1:epoch-2:0", latestCursor: "ring-1:epoch-2:0", events: []
      } };
    });
    const events = {
      async supportsSessionEventRingV2() { return true; },
      async supportsSessionEventStream() { return true; },
      async openSessionRing() { return {
        ringId: "ring-1", epoch: "epoch-2", terminalId: "term-1", agentKind: "traex" as const,
        sessionId: "session-1", earliestCursor: "ring-1:epoch-2:0", latestCursor: "ring-1:epoch-2:0"
      }; },
      readSessionRing
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession(source)).resolves.toEqual({ laneId, sourceId: "ring-1", ingestedEvents: 0, caughtUp: true });
    expect(readSessionRing).toHaveBeenCalledWith("ring-1", "start");
    expect(stores.coreEvents.getCheckpoint(laneId)).toMatchObject({
      sourceId: "ring-1", sourceEpoch: "epoch-2", readCursor: "ring-1:epoch-2:0", latestCursor: "ring-1:epoch-2:0"
    });
    expect(stores.driver.database.prepare("SELECT failure_code FROM projection_gaps WHERE owner_id='binding-1'").all())
      .toEqual([{ failure_code: "cursor_epoch_changed" }]);
  });

  it("bootstraps a new lane when its typed Core start cursor has expired", async () => {
    const stores = createTestStoreBundle();
    const source = epochTransitionSource();
    const laneId = liveCoreSessionLaneId(source);
    const retained = {
      schemaVersion: 1 as const, eventId: "new-lane-retained", cursor: "ring-1:epoch-1:10", sourceId: "transport-source",
      agentKind: "traex" as const, sessionId: "session-1", turnId: null, occurredAt: "2026-10-07T09:33:10.000Z",
      payload: { type: "runtime_status_changed" as const, paneId: "wN:p6G", status: "working" }
    };
    const readSessionRing = vi.fn(async (_ringId: string, after: string) => after === "start"
      ? { outcome: "cursor_expired" as const, resumeCursor: "ring-1:epoch-1:9", earliestCursor: retained.cursor, latestCursor: retained.cursor }
      : { outcome: "batch" as const, batch: {
          ringId: "ring-1", epoch: "epoch-1", earliestCursor: retained.cursor,
          nextCursor: retained.cursor, latestCursor: retained.cursor, events: [retained]
        } });
    const events = {
      async supportsSessionEventRingV2() { return true; }, async supportsSessionEventStream() { return true; },
      async openSessionRing() { return {
        ringId: "ring-1", epoch: "epoch-1", terminalId: "term-1", agentKind: "traex" as const,
        sessionId: "session-1", earliestCursor: retained.cursor, latestCursor: retained.cursor
      }; }, readSessionRing
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession(source)).resolves.toEqual({ laneId, sourceId: "ring-1", ingestedEvents: 1, caughtUp: true });
    expect(readSessionRing.mock.calls.map((call) => call[1])).toEqual(["start", "ring-1:epoch-1:9"]);
    expect(stores.coreEvents.getCheckpoint(laneId)).toMatchObject({ sourceId: "ring-1", sourceEpoch: "epoch-1", readCursor: retained.cursor, latestCursor: retained.cursor });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_expired'").get()).toEqual({ count: 1 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM core_event_lane_items WHERE lane_id=?").get(laneId)).toEqual({ count: 1 });
    stores.lifecycle.close();
  });

  it("preserves lane order while ingesting a non-empty replacement epoch", async () => {
    const stores = createTestStoreBundle();
    const source = epochTransitionSource();
    const laneId = liveCoreSessionLaneId(source);
    const oldEvent = {
      schemaVersion: 1 as const, eventId: "old-epoch-event", cursor: "ring-1:epoch-3:164", sourceId: "ring-1",
      agentKind: "traex" as const, sessionId: "session-1", turnId: null, occurredAt: "2026-10-07T09:30:00.000Z",
      payload: { type: "runtime_status_changed" as const, pane_id: "wN:p6G", status: "working" }
    };
    stores.coreEvents.ingestBatch({
      laneId, sourceId: "ring-1", sourceEpoch: "epoch-3", agentKind: "traex", sessionId: "session-1",
      afterCursor: "start", nextCursor: oldEvent.cursor, latestCursor: oldEvent.cursor, events: [oldEvent],
      ingestedAt: "2026-10-07T09:32:21.954Z"
    });
    const replacementEvents = [1, 2].map((index) => ({
      schemaVersion: 1 as const, eventId: `replacement-${index}`, cursor: `ring-1:epoch-2:${index}`, sourceId: "transport-source",
      agentKind: "traex" as const, sessionId: "session-1", turnId: null, occurredAt: `2026-10-07T09:33:0${index}.000Z`,
      payload: { type: "runtime_status_changed" as const, paneId: "wN:p6G", status: "working" }
    }));
    const events = {
      async supportsSessionEventRingV2() { return true; },
      async supportsSessionEventStream() { return true; },
      async openSessionRing() { return {
        ringId: "ring-1", epoch: "epoch-2", terminalId: "term-1", agentKind: "traex" as const,
        sessionId: "session-1", earliestCursor: "ring-1:epoch-2:1", latestCursor: "ring-1:epoch-2:2"
      }; },
      async readSessionRing(_ringId: string, after: string) { return { outcome: "batch" as const, batch: {
        ringId: "ring-1", epoch: "epoch-2", earliestCursor: "ring-1:epoch-2:1",
        nextCursor: "ring-1:epoch-2:2", latestCursor: "ring-1:epoch-2:2",
        events: after === "start" ? replacementEvents : []
      } }; }
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession(source)).resolves.toEqual({ laneId, sourceId: "ring-1", ingestedEvents: 2, caughtUp: true });
    expect(stores.coreEvents.loadPending(laneId).eventIds).toEqual(["old-epoch-event", "replacement-1", "replacement-2"]);
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM core_event_lane_items WHERE lane_id=?").get(laneId)).toEqual({ count: 3 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_epoch_changed'").get()).toEqual({ count: 1 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM submission_intents").get()).toEqual({ count: 0 });
  });

  it("allows one typed same-epoch expiry rebase after an epoch transition", async () => {
    const stores = createTestStoreBundle();
    const source = epochTransitionSource();
    const laneId = seedEpochCheckpoint(stores, source);
    const retained = {
      schemaVersion: 1 as const, eventId: "retained-after-transition", cursor: "ring-1:epoch-2:10", sourceId: "transport-source",
      agentKind: "traex" as const, sessionId: "session-1", turnId: null, occurredAt: "2026-10-07T09:33:10.000Z",
      payload: { type: "runtime_status_changed" as const, paneId: "wN:p6G", status: "working" }
    };
    const readSessionRing = vi.fn(async (_ringId: string, after: string) => after === "start"
      ? { outcome: "cursor_expired" as const, resumeCursor: "ring-1:epoch-2:9", earliestCursor: retained.cursor, latestCursor: retained.cursor }
      : { outcome: "batch" as const, batch: {
          ringId: "ring-1", epoch: "epoch-2", earliestCursor: retained.cursor,
          nextCursor: retained.cursor, latestCursor: retained.cursor, events: [retained]
        } });
    const events = {
      async supportsSessionEventRingV2() { return true; }, async supportsSessionEventStream() { return true; },
      async openSessionRing() { return {
        ringId: "ring-1", epoch: "epoch-2", terminalId: "term-1", agentKind: "traex" as const,
        sessionId: "session-1", earliestCursor: retained.cursor, latestCursor: retained.cursor
      }; }, readSessionRing
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession(source)).resolves.toEqual({ laneId, sourceId: "ring-1", ingestedEvents: 1, caughtUp: true });
    expect(readSessionRing.mock.calls.map((call) => call[1])).toEqual(["start", "ring-1:epoch-2:9"]);
    expect(stores.driver.database.prepare("SELECT failure_code,COUNT(*) AS count FROM projection_gaps GROUP BY failure_code ORDER BY failure_code").all())
      .toEqual([{ failure_code: "cursor_epoch_changed", count: 1 }, { failure_code: "cursor_expired", count: 1 }]);
  });

  it("fails closed on a second typed expiry after an epoch transition", async () => {
    const stores = createTestStoreBundle();
    const source = epochTransitionSource();
    const laneId = seedEpochCheckpoint(stores, source);
    const readSessionRing = vi.fn(async (_ringId: string, after: string) => ({
      outcome: "cursor_expired" as const,
      resumeCursor: after === "start" ? "ring-1:epoch-2:9" : "ring-1:epoch-2:19",
      earliestCursor: "ring-1:epoch-2:20", latestCursor: "ring-1:epoch-2:30"
    }));
    const events = {
      async supportsSessionEventRingV2() { return true; }, async supportsSessionEventStream() { return true; },
      async openSessionRing() { return {
        ringId: "ring-1", epoch: "epoch-2", terminalId: "term-1", agentKind: "traex" as const,
        sessionId: "session-1", earliestCursor: "ring-1:epoch-2:20", latestCursor: "ring-1:epoch-2:30"
      }; }, readSessionRing
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession(source)).rejects.toThrow("Core session event cursor expired");
    expect(readSessionRing.mock.calls.map((call) => call[1])).toEqual(["start", "ring-1:epoch-2:9"]);
    expect(stores.coreEvents.getCheckpoint(laneId)).toMatchObject({ sourceEpoch: "epoch-2", readCursor: "ring-1:epoch-2:9" });
    expect(stores.driver.database.prepare("SELECT failure_code,COUNT(*) AS count FROM projection_gaps GROUP BY failure_code ORDER BY failure_code").all())
      .toEqual([{ failure_code: "cursor_epoch_changed", count: 1 }, { failure_code: "cursor_expired", count: 1 }]);
  });

  it("fails closed when the live ring identity changes before an epoch-transition rebase", async () => {
    const stores = createTestStoreBundle();
    const source = epochTransitionSource();
    const laneId = seedEpochCheckpoint(stores, source);
    let openCount = 0;
    const readSessionRing = vi.fn();
    const events = {
      async supportsSessionEventRingV2() { return true; }, async supportsSessionEventStream() { return true; },
      async openSessionRing() {
        openCount += 1;
        return {
          ringId: openCount === 1 ? "ring-1" : "ring-other", epoch: "epoch-2", terminalId: "term-1",
          agentKind: "traex" as const, sessionId: "session-1", earliestCursor: "ring-1:epoch-2:0", latestCursor: "ring-1:epoch-2:0"
        };
      }, readSessionRing
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession(source)).rejects.toThrow("session event ring identity changed during epoch transition");
    expect(readSessionRing).not.toHaveBeenCalled();
    expect(stores.coreEvents.getCheckpoint(laneId)).toMatchObject({ sourceEpoch: "epoch-3", readCursor: "ring-1:epoch-3:164" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_epoch_changed'").get()).toEqual({ count: 0 });
  });

  it("fails closed when an epoch-transition checkpoint race is lost", async () => {
    const stores = createTestStoreBundle();
    const source = epochTransitionSource();
    const laneId = seedEpochCheckpoint(stores, source);
    vi.spyOn(stores.coreEvents, "rebaseEpochTransition").mockReturnValue("stale_rebase");
    const readSessionRing = vi.fn();
    const events = {
      async supportsSessionEventRingV2() { return true; }, async supportsSessionEventStream() { return true; },
      async openSessionRing() { return {
        ringId: "ring-1", epoch: "epoch-2", terminalId: "term-1", agentKind: "traex" as const,
        sessionId: "session-1", earliestCursor: "ring-1:epoch-2:0", latestCursor: "ring-1:epoch-2:0"
      }; }, readSessionRing
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession(source)).rejects.toThrow("Core event epoch transition rebase lost its identity fence");
    expect(readSessionRing).not.toHaveBeenCalled();
    expect(stores.coreEvents.getCheckpoint(laneId)).toMatchObject({ sourceEpoch: "epoch-3" });
  });

  it("does not perform a second epoch transition in one ingestion attempt", async () => {
    const stores = createTestStoreBundle();
    const source = epochTransitionSource();
    const laneId = seedEpochCheckpoint(stores, source);
    const events = {
      async supportsSessionEventRingV2() { return true; }, async supportsSessionEventStream() { return true; },
      async openSessionRing() { return {
        ringId: "ring-1", epoch: "epoch-2", terminalId: "term-1", agentKind: "traex" as const,
        sessionId: "session-1", earliestCursor: "ring-1:epoch-2:0", latestCursor: "ring-1:epoch-2:0"
      }; },
      async readSessionRing() { return { outcome: "batch" as const, batch: {
        ringId: "ring-1", epoch: "epoch-4", earliestCursor: "ring-1:epoch-4:0",
        nextCursor: "ring-1:epoch-4:0", latestCursor: "ring-1:epoch-4:0", events: []
      } }; }
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession(source)).rejects.toThrow("Core session event ring epoch changed again during ingestion");
    expect(stores.coreEvents.getCheckpoint(laneId)).toMatchObject({ sourceEpoch: "epoch-2", readCursor: "start" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_epoch_changed'").get()).toEqual({ count: 1 });
  });

  it("reopens once then persists one invalid-cursor gap without advancing a same-epoch checkpoint", async () => {
    const stores = createTestStoreBundle();
    const source = epochTransitionSource();
    const laneId = seedEpochCheckpoint(stores, source, "epoch-2", "ring-1:epoch-2:7");
    const openSessionRing = vi.fn(async () => ({
      ringId: "ring-1", epoch: "epoch-2", terminalId: "term-1", agentKind: "traex" as const,
      sessionId: "session-1", earliestCursor: "ring-1:epoch-2:8", latestCursor: "ring-1:epoch-2:9"
    }));
    const events = {
      async supportsSessionEventRingV2() { return true; }, async supportsSessionEventStream() { return true; },
      openSessionRing,
      async readSessionRing() { return { outcome: "invalid_cursor" as const }; }
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    const failure = reader.ingestCurrentSession(source);
    await expect(failure).rejects.toBeInstanceOf(CoreSessionUnrecoverableCursorError);
    await expect(failure).rejects.toMatchObject({
      laneId, owner: { kind: "binding", id: "binding-1" }, sourceId: "ring-1", sourceEpoch: "epoch-2",
      readCursor: "ring-1:epoch-2:7"
    });
    expect(openSessionRing).toHaveBeenCalledTimes(2);
    expect(stores.coreEvents.getCheckpoint(laneId)).toMatchObject({ sourceEpoch: "epoch-2", readCursor: "ring-1:epoch-2:7" });
    expect(stores.driver.database.prepare("SELECT failure_code,details_json FROM projection_gaps").all()).toEqual([{
      failure_code: "invalid_cursor",
      details_json: JSON.stringify({
        laneId, sourceId: "ring-1", sourceEpoch: "epoch-2", agentKind: "traex", sessionId: "session-1",
        readCursor: "ring-1:epoch-2:7"
      })
    }]);
  });

  it("surfaces ring cursor expiry without inventing a card or replaying Agent Input", async () => {
    const stores = createTestStoreBundle();
    const readSessionRing = vi.fn(async () => ({
      outcome: "cursor_expired" as const,
      earliestCursor: "ring-expired:epoch-1:20",
      latestCursor: "ring-expired:epoch-1:40"
    }));
    const events = {
      async supportsSessionEventRingV2() { return true; },
      async supportsSessionEventStream() { return true; },
      async openSessionRing() { return { ringId: "ring-expired", epoch: "epoch-1", terminalId: "terminal-1", agentKind: "traex" as const, sessionId: "session-1", earliestCursor: "ring-expired:epoch-1:20", latestCursor: "ring-expired:epoch-1:40" }; },
      readSessionRing
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession({
      agentKind: "traex", bindingId: "binding-1", generation: 1, paneId: "w1:p1", terminalId: "terminal-1",
      nativeSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }
    })).rejects.toMatchObject({ name: "CoreSessionCursorExpiredError", resumeCursor: undefined, earliestCursor: "ring-expired:epoch-1:20" });
    expect(readSessionRing).toHaveBeenCalledTimes(1);
    expect(readSessionRing).toHaveBeenCalledWith("ring-expired", "start");
    expect(stores.coreEvents.getCheckpoint(liveCoreSessionLaneId({
      agentKind: "traex", bindingId: "binding-1", generation: 1, paneId: "w1:p1", terminalId: "terminal-1",
      nativeSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }
    }))).toBeNull();
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
  });

  it("rebases an expired ring checkpoint and ingests the complete retained window", async () => {
    const stores = createTestStoreBundle();
    const source = {
      agentKind: "traex" as const, bindingId: "binding-1", generation: 1, paneId: "w1:p1", terminalId: "terminal-1",
      nativeSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" },
      coreEventOwner: { kind: "binding" as const, id: "binding-1" }
    };
    const laneId = liveCoreSessionLaneId(source);
    const beforeExpiry = {
      schemaVersion: 1 as const, eventId: "before-expiry", cursor: "ring-1:epoch-1:3", sourceId: "ring-1",
      agentKind: "traex" as const, sessionId: "session-1", turnId: null, occurredAt: "2026-10-05T00:00:00Z",
      payload: { type: "runtime_status_changed" as const, pane_id: "w1:p1", status: "working" }
    };
    stores.coreEvents.ingestBatch({
      laneId, sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: "start", nextCursor: beforeExpiry.cursor, latestCursor: beforeExpiry.cursor,
      events: [beforeExpiry], ingestedAt: "2026-10-05T00:00:00Z"
    });
    const earliest = {
      ...beforeExpiry,
      eventId: "earliest-retained",
      cursor: "ring-1:epoch-1:10",
      occurredAt: "2026-10-05T00:00:01Z",
      payload: { type: "runtime_status_changed" as const, paneId: "w1:p1", status: "working" }
    };
    const readSessionRing = vi.fn(async (_ringId: string, after: string) => {
      if (after === beforeExpiry.cursor) return {
        outcome: "cursor_expired" as const,
        resumeCursor: "ring-1:epoch-1:9",
        earliestCursor: earliest.cursor,
        latestCursor: earliest.cursor
      };
      return { outcome: "batch" as const, batch: {
        ringId: "ring-1", epoch: "epoch-1", earliestCursor: earliest.cursor,
        nextCursor: earliest.cursor, latestCursor: earliest.cursor, events: [earliest]
      } };
    });
    const events = {
      async supportsSessionEventRingV2() { return true; },
      async supportsSessionEventStream() { return true; },
      async openSessionRing() { return {
        ringId: "ring-1", epoch: "epoch-1", terminalId: "terminal-1", agentKind: "traex" as const,
        sessionId: "session-1", earliestCursor: earliest.cursor, latestCursor: earliest.cursor
      }; },
      readSessionRing
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession(source)).resolves.toEqual({ laneId, sourceId: "ring-1", ingestedEvents: 1, caughtUp: true });
    expect(readSessionRing.mock.calls.map((call) => call[1])).toEqual([beforeExpiry.cursor, "ring-1:epoch-1:9"]);
    expect(stores.coreEvents.getCheckpoint(laneId)).toMatchObject({
      sourceEpoch: "epoch-1", readCursor: earliest.cursor, latestCursor: earliest.cursor
    });
    expect(stores.coreEvents.loadPending(laneId).eventIds).toEqual(["before-expiry", "earliest-retained"]);
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_expired'").get()).toEqual({ count: 1 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM input_card_views").get()).toEqual({ count: 0 });

    stores.lifecycle.close();
  });

  it("adopts a compatible durable winner after losing an expired-cursor rebase", async () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-core-rebase-winner-"));
    const path = join(directory, "state.sqlite");
    const stores = createTestStoreBundle(path);
    const winner = createTestStoreBundle(path);
    try {
      const source = epochTransitionSource();
      const laneId = liveCoreSessionLaneId(source);
      const beforeExpiry = {
        schemaVersion: 1 as const, eventId: "before-competing-expiry", cursor: "ring-1:epoch-1:3", sourceId: "ring-1",
        agentKind: "traex" as const, sessionId: "session-1", turnId: null, occurredAt: "2026-10-05T00:00:00Z",
        payload: { type: "runtime_status_changed" as const, pane_id: "wN:p6G", status: "working" }
      };
      stores.coreEvents.ingestBatch({
        laneId, sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
        afterCursor: "start", nextCursor: beforeExpiry.cursor, latestCursor: beforeExpiry.cursor,
        events: [beforeExpiry], ingestedAt: "2026-10-05T00:00:00Z"
      });
      const retained = {
        ...beforeExpiry, eventId: "after-competing-expiry", cursor: "ring-1:epoch-1:10", occurredAt: "2026-10-05T00:00:01Z",
        payload: { type: "runtime_status_changed" as const, paneId: "wN:p6G", status: "working" }
      };
      const readSessionRing = vi.fn(async (_ringId: string, after: string) => after === beforeExpiry.cursor
        ? { outcome: "cursor_expired" as const, resumeCursor: "ring-1:epoch-1:9", earliestCursor: retained.cursor, latestCursor: retained.cursor }
        : { outcome: "batch" as const, batch: {
            ringId: "ring-1", epoch: "epoch-1", earliestCursor: retained.cursor,
            nextCursor: retained.cursor, latestCursor: retained.cursor, events: [retained]
          } });
      const events = {
        async supportsSessionEventRingV2() { return true; }, async supportsSessionEventStream() { return true; },
        async openSessionRing() { return {
          ringId: "ring-1", epoch: "epoch-1", terminalId: "term-1", agentKind: "traex" as const,
          sessionId: "session-1", earliestCursor: retained.cursor, latestCursor: retained.cursor
        }; }, readSessionRing
      } as unknown as HerdrEventsPort;
      vi.spyOn(stores.coreEvents, "rebaseExpiredCheckpoint").mockImplementation((input) => {
        expect(winner.coreEvents.rebaseExpiredCheckpoint(input)).toBe("rebased");
        return "stale_rebase";
      });
      const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

      await expect(reader.ingestCurrentSession(source)).resolves.toEqual({ laneId, sourceId: "ring-1", ingestedEvents: 1, caughtUp: true });
      expect(readSessionRing.mock.calls.map((call) => call[1])).toEqual([beforeExpiry.cursor, "ring-1:epoch-1:9"]);
      expect(stores.coreEvents.getCheckpoint(laneId)).toMatchObject({ sourceEpoch: "epoch-1", readCursor: retained.cursor, latestCursor: retained.cursor });
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_expired'").get()).toEqual({ count: 1 });
    } finally {
      winner.lifecycle.close();
      stores.lifecycle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails closed when a stale expired-cursor rebase leaves the durable cursor unchanged", async () => {
    const stores = createTestStoreBundle();
    const source = epochTransitionSource();
    const laneId = seedEpochCheckpoint(stores, source, "epoch-1", "ring-1:epoch-1:3");
    const readSessionRing = vi.fn(async () => ({
      outcome: "cursor_expired" as const, resumeCursor: "ring-1:epoch-1:9",
      earliestCursor: "ring-1:epoch-1:10", latestCursor: "ring-1:epoch-1:20"
    }));
    const events = {
      async supportsSessionEventRingV2() { return true; }, async supportsSessionEventStream() { return true; },
      async openSessionRing() { return {
        ringId: "ring-1", epoch: "epoch-1", terminalId: "term-1", agentKind: "traex" as const,
        sessionId: "session-1", earliestCursor: "ring-1:epoch-1:10", latestCursor: "ring-1:epoch-1:20"
      }; }, readSessionRing
    } as unknown as HerdrEventsPort;
    vi.spyOn(stores.coreEvents, "rebaseExpiredCheckpoint").mockReturnValue("stale_rebase");
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession(source)).rejects.toThrow("Core event checkpoint rebase lost its identity fence");
    expect(readSessionRing).toHaveBeenCalledTimes(1);
    expect(stores.coreEvents.getCheckpoint(laneId)).toMatchObject({ sourceEpoch: "epoch-1", readCursor: "ring-1:epoch-1:3" });
    stores.lifecycle.close();
  });

  it("fails closed when a stale expired-cursor rebase crosses the live epoch", async () => {
    const stores = createTestStoreBundle();
    const source = epochTransitionSource();
    const laneId = seedEpochCheckpoint(stores, source, "epoch-1", "ring-1:epoch-1:3");
    const readSessionRing = vi.fn(async () => ({
      outcome: "cursor_expired" as const, resumeCursor: "ring-1:epoch-1:9",
      earliestCursor: "ring-1:epoch-1:10", latestCursor: "ring-1:epoch-1:20"
    }));
    const events = {
      async supportsSessionEventRingV2() { return true; }, async supportsSessionEventStream() { return true; },
      async openSessionRing() { return {
        ringId: "ring-1", epoch: "epoch-1", terminalId: "term-1", agentKind: "traex" as const,
        sessionId: "session-1", earliestCursor: "ring-1:epoch-1:10", latestCursor: "ring-1:epoch-1:20"
      }; }, readSessionRing
    } as unknown as HerdrEventsPort;
    vi.spyOn(stores.coreEvents, "rebaseExpiredCheckpoint").mockImplementation((input) => {
      stores.coreEvents.ingestBatch({
        laneId, sourceId: "ring-1", sourceEpoch: "epoch-2", agentKind: "traex", sessionId: "session-1",
        afterCursor: input.expectedReadCursor, nextCursor: input.expectedReadCursor, latestCursor: "ring-1:epoch-2:20", events: [],
        ingestedAt: "2026-10-05T00:00:01Z"
      });
      return "stale_rebase";
    });
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession(source)).rejects.toThrow("Core event checkpoint rebase lost its identity fence");
    expect(readSessionRing).toHaveBeenCalledTimes(1);
    expect(stores.coreEvents.getCheckpoint(laneId)).toMatchObject({ sourceEpoch: "epoch-2", readCursor: "ring-1:epoch-1:3" });
    stores.lifecycle.close();
  });

  it("fails closed when a stale expired-cursor rebase reloads a foreign identity", async () => {
    for (const [field, value] of [["sourceId", "ring-other"], ["agentKind", "pi"], ["sessionId", "session-other"]] as const) {
      const stores = createTestStoreBundle();
      const source = epochTransitionSource();
      const laneId = seedEpochCheckpoint(stores, source, "epoch-1", "ring-1:epoch-1:3");
      const baseline = stores.coreEvents.getCheckpoint(laneId)!;
      let checkpointReads = 0;
      const readSessionRing = vi.fn(async () => ({
        outcome: "cursor_expired" as const, resumeCursor: "ring-1:epoch-1:9",
        earliestCursor: "ring-1:epoch-1:10", latestCursor: "ring-1:epoch-1:20"
      }));
      const events = {
        async supportsSessionEventRingV2() { return true; }, async supportsSessionEventStream() { return true; },
        async openSessionRing() { return {
          ringId: "ring-1", epoch: "epoch-1", terminalId: "term-1", agentKind: "traex" as const,
          sessionId: "session-1", earliestCursor: "ring-1:epoch-1:10", latestCursor: "ring-1:epoch-1:20"
        }; }, readSessionRing
      } as unknown as HerdrEventsPort;
      vi.spyOn(stores.coreEvents, "rebaseExpiredCheckpoint").mockReturnValue("stale_rebase");
      vi.spyOn(stores.coreEvents, "getCheckpoint").mockImplementation(() => {
        checkpointReads += 1;
        return checkpointReads === 1 ? baseline : { ...baseline, [field]: value };
      });
      const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

      await expect(reader.ingestCurrentSession(source)).rejects.toThrow("Core event checkpoint rebase lost its identity fence");
      expect(readSessionRing).toHaveBeenCalledTimes(1);
      stores.lifecycle.close();
    }
  });

  it("preserves Core batch order when independent Inputs arrived in the opposite order", async () => {
    const stores = createTestStoreBundle();
    activatePrimary(stores);
    for (const [submissionId, recordedAt] of [["submission-a", "2026-10-04T12:00:00.000Z"], ["submission-b", "2026-10-04T12:00:01.000Z"]] as const) {
      stores.agentInputs.admit({
        submissionId, ingressSource: "feishu:primary", sourceMessageKey: `message-${submissionId}`,
        actor: { kind: "human", id: "user-1", gatewayId: "feishu:primary", chatId: "chat-1", topicId: "topic-1", rootMessageId: "root-1" },
        text: submissionId, owner: { kind: "primary", id: "binding-1", generation: 1 },
        paneId: "w1:p1", terminalId: "terminal-1", expectedAgentKind: "traex", expectedSessionId: "session-1", recordedAt
      });
    }
    const events = {
      async supportsSessionEventStream() { return true; },
      async openSession() { return { streamId: "stream-1", terminalId: "terminal-1", agentKind: "traex" as const, sessionId: "session-1", earliestCursor: "cursor-0", latestCursor: "cursor-2" }; },
      async readSession() { return { outcome: "batch" as const, batch: {
        streamId: "stream-1", earliestCursor: "cursor-0", nextCursor: "cursor-2", latestCursor: "cursor-2", complete: true,
        events: [
          { schemaVersion: 1 as const, eventId: "event-z", cursor: "cursor-1", sourceId: "stream-1", agentKind: "traex" as const, sessionId: "session-1", turnId: "turn-b", occurredAt: "2026-10-04T12:00:03.000Z", payload: { type: "human_message" as const, messageId: "message-b", text: "submission-b", truncated: false, submissionId: "submission-b" } },
          { schemaVersion: 1 as const, eventId: "event-a", cursor: "cursor-2", sourceId: "stream-1", agentKind: "traex" as const, sessionId: "session-1", turnId: "turn-a", occurredAt: "2026-10-04T12:00:02.000Z", payload: { type: "human_message" as const, messageId: "message-a", text: "submission-a", truncated: false, submissionId: "submission-a" } }
        ]
      } }; }
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);
    const source = {
      agentKind: "traex" as const, bindingId: "binding-1", generation: 1, paneId: "w1:p1", terminalId: "terminal-1",
      nativeSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }
    };

    await reader.ingestCurrentSession(source);

    const laneId = liveCoreSessionLaneId(source, "stream-1");
    const order = stores.driver.database.prepare(`SELECT json_extract(event.event_json, '$.payload.submission_id') AS submission_id
      FROM core_event_lane_items item JOIN core_event_inbox event ON event.event_id=item.event_id
      WHERE item.lane_id=? ORDER BY item.sequence`).all(laneId);
    expect(order).toEqual([{ submission_id: "submission-b" }, { submission_id: "submission-a" }]);
    expect(stores.driver.database.prepare("SELECT submission_id,state,start_lane_sequence FROM conversation_segments ORDER BY start_lane_sequence").all())
      .toEqual([
        { submission_id: "submission-b", state: "working", start_lane_sequence: 1 },
        { submission_id: "submission-a", state: "working", start_lane_sequence: 2 }
      ]);
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM input_card_views").get()).toEqual({ count: 0 });
  });

  it("resumes from the durable cursor and catches up bounded pages in one pass", async () => {
    const stores = createTestStoreBundle();
    const batches = new Map([
      ["start", { nextCursor: "cursor-1", latestCursor: "cursor-2", id: "event-1" }],
      ["cursor-1", { nextCursor: "cursor-2", latestCursor: "cursor-2", id: "event-2" }]
    ]);
    const readSession = vi.fn(async (_streamId: string, after: string) => {
      const page = batches.get(after)!;
      return { outcome: "batch" as const, batch: {
        streamId: "stream-1", earliestCursor: "cursor-0", nextCursor: page.nextCursor, latestCursor: page.latestCursor,
        events: [{ schemaVersion: 1 as const, eventId: page.id, cursor: page.nextCursor, sourceId: "stream-1", agentKind: "traex" as const, sessionId: "session-1", turnId: null, occurredAt: "2026-10-04T12:00:01.000Z", payload: { type: "runtime_status_changed" as const, paneId: "w1:p1", status: "working" } }]
      } };
    });
    const events = { async supportsSessionEventStream() { return true; }, async openSession() { return { streamId: "stream-1", terminalId: "terminal-1", agentKind: "traex" as const, sessionId: "session-1", earliestCursor: "cursor-0", latestCursor: "cursor-2" }; }, readSession } as unknown as HerdrEventsPort;
    const source = { agentKind: "traex" as const, bindingId: "binding-1", generation: 1, paneId: "w1:p1", nativeSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" } };
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession(source)).resolves.toMatchObject({ ingestedEvents: 2, caughtUp: true });
    expect(readSession.mock.calls.map((call) => call[1])).toEqual(["start", "cursor-1"]);
    expect(stores.coreEvents.getCheckpoint(liveCoreSessionLaneId(source, "stream-1"))).toMatchObject({ readCursor: "cursor-2" });
  });

  it("reloads a stale batch from its durable checkpoint without counting or catching it up", async () => {
    const stores = createTestStoreBundle();
    const readSession = vi.fn(async (_streamId: string, after: string) => {
      const page = after === "start"
        ? { nextCursor: "cursor-loser", latestCursor: "cursor-loser", eventId: "loser" }
        : { nextCursor: "cursor-2", latestCursor: "cursor-2", eventId: "winner" };
      return { outcome: "batch" as const, batch: {
        streamId: "stream-1", earliestCursor: "cursor-0", nextCursor: page.nextCursor, latestCursor: page.latestCursor,
        events: [{ schemaVersion: 1 as const, eventId: page.eventId, cursor: page.nextCursor, sourceId: "stream-1", agentKind: "traex" as const, sessionId: "session-1", turnId: null, occurredAt: "2026-10-04T12:00:01.000Z", payload: { type: "runtime_status_changed" as const, paneId: "w1:p1", status: "working" } }]
      } };
    });
    const events = {
      async supportsSessionEventStream() { return true; },
      async openSession() { return { streamId: "stream-1", terminalId: "terminal-1", agentKind: "traex" as const, sessionId: "session-1", earliestCursor: "cursor-0", latestCursor: "cursor-2" }; },
      readSession
    } as unknown as HerdrEventsPort;
    const source = { agentKind: "traex" as const, bindingId: "binding-1", generation: 1, paneId: "w1:p1", nativeSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" } };
    const originalIngest = stores.coreEvents.ingestBatch.bind(stores.coreEvents);
    let stale = true;
    vi.spyOn(stores.coreEvents, "ingestBatch").mockImplementation((input) => {
      if (!stale) return originalIngest(input);
      stale = false;
      originalIngest({ ...input, nextCursor: "cursor-winner", latestCursor: "cursor-winner", events: [] });
      return "stale_rebase";
    });
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession(source)).resolves.toEqual({
      laneId: liveCoreSessionLaneId(source, "stream-1"), sourceId: "stream-1", ingestedEvents: 1, caughtUp: true
    });
    expect(readSession.mock.calls.map((call) => call[1])).toEqual(["start", "cursor-winner"]);
    expect(stores.coreEvents.getCheckpoint(liveCoreSessionLaneId(source, "stream-1"))).toMatchObject({ readCursor: "cursor-2" });
    expect(stores.coreEvents.loadPending(liveCoreSessionLaneId(source, "stream-1")).eventIds).toEqual(["winner"]);
  });

  it("rejects a Core stream whose terminal no longer matches the resolved route", async () => {
    const events = {
      async supportsSessionEventStream() { return true; },
      async openSession() { return { streamId: "stream-1", terminalId: "terminal-new", agentKind: "traex" as const, sessionId: "session-1", earliestCursor: "cursor-0", latestCursor: "cursor-0" }; }
    } as unknown as HerdrEventsPort;
    const stores = createTestStoreBundle();
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents);

    await expect(reader.ingestCurrentSession({
      agentKind: "traex", bindingId: "binding-1", generation: 1, paneId: "w1:p1", terminalId: "terminal-old",
      nativeSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }
    })).rejects.toThrow("session stream identity mismatch");
  });

  it("coalesces concurrent Primary scans into one exact session producer", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const ingestCurrentSession = vi.fn(async () => { await held; return { laneId: "lane-1", ingestedEvents: 1, caughtUp: true }; });
    const binding = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] },
      ingestor: { ingestCurrentSession },
      onIngested: vi.fn(),
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" })
    });

    const first = supervisor.reconcile();
    const second = supervisor.reconcile();
    await vi.waitFor(() => expect(ingestCurrentSession).toHaveBeenCalledTimes(1));
    release();
    await Promise.all([first, second]);
    expect(ingestCurrentSession).toHaveBeenCalledWith(expect.objectContaining({
      bindingId: "binding-1", generation: 3, paneId: "w1:p1",
      nativeSession: expect.objectContaining({ value: "session-1" })
    }));
  });

  it("routes a known Core source notification only to its exact Primary owner", async () => {
    const bindings = ["binding-1", "binding-2"].map((id, index) => ({
      id, state: "active", generation: 3, paneId: `w1:p${index + 1}`, agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: `session-${index + 1}`
    })) as Binding[];
    const ingestCurrentSession = vi.fn(async (source: { bindingId: string }) => ({
      laneId: `lane-${source.bindingId}`,
      sourceId: `stream-${source.bindingId}`,
      ingestedEvents: 0,
      caughtUp: true
    }));
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => bindings },
      ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async (binding) => ({ ...bindingSource(binding), terminalId: `terminal-${binding.id}` })
    });
    await supervisor.reconcile();
    ingestCurrentSession.mockClear();

    await supervisor.notifySources([{ sourceId: "stream-binding-2", latestCursor: "cursor-9" }]);

    expect(ingestCurrentSession).toHaveBeenCalledOnce();
    expect(ingestCurrentSession).toHaveBeenCalledWith(expect.objectContaining({ bindingId: "binding-2" }));
  });

  it("keeps one stable 128-target multiplex set while overflow owners remain on v2", async () => {
    const bindings = Array.from({ length: 129 }, (_, index) => ({
      id: `binding-${String(index + 1).padStart(3, "0")}`,
      state: "active",
      generation: 3,
      paneId: `w1:p${index + 1}`,
      agentKind: "traex",
      agentSessionSource: "herdr:traex",
      agentSessionAgent: "traex",
      agentSessionKind: "id",
      agentSessionValue: `session-${index + 1}`
    })) as Binding[];
    const replaceMultiplexTargets = vi.fn(async (_targets: readonly CoreSessionEventMultiplexTarget[]) => undefined);
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => bindings },
      ingestor: {
        ingestCurrentSession: vi.fn(async (source: { bindingId: string }) => ({
          laneId: `lane-${source.bindingId}`,
          sourceId: `ring-${source.bindingId}`,
          ingestedEvents: 0,
          caughtUp: true
        })),
        prepareMultiplexTarget: vi.fn(async (source: { bindingId: string }) => ({
          ringId: `ring-${source.bindingId}`,
          epoch: "epoch-1",
          after: "start",
          limit: 128
        }))
      },
      replaceMultiplexTargets,
      onIngested: vi.fn(),
      resolveSource: async (binding) => ({ ...bindingSource(binding), terminalId: `terminal-${binding.id}` })
    });

    await supervisor.reconcile();

    expect(replaceMultiplexTargets).toHaveBeenCalledOnce();
    const targets = replaceMultiplexTargets.mock.calls[0]![0];
    expect(targets).toHaveLength(128);
    expect(new Set(targets.map(({ ringId }) => ringId)).size).toBe(128);
    expect(supervisor.snapshot()).toMatchObject({ multiplexTargets: 128, multiplexOverflow: 1 });
  });

  it("refreshes multiplex targets with bounded concurrency", async () => {
    const bindings = Array.from({ length: 8 }, (_, index) => ({
      id: `refresh-binding-${index + 1}`, state: "active", generation: 1,
      paneId: `w1:refresh-${index + 1}`, agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id",
      agentSessionValue: `refresh-session-${index + 1}`
    })) as Binding[];
    let inFlight = 0;
    let maximumInFlight = 0;
    const prepareMultiplexTarget = vi.fn(async (source: { bindingId: string }) => {
      inFlight += 1;
      maximumInFlight = Math.max(maximumInFlight, inFlight);
      await new Promise<void>((resolve) => setImmediate(resolve));
      inFlight -= 1;
      return { ringId: `refresh-ring-${source.bindingId}`, epoch: "epoch-1", after: "start", limit: 128 };
    });
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => bindings },
      ingestor: {
        ingestCurrentSession: vi.fn(async (source: { bindingId: string }) => ({ laneId: source.bindingId, sourceId: source.bindingId, ingestedEvents: 0, caughtUp: true })),
        prepareMultiplexTarget
      },
      replaceMultiplexTargets: vi.fn(async () => undefined),
      onIngested: vi.fn(),
      resolveSource: async (binding) => ({ ...bindingSource(binding), terminalId: `terminal-${binding.id}` })
    });

    await supervisor.reconcile();
    inFlight = 0;
    maximumInFlight = 0;
    prepareMultiplexTarget.mockClear();

    await supervisor.refreshMultiplexTargets();

    expect(prepareMultiplexTarget).toHaveBeenCalledTimes(8);
    expect(maximumInFlight).toBeGreaterThan(1);
    expect(maximumInFlight).toBeLessThanOrEqual(4);
  });

  it("falls back the exact multiplex owners when transport disconnects", async () => {
    const binding = {
      id: "transport-binding", state: "active", generation: 1, paneId: "w1:transport",
      agentKind: "traex", agentSessionSource: "herdr:traex", agentSessionAgent: "traex",
      agentSessionKind: "id", agentSessionValue: "transport-session"
    } as Binding;
    const ingestCurrentSession = vi.fn(async () => ({ laneId: "lane", sourceId: "source", ingestedEvents: 0, caughtUp: true }));
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] },
      ingestor: {
        ingestCurrentSession,
        prepareMultiplexTarget: async () => ({ ringId: "transport-ring", epoch: "epoch-1", after: "start", limit: 128 })
      },
      replaceMultiplexTargets: vi.fn(async () => 1),
      onIngested: vi.fn(),
      resolveSource: async (candidate) => ({ ...bindingSource(candidate), terminalId: "transport-terminal" })
    });

    await supervisor.reconcile();
    ingestCurrentSession.mockClear();

    await supervisor.handleMultiplexTransportState("disconnected", 1);

    expect(ingestCurrentSession).toHaveBeenCalledOnce();
    expect(supervisor.snapshot()).toMatchObject({ multiplexTargets: 1 });
  });

  it("promotes the deterministic overflow owner when a subscribed slot opens", async () => {
    let bindings = Array.from({ length: 129 }, (_, index) => ({
      id: `binding-${String(index + 1).padStart(3, "0")}`, state: "active", generation: 3, paneId: `w1:p${index + 1}`,
      agentKind: "traex", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: `session-${index + 1}`
    })) as Binding[];
    const replacements: CoreSessionEventMultiplexTarget[][] = [];
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => bindings },
      ingestor: {
        ingestCurrentSession: async (source) => ({ laneId: `lane-${source.bindingId}`, sourceId: `ring-${source.bindingId}`, ingestedEvents: 0, caughtUp: true }),
        prepareMultiplexTarget: async (source) => ({ ringId: `ring-${source.bindingId}`, epoch: "epoch-1", after: "start", limit: 128 })
      },
      replaceMultiplexTargets: async (targets) => { replacements.push([...targets]); },
      onIngested: vi.fn(), resolveSource: async (binding) => ({ ...bindingSource(binding), terminalId: `terminal-${binding.id}` })
    });

    await supervisor.reconcile();
    bindings = bindings.slice(1);
    await supervisor.reconcile();

    expect(replacements).toHaveLength(2);
    expect(replacements[0]!.map(({ ringId }) => ringId)).not.toContain("ring-binding-129");
    expect(replacements[1]!.map(({ ringId }) => ringId)).toContain("ring-binding-129");
    expect(replacements[1]!.map(({ ringId }) => ringId)).not.toContain("ring-binding-001");
    expect(supervisor.snapshot()).toMatchObject({ multiplexTargets: 128, multiplexOverflow: 0, multiplexGeneration: 2 });
  });

  it("routes one v3 batch through only its exact owner tail without a global scan", async () => {
    const bindings = Array.from({ length: 23 }, (_, index) => ({
      id: `binding-${String(index + 1).padStart(2, "0")}`, state: "active", generation: 3, paneId: `w1:p${index + 1}`,
      agentKind: "traex", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: `session-${index + 1}`
    })) as Binding[];
    const ingestCurrentSession = vi.fn(async (source: { bindingId: string }) => ({ laneId: `lane-${source.bindingId}`, sourceId: `ring-${source.bindingId}`, ingestedEvents: 0, caughtUp: true }));
    const ingestMultiplexBatch = vi.fn(async (_source: { bindingId: string }, _target: CoreSessionEventMultiplexTarget, batch: CoreSessionEventMultiplexBatch) => ({
      laneId: "lane", sourceId: batch.ringId, ingestedEvents: batch.events.length, caughtUp: true, outcome: "accepted" as const, readCursor: batch.nextCursor
    }));
    const onIngested = vi.fn();
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => bindings },
      ingestor: { ingestCurrentSession, ingestMultiplexBatch,
        prepareMultiplexTarget: async (source: { bindingId: string }) => ({ ringId: `ring-${source.bindingId}`, epoch: "epoch-1", after: "start", limit: 128 }) },
      replaceMultiplexTargets: async () => undefined, onIngested,
      resolveSource: async (binding) => ({ ...bindingSource(binding), terminalId: `terminal-${binding.id}` })
    });
    await supervisor.reconcile();
    ingestCurrentSession.mockClear();

    const event = { schemaVersion: 1 as const, eventId: "event-10", cursor: "cursor-10", sourceId: "journal", agentKind: "traex" as const,
      sessionId: "session-10", turnId: null, occurredAt: "2026-10-17T00:00:00.000Z", payload: { type: "turn_started" as const } };
    await supervisor.handleMultiplexFrame({ outcome: "batch", batch: { ringId: "ring-binding-10", epoch: "epoch-1", earliestCursor: "cursor-1",
      nextCursor: event.cursor, latestCursor: event.cursor, events: [event] } }, 1);

    expect(ingestCurrentSession).not.toHaveBeenCalled();
    expect(ingestMultiplexBatch).toHaveBeenCalledOnce();
    expect(ingestMultiplexBatch.mock.calls[0]![0]).toMatchObject({ bindingId: "binding-10" });
    expect(onIngested).toHaveBeenCalledOnce();
    expect(onIngested).toHaveBeenCalledWith("binding-10");
  });

  it("ignores stale generations and wrong multiplex identity before entering an owner tail", async () => {
    const binding = { id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" } as Binding;
    const ingestMultiplexBatch = vi.fn();
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] },
      ingestor: { ingestCurrentSession: async () => ({ laneId: "lane", sourceId: "ring-binding-1", ingestedEvents: 0, caughtUp: true }), ingestMultiplexBatch,
        prepareMultiplexTarget: async () => ({ ringId: "ring-binding-1", epoch: "epoch-1", after: "start", limit: 128 }) },
      replaceMultiplexTargets: async () => undefined, onIngested: vi.fn(),
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" })
    });
    await supervisor.reconcile();
    const empty = (ringId: string, epoch: string) => ({ outcome: "batch" as const, batch: { ringId, epoch, earliestCursor: "start", nextCursor: "start", latestCursor: "start", events: [] } });

    await supervisor.handleMultiplexFrame(empty("ring-binding-1", "epoch-1"), 0);
    await supervisor.handleMultiplexFrame(empty("ring-other", "epoch-1"), 1);
    await supervisor.handleMultiplexFrame(empty("ring-binding-1", "epoch-other"), 1);
    expect(ingestMultiplexBatch).not.toHaveBeenCalled();
  });

  it("suspends a stale v3 batch and replaces it from the winning durable cursor", async () => {
    const binding = { id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" } as Binding;
    let durableCursor = "start";
    const replaceMultiplexTargets = vi.fn(async () => undefined);
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] },
      ingestor: {
        ingestCurrentSession: async () => ({ laneId: "lane", sourceId: "ring-binding-1", ingestedEvents: 0, caughtUp: true }),
        prepareMultiplexTarget: async () => ({ ringId: "ring-binding-1", epoch: "epoch-1", after: durableCursor, limit: 128 }),
        ingestMultiplexBatch: async () => {
          durableCursor = "ring-binding-1:epoch-1:10";
          return {
            laneId: "lane",
            sourceId: "ring-binding-1",
            ingestedEvents: 0,
            caughtUp: false,
            outcome: "stale_rebase" as const,
            readCursor: durableCursor
          };
        }
      },
      replaceMultiplexTargets,
      onIngested: vi.fn(),
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" })
    });
    await supervisor.reconcile();
    replaceMultiplexTargets.mockClear();
    const event = { schemaVersion: 1 as const, eventId: "event-10", cursor: "ring-binding-1:epoch-1:10", sourceId: "journal",
      agentKind: "traex" as const, sessionId: "session-1", turnId: null, occurredAt: "2026-10-17T00:00:00Z",
      payload: { type: "turn_started" as const } };

    await supervisor.handleMultiplexFrame({ outcome: "batch", batch: {
      ringId: "ring-binding-1", epoch: "epoch-1", earliestCursor: event.cursor,
      nextCursor: "ring-binding-1:epoch-1:11", latestCursor: "ring-binding-1:epoch-1:11", events: [event]
    } }, 1);

    expect(replaceMultiplexTargets).toHaveBeenCalledOnce();
    expect(replaceMultiplexTargets.mock.calls[0]![0]).toEqual([{
      ringId: "ring-binding-1", epoch: "epoch-1", after: durableCursor, limit: 128
    }]);
    expect(supervisor.snapshot()).toMatchObject({ multiplexGeneration: 2, multiplexTargets: 1 });
  });

  it("clears the multiplex transport when the selected owner set becomes empty", async () => {
    const binding = { id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" } as Binding;
    let activeBindings = [binding];
    const clearMultiplexTargets = vi.fn(async () => undefined);
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => activeBindings },
      ingestor: {
        ingestCurrentSession: async () => ({ laneId: "lane", sourceId: "ring-binding-1", ingestedEvents: 0, caughtUp: true }),
        prepareMultiplexTarget: async () => ({ ringId: "ring-binding-1", epoch: "epoch-1", after: "start", limit: 128 })
      },
      replaceMultiplexTargets: async () => undefined,
      clearMultiplexTargets,
      onIngested: vi.fn(),
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" })
    });
    await supervisor.reconcile();

    activeBindings = [];
    await supervisor.reconcile();

    expect(clearMultiplexTargets).toHaveBeenCalledOnce();
    expect(supervisor.snapshot()).toMatchObject({ multiplexGeneration: 1, multiplexTargets: 0 });
  });

  it.each([
    { ringId: "ring-binding-1", epoch: "epoch-1", code: "cursor_expired", resumeCursor: "cursor-4", earliestCursor: "cursor-5", latestCursor: "cursor-10" },
    { ringId: "ring-binding-1", epoch: "epoch-1", code: "epoch_changed", currentEpoch: "epoch-2" },
    { ringId: "ring-binding-1", epoch: "epoch-1", code: "missing" },
    { ringId: "ring-binding-1", epoch: "epoch-1", code: "unavailable" }
  ] satisfies CoreSessionEventMultiplexGap[])("repairs and reinserts only the gapped owner for $code", async (gap) => {
    const binding = { id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" } as Binding;
    const ingestCurrentSession = vi.fn(async () => ({ laneId: "lane", sourceId: "ring-binding-1", ingestedEvents: 0, caughtUp: true }));
    const prepareMultiplexTarget = vi.fn(async () => ({ ringId: "ring-binding-1", epoch: "epoch-1", after: "cursor-repaired", limit: 128 }));
    const replaceMultiplexTargets = vi.fn(async () => undefined);
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession, prepareMultiplexTarget },
      replaceMultiplexTargets, onIngested: vi.fn(), resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" })
    });
    await supervisor.reconcile();
    ingestCurrentSession.mockClear(); prepareMultiplexTarget.mockClear(); replaceMultiplexTargets.mockClear();

    await supervisor.handleMultiplexFrame({ outcome: "gap", gap }, 1);

    expect(ingestCurrentSession).toHaveBeenCalledOnce();
    expect(prepareMultiplexTarget).toHaveBeenCalledOnce();
    expect(replaceMultiplexTargets).toHaveBeenCalledOnce();
    expect(replaceMultiplexTargets.mock.calls[0]![0]).toEqual([{ ringId: "ring-binding-1", epoch: "epoch-1", after: "cursor-repaired", limit: 128 }]);
    expect(supervisor.snapshot()).toMatchObject({ multiplexTargets: 1, multiplexOverflow: 0, multiplexGeneration: 2 });
  });

  it("reinserts a gapped target after bounded v2 continuation finally catches up", async () => {
    const binding = { id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" } as Binding;
    let repairing = false;
    let repairReads = 0;
    const ingestCurrentSession = vi.fn(async () => {
      if (!repairing) return { laneId: "lane", sourceId: "ring-binding-1", ingestedEvents: 0, caughtUp: true };
      repairReads += 1;
      return { laneId: "lane", sourceId: "ring-binding-1", ingestedEvents: 0, caughtUp: repairReads >= 9 };
    });
    const replaceMultiplexTargets = vi.fn(async () => undefined);
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] },
      ingestor: { ingestCurrentSession, prepareMultiplexTarget: async () => ({ ringId: "ring-binding-1", epoch: "epoch-1", after: repairing ? "cursor-repaired" : "start", limit: 128 }) },
      replaceMultiplexTargets, onIngested: vi.fn(), resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" })
    });
    await supervisor.reconcile();
    repairing = true;
    replaceMultiplexTargets.mockClear();

    await supervisor.handleMultiplexFrame({ outcome: "gap", gap: { ringId: "ring-binding-1", epoch: "epoch-1", code: "unavailable" } }, 1);
    await vi.waitFor(() => expect(replaceMultiplexTargets).toHaveBeenCalledOnce());

    expect(repairReads).toBe(9);
    expect(replaceMultiplexTargets.mock.calls[0]![0]).toEqual([{ ringId: "ring-binding-1", epoch: "epoch-1", after: "cursor-repaired", limit: 128 }]);
    expect(supervisor.snapshot()).toMatchObject({ multiplexTargets: 1, multiplexGeneration: 2 });
  });

  it("bounds event-driven Core source ingestion to four owners", async () => {
    const bindings = Array.from({ length: 8 }, (_, index) => ({
      id: `binding-${index + 1}`, state: "active", generation: 3, paneId: `w1:p${index + 1}`, agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: `session-${index + 1}`
    })) as Binding[];
    let block = false;
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let active = 0;
    let maximumActive = 0;
    const ingestCurrentSession = vi.fn(async (source: { bindingId: string }) => {
      if (block) {
        active += 1;
        maximumActive = Math.max(maximumActive, active);
        await held;
        active -= 1;
      }
      return {
        laneId: `lane-${source.bindingId}`, sourceId: `stream-${source.bindingId}`,
        ingestedEvents: 0, caughtUp: true
      };
    });
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => bindings },
      ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async (binding) => ({ ...bindingSource(binding), terminalId: `terminal-${binding.id}` })
    });
    await supervisor.reconcile();
    ingestCurrentSession.mockClear();
    block = true;

    const notified = bindings.map((binding) => supervisor.notifySources([{
      sourceId: `stream-${binding.id}`, latestCursor: "cursor-9"
    }]));
    await vi.waitFor(() => expect(ingestCurrentSession).toHaveBeenCalledTimes(4));
    expect(maximumActive).toBe(4);
    release();
    await Promise.all(notified);

    expect(ingestCurrentSession).toHaveBeenCalledTimes(8);
    expect(maximumActive).toBe(4);
  });

  it("preserves exact notification admission on the next permit before later periodic owners", async () => {
    const bindings = Array.from({ length: 8 }, (_, index) => ({
      id: `binding-${index + 1}`, state: "active", generation: 3, paneId: `w1:p${index + 1}`, agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: `session-${index + 1}`
    })) as Binding[];
    let block = false;
    const releases = new Map<string, () => void>();
    const started: string[] = [];
    const ingestCurrentSession = vi.fn(async (source: { bindingId: string }) => {
      if (block) {
        started.push(source.bindingId);
        await new Promise<void>((resolve) => { releases.set(source.bindingId, resolve); });
      }
      return {
        laneId: `lane-${source.bindingId}`, sourceId: `stream-${source.bindingId}`,
        ingestedEvents: 0, caughtUp: true
      };
    });
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => bindings }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async (binding) => ({ ...bindingSource(binding), terminalId: `terminal-${binding.id}` })
    });
    await supervisor.reconcile();
    ingestCurrentSession.mockClear();
    block = true;

    const periodic = supervisor.reconcile();
    await vi.waitFor(() => expect(started).toHaveLength(4));
    const notified = supervisor.notifySources([{ sourceId: "stream-binding-8", latestCursor: "cursor-live" }]);
    releases.get(started[0]!)!();
    await vi.waitFor(() => expect(started).toHaveLength(5));

    expect(started[4]).toBe("binding-8");
    block = false;
    for (const release of releases.values()) release();
    await Promise.all([periodic, notified]);
  });

  it("serializes ordinary exact notifications around projection callbacks", async () => {
    const binding = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    let phase: "initial" | "live" = "initial";
    let liveIngestions = 0;
    let releaseProjection!: () => void;
    const projectionHeld = new Promise<void>((resolve) => { releaseProjection = resolve; });
    const order: string[] = [];
    const ingestCurrentSession = vi.fn(async () => {
      if (phase === "initial") return { laneId: "lane-1", sourceId: "stream-1", ingestedEvents: 0, caughtUp: true };
      liveIngestions += 1;
      order.push(`ingest-${liveIngestions}`);
      return { laneId: "lane-1", sourceId: "stream-1", ingestedEvents: liveIngestions === 1 ? 1 : 0, caughtUp: true };
    });
    const onIngested = vi.fn(async () => {
      order.push("on-ingested");
      await projectionHeld;
    });
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession }, onIngested,
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" })
    });
    await supervisor.reconcile();
    phase = "live";
    ingestCurrentSession.mockClear();

    const first = supervisor.notifySources([{ sourceId: "stream-1", latestCursor: "cursor-1" }]);
    await vi.waitFor(() => expect(onIngested).toHaveBeenCalledOnce());
    const second = supervisor.notifySources([{ sourceId: "stream-1", latestCursor: "cursor-2" }]);
    releaseProjection();
    await Promise.all([first, second]);

    expect(order).toEqual(["ingest-1", "on-ingested", "ingest-2"]);
  });

  it("uses a thirty-second fallback after a healthy caught-up scan", async () => {
    vi.useFakeTimers();
    const binding = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    const ingestCurrentSession = vi.fn(async () => ({ laneId: "lane-1", sourceId: "stream-1", ingestedEvents: 0, caughtUp: true }));
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" })
    });

    try {
      supervisor.start();
      await supervisor.reconcile();
      expect(ingestCurrentSession).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(2_000);
      expect(ingestCurrentSession).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(28_000);
      expect(ingestCurrentSession).toHaveBeenCalledTimes(2);
    } finally {
      await supervisor.stop();
      vi.useRealTimers();
    }
  });

  it("uses the degraded two-second fallback while an owner awaits its first session", async () => {
    vi.useFakeTimers();
    const binding = { id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex" } as Binding;
    const resolveSource = vi.fn(async () => null);
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession: vi.fn() }, onIngested: vi.fn(), resolveSource
    });

    try {
      supervisor.start();
      await supervisor.reconcile();
      expect(resolveSource).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1_999);
      expect(resolveSource).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(1);
      expect(resolveSource).toHaveBeenCalledTimes(2);
    } finally {
      await supervisor.stop();
      vi.useRealTimers();
    }
  });

  it("keeps a nondefault degraded cadence after an immediate manual reconcile", async () => {
    vi.useFakeTimers();
    const binding = { id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex" } as Binding;
    const resolveSource = vi.fn(async () => null);
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession: vi.fn() }, onIngested: vi.fn(), resolveSource
    });

    try {
      supervisor.start(37);
      await supervisor.reconcile();
      await vi.advanceTimersByTimeAsync(10);
      await supervisor.reconcile();
      expect(supervisor.snapshot()).toMatchObject({ fallbackDelayMs: 37, pendingReprojections: 0, activeIngestionPermits: 0 });
      await vi.advanceTimersByTimeAsync(36);
      expect(resolveSource).toHaveBeenCalledTimes(2);
      await vi.advanceTimersByTimeAsync(1);
      expect(resolveSource).toHaveBeenCalledTimes(3);
    } finally {
      await supervisor.stop();
      vi.useRealTimers();
    }
  });

  it("reschedules after a scheduled reconciliation rejects without leaking an unhandled rejection", async () => {
    vi.useFakeTimers();
    const recoverCanonicalTurns = vi.fn().mockRejectedValueOnce(new Error("recovery failed")).mockResolvedValueOnce(undefined);
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [] }, ingestor: { ingestCurrentSession: vi.fn() }, onIngested: vi.fn(), recoverCanonicalTurns
    });

    try {
      supervisor.start();
      await vi.advanceTimersByTimeAsync(0);
      expect(recoverCanonicalTurns).toHaveBeenCalledOnce();
      await vi.advanceTimersByTimeAsync(30_000);
      expect(recoverCanonicalTurns).toHaveBeenCalledTimes(2);
    } finally {
      await supervisor.stop();
      vi.useRealTimers();
    }
  });

  it("cancels its fallback timer when stopped", async () => {
    vi.useFakeTimers();
    const binding = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    const ingestCurrentSession = vi.fn(async () => ({ laneId: "lane-1", sourceId: "stream-1", ingestedEvents: 0, caughtUp: true }));
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" })
    });

    try {
      supervisor.start();
      await supervisor.reconcile();
      await supervisor.stop();
      await vi.advanceTimersByTimeAsync(60_000);
      expect(ingestCurrentSession).toHaveBeenCalledOnce();
    } finally {
      vi.useRealTimers();
    }
  });

  it("coalesces concurrent duplicate notifications for one known Core source", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    let block = false;
    const binding = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    const ingestCurrentSession = vi.fn(async () => {
      if (block) await held;
      return { laneId: "lane-1", sourceId: "stream-1", ingestedEvents: 0, caughtUp: true };
    });
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" })
    });
    await supervisor.reconcile();
    ingestCurrentSession.mockClear();
    block = true;

    const first = supervisor.notifySources([{ sourceId: "stream-1", latestCursor: "cursor-9" }]);
    const duplicate = supervisor.notifySources([{ sourceId: "stream-1", latestCursor: "cursor-9" }]);
    await vi.waitFor(() => expect(ingestCurrentSession).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, duplicate]);

    expect(ingestCurrentSession).toHaveBeenCalledOnce();
  });

  it("coalesces unknown Core sources into one full discovery pass", async () => {
    let release!: () => void;
    const held = new Promise<void>((resolve) => { release = resolve; });
    const binding = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    const ingestCurrentSession = vi.fn(async () => {
      await held;
      return { laneId: "lane-1", sourceId: "stream-1", ingestedEvents: 0, caughtUp: true };
    });
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" })
    });

    const first = supervisor.notifySources([{ sourceId: "unknown-1", latestCursor: "cursor-1" }]);
    const second = supervisor.notifySources([{ sourceId: "unknown-2", latestCursor: "cursor-2" }]);
    await vi.waitFor(() => expect(ingestCurrentSession).toHaveBeenCalledOnce());
    release();
    await Promise.all([first, second]);

    expect(ingestCurrentSession).toHaveBeenCalledOnce();
    expect(supervisor.snapshot()).toMatchObject({ runCount: 1 });
  });

  it("immediately continues the exact owner when a Core ingestion page is not caught up", async () => {
    const binding = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    const ingestCurrentSession = vi.fn()
      .mockResolvedValueOnce({ laneId: "lane-1", sourceId: "stream-1", ingestedEvents: 512, caughtUp: false })
      .mockResolvedValueOnce({ laneId: "lane-1", sourceId: "stream-1", ingestedEvents: 12, caughtUp: true });
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" })
    });

    await supervisor.reconcile();

    expect(ingestCurrentSession).toHaveBeenCalledTimes(2);
    expect(supervisor.snapshot()).toMatchObject({ laggingSessions: 0 });
  });

  it("keeps retired pending-reprojection diagnostics inert after exact session ingestion", async () => {
    const binding = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    const ingestCurrentSession = vi.fn(async () => ({ laneId: "lane-1", sourceId: "stream-1", ingestedEvents: 0, caughtUp: true }));
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" })
    });

    await supervisor.reconcile();

    expect(supervisor.snapshot()).toMatchObject({
      pendingReprojectionRuns: 0, pendingReprojectedEvents: 0, pendingReprojectionRetries: 0,
      pendingReprojectionQuarantined: 0, lastPendingReprojectionAt: null
    });
  });

  it("serializes exact session changes per owner", async () => {
    const binding = {
      id: "binding-owner", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-old"
    } as Binding;
    let ownerActive = 0;
    let maximumOwnerActive = 0;
    const enterOwner = () => { ownerActive += 1; maximumOwnerActive = Math.max(maximumOwnerActive, ownerActive); };
    const leaveOwner = () => { ownerActive -= 1; };
    const ingestCurrentSession = vi.fn(async (source: { nativeSession?: { value?: string } }) => {
      enterOwner();
      leaveOwner();
      const sessionId = source.nativeSession?.value ?? "missing";
      return { laneId: `lane-${sessionId}`, sourceId: `stream-${sessionId}`, ingestedEvents: 0, caughtUp: true };
    });
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: `terminal-${binding.agentSessionValue}` })
    });

    await supervisor.reconcile();
    binding.agentSessionValue = "session-new";
    const transitioned = supervisor.reconcile();
    await transitioned;
    expect(ingestCurrentSession).toHaveBeenCalledTimes(2);
    expect(maximumOwnerActive).toBe(1);
    await supervisor.stop();
  });

  it("keeps retired pending reprojection diagnostics inert across ordinary and notified ingestion", async () => {
    const binding = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    const ingestCurrentSession = vi.fn(async () => ({ laneId: "lane-1", sourceId: "stream-1", ingestedEvents: 0, caughtUp: true }));
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" })
    });

    await supervisor.reconcile();
    await supervisor.reconcile();
    await supervisor.notifySources([{ sourceId: "stream-1", latestCursor: "cursor-2" }]);
    expect(supervisor.snapshot()).toMatchObject({ pendingReprojectionRuns: 0, pendingReprojectionNoPending: 0 });
  });

  it("bounds Core continuation pages within one wake", async () => {
    const binding = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    const ingestCurrentSession = vi.fn(async () => ({
      laneId: "lane-1", sourceId: "stream-1", ingestedEvents: 512, caughtUp: false
    }));
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" })
    });

    try {
      const outcome = await Promise.race([
        supervisor.reconcile().then(() => "resolved" as const),
        new Promise<"timed_out">((resolve) => setTimeout(() => resolve("timed_out"), 50))
      ]);
      expect(outcome).toBe("resolved");
      expect(ingestCurrentSession).toHaveBeenCalledTimes(8);
    } finally {
      await supervisor.stop();
    }
  });

  it.each(["traex", "pi"] as const)("ingests an exact %s Worker session under Worker and parent ownership fences", async (agentKind) => {
    const ingestCurrentSession = vi.fn(async () => ({ laneId: "worker-lane", sourceId: "worker-stream", ingestedEvents: 1, caughtUp: true }));
    const onWorkerIngested = vi.fn();
    const worker = {
      id: "worker-1", role: "worker", agentKind, generation: 4, workerSessionGeneration: 7,
      workerSessionLifecycle: "active", desiredState: "running", observedState: "idle",
      parent: { bindingId: "binding-1", bindingGeneration: 3, paneId: "w1:p1", nativeSessionId: "primary-session" },
      runtimeRef: { herdrWorkspaceId: "w1", paneId: "w1:p2", terminalId: "terminal-worker", nativeSessionId: "worker-session", generation: 4 }
    } as AgentInstance;
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [] },
      ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      workers: { listWorkerSessions: () => [worker] },
      resolveWorkerSource: (candidate) => resolveWorkerSessionIngestionSource(candidate, {
        getAgentInstance: () => worker,
        getBinding: () => ({ id: "binding-1", state: "active", generation: 3, paneId: "w1:p1" }) as Binding,
        getPane: async () => ({
          paneId: "w1:p2", terminalId: "terminal-worker", agentKind,
          agentSession: { source: `herdr:${agentKind}`, agent: agentKind, kind: "id", value: "worker-session" }
        }) as never
      }),
      onWorkerIngested
    });

    await supervisor.reconcile();
    expect(ingestCurrentSession).toHaveBeenCalledWith(expect.objectContaining({
      agentKind, bindingId: "worker-1", terminalId: "terminal-worker",
      nativeSession: expect.objectContaining({ source: `herdr:${agentKind}`, agent: agentKind, value: "worker-session" })
    }));
    expect(onWorkerIngested).toHaveBeenCalledWith("worker-1", "w1:p2");
    ingestCurrentSession.mockClear();
    onWorkerIngested.mockClear();

    await supervisor.notifySources([{ sourceId: "worker-stream", latestCursor: "worker-cursor-9" }]);

    expect(ingestCurrentSession).toHaveBeenCalledOnce();
    expect(ingestCurrentSession).toHaveBeenCalledWith(expect.objectContaining({ bindingId: "worker-1", paneId: "w1:p2" }));
    expect(onWorkerIngested).toHaveBeenCalledWith("worker-1", "w1:p2");
  });

  it("rejects a Worker route after its parent Binding generation changes", async () => {
    const worker = {
      id: "worker-1", role: "worker", agentKind: "traex", generation: 4, workerSessionGeneration: 7,
      workerSessionLifecycle: "active", desiredState: "running", observedState: "idle",
      parent: { bindingId: "binding-1", bindingGeneration: 3, paneId: "w1:p1", nativeSessionId: "primary-session" },
      runtimeRef: { herdrWorkspaceId: "w1", paneId: "w1:p2", nativeSessionId: "worker-session", generation: 4 }
    } as AgentInstance;

    await expect(resolveWorkerSessionIngestionSource(worker, {
      getAgentInstance: () => worker,
      getBinding: () => ({ generation: 4, paneId: "w1:p1" }) as Binding,
      getPane: vi.fn()
    })).resolves.toBeNull();
  });

  it("rejects a Worker route whose generation changes during Pane resolution", async () => {
    const candidate = {
      id: "worker-1", role: "worker", agentKind: "traex", generation: 4, workerSessionGeneration: 7,
      workerSessionLifecycle: "active", desiredState: "running", observedState: "idle",
      parent: { bindingId: "binding-1", bindingGeneration: 3, paneId: "w1:p1", nativeSessionId: "primary-session" },
      runtimeRef: { herdrWorkspaceId: "w1", paneId: "w1:p2", nativeSessionId: "worker-session", generation: 4 }
    } as AgentInstance;
    let current = candidate;

    await expect(resolveWorkerSessionIngestionSource(candidate, {
      getAgentInstance: () => current,
      getBinding: () => ({ generation: 3, paneId: "w1:p1" }) as Binding,
      getPane: async () => {
        current = { ...candidate, generation: 5 } as AgentInstance;
        return { paneId: "w1:p2", terminalId: "terminal-worker", agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "worker-session" } } as never;
      }
    })).resolves.toBeNull();
  });

  it("rejects a Primary route whose Binding generation changes during Pane resolution", async () => {
    const candidate = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    let current = candidate;

    await expect(resolvePrimarySessionIngestionSource(candidate, {
      getBinding: () => current,
      getPane: async () => {
        current = { ...candidate, generation: 4 } as Binding;
        return { paneId: "w1:p1", terminalId: "terminal-1", agentKind: "traex", agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" } } as never;
      }
    })).resolves.toBeNull();
  });

  it("does not invent a speculative card when unmatched canonical evidence predates admission", () => {
    const stores = createTestStoreBundle();
    stores.coreEvents.ingestBatch({
      laneId: "session-lane", sourceId: "stream-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: "start", nextCursor: "cursor-1", latestCursor: "cursor-1", ingestedAt: "2026-10-04T12:00:01.000Z",
      events: [{
        schemaVersion: 1, eventId: "human-before-card", cursor: "cursor-1", sourceId: "stream-1",
        agentKind: "traex", sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-04T12:00:01.000Z",
        payload: { type: "human_message", message_id: "message-1", text: "continue", truncated: false, submission_id: "submission-late" }
      }]
    });
    stores.agentInputs.admit({
      submissionId: "submission-late", ingressSource: "feishu:primary", sourceMessageKey: "message-late",
      actor: { kind: "human", id: "user-1", gatewayId: "feishu:primary", chatId: "chat-1", topicId: "topic-1", rootMessageId: "root-1" },
      text: "continue", owner: { kind: "primary", id: "binding-1", generation: 1 }, paneId: "w1:p1", terminalId: "terminal-1",
      expectedAgentKind: "traex", expectedSessionId: "session-1", recordedAt: "2026-10-04T12:00:02.000Z"
    });

    expect(stores.agentInputs.reconcileCanonicalHumanMessages(10)).toBe(0);
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM input_card_views").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT state,human_event_id,root_message_id FROM conversation_segments WHERE submission_id=?").get("submission-late"))
      .toEqual({ state: "working", human_event_id: "human-before-card", root_message_id: "" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key LIKE 'turn-card:%'").get()).toEqual({ count: 0 });
  });

  it("uses only a complete exact-turn snapshot and preserves hidden-event positions in a recovered Turn Card", async () => {
    const stores = createTestStoreBundle();
    activatePrimary(stores);
    stores.agentInputs.admit({
      submissionId: "submission-expired", ingressSource: "feishu:primary", sourceMessageKey: "message-expired",
      actor: { kind: "human", id: "user-1", gatewayId: "feishu:primary", chatId: "chat-1", topicId: "topic-1", rootMessageId: "root-1" },
      text: "recover", owner: { kind: "primary", id: "binding-1", generation: 1 }, paneId: "w1:p1", terminalId: "terminal-1",
      expectedAgentKind: "traex", expectedSessionId: "session-1", recordedAt: "2026-10-04T12:00:00.000Z"
    });
    stores.agentInputs.claimRecorded("submission-expired", "2026-10-04T12:00:00.500Z");
    stores.agentInputs.recordReceipt("submission-expired", {
      submissionId: "submission-expired", paneId: "w1:p1", terminalId: "terminal-1", agentKind: "traex",
      sessionId: "session-1", state: "observed", turnId: "turn-1", startedAt: "2026-10-04T12:00:01.000Z",
      terminalState: null, createdAt: 1, updatedAt: 2
    });
    const retainedHuman = { schemaVersion: 1 as const, eventId: "human-recovered", cursor: "live-1", sourceId: "recovery-source", agentKind: "traex" as const, sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-04T12:00:01.100Z", payload: { type: "human_message" as const, messageId: "message-expired", text: "recover", truncated: false, submissionId: "submission-expired" } };
    const retainedProgress = { schemaVersion: 1 as const, eventId: "progress-retained", cursor: "live-2", sourceId: "recovery-source", agentKind: "traex" as const, sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-04T12:00:01.300Z", payload: { type: "message" as const, messageId: "progress-message", channel: "analysis" as const, text: "still working", truncated: false } };
    stores.coreEvents.ingestBatch({
      laneId: "live-session", sourceId: "recovery-source", agentKind: "traex", sessionId: "session-1",
      afterCursor: "", nextCursor: "live-2", latestCursor: "live-2", events: [
        { ...retainedHuman, payload: { type: "human_message" as const, message_id: "message-expired", text: "recover", truncated: false, submission_id: "submission-expired" } },
        { ...retainedProgress, payload: { type: "message" as const, message_id: "progress-message", channel: "analysis", text: "still working", truncated: false } }
      ],
      ingestedAt: "2026-10-04T12:00:01.400Z"
    });
    expect(stores.agentInputs.listPendingCanonicalRecoveries()).toHaveLength(1);
    const events = {
      async supportsSessionEventStream() { return true; },
      async recoverTurn() { return {
        outcome: "recovered" as const, canonicalStartedAt: "2026-10-04T12:00:01.000Z", nextCursor: "recovery-1", latestCursor: "recovery-1", complete: true,
        events: [
          { schemaVersion: 1 as const, eventId: "turn-start", cursor: "recovery-0", sourceId: "recovery-source", agentKind: "traex" as const, sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-04T12:00:01.000Z", payload: { type: "turn_started" as const } },
          retainedHuman,
          retainedProgress,
          { schemaVersion: 1 as const, eventId: "assistant-recovered", cursor: "recovery-2", sourceId: "recovery-source", agentKind: "traex" as const, sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-04T12:00:01.500Z", payload: { type: "message" as const, messageId: "assistant-message", channel: "final" as const, text: "recovered final answer", truncated: false } },
          { schemaVersion: 1 as const, eventId: "turn-end", cursor: "recovery-3", sourceId: "recovery-source", agentKind: "traex" as const, sessionId: "session-1", turnId: "turn-1", occurredAt: "2026-10-04T12:00:02.000Z", payload: { type: "turn_completed" as const } }
        ]
      }; }
    } as unknown as HerdrEventsPort;
    const reader = new HerdrEventsReader(events, { async listAllPanes() { return []; } }, async () => null, stores.coreEvents, {}, stores.turnSnapshots);
    const source = { agentKind: "traex" as const, bindingId: "binding-1", generation: 1, paneId: "w1:p1", terminalId: "terminal-1", nativeSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" } };

    await expect(reader.recoverCanonicalTurn(source, "turn-1", "2026-10-04T12:00:01.000Z")).resolves.toBe("recovered");
    stores.agentInputs.recordCanonicalRecoveryOutcome("submission-expired", "recovered", "2026-10-04T12:00:03.000Z");
    expect(stores.driver.database.prepare("SELECT state,human_event_id FROM conversation_segments WHERE submission_id=?").get("submission-expired"))
      .toEqual({ state: "completed", human_event_id: "human-recovered" });
    expect(stores.driver.database.prepare("SELECT item_json FROM conversation_segment_items WHERE segment_id=? AND item_id=?")
      .get("segment:submission-expired", "message:assistant-message"))
      .toEqual({ item_json: expect.stringContaining("recovered final answer") });
    expect(stores.driver.database.prepare("SELECT lane_sequence FROM conversation_segment_items WHERE segment_id=? AND item_id=?")
      .get("segment:submission-expired", "message:assistant-message")).toEqual({ lane_sequence: 3 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_items WHERE segment_id=? AND item_json LIKE '%still working%'")
      .get("segment:submission-expired")).toEqual({ count: 0 });
    expect(stores.agentInputs.listPendingCanonicalRecoveries()).toEqual([]);
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM input_card_views").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key='turn-card:segment:submission-expired:page:0'").get()).toEqual({ count: 1 });

    await expect(reader.recoverCanonicalTurn(source, "turn-1", "2026-10-04T12:00:01.000Z")).resolves.toBe("recovered");
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_items WHERE segment_id=? AND item_id=?")
      .get("segment:submission-expired", "message:assistant-message")).toEqual({ count: 1 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key='turn-card:segment:submission-expired:page:0'").get()).toEqual({ count: 1 });
  });

  it("reports not ready when a pending Primary Input has no viable exact session route", async () => {
    const binding = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    let required = true;
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] },
      ingestor: { ingestCurrentSession: vi.fn() }, onIngested: vi.fn(),
      resolveSource: async () => null,
      requiresIngestion: () => required
    });

    await supervisor.reconcile();
    expect(supervisor.snapshot()).toMatchObject({ ready: false, requiredFailures: 1, activeSessions: 0 });
    required = false;
    await supervisor.reconcile();
    expect(supervisor.snapshot()).toMatchObject({
      ready: true, state: "idle", awaitingSessions: 0, laggingSessions: 1,
      requiredFailures: 0, lastFailureCode: "route_unavailable"
    });
  });

  it("does not ingest when an exact live pane route is unavailable", async () => {
    const binding = {
      id: "binding-history", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-history"
    } as Binding;
    const ingestCurrentSession = vi.fn();
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async () => null
    });

    await supervisor.reconcile();

    expect(ingestCurrentSession).not.toHaveBeenCalled();
    expect(supervisor.snapshot()).toMatchObject({ pendingReprojectionRuns: 0, pendingReprojectedEvents: 0 });
  });

  it("does not let a route-unavailable owner consume exact ingestion concurrency", async () => {
    const exactBindings = Array.from({ length: 4 }, (_, index) => ({
      id: `binding-${index}`, state: "active", generation: 3, paneId: `w1:p${index}`, agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: `session-${index}`
    })) as Binding[];
    const historical = {
      id: "binding-history", state: "active", generation: 3, paneId: "w1:history", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-history"
    } as Binding;
    const bindings = [...exactBindings, historical];
    let releaseExact!: () => void;
    const exactHeld = new Promise<void>((resolve) => { releaseExact = resolve; });
    let active = 0;
    let maximumActive = 0;
    const enter = () => { active += 1; maximumActive = Math.max(maximumActive, active); };
    const leave = () => { active -= 1; };
    const ingestCurrentSession = vi.fn(async (source: { bindingId: string }) => {
      enter();
      await exactHeld;
      leave();
      return { laneId: `lane-${source.bindingId}`, sourceId: `stream-${source.bindingId}`, ingestedEvents: 0, caughtUp: true };
    });
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => bindings }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async (binding) => binding.id === historical.id ? null : ({ ...bindingSource(binding), terminalId: `terminal-${binding.id}` })
    });

    const scan = supervisor.reconcile();
    await vi.waitFor(() => expect(ingestCurrentSession).toHaveBeenCalledTimes(4));
    releaseExact();
    await scan;

    expect(maximumActive).toBe(4);
  });

  it("stops cleanly with an unavailable exact route", async () => {
    const binding = {
      id: "binding-history", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-history"
    } as Binding;
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession: vi.fn() }, onIngested: vi.fn(), resolveSource: async () => null
    });

    await supervisor.reconcile();
    await supervisor.stop();
    expect(supervisor.snapshot()).toMatchObject({ state: "stopped", pendingReprojections: 0, activeIngestionPermits: 0 });
  });

  it("reports awaiting_session before the first native session without weakening required-route readiness", async () => {
    const binding = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: null, agentSessionAgent: null, agentSessionKind: null, agentSessionValue: null
    } as Binding;
    let required = false;
    let exactSource = false;
    const ingestCurrentSession = vi.fn(async () => ({ laneId: "lane-1", ingestedEvents: 0, caughtUp: true }));
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async () => exactSource ? ({ ...bindingSource(binding), terminalId: "terminal-1" }) : null,
      requiresIngestion: () => required
    });

    await supervisor.reconcile();
    expect(supervisor.snapshot()).toMatchObject({
      ready: true, state: "awaiting_session", activeSessions: 0, awaitingSessions: 1,
      laggingSessions: 0, oldestLagAgeSeconds: null, requiredFailures: 0,
      lastFailureAt: null, lastFailureCode: null, lastFailure: null
    });

    required = true;
    await supervisor.reconcile();
    expect(supervisor.snapshot()).toMatchObject({
      ready: false, state: "idle", activeSessions: 0, awaitingSessions: 0,
      laggingSessions: 1, requiredFailures: 1, lastFailureCode: "route_unavailable"
    });

    required = false;
    exactSource = true;
    binding.agentSessionSource = "herdr:traex";
    binding.agentSessionAgent = "traex";
    binding.agentSessionKind = "id";
    binding.agentSessionValue = "session-1";
    await supervisor.reconcile();
    expect(ingestCurrentSession).toHaveBeenCalledOnce();
    expect(supervisor.snapshot()).toMatchObject({
      ready: true, state: "idle", activeSessions: 1, awaitingSessions: 0,
      laggingSessions: 0, oldestLagAgeSeconds: null, requiredFailures: 0
    });
  });

  it("enters awaiting_session immediately when a stale ingestion retry loses its native session", async () => {
    const binding = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    const ingestCurrentSession = vi.fn().mockRejectedValue(new Error("Core unavailable"));
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async () => binding.agentSessionValue ? ({ ...bindingSource(binding), terminalId: "terminal-1" }) : null,
      requiresIngestion: () => false, retryBaseMs: 60_000
    });

    await supervisor.reconcile();
    expect(supervisor.snapshot()).toMatchObject({
      state: "idle", awaitingSessions: 0, laggingSessions: 1, retryingSessions: 1,
      lastFailureCode: "session_ingestion_failed"
    });

    binding.agentSessionSource = null;
    binding.agentSessionAgent = null;
    binding.agentSessionKind = null;
    binding.agentSessionValue = null;
    await supervisor.reconcile();
    expect(ingestCurrentSession).toHaveBeenCalledOnce();
    expect(supervisor.snapshot()).toMatchObject({
      ready: true, state: "awaiting_session", activeSessions: 0, awaitingSessions: 1,
      laggingSessions: 0, oldestLagAgeSeconds: null, requiredFailures: 0,
      retryingSessions: 0, maxRetryAttempt: 0, nextRetryAt: null
    });
  });

  it("backs off a failed required session and exposes bounded typed lag diagnostics", async () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-10-04T12:00:00.000Z"));
    const binding = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    const ingestCurrentSession = vi.fn()
      .mockRejectedValueOnce(Object.assign(new Error("Core session event cursor expired"), { name: "CoreSessionCursorExpiredError" }))
      .mockResolvedValue({ laneId: "lane-1", ingestedEvents: 1, caughtUp: true });
    let required = true;
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" }),
      requiresIngestion: () => required, retryBaseMs: 100, retryMaxMs: 400
    });

    try {
      await supervisor.reconcile();
      expect(supervisor.snapshot()).toMatchObject({
        ready: false, runCount: 1, laggingSessions: 1, oldestLagAgeSeconds: 0,
        retryingSessions: 1, maxRetryAttempt: 1, nextRetryAt: "2026-10-04T12:00:00.100Z",
        lastFailureCode: "cursor_expired"
      });

      required = false;
      await supervisor.reconcile();
      expect(ingestCurrentSession).toHaveBeenCalledTimes(1);
      expect(supervisor.snapshot()).toMatchObject({ ready: true, runCount: 2, retryingSessions: 1 });

      await vi.advanceTimersByTimeAsync(100);
      await supervisor.reconcile();
      expect(ingestCurrentSession).toHaveBeenCalledTimes(2);
      expect(supervisor.snapshot()).toMatchObject({
        ready: true, runCount: 3, laggingSessions: 0, oldestLagAgeSeconds: null,
        retryingSessions: 0, maxRetryAttempt: 0, nextRetryAt: null,
        lastSuccessfulIngestAt: "2026-10-04T12:00:00.100Z"
      });
    } finally {
      vi.useRealTimers();
    }
  });

  it("cools down only an unrecoverable-cursor owner until a source notification releases it", async () => {
    vi.useFakeTimers();
    const bindings = ["broken", "healthy"].map((id) => ({
      id, state: "active", generation: 3, paneId: `w1:${id}`, agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: `session-${id}`
    })) as Binding[];
    let brokenFails = true;
    const ingestCurrentSession = vi.fn(async (source: { bindingId: string }) => {
      if (source.bindingId === "broken" && brokenFails) {
        throw new CoreSessionUnrecoverableCursorError({
          laneId: "broken-lane", sourceId: "broken-ring", sourceEpoch: "epoch-1", agentKind: "traex",
          sessionId: "session-broken", readCursor: "broken-ring:epoch-1:7", owner: { kind: "binding", id: "broken" }
        });
      }
      return { laneId: `${source.bindingId}-lane`, sourceId: `${source.bindingId}-ring`, ingestedEvents: 1, caughtUp: true };
    });
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => bindings }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async (binding) => ({ ...bindingSource(binding), terminalId: `terminal-${binding.id}` }),
      requiresIngestion: (_kind, ownerId) => ownerId === "broken", pollIntervalMs: 10
    });

    try {
      await supervisor.reconcile();
      expect(ingestCurrentSession).toHaveBeenCalledTimes(2);
      expect(supervisor.snapshot()).toMatchObject({
        ready: false, laggingSessions: 1, retryingSessions: 0, requiredFailures: 1, lastFailureCode: "unrecoverable_cursor"
      });

      supervisor.start(10);
      await vi.advanceTimersByTimeAsync(100);
      expect(ingestCurrentSession.mock.calls.filter(([source]) => source.bindingId === "broken")).toHaveLength(1);
      expect(ingestCurrentSession.mock.calls.filter(([source]) => source.bindingId === "healthy").length).toBeGreaterThan(1);

      brokenFails = false;
      await supervisor.notifySources([{ sourceId: "broken-ring", latestCursor: "broken-ring:epoch-1:8" }]);
      expect(ingestCurrentSession.mock.calls.filter(([source]) => source.bindingId === "broken")).toHaveLength(2);
      expect(ingestCurrentSession).toHaveBeenLastCalledWith(expect.objectContaining({ bindingId: "broken" }));
      expect(supervisor.snapshot()).toMatchObject({ ready: true, laggingSessions: 0, retryingSessions: 0 });
    } finally {
      await supervisor.stop();
      vi.useRealTimers();
    }
  });

  it("isolates route-resolution failure so another exact session still ingests", async () => {
    const bindings = ["broken", "healthy"].map((id) => ({
      id, state: "active", generation: 1, paneId: `w1:${id}`, agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: `session-${id}`
    })) as Binding[];
    const ingestCurrentSession = vi.fn(async () => ({ laneId: "healthy-lane", ingestedEvents: 1, caughtUp: true }));
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => bindings }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async (binding) => {
        if (binding.id === "broken") throw new Error("Core identity lookup failed");
        return { ...bindingSource(binding), terminalId: "terminal-healthy" };
      },
      requiresIngestion: (_kind, ownerId) => ownerId === "broken"
    });

    await expect(supervisor.reconcile()).resolves.toBeUndefined();
    expect(ingestCurrentSession).toHaveBeenCalledTimes(1);
    expect(ingestCurrentSession).toHaveBeenCalledWith(expect.objectContaining({ bindingId: "healthy" }));
    expect(supervisor.snapshot()).toMatchObject({
      ready: false, activeSessions: 1, laggingSessions: 1, requiredFailures: 1,
      lastFailureCode: "route_resolution_failed", lastFailure: "Core identity lookup failed"
    });
  });

  it("fails readiness when a pending Input appears during session backoff", async () => {
    const binding = {
      id: "binding-1", state: "active", generation: 3, paneId: "w1:p1", agentKind: "traex",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
    } as Binding;
    let required = false;
    const ingestCurrentSession = vi.fn().mockRejectedValue(new Error("Core unavailable"));
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [binding] }, ingestor: { ingestCurrentSession }, onIngested: vi.fn(),
      resolveSource: async () => ({ ...bindingSource(binding), terminalId: "terminal-1" }),
      requiresIngestion: () => required, retryBaseMs: 60_000
    });

    await supervisor.reconcile();
    expect(supervisor.snapshot()).toMatchObject({ ready: true, retryingSessions: 1, requiredFailures: 0 });
    required = true;
    await supervisor.reconcile();
    expect(ingestCurrentSession).toHaveBeenCalledTimes(1);
    expect(supervisor.snapshot()).toMatchObject({ ready: false, retryingSessions: 1, requiredFailures: 1 });
  });

  it("does not block readiness on legacy canonical recovery ambiguity", async () => {
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [] }, ingestor: { ingestCurrentSession: vi.fn() }, onIngested: vi.fn(),
      recoverCanonicalTurns: async () => ({ indexing: 0, needsHuman: 2, lastFailureCode: "recovery_ambiguous" as const })
    });

    await supervisor.reconcile();

    expect(supervisor.snapshot()).toMatchObject({
      ready: true, recoveryState: "idle", indexingRecoveries: 0, needsHumanRecoveries: 0
    });
  });

  it("releases a rejected scan so canonical recovery can be retried without an unhandled rejection", async () => {
    const recoverCanonicalTurns = vi.fn()
      .mockRejectedValueOnce(new Error("malformed historical projection"))
      .mockResolvedValueOnce({ indexing: 0, needsHuman: 0, lastFailureCode: null });
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [] }, ingestor: { ingestCurrentSession: vi.fn() }, onIngested: vi.fn(),
      recoverCanonicalTurns
    });

    await expect(supervisor.reconcile()).rejects.toThrow("malformed historical projection");
    await expect(supervisor.reconcile()).resolves.toBeUndefined();

    expect(recoverCanonicalTurns).toHaveBeenCalledTimes(2);
  });

  it("scans legacy Input Card retirement after canonical reconciliation and wakes delivery", async () => {
    const reconcileCanonicalHumanMessages = vi.fn(() => 1);
    const retireLegacyInputCards = vi.fn(() => 1);
    const wakeOutbound = vi.fn();
    const supervisor = new CoreSessionIngestionSupervisor({
      routes: { listBindingsByState: () => [] }, ingestor: { ingestCurrentSession: vi.fn() }, onIngested: vi.fn(),
      reconcileCanonicalHumanMessages, retireLegacyInputCards, wakeOutbound
    });

    await supervisor.reconcile();

    expect(reconcileCanonicalHumanMessages).toHaveBeenCalledOnce();
    expect(retireLegacyInputCards).toHaveBeenCalledWith(100);
    expect(reconcileCanonicalHumanMessages.mock.invocationCallOrder[0]).toBeLessThan(retireLegacyInputCards.mock.invocationCallOrder[0]!);
    expect(wakeOutbound).toHaveBeenCalledOnce();
  });
});

function activatePrimary(stores: ReturnType<typeof createTestStoreBundle>): void {
  stores.driver.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "chat-1", topicId: "topic-1", rootMessageId: "root-1", title: "Task" });
  stores.driver.updateBinding("binding-1", {
    state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1",
    agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1"
  });
}

function bindingSource(binding: Binding) {
  return {
    agentKind: binding.agentKind, bindingId: binding.id, generation: binding.generation, paneId: binding.paneId,
    nativeSession: binding.agentSessionValue ? { source: binding.agentSessionSource!, agent: binding.agentSessionAgent!, kind: "id" as const, value: binding.agentSessionValue } : null
  };
}
