import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CORE_EVENT_RETENTION_WINDOW_MS, RETENTION_WINDOW_MS } from "../src/domain/retention-barrier.js";
import { SqliteCapabilityGraph } from "../src/store/sqlite/capability-graph.js";
import { SqliteContext } from "../src/store/sqlite/context.js";
import { coreEventSemanticHash } from "../src/store/sqlite/core-event-identity.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";

const now = "2026-10-08T00:00:00.000Z";
const old = new Date(Date.parse(now) - RETENTION_WINDOW_MS - 1).toISOString();
let deliveryOrder = 0;

function insertDelivery(context: SqliteContext, id = "reply-1", payload = JSON.stringify({ body: "secret" }), state = "delivered"): number {
  const order = ++deliveryOrder;
  const scopeKey = JSON.stringify(["pane", "workspace-1", "pane-1"]);
  context.database.prepare(`INSERT INTO outbound_replies(
    id,idempotency_key,root_message_id,kind,payload,state,attempt_count,next_attempt_at,created_at,updated_at,delivery_order,lane_key,snapshot_revision,
    delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation,
    scope_kind,scope_key,scope_workspace_id,scope_pane_id
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, `key:${id}`, "root-1", "text", payload, state, 0, old, old, old, order, `reply:${id}`, 1,
    "primary", "binding-1", 2, 1, "pane", scopeKey, "workspace-1", "pane-1"
  );
  context.database.prepare(`INSERT INTO delivery_ring_checkpoints(
    scope_key,scope_kind,scope_workspace_id,scope_pane_id,committed_delivery_order,created_at,updated_at
  ) VALUES(?,'pane','workspace-1','pane-1',?,?,?)
  ON CONFLICT(scope_key) DO UPDATE SET committed_delivery_order=MAX(committed_delivery_order,excluded.committed_delivery_order),updated_at=excluded.updated_at`)
    .run(scopeKey, order, old, old);
  return order;
}

function insertCoreAuditFixture(context: Pick<SqliteContext, "database">, id: string, options: {
  terminal?: boolean;
  laneState?: "pending" | "projected" | "ignored" | "quarantined";
  timestamp?: string;
} = {}) {
  const timestamp = options.timestamp ?? new Date(Date.parse(now) - CORE_EVENT_RETENTION_WINDOW_MS - 1).toISOString();
  const laneId = `lane:${id}`;
  const turnId = `turn:${id}`;
  const humanId = `human:${id}`;
  const event = {
    schemaVersion: 1 as const,
    eventId: id,
    cursor: `cursor:${id}`,
    sourceId: "source-1",
    agentKind: "traex" as const,
    sessionId: "session-1",
    turnId,
    occurredAt: timestamp,
    payload: { type: "turn_completed" as const }
  };
  const human = {
    schemaVersion: 1 as const,
    eventId: humanId,
    cursor: `cursor:${humanId}`,
    sourceId: "source-1",
    agentKind: "traex" as const,
    sessionId: "session-1",
    turnId,
    occurredAt: timestamp,
    payload: {
      type: "human_message" as const,
      message_id: `message:${id}`,
      text: `request:${id}`,
      truncated: false,
      submission_id: `submission:${id}`
    }
  };
  context.database.prepare(`INSERT INTO core_event_inbox(
    event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type,submission_id
  ) VALUES(?,?,?,?,?,?,?,?,?,'human_message',?)`).run(
    human.eventId, human.sourceId, human.agentKind, human.sessionId, human.turnId, human.cursor,
    human.occurredAt, JSON.stringify(human), timestamp, human.payload.submission_id
  );
  context.database.prepare(`INSERT INTO core_event_inbox(
    event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type,submission_id
  ) VALUES(?,?,?,?,?,?,?,?,?,'turn_completed',NULL)`).run(
    event.eventId, event.sourceId, event.agentKind, event.sessionId, event.turnId, event.cursor,
    event.occurredAt, JSON.stringify(event), timestamp
  );
  if (options.terminal !== false) {
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,submission_id,human_event_id,agent_kind,session_id,
      request_text,state,view_version,root_message_id,created_at,updated_at
    ) VALUES(?,?,'primary','binding-1',1,?,?,?,'session-1',?,'completed',1,?,?,?)`).run(
      `segment:${id}`, `lane:${laneId}`, human.payload.submission_id, human.eventId, human.agentKind,
      human.payload.text, `root:${id}`, timestamp, timestamp
    );
  }
  context.database.prepare(`INSERT INTO core_event_lane_items(lane_id,event_id,sequence,state,created_at,updated_at)
    VALUES(?,?,1,?,?,?)`).run(laneId, event.eventId, options.laneState ?? "projected", timestamp, timestamp);
  context.database.prepare(`INSERT INTO core_event_lane_checkpoints(
    lane_id,source_id,source_epoch,agent_kind,session_id,read_cursor,latest_cursor,updated_at
  ) VALUES(?,'source-1','epoch-1','traex','session-1',?,?,?)`).run(laneId, event.cursor, event.cursor, timestamp);
  return { event, laneId, segmentId: `segment:${id}`, timestamp };
}

describe("SQLite retention audit skeletons", () => {
  it.each([
    ["retention_window_open", (context: SqliteContext) => insertCoreAuditFixture(context, "boundary", {
      timestamp: new Date(Date.parse(now) - CORE_EVENT_RETENTION_WINDOW_MS).toISOString()
    })],
    ["retention_window_open", (context: SqliteContext) => {
      const fixture = insertCoreAuditFixture(context, "recent-owner");
      context.database.prepare("UPDATE conversation_segments SET updated_at=? WHERE id=?")
        .run(new Date(Date.parse(now) - CORE_EVENT_RETENTION_WINDOW_MS).toISOString(), fixture.segmentId);
      return fixture;
    }],
    ["checkpoint_incomplete", (context: SqliteContext) => {
      const fixture = insertCoreAuditFixture(context, "pending-lane");
      context.database.prepare(`INSERT INTO core_event_lane_items(lane_id,event_id,sequence,state,created_at,updated_at)
        VALUES('lane:pending-neighbour','pending-lane',2,'pending',?,?)`).run(fixture.timestamp, fixture.timestamp);
      context.database.prepare(`INSERT INTO core_event_lane_checkpoints(
        lane_id,source_id,source_epoch,agent_kind,session_id,read_cursor,latest_cursor,updated_at
      ) VALUES('lane:pending-neighbour','source-1','epoch-1','traex','session-1','cursor:pending-lane','cursor:pending-lane',?)`)
        .run(fixture.timestamp);
      return fixture;
    }],
    ["quarantined", (context: SqliteContext) => insertCoreAuditFixture(context, "quarantined", { laneState: "quarantined" })],
    ["open_gap", (context: SqliteContext) => {
      const fixture = insertCoreAuditFixture(context, "open-gap");
      context.database.prepare(`INSERT INTO projection_gaps(
        stage,owner_kind,owner_id,source_item_id,failure_code,state,first_failed_at,last_failed_at
      ) VALUES('core_projection','prompt','prompt-1','open-gap','test','open',?,?)`).run(fixture.timestamp, fixture.timestamp);
      return fixture;
    }],
    ["open_gap", (context: SqliteContext) => {
      const fixture = insertCoreAuditFixture(context, "owner-open-gap");
      context.database.prepare(`INSERT INTO projection_gaps(
        stage,owner_kind,owner_id,source_item_id,failure_code,state,first_failed_at,last_failed_at
      ) VALUES('turn_recovery','binding','binding-1','turn-snapshot:owner-open-gap','test','open',?,?)`)
        .run(fixture.timestamp, fixture.timestamp);
      return fixture;
    }],
    ["unresolved_recovery", (context: SqliteContext) => {
      const fixture = insertCoreAuditFixture(context, "unresolved-recovery");
      insertDelivery(context, "recovery-reply");
      context.database.prepare(`INSERT INTO conversation_segment_page_recoveries(
        segment_id,source_page_index,start_cursor_json,end_cursor_json,reply_id,state,created_at,updated_at
      ) VALUES(?,1,'{}','{}','recovery-reply','pending',?,?)`).run(
        fixture.segmentId, fixture.timestamp, fixture.timestamp
      );
      return fixture;
    }],
    ["not_terminal", (context: SqliteContext) => insertCoreAuditFixture(context, "nonterminal", { terminal: false })]
  ] as const)("refuses Core audit evidence with %s", (reason, arrange) => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    const fixture = arrange(context);

    expect(graph.retentionAudit.prepare({
      kind: "core_event", id: fixture.event.eventId, retentionWindowMs: CORE_EVENT_RETENTION_WINDOW_MS
    }, now)).toEqual({ status: "refused", reason });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM audit_skeletons WHERE source_kind='core_event'").get())
      .toEqual({ count: 0 });
    context.close();
  });

  it("retains Core payload evidence while exact-turn recovery is unresolved", () => {
    const stores = createTestStoreBundle(":memory:");
    stores.bindingProvisioning.createPendingBinding({
      id: "binding-1", projectId: "project", workspaceId: "w1", chatId: "chat-1",
      topicId: "topic-1", rootMessageId: "root-1", title: "Primary"
    });
    stores.driver.updateBinding("binding-1", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id",
      agentSessionValue: "session-1"
    });
    const fixture = insertCoreAuditFixture(stores.driver, "external-recovery");
    const externalView = createQueuedRunCard({
      promptId: "prompt-external-recovery", bindingId: "binding-1", title: "Recovery",
      workspaceId: "w1", spaceName: "project", paneId: "w1:p1", requestText: "recover",
      queuePosition: 0, occurredAt: fixture.timestamp
    });
    const adopted = stores.driver.adoptExternalTurn({
      bindingId: "binding-1", expectedGeneration: 1, expectedPaneId: "w1:p1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: fixture.event.turnId!, startedAt: fixture.timestamp, requestText: "recover",
      externalPromptId: "prompt-external-recovery", externalMessageId: "human:external-recovery",
      externalView, answerCardFor: () => ({})
    });
    if (!adopted.prompt) throw new Error("expected external prompt adoption");
    expect(stores.driver.deferExternalTurnRecovery({
      promptId: adopted.prompt.id, bindingId: "binding-1", expectedGeneration: 1, expectedPaneId: "w1:p1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: fixture.event.turnId!, startedAt: fixture.timestamp, failureCode: "recovery_not_found", occurredAt: now
    })).not.toBeNull();

    expect(stores.retention.prepare({
      kind: "core_event", id: fixture.event.eventId, retentionWindowMs: CORE_EVENT_RETENTION_WINDOW_MS
    }, now)).toEqual({ status: "refused", reason: "unresolved_recovery" });
    stores.lifecycle.close();
  });

  it("rejects changed Core semantics without replacing verified skeleton evidence", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    const fixture = insertCoreAuditFixture(context, "semantic-conflict");
    const first = graph.retentionAudit.prepare({
      kind: "core_event", id: fixture.event.eventId, retentionWindowMs: CORE_EVENT_RETENTION_WINDOW_MS
    }, now);
    expect(first.status).toBe("recorded");
    const changed = { ...fixture.event, occurredAt: new Date(Date.parse(fixture.event.occurredAt) - 1).toISOString() };
    context.database.prepare("UPDATE core_event_inbox SET event_json=? WHERE event_id=?")
      .run(JSON.stringify(changed), fixture.event.eventId);

    expect(() => graph.retentionAudit.prepare({
      kind: "core_event", id: fixture.event.eventId, retentionWindowMs: CORE_EVENT_RETENTION_WINDOW_MS
    }, now)).toThrow("audit_skeleton_conflict");
    expect(graph.retentionAudit.load({ kind: "core_event", id: fixture.event.eventId })?.payloadHash)
      .toBe(coreEventSemanticHash(fixture.event));
    context.close();
  });

  it("derives current source facts and round trips one accepted payload-free skeleton", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    const order = insertDelivery(context);
    const result = graph.retentionAudit.prepare({ kind: "delivery", id: "reply-1" }, now);
    expect(result).toMatchObject({ status: "recorded", skeleton: {
      identity: { kind: "delivery", id: "reply-1" }, payloadHash: createHash("sha256").update(JSON.stringify({ body: "secret" })).digest("hex"),
      payloadBytes: Buffer.byteLength(JSON.stringify({ body: "secret" })), lifecycleState: "delivered",
      owner: {
        kind: "primary", id: "binding-1", generation: 2, sessionGeneration: 1, parent: null,
        scopeKey: JSON.stringify(["pane", "workspace-1", "pane-1"])
      }, state: "verified", links: [{
        kind: "checkpoint", id: JSON.stringify(["pane", "workspace-1", "pane-1"]), state: `committed-through:${order}`
      }]
    } });
    const loaded = graph.retentionAudit.load({ kind: "delivery", id: "reply-1" });
    expect(loaded).toEqual(result.status === "recorded" ? result.skeleton : null);
    expect(JSON.stringify(loaded)).not.toContain("secret");
    context.close();
  });

  it("refuses missing, non-terminal, uncertain, quarantined, and stale-owner candidates without mutation", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    expect(graph.retentionAudit.prepare({ kind: "delivery", id: "missing" }, now)).toEqual({ status: "missing" });
    insertDelivery(context, "reply-1", "payload", "pending");
    expect(graph.retentionAudit.prepare({ kind: "delivery", id: "reply-1" }, now)).toEqual({ status: "refused", reason: "not_terminal" });
    context.database.prepare("UPDATE outbound_replies SET state='delivered',effect_certainty='uncertain' WHERE id='reply-1'").run();
    expect(graph.retentionAudit.prepare({ kind: "delivery", id: "reply-1" }, now)).toEqual({ status: "refused", reason: "uncertain_effect" });
    context.database.prepare("UPDATE outbound_replies SET effect_certainty=NULL WHERE id='reply-1'").run();
    context.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at)
      VALUES('reply:reply-1','reply-1','immutable','unknown','active','blocked','test',?,?)`).run(old, old);
    expect(graph.retentionAudit.prepare({ kind: "delivery", id: "reply-1" }, now)).toEqual({ status: "refused", reason: "quarantined" });
    context.database.prepare("UPDATE outbox_lane_quarantines SET state='released',released_at=?,updated_at=? WHERE failed_reply_id='reply-1'").run(old, old);
    expect(graph.retentionAudit.prepare({
      kind: "delivery", id: "reply-1",
      expectedOwnerFence: { kind: "primary", id: "binding-1", generation: 3, sessionGeneration: 1 }
    }, now)).toEqual({ status: "stale_owner" });
    expect(graph.retentionAudit.prepare({
      kind: "delivery", id: "reply-1",
      expectedOwnerFence: { kind: "primary", id: "binding-1", generation: 2, sessionGeneration: 2 }
    }, now)).toEqual({ status: "stale_owner" });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM audit_skeletons").get()).toEqual({ count: 0 });
    context.close();
  });

  it("is idempotent for unchanged source evidence and rejects a changed payload identity", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    insertDelivery(context);
    const first = graph.retentionAudit.prepare({ kind: "delivery", id: "reply-1" }, now);
    expect(first.status).toBe("recorded");
    context.database.prepare("UPDATE delivery_ring_checkpoints SET committed_delivery_order=committed_delivery_order+10").run();
    expect(graph.retentionAudit.prepare({ kind: "delivery", id: "reply-1" }, now).status).toBe("existing");
    context.database.prepare("UPDATE outbound_replies SET payload='changed' WHERE id='reply-1'").run();
    expect(() => graph.retentionAudit.prepare({ kind: "delivery", id: "reply-1" }, now)).toThrow("audit_skeleton_conflict");
    expect(graph.retentionAudit.load({ kind: "delivery", id: "reply-1" })?.payloadHash)
      .toBe(first.status === "recorded" ? first.skeleton.payloadHash : "");
    context.close();
  });

  it("derives checkpoint, gap, recovery, prerequisite, replacement, reference, and reconstruction refusals from current rows", () => {
    const refusal = (mutate: (context: SqliteContext) => void) => {
      const context = new SqliteContext(":memory:");
      const graph = new SqliteCapabilityGraph(context);
      insertDelivery(context);
      mutate(context);
      const result = graph.retentionAudit.prepare({ kind: "delivery", id: "reply-1" }, now);
      context.close();
      return result;
    };
    expect(refusal((context) => context.database.prepare("UPDATE outbound_replies SET claim_attempt_id='claim-1' WHERE id='reply-1'").run()))
      .toEqual({ status: "refused", reason: "checkpoint_incomplete" });
    expect(refusal((context) => context.database.prepare("DELETE FROM delivery_ring_checkpoints").run()))
      .toEqual({ status: "refused", reason: "checkpoint_incomplete" });
    expect(refusal((context) => context.database.prepare("UPDATE delivery_ring_checkpoints SET committed_delivery_order=0").run()))
      .toEqual({ status: "refused", reason: "checkpoint_incomplete" });
    expect(refusal((context) => context.database.prepare("UPDATE delivery_ring_checkpoints SET scope_pane_id='different-pane'").run()))
      .toEqual({ status: "refused", reason: "checkpoint_incomplete" });
    expect(refusal((context) => context.database.prepare(`INSERT INTO projection_gaps(
      stage,owner_kind,owner_id,source_item_id,failure_code,state,first_failed_at,last_failed_at
    ) VALUES('answer_delivery','prompt','prompt-1','reply-1','test','open',?,?)`).run(old, old)))
      .toEqual({ status: "refused", reason: "open_gap" });
    expect(refusal((context) => context.database.prepare(`INSERT INTO delivery_recoveries(
      failed_reply_id,snapshot_revision,state,failure_class,reason,action,created_at,updated_at
    ) VALUES('reply-1',1,'unresolved','unknown','test','blocked',?,?)`).run(old, old)))
      .toEqual({ status: "refused", reason: "unresolved_recovery" });
    expect(refusal((context) => {
      insertDelivery(context, "prerequisite", "payload", "pending");
      context.database.prepare(`INSERT INTO outbound_reply_prerequisites(dependent_reply_id,prerequisite_reply_id,required_state,created_at)
        VALUES('reply-1','prerequisite','delivered',?)`).run(old);
    })).toEqual({ status: "refused", reason: "pending_prerequisite" });
    expect(refusal((context) => {
      insertDelivery(context, "dependent");
      context.database.prepare(`INSERT INTO outbound_reply_prerequisites(dependent_reply_id,prerequisite_reply_id,required_state,created_at)
        VALUES('dependent','reply-1','delivered',?)`).run(old);
    })).toEqual({ status: "refused", reason: "referenced" });
    expect(refusal((context) => context.database.prepare(`INSERT INTO delivery_recoveries(
      failed_reply_id,snapshot_revision,state,failure_class,reason,action,created_at,updated_at
    ) VALUES('reply-1',1,'replacement_pending','unknown','test','rebuild',?,?)`).run(old, old)))
      .toEqual({ status: "refused", reason: "replacement_incomplete" });
    expect(refusal((context) => {
      insertDelivery(context, "failed");
      context.database.prepare(`INSERT INTO delivery_recoveries(
        failed_reply_id,snapshot_revision,state,failure_class,reason,action,replacement_reply_id,created_at,updated_at
      ) VALUES('failed',1,'replacement_pending','unknown','test','rebuild','reply-1',?,?)`).run(old, old);
    })).toEqual({ status: "refused", reason: "replacement_incomplete" });
    expect(refusal((context) => {
      context.database.prepare(`INSERT INTO conversation_segments(
        id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at
      ) VALUES('segment-1','producer-1','primary','binding-1',1,'traex','request','completed',1,'root-1',?,?)`).run(old, old);
      context.database.prepare(`INSERT INTO conversation_segment_page_recoveries(
        segment_id,source_page_index,start_cursor_json,end_cursor_json,reply_id,state,created_at,updated_at
      ) VALUES('segment-1',1,'{}','{}','reply-1','delivered',?,?)`).run(old, old);
    })).toEqual({ status: "refused", reason: "referenced" });
    expect(refusal((context) => context.database.prepare("UPDATE outbound_replies SET projection_key='projection:1' WHERE id='reply-1'").run()))
      .toEqual({ status: "refused", reason: "projection_not_reconstructible" });
  });

  it("rolls back the skeleton when a permanent relationship write fails", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    insertDelivery(context);
    insertDelivery(context, "dependent");
    context.database.prepare(`INSERT INTO outbound_reply_prerequisites(dependent_reply_id,prerequisite_reply_id,required_state,created_at)
      VALUES('reply-1','dependent','delivered',?)`).run(old);
    context.database.exec(`CREATE TRIGGER fail_audit_link BEFORE INSERT ON audit_skeleton_links BEGIN SELECT RAISE(ABORT, 'injected_link_failure'); END`);
    expect(() => graph.retentionAudit.prepare({ kind: "delivery", id: "reply-1" }, now)).toThrow("injected_link_failure");
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM audit_skeletons").get()).toEqual({ count: 0 });
    context.close();
  });

  it("permanently records prerequisite, projection, replacement, and resolver topology", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    for (const id of ["failed", "replacement", "resolver", "dependent", "prerequisite", "old-projection", "new-projection"]) insertDelivery(context, id);
    context.database.prepare(`INSERT INTO delivery_recoveries(
      failed_reply_id,snapshot_revision,state,failure_class,reason,action,replacement_reply_id,resolved_by_reply_id,created_at,updated_at,resolved_at
    ) VALUES('failed',1,'recovered','unknown','test','rebuilt','replacement','resolver',?,?,?)`).run(old, old, old);
    context.database.prepare(`INSERT INTO outbound_reply_prerequisites(dependent_reply_id,prerequisite_reply_id,required_state,created_at)
      VALUES('dependent','prerequisite','delivered',?)`).run(old);
    context.database.prepare("UPDATE outbound_replies SET projection_key='projection:answer',snapshot_revision=1 WHERE id='old-projection'").run();
    context.database.prepare("UPDATE outbound_replies SET projection_key='projection:answer',snapshot_revision=2 WHERE id='new-projection'").run();

    const prepared = (id: string) => {
      const result = graph.retentionAudit.prepare({ kind: "delivery", id }, now);
      expect(result.status).toBe("recorded");
      return result.status === "recorded" ? result.skeleton.links : [];
    };
    expect(prepared("failed")).toEqual(expect.arrayContaining([
      { kind: "replacement", id: "replacement", state: "replacement:recovered" },
      { kind: "recovery", id: "resolver", state: "resolver:recovered" }
    ]));
    expect(prepared("replacement")).toEqual(expect.arrayContaining([
      { kind: "recovery", id: "failed", state: "replaces:recovered" },
      { kind: "recovery", id: "resolver", state: "resolver:recovered" }
    ]));
    expect(prepared("resolver")).toEqual(expect.arrayContaining([
      { kind: "recovery", id: "failed", state: "resolved:recovered" },
      { kind: "replacement", id: "replacement", state: "replacement:recovered" }
    ]));
    expect(prepared("dependent")).toContainEqual({ kind: "prerequisite", id: "prerequisite", state: "depends_on:delivered" });
    expect(graph.retentionAudit.prepare({ kind: "delivery", id: "prerequisite" }, now))
      .toEqual({ status: "refused", reason: "referenced" });
    expect(prepared("old-projection")).toEqual(expect.arrayContaining([
      { kind: "projection", id: "projection:answer", state: "snapshot:1" },
      { kind: "replacement", id: "new-projection", state: "reconstructs:2:delivered" }
    ]));
    context.close();
  });

  it("CAS-fences Primary session and complete Worker owner/parent identity", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    insertDelivery(context, "primary");
    const primaryFence = { kind: "primary" as const, id: "binding-1", generation: 2, sessionGeneration: 1 };
    context.database.prepare("UPDATE outbound_replies SET delivery_owner_session_generation=2 WHERE id='primary'").run();
    expect(graph.retentionAudit.prepare({ kind: "delivery", id: "primary", expectedOwnerFence: primaryFence }, now)).toEqual({ status: "stale_owner" });

    insertDelivery(context, "worker");
    context.database.prepare(`UPDATE outbound_replies SET
      delivery_owner_kind='worker',delivery_owner_id='worker-1',delivery_owner_generation=4,delivery_owner_session_generation=5,
      delivery_parent_id='binding-1',delivery_parent_generation=2,delivery_parent_session_generation=3,delivery_parent_pane_id='pane-1'
      WHERE id='worker'`).run();
    const workerFence = {
      kind: "worker" as const, id: "worker-1", generation: 4, sessionGeneration: 5,
      parent: { id: "binding-1", generation: 2, sessionGeneration: 3 }
    };
    const recorded = graph.retentionAudit.prepare({ kind: "delivery", id: "worker", expectedOwnerFence: workerFence }, now);
    expect(recorded).toMatchObject({ status: "recorded", skeleton: { owner: {
      kind: "worker", id: "worker-1", generation: 4, sessionGeneration: 5,
      parent: { id: "binding-1", generation: 2, sessionGeneration: 3 }
    } } });
    insertDelivery(context, "stale-worker");
    context.database.prepare(`UPDATE outbound_replies SET
      delivery_owner_kind='worker',delivery_owner_id='worker-1',delivery_owner_generation=4,delivery_owner_session_generation=6,
      delivery_parent_id='binding-1',delivery_parent_generation=2,delivery_parent_session_generation=3,delivery_parent_pane_id='pane-1'
      WHERE id='stale-worker'`).run();
    expect(graph.retentionAudit.prepare({ kind: "delivery", id: "stale-worker", expectedOwnerFence: workerFence }, now)).toEqual({ status: "stale_owner" });
    context.close();
  });

  it("rejects skeleton writes after lease ownership is lost", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    insertDelivery(context);
    const lease = graph.leases.acquireInstanceLease("owner", now, "2099-10-08T00:00:00.000Z")!;
    graph.leases.activateWriteFence(lease.ownerId, lease.fencingToken);
    graph.leases.releaseInstanceLease(lease.ownerId, lease.fencingToken);
    expect(() => graph.retentionAudit.prepare({ kind: "delivery", id: "reply-1" }, now)).toThrow("stale_instance_lease");
    context.close();
  });

  it("makes identity, hash, and recovery relationships permanent while allowing only forward compaction", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    insertDelivery(context);
    insertDelivery(context, "dependent");
    context.database.prepare(`INSERT INTO outbound_reply_prerequisites(dependent_reply_id,prerequisite_reply_id,required_state,created_at)
      VALUES('reply-1','dependent','delivered',?)`).run(old);
    expect(graph.retentionAudit.prepare({ kind: "delivery", id: "reply-1" }, now).status).toBe("recorded");
    expect(() => context.database.prepare("DELETE FROM audit_skeletons WHERE source_kind='delivery' AND source_id='reply-1'").run()).toThrow("permanent_audit_skeleton");
    expect(() => context.database.prepare("UPDATE audit_skeletons SET payload_hash=? WHERE source_kind='delivery' AND source_id='reply-1'").run("b".repeat(64))).toThrow("immutable_audit_skeleton");
    expect(() => context.database.prepare("DELETE FROM audit_skeleton_links WHERE source_kind='delivery' AND source_id='reply-1'").run()).toThrow("permanent_audit_skeleton_link");
    expect(context.database.prepare("UPDATE audit_skeletons SET state='compacted',compacted_at=? WHERE source_kind='delivery' AND source_id='reply-1'").run(now).changes).toBe(1);
    expect(() => context.database.prepare("UPDATE audit_skeletons SET state='verified',compacted_at=NULL WHERE source_kind='delivery' AND source_id='reply-1'").run()).toThrow("invalid_audit_skeleton_transition");
    context.close();
  });

  it("reopens with the same payload-free identity, hash, ownership, and recovery links", () => {
    const directory = mkdtempSync(join(tmpdir(), "retention-audit-"));
    const path = join(directory, "bridge.sqlite");
    try {
      const firstContext = new SqliteContext(path);
      const first = new SqliteCapabilityGraph(firstContext);
      insertDelivery(firstContext);
      insertDelivery(firstContext, "dependent");
      firstContext.database.prepare(`INSERT INTO outbound_reply_prerequisites(dependent_reply_id,prerequisite_reply_id,required_state,created_at)
        VALUES('reply-1','dependent','delivered',?)`).run(old);
      const recorded = first.retentionAudit.prepare({ kind: "delivery", id: "reply-1" }, now);
      expect(recorded.status).toBe("recorded");
      firstContext.close();

      const secondContext = new SqliteContext(path);
      const second = new SqliteCapabilityGraph(secondContext);
      expect(second.retentionAudit.load({ kind: "delivery", id: "reply-1" }))
        .toEqual(recorded.status === "recorded" ? recorded.skeleton : null);
      expect(second.retentionAudit.prepare({ kind: "delivery", id: "reply-1" }, now).status).toBe("existing");
      secondContext.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });
});
