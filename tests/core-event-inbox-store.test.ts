import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import type { CoreEventEnvelope } from "../src/domain/core-event-inbox.js";
import { createTestStoreBundle, type TestStoreBundle } from "./helpers/create-test-store-bundle.js";
import { initialTopicView, updateTopicView } from "../src/domain/topic-view.js";
import { SqliteContext } from "../src/store/sqlite/context.js";
import { SqliteMigrations } from "../src/store/sqlite/migrations.js";
import { SqliteCoreEventInboxStore } from "../src/store/sqlite/core-event-inbox-store.js";
import { coreEventDiscriminatorSql } from "../src/store/sqlite/core-event-discriminators.js";
import { DeliveryLatencyTrace } from "../src/domain/delivery-trace.js";

function event(overrides: Partial<CoreEventEnvelope> = {}): CoreEventEnvelope {
  return {
    schemaVersion: 1,
    eventId: "stable-event-1",
    cursor: "live-source:1",
    sourceId: "live-source",
    agentKind: "traex",
    sessionId: "session-1",
    turnId: "turn-1",
    occurredAt: "2026-09-30T00:00:00.000Z",
    payload: { type: "message", message_id: "message-1", channel: "final", text: "answer", truncated: false },
    ...overrides
  };
}

function batch(laneId: string, item: CoreEventEnvelope, afterCursor: string, nextCursor: string) {
  return {
    laneId,
    sourceId: item.sourceId,
    agentKind: item.agentKind,
    sessionId: item.sessionId,
    afterCursor,
    nextCursor,
    latestCursor: nextCursor,
    events: [item],
    ingestedAt: "2026-09-30T00:00:01.000Z"
  } as const;
}

function admitTerminalAliasIntent(stores: TestStoreBundle, input: {
  submissionId: string;
  sourceMessageKey: string;
  actorId?: string;
  text?: string;
  choice?: { actionSetId: string; optionId: string; sourceMessageId: string };
  recordedAt?: string;
  turnId?: string;
  terminalState?: string;
}): void {
  const recordedAt = input.recordedAt ?? "2026-09-29T23:59:58.000Z";
  stores.agentInputs.admit({
    submissionId: input.submissionId,
    ingressSource: "feishu:primary",
    sourceMessageKey: input.sourceMessageKey,
    actor: { kind: "human", id: input.actorId ?? "user-1", gatewayId: "feishu:primary", chatId: "chat-1", topicId: "topic-1", rootMessageId: "root-1" },
    text: input.text ?? "request",
    ...(input.choice ? { input: { schemaVersion: 2, text: input.text ?? "request", choice: input.choice } } : {}),
    owner: { kind: "primary", id: "binding-1", generation: 1 },
    paneId: "w1:p1",
    terminalId: "terminal-1",
    expectedAgentKind: "traex",
    expectedSessionId: "session-1",
    recordedAt
  });
  stores.agentInputs.claimRecorded(input.submissionId, recordedAt);
  stores.agentInputs.recordReceipt(input.submissionId, {
    submissionId: input.submissionId, paneId: "w1:p1", terminalId: "terminal-1", agentKind: "traex", sessionId: "session-1",
    state: "terminal", turnId: input.turnId ?? "turn-1", startedAt: "2026-09-30T00:00:00.000Z", terminalState: input.terminalState ?? "completed",
    createdAt: Date.parse(recordedAt), updatedAt: Date.parse(recordedAt) + 1
  });
}

function countPreparedStatementExecutions(context: SqliteContext): Map<string, number> {
  const counts = new Map<string, number>();
  const database = context.database as unknown as { prepare(sql: string): object };
  const prepare = database.prepare.bind(database);
  database.prepare = (sql: string) => {
    const statement = prepare(sql) as Record<string, unknown>;
    return new Proxy(statement, {
      get(target, property) {
        const value = Reflect.get(target, property, target);
        if (typeof value !== "function") return value;
        if (property !== "get" && property !== "all" && property !== "run" && property !== "iterate") return value.bind(target);
        return (...args: unknown[]) => {
          counts.set(sql, (counts.get(sql) ?? 0) + 1);
          return value.apply(target, args);
        };
      }
    });
  };
  return counts;
}

function countSql(counts: Map<string, number>, fragment: string): number {
  return [...counts].reduce((total, [sql, count]) => total + (sql.includes(fragment) ? count : 0), 0);
}

function countStatementPreparations(context: SqliteContext): Map<string, number> {
  const counts = new Map<string, number>();
  const database = context.database as unknown as { prepare(sql: string): object };
  const prepare = database.prepare.bind(database);
  database.prepare = (sql: string) => {
    counts.set(sql, (counts.get(sql) ?? 0) + 1);
    return prepare(sql);
  };
  return counts;
}

describe("Core event inbox store", () => {
  it("signals committed pending lane work only after the outer transaction commits", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const inbox = new SqliteCoreEventInboxStore(context);
    const wakes = vi.fn();
    inbox.onPendingWorkCommitted(wakes);
    const pending = event({ eventId: "wake-pending", cursor: "wake:1" });
    const secondPending = event({ eventId: "wake-pending-second", cursor: "wake:2" });
    const pendingBatch = { ...batch("lane-wake", pending, "start", secondPending.cursor), events: [pending, secondPending] };
    const ignored = event({ eventId: "wake-ignored", cursor: "wake:2", payload: { type: "source_error", code: "runtime_identity_changed" } });
    const database = context.database as unknown as { exec(sql: string): void };
    const execute = database.exec.bind(database);
    let rejectCommit = true;
    database.exec = (sql) => {
      if (rejectCommit && sql === "COMMIT") {
        rejectCommit = false;
        throw new Error("simulated outer commit failure");
      }
      execute(sql);
    };

    expect(() => inbox.ingestBatch(pendingBatch)).toThrow("simulated outer commit failure");
    expect(wakes).not.toHaveBeenCalled();
    expect(inbox.ingestBatch(pendingBatch)).toBe("accepted");
    expect(wakes).toHaveBeenCalledOnce();
    expect(inbox.ingestBatch(pendingBatch)).toBe("stale_rebase");
    expect(inbox.ingestBatch({ ...batch("lane-wake", pending, secondPending.cursor, secondPending.cursor), events: [] })).toBe("accepted");
    expect(inbox.ingestBatch(batch("lane-ignored-wake", ignored, "start", ignored.cursor))).toBe("accepted");
    expect(wakes).toHaveBeenCalledOnce();
    context.close();
  });

  it("does not signal lane work settled before the outer transaction commits", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const inbox = new SqliteCoreEventInboxStore(context);
    const wakes = vi.fn();
    inbox.onPendingWorkCommitted(wakes);
    const settled = event({ eventId: "wake-settled", cursor: "wake-settled:1" });

    context.transaction("test.settle-before-commit", () => {
      expect(inbox.ingestBatch(batch("lane-wake-settled", settled, "start", settled.cursor))).toBe("accepted");
      expect(inbox.acknowledge(
        "lane-wake-settled", [settled.eventId], "projected", "2026-09-30T00:00:02.000Z"
      )).toBe("settled");
      expect(wakes).not.toHaveBeenCalled();
    });

    expect(wakes).not.toHaveBeenCalled();
    expect(context.database.prepare("SELECT state FROM core_event_lane_items WHERE lane_id=? AND event_id=?")
      .get("lane-wake-settled", settled.eventId)).toEqual({ state: "projected" });
    context.close();
  });

  it("retains snapshot source diagnostics without projecting conversation content", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const projected: string[] = [];
    const inbox = new SqliteCoreEventInboxStore(context, {
      projectCanonicalEvent: ({ event: item }) => projected.push(item.eventId)
    });
    const diagnostic = event({
      eventId: "snapshot-runtime-diagnostic", cursor: "snapshot:1", turnId: null,
      payload: { type: "source_error", code: "runtime_identity_changed" }
    });

    expect(inbox.ingestCanonicalSnapshotEvidence([diagnostic], "2026-10-17T00:00:00.000Z")).toBe(0);

    expect(context.database.prepare("SELECT event_type FROM core_event_inbox WHERE event_id=?").get(diagnostic.eventId))
      .toEqual({ event_type: "source_error" });
    expect(projected).toEqual([]);
    context.close();
  });

  it("stores source diagnostics as ignored evidence and advances to a healthy neighbour", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const projected: string[] = [];
    const inbox = new SqliteCoreEventInboxStore(context, {
      projectCanonicalEvent: ({ event: item }) => {
        if ((item.payload as { type?: string }).type === "source_error") throw new Error("source diagnostic is not conversation content");
        projected.push(item.eventId);
      }
    });
    const diagnostic = event({
      eventId: "runtime-identity-diagnostic", cursor: "runtime:1", turnId: null,
      payload: { type: "source_error", code: "runtime_identity_changed" }
    });
    const healthy = event({ eventId: "healthy-neighbour", cursor: "runtime:2", payload: { type: "turn_started" } });

    expect(() => inbox.ingestBatch({
      ...batch("lane-runtime-recovery", diagnostic, "start", healthy.cursor),
      events: [diagnostic, healthy]
    })).not.toThrow();

    expect(context.database.prepare(`SELECT event_id,state FROM core_event_lane_items
      WHERE lane_id='lane-runtime-recovery' ORDER BY sequence`).all()).toEqual([
      { event_id: diagnostic.eventId, state: "ignored" },
      { event_id: healthy.eventId, state: "pending" }
    ]);
    expect(context.database.prepare("SELECT event_type FROM core_event_inbox WHERE event_id=?").get(diagnostic.eventId))
      .toEqual({ event_type: "source_error" });
    expect(inbox.getCheckpoint("lane-runtime-recovery")).toMatchObject({ readCursor: healthy.cursor, latestCursor: healthy.cursor });
    expect(projected).toEqual([healthy.eventId]);
    expect(inbox.loadPending("lane-runtime-recovery").eventIds).toEqual([healthy.eventId]);
    context.close();
  });

  it("dual-writes normalized discriminators without changing the authoritative event JSON", () => {
    const stores = createTestStoreBundle(":memory:");
    const items = [
      event({ eventId: "normalized-human", cursor: "n:1", payload: { type: "human_message", message_id: "m1", text: "hello", truncated: false, submission_id: "submission-1" } }),
      event({ eventId: "normalized-message", cursor: "n:2", payload: { type: "message", message_id: "m2", channel: "final", text: "answer", truncated: false } }),
      event({ eventId: "normalized-tool", cursor: "n:3", payload: { type: "tool_result", call_id: "call-1", text: "ok", is_error: false, truncated: false } }),
      event({ eventId: "normalized-turn", cursor: "n:4", payload: { type: "turn_started" } })
    ];
    stores.coreEvents.ingestBatch({ ...batch("lane-normalized", items[0]!, "start", "n:4"), events: items });

    expect(stores.driver.database.prepare(`SELECT event_id,event_type,submission_id,channel,call_id
      FROM core_event_inbox ORDER BY event_id`).all()).toEqual([
      { event_id: "normalized-human", event_type: "human_message", submission_id: "submission-1", channel: null, call_id: null },
      { event_id: "normalized-message", event_type: "message", submission_id: null, channel: "final", call_id: null },
      { event_id: "normalized-tool", event_type: "tool_result", submission_id: null, channel: null, call_id: "call-1" },
      { event_id: "normalized-turn", event_type: "turn_started", submission_id: null, channel: null, call_id: null }
    ]);
    expect(JSON.parse((stores.driver.database.prepare("SELECT event_json FROM core_event_inbox WHERE event_id='normalized-human'").get() as { event_json: string }).event_json)).toEqual(items[0]);
    stores.lifecycle.close();
  });

  it("resumes bounded discriminator backfill and activates one all-or-nothing read mode", () => {
    const stores = createTestStoreBundle(":memory:");
    const items = [
      event({ eventId: "backfill-a", cursor: "b:1", payload: { type: "turn_started" } }),
      event({ eventId: "backfill-b", cursor: "b:2", payload: { type: "message", message_id: "m", channel: "final", text: "ok", truncated: false } })
    ];
    stores.coreEvents.ingestBatch({ ...batch("lane-backfill", items[0]!, "start", "b:2"), events: items });
    const malformed = event({ eventId: "backfill-c", cursor: "b:3", payload: 42 });
    stores.driver.database.prepare(`INSERT INTO core_event_inbox(
      event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at
    ) VALUES(?,?,?,?,?,?,?,?,?)`).run(
      malformed.eventId, malformed.sourceId, malformed.agentKind, malformed.sessionId, malformed.turnId,
      malformed.cursor, malformed.occurredAt, JSON.stringify(malformed), malformed.occurredAt
    );
    stores.driver.database.exec(`UPDATE core_event_inbox SET event_type=NULL,submission_id=NULL,channel=NULL,call_id=NULL;
      UPDATE core_event_discriminator_backfill SET state='backfilling',high_water_event_id='backfill-c',after_event_id='',processed_count=0;`);

    expect(coreEventDiscriminatorSql(stores.driver.database, "i", "event_type")).toContain("json_extract");
    expect(stores.coreEvents.backfillDiscriminators(1, "2026-10-08T00:00:01.000Z")).toEqual({ state: "backfilling", processed: 1, remaining: true });
    expect(stores.driver.database.prepare("SELECT after_event_id,processed_count,state FROM core_event_discriminator_backfill").get())
      .toEqual({ after_event_id: "backfill-a", processed_count: 1, state: "backfilling" });
    expect(stores.coreEvents.backfillDiscriminators(1, "2026-10-08T00:00:02.000Z")).toEqual({ state: "backfilling", processed: 1, remaining: true });
    expect(stores.coreEvents.backfillDiscriminators(1, "2026-10-08T00:00:03.000Z")).toEqual({ state: "complete", processed: 1, remaining: false });
    expect(coreEventDiscriminatorSql(stores.driver.database, "i", "event_type")).toBe("i.event_type");
    expect(stores.driver.database.prepare("SELECT event_type,channel FROM core_event_inbox WHERE event_id='backfill-c'").get())
      .toEqual({ event_type: null, channel: null });
    const eventType = coreEventDiscriminatorSql(stores.driver.database, "i", "event_type");
    const plan = stores.driver.database.prepare(`EXPLAIN QUERY PLAN SELECT i.event_id FROM core_event_inbox i
      WHERE ${eventType}='message' AND i.agent_kind='traex' AND i.session_id='session-1' AND i.turn_id='turn-1'
      ORDER BY i.occurred_at,i.event_id`).all() as Array<{ detail: string }>;
    expect(plan.map(({ detail }) => detail).join("\n")).toContain("core_event_inbox_type_session_turn");
    stores.lifecycle.close();
  });

  it("rolls back a discriminator page and cursor when existing normalized evidence disagrees", () => {
    const stores = createTestStoreBundle(":memory:");
    const item = event({ eventId: "backfill-conflict", cursor: "bc:1", payload: { type: "turn_started" } });
    stores.coreEvents.ingestBatch(batch("lane-conflict", item, "start", item.cursor));
    stores.driver.database.exec(`UPDATE core_event_inbox SET event_type='turn_completed';
      UPDATE core_event_discriminator_backfill SET state='backfilling',high_water_event_id='backfill-conflict',after_event_id='',processed_count=0;`);

    const eventType = coreEventDiscriminatorSql(stores.driver.database, "i", "event_type");
    expect(stores.driver.database.prepare(`SELECT ${eventType} AS event_type FROM core_event_inbox i`).get())
      .toEqual({ event_type: "turn_started" });
    expect(() => stores.coreEvents.backfillDiscriminators(10)).toThrow(/discriminator mismatch/);
    expect(stores.driver.database.prepare("SELECT event_type FROM core_event_inbox").get()).toEqual({ event_type: "turn_completed" });
    expect(stores.driver.database.prepare("SELECT after_event_id,processed_count,state FROM core_event_discriminator_backfill").get())
      .toEqual({ after_event_id: "", processed_count: 0, state: "backfilling" });
    stores.lifecycle.close();
  });

  it("does not prepare ingest statements for acknowledgement-only store construction", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const preparations = countStatementPreparations(context);
    const inbox = new SqliteCoreEventInboxStore(context);
    expect(inbox.acknowledge("lane-unused", [], "projected", "2026-09-30T00:00:00.000Z")).toBe("settled");
    expect(preparations.size).toBe(0);
    context.close();
  });

  it("selects an exact orphaned binding route for the oldest pending historical event", () => {
    const stores = createTestStoreBundle(":memory:");
    stores.bindingProvisioning.createPendingBinding({
      id: "binding-history", workspaceId: "w1", chatId: "chat", topicId: "topic",
      rootMessageId: "root-history", title: "History"
    });
    stores.driver.updateBinding("binding-history", {
      state: "orphaned", lifecycle: "active", attachment: "orphaned", paneId: "w1:p1",
      agentKind: "traex", agentSessionSource: "herdr:traex", agentSessionAgent: "traex",
      agentSessionKind: "id", agentSessionValue: "session-history"
    });
    const item = event({
      eventId: "history-pending", sessionId: "session-history", cursor: "history:1",
      payload: { type: "message", message_id: "history-message", channel: "final", text: "answer", truncated: false }
    });
    stores.coreEvents.ingestBatch(batch("lane-history", item, "start", item.cursor));

    const candidates = stores.coreEvents.listHistoricalRecoveryCandidates({ limit: 10 });

    expect(candidates).toEqual([{
      laneId: "lane-history", eventId: "history-pending", laneSequence: 1,
      sourceId: "live-source", sourceEpoch: null, agentKind: "traex", sessionId: "session-history",
      oldestPendingAt: "2026-09-30T00:00:01.000Z",
      route: {
        ownerKind: "primary", ownerId: "binding-history", ownerGeneration: 1,
        gatewayId: "feishu:primary", rootMessageId: "root-history"
      }
    }]);
    stores.lifecycle.close();
  });

  it("projects one exact orphaned historical Human Message to its frozen original route as history work", () => {
    const stores = createTestStoreBundle(":memory:");
    stores.bindingProvisioning.createPendingBinding({
      id: "binding-history", workspaceId: "w1", chatId: "chat", topicId: "topic",
      rootMessageId: "root-history", title: "History"
    });
    stores.driver.updateBinding("binding-history", {
      state: "orphaned", lifecycle: "active", attachment: "orphaned", paneId: "w1:p1",
      agentKind: "traex", agentSessionSource: "herdr:traex", agentSessionAgent: "traex",
      agentSessionKind: "id", agentSessionValue: "session-history"
    });
    const item = event({
      eventId: "history-human", sessionId: "session-history", cursor: "history:1", turnId: "history-turn",
      payload: { type: "human_message", message_id: "history-human-message", text: "restore this", truncated: false }
    });
    stores.driver.database.prepare(`INSERT INTO core_event_inbox(
      event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type
    ) VALUES(?,?,?,?,?,?,?,?,?,?)`).run(
      item.eventId, item.sourceId, item.agentKind, item.sessionId, item.turnId, item.cursor,
      item.occurredAt, JSON.stringify(item), "2026-09-30T00:00:01.000Z", "human_message"
    );
    stores.driver.database.prepare(`INSERT INTO core_event_lane_checkpoints(
      lane_id,source_id,source_epoch,agent_kind,session_id,read_cursor,latest_cursor,updated_at
    ) VALUES(?,?,?,?,?,?,?,?)`).run(
      "lane-history", item.sourceId, null, item.agentKind, item.sessionId, item.cursor, item.cursor,
      "2026-09-30T00:00:01.000Z"
    );
    stores.driver.database.prepare(`INSERT INTO core_event_lane_items(
      lane_id,event_id,sequence,state,created_at,updated_at
    ) VALUES(?,?,1,'pending',?,?)`).run(
      "lane-history", item.eventId, "2026-09-30T00:00:01.000Z", "2026-09-30T00:00:01.000Z"
    );
    const [candidate] = stores.coreEvents.listHistoricalRecoveryCandidates({ limit: 1 });

    expect(candidate).toBeDefined();
    expect(stores.coreEvents.reprojectHistoricalCandidate(candidate!, "2026-09-30T00:00:02.000Z")).toEqual({
      outcome: "projected", remaining: false
    });
    expect(stores.driver.database.prepare("SELECT owner_kind,owner_id,owner_generation,root_message_id FROM conversation_segments WHERE human_event_id=?").get(item.eventId)).toEqual({
      owner_kind: "primary", owner_id: "binding-history", owner_generation: 1, root_message_id: "root-history"
    });
    expect(stores.driver.listPendingOutboundReplies()).toEqual([expect.objectContaining({
      rootMessageId: "root-history", kind: "card_reply", workClass: "history"
    })]);
    stores.lifecycle.close();
  });

  it("loses a historical projection without writes when its frozen route changes", () => {
    const stores = createTestStoreBundle(":memory:");
    stores.bindingProvisioning.createPendingBinding({
      id: "binding-history", workspaceId: "w1", chatId: "chat", topicId: "topic",
      rootMessageId: "root-history", title: "History"
    });
    stores.driver.updateBinding("binding-history", {
      state: "orphaned", lifecycle: "active", attachment: "orphaned", paneId: "w1:p1",
      agentKind: "traex", agentSessionSource: "herdr:traex", agentSessionAgent: "traex",
      agentSessionKind: "id", agentSessionValue: "session-history"
    });
    const item = event({ eventId: "history-stale", sessionId: "session-history", cursor: "history:1" });
    stores.coreEvents.ingestBatch(batch("lane-history", item, "start", item.cursor));
    const [candidate] = stores.coreEvents.listHistoricalRecoveryCandidates({ limit: 1 });
    stores.driver.database.prepare("UPDATE bindings SET root_message_id='different-root' WHERE id='binding-history'").run();

    expect(stores.coreEvents.reprojectHistoricalCandidate(candidate!, "2026-09-30T00:00:02.000Z")).toEqual({
      outcome: "stale", remaining: true
    });
    expect(stores.driver.database.prepare("SELECT state FROM core_event_lane_items WHERE lane_id='lane-history'").get()).toEqual({ state: "pending" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_segments").get()).toEqual({ count: 0 });
    expect(stores.driver.listPendingOutboundReplies()).toEqual([]);
    stores.lifecycle.close();
  });

  it("refuses ambiguous and archived historical routes", () => {
    const stores = createTestStoreBundle(":memory:");
    for (const id of ["binding-a", "binding-b"]) {
      stores.bindingProvisioning.createPendingBinding({
        id, workspaceId: "w1", chatId: "chat", topicId: `topic-${id}`,
        rootMessageId: `root-${id}`, title: id
      });
      stores.driver.updateBinding(id, {
        state: id === "binding-a" ? "archived" : "orphaned",
        lifecycle: id === "binding-a" ? "archived" : "active",
        attachment: id === "binding-a" ? "unattached" : "orphaned", paneId: `w1:${id}`,
        agentKind: "traex", agentSessionSource: "herdr:traex", agentSessionAgent: "traex",
        agentSessionKind: "id", agentSessionValue: "shared-session"
      });
    }
    const item = event({ eventId: "history-route-filter", sessionId: "shared-session", cursor: "history:1" });
    stores.coreEvents.ingestBatch(batch("lane-history", item, "start", item.cursor));
    expect(stores.coreEvents.listHistoricalRecoveryCandidates({ limit: 10 })).toHaveLength(1);
    expect(stores.coreEvents.summarizeHistoricalRecoveryBacklog()).toMatchObject({
      eligiblePendingEvents: 1, eligibleLanes: 1, ineligiblePendingEvents: 0, quarantinedEvents: 0
    });
    stores.bindingProvisioning.createPendingBinding({
      id: "binding-c", workspaceId: "w1", chatId: "chat", topicId: "topic-c", rootMessageId: "root-c", title: "C"
    });
    stores.driver.updateBinding("binding-c", {
      state: "orphaned", lifecycle: "active", attachment: "orphaned", paneId: "w1:p2",
      agentKind: "traex", agentSessionSource: "herdr:traex", agentSessionAgent: "traex",
      agentSessionKind: "id", agentSessionValue: "shared-session"
    });
    expect(stores.coreEvents.listHistoricalRecoveryCandidates({ limit: 10 })).toEqual([]);
    expect(stores.coreEvents.summarizeHistoricalRecoveryBacklog()).toMatchObject({
      eligiblePendingEvents: 0, eligibleLanes: 0, ineligiblePendingEvents: 1, quarantinedEvents: 0
    });
    stores.lifecycle.close();
  });

  it("selects one persisted Segment owner when the binding session has rotated", () => {
    const stores = createTestStoreBundle(":memory:");
    stores.bindingProvisioning.createPendingBinding({
      id: "binding-segment", workspaceId: "w1", chatId: "chat", topicId: "topic",
      rootMessageId: "binding-root", title: "Segment History"
    });
    stores.driver.updateBinding("binding-segment", {
      state: "orphaned", lifecycle: "active", attachment: "orphaned", paneId: "w1:p1",
      agentKind: "traex", agentSessionSource: "herdr:traex", agentSessionAgent: "traex",
      agentSessionKind: "id", agentSessionValue: "new-session"
    });
    const item = event({ eventId: "segment-history", sessionId: "old-session", cursor: "history:1" });
    stores.coreEvents.ingestBatch(batch("lane-segment-history", item, "start", item.cursor));
    stores.driver.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
      start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,created_at,updated_at
    ) VALUES(?,?,'primary','binding-segment',1,'traex','old-session','request',1,0,'working',1,'segment-root',?,?)`).run(
      "segment-history", "lane:lane-segment-history", "2026-09-30T00:00:00.000Z", "2026-09-30T00:00:00.000Z"
    );

    expect(stores.coreEvents.listHistoricalRecoveryCandidates({ limit: 10 })).toEqual([expect.objectContaining({
      laneId: "lane-segment-history",
      route: {
        ownerKind: "primary", ownerId: "binding-segment", ownerGeneration: 1,
        gatewayId: "feishu:primary", rootMessageId: "segment-root"
      }
    })]);
    stores.lifecycle.close();
  });

  it("prepares the fixed ingest statement bundle once for the store lifetime", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const preparations = countStatementPreparations(context);
    const inbox = new SqliteCoreEventInboxStore(context);
    const first = event({ eventId: "prepared-once-a", cursor: "live-source:1" });
    const second = event({ eventId: "prepared-once-b", cursor: "live-source:2", occurredAt: "2026-09-30T00:00:01.000Z" });
    inbox.ingestBatch(batch("lane-prepared", first, "start", first.cursor));
    const afterFirst = new Map(preparations);
    inbox.ingestBatch(batch("lane-prepared", second, first.cursor, second.cursor));
    expect(preparations).toEqual(afterFirst);
    expect([...preparations.values()].every((count) => count === 1)).toBe(true);
    context.close();
  });

  it("loads event and lane evidence once per batch entry without rereading inserted rows", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const counts = countPreparedStatementExecutions(context);
    const inbox = new SqliteCoreEventInboxStore(context);
    const first = event({ eventId: "batch-a", cursor: "live-source:1" });
    const second = event({ eventId: "batch-b", cursor: "live-source:2", occurredAt: "2026-09-30T00:00:01.000Z" });

    inbox.ingestBatch({ ...batch("lane-counted", first, "start", second.cursor), events: [first, second] });

    expect(countSql(counts, "FROM core_event_inbox WHERE event_id = ?")).toBe(0);
    expect(countSql(counts, "FROM core_event_lane_items WHERE lane_id = ? AND event_id = ?")).toBe(0);
    expect(countSql(counts, "FROM core_event_lane_items WHERE lane_id=? AND event_id=?")).toBe(0);
    expect(countSql(counts, "LEFT JOIN core_event_lane_items")).toBe(2);
    expect(countSql(counts, "INSERT INTO core_event_lane_items")).toBe(2);
    expect(inbox.loadPending("lane-counted").eventIds).toEqual([first.eventId, second.eventId]);
    context.close();
  });

  it("converges duplicate Human events on one lane sequence and canonical submission without conflict reads", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const counts = countPreparedStatementExecutions(context);
    const projected: number[] = [];
    const deliveryTrace = new DeliveryLatencyTrace();
    const inbox = new SqliteCoreEventInboxStore(context, {
      projectCanonicalEvent: ({ laneSequence }) => { projected.push(laneSequence); return { outcome: "created", segmentId: "segment-duplicate" }; },
      deliveryTrace
    });
    const human = event({
      eventId: "duplicate-human",
      payload: { type: "human_message", message_id: "message-1", text: "continue", truncated: false, submission_id: "submission-1" }
    });

    inbox.ingestBatch({ ...batch("lane-duplicate", human, "start", human.cursor), events: [human, human] });

    expect(projected).toEqual([1]);
    expect(context.database.prepare("SELECT event_id,sequence FROM core_event_lane_items WHERE lane_id=?").all("lane-duplicate"))
      .toEqual([{ event_id: human.eventId, sequence: 1 }]);
    expect(context.database.prepare("SELECT submission_id,event_id FROM canonical_human_message_submissions").all())
      .toEqual([{ submission_id: "submission-1", event_id: human.eventId }]);
    expect(countSql(counts, "LEFT JOIN core_event_lane_items")).toBe(2);
    expect(countSql(counts, "INSERT INTO core_event_lane_items")).toBe(1);
    expect(countSql(counts, "INSERT OR IGNORE INTO canonical_human_message_submissions")).toBe(1);
    expect(countSql(counts, "WHERE submission_id=?")).toBe(0);
    expect(deliveryTrace.snapshot()).toMatchObject({ traces: 1, completed: 0 });
    expect(JSON.stringify(deliveryTrace.snapshot())).not.toMatch(/duplicate-human|submission-1|segment-duplicate/);
    context.close();
  });

  it("isolates one failed event projection while later events and the cursor advance", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const deliveryTrace = new DeliveryLatencyTrace();
    const committedReceipts: string[] = [];
    let poisonReceipt: ReturnType<SqliteContext["receipt"]> | undefined;
    context.database.exec(`CREATE TEMP TABLE projection_effects(
      event_id TEXT PRIMARY KEY,
      outbox_intent TEXT NOT NULL
    )`);
    const inbox = new SqliteCoreEventInboxStore(context, {
      projectCanonicalEvent: ({ event: item }) => {
        context.database.prepare("INSERT INTO projection_effects(event_id,outbox_intent) VALUES (?,?)")
          .run(item.eventId, `reply:${item.eventId}`);
        const receipt = context.receipt(item.eventId, [item.eventId]);
        receipt.afterCommit(() => committedReceipts.push(item.eventId));
        if (item.eventId === "poison") poisonReceipt = receipt;
        if (item.eventId === "poison") throw new Error("simulated projection failure");
        return { outcome: "created", segmentId: `segment:${item.eventId}` };
      },
      deliveryTrace
    });
    const before = event({
      eventId: "before", cursor: "live-source:1",
      payload: { type: "human_message", message_id: "before-message", text: "before", truncated: false, submission_id: "before-submission" }
    });
    const poison = event({
      eventId: "poison", cursor: "live-source:2", occurredAt: "2026-09-30T00:00:01.000Z",
      payload: { type: "human_message", message_id: "poison-message", text: "poison", truncated: false, submission_id: "poison-submission" }
    });
    const after = event({
      eventId: "after", cursor: "live-source:3", occurredAt: "2026-09-30T00:00:02.000Z",
      payload: { type: "human_message", message_id: "after-message", text: "after", truncated: false, submission_id: "after-submission" }
    });

    expect(inbox.ingestBatch({
      ...batch("lane-isolated", before, "start", after.cursor),
      events: [before, poison, after]
    })).toBe("accepted");
    expect(context.database.prepare("SELECT event_id,outbox_intent FROM projection_effects ORDER BY event_id").all()).toEqual([
      { event_id: "after", outbox_intent: "reply:after" },
      { event_id: "before", outbox_intent: "reply:before" }
    ]);
    expect(context.database.prepare("SELECT event_id,state,sequence FROM core_event_lane_items WHERE lane_id=? ORDER BY sequence").all("lane-isolated")).toEqual([
      { event_id: "before", state: "pending", sequence: 1 },
      { event_id: "poison", state: "pending", sequence: 2 },
      { event_id: "after", state: "pending", sequence: 3 }
    ]);
    expect(context.database.prepare("SELECT event_id FROM core_event_inbox ORDER BY event_id").all()).toEqual([
      { event_id: "after" }, { event_id: "before" }, { event_id: "poison" }
    ]);
    expect(inbox.getCheckpoint("lane-isolated")).toMatchObject({ readCursor: after.cursor, latestCursor: after.cursor });
    expect(deliveryTrace.snapshot()).toMatchObject({ traces: 2, completed: 0 });
    expect(poisonReceipt?.commitState).toBe("rolled_back");
    expect(poisonReceipt?.consumeEffects()).toEqual([]);
    expect(committedReceipts).toEqual(["before", "after"]);
    context.close();
  });

  it("propagates a savepoint rollback failure and rolls back the batch cursor", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const database = context.database as unknown as { exec(sql: string): void };
    const execute = database.exec.bind(database);
    database.exec = (sql) => {
      if (sql.startsWith("ROLLBACK TO SAVEPOINT sqlite_savepoint_")) throw new Error("simulated savepoint rollback failure");
      execute(sql);
    };
    const inbox = new SqliteCoreEventInboxStore(context, {
      projectCanonicalEvent: () => { throw new Error("simulated projection failure"); }
    });
    const item = event({ eventId: "savepoint-management-failure" });

    expect(() => inbox.ingestBatch(batch("lane-savepoint-management", item, "start", item.cursor)))
      .toThrow("simulated savepoint rollback failure");
    expect(context.database.prepare(`SELECT
      (SELECT COUNT(*) FROM core_event_inbox) AS events,
      (SELECT COUNT(*) FROM core_event_lane_items) AS lane_items,
      (SELECT COUNT(*) FROM core_event_lane_checkpoints) AS checkpoints`).get())
      .toEqual({ events: 0, lane_items: 0, checkpoints: 0 });
    context.close();
  });

  it("propagates a savepoint release failure and rolls back the batch cursor", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const database = context.database as unknown as { exec(sql: string): void };
    const execute = database.exec.bind(database);
    let rejectRelease = true;
    database.exec = (sql) => {
      if (rejectRelease && sql.startsWith("RELEASE SAVEPOINT sqlite_savepoint_")) {
        rejectRelease = false;
        throw new Error("simulated savepoint release failure");
      }
      execute(sql);
    };
    const inbox = new SqliteCoreEventInboxStore(context, {
      projectCanonicalEvent: () => ({ outcome: "created", segmentId: "segment:release-failure" })
    });
    const item = event({ eventId: "savepoint-release-failure" });

    expect(() => inbox.ingestBatch(batch("lane-savepoint-release", item, "start", item.cursor)))
      .toThrow("simulated savepoint release failure");
    expect(context.database.prepare(`SELECT
      (SELECT COUNT(*) FROM core_event_inbox) AS events,
      (SELECT COUNT(*) FROM core_event_lane_items) AS lane_items,
      (SELECT COUNT(*) FROM core_event_lane_checkpoints) AS checkpoints`).get())
      .toEqual({ events: 0, lane_items: 0, checkpoints: 0 });
    context.close();
  });

  it("does not trace a human projection whose later savepoint work rolls back", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const deliveryTrace = new DeliveryLatencyTrace();
    const inbox = new SqliteCoreEventInboxStore(context, {
      projectCanonicalEvent: () => ({ outcome: "created", segmentId: "segment:rolled-back-trace" }),
      observeCanonicalHumanMessage: () => { throw new Error("simulated human observation failure"); },
      deliveryTrace
    });
    const human = event({
      eventId: "rolled-back-trace", cursor: "trace:1",
      payload: { type: "human_message", message_id: "rolled-back-trace-message", text: "request", truncated: false, submission_id: "rolled-back-trace-submission" }
    });

    expect(inbox.ingestBatch(batch("lane-rolled-back-trace", human, "start", human.cursor))).toBe("accepted");
    expect(deliveryTrace.snapshot()).toMatchObject({ traces: 0, completed: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM canonical_human_message_submissions").get())
      .toEqual({ count: 0 });
    context.close();
  });

  it("reprojects a stateful canonical projector event after its SQLite effects roll back", () => {
    const stores = createTestStoreBundle(":memory:");
    stores.bindingProvisioning.createPendingBinding({
      id: "binding-1", projectId: "project", workspaceId: "w1", chatId: "chat-1",
      topicId: "topic-1", rootMessageId: "root-1", title: "Primary"
    });
    stores.driver.updateBinding("binding-1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1",
      agentKind: "traex", agentSessionSource: "herdr:traex", agentSessionAgent: "traex",
      agentSessionKind: "id", agentSessionValue: "session-1"
    });
    admitTerminalAliasIntent(stores, {
      submissionId: "stateful-submission", sourceMessageKey: "stateful-source", text: "request"
    });
    const human = event({
      eventId: "stateful-human", cursor: "stateful:1",
      payload: {
        type: "human_message", message_id: "stateful-human-message", text: "request", truncated: false,
        submission_id: "stateful-submission"
      }
    });
    const assistant = event({
      eventId: "stateful-assistant", cursor: "stateful:2", occurredAt: "2026-09-30T00:00:01.000Z",
      payload: { type: "message", message_id: "stateful-assistant-message", channel: "final", text: "answer", truncated: false }
    });
    stores.coreEvents.ingestBatch(batch("lane-stateful", human, "start", human.cursor));
    stores.coreEvents.acknowledge("lane-stateful", [human.eventId], "projected", "2026-09-30T00:00:00.500Z");
    const outboxCountAfterHuman = stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get() as { count: number };
    expect(outboxCountAfterHuman).toEqual({ count: 1 });
    const conversationSegments = stores.driver.capabilityModules().conversationSegments;
    const segment = stores.driver.database.prepare("SELECT id FROM conversation_segments WHERE human_event_id=?")
      .get(human.eventId) as { id: string };
    const page = conversationSegments.getActivePage(segment.id)!;
    stores.driver.markOutboundReplyDelivered(page.pendingReplyId!, "stateful-root-message", "stateful-root-card");
    expect(conversationSegments.reconcilePageDelivery(segment.id, page.pageIndex)).toBe("adopted");
    let recoveryReservation: string | null = null;
    conversationSegments.setProjectionNotifier?.(({ segmentId, viewVersion }) => {
      const activePage = conversationSegments.getActivePage(segmentId)!;
      recoveryReservation = conversationSegments.reserveSnapshot({
        segmentId, pageIndex: activePage.pageIndex, messageId: activePage.messageId!, cardId: activePage.cardId,
        elementId: activePage.elementId, card: { schema: "2.0", body: "stateful" },
        cursor: { itemIndex: 2, markdownOffset: 0 }, viewVersion
      });
    });
    stores.driver.database.exec(`CREATE TRIGGER reject_stateful_projection BEFORE INSERT ON conversation_segment_items
      WHEN NEW.item_id='message:stateful-assistant-message'
      BEGIN SELECT RAISE(ABORT, 'simulated conversation write failure'); END`);

    expect(stores.coreEvents.ingestBatch(batch("lane-stateful", assistant, human.cursor, assistant.cursor))).toBe("accepted");
    expect(stores.driver.database.prepare("SELECT state FROM core_event_lane_items WHERE lane_id=? AND event_id=?")
      .get("lane-stateful", assistant.eventId)).toEqual({ state: "pending" });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_items WHERE item_id='message:stateful-assistant-message'").get())
      .toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual(outboxCountAfterHuman);
    stores.driver.database.exec("DROP TRIGGER reject_stateful_projection");

    const [candidate] = stores.coreEvents.listHistoricalRecoveryCandidates({ limit: 1 });
    expect(candidate).toMatchObject({ laneId: "lane-stateful", eventId: assistant.eventId });
    expect(stores.coreEvents.reprojectHistoricalCandidate(candidate!)).toEqual({ outcome: "projected", remaining: false });
    expect(stores.driver.database.prepare("SELECT state FROM core_event_lane_items WHERE lane_id=? AND event_id=?")
      .get("lane-stateful", assistant.eventId)).toEqual({ state: "projected" });
    expect(stores.driver.database.prepare("SELECT lane_sequence FROM conversation_segment_items WHERE item_id='message:stateful-assistant-message'").get())
      .toEqual({ lane_sequence: 2 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_items WHERE item_id='message:stateful-assistant-message'").get())
      .toEqual({ count: 1 });
    expect(recoveryReservation).toBe("reserved");
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get())
      .toEqual({ count: outboxCountAfterHuman.count + 1 });
    stores.lifecycle.close();
  });

  it("reprojects a stateful canonical projector event after the outer transaction rolls back", () => {
    const stores = createTestStoreBundle(":memory:");
    const human = event({
      eventId: "outer-rollback-human", cursor: "outer-rollback:1",
      payload: { type: "human_message", message_id: "outer-rollback-human-message", text: "request", truncated: false }
    });
    const assistant = event({
      eventId: "outer-rollback-assistant", cursor: "outer-rollback:2", occurredAt: "2026-09-30T00:00:01.000Z",
      payload: { type: "message", message_id: "outer-rollback-assistant-message", channel: "final", text: "answer", truncated: false }
    });
    stores.coreEvents.ingestBatch(batch("lane-outer-rollback", human, "start", human.cursor));
    stores.coreEvents.acknowledge("lane-outer-rollback", [human.eventId], "projected", "2026-09-30T00:00:00.500Z");

    const database = stores.driver.database as unknown as { exec(sql: string): void };
    const execute = database.exec.bind(database);
    let rejectCommit = true;
    database.exec = (sql) => {
      if (rejectCommit && sql === "COMMIT") {
        rejectCommit = false;
        throw new Error("simulated outer commit failure");
      }
      execute(sql);
    };
    expect(() => stores.coreEvents.ingestBatch(batch("lane-outer-rollback", assistant, human.cursor, assistant.cursor)))
      .toThrow("simulated outer commit failure");
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_items WHERE item_id='message:outer-rollback-assistant-message'").get())
      .toEqual({ count: 0 });

    expect(stores.coreEvents.ingestBatch(batch("lane-outer-rollback", assistant, human.cursor, assistant.cursor))).toBe("accepted");
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_items WHERE item_id='message:outer-rollback-assistant-message'").get())
      .toEqual({ count: 1 });
    stores.lifecycle.close();
  });

  it("correlates an actual Worker canonical projection to its semantic Outbox reservation after restart", () => {
    const stores = createTestStoreBundle(":memory:");
    const modules = stores.driver.capabilityModules();
    const observedStages: string[] = [];
    modules.deliveryTrace.subscribe({ onObservation: ({ stage }) => { observedStages.push(stage); } });
    stores.bindingProvisioning.createPendingBinding({
      id: "binding-worker-trace", projectId: "project", workspaceId: "workspace", chatId: "chat",
      topicId: "topic", rootMessageId: "primary-root", title: "Primary"
    });
    stores.driver.updateBinding("binding-worker-trace", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane"
    });
    const created = stores.instance.createWorkerAgentInstance({
      id: "worker-trace", projectId: "project", name: "Worker Trace", role: "worker", agentKind: "traex", model: null,
      desiredState: "running",
      parent: { bindingId: "binding-worker-trace", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
      workspace: { id: "worker-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4);
    if (created.outcome !== "created") throw new Error("expected Worker");
    const worker = stores.instance.attachAgentInstanceRuntime({
      instanceId: created.instance.id, expectedGeneration: created.instance.generation,
      herdrWorkspaceId: "worker-workspace", paneId: "worker-pane", nativeSessionId: "worker-session"
    });
    if (!worker) throw new Error("expected attached Worker");
    stores.driver.database.exec("DROP TRIGGER semantic_delivery_rollout_guarded_transition");
    stores.driver.database.prepare("UPDATE semantic_delivery_rollout SET phase='cohort',cohort_enabled=1 WHERE singleton_id=1").run();
    stores.agentInputs.admit({
      submissionId: "worker-submission-trace", ingressSource: "feishu:worker", sourceMessageKey: "worker-source-message",
      actor: { kind: "human", id: "operator", gatewayId: "feishu:worker", chatId: "chat", topicId: "topic", rootMessageId: "worker-root" },
      text: "CANARY_PRIVATE_WORKER_INPUT", owner: { kind: "worker", id: worker.id, generation: worker.generation },
      paneId: "worker-pane", terminalId: "worker-terminal", expectedAgentKind: "traex", expectedSessionId: "worker-session",
      recordedAt: "2026-10-10T00:00:00.000Z"
    });
    const human = event({
      eventId: "worker-core-trace", cursor: "worker-source:1", sourceId: "worker-source", sessionId: "worker-session",
      payload: { type: "human_message", message_id: "worker-human-trace", text: "CANARY_PRIVATE_WORKER_INPUT", truncated: false, submission_id: "worker-submission-trace" }
    });

    expect(stores.coreEvents.ingestBatch(batch("worker-lane-trace", human, "start", human.cursor))).toBe("accepted");
    const segmentId = "segment:worker-submission-trace";
    expect(modules.conversationSegments.getConversationSegment(segmentId)).toMatchObject({
      ownerKind: "worker", ownerId: worker.id, ownerGeneration: worker.generation
    });
    const page = modules.conversationSegments.listConversationSegmentPages(segmentId)[0]!;
    expect(page.deliveryCohort).toBe("semantic");
    expect(modules.conversationSegments.reserveSemanticSnapshot!({
      transition: "snapshot", segmentId, pageIndex: 0, messageId: null, elementId: page.elementId,
      cursor: null, viewVersion: 1, snapshot: { schemaVersion: 1, kind: "conversation-turn-card" },
      plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
    })).toBe("reserved");

    const reserved = modules.conversationSegments.listConversationSegmentPages(segmentId)[0]!;
    expect(stores.preparedDeliveries.hydrateDeliveryWork(reserved.pendingReplyId!)).toMatchObject({
      status: "ready",
      work: {
        scope: { kind: "pane", workspaceId: "worker-workspace", paneId: "worker-pane" },
        ownerFence: { kind: "worker", id: worker.id, generation: worker.generation }
      }
    });
    expect(observedStages).toEqual(["core_projected", "outbox_committed"]);
    expect(modules.deliveryTrace.snapshot()).toMatchObject({ traces: 1, activePaths: 1, completed: 0 });
    expect(JSON.stringify(modules.deliveryTrace.snapshot())).not.toMatch(/worker-submission|worker-core|CANARY_PRIVATE|worker-human/);
    stores.lifecycle.close();
  });

  it("preserves monotonic lane-local order across handles and rebuilds statements after reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-core-inbox-order-"));
    const path = join(directory, "state.sqlite");
    const leftContext = new SqliteContext(path); new SqliteMigrations(leftContext).run();
    const rightContext = new SqliteContext(path); new SqliteMigrations(rightContext).run();
    const left = new SqliteCoreEventInboxStore(leftContext);
    const right = new SqliteCoreEventInboxStore(rightContext);
    try {
      const first = event({ eventId: "ordered-a", cursor: "live-source:1" });
      const second = event({ eventId: "ordered-b", cursor: "live-source:2", occurredAt: "2026-09-30T00:00:01.000Z" });
      const other = event({ eventId: "other-a", cursor: "live-source:3", occurredAt: "2026-09-30T00:00:02.000Z" });
      left.ingestBatch(batch("lane-shared", first, "start", first.cursor));
      right.ingestBatch(batch("lane-shared", second, first.cursor, second.cursor));
      left.ingestBatch(batch("lane-other", other, "start", other.cursor));
      expect(rightContext.database.prepare("SELECT lane_id,event_id,sequence FROM core_event_lane_items ORDER BY lane_id,sequence").all()).toEqual([
        { lane_id: "lane-other", event_id: other.eventId, sequence: 1 },
        { lane_id: "lane-shared", event_id: first.eventId, sequence: 1 },
        { lane_id: "lane-shared", event_id: second.eventId, sequence: 2 }
      ]);
    } finally {
      rightContext.close();
      leftContext.close();
    }

    const reopenedContext = new SqliteContext(path); new SqliteMigrations(reopenedContext).run();
    try {
      const reopened = new SqliteCoreEventInboxStore(reopenedContext);
      const duplicate = event({ eventId: "ordered-a", cursor: "live-source:repeat" });
      const third = event({ eventId: "ordered-c", cursor: "live-source:3", occurredAt: "2026-09-30T00:00:02.000Z" });
      reopened.ingestBatch(batch("lane-shared", duplicate, "live-source:2", duplicate.cursor));
      reopened.ingestBatch(batch("lane-shared", third, duplicate.cursor, third.cursor));
      expect(reopenedContext.database.prepare("SELECT event_id,sequence FROM core_event_lane_items WHERE lane_id=? ORDER BY sequence").all("lane-shared"))
        .toEqual([{ event_id: "ordered-a", sequence: 1 }, { event_id: "ordered-b", sequence: 2 }, { event_id: "ordered-c", sequence: 3 }]);
    } finally {
      reopenedContext.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rejects malformed batch identity before mutation and bounds redacted quarantine evidence", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const inbox = new SqliteCoreEventInboxStore(context);
    const malformed = { ...event(), schemaVersion: 2 as 1 };
    expect(() => inbox.ingestBatch(batch("lane-malformed", malformed, "start", malformed.cursor)))
      .toThrow("Core event inbox identity mismatch");
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM core_event_inbox").get()).toEqual({ count: 0 });

    const poison = event({ eventId: "bounded-poison" });
    inbox.ingestBatch(batch("lane-redacted", poison, "start", poison.cursor));
    const secret = `token=super-secret-${"x".repeat(2_000)}`;
    for (const occurredAt of ["2026-09-30T00:00:02.000Z", "2026-09-30T00:00:03.000Z", "2026-09-30T00:00:04.000Z"]) {
      inbox.acknowledge("lane-redacted", [poison.eventId], "quarantined", occurredAt, secret);
    }
    const failure = context.database.prepare("SELECT failure FROM core_event_lane_items WHERE lane_id=? AND event_id=?")
      .get("lane-redacted", poison.eventId) as { failure: string };
    expect(failure.failure).toMatch(/^[a-f0-9]{64}$/);
    expect(failure.failure).not.toContain("super-secret");
    context.close();
  });

  it("isolates exact recovery snapshots for different turns from the same source", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const observed: Array<{ laneId: string; eventId: string }> = [];
    const inbox = new SqliteCoreEventInboxStore(context, { projectCanonicalEvent: (input) => observed.push({ laneId: input.laneId, eventId: input.event.eventId }) });

    inbox.ingestCanonicalSnapshotEvidence([event({ eventId: "turn-a-start", sourceId: "recovery-source", turnId: "turn-a", payload: { type: "turn_started" } })], "2026-10-05T00:00:00.000Z");
    inbox.ingestCanonicalSnapshotEvidence([event({ eventId: "turn-b-start", sourceId: "recovery-source", turnId: "turn-b", payload: { type: "turn_started" } })], "2026-10-05T00:00:01.000Z");

    expect(observed).toEqual([
      { laneId: "snapshot:recovery-source:turn-a", eventId: "turn-a-start" },
      { laneId: "snapshot:recovery-source:turn-b", eventId: "turn-b-start" }
    ]);
    context.close();
  });

  it("passes the inserted lane sequence to canonical projection on replay", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const observed: Array<{ laneId: string; laneSequence: number; eventId: string }> = [];
    const inbox = new SqliteCoreEventInboxStore(context, { projectCanonicalEvent: (input) => observed.push({ laneId: input.laneId, laneSequence: input.laneSequence, eventId: input.event.eventId }) });
    const first = event({ eventId: "lane-sequence-a", cursor: "live-source:1" });
    inbox.ingestBatch(batch("lane-sequence", first, "start", first.cursor));
    const recovery = event({ eventId: "lane-sequence-b", cursor: "live-source:2" });
    inbox.ingestBatch(batch("lane-sequence", recovery, first.cursor, recovery.cursor));
    inbox.ingestBatch(batch("lane-sequence", first, recovery.cursor, first.cursor));
    expect(observed).toEqual([
      { laneId: "lane-sequence", laneSequence: 1, eventId: "lane-sequence-a" },
      { laneId: "lane-sequence", laneSequence: 2, eventId: "lane-sequence-b" }
    ]);
    context.close();
  });

  it("does not reproject an already settled event repeated by an advancing Ring cursor", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const observed: Array<{ laneId: string; laneSequence: number; eventId: string }> = [];
    const inbox = new SqliteCoreEventInboxStore(context, { projectCanonicalEvent: (input) => observed.push({ laneId: input.laneId, laneSequence: input.laneSequence, eventId: input.event.eventId }) });
    const first = event({ eventId: "settled-replay", cursor: "live-source:1" });

    inbox.ingestBatch(batch("lane-live", first, "start", first.cursor));
    inbox.acknowledge("lane-live", [first.eventId], "projected", "2026-09-30T00:00:02.000Z");
    inbox.ingestBatch(batch("lane-live", { ...first, cursor: "live-source:2" }, first.cursor, "live-source:2"));

    expect(observed).toEqual([{ laneId: "lane-live", laneSequence: 1, eventId: first.eventId }]);
    expect(inbox.getCheckpoint("lane-live")).toMatchObject({ readCursor: "live-source:2" });
    context.close();
  });
  it("persists bounded owner-scoped request-input candidates without sending a card", () => {
    const stores = createTestStoreBundle(":memory:");
    stores.bindingProvisioning.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    let after = "start";
    for (let index = 0; index < 10; index += 1) {
      const item = event({
        eventId: `candidate-${index}`,
        cursor: `live-source:${index + 1}`,
        payload: {
          type: "tool_call", call_id: `ask-${index}`, name: "request_user_input",
          arguments: JSON.stringify({ questions: [{ question: `Choose option ${index}`, header: "Choice", options: [] }] }),
          truncated: false
        }
      });
      stores.coreEvents.ingestBatch(batch("lane-live", item, after, item.cursor));
      stores.coreEvents.acknowledge("lane-live", [item.eventId], "projected", "2026-09-30T00:01:00.000Z", undefined, { kind: "binding", id: "binding-1" });
      after = item.cursor;
    }

    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM human_review_candidates WHERE state = 'pending'").get()).toEqual({ count: 8 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM human_review_candidates WHERE state = 'expired'").get()).toEqual({ count: 2 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT notice FROM human_review_candidates WHERE source_event_id = 'candidate-9'").get()).toEqual({ notice: "Choose option 9" });

    stores.lifecycle.close();
  });

  it("does not derive a Human Review candidate from a compacted Core payload", () => {
    const stores = createTestStoreBundle(":memory:");
    stores.bindingProvisioning.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const item = event({
      eventId: "compacted-review-candidate",
      payload: {
        type: "tool_call", call_id: "ask-compacted", name: "request_user_input",
        arguments: JSON.stringify({ questions: [{ question: "This must stay unavailable", header: "Choice", options: [] }] }),
        truncated: false
      }
    });
    stores.coreEvents.ingestBatch(batch("lane-live", item, "start", item.cursor));
    stores.driver.database.prepare(`UPDATE core_event_inbox SET event_json='null',payload_compacted_at=? WHERE event_id=?`)
      .run("2026-10-17T00:00:00.000Z", item.eventId);

    stores.coreEvents.acknowledge("lane-live", [item.eventId], "projected", "2026-10-17T00:00:01.000Z", undefined, {
      kind: "binding", id: "binding-1"
    });

    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM human_review_candidates WHERE source_event_id=?")
      .get(item.eventId)).toEqual({ count: 0 });
    stores.lifecycle.close();
  });

  it("retains an unmatched request-input candidate across restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-human-review-candidate-"));
    const path = join(directory, "bridge.db");
    let stores = createTestStoreBundle(path);
    try {
      stores.bindingProvisioning.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
      const item = event({
        eventId: "candidate-restart", payload: {
          type: "tool_call", call_id: "ask-restart", name: "request_user_input",
          arguments: JSON.stringify({ questions: [{ question: "Select a rollout lane", header: "Lane", options: [] }] }), truncated: false
        }
      });
      stores.coreEvents.ingestBatch(batch("lane-live", item, "start", item.cursor));
      stores.coreEvents.acknowledge("lane-live", [item.eventId], "projected", "2026-09-30T00:01:00.000Z", undefined, { kind: "binding", id: "binding-1" });
      stores.lifecycle.close();

      stores = createTestStoreBundle(path);
      expect(stores.driver.database.prepare("SELECT owner_kind, owner_id, owner_generation, state, notice FROM human_review_candidates WHERE source_event_id = ?").get(item.eventId)).toEqual({
        owner_kind: "binding", owner_id: "binding-1", owner_generation: 1, state: "pending", notice: "Select a rollout lane"
      });
    } finally {
      stores.lifecycle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("deduplicates stable events across live and exact-recovery transport identities", () => {
    const stores = createTestStoreBundle(":memory:");
    const live = event();
    const recovered = event({ cursor: "recovery:transcript:1", sourceId: "recovery:transcript" });

    stores.coreEvents.ingestBatch(batch("lane-live", live, "start", live.cursor));
    expect(() => stores.coreEvents.ingestBatch(batch("lane-recovery", recovered, "", recovered.cursor))).not.toThrow();
    expect(stores.coreEvents.loadPending("lane-live").eventIds).toEqual([live.eventId]);
    expect(stores.coreEvents.loadPending("lane-recovery").eventIds).toEqual([]);

    stores.lifecycle.close();
  });

  it("settles a later terminal submission as an immutable conflict without rebinding canonical evidence", () => {
    const stores = createTestStoreBundle(":memory:");
    const original = event({
      payload: { type: "human_message", message_id: "message-1", text: "request", truncated: false, submission_id: "submission-original" }
    });
    stores.coreEvents.ingestBatch(batch("lane-original", original, "start", original.cursor));
    const before = {
      inbox: stores.driver.database.prepare("SELECT event_json,submission_id FROM core_event_inbox WHERE event_id=?").get(original.eventId),
      canonical: stores.driver.database.prepare("SELECT submission_id,event_id FROM canonical_human_message_submissions WHERE event_id=?").get(original.eventId)
    };
    admitTerminalAliasIntent(stores, {
      submissionId: "submission-later", sourceMessageKey: "source-later", text: "request"
    });
    const replay = event({
      cursor: "replay:1", sourceId: "replay-source",
      payload: { type: "human_message", message_id: "message-1", text: "request", truncated: false, submission_id: "submission-later" }
    });

    expect(() => stores.coreEvents.ingestBatch(batch("lane-later", replay, "start", replay.cursor))).not.toThrow();
    expect(stores.driver.database.prepare("SELECT event_json,submission_id FROM core_event_inbox WHERE event_id=?").get(original.eventId)).toEqual(before.inbox);
    expect(stores.driver.database.prepare("SELECT submission_id,event_id FROM canonical_human_message_submissions WHERE event_id=?").get(original.eventId)).toEqual(before.canonical);
    expect(stores.driver.database.prepare(`SELECT state,conflict_count,last_conflict_reason,last_conflict_at
      FROM core_event_lane_items WHERE lane_id=? AND event_id=?`).get("lane-later", replay.eventId))
      .toEqual({ state: "ignored", conflict_count: 1, last_conflict_reason: "semantic_conflict", last_conflict_at: "2026-09-30T00:00:01.000Z" });
    expect(stores.coreEvents.getCheckpoint("lane-later")).toMatchObject({ readCursor: replay.cursor, latestCursor: replay.cursor });
    stores.lifecycle.close();
  });

  it("settles a conflicting duplicate without rewriting inbox or blocking batch progress", () => {
    const stores = createTestStoreBundle(":memory:");
    const originalChoice = {
      actionSetId: "review-actions", optionId: "approve", sourceMessageId: "review-message"
    };
    const original = event({
      eventId: "immutable-human", cursor: "canonical:1", sourceId: "canonical-source",
      payload: {
        type: "human_message", message_id: "human-1", text: "approve", truncated: false,
        submission_id: "submission-original", choice: originalChoice
      }
    });
    stores.coreEvents.ingestBatch(batch("lane-canonical", original, "start", original.cursor));
    const originalInbox = stores.driver.database.prepare(`SELECT event_json,submission_id
      FROM core_event_inbox WHERE event_id=?`).get(original.eventId);

    const before = event({
      eventId: "valid-before", cursor: "replay:1", sourceId: "replay-source",
      payload: { type: "turn_started" }
    });
    const conflict = event({
      eventId: original.eventId, cursor: "replay:2", sourceId: "replay-source",
      payload: {
        type: "human_message", message_id: "human-1", text: "approve", truncated: false,
        submission_id: "submission-conflict", choice: { ...originalChoice, optionId: "revise" }
      }
    });
    const after = event({
      eventId: "valid-after", cursor: "replay:3", sourceId: "replay-source",
      payload: { type: "turn_completed", status: "completed" }
    });

    expect(() => stores.coreEvents.ingestBatch({
      ...batch("lane-conflict", before, "start", after.cursor),
      events: [before, conflict, after]
    })).not.toThrow();

    expect(stores.driver.database.prepare(`SELECT event_id,state,conflict_count,
      last_conflict_hash,last_conflict_reason,last_conflict_at
      FROM core_event_lane_items WHERE lane_id='lane-conflict' ORDER BY sequence`).all()).toEqual([
      {
        event_id: before.eventId, state: "pending", conflict_count: 0,
        last_conflict_hash: null, last_conflict_reason: null, last_conflict_at: null
      },
      {
        event_id: conflict.eventId, state: "ignored", conflict_count: 1,
        last_conflict_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
        last_conflict_reason: "semantic_conflict", last_conflict_at: "2026-09-30T00:00:01.000Z"
      },
      {
        event_id: after.eventId, state: "pending", conflict_count: 0,
        last_conflict_hash: null, last_conflict_reason: null, last_conflict_at: null
      }
    ]);
    expect(stores.driver.database.prepare(`SELECT event_json,submission_id
      FROM core_event_inbox WHERE event_id=?`).get(original.eventId)).toEqual(originalInbox);
    expect(stores.driver.database.prepare(`SELECT submission_id,event_id
      FROM canonical_human_message_submissions WHERE event_id=?`).get(original.eventId)).toEqual({
      submission_id: "submission-original", event_id: original.eventId
    });
    expect(stores.coreEvents.loadPending("lane-conflict").eventIds).toEqual([before.eventId, after.eventId]);
    expect(stores.coreEvents.getCheckpoint("lane-conflict")).toMatchObject({
      readCursor: after.cursor, latestCursor: after.cursor
    });

    stores.lifecycle.close();
  });

  it.each([
    ["pending", "pending"],
    ["projected", "projected"],
    ["quarantined", "quarantined"]
  ] as const)("records a same-lane conflict without replacing the canonical %s state", (_label, expectedState) => {
    const stores = createTestStoreBundle(":memory:");
    const canonical = event({
      eventId: `same-lane-${expectedState}`,
      cursor: "canonical:1",
      payload: { type: "message", message_id: "message-1", channel: "final", text: "canonical", truncated: false }
    });
    stores.coreEvents.ingestBatch(batch("lane-same", canonical, "start", canonical.cursor));
    if (expectedState === "projected") {
      stores.coreEvents.acknowledge("lane-same", [canonical.eventId], "projected", "2026-09-30T00:00:01.000Z");
    } else if (expectedState === "quarantined") {
      for (let attempt = 0; attempt < 3; attempt += 1) {
        stores.coreEvents.acknowledge("lane-same", [canonical.eventId], "quarantined", `2026-09-30T00:00:0${attempt + 1}.000Z`, "projection failed");
      }
    }
    const conflict = event({
      eventId: canonical.eventId,
      cursor: "canonical:2",
      payload: { type: "message", message_id: "message-1", channel: "final", text: "conflict", truncated: false }
    });

    expect(stores.coreEvents.ingestBatch(batch("lane-same", conflict, canonical.cursor, conflict.cursor))).toBe("accepted");
    expect(stores.driver.database.prepare(`SELECT state,conflict_count,last_conflict_reason
      FROM core_event_lane_items WHERE lane_id=? AND event_id=?`).get("lane-same", canonical.eventId))
      .toEqual({ state: expectedState, conflict_count: 1, last_conflict_reason: "semantic_conflict" });
    expect(stores.coreEvents.getCheckpoint("lane-same")).toMatchObject({ readCursor: conflict.cursor });

    expect(stores.coreEvents.ingestBatch(batch("lane-same", conflict, "start", conflict.cursor))).toBe("stale_rebase");
    expect(stores.driver.database.prepare(`SELECT state,conflict_count,last_conflict_reason
      FROM core_event_lane_items WHERE lane_id=? AND event_id=?`).get("lane-same", canonical.eventId))
      .toEqual({ state: expectedState, conflict_count: 2, last_conflict_reason: "semantic_conflict" });
    stores.driver.database.prepare(`UPDATE core_event_lane_items SET conflict_count=1000
      WHERE lane_id=? AND event_id=?`).run("lane-same", canonical.eventId);
    expect(stores.coreEvents.ingestBatch(batch("lane-same", conflict, "start", conflict.cursor))).toBe("stale_rebase");
    expect(stores.driver.database.prepare(`SELECT state,conflict_count FROM core_event_lane_items
      WHERE lane_id=? AND event_id=?`).get("lane-same", canonical.eventId))
      .toEqual({ state: expectedState, conflict_count: 1000 });
    stores.lifecycle.close();
  });

  it("accepts transport key reordering without weakening semantic identity", () => {
    const stores = createTestStoreBundle(":memory:");
    const original = event({
      payload: { type: "message", message_id: "message-1", channel: "reasoning", text: "Waiting for execution", truncated: false }
    });
    const reordered = event({
      cursor: "replay:1",
      sourceId: "replay:source",
      payload: { channel: "reasoning", message_id: "message-1", text: "Waiting for execution", truncated: false, type: "message" }
    });

    stores.coreEvents.ingestBatch(batch("lane-live", original, "start", original.cursor));
    expect(() => stores.coreEvents.ingestBatch(batch("lane-replay", reordered, "", reordered.cursor))).not.toThrow();

    stores.lifecycle.close();
  });

  it("persists an explicit message role in the generic inbox and accepts exact replay", () => {
    const stores = createTestStoreBundle(":memory:");
    const original = event({
      eventId: "role-message",
      cursor: "role:1",
      payload: {
        type: "message",
        message_id: "message-1",
        role: "developer",
        channel: "commentary",
        text: "Repository-only guidance",
        truncated: false
      }
    });
    const replay = event({
      eventId: "role-message",
      cursor: "role:2",
      sourceId: "replay:source",
      payload: {
        role: "developer",
        text: "Repository-only guidance",
        channel: "commentary",
        message_id: "message-1",
        truncated: false,
        type: "message"
      }
    });

    expect(stores.coreEvents.ingestBatch(batch("lane-role", original, "start", original.cursor))).toBe("accepted");
    expect(JSON.parse((stores.driver.database.prepare(`SELECT event_json FROM core_event_inbox WHERE event_id=?`).get(original.eventId) as { event_json: string }).event_json))
      .toMatchObject({ payload: { type: "message", role: "developer", channel: "commentary" } });
    expect(() => stores.coreEvents.ingestBatch(batch("lane-role-replay", replay, "start", replay.cursor))).not.toThrow();

    stores.lifecycle.close();
  });

  it("treats a missing legacy Turn identity as the canonical null identity", () => {
    const stores = createTestStoreBundle(":memory:");
    const legacy = event({ turnId: null });
    const replayed = event({ sourceId: "replay:source", cursor: "replay:1", turnId: null });

    stores.coreEvents.ingestBatch(batch("lane-legacy", legacy, "start", legacy.cursor));
    stores.driver.database.prepare(`UPDATE core_event_inbox
      SET event_json = json_remove(event_json, '$.turnId')
      WHERE event_id = ?`).run(legacy.eventId);
    expect(() => stores.coreEvents.ingestBatch(batch("lane-replay", replayed, "", replayed.cursor))).not.toThrow();
    expect(stores.coreEvents.getCheckpoint("lane-replay")).toMatchObject({ readCursor: replayed.cursor });

    stores.lifecycle.close();
  });

  it("deduplicates a replayed skipped-record diagnostic whose generated time changes", () => {
    const stores = createTestStoreBundle(":memory:");
    const original = event({
      occurredAt: "2026-09-30T00:00:00.000Z",
      payload: { type: "record_skipped", code: "record_too_large" }
    });
    const replayed = event({
      sourceId: "replay:source",
      cursor: "replay:1",
      occurredAt: "2026-10-04T14:00:00.000Z",
      payload: { type: "record_skipped", code: "record_too_large" }
    });

    stores.coreEvents.ingestBatch(batch("lane-live", original, "start", original.cursor));
    expect(() => stores.coreEvents.ingestBatch(batch("lane-replay", replayed, "", replayed.cursor))).not.toThrow();
    expect(stores.coreEvents.loadPending("lane-replay").events).toEqual([]);
    expect(stores.driver.database.prepare(`SELECT state,conflict_count FROM core_event_lane_items
      WHERE lane_id=? AND event_id=?`).get("lane-replay", replayed.eventId)).toEqual({ state: "ignored", conflict_count: 0 });

    stores.lifecycle.close();
  });

  it("settles a missing typed choice without changing the immutable canonical event", () => {
    const stores = createTestStoreBundle(":memory:");
    stores.bindingProvisioning.createPendingBinding({
      id: "binding-1", projectId: "project", workspaceId: "w1", chatId: "chat-1",
      topicId: "topic-1", rootMessageId: "root-1", title: "Primary"
    });
    stores.driver.updateBinding("binding-1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1"
    });
    const choice = { actionSetId: "review-actions", optionId: "approve", sourceMessageId: "review-message" };
    admitTerminalAliasIntent(stores, {
      submissionId: "submission-canonical", sourceMessageKey: "source-canonical", text: "approve", choice
    });
    const canonical = event({
      eventId: "canonical-choice-replay", cursor: "canonical:1",
      payload: {
        type: "human_message", message_id: "human-choice", text: "approve", truncated: false,
        submission_id: "submission-canonical", choice
      }
    });
    stores.coreEvents.ingestBatch(batch("lane-canonical", canonical, "start", canonical.cursor));
    const firstAdmission = stores.driver.database.prepare(`SELECT
      segment.start_lane_sequence AS lane_sequence,
      page.pending_reply_id AS reply_id,
      reply.projection_key
      FROM conversation_segments segment
      JOIN conversation_segment_pages page ON page.segment_id=segment.id
      JOIN outbound_replies reply ON reply.id=page.pending_reply_id
      WHERE segment.human_event_id=?`).all(canonical.eventId);
    expect(firstAdmission).toHaveLength(1);
    expect(firstAdmission[0]).toMatchObject({ lane_sequence: 1 });
    const outboxCountAfterFirstAdmission = stores.driver.database.prepare(`SELECT COUNT(*) AS count
      FROM conversation_segments segment
      JOIN conversation_segment_pages page ON page.segment_id=segment.id
      JOIN outbound_replies reply ON reply.id=page.pending_reply_id
      WHERE segment.human_event_id=?`).get(canonical.eventId) as { count: number };
    expect(outboxCountAfterFirstAdmission).toEqual({ count: 1 });
    const replay = event({
      eventId: canonical.eventId, cursor: "replay:1", sourceId: "replay-source",
      payload: { type: "human_message", message_id: "human-choice", text: "approve", truncated: false }
    });

    expect(() => stores.coreEvents.ingestBatch(batch("lane-replay", replay, "start", replay.cursor))).not.toThrow();

    const stored = JSON.parse((stores.driver.database.prepare("SELECT event_json FROM core_event_inbox WHERE event_id=?")
      .get(canonical.eventId) as { event_json: string }).event_json) as CoreEventEnvelope;
    expect(stored.payload).toEqual({
      type: "human_message", message_id: "human-choice", text: "approve", truncated: false,
      submission_id: "submission-canonical", choice
    });
    expect(stores.driver.database.prepare("SELECT state FROM core_event_lane_items WHERE lane_id=? AND event_id=?")
      .get("lane-replay", canonical.eventId)).toEqual({ state: "ignored" });
    expect(stores.driver.database.prepare(`SELECT conflict_count,last_conflict_reason
      FROM core_event_lane_items WHERE lane_id=? AND event_id=?`).get("lane-replay", canonical.eventId))
      .toEqual({ conflict_count: 1, last_conflict_reason: "semantic_conflict" });
    expect(stores.coreEvents.getCheckpoint("lane-replay")).toMatchObject({ readCursor: replay.cursor });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM conversation_segments WHERE human_event_id=?")
      .get(canonical.eventId)).toEqual({ count: 1 });
    expect(stores.driver.database.prepare(`SELECT COUNT(*) AS count
      FROM conversation_segments segment
      JOIN conversation_segment_pages page ON page.segment_id=segment.id
      JOIN outbound_replies reply ON reply.id=page.pending_reply_id
      WHERE segment.human_event_id=?`).get(canonical.eventId)).toEqual(outboxCountAfterFirstAdmission);
    stores.lifecycle.close();
  });

  it("settles a canonical human-message replay whose typed choice conflicts", () => {
    const stores = createTestStoreBundle(":memory:");
    stores.bindingProvisioning.createPendingBinding({
      id: "binding-1", projectId: "project", workspaceId: "w1", chatId: "chat-1",
      topicId: "topic-1", rootMessageId: "root-1", title: "Primary"
    });
    stores.driver.updateBinding("binding-1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1"
    });
    const canonicalChoice = { actionSetId: "review-actions", optionId: "approve", sourceMessageId: "review-message" };
    admitTerminalAliasIntent(stores, {
      submissionId: "submission-canonical-conflict", sourceMessageKey: "source-canonical-conflict",
      text: "approve", choice: canonicalChoice
    });
    const canonical = event({
      eventId: "canonical-choice-conflict", cursor: "canonical:1",
      payload: {
        type: "human_message", message_id: "human-choice-conflict", text: "approve", truncated: false,
        submission_id: "submission-canonical-conflict", choice: canonicalChoice
      }
    });
    stores.coreEvents.ingestBatch(batch("lane-canonical-conflict", canonical, "start", canonical.cursor));
    const replay = event({
      eventId: canonical.eventId, cursor: "replay:1", sourceId: "replay-source",
      payload: {
        type: "human_message", message_id: "human-choice-conflict", text: "approve", truncated: false,
        choice: { ...canonicalChoice, optionId: "reject" }
      }
    });

    expect(() => stores.coreEvents.ingestBatch(batch("lane-choice-conflict", replay, "start", replay.cursor))).not.toThrow();
    expect(stores.coreEvents.getCheckpoint("lane-choice-conflict")).toMatchObject({ readCursor: replay.cursor });
    expect(stores.driver.database.prepare(`SELECT state,conflict_count,last_conflict_reason FROM core_event_lane_items
      WHERE lane_id=? AND event_id=?`).get("lane-choice-conflict", replay.eventId))
      .toEqual({ state: "ignored", conflict_count: 1, last_conflict_reason: "semantic_conflict" });
    stores.lifecycle.close();
  });

  it("settles a replayed business event whose occurrence time changes", () => {
    const stores = createTestStoreBundle(":memory:");
    const original = event({ occurredAt: "2026-09-30T00:00:00.000Z" });
    const replayed = event({
      sourceId: "replay:source",
      cursor: "replay:1",
      occurredAt: "2026-10-04T14:00:00.000Z"
    });

    stores.coreEvents.ingestBatch(batch("lane-live", original, "start", original.cursor));
    expect(() => stores.coreEvents.ingestBatch(batch("lane-replay", replayed, "", replayed.cursor))).not.toThrow();
    expect(stores.driver.database.prepare(`SELECT state,conflict_count FROM core_event_lane_items
      WHERE lane_id=? AND event_id=?`).get("lane-replay", replayed.eventId)).toEqual({ state: "ignored", conflict_count: 1 });

    stores.lifecycle.close();
  });

  it("settles a stable event id whose semantic payload changes", () => {
    const stores = createTestStoreBundle(":memory:");
    const original = event();
    stores.coreEvents.ingestBatch(batch("lane-live", original, "start", original.cursor));

    expect(() => stores.coreEvents.ingestBatch(batch(
      "lane-recovery",
      event({ sourceId: "recovery:transcript", cursor: "recovery:transcript:1", payload: { type: "message", text: "tampered" } }),
      "",
      "recovery:transcript:1"
    ))).not.toThrow();

    stores.lifecycle.close();
  });

  it("advances its read checkpoint atomically while retaining pending events until acknowledged", () => {
    const stores = createTestStoreBundle(":memory:");
    const item = event();
    stores.coreEvents.ingestBatch(batch("lane-live", item, "start", item.cursor));

    expect(stores.coreEvents.getCheckpoint("lane-live")).toMatchObject({ readCursor: item.cursor, latestCursor: item.cursor });
    expect(stores.coreEvents.loadPending("lane-live").eventIds).toEqual([item.eventId]);
    expect(stores.coreEvents.acknowledge("lane-live", [item.eventId], "projected", "2026-09-30T00:00:02.000Z")).toBe("settled");
    expect(stores.coreEvents.acknowledge("lane-live", [item.eventId], "quarantined", "2026-09-30T00:00:03.000Z", "late subscriber failure")).toBe("settled");
    expect(stores.coreEvents.loadPending("lane-live").eventIds).toEqual([]);

    stores.lifecycle.close();
  });

  it("atomically records an expired interval and rebases the exact stale checkpoint", () => {
    const stores = createTestStoreBundle(":memory:");
    const item = event({ eventId: "before-expiry", cursor: "ring-1:epoch-1:3", sourceId: "ring-1" });
    stores.coreEvents.ingestBatch({
      ...batch("lane-ring", item, "start", item.cursor),
      sourceEpoch: "epoch-1",
      latestCursor: "ring-1:epoch-1:3"
    });

    expect(stores.coreEvents.rebaseExpiredCheckpoint({
      laneId: "lane-ring",
      sourceId: "ring-1",
      sourceEpoch: "epoch-1",
      expectedSourceEpoch: "epoch-1",
      agentKind: "traex",
      sessionId: "session-1",
      expectedReadCursor: "ring-1:epoch-1:3",
      resumeCursor: "ring-1:epoch-1:9",
      earliestCursor: "ring-1:epoch-1:10",
      latestCursor: "ring-1:epoch-1:521",
      owner: { kind: "binding", id: "binding-1" },
      rebasedAt: "2026-10-05T12:00:00.000Z"
    })).toBe("rebased");

    expect(stores.coreEvents.getCheckpoint("lane-ring")).toEqual({
      sourceId: "ring-1",
      sourceEpoch: "epoch-1",
      agentKind: "traex",
      sessionId: "session-1",
      readCursor: "ring-1:epoch-1:9",
      latestCursor: "ring-1:epoch-1:521"
    });
    expect(stores.driver.database.prepare(`SELECT stage,owner_kind,owner_id,failure_code,state,details_json
      FROM projection_gaps WHERE owner_id='binding-1'`).get()).toEqual({
      stage: "core_projection",
      owner_kind: "binding",
      owner_id: "binding-1",
      failure_code: "cursor_expired",
      state: "open",
      details_json: JSON.stringify({
        laneId: "lane-ring",
        sourceId: "ring-1",
        sourceEpoch: "epoch-1",
        staleCursor: "ring-1:epoch-1:3",
        resumeCursor: "ring-1:epoch-1:9",
        earliestCursor: "ring-1:epoch-1:10",
        latestCursor: "ring-1:epoch-1:521"
      })
    });

    stores.lifecycle.close();
  });

  it("records an invalid cursor gap idempotently without advancing its checkpoint", () => {
    const stores = createTestStoreBundle(":memory:");
    const item = event({ eventId: "before-invalid-cursor", cursor: "ring-1:epoch-1:7", sourceId: "ring-1" });
    stores.coreEvents.ingestBatch({
      ...batch("lane-ring", item, "start", item.cursor), sourceEpoch: "epoch-1", latestCursor: item.cursor
    });
    const input = {
      laneId: "lane-ring", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex" as const,
      sessionId: "session-1", readCursor: item.cursor, owner: { kind: "binding" as const, id: "binding-1" },
      occurredAt: "2026-10-12T12:00:00.000Z"
    };

    stores.coreEvents.recordInvalidCursorGap(input);
    stores.coreEvents.recordInvalidCursorGap(input);

    expect(stores.coreEvents.getCheckpoint("lane-ring")).toMatchObject({ readCursor: item.cursor, latestCursor: item.cursor });
    expect(stores.driver.database.prepare(`SELECT failure_code,source_item_id,details_json FROM projection_gaps
      WHERE owner_id='binding-1'`).all()).toEqual([{
      failure_code: "invalid_cursor", source_item_id: expect.stringMatching(/^invalid-cursor:[a-f0-9]{64}$/),
      details_json: JSON.stringify({
        laneId: "lane-ring", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1", readCursor: item.cursor
      })
    }]);
    stores.lifecycle.close();
  });

  it("atomically records an epoch transition and preserves existing events and lane items", () => {
    const stores = createTestStoreBundle(":memory:");
    const item = event({ eventId: "before-epoch-transition", cursor: "ring-1:epoch-3:164", sourceId: "ring-1" });
    stores.coreEvents.ingestBatch({
      ...batch("lane-ring", item, "start", item.cursor), sourceEpoch: "epoch-3"
    });

    expect(stores.coreEvents.rebaseEpochTransition({
      laneId: "lane-ring", sourceId: "ring-1", expectedSourceEpoch: "epoch-3",
      expectedReadCursor: item.cursor, agentKind: "traex", sessionId: "session-1",
      sourceEpoch: "epoch-2", earliestCursor: "ring-1:epoch-2:0", latestCursor: "ring-1:epoch-2:8",
      owner: { kind: "binding", id: "binding-1" }, rebasedAt: "2026-10-07T12:00:00.000Z"
    })).toBe("rebased");

    expect(stores.coreEvents.getCheckpoint("lane-ring")).toEqual({
      sourceId: "ring-1", sourceEpoch: "epoch-2", agentKind: "traex", sessionId: "session-1",
      readCursor: "start", latestCursor: "ring-1:epoch-2:8"
    });
    expect(stores.coreEvents.loadPending("lane-ring").eventIds).toEqual([item.eventId]);
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM core_event_inbox WHERE event_id=?").get(item.eventId)).toEqual({ count: 1 });
    expect(stores.driver.database.prepare(`SELECT stage,owner_kind,owner_id,source_item_id,failure_code,state,details_json
      FROM projection_gaps WHERE owner_id='binding-1'`).get()).toEqual({
      stage: "core_projection",
      owner_kind: "binding",
      owner_id: "binding-1",
      source_item_id: expect.stringMatching(/^cursor-epoch-changed:[a-f0-9]{64}$/),
      failure_code: "cursor_epoch_changed",
      state: "open",
      details_json: JSON.stringify({
        laneId: "lane-ring", sourceId: "ring-1", agentKind: "traex", sessionId: "session-1",
        expectedSourceEpoch: "epoch-3", expectedReadCursor: item.cursor, sourceEpoch: "epoch-2",
        earliestCursor: "ring-1:epoch-2:0", latestCursor: "ring-1:epoch-2:8"
      })
    });

    stores.lifecycle.close();
  });

  it("atomically replaces a v2 physical ring at Core's start boundary", () => {
    const stores = createTestStoreBundle(":memory:");
    const item = event({ eventId: "before-source-transition", cursor: "ring-1:epoch-1:3", sourceId: "ring-1" });
    stores.coreEvents.ingestBatch({ ...batch("lane-ring", item, "start", item.cursor), sourceEpoch: "epoch-1" });

    expect(stores.coreEvents.transitionSource({
      laneId: "lane-ring", expectedSourceId: "ring-1", expectedSourceEpoch: "epoch-1", expectedReadCursor: item.cursor,
      sourceId: "ring-2", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      earliestCursor: "ring-2:epoch-1:0", latestCursor: "ring-2:epoch-1:8",
      owner: { kind: "binding", id: "binding-1" }, transitionedAt: "2026-10-12T12:00:00.000Z"
    })).toBe("transitioned");

    expect(stores.coreEvents.getCheckpoint("lane-ring")).toEqual({
      sourceId: "ring-2", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      readCursor: "start", latestCursor: "ring-2:epoch-1:8"
    });
    expect(stores.coreEvents.loadPending("lane-ring").eventIds).toEqual([item.eventId]);
    expect(stores.driver.database.prepare(`SELECT source_item_id,failure_code,details_json
      FROM projection_gaps WHERE owner_id='binding-1'`).get()).toEqual({
      source_item_id: expect.stringMatching(/^cursor-source-changed:[a-f0-9]{64}$/),
      failure_code: "cursor_source_changed",
      details_json: JSON.stringify({
        laneId: "lane-ring", expectedSourceId: "ring-1", expectedSourceEpoch: "epoch-1", expectedReadCursor: item.cursor,
        sourceId: "ring-2", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
        earliestCursor: "ring-2:epoch-1:0", latestCursor: "ring-2:epoch-1:8"
      })
    });
    stores.lifecycle.close();
  });

  it("fails a source transition closed when its durable identity fence is stale", () => {
    const stores = createTestStoreBundle(":memory:");
    const item = event({ eventId: "before-stale-source-transition", cursor: "ring-1:epoch-1:3", sourceId: "ring-1" });
    stores.coreEvents.ingestBatch({ ...batch("lane-ring", item, "start", item.cursor), sourceEpoch: "epoch-1" });
    const valid = {
      laneId: "lane-ring", expectedSourceId: "ring-1", expectedSourceEpoch: "epoch-1", expectedReadCursor: item.cursor,
      sourceId: "ring-2", sourceEpoch: "epoch-1", agentKind: "traex" as const, sessionId: "session-1",
      earliestCursor: "ring-2:epoch-1:0", latestCursor: "ring-2:epoch-1:8",
      owner: { kind: "binding" as const, id: "binding-1" }, transitionedAt: "2026-10-12T12:00:00.000Z"
    };

    for (const stale of [
      { ...valid, expectedSourceId: "ring-other" },
      { ...valid, expectedSourceEpoch: "epoch-other" },
      { ...valid, expectedReadCursor: "ring-1:epoch-1:2" },
      { ...valid, agentKind: "pi" as const },
      { ...valid, sessionId: "session-other" }
    ]) expect(stores.coreEvents.transitionSource(stale)).toBe("stale_rebase");

    expect(stores.coreEvents.getCheckpoint("lane-ring")).toMatchObject({ sourceId: "ring-1", sourceEpoch: "epoch-1", readCursor: item.cursor });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_source_changed'").get()).toEqual({ count: 0 });
    stores.lifecycle.close();
  });

  it("lets only one handle transition a physical ring and rolls back a failed transition", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-core-source-transition-"));
    const path = join(directory, "state.sqlite");
    const left = createTestStoreBundle(path);
    const right = createTestStoreBundle(path);
    try {
      const item = event({ eventId: "before-competing-source-transition", cursor: "ring-1:epoch-1:3", sourceId: "ring-1" });
      left.coreEvents.ingestBatch({ ...batch("lane-ring", item, "start", item.cursor), sourceEpoch: "epoch-1" });
      const input = {
        laneId: "lane-ring", expectedSourceId: "ring-1", expectedSourceEpoch: "epoch-1", expectedReadCursor: item.cursor,
        sourceId: "ring-2", sourceEpoch: "epoch-1", agentKind: "traex" as const, sessionId: "session-1",
        earliestCursor: "ring-2:epoch-1:0", latestCursor: "ring-2:epoch-1:8",
        owner: { kind: "binding" as const, id: "binding-1" }, transitionedAt: "2026-10-12T12:00:00.000Z"
      };

      expect(left.coreEvents.transitionSource(input)).toBe("transitioned");
      expect(right.coreEvents.transitionSource(input)).toBe("stale_rebase");
      expect(right.coreEvents.getCheckpoint("lane-ring")).toMatchObject({ sourceId: "ring-2", readCursor: "start" });
      expect(right.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_source_changed'").get()).toEqual({ count: 1 });
    } finally {
      right.lifecycle.close();
      left.lifecycle.close();
    }

    const rollback = createTestStoreBundle(":memory:");
    try {
      const item = event({ eventId: "before-failed-source-transition", cursor: "ring-1:epoch-1:3", sourceId: "ring-1" });
      rollback.coreEvents.ingestBatch({ ...batch("lane-ring", item, "start", item.cursor), sourceEpoch: "epoch-1" });
      rollback.driver.database.exec(`CREATE TRIGGER fail_source_transition
        BEFORE INSERT ON projection_gaps
        WHEN NEW.failure_code='cursor_source_changed'
        BEGIN SELECT RAISE(ABORT, 'simulated source transition failure'); END;`);

      expect(() => rollback.coreEvents.transitionSource({
        laneId: "lane-ring", expectedSourceId: "ring-1", expectedSourceEpoch: "epoch-1", expectedReadCursor: item.cursor,
        sourceId: "ring-2", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
        earliestCursor: "ring-2:epoch-1:0", latestCursor: "ring-2:epoch-1:8",
        owner: { kind: "binding", id: "binding-1" }, transitionedAt: "2026-10-12T12:00:00.000Z"
      })).toThrow("simulated source transition failure");
      expect(rollback.coreEvents.getCheckpoint("lane-ring")).toMatchObject({ sourceId: "ring-1", readCursor: item.cursor });
      expect(rollback.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_source_changed'").get()).toEqual({ count: 0 });
    } finally {
      rollback.lifecycle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("fails an epoch transition closed when any durable identity fence is stale", () => {
    const stores = createTestStoreBundle(":memory:");
    const item = event({ eventId: "before-stale-transition", cursor: "ring-1:epoch-3:164", sourceId: "ring-1" });
    stores.coreEvents.ingestBatch({ ...batch("lane-ring", item, "start", item.cursor), sourceEpoch: "epoch-3" });
    const valid = {
      laneId: "lane-ring", sourceId: "ring-1", expectedSourceEpoch: "epoch-3", expectedReadCursor: item.cursor,
      agentKind: "traex" as const, sessionId: "session-1", sourceEpoch: "epoch-2",
      earliestCursor: "ring-1:epoch-2:0", latestCursor: "ring-1:epoch-2:8",
      owner: { kind: "binding" as const, id: "binding-1" }, rebasedAt: "2026-10-07T12:00:00.000Z"
    };

    for (const stale of [
      { ...valid, sourceId: "ring-other" },
      { ...valid, expectedSourceEpoch: "epoch-old" },
      { ...valid, expectedReadCursor: "ring-1:epoch-3:163" },
      { ...valid, agentKind: "pi" as const },
      { ...valid, sessionId: "session-other" }
    ]) expect(stores.coreEvents.rebaseEpochTransition(stale)).toBe("stale_rebase");

    expect(stores.coreEvents.getCheckpoint("lane-ring")).toMatchObject({ sourceEpoch: "epoch-3", readCursor: item.cursor });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_epoch_changed'").get()).toEqual({ count: 0 });
    stores.lifecycle.close();
  });

  it("rolls back both epoch-transition gap evidence and checkpoint replacement on failure", () => {
    const stores = createTestStoreBundle(":memory:");
    const item = event({ eventId: "before-failed-transition", cursor: "ring-1:epoch-3:164", sourceId: "ring-1" });
    stores.coreEvents.ingestBatch({ ...batch("lane-ring", item, "start", item.cursor), sourceEpoch: "epoch-3" });
    stores.driver.database.exec(`CREATE TRIGGER fail_epoch_transition
      BEFORE INSERT ON projection_gaps
      WHEN NEW.failure_code='cursor_epoch_changed'
      BEGIN SELECT RAISE(ABORT, 'simulated epoch transition failure'); END;`);

    expect(() => stores.coreEvents.rebaseEpochTransition({
      laneId: "lane-ring", sourceId: "ring-1", expectedSourceEpoch: "epoch-3", expectedReadCursor: item.cursor,
      agentKind: "traex", sessionId: "session-1", sourceEpoch: "epoch-2",
      earliestCursor: "ring-1:epoch-2:0", latestCursor: "ring-1:epoch-2:8",
      owner: { kind: "binding", id: "binding-1" }, rebasedAt: "2026-10-07T12:00:00.000Z"
    })).toThrow("simulated epoch transition failure");
    expect(stores.coreEvents.getCheckpoint("lane-ring")).toMatchObject({ sourceEpoch: "epoch-3", readCursor: item.cursor });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_epoch_changed'").get()).toEqual({ count: 0 });
    stores.lifecycle.close();
  });

  it("lets one competing store win an epoch transition and keeps restart retries idempotent", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-core-epoch-transition-"));
    const path = join(directory, "state.sqlite");
    const left = createTestStoreBundle(path);
    const right = createTestStoreBundle(path);
    try {
      const item = event({ eventId: "before-competing-transition", cursor: "ring-1:epoch-3:164", sourceId: "ring-1" });
      left.coreEvents.ingestBatch({ ...batch("lane-ring", item, "start", item.cursor), sourceEpoch: "epoch-3" });
      const input = {
        laneId: "lane-ring", sourceId: "ring-1", expectedSourceEpoch: "epoch-3", expectedReadCursor: item.cursor,
        agentKind: "traex" as const, sessionId: "session-1", sourceEpoch: "epoch-2",
        earliestCursor: "ring-1:epoch-2:0", latestCursor: "ring-1:epoch-2:8",
        owner: { kind: "binding" as const, id: "binding-1" }, rebasedAt: "2026-10-07T12:00:00.000Z"
      };

      expect(left.coreEvents.rebaseEpochTransition(input)).toBe("rebased");
      expect(right.coreEvents.rebaseEpochTransition(input)).toBe("stale_rebase");
      expect(right.coreEvents.getCheckpoint("lane-ring")).toMatchObject({ sourceEpoch: "epoch-2", readCursor: "start" });
      expect(right.coreEvents.loadPending("lane-ring").eventIds).toEqual([item.eventId]);
      expect(right.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_epoch_changed'").get()).toEqual({ count: 1 });
    } finally {
      right.lifecycle.close();
      left.lifecycle.close();
    }

    const restarted = createTestStoreBundle(path);
    try {
      expect(restarted.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_epoch_changed'").get()).toEqual({ count: 1 });
      expect(restarted.coreEvents.loadPending("lane-ring").eventIds).toEqual(["before-competing-transition"]);
    } finally {
      restarted.lifecycle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("rolls back both the gap and checkpoint when an expired-cursor rebase transaction fails", () => {
    const stores = createTestStoreBundle(":memory:");
    const item = event({ eventId: "before-failed-rebase", cursor: "ring-1:epoch-1:3", sourceId: "ring-1" });
    stores.coreEvents.ingestBatch({
      ...batch("lane-ring", item, "start", item.cursor), sourceEpoch: "epoch-1"
    });
    stores.driver.database.exec(`CREATE TRIGGER fail_expired_rebase
      BEFORE UPDATE OF read_cursor ON core_event_lane_checkpoints
      WHEN NEW.read_cursor='ring-1:epoch-1:9'
      BEGIN SELECT RAISE(ABORT, 'simulated rebase failure'); END;`);

    expect(() => stores.coreEvents.rebaseExpiredCheckpoint({
      laneId: "lane-ring", sourceId: "ring-1", sourceEpoch: "epoch-1", expectedSourceEpoch: "epoch-1",
      agentKind: "traex", sessionId: "session-1", expectedReadCursor: item.cursor,
      resumeCursor: "ring-1:epoch-1:9", earliestCursor: "ring-1:epoch-1:10", latestCursor: "ring-1:epoch-1:521",
      owner: { kind: "binding", id: "binding-1" }, rebasedAt: "2026-10-05T12:00:00.000Z"
    })).toThrow("simulated rebase failure");
    expect(stores.coreEvents.getCheckpoint("lane-ring")).toMatchObject({ readCursor: item.cursor, latestCursor: item.cursor });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_expired'").get()).toEqual({ count: 0 });

    stores.lifecycle.close();
  });

  it("lets only one competing SQLite handle rebase the same expired checkpoint", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-core-rebase-"));
    const path = join(directory, "state.sqlite");
    const left = createTestStoreBundle(path);
    const right = createTestStoreBundle(path);
    try {
      const item = event({ eventId: "before-competing-rebase", cursor: "ring-1:epoch-1:3", sourceId: "ring-1" });
      left.coreEvents.ingestBatch({ ...batch("lane-ring", item, "start", item.cursor), sourceEpoch: "epoch-1" });
      const input = {
        laneId: "lane-ring", sourceId: "ring-1", sourceEpoch: "epoch-1", expectedSourceEpoch: "epoch-1",
        agentKind: "traex" as const, sessionId: "session-1", expectedReadCursor: item.cursor,
        resumeCursor: "ring-1:epoch-1:9", earliestCursor: "ring-1:epoch-1:10", latestCursor: "ring-1:epoch-1:521",
        owner: { kind: "binding" as const, id: "binding-1" }, rebasedAt: "2026-10-05T12:00:00.000Z"
      };

      expect(left.coreEvents.rebaseExpiredCheckpoint(input)).toBe("rebased");
      expect(right.coreEvents.rebaseExpiredCheckpoint(input)).toBe("stale_rebase");
      expect(right.coreEvents.getCheckpoint("lane-ring")).toMatchObject({ readCursor: input.resumeCursor });
      expect(right.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_expired'").get()).toEqual({ count: 1 });
    } finally {
      right.lifecycle.close();
      left.lifecycle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("atomically bootstraps a new lane from a typed expired cursor", () => {
    const stores = createTestStoreBundle(":memory:");
    const input = {
      laneId: "lane-new", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex" as const, sessionId: "session-1",
      resumeCursor: "ring-1:epoch-1:9", earliestCursor: "ring-1:epoch-1:10", latestCursor: "ring-1:epoch-1:20",
      owner: { kind: "binding" as const, id: "binding-1" }, observedAt: "2026-10-07T12:00:00.000Z"
    };

    expect(stores.coreEvents.bootstrapExpiredLane(input)).toBe("bootstrapped");
    expect(stores.coreEvents.getCheckpoint(input.laneId)).toEqual({
      sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      readCursor: input.resumeCursor, latestCursor: input.latestCursor
    });
    expect(stores.driver.database.prepare("SELECT failure_code,COUNT(*) AS count FROM projection_gaps GROUP BY failure_code").get())
      .toEqual({ failure_code: "cursor_expired", count: 1 });
    stores.lifecycle.close();
  });

  it("lets only one competing handle bootstrap a new lane", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-core-lane-bootstrap-"));
    const path = join(directory, "state.sqlite");
    const left = createTestStoreBundle(path);
    const right = createTestStoreBundle(path);
    try {
      const input = {
        laneId: "lane-new", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex" as const, sessionId: "session-1",
        resumeCursor: "ring-1:epoch-1:9", earliestCursor: "ring-1:epoch-1:10", latestCursor: "ring-1:epoch-1:20",
        owner: { kind: "binding" as const, id: "binding-1" }, observedAt: "2026-10-07T12:00:00.000Z"
      };

      expect(left.coreEvents.bootstrapExpiredLane(input)).toBe("bootstrapped");
      expect(right.coreEvents.bootstrapExpiredLane(input)).toBe("stale_rebase");
      expect(right.coreEvents.getCheckpoint(input.laneId)).toMatchObject({ readCursor: input.resumeCursor, latestCursor: input.latestCursor });
      expect(right.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_expired'").get()).toEqual({ count: 1 });
    } finally {
      right.lifecycle.close();
      left.lifecycle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("does not adopt a historical lane when bootstrapping a new lane", () => {
    const stores = createTestStoreBundle(":memory:");
    const historical = event({ eventId: "historical-worker-event", sourceId: "ring-1", cursor: "ring-1:epoch-1:1" });
    stores.coreEvents.ingestBatch({
      ...batch("historical-worker-lane", historical, "start", historical.cursor),
      sourceEpoch: "epoch-1", sessionId: historical.sessionId
    });
    const input = {
      laneId: "current-binding-lane", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex" as const, sessionId: "session-1",
      resumeCursor: "ring-1:epoch-1:9", earliestCursor: "ring-1:epoch-1:10", latestCursor: "ring-1:epoch-1:20",
      owner: { kind: "binding" as const, id: "binding-1" }, observedAt: "2026-10-07T12:00:00.000Z"
    };

    expect(stores.coreEvents.bootstrapExpiredLane(input)).toBe("bootstrapped");
    expect(stores.coreEvents.getCheckpoint("historical-worker-lane")).toMatchObject({ readCursor: historical.cursor, latestCursor: historical.cursor });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM core_event_lane_items WHERE lane_id='historical-worker-lane'").get()).toEqual({ count: 1 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM core_event_lane_items WHERE lane_id='current-binding-lane'").get()).toEqual({ count: 0 });
    stores.lifecycle.close();
  });

  it("rejects bootstrap when the current lane already has an item without a checkpoint", () => {
    const stores = createTestStoreBundle(":memory:");
    const item = event({ eventId: "orphan-current-lane-event", sourceId: "ring-1", cursor: "ring-1:epoch-1:1" });
    stores.driver.database.prepare(`INSERT INTO core_event_inbox(
      event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type
    ) VALUES (?,?,?,?,?,?,?,?,?,?)`).run(
      item.eventId, item.sourceId, item.agentKind, item.sessionId, item.turnId, item.cursor, item.occurredAt,
      JSON.stringify(item), item.occurredAt, "message"
    );
    stores.driver.database.prepare(`INSERT INTO core_event_lane_items(
      lane_id,event_id,sequence,state,created_at,updated_at
    ) VALUES (?,?,1,'pending',?,?)`).run("current-binding-lane", item.eventId, item.occurredAt, item.occurredAt);
    const input = {
      laneId: "current-binding-lane", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex" as const, sessionId: "session-1",
      resumeCursor: "ring-1:epoch-1:9", earliestCursor: "ring-1:epoch-1:10", latestCursor: "ring-1:epoch-1:20",
      owner: { kind: "binding" as const, id: "binding-1" }, observedAt: "2026-10-07T12:00:00.000Z"
    };

    expect(stores.coreEvents.bootstrapExpiredLane(input)).toBe("stale_rebase");
    expect(stores.coreEvents.getCheckpoint(input.laneId)).toBeNull();
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_expired'").get()).toEqual({ count: 0 });
    stores.lifecycle.close();
  });

  it("rejects a rebase after the durable checkpoint epoch changes", () => {
    const stores = createTestStoreBundle(":memory:");
    const item = event({ eventId: "before-epoch-change", cursor: "ring-1:epoch-1:3", sourceId: "ring-1" });
    stores.coreEvents.ingestBatch({ ...batch("lane-ring", item, "start", item.cursor), sourceEpoch: "epoch-1" });
    stores.coreEvents.ingestBatch({
      laneId: "lane-ring", sourceId: "ring-1", sourceEpoch: "epoch-2", agentKind: "traex", sessionId: "session-1",
      afterCursor: item.cursor, nextCursor: item.cursor, latestCursor: "ring-1:epoch-2:40", events: [],
      ingestedAt: "2026-10-05T12:00:01.000Z"
    });

    expect(stores.coreEvents.rebaseExpiredCheckpoint({
      laneId: "lane-ring", sourceId: "ring-1", sourceEpoch: "epoch-1", expectedSourceEpoch: "epoch-1",
      agentKind: "traex", sessionId: "session-1", expectedReadCursor: item.cursor,
      resumeCursor: "ring-1:epoch-1:9", earliestCursor: "ring-1:epoch-1:10", latestCursor: "ring-1:epoch-1:521",
      owner: { kind: "binding", id: "binding-1" }, rebasedAt: "2026-10-05T12:00:02.000Z"
    })).toBe("stale_rebase");
    expect(stores.coreEvents.getCheckpoint("lane-ring")).toMatchObject({
      sourceEpoch: "epoch-2", readCursor: item.cursor, latestCursor: "ring-1:epoch-2:40"
    });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE failure_code='cursor_expired'").get()).toEqual({ count: 0 });

    stores.lifecycle.close();
  });

  it("rejects an advancing batch from a different source epoch while allowing metadata-only epoch refresh", () => {
    const stores = createTestStoreBundle(":memory:");
    const first = event({ eventId: "epoch-one", cursor: "ring-1:epoch-1:1", sourceId: "ring-1" });
    stores.coreEvents.ingestBatch({ ...batch("lane-ring", first, "start", first.cursor), sourceEpoch: "epoch-1" });

    const foreign = event({ eventId: "epoch-two-event", cursor: "ring-1:epoch-2:1", sourceId: "ring-1" });
    expect(() => stores.coreEvents.ingestBatch({
      ...batch("lane-ring", foreign, first.cursor, foreign.cursor), sourceEpoch: "epoch-2"
    })).toThrow("Core event inbox source epoch mismatch");
    expect(stores.coreEvents.getCheckpoint("lane-ring")).toMatchObject({ sourceEpoch: "epoch-1", readCursor: first.cursor });
    expect(stores.driver.database.prepare("SELECT 1 FROM core_event_inbox WHERE event_id=?").get(foreign.eventId)).toBeUndefined();

    expect(stores.coreEvents.ingestBatch({
      laneId: "lane-ring", sourceId: "ring-1", sourceEpoch: "epoch-2", agentKind: "traex", sessionId: "session-1",
      afterCursor: first.cursor, nextCursor: first.cursor, latestCursor: "ring-1:epoch-2:9", events: [],
      ingestedAt: "2026-10-05T12:00:01.000Z"
    })).toBe("accepted");
    expect(stores.coreEvents.getCheckpoint("lane-ring")).toMatchObject({ sourceEpoch: "epoch-2", readCursor: first.cursor });
    stores.lifecycle.close();
  });

  it("elides an exact caught-up checkpoint poll without opening a write transaction", () => {
    const context = new SqliteContext(":memory:");
    new SqliteMigrations(context).run();
    const inbox = new SqliteCoreEventInboxStore(context);
    const first = event({ eventId: "caught-up-first", cursor: "ring-1:epoch-1:1", sourceId: "ring-1" });
    inbox.ingestBatch({ ...batch("lane-caught-up", first, "start", first.cursor), sourceEpoch: "epoch-1" });
    const before = context.database.prepare("SELECT updated_at FROM core_event_lane_checkpoints WHERE lane_id=?")
      .get("lane-caught-up");
    const transactionCount = context.runtimeDiagnostics().transactionCount;

    expect(inbox.ingestBatch({
      laneId: "lane-caught-up", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: first.cursor, nextCursor: first.cursor, latestCursor: first.cursor, events: [],
      ingestedAt: "2026-10-05T12:00:02.000Z"
    })).toBe("accepted");
    expect(context.runtimeDiagnostics().transactionCount).toBe(transactionCount);
    expect(context.database.prepare("SELECT updated_at FROM core_event_lane_checkpoints WHERE lane_id=?").get("lane-caught-up")).toEqual(before);

    expect(inbox.ingestBatch({
      laneId: "lane-caught-up", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: first.cursor, nextCursor: first.cursor, latestCursor: "ring-1:epoch-1:2", events: [],
      ingestedAt: "2026-10-05T12:00:03.000Z"
    })).toBe("accepted");
    expect(context.runtimeDiagnostics().transactionCount).toBe(transactionCount + 1);
    expect(context.runtimeDiagnostics().lastTransaction?.operation).toBe("sqlite.core-event-inbox-store.ingest-batch");
    expect(inbox.getCheckpoint("lane-caught-up")).toMatchObject({ sourceEpoch: "epoch-1", latestCursor: "ring-1:epoch-1:2" });

    expect(inbox.ingestBatch({
      laneId: "lane-caught-up", sourceId: "ring-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: first.cursor, nextCursor: first.cursor, latestCursor: "ring-1:epoch-1:2", events: [],
      ingestedAt: "2026-10-05T12:00:03.500Z"
    })).toBe("accepted");
    expect(context.runtimeDiagnostics().transactionCount).toBe(transactionCount + 2);

    expect(inbox.ingestBatch({
      laneId: "lane-caught-up", sourceId: "ring-1", sourceEpoch: "epoch-2", agentKind: "traex", sessionId: "session-1",
      afterCursor: first.cursor, nextCursor: first.cursor, latestCursor: "ring-1:epoch-2:2", events: [],
      ingestedAt: "2026-10-05T12:00:04.000Z"
    })).toBe("accepted");
    expect(context.runtimeDiagnostics().transactionCount).toBe(transactionCount + 3);
    expect(inbox.getCheckpoint("lane-caught-up")).toMatchObject({ sourceEpoch: "epoch-2", latestCursor: "ring-1:epoch-2:2" });
    context.close();
  });

  it("reports bounded operation-specific labels for Core inbox mutations", () => {
    const context = new SqliteContext(":memory:");
    new SqliteMigrations(context).run();
    const inbox = new SqliteCoreEventInboxStore(context);
    const first = event({ eventId: "labeled-ingest", cursor: "cursor-1" });

    inbox.ingestBatch(batch("lane-labeled", first, "start", first.cursor));
    expect(context.runtimeDiagnostics().lastTransaction?.operation).toBe("sqlite.core-event-inbox-store.ingest-batch");

    expect(inbox.bootstrapExpiredLane({
      laneId: "lane-bootstrap-label", sourceId: "ring-label", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      resumeCursor: "cursor-8", earliestCursor: "cursor-9", latestCursor: "cursor-12",
      owner: { kind: "binding", id: "binding-label" }, observedAt: "2026-10-13T00:00:00.000Z"
    })).toBe("bootstrapped");
    expect(context.runtimeDiagnostics().lastTransaction?.operation).toBe("sqlite.core-event-inbox-store.bootstrap-expired-lane");

    expect(inbox.rebaseExpiredCheckpoint({
      laneId: "lane-bootstrap-label", sourceId: "ring-label", expectedSourceEpoch: "epoch-1", sourceEpoch: "epoch-1",
      agentKind: "traex", sessionId: "session-1", expectedReadCursor: "cursor-8",
      resumeCursor: "cursor-9", earliestCursor: "cursor-9", latestCursor: "cursor-12",
      owner: { kind: "binding", id: "binding-label" }, rebasedAt: "2026-10-13T00:00:00.100Z"
    })).toBe("rebased");
    expect(context.runtimeDiagnostics().lastTransaction?.operation).toBe("sqlite.core-event-inbox-store.rebase-expired-checkpoint");

    expect(inbox.bootstrapExpiredLane({
      laneId: "lane-epoch-label", sourceId: "ring-epoch", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      resumeCursor: "cursor-3", earliestCursor: "cursor-4", latestCursor: "cursor-8",
      owner: { kind: "binding", id: "binding-label" }, observedAt: "2026-10-13T00:00:00.200Z"
    })).toBe("bootstrapped");
    expect(inbox.rebaseEpochTransition({
      laneId: "lane-epoch-label", sourceId: "ring-epoch", expectedSourceEpoch: "epoch-1", sourceEpoch: "epoch-2",
      agentKind: "traex", sessionId: "session-1", expectedReadCursor: "cursor-3",
      earliestCursor: "epoch-2:1", latestCursor: "epoch-2:8",
      owner: { kind: "binding", id: "binding-label" }, rebasedAt: "2026-10-13T00:00:00.300Z"
    })).toBe("rebased");
    expect(context.runtimeDiagnostics().lastTransaction?.operation).toBe("sqlite.core-event-inbox-store.rebase-epoch-transition");

    expect(inbox.bootstrapExpiredLane({
      laneId: "lane-source-label", sourceId: "ring-source-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      resumeCursor: "cursor-3", earliestCursor: "cursor-4", latestCursor: "cursor-8",
      owner: { kind: "binding", id: "binding-label" }, observedAt: "2026-10-13T00:00:00.400Z"
    })).toBe("bootstrapped");
    expect(inbox.transitionSource({
      laneId: "lane-source-label", expectedSourceId: "ring-source-1", expectedSourceEpoch: "epoch-1", expectedReadCursor: "cursor-3",
      sourceId: "ring-source-2", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      earliestCursor: "source-2:1", latestCursor: "source-2:8",
      owner: { kind: "binding", id: "binding-label" }, transitionedAt: "2026-10-13T00:00:00.500Z"
    })).toBe("transitioned");
    expect(context.runtimeDiagnostics().lastTransaction?.operation).toBe("sqlite.core-event-inbox-store.transition-source");

    inbox.recordInvalidCursorGap({
      laneId: "lane-labeled", sourceId: "live-source", sourceEpoch: null, agentKind: "traex", sessionId: "session-1",
      readCursor: first.cursor, owner: { kind: "binding", id: "binding-label" }, occurredAt: "2026-10-13T00:00:00.600Z"
    });
    expect(context.runtimeDiagnostics().lastTransaction?.operation).toBe("sqlite.core-event-inbox-store.record-invalid-cursor-gap");

    inbox.ingestCanonicalSnapshotEvidence([
      event({ eventId: "labeled-snapshot", cursor: "cursor-snapshot" })
    ], "2026-10-13T00:00:01.000Z");
    expect(context.runtimeDiagnostics().lastTransaction?.operation).toBe("sqlite.core-event-inbox-store.ingest-canonical-snapshot-evidence");

    expect(inbox.acknowledge("lane-labeled", [first.eventId], "projected", "2026-10-13T00:00:02.000Z")).toBe("settled");
    expect(context.runtimeDiagnostics().lastTransaction?.operation).toBe("sqlite.core-event-inbox-store.acknowledge");
    context.close();
  });

  it("keeps canonical projections and delivery intents unchanged when a retained event is reread", () => {
    const stores = createTestStoreBundle(":memory:");
    stores.driver.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "chat-1", topicId: "topic-1", rootMessageId: "root-1", title: "Task" });
    stores.driver.updateBinding("binding-1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1" });
    stores.agentInputs.admit({
      submissionId: "submission-refill", ingressSource: "feishu:primary", sourceMessageKey: "message-refill",
      actor: { kind: "human", id: "user-1", gatewayId: "feishu:primary", chatId: "chat-1", topicId: "topic-1", rootMessageId: "root-1" },
      text: "continue", owner: { kind: "primary", id: "binding-1", generation: 1 },
      paneId: "w1:p1", terminalId: "terminal-1", expectedAgentKind: "traex", expectedSessionId: "session-1",
      recordedAt: "2026-10-05T12:00:00.000Z"
    });
    const beforeExpiry = event({ eventId: "before-refill", cursor: "ring-1:epoch-1:3", sourceId: "ring-1", turnId: null });
    stores.coreEvents.ingestBatch({ ...batch("lane-ring", beforeExpiry, "start", beforeExpiry.cursor), sourceEpoch: "epoch-1" });
    expect(stores.coreEvents.rebaseExpiredCheckpoint({
      laneId: "lane-ring", sourceId: "ring-1", sourceEpoch: "epoch-1", expectedSourceEpoch: "epoch-1",
      agentKind: "traex", sessionId: "session-1", expectedReadCursor: beforeExpiry.cursor,
      resumeCursor: "ring-1:epoch-1:9", earliestCursor: "ring-1:epoch-1:10", latestCursor: "ring-1:epoch-1:10",
      owner: { kind: "binding", id: "binding-1" }, rebasedAt: "2026-10-05T12:00:01.000Z"
    })).toBe("rebased");
    const retained = event({
      eventId: "retained-human", cursor: "ring-1:epoch-1:10", sourceId: "ring-1", turnId: "turn-refill",
      payload: { type: "human_message", message_id: "message-refill", text: "continue", truncated: false, submission_id: "submission-refill" }
    });
    const retainedBatch = {
      ...batch("lane-ring", retained, "ring-1:epoch-1:9", retained.cursor), sourceEpoch: "epoch-1"
    };
    expect(stores.coreEvents.ingestBatch(retainedBatch)).toBe("accepted");
    const counts = stores.driver.database.prepare(`SELECT
      (SELECT COUNT(*) FROM core_event_lane_items) AS lane_items,
      (SELECT COUNT(*) FROM conversation_segments) AS segments,
      (SELECT COUNT(*) FROM conversation_segment_pages) AS pages,
      (SELECT COUNT(*) FROM outbound_replies) AS outbox,
      (SELECT COUNT(*) FROM input_card_views) AS input_cards,
      (SELECT view_version FROM conversation_segments WHERE submission_id='submission-refill') AS view_revision`).get();

    expect(stores.coreEvents.ingestBatch(retainedBatch)).toBe("stale_rebase");
    expect(stores.driver.database.prepare(`SELECT
      (SELECT COUNT(*) FROM core_event_lane_items) AS lane_items,
      (SELECT COUNT(*) FROM conversation_segments) AS segments,
      (SELECT COUNT(*) FROM conversation_segment_pages) AS pages,
      (SELECT COUNT(*) FROM outbound_replies) AS outbox,
      (SELECT COUNT(*) FROM input_card_views) AS input_cards,
      (SELECT view_version FROM conversation_segments WHERE submission_id='submission-refill') AS view_revision`).get()).toEqual(counts);

    stores.lifecycle.close();
  });

  it("adds checkpoint epoch and gap details to an existing database idempotently", () => {
    const context = new SqliteContext(":memory:");
    context.database.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE core_event_lane_checkpoints(
        lane_id TEXT PRIMARY KEY, source_id TEXT NOT NULL, agent_kind TEXT NOT NULL CHECK(agent_kind IN ('traex','pi')),
        session_id TEXT NOT NULL, read_cursor TEXT NOT NULL, latest_cursor TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE TABLE projection_gaps(
        id INTEGER PRIMARY KEY AUTOINCREMENT,
        stage TEXT NOT NULL CHECK(stage IN ('core_projection','answer_delivery','main_delivery','worker_delivery','turn_recovery')),
        owner_kind TEXT NOT NULL CHECK(owner_kind IN ('binding','prompt','answer_page','worker_turn','turn_card')),
        owner_id TEXT NOT NULL, source_item_id TEXT NOT NULL, failure_class TEXT NOT NULL DEFAULT 'unknown', failure_code TEXT NOT NULL, required_version INTEGER,
        occurrence_count INTEGER NOT NULL DEFAULT 1 CHECK(occurrence_count >= 1), state TEXT NOT NULL DEFAULT 'open' CHECK(state IN ('open','compensated','dismissed')),
        compensated_by_version INTEGER, first_failed_at TEXT NOT NULL, last_failed_at TEXT NOT NULL, compensated_at TEXT,
        UNIQUE(stage,owner_kind,owner_id,source_item_id)
      );
      INSERT INTO core_event_lane_checkpoints(lane_id,source_id,agent_kind,session_id,read_cursor,latest_cursor,updated_at)
        VALUES ('lane-legacy','ring-legacy','traex','session-legacy','cursor-3','cursor-4','2026-10-05T12:00:00.000Z');
      INSERT INTO projection_gaps(stage,owner_kind,owner_id,source_item_id,failure_code,first_failed_at,last_failed_at)
        VALUES ('core_projection','binding','binding-legacy','event-legacy','legacy_gap','2026-10-05T12:00:00.000Z','2026-10-05T12:00:00.000Z');
    `);

    new SqliteMigrations(context).run();
    new SqliteMigrations(context).run();

    expect(context.database.prepare("SELECT source_epoch,read_cursor,latest_cursor FROM core_event_lane_checkpoints WHERE lane_id='lane-legacy'").get())
      .toEqual({ source_epoch: null, read_cursor: "cursor-3", latest_cursor: "cursor-4" });
    expect(context.database.prepare("SELECT details_json,failure_code FROM projection_gaps WHERE owner_id='binding-legacy'").get())
      .toEqual({ details_json: null, failure_code: "legacy_gap" });
    expect(context.database.prepare("SELECT version FROM schema_migrations WHERE version=102").get()).toEqual({ version: 102 });

    context.close();
  });

  it("accepts an already-ingested stale cursor replay without moving the checkpoint backwards", () => {
    const stores = createTestStoreBundle(":memory:");
    const first = event({ eventId: "first", cursor: "c1" });
    const second = event({ eventId: "second", cursor: "c2", occurredAt: "2026-09-30T00:00:01.000Z" });

    stores.coreEvents.ingestBatch(batch("lane-live", first, "start", "c1"));
    stores.coreEvents.ingestBatch(batch("lane-live", second, "c1", "c2"));

    expect(() => stores.coreEvents.ingestBatch(batch("lane-live", first, "start", "c1"))).not.toThrow();
    expect(stores.coreEvents.getCheckpoint("lane-live")).toMatchObject({ readCursor: "c2", latestCursor: "c2" });
    expect(stores.coreEvents.loadPending("lane-live").eventIds).toEqual(["first", "second"]);

    stores.lifecycle.close();
  });

  it("rebases a stale overlapping batch instead of appending an unseen opaque-cursor tail", () => {
    const stores = createTestStoreBundle(":memory:");
    const first = event({ eventId: "first", cursor: "c1" });
    const second = event({ eventId: "second", cursor: "c2", occurredAt: "2026-09-30T00:00:01.000Z" });
    const unseenTail = event({ eventId: "unseen-tail", cursor: "c3", occurredAt: "2026-09-30T00:00:02.000Z" });

    stores.coreEvents.ingestBatch(batch("lane-live", first, "start", "c1"));
    stores.coreEvents.ingestBatch(batch("lane-live", second, "c1", "c2"));

    expect(stores.coreEvents.ingestBatch({
      ...batch("lane-live", first, "start", "c3"),
      events: [first, unseenTail]
    })).toBe("stale_rebase");
    expect(stores.coreEvents.getCheckpoint("lane-live")).toMatchObject({ readCursor: "c2", latestCursor: "c2" });
    expect(stores.coreEvents.loadPending("lane-live").eventIds).toEqual(["first", "second"]);
    expect(stores.driver.database.prepare(
      "SELECT 1 FROM core_event_inbox WHERE event_id = ?"
    ).get(unseenTail.eventId)).toBeUndefined();

    stores.lifecycle.close();
  });

  it("lets either v2 repair or v3 delivery win the shared lane CAS without duplicate tails", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-core-v2-v3-cas-"));
    const path = join(directory, "state.sqlite");
    const v2 = createTestStoreBundle(path);
    const v3 = createTestStoreBundle(path);
    try {
      const v2Winner = event({ eventId: "v2-winner", sourceId: "ring-1", cursor: "ring-1:epoch-1:1" });
      const v2Batch = { ...batch("lane-v2-wins", v2Winner, "start", v2Winner.cursor), sourceEpoch: "epoch-1" };
      expect(v2.coreEvents.ingestBatch(v2Batch)).toBe("accepted");
      expect(v3.coreEvents.ingestBatch(v2Batch)).toBe("stale_rebase");

      const v3Winner = event({ eventId: "v3-winner", sourceId: "ring-2", cursor: "ring-2:epoch-1:1" });
      const v3Batch = { ...batch("lane-v3-wins", v3Winner, "start", v3Winner.cursor), sourceEpoch: "epoch-1" };
      expect(v3.coreEvents.ingestBatch(v3Batch)).toBe("accepted");
      expect(v2.coreEvents.ingestBatch(v3Batch)).toBe("stale_rebase");

      expect(v2.coreEvents.getCheckpoint("lane-v2-wins")).toMatchObject({ readCursor: v2Winner.cursor });
      expect(v2.coreEvents.getCheckpoint("lane-v3-wins")).toMatchObject({ readCursor: v3Winner.cursor });
      expect(v2.driver.database.prepare("SELECT lane_id,COUNT(*) AS count FROM core_event_lane_items WHERE lane_id IN ('lane-v2-wins','lane-v3-wins') GROUP BY lane_id ORDER BY lane_id").all())
        .toEqual([{ lane_id: "lane-v2-wins", count: 1 }, { lane_id: "lane-v3-wins", count: 1 }]);
    } finally {
      v3.lifecycle.close();
      v2.lifecycle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replays after restart when projection and Core settlement fail to commit atomically", () => {
    const directory = mkdtempSync(join(tmpdir(), "herdr-core-projection-"));
    const path = join(directory, "state.sqlite");
    const item = event();
    const settlement = {
      laneId: "lane-live",
      eventIds: [item.eventId],
      occurredAt: "2026-09-30T00:00:02.000Z",
      owner: { kind: "binding" as const, id: "binding-1" }
    };
    let stores = createTestStoreBundle(path);
    try {
      stores.bindingProvisioning.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
      stores.coreEvents.ingestBatch(batch(settlement.laneId, item, "start", item.cursor));
      expect(() => stores.projection.projectCoreEvent(settlement, { kind: "prompt", id: "prompt-1" }, () => {
        stores.projection.saveTopicView(updateTopicView(initialTopicView("binding-1"), { title: "uncommitted" }));
        throw new Error("simulated commit boundary failure");
      })).toThrow("simulated commit boundary failure");
      expect(stores.projection.loadTopicView("binding-1")).toBeNull();
      expect(stores.coreEvents.loadPending(settlement.laneId).eventIds).toEqual([item.eventId]);
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM core_event_owner_projections").get()).toEqual({ count: 0 });

      stores.lifecycle.close();
      stores = createTestStoreBundle(path);
      expect(stores.coreEvents.loadPending(settlement.laneId).eventIds).toEqual([item.eventId]);
      stores.projection.projectCoreEvent(settlement, { kind: "prompt", id: "prompt-1" }, () => {
        stores.projection.saveTopicView(updateTopicView(initialTopicView("binding-1"), { title: "committed" }));
      });
      expect(stores.projection.loadTopicView("binding-1")?.title).toBe("committed");
      expect(stores.coreEvents.loadPending(settlement.laneId).eventIds).toEqual([]);
      expect(stores.driver.database.prepare("SELECT owner_kind, owner_id, event_id, reducer_revision FROM core_event_owner_projections").all()).toEqual([{
        owner_kind: "prompt", owner_id: "prompt-1", event_id: item.eventId, reducer_revision: 1
      }]);
    } finally {
      stores.lifecycle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("replays a projected Turn in the first authoritative Core batch order", () => {
    const stores = createTestStoreBundle(":memory:");
    const occurredAt = "2026-09-30T00:00:00.000Z";
    stores.driver.database.prepare(`INSERT INTO conversation_turn_projections(
      agent_kind, session_id, turn_id, started_at, source_lane_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      "traex", "session-1", "turn-1", occurredAt, "lane-live", occurredAt, occurredAt
    );
    const started = event({
      eventId: "turn-start",
      cursor: "live-source:1",
      occurredAt,
      payload: { type: "turn_started" }
    });
    const human = event({
      eventId: "z-human-first-in-core",
      cursor: "live-source:2",
      occurredAt,
      payload: { type: "human_message", message_id: "human-1", text: "direct input", truncated: false }
    });
    const firstTool = event({
      eventId: "y-tool-second-in-core",
      cursor: "live-source:3",
      occurredAt,
      payload: { type: "tool_call", call_id: "first", name: "first_tool", arguments: "{}", truncated: false }
    });
    const secondTool = event({
      eventId: "a-tool-third-in-core",
      cursor: "live-source:4",
      occurredAt,
      payload: { type: "tool_call", call_id: "second", name: "second_tool", arguments: "{}", truncated: false }
    });
    stores.coreEvents.ingestBatch({
      ...batch("lane-live", started, "start", "live-source:4"),
      events: [started, human, firstTool, secondTool]
    });
    stores.coreEvents.acknowledge("lane-live", [started.eventId, human.eventId, firstTool.eventId, secondTool.eventId], "projected", "2026-09-30T00:00:01.000Z");

    const recovered = [started, secondTool, firstTool, human].map((item, index) => ({
      ...item,
      sourceId: "recovery-source",
      cursor: `recovery-source:${index + 1}`
    }));
    stores.coreEvents.ingestBatch({
      laneId: "lane-recovery",
      sourceId: "recovery-source",
      agentKind: "traex",
      sessionId: "session-1",
      afterCursor: "start",
      nextCursor: "recovery-source:4",
      latestCursor: "recovery-source:4",
      events: recovered,
      ingestedAt: "2026-09-30T00:00:02.000Z"
    });
    stores.coreEvents.acknowledge("lane-recovery", recovered.map(({ eventId }) => eventId), "projected", "2026-09-30T00:00:03.000Z");

    const formalOrder = stores.driver.database.prepare(`SELECT event_id FROM conversation_turn_projection_events
      WHERE agent_kind = ? AND session_id = ? AND turn_id = ? AND started_at = ?
      ORDER BY sequence`).all("traex", "session-1", "turn-1", occurredAt) as Array<{ event_id: string }>;
    expect(formalOrder.map(({ event_id }) => event_id)).toEqual([
      "turn-start",
      "z-human-first-in-core",
      "y-tool-second-in-core",
      "a-tool-third-in-core"
    ]);

    expect(stores.coreEvents.loadProjectedTurnViewEvents({
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "turn-1",
      startedAt: occurredAt
    }).map(({ eventId }) => eventId)).toEqual(["y-tool-second-in-core", "a-tool-third-in-core"]);

    stores.driver.database.prepare(`UPDATE core_event_inbox SET event_json='null',payload_compacted_at=? WHERE event_id=?`)
      .run("2026-10-17T00:00:00.000Z", firstTool.eventId);
    expect(stores.coreEvents.loadProjectedTurnViewEvents({
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "turn-1",
      startedAt: occurredAt
    }).map(({ eventId }) => eventId)).toEqual(["a-tool-third-in-core"]);

    stores.lifecycle.close();
  });

  it("records Core order only for an existing legacy Turn projection", () => {
    const stores = createTestStoreBundle(":memory:");
    const occurredAt = "2026-09-30T00:00:00.000Z";
    const directStarted = event({
      eventId: "direct-turn-start",
      cursor: "direct-source:1",
      sourceId: "direct-source",
      turnId: "direct-turn",
      occurredAt,
      payload: { type: "turn_started" }
    });
    stores.coreEvents.ingestBatch(batch("lane-direct", directStarted, "start", directStarted.cursor));
    stores.coreEvents.acknowledge("lane-direct", [directStarted.eventId], "projected", "2026-09-30T00:00:01.000Z");

    expect(stores.driver.database.prepare(`SELECT COUNT(*) AS count FROM conversation_turn_projections
      WHERE agent_kind = ? AND session_id = ? AND turn_id = ?`).get(
      "traex", "session-1", "direct-turn"
    )).toEqual({ count: 0 });
    expect(stores.driver.database.prepare(`SELECT COUNT(*) AS count FROM conversation_turn_projection_events
      WHERE event_id = ?`).get(directStarted.eventId)).toEqual({ count: 0 });

    stores.driver.database.prepare(`INSERT INTO conversation_turn_projections(
      agent_kind, session_id, turn_id, started_at, source_lane_id, created_at, updated_at
    ) VALUES (?, ?, ?, ?, ?, ?, ?)`).run(
      "traex", "session-1", "legacy-turn", occurredAt, "lane-legacy", occurredAt, occurredAt
    );
    const legacyStarted = event({
      eventId: "legacy-turn-start",
      cursor: "legacy-source:1",
      sourceId: "legacy-source",
      turnId: "legacy-turn",
      occurredAt,
      payload: { type: "turn_started" }
    });
    stores.coreEvents.ingestBatch(batch("lane-legacy", legacyStarted, "start", legacyStarted.cursor));
    stores.coreEvents.acknowledge("lane-legacy", [legacyStarted.eventId], "projected", "2026-09-30T00:00:02.000Z");

    expect(stores.driver.database.prepare(`SELECT event_id, sequence FROM conversation_turn_projection_events
      WHERE agent_kind = ? AND session_id = ? AND turn_id = ? ORDER BY sequence`).all(
      "traex", "session-1", "legacy-turn"
    )).toEqual([{ event_id: legacyStarted.eventId, sequence: 1 }]);

    stores.lifecycle.close();
  });

  it("does not invent Turn order when authoritative projection evidence is absent", () => {
    const stores = createTestStoreBundle(":memory:");
    const occurredAt = "2026-09-30T00:00:00.000Z";
    const started = event({ eventId: "legacy-start", cursor: "legacy:1", occurredAt, payload: { type: "turn_started" } });
    const first = event({
      eventId: "z-legacy-first",
      cursor: "legacy:2",
      occurredAt,
      payload: { type: "tool_call", call_id: "first", name: "first_tool", arguments: "{}", truncated: false }
    });
    const second = event({
      eventId: "a-legacy-second",
      cursor: "legacy:3",
      occurredAt,
      payload: { type: "tool_call", call_id: "second", name: "second_tool", arguments: "{}", truncated: false }
    });
    stores.coreEvents.ingestBatch({
      ...batch("legacy-lane", started, "start", "legacy:3"),
      events: [started, first, second]
    });
    stores.coreEvents.acknowledge("legacy-lane", [started.eventId, first.eventId, second.eventId], "projected", "2026-09-30T00:00:01.000Z");
    stores.driver.database.prepare("DELETE FROM conversation_turn_projection_events").run();

    expect(stores.coreEvents.loadProjectedTurnViewEvents({
      agentKind: "traex",
      sessionId: "session-1",
      turnId: "turn-1",
      startedAt: occurredAt
    })).toEqual([]);
    stores.lifecycle.close();
  });

  it("projects one Core event at most once for the same owner and reducer revision", () => {
    const stores = createTestStoreBundle(":memory:");
    const live = event();
    const recovered = event({ cursor: "recovery:transcript:1", sourceId: "recovery:transcript" });
    const projectionOwner = { kind: "prompt" as const, id: "prompt-1" };
    let projections = 0;

    stores.coreEvents.ingestBatch(batch("lane-live", live, "start", live.cursor));
    expect(stores.projection.projectCoreEvent({
      laneId: "lane-live", eventIds: [live.eventId], occurredAt: "2026-09-30T00:00:02.000Z",
      owner: { kind: "binding", id: "binding-1" }
    }, projectionOwner, () => { projections += 1; return "first"; })).toEqual({ outcome: "projected", value: "first" });

    stores.coreEvents.ingestBatch(batch("lane-recovery", recovered, "", recovered.cursor));
    expect(stores.projection.projectCoreEvent({
      laneId: "lane-recovery", eventIds: [recovered.eventId], occurredAt: "2026-09-30T00:00:03.000Z",
      owner: { kind: "binding", id: "binding-1" }
    }, projectionOwner, () => { projections += 1; return "duplicate"; })).toEqual({ outcome: "current" });

    expect(projections).toBe(1);
    expect(stores.coreEvents.loadPending("lane-live").eventIds).toEqual([]);
    expect(stores.coreEvents.loadPending("lane-recovery").eventIds).toEqual([]);
    expect(stores.driver.database.prepare("SELECT owner_kind, owner_id, event_id, reducer_revision FROM core_event_owner_projections").all()).toEqual([{
      owner_kind: "prompt", owner_id: "prompt-1", event_id: live.eventId, reducer_revision: 1
    }]);

    const anotherOwner = event({ cursor: "recovery:other:1", sourceId: "recovery:other" });
    stores.coreEvents.ingestBatch(batch("lane-other", anotherOwner, "", anotherOwner.cursor));
    expect(stores.projection.projectCoreEvent({
      laneId: "lane-other", eventIds: [anotherOwner.eventId], occurredAt: "2026-09-30T00:00:04.000Z",
      owner: { kind: "binding", id: "binding-2" }
    }, { kind: "prompt", id: "prompt-2" }, () => { projections += 1; return "other-owner"; })).toEqual({ outcome: "projected", value: "other-owner" });
    expect(projections).toBe(2);
    expect(stores.driver.database.prepare("SELECT owner_id FROM core_event_owner_projections ORDER BY owner_id").all()).toEqual([
      { owner_id: "prompt-1" }, { owner_id: "prompt-2" }
    ]);
    stores.lifecycle.close();
  });

  it("retries a poison event three times before quarantining only that event", () => {
    const stores = createTestStoreBundle(":memory:");
    const poison = event({ eventId: "poison", cursor: "c1" });
    const healthy = event({ eventId: "healthy", cursor: "c2" });
    stores.coreEvents.ingestBatch({ ...batch("lane-live", poison, "start", "c2"), events: [poison, healthy] });

    for (const occurredAt of ["2026-09-30T00:00:02.000Z", "2026-09-30T00:00:03.000Z"]) {
      stores.coreEvents.acknowledge("lane-live", [poison.eventId], "quarantined", occurredAt, "bad token secret=hidden", { kind: "binding", id: "binding-1" });
      expect(stores.coreEvents.loadPending("lane-live").eventIds).toEqual([poison.eventId, healthy.eventId]);
      expect(stores.coreEvents.countOpenProjectionGaps({ kind: "binding", id: "binding-1" })).toBe(0);
    }
    stores.coreEvents.acknowledge("lane-live", [poison.eventId], "quarantined", "2026-09-30T00:00:04.000Z", "bad token secret=hidden", { kind: "binding", id: "binding-1" });

    expect(stores.coreEvents.loadPending("lane-live").eventIds).toEqual([healthy.eventId]);
    expect(stores.coreEvents.getCheckpoint("lane-live")).toMatchObject({ readCursor: "c2" });
    expect(stores.coreEvents.countOpenProjectionGaps({ kind: "binding", id: "binding-1" })).toBe(1);
    expect(stores.driver.database.prepare("SELECT state, attempt_count, length(failure_fingerprint) AS fingerprint_length, failure FROM core_event_lane_items WHERE lane_id='lane-live' AND event_id='poison'").get()).toEqual({
      state: "quarantined", attempt_count: 3, fingerprint_length: 64,
      failure: expect.stringMatching(/^[a-f0-9]{64}$/)
    });
    expect(stores.driver.database.prepare("SELECT stage, failure_class, failure_code, required_version FROM projection_gaps WHERE source_item_id = 'poison'").get()).toEqual({
      stage: "core_projection", failure_class: "projection", failure_code: expect.stringMatching(/^projection_[a-f0-9]{16}$/), required_version: 1
    });

    stores.lifecycle.close();
  });
});
