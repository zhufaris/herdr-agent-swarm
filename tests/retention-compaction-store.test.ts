import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { CORE_EVENT_RETENTION_WINDOW_MS, RETENTION_WINDOW_MS } from "../src/domain/retention-barrier.js";
import { SqliteCapabilityGraph } from "../src/store/sqlite/capability-graph.js";
import { SqliteContext } from "../src/store/sqlite/context.js";
import { SqliteAnswerTimelineStore } from "../src/store/sqlite/answer-timeline-store.js";
import { SqliteOutboxRetentionStore } from "../src/store/sqlite/outbox-retention-store.js";
import { removeDependentDeliveryPrerequisites } from "../src/store/sqlite/delivery-prerequisites.js";
import { coreEventSemanticHash } from "../src/store/sqlite/core-event-identity.js";
import { SqliteCoreEventInboxStore } from "../src/store/sqlite/core-event-inbox-store.js";

const now = "2026-10-08T00:00:00.000Z";
const old = new Date(Date.parse(now) - RETENTION_WINDOW_MS - 1).toISOString();
let deliveryOrder = 0;

function insertDelivery(context: SqliteContext, id: string, state = "delivered", payload = JSON.stringify({ body: `secret:${id}` })): void {
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
}

function insertRecoverableSemanticFailure(context: SqliteContext, id: string): string {
  const order = ++deliveryOrder;
  const scopeKey = JSON.stringify(["pane", "workspace-1", "pane-1"]);
  const snapshot = JSON.stringify({ schemaVersion: 1, kind: "conversation-turn-card", timeline: [{ text: `secret:${id}` }] });
  context.database.prepare(`INSERT INTO outbound_replies(
    id,delivery_input_kind,subject_kind,subject_json,subject_revision,presentation_snapshot_json,presentation_snapshot_hash,
    planner_policy_version,renderer_policy_version,gateway_profile_version,preparation_state,
    idempotency_key,root_message_id,kind,payload,state,effect_certainty,failure_class,error,attempt_count,next_attempt_at,created_at,updated_at,
    delivery_order,lane_key,snapshot_revision,delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation,
    scope_kind,scope_key,scope_workspace_id,scope_pane_id
  ) VALUES(?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?)`).run(
    id, "semantic-snapshot", "conversation-page", JSON.stringify({ kind: "conversation-page", segmentId: "segment", pageIndex: 0, revision: 1 }), 1,
    snapshot, createHash("sha256").update(snapshot).digest("hex"), 1, 1, 1, "reserved",
    `key:${id}`, "root-1", "card_reply", "{}", "dead_letter", "not-started", "permanent", "preparation failed", 1, old, old, old,
    order, `reply:${id}`, 1, "primary", "binding-1", 2, 1, "pane", scopeKey, "workspace-1", "pane-1"
  );
  context.database.prepare(`INSERT INTO delivery_ring_checkpoints(
    scope_key,scope_kind,scope_workspace_id,scope_pane_id,committed_delivery_order,created_at,updated_at
  ) VALUES(?,'pane','workspace-1','pane-1',?,?,?)
  ON CONFLICT(scope_key) DO UPDATE SET committed_delivery_order=MAX(committed_delivery_order,excluded.committed_delivery_order),updated_at=excluded.updated_at`)
    .run(scopeKey, order, old, old);
  return snapshot;
}

describe("SQLite retention payload compaction", () => {
  it("audits 24-hour Core eligibility and records semantic skeletons without clearing payloads", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    const coreOld = new Date(Date.parse(now) - CORE_EVENT_RETENTION_WINDOW_MS - 1).toISOString();
    const terminal = {
      schemaVersion: 1 as const, eventId: "audit-terminal", cursor: "cursor:2", sourceId: "source-1", agentKind: "traex" as const,
      sessionId: "session-1", turnId: "turn-1", occurredAt: coreOld, payload: { type: "turn_completed" }
    };
    const human = {
      schemaVersion: 1 as const, eventId: "audit-human", cursor: "cursor:1", sourceId: "source-1", agentKind: "traex" as const,
      sessionId: "session-1", turnId: "turn-1", occurredAt: coreOld,
      payload: { type: "human_message", message_id: "message-1", text: "hello", truncated: false, submission_id: "submission-1" }
    };
    const diagnostic = {
      schemaVersion: 1 as const, eventId: "audit-diagnostic", cursor: "cursor:3", sourceId: "source-1", agentKind: "traex" as const,
      sessionId: "session-1", turnId: null, occurredAt: coreOld,
      payload: { type: "source_error", code: "runtime_identity_changed" }
    };
    const terminalJson = JSON.stringify(terminal);
    const humanJson = JSON.stringify(human);
    const diagnosticJson = JSON.stringify(diagnostic);
    context.database.prepare(`INSERT INTO core_event_inbox(
      event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type,submission_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      human.eventId, human.sourceId, human.agentKind, human.sessionId, human.turnId, human.cursor,
      human.occurredAt, humanJson, coreOld, "human_message", "submission-1"
    );
    context.database.prepare(`INSERT INTO core_event_inbox(
      event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type,submission_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`).run(
      terminal.eventId, terminal.sourceId, terminal.agentKind, terminal.sessionId, terminal.turnId, terminal.cursor,
      terminal.occurredAt, terminalJson, coreOld, "turn_completed"
    );
    context.database.prepare(`INSERT INTO core_event_inbox(
      event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type,submission_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`).run(
      diagnostic.eventId, diagnostic.sourceId, diagnostic.agentKind, diagnostic.sessionId, diagnostic.turnId, diagnostic.cursor,
      diagnostic.occurredAt, diagnosticJson, coreOld, "source_error"
    );
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,submission_id,human_event_id,agent_kind,session_id,
      request_text,state,view_version,root_message_id,created_at,updated_at
    ) VALUES('audit-segment','lane:audit-lane','primary','binding-1',1,'submission-1','audit-human','traex','session-1',
      'hello','completed',1,'root-1',?,?)`).run(coreOld, coreOld);
    context.database.prepare(`INSERT INTO core_event_lane_items(lane_id,event_id,sequence,state,created_at,updated_at)
      VALUES('audit-lane','audit-human',1,'projected',?,?),('audit-lane','audit-terminal',2,'projected',?,?),
        ('audit-lane','audit-diagnostic',3,'ignored',?,?)`)
      .run(coreOld, coreOld, coreOld, coreOld, coreOld, coreOld);
    context.database.prepare(`INSERT INTO core_event_lane_checkpoints(
      lane_id,source_id,source_epoch,agent_kind,session_id,read_cursor,latest_cursor,updated_at
    ) VALUES('audit-lane','source-1','epoch-1','traex','session-1','cursor:3','cursor:3',?)`).run(coreOld);

    const result = graph.retentionCompaction.auditPage({
      kind: "core_event", evaluatedAt: now, retentionWindowMs: CORE_EVENT_RETENTION_WINDOW_MS, limit: 10
    });

    expect(result).toMatchObject({
      source: "core_event", scanned: 3, eligible: 2, alreadyVerified: 0,
      eligibleBytes: Buffer.byteLength(terminalJson) + Buffer.byteLength(diagnosticJson),
      refusals: { human_input_retained: 1 }, cycleComplete: true
    });
    expect(context.database.prepare("SELECT event_id,event_json,payload_compacted_at FROM core_event_inbox ORDER BY event_id").all())
      .toEqual([
        { event_id: "audit-diagnostic", event_json: diagnosticJson, payload_compacted_at: null },
        { event_id: "audit-human", event_json: humanJson, payload_compacted_at: null },
        { event_id: "audit-terminal", event_json: terminalJson, payload_compacted_at: null }
      ]);
    expect(graph.retentionAudit.load({ kind: "core_event", id: terminal.eventId })).toMatchObject({
      payloadHash: coreEventSemanticHash(terminal), payloadBytes: Buffer.byteLength(terminalJson), state: "verified"
    });
    expect(graph.retentionAudit.load({ kind: "core_event", id: diagnostic.eventId })).toMatchObject({
      payloadHash: coreEventSemanticHash(diagnostic), lifecycleState: "ignored-diagnostic", state: "verified"
    });
    expect(graph.operations.getOperationalSummary().retentionCompaction.coreEvent).toEqual({
      cursorMode: "audit", verified: 2, compacted: 0,
      retainedBytes: Buffer.byteLength(terminalJson) + Buffer.byteLength(diagnosticJson)
    });
    context.close();
  });

  it("keeps token-usage events on the unchanged generic Core compaction path", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    const coreOld = new Date(Date.parse(now) - CORE_EVENT_RETENTION_WINDOW_MS - 1).toISOString();
    const token = {
      schemaVersion: 1 as const,
      eventId: "audit-token",
      cursor: "cursor:token",
      sourceId: "source-1",
      agentKind: "traex" as const,
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: coreOld,
      payload: {
        type: "token_usage",
        response_id: "response-1",
        response: {
          input_tokens: 80,
          cached_input_tokens: 10,
          cache_creation_input_tokens: 0,
          output_tokens: 20,
          reasoning_output_tokens: 5,
          total_tokens: 105
        },
        thread: {
          input_tokens: 800,
          cached_input_tokens: 100,
          cache_creation_input_tokens: 0,
          output_tokens: 200,
          reasoning_output_tokens: 50,
          total_tokens: 1_050
        },
        auto_compact_limit: 3_000
      }
    };
    const human = {
      schemaVersion: 1 as const,
      eventId: "audit-human",
      cursor: "cursor:human",
      sourceId: "source-1",
      agentKind: "traex" as const,
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: coreOld,
      payload: { type: "human_message", message_id: "message-1", text: "hello", truncated: false, submission_id: "submission-1" }
    };
    const tokenJson = JSON.stringify(token);
    const humanJson = JSON.stringify(human);
    context.database.prepare(`INSERT INTO core_event_inbox(
      event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type,submission_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`).run(
      token.eventId, token.sourceId, token.agentKind, token.sessionId, token.turnId, token.cursor,
      token.occurredAt, tokenJson, coreOld, "token_usage"
    );
    context.database.prepare(`INSERT INTO core_event_inbox(
      event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type,submission_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      human.eventId, human.sourceId, human.agentKind, human.sessionId, human.turnId, human.cursor,
      human.occurredAt, humanJson, coreOld, "human_message", "submission-1"
    );
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,submission_id,human_event_id,agent_kind,session_id,
      request_text,state,view_version,root_message_id,created_at,updated_at
    ) VALUES('token-segment','lane:audit-lane','primary','binding-1',1,'submission-1','audit-human','traex','session-1',
      'hello','completed',1,'root-1',?,?)`).run(coreOld, coreOld);
    context.database.prepare(`INSERT INTO core_event_lane_items(lane_id,event_id,sequence,state,created_at,updated_at)
      VALUES('audit-lane',?,1,'projected',?,?),('audit-lane',?,2,'projected',?,?)`)
      .run(token.eventId, coreOld, coreOld, human.eventId, coreOld, coreOld);
    context.database.prepare(`INSERT INTO core_event_lane_checkpoints(
      lane_id,source_id,source_epoch,agent_kind,session_id,read_cursor,latest_cursor,updated_at
    ) VALUES('audit-lane','source-1','epoch-1','traex','session-1','cursor:human','cursor:human',?)`).run(coreOld);

    const audit = graph.retentionCompaction.auditPage({
      kind: "core_event",
      evaluatedAt: now,
      retentionWindowMs: CORE_EVENT_RETENTION_WINDOW_MS,
      limit: 10
    });

    expect(audit).toMatchObject({
      source: "core_event",
      scanned: 2,
      eligible: 1,
      alreadyVerified: 0,
      eligibleBytes: Buffer.byteLength(tokenJson),
      refusals: { human_input_retained: 1 }
    });

    const compact = graph.retentionCompaction.compactPage({
      kind: "core_event",
      evaluatedAt: now,
      retentionWindowMs: CORE_EVENT_RETENTION_WINDOW_MS,
      limit: 10
    });

    expect(compact).toMatchObject({
      source: "core_event",
      scanned: 2,
      compacted: 1,
      alreadyCompacted: 0,
      refusals: { human_input_retained: 1 }
    });
    expect(context.database.prepare("SELECT event_json,payload_compacted_at FROM core_event_inbox WHERE event_id='audit-token'").get())
      .toEqual({ event_json: "null", payload_compacted_at: now });
    expect(context.database.prepare("SELECT event_json,payload_compacted_at FROM core_event_inbox WHERE event_id='audit-human'").get())
      .toEqual({ event_json: humanJson, payload_compacted_at: null });

    context.close();
  });

  it("keeps context-snapshot events on the unchanged generic Core compaction path", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    const coreOld = new Date(Date.parse(now) - CORE_EVENT_RETENTION_WINDOW_MS - 1).toISOString();
    const snapshot = {
      schemaVersion: 1 as const,
      eventId: "audit-context",
      cursor: "cursor:context",
      sourceId: "source-1",
      agentKind: "traex" as const,
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: coreOld,
      payload: {
        type: "context_snapshot",
        model: "GPT-5.6-Sol",
        provider: "trae",
        permission_mode: "managed",
        current_date: "2026-10-22",
        timezone: "Etc/UTC",
        auto_compact_limit: 3_000
      }
    };
    const human = {
      schemaVersion: 1 as const,
      eventId: "audit-human-context",
      cursor: "cursor:human-context",
      sourceId: "source-1",
      agentKind: "traex" as const,
      sessionId: "session-1",
      turnId: "turn-1",
      occurredAt: coreOld,
      payload: { type: "human_message", message_id: "message-1", text: "hello", truncated: false, submission_id: "submission-1" }
    };
    const snapshotJson = JSON.stringify(snapshot);
    const humanJson = JSON.stringify(human);
    context.database.prepare(`INSERT INTO core_event_inbox(
      event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type,submission_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,NULL)`).run(
      snapshot.eventId, snapshot.sourceId, snapshot.agentKind, snapshot.sessionId, snapshot.turnId, snapshot.cursor,
      snapshot.occurredAt, snapshotJson, coreOld, "context_snapshot"
    );
    context.database.prepare(`INSERT INTO core_event_inbox(
      event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type,submission_id
    ) VALUES(?,?,?,?,?,?,?,?,?,?,?)`).run(
      human.eventId, human.sourceId, human.agentKind, human.sessionId, human.turnId, human.cursor,
      human.occurredAt, humanJson, coreOld, "human_message", "submission-1"
    );
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,submission_id,human_event_id,agent_kind,session_id,
      request_text,state,view_version,root_message_id,created_at,updated_at
    ) VALUES('context-segment','lane:audit-context-lane','primary','binding-1',1,'submission-1','audit-human-context','traex','session-1',
      'hello','completed',1,'root-1',?,?)`).run(coreOld, coreOld);
    context.database.prepare(`INSERT INTO core_event_lane_items(lane_id,event_id,sequence,state,created_at,updated_at)
      VALUES('audit-context-lane',?,1,'projected',?,?),('audit-context-lane',?,2,'projected',?,?)`)
      .run(snapshot.eventId, coreOld, coreOld, human.eventId, coreOld, coreOld);
    context.database.prepare(`INSERT INTO core_event_lane_checkpoints(
      lane_id,source_id,source_epoch,agent_kind,session_id,read_cursor,latest_cursor,updated_at
    ) VALUES('audit-context-lane','source-1','epoch-1','traex','session-1','cursor:human-context','cursor:human-context',?)`).run(coreOld);

    const audit = graph.retentionCompaction.auditPage({
      kind: "core_event",
      evaluatedAt: now,
      retentionWindowMs: CORE_EVENT_RETENTION_WINDOW_MS,
      limit: 10
    });

    expect(audit).toMatchObject({
      source: "core_event",
      scanned: 2,
      eligible: 1,
      alreadyVerified: 0,
      eligibleBytes: Buffer.byteLength(snapshotJson),
      refusals: { human_input_retained: 1 }
    });

    const compact = graph.retentionCompaction.compactPage({
      kind: "core_event",
      evaluatedAt: now,
      retentionWindowMs: CORE_EVENT_RETENTION_WINDOW_MS,
      limit: 10
    });

    expect(compact).toMatchObject({
      source: "core_event",
      scanned: 2,
      compacted: 1,
      alreadyCompacted: 0,
      refusals: { human_input_retained: 1 }
    });
    expect(context.database.prepare("SELECT event_json,payload_compacted_at FROM core_event_inbox WHERE event_id='audit-context'").get())
      .toEqual({ event_json: "null", payload_compacted_at: now });
    expect(context.database.prepare("SELECT event_json,payload_compacted_at FROM core_event_inbox WHERE event_id='audit-human-context'").get())
      .toEqual({ event_json: humanJson, payload_compacted_at: null });

    context.close();
  });

  it("resumes the bounded Core audit cursor after SQLite restart without clearing payloads", () => {
    const directory = mkdtempSync(join(tmpdir(), "swarm-core-audit-restart-"));
    const databasePath = join(directory, "bridge.db");
    const coreOld = new Date(Date.parse(now) - CORE_EVENT_RETENTION_WINDOW_MS - 1).toISOString();
    try {
      const firstContext = new SqliteContext(databasePath);
      const firstGraph = new SqliteCapabilityGraph(firstContext);
      for (const [index, eventId] of ["audit-restart-a", "audit-restart-b"].entries()) {
        const event = {
          schemaVersion: 1 as const,
          eventId,
          cursor: `cursor:${index + 1}`,
          sourceId: "source-1",
          agentKind: "traex" as const,
          sessionId: "session-1",
          turnId: null,
          occurredAt: coreOld,
          payload: { type: "source_error" as const, code: "runtime_identity_changed" }
        };
        const laneId = `lane:${eventId}`;
        firstContext.database.prepare(`INSERT INTO core_event_inbox(
          event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type,submission_id
        ) VALUES(?,?,?,?,NULL,?,?,?,?,'source_error',NULL)`).run(
          event.eventId, event.sourceId, event.agentKind, event.sessionId, event.cursor,
          event.occurredAt, JSON.stringify(event), coreOld
        );
        firstContext.database.prepare(`INSERT INTO core_event_lane_items(lane_id,event_id,sequence,state,created_at,updated_at)
          VALUES(?,?,1,'ignored',?,?)`).run(laneId, event.eventId, coreOld, coreOld);
        firstContext.database.prepare(`INSERT INTO core_event_lane_checkpoints(
          lane_id,source_id,source_epoch,agent_kind,session_id,read_cursor,latest_cursor,updated_at
        ) VALUES(?,'source-1','epoch-1','traex','session-1',?,?,?)`).run(laneId, event.cursor, event.cursor, coreOld);
      }

      expect(firstGraph.retentionCompaction.auditPage({
        kind: "core_event", evaluatedAt: now, retentionWindowMs: CORE_EVENT_RETENTION_WINDOW_MS, limit: 1
      })).toMatchObject({
        scanned: 1, eligible: 1, alreadyVerified: 0,
        cursor: { eventId: "audit-restart-a" }, cycleComplete: false
      });
      firstContext.close();

      const resumedContext = new SqliteContext(databasePath);
      const resumedGraph = new SqliteCapabilityGraph(resumedContext);
      expect(resumedGraph.retentionCompaction.auditPage({
        kind: "core_event", evaluatedAt: now, retentionWindowMs: CORE_EVENT_RETENTION_WINDOW_MS, limit: 1
      })).toMatchObject({
        scanned: 1, eligible: 1, alreadyVerified: 0,
        cursor: { eventId: "audit-restart-b" }, cycleComplete: true
      });
      expect(resumedContext.database.prepare(`SELECT event_id,event_json,payload_compacted_at
        FROM core_event_inbox ORDER BY event_id`).all()).toEqual([
        expect.objectContaining({ event_id: "audit-restart-a", payload_compacted_at: null }),
        expect.objectContaining({ event_id: "audit-restart-b", payload_compacted_at: null })
      ]);
      resumedContext.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("retains a preparation-failed semantic snapshot until recovery is discharged", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    const snapshot = insertRecoverableSemanticFailure(context, "semantic-failure");

    expect(graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 10 })).toMatchObject({
      scanned: 1, compacted: 0, refusals: { not_terminal: 1 }
    });
    expect(context.database.prepare("SELECT presentation_snapshot_json,presentation_snapshot_hash,payload_compacted_at FROM outbound_replies WHERE id='semantic-failure'").get()).toEqual({
      presentation_snapshot_json: snapshot,
      presentation_snapshot_hash: createHash("sha256").update(snapshot).digest("hex"),
      payload_compacted_at: null
    });
    context.close();
  });

  it("compacts a settled semantic snapshot only after preserving its frozen plan and identity hash", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    const snapshot = insertRecoverableSemanticFailure(context, "semantic-settled");
    const plan = JSON.stringify({ protocolVersion: 1, gatewayId: "feishu:primary", profileId: "feishu-cardkit-v1", rendererRevision: 1, operation: "message.reply.view", intent: { kind: "message.reply.view" } });
    context.database.prepare(`UPDATE outbound_replies SET state='delivered',preparation_state='prepared',gateway_plan_json=?,gateway_plan_hash=?,
      effect_certainty=NULL,failure_class=NULL,error=NULL,delivered_message_id='message' WHERE id='semantic-settled'`)
      .run(plan, createHash("sha256").update(plan).digest("hex"));
    context.database.prepare("DELETE FROM delivery_recoveries WHERE failed_reply_id='semantic-settled'").run();

    expect(graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 10 })).toMatchObject({ compacted: 1, refusals: {} });
    expect(context.database.prepare(`SELECT presentation_snapshot_json,presentation_snapshot_hash,gateway_plan_json,payload_compacted_at
      FROM outbound_replies WHERE id='semantic-settled'`).get()).toEqual({
      presentation_snapshot_json: null,
      presentation_snapshot_hash: createHash("sha256").update(snapshot).digest("hex"),
      gateway_plan_json: plan,
      payload_compacted_at: now
    });
    context.close();
  });

  it("atomically compacts an eligible Delivery payload and advances its durable cursor", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    const payload = JSON.stringify({ body: "secret:eligible" });
    insertDelivery(context, "eligible", "delivered", payload);

    const result = graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 10 });

    expect(result).toEqual({
      source: "delivery", scanned: 1, compacted: 1, alreadyCompacted: 0,
      refusals: {}, cursor: { updatedAt: old, id: "eligible" }, cycleComplete: true
    });
    expect(JSON.stringify(result)).not.toContain("secret:eligible");
    expect(context.database.prepare("SELECT payload,payload_compacted_at FROM outbound_replies WHERE id='eligible'").get())
      .toEqual({ payload: "", payload_compacted_at: now });
    expect(graph.retentionAudit.load({ kind: "delivery", id: "eligible" })).toMatchObject({
      payloadHash: createHash("sha256").update(payload).digest("hex"),
      payloadBytes: Buffer.byteLength(payload), state: "compacted", compactedAt: now
    });
    expect(context.database.prepare("SELECT source_kind,cycle_state,after_key_json FROM retention_compaction_cursors WHERE source_kind='delivery'").get())
      .toEqual({ source_kind: "delivery", cycle_state: "complete", after_key_json: JSON.stringify({ updatedAt: old, id: "eligible" }) });
    expect(() => context.database.prepare("UPDATE outbound_replies SET payload='tampered',payload_compacted_at=NULL WHERE id='eligible'").run())
      .toThrow("immutable_outbound_revision");
    const diagnostics = graph.operations.getOperationalSummary().retentionCompaction;
    expect(diagnostics).toMatchObject({ totalCompacted: 1, sources: [{ source: "delivery", compacted: 1, cycleState: "complete" }] });
    expect(JSON.stringify(diagnostics)).not.toContain("secret:eligible");
    context.close();
  });

  it("does not prune or compact a Delivery linked to a live fresh Completion Review presentation", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    context.database.prepare(`INSERT INTO bindings(id,runtime,workspace_id,chat_id,title,state,last_agent_state,created_at,updated_at)
      VALUES('binding-1','traex','workspace-1','chat-1','Task','active','done',?,?)`).run(old, old);
    insertDelivery(context, "live-review");
    context.database.prepare(`INSERT INTO completion_action_sets(
      id,owner_kind,owner_id,owner_generation,binding_id,binding_generation,page_index,mention_open_id,
      presentation_kind,presentation_generation,presentation_reply_id,state,created_at,updated_at
    ) VALUES('review-action','primary-prompt','prompt-1',1,'binding-1',1,0,'user-1','fresh-card',1,'live-review','presenting',?,?)`).run(old, old);

    expect(new SqliteOutboxRetentionStore(context).pruneDelivered(now, 10)).toBe(0);
    expect(graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 10 }))
      .toMatchObject({ compacted: 0, refusals: { referenced: 1 } });
    expect(context.database.prepare("SELECT payload,payload_compacted_at FROM outbound_replies WHERE id='live-review'").get())
      .toEqual({ payload: JSON.stringify({ body: "secret:live-review" }), payload_compacted_at: null });

    context.database.prepare("UPDATE completion_action_sets SET state='active' WHERE id='review-action'").run();
    expect(new SqliteOutboxRetentionStore(context).pruneDelivered(now, 10)).toBe(0);
    expect(graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 10 }))
      .toMatchObject({ compacted: 0, refusals: { referenced: 1 } });

    context.database.prepare("UPDATE completion_action_sets SET state='consumed' WHERE id='review-action'").run();
    expect(graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 10 }))
      .toMatchObject({ compacted: 1, refusals: {} });
    context.close();
  });

  it("compacts a production-shaped claimed Delivery without weakening claim immutability", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    const payload = JSON.stringify({ body: "secret:claimed" });
    insertDelivery(context, "claimed", "delivered", payload);
    context.database.prepare(`UPDATE outbound_replies SET
      first_claimed_at=?,gateway_plan_json=?,gateway_plan_hash=?,payload_hash=?
      WHERE id='claimed'`).run(
        old,
        JSON.stringify({ gatewayId: "feishu:primary", operation: "surface.replace" }),
        "gateway-plan-hash",
        createHash("sha256").update(payload).digest("hex")
      );

    expect(graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 10 }))
      .toMatchObject({ scanned: 1, compacted: 1, refusals: {} });
    expect(context.database.prepare("SELECT payload,payload_compacted_at,gateway_plan_json,gateway_plan_hash FROM outbound_replies WHERE id='claimed'").get())
      .toEqual({
        payload: "",
        payload_compacted_at: now,
        gateway_plan_json: JSON.stringify({ gatewayId: "feishu:primary", operation: "surface.replace" }),
        gateway_plan_hash: "gateway-plan-hash"
      });
    expect(() => context.database.prepare("UPDATE outbound_replies SET payload='changed' WHERE id='claimed'").run())
      .toThrow("immutable_outbound_revision");
    expect(() => context.database.prepare("UPDATE outbound_replies SET payload_compacted_at=NULL WHERE id='claimed'").run())
      .toThrow("immutable_outbound_revision");
    context.close();
  });

  it("compacts a claimed legacy-v1 Delivery after preserving its typed intent identity", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    const payload = JSON.stringify({ body: "secret:legacy-v1" });
    insertDelivery(context, "claimed-v1", "delivered", payload);
    context.database.prepare(`UPDATE outbound_replies SET intent_json=json_object(
      'schemaVersion',1,'kind',intent_kind,'materializedPayload',payload
    ) WHERE id='claimed-v1'`).run();
    context.database.prepare(`UPDATE outbound_replies SET
      first_claimed_at=?,gateway_plan_json=?,gateway_plan_hash=?,payload_hash=?
      WHERE id='claimed-v1'`).run(
        old,
        JSON.stringify({ gatewayId: "feishu:primary", operation: "surface.replace" }),
        "gateway-plan-hash",
        createHash("sha256").update(payload).digest("hex")
      );

    expect(graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 10 }))
      .toMatchObject({ scanned: 1, compacted: 1, refusals: {} });
    expect(context.database.prepare(`SELECT payload,payload_compacted_at,
      json_extract(intent_json,'$.schemaVersion') AS intent_schema_version
      FROM outbound_replies WHERE id='claimed-v1'`).get()).toEqual({
        payload: "", payload_compacted_at: now, intent_schema_version: 2
      });
    context.close();
  });

  it("resumes a durable Delivery cursor after restart and opens a new cycle after wrap", () => {
    const directory = mkdtempSync(join(tmpdir(), "retention-compaction-"));
    const databasePath = join(directory, "bridge.sqlite");
    try {
      let context = new SqliteContext(databasePath);
      let graph = new SqliteCapabilityGraph(context);
      insertDelivery(context, "cursor-a");
      insertDelivery(context, "cursor-b");

      expect(graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 1 }))
        .toMatchObject({ scanned: 1, compacted: 1, cycleComplete: false, cursor: { id: "cursor-a" } });
      context.close();

      context = new SqliteContext(databasePath);
      graph = new SqliteCapabilityGraph(context);
      expect(graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 1 }))
        .toMatchObject({ scanned: 1, compacted: 1, cycleComplete: true, cursor: { id: "cursor-b" } });

      insertDelivery(context, "cursor-c");
      expect(graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 1 }))
        .toMatchObject({ scanned: 1, compacted: 1, cycleComplete: true, cursor: { id: "cursor-c" } });
      expect(context.database.prepare("SELECT id,payload_compacted_at FROM outbound_replies ORDER BY id").all())
        .toEqual([
          { id: "cursor-a", payload_compacted_at: now },
          { id: "cursor-b", payload_compacted_at: now },
          { id: "cursor-c", payload_compacted_at: now }
        ]);
      context.close();
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("leaves a refused Delivery payload and Audit Skeleton unchanged while recording bounded diagnostics", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    insertDelivery(context, "pending", "pending");

    const result = graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 1 });

    expect(result).toMatchObject({ scanned: 1, compacted: 0, refusals: { not_terminal: 1 } });
    expect(context.database.prepare("SELECT payload,payload_compacted_at FROM outbound_replies WHERE id='pending'").get())
      .toEqual({ payload: JSON.stringify({ body: "secret:pending" }), payload_compacted_at: null });
    expect(graph.retentionAudit.load({ kind: "delivery", id: "pending" })).toBeNull();
    context.close();
  });

  it("re-evaluates references inside each page transaction before compacting a discovered Delivery", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    insertDelivery(context, "reference-a");
    insertDelivery(context, "reference-b");

    expect(graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 1 }))
      .toMatchObject({ compacted: 1, cycleComplete: false, cursor: { id: "reference-a" } });
    insertDelivery(context, "dependent");
    context.database.prepare(`INSERT INTO outbound_reply_prerequisites(
      dependent_reply_id,prerequisite_reply_id,required_state,created_at
    ) VALUES('dependent','reference-b','delivered',?)`).run(old);

    expect(graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 1 }))
      .toMatchObject({ scanned: 1, compacted: 0, refusals: { referenced: 1 }, cycleComplete: true });
    expect(context.database.prepare("SELECT payload_compacted_at FROM outbound_replies WHERE id='reference-b'").get())
      .toEqual({ payload_compacted_at: null });
    expect(graph.retentionAudit.load({ kind: "delivery", id: "reference-b" })).toBeNull();
    context.close();
  });

  it("retains a delivered exact presentation while its pending completion dependent is beyond the cutoff", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    insertDelivery(context, "choice-presentation");
    insertDelivery(context, "choice-notification", "pending");
    context.database.prepare(`INSERT INTO outbound_reply_prerequisites(
      dependent_reply_id,prerequisite_reply_id,required_state,created_at
    ) VALUES('choice-notification','choice-presentation','delivered',?)`).run(old);

    expect(new SqliteOutboxRetentionStore(context).pruneDelivered(now, 10)).toBe(0);
    expect(context.database.prepare("SELECT id FROM outbound_replies WHERE id='choice-presentation'").get())
      .toEqual({ id: "choice-presentation" });
    expect(context.database.prepare("SELECT prerequisite_reply_id FROM outbound_reply_prerequisites WHERE dependent_reply_id='choice-notification'").get())
      .toEqual({ prerequisite_reply_id: "choice-presentation" });

    expect(removeDependentDeliveryPrerequisites(context, "choice-notification")).toBe(1);
    expect(new SqliteOutboxRetentionStore(context).pruneDelivered(now, 10)).toBe(1);
    expect(context.database.prepare("SELECT id FROM outbound_replies WHERE id='choice-presentation'").get()).toBeUndefined();
    expect(context.database.prepare("SELECT id,state FROM outbound_replies WHERE id='choice-notification'").get())
      .toEqual({ id: "choice-notification", state: "pending" });
    context.close();
  });

  it("rolls back payload, Skeleton, and cursor after lease ownership is lost", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    insertDelivery(context, "lease-lost");
    const lease = graph.leases.acquireInstanceLease("owner", now, "2099-10-08T00:00:00.000Z")!;
    graph.leases.activateWriteFence(lease.ownerId, lease.fencingToken);
    graph.leases.releaseInstanceLease(lease.ownerId, lease.fencingToken);

    expect(() => graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 1 }))
      .toThrow("stale_instance_lease");
    expect(context.database.prepare("SELECT payload_compacted_at FROM outbound_replies WHERE id='lease-lost'").get())
      .toEqual({ payload_compacted_at: null });
    expect(graph.retentionAudit.load({ kind: "delivery", id: "lease-lost" })).toBeNull();
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM retention_compaction_cursors").get())
      .toEqual({ count: 0 });
    context.close();
  });

  it("rolls back payload, Skeleton, and cursor when payload mutation fails", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    insertDelivery(context, "rollback");
    context.database.exec(`CREATE TRIGGER reject_payload_compaction BEFORE UPDATE OF payload_compacted_at ON outbound_replies
      WHEN NEW.id='rollback' BEGIN SELECT RAISE(ABORT, 'injected_payload_failure'); END`);

    expect(() => graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 1 }))
      .toThrow("injected_payload_failure");
    expect(context.database.prepare("SELECT payload_compacted_at FROM outbound_replies WHERE id='rollback'").get())
      .toEqual({ payload_compacted_at: null });
    expect(graph.retentionAudit.load({ kind: "delivery", id: "rollback" })).toBeNull();
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM retention_compaction_cursors").get()).toEqual({ count: 0 });
    context.close();
  });

  it("compacts a normalized settled Core event while preserving its lane checkpoint evidence", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    const eventJson = JSON.stringify({
      schemaVersion: 1, eventId: "event-1", cursor: "cursor:1", sourceId: "source-1", agentKind: "traex",
      sessionId: "session-1", turnId: "turn-1", occurredAt: old,
      payload: { type: "turn_completed" }
    });
    context.database.prepare(`INSERT INTO core_event_inbox(
      event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type,submission_id
    ) VALUES('event-1','source-1','traex','session-1','turn-1','cursor:1',?,?,?,'turn_completed',NULL)`).run(old, eventJson, old);
    const humanJson = JSON.stringify({
      schemaVersion: 1, eventId: "human-1", cursor: "cursor:0", sourceId: "source-1", agentKind: "traex",
      sessionId: "session-1", turnId: "turn-1", occurredAt: old,
      payload: { type: "human_message", message_id: "message-1", text: "hello", truncated: false, submission_id: "submission-1" }
    });
    context.database.prepare(`INSERT INTO core_event_inbox(
      event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type,submission_id
    ) VALUES('human-1','source-1','traex','session-1','turn-1','cursor:0',?,?,?,'human_message','submission-1')`).run(old, humanJson, old);
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,submission_id,human_event_id,agent_kind,session_id,
      request_text,state,view_version,root_message_id,created_at,updated_at
    ) VALUES('core-segment','lane:lane-1','primary','binding-1',1,'submission-1','human-1','traex','session-1',
      'hello','completed',1,'root-1',?,?)`).run(old, old);
    context.database.prepare(`INSERT INTO core_event_lane_items(lane_id,event_id,sequence,state,created_at,updated_at)
      VALUES('lane-1','event-1',1,'projected',?,?)`).run(old, old);
    context.database.prepare(`INSERT INTO core_event_lane_checkpoints(
      lane_id,source_id,source_epoch,agent_kind,session_id,read_cursor,latest_cursor,updated_at
    ) VALUES('lane-1','source-1','epoch-1','traex','session-1','cursor:1','cursor:1',?)`).run(old);

    const result = graph.retentionCompaction.compactPage({ kind: "core_event", evaluatedAt: now, limit: 10 });

    expect(result).toMatchObject({ source: "core_event", scanned: 2, compacted: 1, refusals: { human_input_retained: 1 }, cycleComplete: true });
    expect(context.database.prepare("SELECT event_json,payload_compacted_at FROM core_event_inbox WHERE event_id='event-1'").get())
      .toEqual({ event_json: "null", payload_compacted_at: now });
    expect(context.database.prepare("SELECT event_json,payload_compacted_at FROM core_event_inbox WHERE event_id='human-1'").get())
      .toEqual({ event_json: humanJson, payload_compacted_at: null });
    expect(graph.retentionAudit.load({ kind: "core_event", id: "event-1" })).toMatchObject({
      payloadHash: coreEventSemanticHash(JSON.parse(eventJson)), state: "compacted",
      links: expect.arrayContaining([
        { kind: "checkpoint", id: "lane-1", state: "projected:1" },
        { kind: "owner", id: "core-segment", state: "conversation-segment:completed" }
      ])
    });
    expect(graph.operations.getOperationalSummary().retentionCompaction.coreEvent?.retainedBytes).toBe(0);
    const projected: Array<{ laneId: string; event: unknown }> = [];
    const replayInbox = new SqliteCoreEventInboxStore(context, {
      projectCanonicalEvent: ({ laneId, event }) => projected.push({ laneId, event })
    });
    const transportReplay = {
      ...JSON.parse(eventJson), sourceId: "replay-source", cursor: "replay:1"
    };
    expect(replayInbox.ingestBatch({
      laneId: "lane-replay", sourceId: "replay-source", sourceEpoch: "epoch-replay", agentKind: "traex", sessionId: "session-1",
      afterCursor: "start", nextCursor: "replay:1", latestCursor: "replay:1", ingestedAt: now,
      events: [transportReplay]
    })).toBe("accepted");
    expect(projected).toEqual([]);
    expect(replayInbox.getCheckpoint("lane-replay")).toMatchObject({ readCursor: "replay:1" });
    expect(context.database.prepare(`SELECT state,conflict_count FROM core_event_lane_items
      WHERE lane_id='lane-replay' AND event_id='event-1'`).get()).toEqual({ state: "ignored", conflict_count: 0 });
    expect(context.database.prepare("SELECT event_json,payload_compacted_at FROM core_event_inbox WHERE event_id='event-1'").get())
      .toEqual({ event_json: "null", payload_compacted_at: now });

    const conflictingReplay = {
      ...transportReplay, sourceId: "conflict-source", cursor: "conflict:1",
      payload: { type: "turn_completed", conflict: true }
    };
    expect(replayInbox.ingestBatch({
      laneId: "lane-conflict", sourceId: "conflict-source", sourceEpoch: "epoch-conflict", agentKind: "traex", sessionId: "session-1",
      afterCursor: "start", nextCursor: "conflict:1", latestCursor: "conflict:1", ingestedAt: now,
      events: [conflictingReplay]
    })).toBe("accepted");
    expect(replayInbox.getCheckpoint("lane-conflict")).toMatchObject({ readCursor: "conflict:1" });
    expect(context.database.prepare(`SELECT state,conflict_count,last_conflict_hash,last_conflict_reason,last_conflict_at
      FROM core_event_lane_items WHERE lane_id='lane-conflict' AND event_id='event-1'`).get()).toEqual({
      state: "ignored", conflict_count: 1, last_conflict_hash: expect.stringMatching(/^[a-f0-9]{64}$/),
      last_conflict_reason: "semantic_conflict", last_conflict_at: now
    });
    expect(context.database.prepare("SELECT event_json,payload_compacted_at FROM core_event_inbox WHERE event_id='event-1'").get())
      .toEqual({ event_json: "null", payload_compacted_at: now });
    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-1", sourceId: "source-1", sourceEpoch: "epoch-1", agentKind: "traex", sessionId: "session-1",
      afterCursor: "cursor:1", nextCursor: "cursor:1", latestCursor: "cursor:1", ingestedAt: now,
      events: [JSON.parse(eventJson)]
    })).toBe("accepted");
    expect(context.database.prepare("SELECT event_json,payload_compacted_at FROM core_event_inbox WHERE event_id='event-1'").get())
      .toEqual({ event_json: "null", payload_compacted_at: now });
    const canonicalStartedAt = "2026-09-01T00:00:00.000Z";
    context.database.prepare(`INSERT INTO conversation_turn_projections(
      agent_kind,session_id,turn_id,started_at,source_lane_id,projection_id,origin,state_json,answer_card_json,created_at,updated_at
    ) VALUES('traex','session-1','turn-1',?,'lane-1','projection-1','herdr','{}','{}',?,?)`)
      .run(canonicalStartedAt, old, old);
    context.database.prepare(`INSERT INTO conversation_turn_projection_events(
      agent_kind,session_id,turn_id,started_at,event_id,sequence,created_at
    ) VALUES('traex','session-1','turn-1',?,'event-1',1,?)`).run(canonicalStartedAt, old);
    const startEvent = {
      schemaVersion: 1, eventId: "start-1", cursor: "snapshot:0", sourceId: "snapshot", agentKind: "traex" as const,
      sessionId: "session-1", turnId: "turn-1", occurredAt: canonicalStartedAt, payload: { type: "turn_started" }
    };
    const changedTerminal = { ...JSON.parse(eventJson), occurredAt: "2026-09-01T00:00:01.000Z" };
    expect(graph.turnSnapshots.stageAuthoritativeTurnSnapshotPage({
      identity: { agentKind: "traex", sessionId: "session-1", turnId: "turn-1", requestedStartedAt: canonicalStartedAt },
      owner: { kind: "binding", id: "binding-1" }, afterCursor: "",
      batch: { outcome: "recovered", canonicalStartedAt, nextCursor: "snapshot:1", complete: true, events: [startEvent, changedTerminal] },
      observedAt: now
    })).toMatchObject({ outcome: "ambiguous", failureCode: "live_event_conflict" });
    context.close();
  });

  it("keeps a compacted source diagnostic ignored when Core replays it on a new lane", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    const diagnostic = {
      schemaVersion: 1 as const,
      eventId: "compacted-diagnostic",
      cursor: "diagnostic:1",
      sourceId: "source-1",
      agentKind: "traex" as const,
      sessionId: "session-1",
      turnId: null,
      occurredAt: old,
      payload: { type: "source_error" as const, code: "runtime_identity_changed" }
    };
    const diagnosticJson = JSON.stringify(diagnostic);
    context.database.prepare(`INSERT INTO core_event_inbox(
      event_id,source_id,agent_kind,session_id,turn_id,source_cursor,occurred_at,event_json,ingested_at,event_type,submission_id
    ) VALUES(?,?,?,?,NULL,?,?,?,?,'source_error',NULL)`).run(
      diagnostic.eventId, diagnostic.sourceId, diagnostic.agentKind, diagnostic.sessionId,
      diagnostic.cursor, diagnostic.occurredAt, diagnosticJson, old
    );
    context.database.prepare(`INSERT INTO core_event_lane_items(lane_id,event_id,sequence,state,created_at,updated_at)
      VALUES('lane-diagnostic','compacted-diagnostic',1,'ignored',?,?)`).run(old, old);
    context.database.prepare(`INSERT INTO core_event_lane_checkpoints(
      lane_id,source_id,source_epoch,agent_kind,session_id,read_cursor,latest_cursor,updated_at
    ) VALUES('lane-diagnostic','source-1','epoch-1','traex','session-1','diagnostic:1','diagnostic:1',?)`).run(old);
    expect(graph.retentionCompaction.compactPage({ kind: "core_event", evaluatedAt: now, limit: 10 }))
      .toMatchObject({ compacted: 1, refusals: {} });

    const projected: unknown[] = [];
    const replayInbox = new SqliteCoreEventInboxStore(context, {
      projectCanonicalEvent: (input) => projected.push(input)
    });
    const replay = { ...diagnostic, sourceId: "replay-source", cursor: "replay:1" };
    expect(replayInbox.ingestBatch({
      laneId: "lane-diagnostic-replay", sourceId: "replay-source", sourceEpoch: "epoch-replay",
      agentKind: "traex", sessionId: "session-1", afterCursor: "start", nextCursor: replay.cursor,
      latestCursor: replay.cursor, ingestedAt: now, events: [replay]
    })).toBe("accepted");
    expect(projected).toEqual([]);
    expect(context.database.prepare("SELECT state FROM core_event_lane_items WHERE lane_id=? AND event_id=?")
      .get("lane-diagnostic-replay", diagnostic.eventId)).toEqual({ state: "ignored" });
    expect(replayInbox.getCheckpoint("lane-diagnostic-replay")).toMatchObject({ readCursor: replay.cursor });
    context.close();
  });

  it("compacts a delivered Timeline item and permanently protects its reconstructing Delivery payload", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    context.database.prepare(`INSERT INTO bindings(id,runtime,workspace_id,chat_id,title,state,last_agent_state,created_at,updated_at)
      VALUES('binding-1','traex','workspace-1','chat-1','Task','active','done',?,?)`).run(old, old);
    context.database.prepare(`INSERT INTO prompt_jobs(id,binding_id,actor_open_id,body,state,created_at,updated_at)
      VALUES('prompt-1','binding-1','user-1','go','delivered',?,?)`).run(old, old);
    context.database.prepare(`INSERT INTO run_cards(
      prompt_id,binding_id,binding_generation,phase,title,workspace_id,answer,progress_events_json,
      queue_position,activity_at,view_version,delivered_version,created_at,updated_at
    ) VALUES('prompt-1','binding-1',1,'completed','Task','workspace-1','','[]',0,?,1,1,?,?)`).run(old, old, old);
    const item = { kind: "final_answer", id: "answer-1", sequence: 1, markdown: "done" };
    const itemJson = JSON.stringify(item);
    context.database.prepare(`INSERT INTO answer_timeline_items(aggregate_kind,aggregate_id,item_id,sequence,item_json)
      VALUES('primary-run','prompt-1','answer-1',1,?)`).run(itemJson);
    context.database.prepare(`INSERT INTO answer_timeline_page_checkpoints(
      aggregate_kind,aggregate_id,page_index,start_cursor_json,delivered_cursor_json,delivered_items_json,created_at,updated_at
    ) VALUES('primary-run','prompt-1',0,'{"itemIndex":0,"markdownOffset":0}','{"itemIndex":1,"markdownOffset":0}',?,?,?)`)
      .run(JSON.stringify([{ id: "answer-1", fingerprint: createHash("sha256").update(itemJson).digest("hex") }]), old, old);
    insertDelivery(context, "timeline-card");
    context.database.prepare(`UPDATE outbound_replies SET prompt_id='prompt-1',card_role='answer',stream_page_index=1,kind='card_update',
      projection_key='answer-timeline:prompt-1:1' WHERE id='timeline-card'`).run();

    expect(graph.retentionCompaction.compactPage({ kind: "answer_timeline_item", evaluatedAt: now, limit: 10 }))
      .toMatchObject({ scanned: 1, compacted: 0, refusals: { projection_not_reconstructible: 1 } });
    expect(context.database.prepare("SELECT item_json,payload_compacted_at FROM answer_timeline_items").get())
      .toEqual({ item_json: itemJson, payload_compacted_at: null });
    context.database.prepare(`UPDATE outbound_replies SET stream_page_index=0,
      projection_key='answer-timeline:prompt-1:0' WHERE id='timeline-card'`).run();

    expect(graph.retentionCompaction.compactPage({ kind: "answer_timeline_item", evaluatedAt: now, limit: 10 }))
      .toMatchObject({ scanned: 1, compacted: 1, refusals: {} });
    expect(context.database.prepare("SELECT item_json,payload_compacted_at FROM answer_timeline_items").get())
      .toEqual({ item_json: "null", payload_compacted_at: now });
    const timeline = new SqliteAnswerTimelineStore(context);
    expect(() => timeline.save("primary-run", "prompt-1", [item])).not.toThrow();
    expect(() => timeline.save("primary-run", "prompt-1", [{ ...item, markdown: "changed" }]))
      .toThrow("compacted_payload_conflict");
    expect(graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 10 }))
      .toMatchObject({ compacted: 0, refusals: { referenced: 1 } });
    expect(context.database.prepare("SELECT payload_compacted_at FROM outbound_replies WHERE id='timeline-card'").get())
      .toEqual({ payload_compacted_at: null });
    context.close();
  });

  it("compacts a terminal Conversation item only when a delivered card remains as reconstruction evidence", () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,start_lane_sequence,start_item_ordinal,
      state,view_version,root_message_id,created_at,updated_at
    ) VALUES('segment-1','lane:1','primary','binding-1',2,'traex','session-1','go',1,0,'completed',2,'root-1',?,?)`).run(old, old);
    const item = { kind: "final_answer" as const, id: "answer-1", sequence: 1, markdown: "done", canonicalPosition: { laneSequence: 2, itemOrdinal: 0 } };
    const itemJson = JSON.stringify(item);
    context.database.prepare(`INSERT INTO conversation_segment_items(segment_id,item_id,lane_sequence,item_ordinal,item_json)
      VALUES('segment-1','answer-1',2,0,?)`).run(itemJson);
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,start_cursor_json,delivered_cursor_json,created_at,updated_at
    ) VALUES('page-1','segment-1',0,'message-1','card-1','element-1','finished',2,2,'{"itemIndex":0,"markdownOffset":0}','{"itemIndex":1,"markdownOffset":0}',?,?)`).run(old, old);
    insertDelivery(context, "segment-card");
    context.database.prepare("UPDATE outbound_replies SET projection_key='turn-card:segment-1:page:1' WHERE id='segment-card'").run();

    expect(graph.retentionCompaction.compactPage({ kind: "conversation_segment_item", evaluatedAt: now, limit: 10 }))
      .toMatchObject({ scanned: 1, compacted: 0, refusals: { projection_not_reconstructible: 1 } });
    expect(context.database.prepare("SELECT item_json,payload_compacted_at FROM conversation_segment_items").get())
      .toEqual({ item_json: itemJson, payload_compacted_at: null });
    context.database.prepare("UPDATE outbound_replies SET projection_key='turn-card:segment-1:page:0' WHERE id='segment-card'").run();

    expect(graph.retentionCompaction.compactPage({ kind: "conversation_segment_item", evaluatedAt: now, limit: 10 }))
      .toMatchObject({ scanned: 1, compacted: 1, refusals: {} });
    expect(graph.conversationSegments.listConversationSegmentItems("segment-1")).toEqual([]);
    const replayEvent = {
      schemaVersion: 1, eventId: "replay-1", cursor: "cursor:replay-1", sourceId: "source-1", agentKind: "traex" as const,
      sessionId: "session-1", turnId: "turn-1", occurredAt: now, payload: { type: "assistant_message", text: "done" }
    };
    expect(graph.conversationSegments.projectCanonicalEvent({
      laneId: "1", laneSequence: 2, event: replayEvent, observedAt: now, timelineDeltas: [item]
    })).toEqual({ outcome: "duplicate", segmentId: "segment-1" });
    expect(() => graph.conversationSegments.projectCanonicalEvent({
      laneId: "1", laneSequence: 2, event: { ...replayEvent, eventId: "replay-2", cursor: "cursor:replay-2" }, observedAt: now,
      timelineDeltas: [{ ...item, markdown: "changed" }]
    })).toThrow("compacted_payload_conflict");
    expect(graph.retentionCompaction.compactPage({ kind: "delivery", evaluatedAt: now, limit: 10 }))
      .toMatchObject({ compacted: 0, refusals: { referenced: 1 } });
    context.close();
  });
});
