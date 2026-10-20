import { describe, expect, it, vi } from "vitest";
import { SqliteContext } from "../src/store/sqlite/context.js";
import { SqliteMigrations } from "../src/store/sqlite/migrations.js";
import { SqliteConversationSegmentStore } from "../src/store/sqlite/conversation-segment-store.js";
import { SqliteProjectionGapStore } from "../src/store/sqlite/projection-gap-store.js";
import { SqliteSubmissionIntentStore } from "../src/store/sqlite/submission-intent-store.js";
import { SqliteCapabilityGraph } from "../src/store/sqlite/capability-graph.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";
import { TurnCardWorkflow } from "../src/coordinator/turn-card-workflow.js";
import { planAndRenderTurnCard, renderTurnCard } from "../src/cards/turn-card.js";
import { prepareOutboundGatewayIntent } from "../src/events/outbound-gateway-intent.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
import { renderWorkerTurnCard } from "../src/cards/worker-turn-card.js";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { parseHerdrAgentEvent } from "../src/adapters/herdr-events-adapter.js";
import { toCoreEventEnvelope } from "../src/runtime/herdr-events/identity.js";
import { agentEvent } from "./helpers/herdr-events.js";

describe("human Turn Card concrete store", () => {
  it("rehydrates only the active-page suffix with a localized durable cursor", () => {
    const directory = mkdtempSync(join(tmpdir(), "turn-card-active-suffix-"));
    const path = join(directory, "bridge.sqlite");
    const timestamp = "2026-10-08T00:00:00.000Z";
    let context = new SqliteContext(path); new SqliteMigrations(context).run();
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,state,view_version,
      root_message_id,timeline_item_count,has_visible_assistant_content,created_at,updated_at
    ) VALUES('active-suffix','lane:active','primary','owner',1,'traex','session','request','working',7,'root',5,1,?,?)`).run(timestamp, timestamp);
    const insertItem = context.database.prepare(`INSERT INTO conversation_segment_items(
      segment_id,item_id,lane_sequence,item_ordinal,item_json
    ) VALUES('active-suffix',?,?,?,?)`);
    for (let index = 0; index < 5; index += 1) insertItem.run(`item-${index}`, index + 1, 0, JSON.stringify({
      kind: "agent_message", id: `item-${index}`, sequence: index, canonicalPosition: { laneSequence: index + 1, itemOrdinal: 0 }, markdown: `message-${index}`
    }));
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,start_cursor_json,delivered_cursor_json,created_at,updated_at
    ) VALUES('active-suffix:0','active-suffix',0,'frozen-message','frozen-card','turn-card:active-suffix:page:0','frozen',5,5,NULL,?, ?,?)`)
      .run(JSON.stringify({ itemIndex: 3, markdownOffset: 2 }), timestamp, timestamp);
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,start_cursor_json,delivered_cursor_json,
      start_lane_sequence,start_item_ordinal,cursor_base,created_at,updated_at
    ) VALUES('active-suffix:1','active-suffix',1,'active-message','active-card','turn-card:active-suffix:page:1','active',7,6,?,?,4,0,3,?,?)`)
      .run(JSON.stringify({ itemIndex: 3, markdownOffset: 2 }), JSON.stringify({ itemIndex: 3, markdownOffset: 2 }), timestamp, timestamp);

    let projection = new SqliteConversationSegmentStore(context).loadActiveProjection("active-suffix");
    expect(projection).toMatchObject({ cursorBase: 3, localStartCursor: { itemIndex: 0, markdownOffset: 2 }, page: { pageIndex: 1, state: "active" } });
    expect(projection?.view.timelineItems.map(({ id }) => id)).toEqual(["item-3", "item-4"]);
    context.close();

    context = new SqliteContext(path); new SqliteMigrations(context).run();
    projection = new SqliteConversationSegmentStore(context).loadActiveProjection("active-suffix");
    expect(projection?.view.timelineItems.map(({ id }) => id)).toEqual(["item-3", "item-4"]);
    expect(projection?.localStartCursor).toEqual({ itemIndex: 0, markdownOffset: 2 });
    context.close(); rmSync(directory, { recursive: true, force: true });
  });

  it("records Worker work without creating a speculative Conversation Segment or Turn Card", () => {
    const store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({
      id: "binding-worker-canonical", gatewayId: "feishu:worker-route", projectId: "project",
      workspaceId: "workspace-primary", chatId: "chat", topicId: "topic", rootMessageId: "primary-root", title: "Primary"
    });
    const worker = store.createAgentInstance({
      id: "worker-canonical", projectId: "project", name: "worker-canonical", role: "worker", agentKind: "traex", model: null,
      parent: { bindingId: "binding-worker-canonical", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
      desiredState: "running", workspace: { id: "workspace-worker-canonical", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    });
    const view = createQueuedWorkerTurnCard({
      turnId: "worker-turn-canonical", instanceId: worker.id, instanceGeneration: worker.generation,
      workerSessionGeneration: worker.workerSessionGeneration, workerName: worker.name, parentTurnId: null,
      rootMessageId: "worker-root", requestText: "review", queuePosition: 0, occurredAt: "2026-10-04T00:00:00.000Z"
    });
    store.acceptInstanceTurnWithCard({
      id: view.turnId, idempotencyKey: view.turnId, actor: { kind: "human", userId: "operator", channel: "feishu" },
      projectId: worker.projectId, instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: view.requestText,
      parentTurnId: null, sourceMessageId: "worker-source", view, render: renderWorkerTurnCard,
      unifiedSegment: {
        segmentId: `worker-turn:${view.turnId}`, submissionId: view.turnId, producerKey: `worker:${worker.id}`,
        owner: { kind: "worker", id: worker.id, generation: worker.generation }, agentKind: "traex", expectedSessionId: null,
        rootMessageId: "worker-root", occurredAt: "2026-10-04T00:00:00.000Z"
      }
    });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM conversation_segments").get()).toEqual({ count: 0 });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_pages").get()).toEqual({ count: 0 });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key LIKE 'turn-card:%'").get()).toEqual({ count: 0 });
    expect(store.database.prepare("SELECT canonical_segment_id,canonical_submission_id,canonical_agent_kind,canonical_root_message_id,canonical_gateway_id FROM instance_turns WHERE id=?").get(view.turnId)).toEqual({
      canonical_segment_id: `worker-turn:${view.turnId}`,
      canonical_submission_id: view.turnId,
      canonical_agent_kind: "traex",
      canonical_root_message_id: "worker-root",
      canonical_gateway_id: "feishu:worker-route"
    });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version=97").get()).toEqual({ version: 97 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version=98").get()).toEqual({ version: 98 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version=99").get()).toEqual({ version: 99 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version=100").get()).toEqual({ version: 100 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version=101").get()).toEqual({ version: 101 });
    store.close();
  });

  it("fails closed when a Worker canonical intent has no exact parent gateway", () => {
    const store = new SqliteBindingStore(":memory:");
    const worker = store.createAgentInstance({
      id: "worker-unroutable", projectId: "project", name: "worker-unroutable", role: "worker", agentKind: "traex", model: null,
      desiredState: "running", workspace: { id: "workspace-worker-unroutable", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    });
    const view = createQueuedWorkerTurnCard({
      turnId: "worker-turn-unroutable", instanceId: worker.id, instanceGeneration: worker.generation,
      workerSessionGeneration: worker.workerSessionGeneration, workerName: worker.name, parentTurnId: null,
      rootMessageId: "worker-root", requestText: "review", queuePosition: 0, occurredAt: "2026-10-04T00:00:00.000Z"
    });
    expect(() => store.acceptInstanceTurnWithCard({
      id: view.turnId, idempotencyKey: view.turnId, actor: { kind: "human", userId: "operator", channel: "feishu" },
      projectId: worker.projectId, instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: view.requestText,
      parentTurnId: null, sourceMessageId: "worker-source", view, render: renderWorkerTurnCard,
      unifiedSegment: {
        segmentId: `worker-turn:${view.turnId}`, submissionId: view.turnId, producerKey: `worker:${worker.id}`,
        owner: { kind: "worker", id: worker.id, generation: worker.generation }, agentKind: "traex", expectedSessionId: null,
        rootMessageId: "worker-root", occurredAt: "2026-10-04T00:00:00.000Z"
      }
    })).toThrow("Worker canonical gateway route is unavailable");
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM instance_turns").get()).toEqual({ count: 0 });
    store.close();
  });

  it("rolls back page reservations when the outbox capability is unavailable", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const store = new SqliteConversationSegmentStore(context);
    const now = new Date().toISOString();
    const insertPage = (id: string, state: "creating" | "active", messageId: string | null) => {
      context.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES(?,?,?,?,1,'traex','request','working',2,'root',?,?)")
        .run(id, `lane:${id}`, "primary", id, now, now);
      context.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,created_at,updated_at) VALUES(?,?,0,?,'card',?,?,1,1,?,?)")
        .run(`${id}:page:0`, id, messageId, `turn-card:${id}:page:0`, state, now, now);
    };
    insertPage("snapshot-no-outbox", "active", "message-snapshot");
    insertPage("freeze-no-outbox", "active", "message-freeze");
    insertPage("finish-no-outbox", "active", "message-finish");
    insertPage("continue-no-outbox", "active", "message-continue");
    expect(() => store.reserveSnapshot({ segmentId: "snapshot-no-outbox", pageIndex: 0, messageId: "message-snapshot", cardId: "card", elementId: "turn-card:snapshot-no-outbox:page:0", card: {}, cursor: { itemIndex: 1, markdownOffset: 1 }, viewVersion: 2 }))
      .toThrow("Conversation Segment prepared delivery is not connected");
    expect(() => store.reserveFreeze({ segmentId: "freeze-no-outbox", pageIndex: 0, messageId: "message-freeze", cardId: "card", elementId: "turn-card:freeze-no-outbox:page:0", card: {}, cursor: { itemIndex: 1, markdownOffset: 0 }, cursorAnchor: { position: { laneSequence: 1, itemOrdinal: 0 }, inclusive: false } }))
      .toThrow("Conversation Segment prepared delivery is not connected");
    expect(() => store.reserveFinish({ segmentId: "finish-no-outbox", pageIndex: 0, messageId: "message-finish", cardId: "card", elementId: "turn-card:finish-no-outbox:page:0", card: {}, summary: "done", cursor: { itemIndex: 0, markdownOffset: 0 } }))
      .toThrow("Conversation Segment prepared delivery is not connected");
    expect(() => store.reserveContinuation({ segmentId: "continue-no-outbox", pageIndex: 0, messageId: "message-continue", card: {}, nextPageIndex: 1, nextElementId: "turn-card:continue-no-outbox:page:1", nextStartCursor: { itemIndex: 1, markdownOffset: 0 } }))
      .toThrow("Conversation Segment prepared delivery is not connected");
    expect(context.database.prepare("SELECT segment_id,state,sequence,pending_reply_id FROM conversation_segment_pages ORDER BY segment_id,page_index").all()).toEqual([
      { segment_id: "continue-no-outbox", state: "active", sequence: 1, pending_reply_id: null },
      { segment_id: "finish-no-outbox", state: "active", sequence: 1, pending_reply_id: null },
      { segment_id: "freeze-no-outbox", state: "active", sequence: 1, pending_reply_id: null },
      { segment_id: "snapshot-no-outbox", state: "active", sequence: 1, pending_reply_id: null }
    ]);
    context.close();
  });

  it("rolls back Input Intent, segment, page, and create effect when atomic admission cannot enqueue", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const segments = new SqliteConversationSegmentStore(context);
    segments.setPreparedDeliveryReservation({ reservePreparedOutboundReply: () => { throw new Error("injected enqueue failure"); } }, { enqueuePreparedDelivery() {} });
    const intents = new SqliteSubmissionIntentStore(context, { enqueue: () => {}, conversationSegments: segments });
    expect(() => intents.admitLegacyPendingCard({
      submissionId: "rollback-submission", ingressSource: "feishu:primary", sourceMessageKey: "source",
      actor: { kind: "human", id: "operator", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic", rootMessageId: "root" },
      text: "hello", owner: { kind: "primary", id: "binding", generation: 1 }, paneId: "pane", terminalId: "terminal",
      expectedAgentKind: "traex", expectedSessionId: "session", recordedAt: "2026-10-04T20:00:00.000Z"
    }, { segmentId: "rollback-segment", rootMessageId: "root", card: { schema: "2.0" } })).toThrow("injected enqueue failure");
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM submission_intents").get()).toEqual({ count: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM conversation_segments").get()).toEqual({ count: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_pages").get()).toEqual({ count: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
    context.close();
  });
  it("upgrades a revision-95 projection gap constraint for turn-card ownership", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    expect(context.database.prepare("SELECT 1 FROM schema_migrations WHERE version=96").get()).toEqual({ 1: 1 });
    context.database.exec("ALTER TABLE projection_gaps RENAME TO projection_gaps_backup; CREATE TABLE projection_gaps(id INTEGER PRIMARY KEY AUTOINCREMENT, stage TEXT NOT NULL, owner_kind TEXT NOT NULL CHECK(owner_kind IN ('binding','prompt','answer_page','worker_turn')), owner_id TEXT NOT NULL, source_item_id TEXT NOT NULL, failure_class TEXT NOT NULL DEFAULT 'unknown', failure_code TEXT NOT NULL, required_version INTEGER, occurrence_count INTEGER NOT NULL DEFAULT 1, state TEXT NOT NULL DEFAULT 'open', compensated_by_version INTEGER, first_failed_at TEXT NOT NULL, last_failed_at TEXT NOT NULL, compensated_at TEXT, UNIQUE(stage,owner_kind,owner_id,source_item_id)); INSERT INTO projection_gaps(id,stage,owner_kind,owner_id,source_item_id,failure_class,failure_code,required_version,occurrence_count,state,compensated_by_version,first_failed_at,last_failed_at,compensated_at) SELECT id,stage,owner_kind,owner_id,source_item_id,failure_class,failure_code,required_version,occurrence_count,state,compensated_by_version,first_failed_at,last_failed_at,compensated_at FROM projection_gaps_backup; DROP TABLE projection_gaps_backup; DELETE FROM schema_migrations WHERE version=96 OR version>=112; DROP TABLE schema_metadata;");
    new SqliteMigrations(context).run();
    new SqliteProjectionGapStore(context).open({ stage: "turn_recovery", ownerKind: "turn_card", ownerId: "segment-upgraded", sourceItemId: "turn-card:segment-upgraded:page:0", failureClass: "permanent", failureCode: "test", occurredAt: new Date().toISOString() });
    expect(context.database.prepare("SELECT owner_kind FROM projection_gaps WHERE owner_id='segment-upgraded'").get()).toEqual({ owner_kind: "turn_card" });
    context.close();
  });
  it("isolates a poisoned Turn Card lane while a later lane delivers", () => {
    const store = new SqliteBindingStore(":memory:"); const now = new Date().toISOString();
    for (const id of ["a", "b"]) {
      store.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES(?,?,?,?,1,'traex','x','working',1,?,?,?)").run(id, `lane:${id}`, "primary", id, `root-${id}`, now, now);
      store.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,element_id,state,sequence,created_at,updated_at) VALUES(?,?,0,?,'creating',0,?,?)").run(`${id}:page:0`, id, `turn-card:${id}:page:0`, now, now);
      store.database.prepare("INSERT INTO outbound_replies(id,idempotency_key,kind,root_message_id,payload,state,next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,scope_kind,scope_key,scope_workspace_id,scope_pane_id,delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation) VALUES(?,?, 'card_reply',?,'{}','pending',?,?,?, ?,?,1,'pane','[\"pane\",\"workspace\",\"pane\"]','workspace','pane','primary',?,1,1)").run(`reply-${id}`, `segment:${id}:page:0:create`, `root-${id}`, now, now, now, `turn-card:${id}:page:0`, `turn-card:${id}:page:0`, id);
    }
    store.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,element_id,state,sequence,created_at,updated_at) VALUES('a:page:1','a',1,'turn-card:a:page:1','frozen',1,?,?)").run(now, now);
    store.database.prepare("UPDATE conversation_segment_pages SET element_id='turn-card:a:page:99' WHERE segment_id='a'").run();
    expect(store.markOutboundReplyDelivered("reply-a", "message-a", "card-a")).toBe(true);
    expect(store.markOutboundReplyDelivered("reply-b", "message-b", "card-b")).toBe(true);
    store.database.prepare("UPDATE conversation_segment_pages SET message_id='message-b', card_id='card-b', state='active' WHERE segment_id='b' AND page_index=0").run();
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE owner_id='a'").get()).toEqual({ count: 1 });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbox_lane_quarantines WHERE lane_key='turn-card:a:page:0' AND state='active'").get()).toEqual({ count: 1 });
    expect(store.database.prepare("SELECT message_id, state FROM conversation_segment_pages WHERE segment_id='b'").get()).toEqual({ message_id: "message-b", state: "active" });
    expect(store.getOperationalSummary().turnCards.quarantined).toBe(1);
    store.close();
  });
  it("counts only the latest actionable Turn Card page", () => {
    const store = new SqliteBindingStore(":memory:"); const now = new Date().toISOString();
    store.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES('latest','lane:latest','primary','latest',1,'traex','x','working',1,'root',?,?)").run(now, now);
    store.database.prepare("INSERT INTO conversation_segment_items(segment_id,item_id,lane_sequence,item_ordinal,item_json) VALUES('latest','item',1,0,'{}')").run();
    store.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_cursor_json,created_at,updated_at) VALUES('latest:page:0','latest',0,'m0','c0','turn-card:latest:page:0','frozen',1,'{\"itemIndex\":1}',?,?)").run(now, now);
    store.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_cursor_json,created_at,updated_at) VALUES('latest:page:1','latest',1,'m1','c1','turn-card:latest:page:1','active',1,'{\"itemIndex\":1}',?,?)").run(now, now);
    expect(store.getOperationalSummary().projectionDeliveryRecovery.byProjection.turnCard).toBe(0);
    expect(store.getOperationalSummary().turnCards.pagesAwaitingUpdate).toBe(0);
    store.database.prepare("UPDATE conversation_segment_pages SET delivered_cursor_json='{\"itemIndex\":0}' WHERE id='latest:page:1'").run();
    expect(store.getOperationalSummary().turnCards.pagesAwaitingUpdate).toBe(1);
    store.database.prepare("UPDATE conversation_segment_pages SET delivered_cursor_json='{\"itemIndex\":1}' WHERE id='latest:page:1'").run();
    store.database.prepare("UPDATE conversation_segments SET view_version=2 WHERE id='latest'").run();
    expect(store.getOperationalSummary().projectionDeliveryRecovery.byProjection.turnCard).toBe(1);
    store.close();
  });
  it("recovers an acknowledged frozen page after an in-place revision", () => {
    const store = new SqliteBindingStore(":memory:"); const now = new Date().toISOString();
    store.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES('frozen','lane:frozen','primary','frozen',1,'traex','x','closed',3,'root',?,?)").run(now, now);
    store.database.prepare("INSERT INTO conversation_segment_items(segment_id,item_id,lane_sequence,item_ordinal,item_json) VALUES('frozen','tool',7,0,'{}')").run();
    store.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_cursor_json,created_at,updated_at) VALUES('frozen:page:0','frozen',0,'m','c','turn-card:frozen:page:0','frozen',3,'{\"itemIndex\":1}',?,?)").run(now, now);
    expect(store.getOperationalSummary().projectionDeliveryRecovery.byProjection.turnCard).toBe(0);
    store.database.prepare("UPDATE conversation_segments SET view_version=4 WHERE id='frozen'").run();
    expect(store.getOperationalSummary().projectionDeliveryRecovery.byProjection.turnCard).toBe(1);
    store.close();
  });
  it("rebuilds a rejected Turn Card root under a new identity with current Agent activity", () => {
    const store = new SqliteBindingStore(":memory:"); const now = new Date().toISOString();
    store.createPendingBinding({ id: "dead", gatewayId: "feishu:primary", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "binding-root", title: "Primary" });
    store.updateBinding("dead", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    store.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES('dead','lane:dead','primary','dead',1,'traex','x','working',4,'root',?,?)").run(now, now);
    store.database.prepare("INSERT INTO conversation_segment_items(segment_id,item_id,lane_sequence,item_ordinal,item_json) VALUES('dead','agent:reviewer',2,0,?)")
      .run(JSON.stringify({ kind: "status", id: "agent:reviewer", sequence: 2, canonicalPosition: { laneSequence: 2, itemOrdinal: 0 }, label: "🤖 Agent · reviewer · GPT-5.6-Sol", detail: "Inspecting the projection.", state: "running" }));
    store.database.prepare("INSERT INTO outbound_replies(id,gateway_id,idempotency_key,binding_id,kind,target_role,root_message_id,payload,state,failure_class,effect_certainty,dead_lettered_at,next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,view_version,scope_kind,scope_key,scope_workspace_id,scope_pane_id,delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation) VALUES('reply-dead','feishu:primary','segment:dead:page:0:create','dead','card_reply','operation_result','root','{\"stale\":true}','dead_letter','permanent','rejected',?,?,?, ?, 'gateway:feishu:primary:turn-card:dead:page:0','turn-card:dead:page:0',1,1,'pane','[\"pane\",\"workspace\",\"pane\"]','workspace','pane','primary','dead',1,1)").run(now, now, now, now);
    store.database.prepare("INSERT INTO delivery_recoveries(failed_reply_id,snapshot_revision,state,failure_class,reason,action,created_at,updated_at) VALUES('reply-dead',1,'unresolved','permanent','rejected','blocked',?,?)").run(now, now);
    store.database.prepare("INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at) VALUES('gateway:feishu:primary:turn-card:dead:page:0','reply-dead','immutable','permanent','active','blocked','bad',?,?)").run(now, now);
    store.enqueueOutboundReply({ id: "dependent", idempotencyKey: "dependent", bindingId: "dead", rootMessageId: "root", kind: "text", payload: "later" });
    store.preparedDeliveries.addPrerequisite({ dependentReplyId: "dependent", prerequisiteReplyId: "reply-dead", requiredState: "delivered" });
    store.recoverStaleOutboxQuarantines();
    expect(store.getOutboundReply("reply-dead")).toMatchObject({ state: "dismissed" });
    const successor = store.database.prepare("SELECT * FROM outbound_replies WHERE projection_key='turn-card:dead:page:0' AND id != 'reply-dead'").get() as Record<string, unknown>;
    expect(successor).toMatchObject({
      id: "turn-card:dead:page:0:recovery:1:create", idempotency_key: "turn-card:dead:page:0:recovery:1:create",
      gateway_id: "feishu:primary", binding_id: "dead", state: "pending", root_message_id: "root",
      snapshot_revision: 4, view_version: 4, scope_kind: "pane", scope_workspace_id: "workspace", scope_pane_id: "pane",
      delivery_owner_kind: "primary", delivery_owner_id: "dead", delivery_owner_generation: 1, delivery_owner_session_generation: 1
    });
    expect(successor.id).not.toBe("reply-dead");
    expect(String(successor.payload)).toContain("🤖 Agent · reviewer · GPT-5.6-Sol");
    expect(String(successor.payload)).toContain("Inspecting the projection.");
    expect(store.database.prepare("SELECT page_index,state,pending_reply_id FROM conversation_segment_pages WHERE segment_id='dead'").get()).toEqual({ page_index: 0, state: "creating", pending_reply_id: successor.id });
    expect(store.database.prepare("SELECT state,action,replacement_reply_id FROM delivery_recoveries WHERE failed_reply_id='reply-dead'").get()).toEqual({ state: "replacement_pending", action: "rebuild_turn_card_root", replacement_reply_id: successor.id });
    expect(store.database.prepare("SELECT prerequisite_reply_id,required_state FROM outbound_reply_prerequisites WHERE dependent_reply_id='dependent'").get()).toEqual({
      prerequisite_reply_id: successor.id, required_state: "delivered"
    });
    expect(store.capabilityModules().conversationSegments.reserveSnapshot({
      segmentId: "dead", pageIndex: 0, messageId: null, elementId: "turn-card:dead:page:0",
      card: { schema: "2.0" }, cursor: null, viewVersion: 4
    })).toBe("waiting");
    store.recoverStaleOutboxQuarantines();
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key='turn-card:dead:page:0'").get()).toEqual({ count: 2 });
    expect(store.database.prepare("SELECT state FROM outbox_lane_quarantines WHERE lane_key='gateway:feishu:primary:turn-card:dead:page:0'").get()).toEqual({ state: "released" });
    expect(store.checkpointOutboundReplyCard(String(successor.id), "card-recovered")).toMatchObject({ cardIdCheckpoint: "card-recovered" });
    expect(store.markOutboundReplyDelivered(String(successor.id), "message-recovered", "card-recovered")).toBe(true);
    expect(store.database.prepare("SELECT state,resolved_by_reply_id,resolved_message_id FROM delivery_recoveries WHERE failed_reply_id='reply-dead'").get()).toEqual({ state: "recovered", resolved_by_reply_id: successor.id, resolved_message_id: "message-recovered" });
    expect(store.capabilityModules().conversationSegments.checkpointPage({ segmentId: "dead", pageIndex: 0, replyId: String(successor.id), messageId: "message-recovered", cardId: "card-recovered" })).toBe("checkpointed");
    expect(store.database.prepare("SELECT message_id,card_id,state,pending_reply_id FROM conversation_segment_pages WHERE segment_id='dead'").get()).toEqual({ message_id: "message-recovered", card_id: "card-recovered", state: "active", pending_reply_id: null });
    store.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES('uncertain','lane:uncertain','primary','uncertain',1,'traex','x','working',1,'root-u',?,?)").run(now, now);
    store.database.prepare("INSERT INTO outbound_replies(id,idempotency_key,kind,root_message_id,payload,state,failure_class,effect_certainty,dead_lettered_at,next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,scope_kind,scope_key,scope_workspace_id,scope_pane_id,delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation) VALUES('reply-u','segment:uncertain:page:0:create','card_reply','root-u','{}','dead_letter','unknown','uncertain',?,?,?, ?, 'turn-card:uncertain:page:0','turn-card:uncertain:page:0',1,'pane','[\"pane\",\"workspace\",\"pane\"]','workspace','pane','primary','uncertain',1,1)").run(now, now, now, now);
    store.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,element_id,state,sequence,pending_reply_id,created_at,updated_at) VALUES('uncertain:page:0','uncertain',0,'turn-card:uncertain:page:0','creating',0,'reply-u',?,?)").run(now, now);
    store.recoverStaleOutboxQuarantines();
    expect(store.getOutboundReply("reply-u")).toMatchObject({ state: "dead_letter", effectCertainty: "uncertain" });
    store.close();
  });
  it("recovers eligible Turn Card dead letters through the live bounded poll", () => {
    const store = new SqliteBindingStore(":memory:"); const now = new Date().toISOString(); const later = new Date(Date.now() + 60_000).toISOString();
    store.createPendingBinding({ id: "live", gatewayId: "feishu:primary", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "binding-root", title: "Primary" });
    store.updateBinding("live", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    store.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES('live','lane:live','primary','live',1,'traex','x','working',1,'root-l',?,?)").run(now, now);
    store.database.prepare("INSERT INTO outbound_replies(id,gateway_id,idempotency_key,binding_id,kind,target_role,root_message_id,payload,state,failure_class,effect_certainty,dead_lettered_at,next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,view_version,scope_kind,scope_key,scope_workspace_id,scope_pane_id,delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation) VALUES('reply-live','feishu:primary','segment:live:page:0:create','live','card_reply','operation_result','root-l','{\"stable\":2}','dead_letter','permanent','rejected',?,?,?, ?, 'gateway:feishu:primary:turn-card:live:page:0','turn-card:live:page:0',1,1,'pane','[\"pane\",\"workspace\",\"pane\"]','workspace','pane','primary','live',1,1)").run(later, later, now, now);
    store.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,element_id,state,sequence,pending_reply_id,created_at,updated_at) VALUES('live:page:0','live',0,'turn-card:live:page:0','creating',0,'reply-live',?,?)").run(now, now);
    store.database.prepare("INSERT INTO delivery_recoveries(failed_reply_id,snapshot_revision,state,failure_class,reason,action,created_at,updated_at) VALUES('reply-live',1,'unresolved','permanent','rejected','blocked',?,?)").run(now, now);
    store.database.prepare("INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at) VALUES('gateway:feishu:primary:turn-card:live:page:0','reply-live','immutable','permanent','active','blocked','bad',?,?)").run(now, now);
    const older = new Date(Date.now() - 30_000).toISOString();
    store.database.prepare("INSERT INTO outbound_replies(id,idempotency_key,kind,root_message_id,payload,state,failure_class,effect_certainty,dead_lettered_at,next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,attempt_count,scope_kind,scope_key) VALUES('reply-generic','generic','card_reply','root-g','{}','dead_letter','transient','not-started',?,?,?, ?, 'generic-lane',NULL,1,5,'global','[\"global\"]')").run(older, older, older, older);
    expect(store.recoverEligibleDeadLetters(new Date(Date.now() - 60_000).toISOString(), 1)).toEqual([]);
    const generic = store.recoverEligibleDeadLetters(later, 1);
    expect(generic[0]).toMatchObject({ id: "reply-generic", state: "pending" });
    const recovered = store.recoverEligibleDeadLetters(later, 1);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id: "turn-card:live:page:0:recovery:1:create", state: "pending", idempotencyKey: "turn-card:live:page:0:recovery:1:create" });
    expect(store.database.prepare("SELECT state FROM outbox_lane_quarantines WHERE lane_key='gateway:feishu:primary:turn-card:live:page:0'").get()).toEqual({ state: "released" });
    expect(store.recoverEligibleDeadLetters(later, 1)).toEqual([]);
    store.close();
  });
  it("orders a Turn Card older than a generic dead letter in the shared limit", () => {
    const store = new SqliteBindingStore(":memory:"); const older = "2026-10-04T18:00:00.000Z"; const newer = "2026-10-04T18:01:00.000Z";
    const segmentId = "older:segment";
    store.createPendingBinding({ id: segmentId, gatewayId: "feishu:primary", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "binding-root", title: "Primary" });
    store.updateBinding(segmentId, { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    store.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES(?,?,?,?,1,'traex','x','working',1,?,?,?)").run(segmentId, `lane:${segmentId}`, "primary", segmentId, "root-turn", older, older);
    store.database.prepare("INSERT INTO outbound_replies(id,gateway_id,idempotency_key,binding_id,kind,target_role,root_message_id,payload,state,failure_class,effect_certainty,dead_lettered_at,next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,view_version,scope_kind,scope_key,scope_workspace_id,scope_pane_id,delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation) VALUES('reply-turn','feishu:primary','turn-card:older:create',?,'card_reply','operation_result','root-turn','{}','dead_letter','permanent','rejected',?,?,?,?,'gateway:feishu:primary:turn-card:older:segment:page:0','turn-card:older:segment:page:0',1,1,'pane','[\"pane\",\"workspace\",\"pane\"]','workspace','pane','primary','older:segment',1,1)").run(segmentId, older, older, older, older);
    store.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,element_id,state,sequence,pending_reply_id,created_at,updated_at) VALUES(?,?,0,?,'creating',0,?,?,?)").run(`${segmentId}:page:0`, segmentId, `turn-card:${segmentId}:page:0`, "reply-turn", older, older);
    store.database.prepare("INSERT INTO delivery_recoveries(failed_reply_id,snapshot_revision,state,failure_class,reason,action,created_at,updated_at) VALUES('reply-turn',1,'unresolved','permanent','rejected','blocked',?,?)").run(older, older);
    store.database.prepare("INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at) VALUES('gateway:feishu:primary:turn-card:older:segment:page:0','reply-turn','immutable','permanent','active','blocked','bad',?,?)").run(older, older);
    store.database.prepare("INSERT INTO outbound_replies(id,idempotency_key,kind,root_message_id,payload,state,failure_class,effect_certainty,dead_lettered_at,next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,scope_kind,scope_key) VALUES('reply-generic','generic:newer','card_reply','root-g','{}','dead_letter','transient','not-started',?,?,?,?,'generic-lane',NULL,1,'global','[\"global\"]')").run(newer, newer, newer, newer);
    const recovered = store.recoverEligibleDeadLetters("2026-10-04T19:00:00.000Z", 1);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id: "turn-card:older:segment:page:0:recovery:1:create", state: "pending" });
    expect(store.getOutboundReply("reply-generic")).toMatchObject({ state: "dead_letter" });
    store.close();
  });
  it("orders equal timestamps by delivery order and then id", () => {
    const store = new SqliteBindingStore(":memory:"); const timestamp = "2026-10-04T18:00:00.000Z";
    const insert = store.database.prepare("INSERT INTO outbound_replies(id,idempotency_key,kind,root_message_id,payload,state,failure_class,effect_certainty,dead_lettered_at,next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,scope_kind,scope_key) VALUES(?,?, 'card_reply',?,'{}','dead_letter','transient','not-started',?,?,?,?,? ,NULL,1,'global','[\"global\"]')");
    insert.run("reply-z", "z", "root-z", timestamp, timestamp, timestamp, timestamp, "lane-z");
    insert.run("reply-b", "b", "root-b", timestamp, timestamp, timestamp, timestamp, "lane-b");
    insert.run("reply-a", "a", "root-a", timestamp, timestamp, timestamp, timestamp, "lane-a");
    // Production delivery_order values are unique; remove that invariant in this
    // in-memory regression so the final id tie-breaker is exercised explicitly.
    store.database.exec("DROP TRIGGER outbound_replies_assign_delivery_order; DROP INDEX outbound_replies_delivery_order;");
    store.database.prepare("UPDATE outbound_replies SET delivery_order=1 WHERE id IN ('reply-a','reply-b')").run();
    store.database.prepare("UPDATE outbound_replies SET delivery_order=2 WHERE id='reply-z'").run();
    const recovered = store.recoverEligibleDeadLetters("2026-10-04T19:00:00.000Z", 3);
    expect(recovered.map((reply) => reply.id)).toEqual(["reply-a", "reply-b", "reply-z"]);
    store.close();
  });
  it("excludes an oldest malformed Turn Card target before the shared limit", () => {
    const store = new SqliteBindingStore(":memory:"); const oldest = "2026-10-04T18:00:00.000Z"; const valid = "2026-10-04T18:01:00.000Z";
    store.database.prepare("INSERT INTO outbound_replies(id,idempotency_key,kind,root_message_id,payload,state,failure_class,effect_certainty,dead_lettered_at,next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,scope_kind,scope_key) VALUES('reply-malformed','malformed','card_reply','root-bad','{}','dead_letter','transient','not-started',?,?,?,?,'bad-lane','turn-card:bad:page:0',1,'global','[\"global\"]')").run(oldest, oldest, oldest, oldest);
    store.database.prepare("INSERT INTO outbound_replies(id,idempotency_key,kind,root_message_id,payload,state,failure_class,effect_certainty,dead_lettered_at,next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,scope_kind,scope_key) VALUES('reply-valid','valid','card_reply','root-valid','{}','dead_letter','transient','not-started',?,?,?,?,'valid-lane',NULL,1,'global','[\"global\"]')").run(valid, valid, valid, valid);
    const recovered = store.recoverEligibleDeadLetters("2026-10-04T19:00:00.000Z", 1);
    expect(recovered).toHaveLength(1);
    expect(recovered[0]).toMatchObject({ id: "reply-valid", state: "pending" });
    expect(store.getOutboundReply("reply-malformed")).toMatchObject({ state: "dead_letter" });
    store.close();
  });
  it("persists a segment page and reloads it after reopening", () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-card-")); const path = join(dir, "bridge.sqlite");
    const context = new SqliteContext(path); new SqliteMigrations(context).run();
    const store = conversationStoreWithOutbox(context);
    store.admitLegacyPending({ segmentId: "segment-1", submissionId: "submission-1", producerKey: "lane:primary", owner: { kind: "primary", id: "binding-1", generation: 1 }, agentKind: "traex", expectedSessionId: null, requestText: "hello", rootMessageId: "root", card: {}, occurredAt: new Date().toISOString() });
    expect(store.getActivePage("segment-1")?.pageIndex).toBe(0);
    expect(store.listConversationSegmentPages("segment-1")).toHaveLength(1);
    const replyId = store.listConversationSegmentPages("segment-1")[0]!.pendingReplyId!;
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='m1',card_id_checkpoint='c1' WHERE id=?").run(replyId);
    expect(store.checkpointPage({ segmentId: "segment-1", pageIndex: 0, replyId, messageId: "m1", cardId: "c1" })).toBe("checkpointed");
    expect(store.checkpointPage({ segmentId: "segment-1", pageIndex: 0, replyId, messageId: "m2", cardId: "c2" })).toBe("stale");
    context.close();
    const reopened = new SqliteContext(path); new SqliteMigrations(reopened).run();
    const restored = new SqliteConversationSegmentStore(reopened);
    expect(restored.listConversationSegmentPages("segment-1")[0]).toMatchObject({ messageId: "m1", cardId: "c1", state: "active" });
    reopened.close(); rmSync(dir, { recursive: true, force: true });
  });

  it("keeps Subagent lifecycle out of Primary and Worker Answer timelines without mutating a frozen page", () => {
    const directory = mkdtempSync(join(tmpdir(), "turn-card-activity-")); const path = join(directory, "bridge.sqlite");
    const harness = new SqliteBindingStore(path);
    harness.createPendingBinding({
      id: "binding", gatewayId: "feishu:activity", projectId: "project", workspaceId: "workspace-primary",
      chatId: "chat", topicId: "topic", rootMessageId: "primary-root", title: "Primary"
    });
    harness.createAgentInstance({
      id: "worker", projectId: "project", name: "worker", role: "worker", agentKind: "traex", model: null,
      parent: { bindingId: "binding", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
      desiredState: "running", workspace: { id: "workspace-worker", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    });
    const store = harness.capabilityModules().conversationSegments;
    const coreEvents = harness.capabilityModules().coreEvents;
    const now = "2026-10-07T00:00:00.000Z";

    for (const owner of [{ kind: "primary" as const, id: "binding", lane: "primary" }, { kind: "worker" as const, id: "worker", lane: "worker" }]) {
      const segmentId = `${owner.kind}-activity`;
      harness.database.prepare(`INSERT INTO conversation_segments(
        id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,
        start_lane_sequence,start_item_ordinal,state,view_version,root_message_id,created_at,updated_at
      ) VALUES(?,?,?,?,1,'traex',?,'inspect activity',1,0,'working',1,?,?,?)`).run(
        segmentId, `lane:${owner.lane}`, owner.kind, owner.id, `${owner.kind}-session`, `${owner.kind}-root`, now, now
      );
      harness.database.prepare(`INSERT INTO conversation_segment_pages(
        id,segment_id,page_index,element_id,state,sequence,created_at,updated_at
      ) VALUES(?,?,0,?,'frozen',1,?,?)`).run(`${segmentId}:page:0`, segmentId, `turn-card:${segmentId}:page:0`, now, now);
      const frozenBefore = store.listConversationSegmentPages(segmentId)[0];
      const payloads = [
        { type: "model_changed", model: "GPT-5.6-Sol" },
        { type: "context_compacted", summary: "private summary" },
        { type: "agent_activity", agent_id: "reviewer", state: "started", model: "GPT-5.6-Sol", content: "Inspecting the projection.", content_truncated: false },
        { type: "agent_activity", agent_id: "reviewer", state: "completed", model: "GPT-5.6-Sol" }
      ];
      let afterCursor = "start";
      payloads.forEach((payload, index) => {
        const event = toCoreEventEnvelope(parseHerdrAgentEvent({
          ...agentEvent(`${owner.lane}:${index + 2}`, `${owner.kind}-turn`, `2026-10-07T00:00:0${index + 1}.000Z`, payload),
          source_id: owner.lane,
          session_id: `${owner.kind}-session`
        }));
        expect(coreEvents.ingestBatch({
          laneId: owner.lane, sourceId: owner.lane, agentKind: "traex", sessionId: `${owner.kind}-session`,
          afterCursor, nextCursor: event.cursor, latestCursor: event.cursor, events: [event], ingestedAt: event.occurredAt
        })).toBe("accepted");
        afterCursor = event.cursor;
      });
      expect(store.listConversationSegmentPages(segmentId)[0]).toEqual(frozenBefore);
      const view = store.loadCardView(segmentId)!;
      expect(view).toMatchObject({ ownerKind: owner.kind, model: "GPT-5.6-Sol" });
      const rendered = JSON.stringify(renderTurnCard(view));
      expect(rendered).toContain("Model: GPT-5.6-Sol");
      expect(rendered).toContain("🧠 Model · GPT-5.6-Sol");
      expect(rendered).toContain("🗜️ Context compacted");
      expect(rendered).not.toContain("🤖 Agent · reviewer · GPT-5.6-Sol");
      expect(rendered).not.toContain("Inspecting the projection.");
      expect(rendered).not.toContain("private summary");
    }

    const inactive = toCoreEventEnvelope(parseHerdrAgentEvent({
      ...agentEvent("inactive:1", "inactive-turn", now, { type: "context_compacted", summary: "private inactive summary" }),
      source_id: "inactive",
      session_id: "inactive-session"
    }));
    expect(coreEvents.ingestBatch({
      laneId: "inactive", sourceId: "inactive", agentKind: "traex", sessionId: "inactive-session",
      afterCursor: "start", nextCursor: inactive.cursor, latestCursor: inactive.cursor, events: [inactive], ingestedAt: now
    })).toBe("accepted");
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM core_event_inbox WHERE event_id=?").get(inactive.eventId)).toEqual({ count: 1 });
    expect(harness.database.prepare("SELECT COUNT(*) AS count FROM conversation_segments WHERE producer_key='lane:inactive'").get()).toEqual({ count: 0 });

    harness.close();
    const reopened = new SqliteBindingStore(path); const restored = reopened.capabilityModules().conversationSegments;
    expect(restored.loadCardView("primary-activity")).toMatchObject({ ownerKind: "primary", model: "GPT-5.6-Sol" });
    expect(restored.loadCardView("worker-activity")).toMatchObject({ ownerKind: "worker", model: "GPT-5.6-Sol" });
    expect(JSON.stringify(renderTurnCard(restored.loadCardView("primary-activity")!))).not.toContain("Inspecting the projection.");
    expect(JSON.stringify(renderTurnCard(restored.loadCardView("worker-activity")!))).not.toContain("Inspecting the projection.");
    reopened.close(); rmSync(directory, { recursive: true, force: true });
  });

  it("routes canonical Turn Card updates independently of legacy Primary Answer identity", () => {
    const bundle = createTestStoreBundle(); const store = bundle.driver; const segments = store.capabilityModules().conversationSegments; const now = new Date().toISOString();
    connectPreparedBundle(bundle);
    store.createPendingBinding({ id: "binding", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "binding" });
    store.updateBinding("binding", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    store.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES('turn-delivery','lane:turn-delivery','primary','binding',1,'traex','hello','working',2,'human-root',?,?)").run(now, now);
    store.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,message_id,element_id,state,sequence,delivered_sequence,created_at,updated_at) VALUES('turn-delivery:page:0','turn-delivery',0,'turn-message','turn-card:turn-delivery:page:0','active',1,1,?,?)").run(now, now);
    expect(segments.reserveSnapshot({ segmentId: "turn-delivery", pageIndex: 0, messageId: "turn-message", elementId: "turn-card:turn-delivery:page:0", card: { schema: "2.0" }, cursor: { itemIndex: 1, markdownOffset: 1 }, viewVersion: 2 })).toBe("reserved");
    const currentReplyId = segments.listConversationSegmentPages("turn-delivery")[0]!.pendingReplyId!;
    const currentReply = store.getOutboundReply(currentReplyId)!;
    expect(prepareOutboundGatewayIntent(store, currentReply).intent).toMatchObject({
      kind: "surface.replace", purpose: "operation-result", messageId: "turn-message"
    });
    expect(currentReply).toMatchObject({ cardRole: null, targetRole: "operation_result" });

    store.database.prepare("INSERT INTO outbound_replies(id,idempotency_key,root_message_id,kind,card_role,payload,state,next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,scope_kind,scope_key) VALUES('legacy-turn-update','legacy-turn-update','turn-message','card_update','answer','{\"schema\":\"2.0\"}','pending',?,?,?,'turn-card:legacy:page:0','turn-card:legacy:page:0',3,'global','[\"global\"]')").run(now, now, now);
    expect(prepareOutboundGatewayIntent(store, store.getOutboundReply("legacy-turn-update")!).intent).toMatchObject({
      kind: "surface.replace", purpose: "operation-result", messageId: "turn-message"
    });

    store.database.prepare("INSERT INTO outbound_replies(id,idempotency_key,root_message_id,kind,card_role,payload,state,next_attempt_at,created_at,updated_at,lane_key,snapshot_revision,scope_kind,scope_key) VALUES('malformed-answer-update','malformed-answer-update','answer-message','card_update','answer','{\"schema\":\"2.0\"}','pending',?,?,?,'answer-lane',1,'global','[\"global\"]')").run(now, now, now);
    expect(() => prepareOutboundGatewayIntent(store, store.getOutboundReply("malformed-answer-update")!)).toThrow("Answer card target is missing binding or prompt identity");
    store.close();
  });

  it("adopts an exactly linked delivered message-only create after restart without replying again", async () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-card-delivered-create-")); const path = join(dir, "bridge.sqlite");
    const timestamp = "2026-10-04T20:00:00.000Z";
    const context = new SqliteContext(path); new SqliteMigrations(context).run();
    context.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,submission_id,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES('restart-segment','lane:restart','primary','binding',1,'submission','traex','hello','working',2,'root',?,?)").run(timestamp, timestamp);
    context.database.prepare("INSERT INTO outbound_replies(id,idempotency_key,root_message_id,kind,card_role,payload,state,delivered_message_id,next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,scope_kind,scope_key) VALUES('restart-create','segment:restart-segment:page:0:create','root','card_reply','answer','{}','delivered','message-created',?,?,?,'turn-card:restart-segment:page:0','turn-card:restart-segment:page:0',1,'global','[\"global\"]')").run(timestamp, timestamp, timestamp);
    context.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,element_id,state,sequence,pending_reply_id,created_at,updated_at) VALUES('restart-segment:page:0','restart-segment',0,'turn-card:restart-segment:page:0','creating',0,'restart-create',?,?)").run(timestamp, timestamp);
    context.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,submission_id,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES('restart-surface','lane:surface','primary','binding',1,'submission-surface','traex','hello','working',2,'root-surface',?,?)").run(timestamp, timestamp);
    context.database.prepare("INSERT INTO outbound_replies(id,idempotency_key,root_message_id,kind,card_role,payload,state,delivered_message_id,card_id_checkpoint,next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,scope_kind,scope_key) VALUES('surface-create','segment:restart-surface:page:0:create','root-surface','card_reply','answer','{}','delivered','message-surface','surface-1',?,?,?,'turn-card:restart-surface:page:0','turn-card:restart-surface:page:0',1,'global','[\"global\"]')").run(timestamp, timestamp, timestamp);
    context.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,element_id,state,sequence,pending_reply_id,created_at,updated_at) VALUES('restart-surface:page:0','restart-surface',0,'turn-card:restart-surface:page:0','creating',0,'surface-create',?,?)").run(timestamp, timestamp);
    context.close();

    const reopened = new SqliteContext(path); new SqliteMigrations(reopened).run();
    const restored = conversationStoreWithOutbox(reopened);
    const workflow = new TurnCardWorkflow(restored, () => undefined, { turnCardPage: () => ({ card: { schema: "2.0" }, items: [], nextCursor: null }) });
    await workflow.converge("restart-segment");
    await workflow.converge("restart-surface");

    expect(restored.listConversationSegmentPages("restart-segment")[0]).toMatchObject({ messageId: "message-created", cardId: null, state: "active" });
    expect(restored.listConversationSegmentPages("restart-surface")[0]).toMatchObject({ messageId: "message-surface", cardId: "surface-1", state: "active" });
    expect(reopened.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE kind='card_reply' AND projection_key='turn-card:restart-segment:page:0'").get()).toEqual({ count: 1 });
    expect(reopened.database.prepare("SELECT kind FROM outbound_replies WHERE kind='card_update' ORDER BY delivery_order").all()).toEqual([{ kind: "card_update" }, { kind: "card_update" }]);
    reopened.close(); rmSync(dir, { recursive: true, force: true });
  });

  it("fails closed on a conflicting delivered create link without emitting a replacement", async () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run(); const timestamp = "2026-10-04T20:00:00.000Z";
    context.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,submission_id,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES('conflict','lane:conflict','primary','binding',1,'submission-conflict','traex','hello','working',2,'root',?,?)").run(timestamp, timestamp);
    context.database.prepare("INSERT INTO outbound_replies(id,idempotency_key,root_message_id,kind,card_role,payload,state,delivered_message_id,next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,scope_kind,scope_key) VALUES('conflict-create','segment:conflict:page:0:create','root','card_reply','answer','{}','delivered','message-created',?,?,?,'turn-card:conflict:page:0','turn-card:another:page:0',1,'global','[\"global\"]')").run(timestamp, timestamp, timestamp);
    context.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,element_id,state,sequence,pending_reply_id,created_at,updated_at) VALUES('conflict:page:0','conflict',0,'turn-card:conflict:page:0','creating',0,'conflict-create',?,?)").run(timestamp, timestamp);
    context.database.prepare("INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,submission_id,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at) VALUES('missing','lane:missing','primary','binding',1,'submission-missing','traex','hello','working',2,'root',?,?)").run(timestamp, timestamp);
    context.database.prepare("INSERT INTO outbound_replies(id,idempotency_key,root_message_id,kind,card_role,payload,state,delivered_message_id,next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,scope_kind,scope_key) VALUES('unlinked-create','segment:missing:page:0:create','root','card_reply','answer','{}','delivered','message-unlinked',?,?,?,'turn-card:missing:page:0','turn-card:missing:page:0',1,'global','[\"global\"]')").run(timestamp, timestamp, timestamp);
    context.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,element_id,state,sequence,created_at,updated_at) VALUES('missing:page:0','missing',0,'turn-card:missing:page:0','creating',0,?,?)").run(timestamp, timestamp);
    const store = conversationStoreWithOutbox(context);
    const replyCount = context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get();
    const workflow = new TurnCardWorkflow(store, () => undefined, { turnCardPage: () => ({ card: { schema: "2.0" }, items: [], nextCursor: null }) });
    await workflow.converge("conflict");
    await workflow.converge("conflict");
    await workflow.converge("missing");

    expect(store.listConversationSegmentPages("conflict")[0]).toMatchObject({ messageId: null, state: "creating", pendingReplyId: "conflict-create" });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual(replyCount);
    expect(context.database.prepare("SELECT failure_code,occurrence_count FROM projection_gaps WHERE owner_kind='turn_card' AND owner_id='conflict'").get()).toEqual({ failure_code: "pending_reply_link_mismatch", occurrence_count: 2 });
    expect(context.database.prepare("SELECT failure_code FROM projection_gaps WHERE owner_kind='turn_card' AND owner_id='missing'").get()).toEqual({ failure_code: "missing_initial_create_link" });
    context.close();
  });

  it("keeps an unmatched canonical Human segment non-actionable without an exact reply route", async () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run(); const store = conversationStoreWithOutbox(context);
    const occurredAt = new Date().toISOString();
    const result = store.projectCanonicalEvent({ laneId: "direct", laneSequence: 1, observedAt: occurredAt, event: { schemaVersion: 1, eventId: "direct-human", cursor: "cursor", sourceId: "core", agentKind: "traex", sessionId: "session", turnId: "turn", occurredAt, payload: { type: "human_message", message_id: "human", submission_id: "unmatched-submission", text: "direct" } } });
    const workflow = new TurnCardWorkflow(store, () => undefined, { turnCardPage: () => ({ card: { schema: "2.0" }, items: [], nextCursor: null }) });
    await workflow.converge(result.segmentId!);
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 0 });
    expect(store.listConversationSegmentPages(result.segmentId!)).toEqual([]);
    expect(store.listActionableConversationSegmentIds()).not.toContain(result.segmentId);
    expect(context.database.prepare("SELECT stage,owner_kind,owner_id,source_item_id,failure_code FROM projection_gaps WHERE owner_kind='turn_card' AND owner_id=?").get(result.segmentId)).toEqual({
      stage: "turn_recovery", owner_kind: "turn_card", owner_id: result.segmentId,
      source_item_id: `turn-card:${result.segmentId}:page:0`, failure_code: "missing_initial_reply_route"
    });
    context.close();
  });

  it("uses the ordinary message target for update, finish, and continuation without a surface id", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run(); const store = conversationStoreWithOutbox(context);
    const admit = (segmentId: string) => {
      store.admitLegacyPending({ segmentId, submissionId: `submission-${segmentId}`, producerKey: `lane:${segmentId}`, owner: { kind: "primary", id: "binding", generation: 1 }, agentKind: "traex", expectedSessionId: "session", requestText: "hello", rootMessageId: "root", card: {}, occurredAt: new Date().toISOString() });
      const replyId = store.listConversationSegmentPages(segmentId)[0]!.pendingReplyId!;
      context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id=? WHERE id=?").run(`message-${segmentId}`, replyId);
      expect(store.checkpointPage({ segmentId, pageIndex: 0, replyId, messageId: `message-${segmentId}`, cardId: null })).toBe("checkpointed");
    };

    admit("ordinary-update");
    expect(store.reserveSnapshot({ segmentId: "ordinary-update", pageIndex: 0, messageId: "message-ordinary-update", elementId: "turn-card:ordinary-update:page:0", card: {}, cursor: null, viewVersion: 2 })).toBe("reserved");
    const updateReply = store.listConversationSegmentPages("ordinary-update")[0]!.pendingReplyId!;
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='message-ordinary-update' WHERE id=?").run(updateReply);
    expect(store.checkpointPage({ segmentId: "ordinary-update", pageIndex: 0, replyId: updateReply, messageId: "message-ordinary-update", cardId: null })).toBe("checkpointed");
    expect(store.reserveContinuation({ segmentId: "ordinary-update", pageIndex: 0, messageId: "message-ordinary-update", card: {}, nextPageIndex: 1, nextElementId: "turn-card:ordinary-update:page:1", nextStartCursor: { itemIndex: 1, markdownOffset: 0 } })).toBe("reserved");
    const continuationReply = store.listConversationSegmentPages("ordinary-update")[1]!.pendingReplyId!;
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='message-continuation' WHERE id=?").run(continuationReply);
    expect(store.checkpointPage({ segmentId: "ordinary-update", pageIndex: 1, replyId: continuationReply, messageId: "message-continuation", cardId: null })).toBe("checkpointed");

    admit("ordinary-finish");
    expect(store.reserveFinish({ segmentId: "ordinary-finish", pageIndex: 0, messageId: "message-ordinary-finish", elementId: "turn-card:ordinary-finish:page:0", card: {}, summary: "Completed", cursor: { itemIndex: 0, markdownOffset: 0 } })).toBe("reserved");
    expect(store.listConversationSegmentPages("ordinary-update")).toEqual(expect.arrayContaining([expect.objectContaining({ pageIndex: 0, state: "frozen", cardId: null }), expect.objectContaining({ pageIndex: 1, state: "active", cardId: null, deliveredSequence: 1 })]));
    expect(store.listConversationSegmentPages("ordinary-finish")[0]).toMatchObject({ state: "finished", cardId: null });
    context.close();
  });

  it("does not recover content already delivered by a terminal continuation page", async () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run(); const store = conversationStoreWithOutbox(context);
    const now = "2026-10-11T12:21:46.000Z";
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,state,view_version,
      root_message_id,timeline_item_count,has_visible_assistant_content,created_at,updated_at
    ) VALUES('terminal-continuation','lane:terminal-continuation','primary','binding',1,'traex','session','continue','closed',3,
      'root',3,1,?,?)`).run(now, now);
    const insertItem = context.database.prepare(`INSERT INTO conversation_segment_items(
      segment_id,item_id,lane_sequence,item_ordinal,item_json
    ) VALUES('terminal-continuation',?,?,0,?)`);
    for (let index = 0; index < 3; index += 1) insertItem.run(
      `item-${index}`, index + 1,
      JSON.stringify({ kind: "agent_message", id: `item-${index}`, sequence: index + 1, markdown: `item ${index}`, canonicalPosition: { laneSequence: index + 1, itemOrdinal: 0 } })
    );
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,
      start_cursor_json,delivered_cursor_json,start_lane_sequence,start_item_ordinal,cursor_base,
      continuation_lane_sequence,continuation_item_ordinal,continuation_cursor_base,delivery_cohort,created_at,updated_at
    ) VALUES
      ('terminal-continuation:0','terminal-continuation',0,'page-one',NULL,'turn-card:terminal-continuation:page:0','frozen',2,2,
        NULL,'{"itemIndex":1,"markdownOffset":0}',NULL,NULL,0,2,0,1,'legacy',?,?),
      ('terminal-continuation:1','terminal-continuation',1,'page-two',NULL,'turn-card:terminal-continuation:page:1','active',1,1,
        '{"itemIndex":1,"markdownOffset":0}',NULL,2,0,1,NULL,NULL,NULL,'legacy',?,?)`).run(now, now, now, now);

    const workflow = new TurnCardWorkflow(store, () => undefined, {
      turnCardPage: (view) => ({
        card: { nodes: [{ slot: "turn-card:terminal-continuation:page:1", content: view.timelineItems.map(({ id }) => id) }] },
        items: view.timelineItems,
        nextCursor: null
      })
    });
    await workflow.converge("terminal-continuation");
    const finish = context.database.prepare(`SELECT id FROM outbound_replies
      WHERE projection_key='turn-card:terminal-continuation:page:1' AND kind='card_update' AND state='pending'`).get() as { id: string };
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='page-two' WHERE id=?").run(finish.id);
    expect(store.checkpointPage({ segmentId: "terminal-continuation", pageIndex: 1, replyId: finish.id, messageId: "page-two", cardId: null })).toBe("checkpointed");

    expect(store.listConversationSegmentPages("terminal-continuation")[1]).toMatchObject({
      state: "finished", deliveredCursor: { itemIndex: 3, markdownOffset: 0 }
    });
    expect(store.nextHistoricalPageRecovery("terminal-continuation")).toBeNull();
    context.close();
  });

  it("checkpoints a Completed freeze update before opening the next Turn Card page", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run(); const store = conversationStoreWithOutbox(context);
    const now = "2026-10-05T00:00:00.000Z";
    store.admitLegacyPending({ segmentId: "freeze-before-next", submissionId: "submission-freeze", producerKey: "lane:freeze", owner: { kind: "primary", id: "binding", generation: 1 }, agentKind: "traex", expectedSessionId: "session", requestText: "hello", rootMessageId: "root", card: {}, occurredAt: now });
    const createReply = store.listConversationSegmentPages("freeze-before-next")[0]!.pendingReplyId!;
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='message-freeze',card_id_checkpoint='card-freeze' WHERE id=?").run(createReply);
    expect(store.checkpointPage({ segmentId: "freeze-before-next", pageIndex: 0, replyId: createReply, messageId: "message-freeze", cardId: "card-freeze" })).toBe("checkpointed");
    const cursor = { itemIndex: 1, markdownOffset: 0 };

    expect(store.reserveFreeze({
      segmentId: "freeze-before-next", pageIndex: 0, messageId: "message-freeze", cardId: "card-freeze",
      elementId: "turn-card:freeze-before-next:page:0", card: { lifecycle: "completed" }, cursor
    })).toBe("reserved");
    const frozen = store.listConversationSegmentPages("freeze-before-next")[0]!;
    expect(frozen).toMatchObject({ state: "frozen", pendingCursor: cursor });
    expect(store.listConversationSegmentPages("freeze-before-next")).toHaveLength(1);
    const freezeReply = context.database.prepare("SELECT id,idempotency_key,kind,root_message_id,payload,state,snapshot_revision FROM outbound_replies WHERE id=?").get(frozen.pendingReplyId) as Record<string, unknown>;
    expect(freezeReply).toMatchObject({
      idempotency_key: "segment:freeze-before-next:page:0:freeze", kind: "card_update",
      root_message_id: "message-freeze", payload: JSON.stringify({ lifecycle: "completed" }), state: "pending",
      snapshot_revision: 2
    });

    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='message-freeze',card_id_checkpoint='card-freeze' WHERE id=?").run(freezeReply.id);
    expect(store.checkpointPage({ segmentId: "freeze-before-next", pageIndex: 0, replyId: String(freezeReply.id), messageId: "message-freeze", cardId: "card-freeze" })).toBe("checkpointed");
    expect(store.listConversationSegmentPages("freeze-before-next")[0]).toMatchObject({
      state: "frozen", pendingReplyId: null, deliveredCursor: cursor, deliveredSequence: 2
    });
    expect(store.reserveLateContinuation({
      segmentId: "freeze-before-next", pageIndex: 0, messageId: "message-freeze", card: { page: 2 },
      nextPageIndex: 1, nextElementId: "turn-card:freeze-before-next:page:1", nextStartCursor: cursor
    })).toBe("reserved");
    expect(store.listConversationSegmentPages("freeze-before-next")).toEqual(expect.arrayContaining([
      expect.objectContaining({ pageIndex: 0, state: "frozen" }),
      expect.objectContaining({ pageIndex: 1, state: "creating" })
    ]));
    context.close();
  });

  it("adopts a delivered Completed freeze after restart before creating the continuation", async () => {
    const directory = mkdtempSync(join(tmpdir(), "turn-card-freeze-restart-")); const path = join(directory, "bridge.sqlite");
    const context = new SqliteContext(path); new SqliteMigrations(context).run(); const store = conversationStoreWithOutbox(context);
    const now = "2026-10-05T00:00:00.000Z";
    store.admitLegacyPending({ segmentId: "freeze-restart", submissionId: "submission-freeze-restart", producerKey: "lane:freeze-restart", owner: { kind: "primary", id: "binding", generation: 1 }, agentKind: "traex", expectedSessionId: "session", requestText: "hello", rootMessageId: "root", card: {}, occurredAt: now });
    const createReply = store.listConversationSegmentPages("freeze-restart")[0]!.pendingReplyId!;
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='message-freeze-restart',card_id_checkpoint='card-freeze-restart' WHERE id=?").run(createReply);
    expect(store.checkpointPage({ segmentId: "freeze-restart", pageIndex: 0, replyId: createReply, messageId: "message-freeze-restart", cardId: "card-freeze-restart" })).toBe("checkpointed");
    const cursor = { itemIndex: 1, markdownOffset: 0 };
    expect(store.reserveFreeze({
      segmentId: "freeze-restart", pageIndex: 0, messageId: "message-freeze-restart", cardId: "card-freeze-restart",
      elementId: "turn-card:freeze-restart:page:0", card: { lifecycle: "completed" }, cursor
    })).toBe("reserved");
    const freezeReply = store.listConversationSegmentPages("freeze-restart")[0]!.pendingReplyId!;
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='message-freeze-restart',card_id_checkpoint='card-freeze-restart' WHERE id=?").run(freezeReply);
    context.close();

    const reopened = new SqliteContext(path); new SqliteMigrations(reopened).run(); const restored = conversationStoreWithOutbox(reopened);
    const workflow = new TurnCardWorkflow(restored, () => undefined, {
      turnCardPage: (_view, page) => ({ card: { page: page.pageIndex }, items: [], nextCursor: null })
    });
    await workflow.converge("freeze-restart");

    expect(restored.listConversationSegmentPages("freeze-restart")).toEqual(expect.arrayContaining([
      expect.objectContaining({ pageIndex: 0, state: "frozen", pendingReplyId: null, deliveredCursor: cursor }),
      expect.objectContaining({ pageIndex: 1, state: "creating" })
    ]));
    expect(reopened.database.prepare("SELECT idempotency_key,kind,state,payload FROM outbound_replies WHERE projection_key='turn-card:freeze-restart:page:1'").get()).toMatchObject({
      idempotency_key: "segment:freeze-restart:page:1:create", kind: "card_reply", state: "pending", payload: JSON.stringify({ page: 1 })
    });
    reopened.close(); rmSync(directory, { recursive: true, force: true });
  });

  it("rehydrates Wait Tool activity and waiting status after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "turn-card-wait-restart-")); const path = join(directory, "bridge.sqlite");
    const context = new SqliteContext(path); new SqliteMigrations(context).run(); const store = conversationStoreWithOutbox(context);
    const now = "2026-10-05T00:00:00.000Z";
    store.admitLegacyPending({ segmentId: "wait-restart", submissionId: "submission-wait-restart", producerKey: "lane:wait", owner: { kind: "primary", id: "binding", generation: 1 }, agentKind: "traex", expectedSessionId: "session", requestText: "wait", rootMessageId: "root", card: {}, occurredAt: now });
    expect(store.projectCanonicalEvent({
      laneId: "wait", laneSequence: 1, observedAt: now,
      event: { schemaVersion: 1, eventId: "human-wait", cursor: "wait:1", sourceId: "core", agentKind: "traex", sessionId: "session", turnId: "turn-wait", occurredAt: now, payload: { type: "human_message", message_id: "human-wait", submission_id: "submission-wait-restart", text: "wait", truncated: false } }
    })).toMatchObject({ outcome: "adopted", segmentId: "wait-restart" });
    expect(store.projectCanonicalEvent({
      laneId: "wait", laneSequence: 2, observedAt: now,
      event: { schemaVersion: 1, eventId: "wait-activity", cursor: "wait:2", sourceId: "core", agentKind: "traex", sessionId: "session", turnId: "turn-wait", occurredAt: now, payload: { type: "message", message_id: "wait-status", channel: "status", text: "Waiting for command", truncated: false } },
      timelineDeltas: [
        { kind: "tool", id: "tool:wait-1", sequence: 1, category: "step", label: "Wait · session 42", state: "running" },
        { kind: "status", id: "status:wait-1", sequence: 2, label: "Waiting for command", state: "running" }
      ]
    })).toMatchObject({ outcome: "projected", segmentId: "wait-restart" });
    context.close();

    const reopened = new SqliteContext(path); new SqliteMigrations(reopened).run(); const restored = conversationStoreWithOutbox(reopened);
    const view = restored.loadCardView("wait-restart")!;
    const rendered = JSON.stringify(renderTurnCard(view));
    expect(view.timelineItems).toEqual(expect.arrayContaining([
      expect.objectContaining({ id: "tool:wait-1", label: "Wait · session 42" }),
      expect.objectContaining({ id: "status:wait-1", label: "Waiting for command" })
    ]));
    expect(rendered).toContain("Wait · session 42");
    expect(rendered).toContain("Waiting for command");
    reopened.close(); rmSync(directory, { recursive: true, force: true });
  });

  it("appends one idempotent recovery card for a frozen page with proven empty delivered content", async () => {
    const directory = mkdtempSync(join(tmpdir(), "turn-card-history-recovery-")); const path = join(directory, "bridge.sqlite");
    let context = new SqliteContext(path); new SqliteMigrations(context).run(); let store = conversationStoreWithOutbox(context);
    const now = "2026-10-05T00:00:00.000Z";
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at
    ) VALUES('missing-history','lane:missing','primary','binding',1,'traex','recover','closed',3,'root',?,?)`).run(now, now);
    context.database.prepare("INSERT INTO conversation_segment_items(segment_id,item_id,lane_sequence,item_ordinal,item_json) VALUES('missing-history','tool:one',1,0,?)")
      .run(JSON.stringify({ kind: "tool", id: "tool:one", sequence: 1, category: "step", label: "Recovered tool", state: "succeeded" }));
    context.database.prepare("INSERT INTO conversation_segment_items(segment_id,item_id,lane_sequence,item_ordinal,item_json) VALUES('missing-history','message:two',2,0,?)")
      .run(JSON.stringify({ kind: "agent_message", id: "message:two", sequence: 2, markdown: "Recovered message" }));
    context.database.prepare("INSERT INTO conversation_segment_items(segment_id,item_id,lane_sequence,item_ordinal,item_json) VALUES('missing-history','later:three',3,0,?)")
      .run(JSON.stringify({ kind: "agent_message", id: "later:three", sequence: 3, markdown: "Must not enter page two recovery" }));
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,element_id,state,sequence,delivered_sequence,start_cursor_json,delivered_cursor_json,created_at,updated_at
    ) VALUES
      ('missing-history:page:1','missing-history',1,'source-message','turn-card:missing-history:page:1','frozen',2,2,'{"itemIndex":0,"markdownOffset":0}','{"itemIndex":2,"markdownOffset":0}',?,?),
      ('missing-history:page:2','missing-history',2,'anchor-message','turn-card:missing-history:page:2','finished',1,1,'{"itemIndex":2,"markdownOffset":0}',NULL,?,?)`).run(now, now, now, now);
    context.database.prepare(`INSERT INTO outbound_replies(
      id,idempotency_key,gateway_id,root_message_id,kind,target_role,payload,state,delivered_message_id,
      next_attempt_at,created_at,updated_at,lane_key,projection_key,snapshot_revision,view_version,scope_kind,scope_key
    ) VALUES('empty-page','empty-page','feishu:primary','source-message','card_update','operation_result',?,'delivered','source-message',?,?,?,?,?,2,2,'global','["global"]')`).run(
      JSON.stringify({ schema: "2.0", body: { elements: [{ tag: "markdown", content: "fixed shell only" }] } }),
      now, now, now, "turn-card:missing-history:page:1", "turn-card:missing-history:page:1"
    );
    const presentation = { turnCardPage: vi.fn((view: { timelineItems: Array<{ id: string }> }) => ({
      card: { recovered: [view.timelineItems[0]!.id] }, items: [view.timelineItems[0]!],
      nextCursor: view.timelineItems.length > 1 ? { itemIndex: 1, markdownOffset: 0 } : null
    })) };
    const workflow = new TurnCardWorkflow(store, () => undefined, presentation as never);

    expect(store.loadHistoryPage({
      segmentId: "missing-history",
      startCursor: { itemIndex: 1, markdownOffset: 0 },
      endCursor: { itemIndex: 1, markdownOffset: 9 },
      limit: 500
    })).toMatchObject({ items: [expect.objectContaining({ id: "message:two", markdown: "Recovered" })], hasMore: false });

    await workflow.converge("missing-history");
    expect(presentation.turnCardPage).toHaveBeenCalledWith(
      expect.objectContaining({ state: "completed", timelineItems: [expect.objectContaining({ id: "tool:one" }), expect.objectContaining({ id: "message:two" })] }),
      expect.objectContaining({ pageIndex: 1, startCursor: null }),
      expect.objectContaining({ continuation: true }),
      expect.any(Number)
    );
    const recovery = context.database.prepare("SELECT id,idempotency_key,root_message_id,kind,state,payload FROM outbound_replies WHERE idempotency_key='turn-card-recovery:missing-history:source:1:part:0:create'").get() as Record<string, unknown>;
    expect(recovery).toMatchObject({ root_message_id: "anchor-message", kind: "card_reply", state: "pending", payload: JSON.stringify({ recovered: ["tool:one"] }) });

    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='recovery-message' WHERE id=?").run(recovery.id);
    context.close();
    context = new SqliteContext(path); new SqliteMigrations(context).run(); store = conversationStoreWithOutbox(context);
    const restored = new TurnCardWorkflow(store, () => undefined, presentation as never);
    await restored.converge("missing-history");
    const second = context.database.prepare("SELECT id,root_message_id,state,payload FROM outbound_replies WHERE idempotency_key='turn-card-recovery:missing-history:source:1:part:1:create'").get() as Record<string, unknown>;
    expect(second).toMatchObject({ root_message_id: "recovery-message", state: "pending", payload: JSON.stringify({ recovered: ["message:two"] }) });
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='recovery-message-2' WHERE id=?").run(second.id);
    await restored.converge("missing-history");
    await restored.converge("missing-history");
    expect(context.database.prepare("SELECT part_index,state,message_id FROM conversation_segment_page_recovery_parts WHERE segment_id='missing-history' AND source_page_index=1 ORDER BY part_index").all()).toEqual([
      { part_index: 0, state: "delivered", message_id: "recovery-message" },
      { part_index: 1, state: "delivered", message_id: "recovery-message-2" }
    ]);
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE idempotency_key LIKE 'turn-card-recovery:missing-history:source:1:part:%:create'").get()).toEqual({ count: 2 });
    context.close(); rmSync(directory, { recursive: true, force: true });
  });

  it("keeps a retryable dead-letter linked without opening an identity gap", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run(); const store = conversationStoreWithOutbox(context);
    store.admitLegacyPending({ segmentId: "retryable", submissionId: "submission-retryable", producerKey: "lane:retryable", owner: { kind: "primary", id: "binding", generation: 1 }, agentKind: "traex", expectedSessionId: "session", requestText: "hello", rootMessageId: "root", card: {}, occurredAt: "2026-10-04T20:00:00.000Z" });
    const replyId = store.listConversationSegmentPages("retryable")[0]!.pendingReplyId!;
    context.database.prepare("UPDATE outbound_replies SET state='dead_letter',failure_class='transient',effect_certainty='uncertain' WHERE id=?").run(replyId);
    expect(store.reconcilePageDelivery("retryable", 0)).toBe("waiting");
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE owner_id='retryable'").get()).toEqual({ count: 0 });
    expect(store.listConversationSegmentPages("retryable")[0]!.pendingReplyId).toBe(replyId);
    context.close();
  });

  it("does not reattach an already checkpointed equal-version update during callback convergence", async () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run(); const store = conversationStoreWithOutbox(context);
    const now = "2026-10-04T20:00:00.000Z";
    store.admitLegacyPending({ segmentId: "equal", submissionId: "submission-equal", producerKey: "lane:equal", owner: { kind: "primary", id: "binding", generation: 1 }, agentKind: "traex", expectedSessionId: "session", requestText: "hello", rootMessageId: "root", card: {}, occurredAt: now });
    const createReply = store.listConversationSegmentPages("equal")[0]!.pendingReplyId!;
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='message-equal' WHERE id=?").run(createReply);
    expect(store.checkpointPage({ segmentId: "equal", pageIndex: 0, replyId: createReply, messageId: "message-equal", cardId: null })).toBe("checkpointed");
    context.database.prepare("UPDATE conversation_segments SET view_version=2 WHERE id='equal'").run();
    expect(store.reserveSnapshot({ segmentId: "equal", pageIndex: 0, messageId: "message-equal", elementId: "turn-card:equal:page:0", card: { version: 2 }, cursor: null, viewVersion: 2 })).toBe("reserved");
    const updateReply = store.listConversationSegmentPages("equal")[0]!.pendingReplyId!;
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='message-equal' WHERE id=?").run(updateReply);
    expect(store.checkpointPage({ segmentId: "equal", pageIndex: 0, replyId: updateReply, messageId: "message-equal", cardId: null })).toBe("checkpointed");

    const workflow = new TurnCardWorkflow(store, () => undefined, { turnCardPage: () => ({ card: { version: 2 }, items: [], nextCursor: null }) });
    await expect(workflow.converge("equal")).resolves.toBeUndefined();
    expect(store.listConversationSegmentPages("equal")[0]!.pendingReplyId).toBeNull();
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key='turn-card:equal:page:0' AND kind='card_update'").get()).toEqual({ count: 1 });
    context.close();
  });

  it("adopts delivered snapshot and finalize replies after reopen without replacement effects", async () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-card-generic-recovery-")); const path = join(dir, "bridge.sqlite");
    const context = new SqliteContext(path); new SqliteMigrations(context).run(); const store = conversationStoreWithOutbox(context);
    const now = "2026-10-04T20:00:00.000Z";
    const activate = (segmentId: string) => {
      store.admitLegacyPending({ segmentId, submissionId: `submission-${segmentId}`, producerKey: `lane:${segmentId}`, owner: { kind: "primary", id: "binding", generation: 1 }, agentKind: "traex", expectedSessionId: "session", requestText: "hello", rootMessageId: "root", card: {}, occurredAt: now });
      const createReply = store.listConversationSegmentPages(segmentId)[0]!.pendingReplyId!;
      context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id=? WHERE id=?").run(`message-${segmentId}`, createReply);
      expect(store.checkpointPage({ segmentId, pageIndex: 0, replyId: createReply, messageId: `message-${segmentId}`, cardId: null })).toBe("checkpointed");
    };
    activate("snapshot-restart");
    context.database.prepare("UPDATE conversation_segments SET view_version=2 WHERE id='snapshot-restart'").run();
    expect(store.reserveSnapshot({ segmentId: "snapshot-restart", pageIndex: 0, messageId: "message-snapshot-restart", elementId: "turn-card:snapshot-restart:page:0", card: { version: 2 }, cursor: null, viewVersion: 2 })).toBe("reserved");
    const snapshotReply = store.listConversationSegmentPages("snapshot-restart")[0]!.pendingReplyId!;
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='message-snapshot-restart' WHERE id=?").run(snapshotReply);

    activate("finish-restart");
    context.database.prepare("UPDATE conversation_segments SET state='completed',view_version=2 WHERE id='finish-restart'").run();
    expect(store.reserveFinish({ segmentId: "finish-restart", pageIndex: 0, messageId: "message-finish-restart", elementId: "turn-card:finish-restart:page:0", card: { state: "completed" }, summary: "Completed", cursor: { itemIndex: 0, markdownOffset: 0 } })).toBe("reserved");
    const finishReply = store.listConversationSegmentPages("finish-restart")[0]!.pendingReplyId!;
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='message-finish-restart' WHERE id=?").run(finishReply);
    context.close();

    const reopened = new SqliteContext(path); new SqliteMigrations(reopened).run(); const restored = conversationStoreWithOutbox(reopened);
    const workflow = new TurnCardWorkflow(restored, () => undefined, { turnCardPage: (view) => ({ card: { state: view.state }, items: [], nextCursor: null }) });
    await workflow.converge("snapshot-restart");
    await workflow.converge("finish-restart");
    expect(restored.listConversationSegmentPages("snapshot-restart")[0]).toMatchObject({ pendingReplyId: null, state: "active" });
    expect(restored.listConversationSegmentPages("finish-restart")[0]).toMatchObject({ pendingReplyId: null, state: "finished" });
    expect(reopened.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key IN ('turn-card:snapshot-restart:page:0','turn-card:finish-restart:page:0')").get()).toEqual({ count: 4 });
    reopened.close(); rmSync(dir, { recursive: true, force: true });
  });

  it("notifies only changed canonical projections and tolerates notifier failure", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run(); const seen: string[] = [];
    const store = new SqliteConversationSegmentStore(context); store.setProjectionNotifier(({ segmentId }) => { seen.push(segmentId); });
    const event = { eventId: "h1", agentKind: "traex" as const, sessionId: "s1", payload: { type: "human_message", message_id: "m", text: "hello" } };
    const first = store.projectCanonicalEvent({ laneId: "lane", laneSequence: 1, event, observedAt: new Date().toISOString() });
    const second = store.projectCanonicalEvent({ laneId: "lane", laneSequence: 1, event, observedAt: new Date().toISOString() });
    expect(first.segmentId).toBeTruthy(); expect(second.outcome).toBe("duplicate"); expect(seen).toEqual([first.segmentId]);
    store.setProjectionNotifier(() => { throw new Error("wake failed"); });
    expect(() => store.projectCanonicalEvent({ laneId: "lane", laneSequence: 2, event: { ...event, eventId: "h2", payload: { type: "assistant_message", text: "ok" } }, observedAt: new Date().toISOString(), timelineDeltas: [{ kind: "assistant", id: "a1", sequence: 1, markdown: "ok", canonicalPosition: { laneSequence: 2, itemOrdinal: 0 } }] })).not.toThrow();
  });

  it("rejects immutable target mismatches and does not enqueue behind a pending effect", async () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const store = conversationStoreWithOutbox(context);
    store.admitLegacyPending({ segmentId: "guarded", submissionId: "submission-guarded", producerKey: "lane:guarded", owner: { kind: "primary", id: "binding-guarded", generation: 1 }, agentKind: "traex", expectedSessionId: null, requestText: "hello", rootMessageId: "root", card: {}, occurredAt: new Date().toISOString() });
    await Promise.resolve();
    expect(context.database.prepare("SELECT idempotency_key FROM outbound_replies ORDER BY delivery_order").all()).toEqual([{ idempotency_key: "turn-card:guarded:page:0:create" }]);
    expect(store.reserveSnapshot({ segmentId: "guarded", pageIndex: 0, messageId: null, card: {}, cursor: null, viewVersion: 2 })).toBe("waiting");
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual({ count: 1 });
    const createReplyId = store.listConversationSegmentPages("guarded")[0]!.pendingReplyId!;
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='m',card_id_checkpoint='c' WHERE id=?").run(createReplyId);
    expect(store.checkpointPage({ segmentId: "guarded", pageIndex: 0, replyId: createReplyId, messageId: "m", cardId: "c" })).toBe("checkpointed");
    expect(store.checkpointPage({ segmentId: "guarded", pageIndex: 0, replyId: createReplyId, messageId: "m", cardId: "c" })).toBe("checkpointed");
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps").get()).toEqual({ count: 0 });
    expect(store.checkpointPage({ segmentId: "guarded", pageIndex: 0, replyId: createReplyId, messageId: "wrong", cardId: "wrong-card" })).toBe("stale");
    expect(context.database.prepare("SELECT owner_kind, owner_id, source_item_id, failure_code FROM projection_gaps WHERE state='open'").all()).toEqual([expect.objectContaining({ owner_kind: "turn_card", owner_id: "guarded", source_item_id: "turn-card:guarded:page:0", failure_code: "immutable_target_mismatch" })]);
    expect(store.reserveFinish({ segmentId: "guarded", pageIndex: 0, messageId: "wrong", card: {}, summary: "done", cursor: { itemIndex: 0, markdownOffset: 0 } })).toBe("stale");
    expect(store.reserveFinish({ segmentId: "guarded", pageIndex: 0, messageId: "m", card: {}, cardId: "c", elementId: "turn-card:guarded:page:0", summary: "done", cursor: { itemIndex: 0, markdownOffset: 0 } })).toBe("reserved");
    expect(store.reserveFinish({ segmentId: "guarded", pageIndex: 0, messageId: "m", card: {}, cardId: "c", elementId: "turn-card:guarded:page:0", summary: "done", cursor: { itemIndex: 0, markdownOffset: 0 } })).toBe("waiting");
    await Promise.resolve();
    const finishReplyId = store.listConversationSegmentPages("guarded")[0]!.pendingReplyId!;
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='m',card_id_checkpoint='c' WHERE id=?").run(finishReplyId);
    expect(store.checkpointPage({ segmentId: "guarded", pageIndex: 0, replyId: finishReplyId, messageId: "m", cardId: "c" })).toBe("checkpointed");
    expect(store.listConversationSegmentPages("guarded")[0]).toMatchObject({ state: "finished", pendingReplyId: null });
    context.close();
  });

  it("does not trust fabricated segment_id metadata for late facts", () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-card-late-")); const path = join(dir, "bridge.sqlite");
    const context = new SqliteContext(path); new SqliteMigrations(context).run(); const store = new SqliteConversationSegmentStore(context);
    const human = (eventId: string, sequence: number, text: string) => ({ eventId, agentKind: "traex" as const, sessionId: "session", payload: { type: "human_message", message_id: eventId, text } });
    const first = store.projectCanonicalEvent({ laneId: "lane-late", laneSequence: 1, event: human("h1", 1, "first"), observedAt: new Date().toISOString() });
    store.projectCanonicalEvent({ laneId: "lane-late", laneSequence: 2, event: human("h2", 2, "second"), observedAt: new Date().toISOString() });
    context.database.prepare("UPDATE conversation_segment_pages SET state='frozen' WHERE segment_id=? AND page_index=0").run(first.segmentId);
    context.close();
    const reopened = new SqliteContext(path); new SqliteMigrations(reopened).run(); const restored = new SqliteConversationSegmentStore(reopened);
    const late = restored.projectCanonicalEvent({ laneId: "lane-late", laneSequence: 3, event: { eventId: "a-late", agentKind: "traex", sessionId: "session", payload: { type: "assistant_message", segment_id: first.segmentId, text: "late" } }, observedAt: new Date().toISOString(), timelineDeltas: [{ kind: "assistant", id: "assistant:late", sequence: 2, markdown: "late", canonicalPosition: { laneSequence: 3, itemOrdinal: 0 } }] });
    expect(late.outcome).toBe("projected");
    expect(late.segmentId).not.toBe(first.segmentId);
    reopened.close(); rmSync(dir, { recursive: true, force: true });
  });

  it("rejects canonical timeline items before the active Conversation Segment start", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const store = new SqliteConversationSegmentStore(context);
    const created = store.projectCanonicalEvent({
      laneId: "lane-boundary", laneSequence: 100, observedAt: "2026-10-12T08:00:00.000Z",
      event: { eventId: "current-human", agentKind: "traex", sessionId: "session", payload: { type: "human_message", message_id: "current-message", text: "current" } }
    });

    expect(store.projectCanonicalEvent({
      laneId: "lane-boundary", laneSequence: 3, observedAt: "2026-10-12T08:00:01.000Z",
      event: { eventId: "historical-assistant", agentKind: "traex", sessionId: "session", payload: { type: "assistant_message", text: "historical" } },
      timelineDeltas: [{ kind: "agent_message", id: "historical-message", sequence: 3, markdown: "historical", canonicalPosition: { laneSequence: 3, itemOrdinal: 0 } }]
    })).toEqual({ outcome: "duplicate", segmentId: created.segmentId });
    expect(store.listConversationSegmentItems(created.segmentId!)).toEqual([
      expect.objectContaining({ itemId: "human:current-message", position: { laneSequence: 100, itemOrdinal: 0 } })
    ]);
    expect(store.getConversationSegment(created.segmentId!)!.viewVersion).toBe(1);
    context.close();
  });

  it("completes a turn while rejecting pre-Segment timeline items", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const graph = new SqliteCapabilityGraph(context); const store = graph.conversationSegments;
    const human = {
      schemaVersion: 1, eventId: "terminal-human", cursor: "lane-terminal:100", sourceId: "source-terminal",
      agentKind: "traex" as const, sessionId: "session-terminal", turnId: "turn-terminal", occurredAt: "2026-10-12T08:00:00.000Z",
      payload: { type: "human_message" as const, message_id: "terminal-message", text: "terminal", truncated: false }
    };
    const created = store.projectCanonicalEvent({ laneId: "lane-terminal", laneSequence: 100, observedAt: human.occurredAt, event: human });
    expect(created.outcome).toBe("created");
    const before = store.getConversationSegment(created.segmentId!)!;

    expect(graph.coreEvents.ingestBatch({
      laneId: "lane-terminal", sourceId: human.sourceId, agentKind: human.agentKind, sessionId: human.sessionId,
      afterCursor: "", nextCursor: human.cursor, latestCursor: human.cursor, events: [human], ingestedAt: human.occurredAt
    })).toBe("accepted");

    const completed = store.projectCanonicalEvent({
      laneId: "lane-terminal", laneSequence: 3, observedAt: "2026-10-12T08:00:01.000Z",
      event: { ...human, eventId: "terminal-completed", cursor: "lane-terminal:3", occurredAt: "2026-10-12T08:00:01.000Z", payload: { type: "turn_completed" as const } },
      timelineDeltas: [{ kind: "agent_message", id: "historical-terminal-message", sequence: 3, markdown: "historical", canonicalPosition: { laneSequence: 3, itemOrdinal: 0 } }]
    });

    expect(completed).toEqual({ outcome: "projected", segmentId: created.segmentId });
    expect(store.getConversationSegment(created.segmentId!)).toMatchObject({ state: "completed", viewVersion: before.viewVersion + 1 });
    const items = store.listConversationSegmentItems(created.segmentId!);
    expect(items).toHaveLength(1);
    expect(items).toEqual([
      expect.objectContaining({ itemId: "human:terminal-message", position: { laneSequence: 100, itemOrdinal: 0 } })
    ]);
    context.close();
  });

  it("keeps a delivered working card active when a later Human Message creates its own card", async () => {
    const context = new SqliteContext(":memory:");
    const graph = new SqliteCapabilityGraph(context);
    graph.bindings.createPendingBinding({
      id: "binding-merged", workspaceId: "workspace", chatId: "chat", topicId: "topic-merged",
      rootMessageId: "root-merged", title: "Merged turn"
    });
    graph.bindings.updateBinding("binding-merged", {
      state: "active", lifecycle: "active", attachment: "attached", paneId: "pane-merged",
      agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-merged"
    });
    graph.conversationSegments.setInitialTurnCardRenderer((view, page) => renderTurnCard(view, page));
    graph.outbox.setGatewayPlanPreparer((reply) => {
      const intent = prepareOutboundGatewayIntent(graph.outbox, reply).intent;
      return {
        protocolVersion: 1, gatewayId: reply.gatewayId, profileId: reply.gatewayProfileId,
        rendererRevision: 1, operation: intent.kind, intent
      };
    });
    graph.connectPreparedDeliveryProducers(graph.outbox, { enqueuePreparedDelivery() {} });
    graph.agentInputs.admit({
      submissionId: "submission-merged", ingressSource: "feishu:primary", sourceMessageKey: "source-merged",
      actor: { kind: "human", id: "operator", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic-merged", rootMessageId: "root-merged" },
      text: "first request", owner: { kind: "primary", id: "binding-merged", generation: 1 },
      paneId: "pane-merged", terminalId: "terminal-merged", expectedAgentKind: "traex", expectedSessionId: "session-merged",
      recordedAt: "2026-10-13T18:08:32.722Z"
    });
    const first = graph.conversationSegments.projectCanonicalEvent({
      laneId: "lane-merged", laneSequence: 1, observedAt: "2026-10-13T18:08:36.835Z",
      event: {
        eventId: "human-first", agentKind: "traex", sessionId: "session-merged",
        payload: { type: "human_message", message_id: "message-first", submission_id: "submission-merged", text: "first request" }
      }
    });
    expect(first.segmentId).toBeTruthy();
    const firstPage = graph.conversationSegments.listConversationSegmentPages(first.segmentId!)[0]!;
    expect(graph.outbox.checkpointOutboundReplyCard(firstPage.pendingReplyId!, "card-first")).not.toBeNull();
    expect(graph.outbox.markOutboundReplyDelivered(firstPage.pendingReplyId!, "message-card-first", "card-first")).toBe(true);
    expect(graph.conversationSegments.reconcilePageDelivery(first.segmentId!, 0)).toBe("adopted");

    graph.conversationSegments.projectCanonicalEvent({
      laneId: "lane-merged", laneSequence: 2, observedAt: "2026-10-13T18:08:40.000Z",
      event: { eventId: "commentary-first", agentKind: "traex", sessionId: "session-merged", payload: { type: "assistant_message", text: "我先检查当前状态。" } },
      timelineDeltas: [{
        kind: "agent_message", id: "commentary-visible", sequence: 1, markdown: "我先检查当前状态。",
        canonicalPosition: { laneSequence: 2, itemOrdinal: 0 }
      }]
    });
    graph.conversationSegments.projectCanonicalEvent({
      laneId: "lane-merged", laneSequence: 3, observedAt: "2026-10-13T18:08:55.450Z",
      event: {
        eventId: "human-second", agentKind: "traex", sessionId: "session-merged",
        payload: { type: "human_message", message_id: "message-second", text: "second request" }
      }
    });
    expect(graph.conversationSegments.getConversationSegment(first.segmentId!)).toMatchObject({ state: "working" });
    expect(graph.conversationSegments.listConversationSegmentItems(first.segmentId!).some(({ item }) => item.kind === "final_answer")).toBe(false);

    const workflow = new TurnCardWorkflow(graph.conversationSegments, () => undefined, {
      turnCardPage: (view, page, options, limit) => planAndRenderTurnCard(view, page, options, limit)
    });
    await workflow.converge(first.segmentId!);
    const finish = graph.outbox.listPendingOutboundReplies().find(({ idempotencyKey }) =>
      idempotencyKey === `segment:${first.segmentId}:page:0:finish`
    );
    expect(finish).toBeUndefined();

    const [firstSegment, secondSegment] = graph.conversationSegments.listConversationSegmentsForProducer("lane:lane-merged");
    expect(firstSegment?.id).toBe(first.segmentId);
    expect(secondSegment?.id).not.toBe(first.segmentId);
    const laterCardCreate = graph.outbox.listPendingOutboundReplies().find(({ projectionKey }) =>
      projectionKey === `turn-card:${secondSegment!.id}:page:0`
    );
    expect(laterCardCreate).toBeDefined();
    expect(graph.outbox.checkpointOutboundReplyCard(laterCardCreate!.id, "card-second")).not.toBeNull();
    expect(graph.outbox.markOutboundReplyDelivered(laterCardCreate!.id, "message-card-second", "card-second")).toBe(true);

    context.close();
  });

  it("correlates a late Tool result by the durable Tool call ID", async () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-card-tool-late-")); const path = join(dir, "bridge.sqlite");
    const context = new SqliteContext(path); new SqliteMigrations(context).run(); const store = conversationStoreWithOutbox(context);
    store.setInitialTurnCardRenderer(() => ({ schema: "2.0" }));
    new SqliteSubmissionIntentStore(context).admit({
      submissionId: "tool-submission", ingressSource: "feishu:primary", sourceMessageKey: "source-tool",
      actor: { kind: "human", id: "operator", gatewayId: "feishu:primary", chatId: "chat", topicId: "topic", rootMessageId: "root-tool" },
      text: "run", owner: { kind: "primary", id: "binding", generation: 1 }, paneId: "pane", terminalId: "terminal",
      expectedAgentKind: "traex", expectedSessionId: "session", recordedAt: new Date().toISOString()
    });
    const first = store.projectCanonicalEvent({ laneId: "lane-tool", laneSequence: 1, event: { eventId: "h-tool", agentKind: "traex", sessionId: "session", payload: { type: "human_message", message_id: "m", submission_id: "tool-submission", text: "run" } }, observedAt: new Date().toISOString(), timelineDeltas: [{ kind: "tool", id: "tool:call-1", sequence: 1, category: "command", label: "run", state: "running", canonicalPosition: { laneSequence: 1, itemOrdinal: 1 } }] });
    expect(first.segmentId).toBeTruthy();
    const firstReplyId = store.listConversationSegmentPages(first.segmentId!)[0]!.pendingReplyId!;
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='m-card',card_id_checkpoint='c-card' WHERE id=?").run(firstReplyId);
    expect(store.checkpointPage({ segmentId: first.segmentId!, pageIndex: 0, replyId: firstReplyId, messageId: "m-card", cardId: "c-card" })).toBe("checkpointed");
    store.projectCanonicalEvent({ laneId: "lane-tool", laneSequence: 2, event: { eventId: "tool-call", agentKind: "traex", sessionId: "session", payload: { type: "assistant_message", text: "working" } }, observedAt: new Date().toISOString(), timelineDeltas: [{ kind: "tool", id: "tool:call-1", sequence: 1, category: "command", label: "run", state: "running", canonicalPosition: { laneSequence: 2, itemOrdinal: 0 } }] });
    store.projectCanonicalEvent({ laneId: "lane-tool", laneSequence: 3, event: { eventId: "h-next", agentKind: "traex", sessionId: "session", payload: { type: "human_message", message_id: "m2", text: "next" } }, observedAt: new Date().toISOString() });
    context.database.prepare("UPDATE conversation_segment_pages SET state='frozen' WHERE segment_id=? AND page_index=0").run(first.segmentId);
    context.close();
    const reopened = new SqliteContext(path); new SqliteMigrations(reopened).run();
    const restored = conversationStoreWithOutbox(reopened);
    const late = restored.projectCanonicalEvent({ laneId: "recovery", laneSequence: 9, event: { eventId: "tool-result", agentKind: "traex", sessionId: "session", payload: { type: "tool_result", call_id: "call-1", text: "ok" } }, observedAt: new Date().toISOString() });
    expect(late).toEqual({ outcome: "projected", segmentId: first.segmentId });
    const revision = restored.getConversationSegment(first.segmentId!)!.viewVersion;
    expect(restored.projectCanonicalEvent({ laneId: "recovery", laneSequence: 9, event: { eventId: "tool-result-replay", agentKind: "traex", sessionId: "session", payload: { type: "tool_result", call_id: "call-1", text: "ok" } }, observedAt: new Date().toISOString() })).toEqual({ outcome: "duplicate", segmentId: first.segmentId });
    expect(restored.getConversationSegment(first.segmentId!)!.viewVersion).toBe(revision);
    const workflow = new TurnCardWorkflow(restored, () => undefined, { turnCardPage: () => ({ card: { schema: "2.0" }, items: [], nextCursor: null }) });
    await workflow.converge(first.segmentId!);
    expect(reopened.database.prepare("SELECT 1 FROM outbound_replies WHERE idempotency_key=?").get(`segment:${first.segmentId}:page:1:create`)).toEqual({ 1: 1 });
    expect(restored.listConversationSegmentPages(first.segmentId!)).toEqual(expect.arrayContaining([expect.objectContaining({ pageIndex: 0, state: "frozen" }), expect.objectContaining({ pageIndex: 1, state: "creating" })]));
    reopened.close(); rmSync(dir, { recursive: true, force: true });
  });

  it("delivers a persisted bounded recovery card for an item inserted before the active anchor", async () => {
    const dir = mkdtempSync(join(tmpdir(), "turn-card-late-anchor-recovery-")); const path = join(dir, "bridge.sqlite");
    let context = new SqliteContext(path); new SqliteMigrations(context).run(); let store = conversationStoreWithOutbox(context);
    const now = "2026-10-08T00:00:00.000Z";
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,start_lane_sequence,start_item_ordinal,
      state,view_version,root_message_id,timeline_item_count,created_at,updated_at
    ) VALUES('late-anchor','lane:late-anchor','primary','binding',1,'traex','session','recover',1,0,'working',2,'root',1,?,?)`).run(now, now);
    context.database.prepare(`INSERT INTO conversation_segment_items(segment_id,item_id,lane_sequence,item_ordinal,item_json)
      VALUES('late-anchor','current',10,0,?)`).run(JSON.stringify({ kind: "status", id: "current", sequence: 10, label: "current", state: "running", canonicalPosition: { laneSequence: 10, itemOrdinal: 0 } }));
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,start_cursor_json,delivered_cursor_json,
      start_lane_sequence,start_item_ordinal,cursor_base,continuation_lane_sequence,continuation_item_ordinal,continuation_cursor_base,created_at,updated_at
    ) VALUES
      ('late-anchor:0','late-anchor',0,'frozen-message','frozen-card','turn-card:late-anchor:page:0','frozen',1,1,NULL,'{"itemIndex":1,"markdownOffset":0}',NULL,NULL,0,10,0,1,?,?),
      ('late-anchor:1','late-anchor',1,'active-message','active-card','turn-card:late-anchor:page:1','active',2,2,'{"itemIndex":1,"markdownOffset":0}','{"itemIndex":1,"markdownOffset":0}',10,0,1,NULL,NULL,NULL,?,?)`)
      .run(now, now, now, now);
    const frozenBefore = context.database.prepare("SELECT * FROM conversation_segment_pages WHERE segment_id='late-anchor' AND page_index=0").get();

    const lateEventInput = {
      laneId: "late-anchor", laneSequence: 5, observedAt: "2026-10-08T00:00:05.000Z",
      event: { schemaVersion: 1, eventId: "late-event", cursor: "late:5", sourceId: "core", agentKind: "traex", sessionId: "session", turnId: "turn", occurredAt: now, payload: { type: "assistant_message", text: "late" } },
      timelineDeltas: [{ kind: "agent_message", id: "late-item", sequence: 5, markdown: "Recovered before-anchor activity", canonicalPosition: { laneSequence: 5, itemOrdinal: 0 } }]
    } as Parameters<typeof store.projectCanonicalEvent>[0];
    expect(store.projectCanonicalEvent(lateEventInput)).toEqual({ outcome: "projected", segmentId: "late-anchor" });
    expect(store.loadActiveProjection("late-anchor")!.view.timelineItems.map(({ id }) => id)).toEqual(["current"]);
    expect(context.database.prepare("SELECT item_id,source_event_id,state FROM conversation_segment_late_recoveries WHERE segment_id='late-anchor'").get())
      .toEqual({ item_id: "late-item", source_event_id: "late-event", state: "queued" });

    const presentation = { turnCardPage: vi.fn((view: { timelineItems: Array<{ id:string }>; gapWarning:string|null }) => ({
      card: { recovered: view.timelineItems.map(({ id }) => id), warning: view.gapWarning }, items: view.timelineItems, nextCursor: null
    })) };
    await new TurnCardWorkflow(store, () => undefined, presentation as never).converge("late-anchor");
    expect(presentation.turnCardPage).toHaveBeenCalledWith(
      expect.objectContaining({ timelineItems: [expect.objectContaining({ id: "late-item" })], gapWarning: expect.stringContaining("恢复") }),
      expect.any(Object), expect.objectContaining({ continuation: true }), expect.any(Number)
    );
    const reply = context.database.prepare(`SELECT id,root_message_id,state,payload FROM outbound_replies
      WHERE projection_key LIKE 'turn-card-late-recovery:late-anchor:%'`).get() as { id:string; root_message_id:string; state:string; payload:string };
    expect(reply).toMatchObject({ root_message_id: "active-message", state: "pending" });
    expect(JSON.parse(reply.payload)).toMatchObject({ recovered: ["late-item"], warning: expect.stringContaining("恢复") });
    expect(context.database.prepare("SELECT * FROM conversation_segment_pages WHERE segment_id='late-anchor' AND page_index=0").get()).toEqual(frozenBefore);
    context.database.prepare("UPDATE outbound_replies SET state='dead_letter',failure_class='permanent',effect_certainty='rejected' WHERE id=?").run(reply.id);
    context.close();

    context = new SqliteContext(path); new SqliteMigrations(context).run(); store = conversationStoreWithOutbox(context);
    await new TurnCardWorkflow(store, () => undefined, presentation as never).converge("late-anchor");
    const replacement = context.database.prepare(`SELECT id FROM outbound_replies
      WHERE projection_key LIKE 'turn-card-late-recovery:late-anchor:%' AND state='pending'`).get() as { id:string };
    expect(replacement.id).not.toBe(reply.id);
    context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='late-recovery-message' WHERE id=?").run(replacement.id);
    context.close();

    context = new SqliteContext(path); new SqliteMigrations(context).run(); store = conversationStoreWithOutbox(context);
    await new TurnCardWorkflow(store, () => undefined, presentation as never).converge("late-anchor");
    expect(context.database.prepare("SELECT state,message_id FROM conversation_segment_late_recoveries WHERE segment_id='late-anchor'").get())
      .toEqual({ state: "delivered", message_id: "late-recovery-message" });
    expect(context.database.prepare("SELECT state FROM projection_gaps WHERE owner_id='late-anchor' AND source_item_id='late-item'").get()).toEqual({ state: "compensated" });
    const enrichedLateEventInput = {
      ...lateEventInput,
      observedAt: "2026-10-08T00:00:06.000Z",
      timelineDeltas: [{ ...lateEventInput.timelineDeltas![0]!, markdown: "Recovered before-anchor activity enriched" }]
    } as Parameters<typeof store.projectCanonicalEvent>[0];
    expect(store.projectCanonicalEvent(enrichedLateEventInput)).toEqual({ outcome: "projected", segmentId: "late-anchor" });
    await new TurnCardWorkflow(store, () => undefined, presentation as never).converge("late-anchor");
    store.projectCanonicalEvent({
      laneId: "late-anchor", laneSequence: 0, observedAt: "2026-10-08T00:00:07.000Z",
      event: { schemaVersion: 1, eventId: "prior-turn-event", cursor: "late:0", sourceId: "core", agentKind: "traex", sessionId: "session", turnId: "prior-turn", occurredAt: now, payload: { type: "assistant_message", text: "prior" } },
      timelineDeltas: [{ kind: "agent_message", id: "prior-turn-item", sequence: 0, markdown: "Prior turn content", canonicalPosition: { laneSequence: 0, itemOrdinal: 0 } }]
    });
    await new TurnCardWorkflow(store, () => undefined, presentation as never).converge("late-anchor");
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE projection_key LIKE 'turn-card-late-recovery:late-anchor:%'").get()).toEqual({ count: 2 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_late_recoveries WHERE segment_id='late-anchor'").get()).toEqual({ count: 1 });
    expect(context.database.prepare("SELECT * FROM conversation_segment_pages WHERE segment_id='late-anchor' AND page_index=0").get()).toEqual(frozenBefore);
    context.close(); rmSync(dir, { recursive: true, force: true });
  });

  it("does not enqueue late recovery after a closed worker owner is gone", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const store = new SqliteConversationSegmentStore(context);
    const now = "2026-10-13T09:00:00.000Z";
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,start_lane_sequence,start_item_ordinal,
      state,view_version,root_message_id,timeline_item_count,created_at,updated_at
    ) VALUES('orphan-worker-segment','worker:missing-worker','worker','missing-worker',1,'traex','orphan-session','recover',1,0,'closed',2,'root',1,?,?)`).run(now, now);
    context.database.prepare(`INSERT INTO conversation_segment_items(segment_id,item_id,lane_sequence,item_ordinal,item_json)
      VALUES('orphan-worker-segment','tool:current',5,0,?)`).run(JSON.stringify({ kind: "tool", id: "tool:current", sequence: 5, category: "command", label: "run", state: "running", canonicalPosition: { laneSequence: 5, itemOrdinal: 0 } }));
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,start_cursor_json,delivered_cursor_json,
      start_lane_sequence,start_item_ordinal,cursor_base,continuation_lane_sequence,continuation_item_ordinal,continuation_cursor_base,created_at,updated_at
    ) VALUES('orphan-worker-segment:0','orphan-worker-segment',0,'active-message','active-card','turn-card:orphan-worker-segment:page:0','active',2,2,'{"itemIndex":1,"markdownOffset":0}','{"itemIndex":1,"markdownOffset":0}',10,0,1,NULL,NULL,NULL,?,?)`)
      .run(now, now);

    const result = store.projectCanonicalEvent({
      laneId: "orphan-worker-lane", laneSequence: 5, observedAt: "2026-10-13T09:00:05.000Z",
      event: { schemaVersion: 1, eventId: "orphan-worker-late-event", cursor: "orphan:5", sourceId: "core", agentKind: "traex", sessionId: "orphan-session", turnId: "orphan-turn", occurredAt: now, payload: { type: "tool_result", call_id: "current", text: "unrenderable" } }
    });

    expect(result).toEqual({ outcome: "projected", segmentId: "orphan-worker-segment" });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_late_recoveries WHERE segment_id='orphan-worker-segment'").get()).toEqual({ count: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE owner_id='orphan-worker-segment'").get()).toEqual({ count: 0 });
    context.close();
  });

  it("does not enqueue late recovery after a Primary segment is closed", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const store = new SqliteConversationSegmentStore(context);
    const now = "2026-10-13T09:20:00.000Z";
    context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,session_id,request_text,start_lane_sequence,start_item_ordinal,
      state,view_version,root_message_id,timeline_item_count,created_at,updated_at
    ) VALUES('closed-primary-segment','lane:closed-primary','primary','binding',1,'traex','closed-primary-session','recover',1,0,'closed',2,'root',1,?,?)`).run(now, now);
    context.database.prepare(`INSERT INTO conversation_segment_items(segment_id,item_id,lane_sequence,item_ordinal,item_json)
      VALUES('closed-primary-segment','tool:current',5,0,?)`).run(JSON.stringify({ kind: "tool", id: "tool:current", sequence: 5, category: "command", label: "run", state: "running", canonicalPosition: { laneSequence: 5, itemOrdinal: 0 } }));
    context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,start_cursor_json,delivered_cursor_json,
      start_lane_sequence,start_item_ordinal,cursor_base,continuation_lane_sequence,continuation_item_ordinal,continuation_cursor_base,created_at,updated_at
    ) VALUES('closed-primary-segment:0','closed-primary-segment',0,'active-message','active-card','turn-card:closed-primary-segment:page:0','active',2,2,'{"itemIndex":1,"markdownOffset":0}','{"itemIndex":1,"markdownOffset":0}',10,0,1,NULL,NULL,NULL,?,?)`)
      .run(now, now);

    const result = store.projectCanonicalEvent({
      laneId: "closed-primary-lane", laneSequence: 5, observedAt: "2026-10-13T09:20:05.000Z",
      event: { schemaVersion: 1, eventId: "closed-primary-late-event", cursor: "closed:5", sourceId: "core", agentKind: "traex", sessionId: "closed-primary-session", turnId: "closed-primary-turn", occurredAt: now, payload: { type: "tool_result", call_id: "current", text: "late" } }
    });

    expect(result).toEqual({ outcome: "projected", segmentId: "closed-primary-segment" });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM conversation_segment_late_recoveries WHERE segment_id='closed-primary-segment'").get()).toEqual({ count: 0 });
    expect(context.database.prepare("SELECT COUNT(*) AS count FROM projection_gaps WHERE owner_id='closed-primary-segment'").get()).toEqual({ count: 0 });
    context.close();
  });

  it("fails closed when a Tool call ID is reused by two segments in one session", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run(); const store = new SqliteConversationSegmentStore(context);
    const make = (id: string, lane: string) => {
      const created = store.projectCanonicalEvent({ laneId: lane, laneSequence: 1, event: { eventId: `h-${id}`, agentKind: "traex", sessionId: "same-session", payload: { type: "human_message", message_id: id, text: id } }, observedAt: new Date().toISOString() });
      store.projectCanonicalEvent({ laneId: lane, laneSequence: 2, event: { eventId: `a-${id}`, agentKind: "traex", sessionId: "same-session", payload: { type: "assistant_message" } }, observedAt: new Date().toISOString(), timelineDeltas: [{ kind: "tool", id: "tool:shared", sequence: 1, category: "command", label: "run", state: "running", canonicalPosition: { laneSequence: 2, itemOrdinal: 0 } }] });
      return created.segmentId!;
    };
    const first = make("one", "lane-one"); make("two", "lane-two");
    const result = store.projectCanonicalEvent({ laneId: "recovery", laneSequence: 9, event: { eventId: "r", agentKind: "traex", sessionId: "same-session", payload: { type: "tool_result", call_id: "shared", text: "ambiguous" } }, observedAt: new Date().toISOString() });
    expect(result).toEqual({ outcome: "ignored", segmentId: null });
    expect(store.getConversationSegment(first)!.viewVersion).toBe(2);
    context.close();
  });

  it("targets only the latest fully delivered page and wakes on a later revision", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run(); const store = new SqliteConversationSegmentStore(context);
    const created = store.projectCanonicalEvent({ laneId: "multi", laneSequence: 1, event: { eventId: "human", agentKind: "traex", sessionId: "s", payload: { type: "human_message", message_id: "m", text: "multi" } }, observedAt: new Date().toISOString() });
    const id = created.segmentId!;
    context.database.prepare("UPDATE conversation_segments SET root_message_id='root' WHERE id=?").run(id);
    context.database.prepare("UPDATE conversation_segment_pages SET message_id='m0',card_id='c0',state='active' WHERE segment_id=? AND page_index=0").run(id);
    context.database.prepare("UPDATE conversation_segment_pages SET state='frozen', delivered_cursor_json=?, sequence=1 WHERE segment_id=? AND page_index=0").run(JSON.stringify({ itemIndex: 1, markdownOffset: 0 }), id);
    context.database.prepare("INSERT INTO conversation_segment_pages(id,segment_id,page_index,message_id,card_id,element_id,state,sequence,start_cursor_json,delivered_cursor_json,created_at,updated_at) VALUES(?,?,?,?,?,?, 'active',1,?,?,?,?)").run(`${id}:page:1`, id, 1, "m1", "c1", `turn-card:${id}:page:1`, JSON.stringify({ itemIndex: 1, markdownOffset: 0 }), JSON.stringify({ itemIndex: 1, markdownOffset: 0 }), new Date().toISOString(), new Date().toISOString());
    expect(store.listActionableConversationSegmentIds()).not.toContain(id);
    store.projectCanonicalEvent({ laneId: "multi", laneSequence: 2, event: { eventId: "a2", agentKind: "traex", sessionId: "s", payload: { type: "assistant_message" } }, observedAt: new Date().toISOString(), timelineDeltas: [{ kind: "assistant", id: "a2", sequence: 2, markdown: "late", canonicalPosition: { laneSequence: 2, itemOrdinal: 0 } }] });
    expect(store.getConversationSegment(id)!.viewVersion).toBeGreaterThan(1);
    expect(store.listActionableConversationSegmentIds()).toContain(id);
    context.close();
  });

  it("filters delivered historical pages before exact recovery hydration", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const graph = new SqliteCapabilityGraph(context); const store = graph.conversationSegments;
    graph.bindings.createPendingBinding({ id: "binding-history", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "History" });
    graph.bindings.updateBinding("binding-history", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    const insertSegment = context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,
      root_message_id,timeline_item_count,created_at,updated_at
    ) VALUES(?,?,'primary','binding-history',1,'traex','request','completed',1,'root',1,?,?)`);
    const insertPage = context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,element_id,state,sequence,delivered_sequence,start_cursor_json,delivered_cursor_json,created_at,updated_at
    ) VALUES(?,?,1,?,?,'finished',1,1,'{"itemIndex":0,"markdownOffset":0}','{"itemIndex":1,"markdownOffset":0}',?,?)`);
    for (let index = 0; index < 25; index += 1) {
      const segmentId = `history-${index}`; const elementId = `turn-card:${segmentId}:page:1`;
      const timestamp = `2026-10-11T00:00:${String(index).padStart(2, "0")}.000Z`;
      insertSegment.run(segmentId, `lane:${segmentId}`, timestamp, timestamp);
      insertPage.run(`${segmentId}:page:1`, segmentId, `message-${index}`, elementId, timestamp, timestamp);
      const reply = graph.outbox.enqueueOutboundReply({
        id: `history-reply-${index}`, idempotencyKey: `history-reply-${index}`, bindingId: "binding-history", bindingGeneration: 1,
        rootMessageId: `message-${index}`, kind: "card_update", payload: JSON.stringify({ nodes: [{ slot: elementId }] }),
        projectionKey: elementId, snapshotRevision: 1
      });
      context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id=? WHERE id=?").run(`message-${index}`, reply.id);
    }

    const prepare = vi.spyOn(context.database, "prepare");
    expect(store.listActionableConversationSegmentIds()).toEqual([]);
    expect(prepare.mock.calls.length).toBeLessThan(10);
    prepare.mockRestore(); context.close();
  });

  it("rotates ordinary and historical recovery candidates after saturated failed pages", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run();
    const graph = new SqliteCapabilityGraph(context); const store = graph.conversationSegments;
    graph.bindings.createPendingBinding({ id: "binding-history", workspaceId: "workspace", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "History" });
    graph.bindings.updateBinding("binding-history", { state: "active", lifecycle: "active", attachment: "attached", paneId: "pane" });
    const insertSegment = context.database.prepare(`INSERT INTO conversation_segments(
      id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,
      root_message_id,timeline_item_count,created_at,updated_at
    ) VALUES(?,?,'primary','binding-history',1,'traex','request','completed',1,'root',1,?,?)`);
    const insertPage = context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,element_id,state,sequence,delivered_sequence,start_cursor_json,delivered_cursor_json,created_at,updated_at
    ) VALUES(?,?,1,?,?,'finished',1,1,'{"itemIndex":0,"markdownOffset":0}','{"itemIndex":1,"markdownOffset":0}',?,?)`);
    for (let index = 0; index <= 25; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const segmentId = `history-${suffix}`; const elementId = `turn-card:${segmentId}:page:1`;
      const timestamp = new Date(Date.UTC(2026, 9, 11, 0, 0, 0, index)).toISOString();
      insertSegment.run(segmentId, `lane:${segmentId}`, timestamp, timestamp);
      insertPage.run(`${segmentId}:page:1`, segmentId, `message-${suffix}`, elementId, timestamp, timestamp);
      const reply = graph.outbox.enqueueOutboundReply({
        id: `history-reply-${suffix}`, idempotencyKey: `history-reply-${suffix}`, bindingId: "binding-history", bindingGeneration: 1,
        rootMessageId: `message-${suffix}`, kind: "card_update", payload: JSON.stringify({ nodes: [{ slot: "legacy-content" }] }),
        projectionKey: elementId, snapshotRevision: 1
      });
      context.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id=? WHERE id=?").run(`message-${suffix}`, reply.id);
    }
    const insertOrdinaryPage = context.database.prepare(`INSERT INTO conversation_segment_pages(
      id,segment_id,page_index,message_id,element_id,state,sequence,delivered_sequence,created_at,updated_at
    ) VALUES(?,?,0,NULL,?,'creating',0,0,?,?)`);
    for (let index = 0; index <= 100; index += 1) {
      const suffix = String(index).padStart(3, "0");
      const segmentId = `ordinary-${suffix}`;
      const timestamp = new Date(Date.UTC(2026, 9, 12, 0, 0, 0, index)).toISOString();
      insertSegment.run(segmentId, `lane:${segmentId}`, timestamp, timestamp);
      insertOrdinaryPage.run(`${segmentId}:page:0`, segmentId, `turn-card:${segmentId}:page:0`, timestamp, timestamp);
    }
    const exactRecovery = vi.spyOn(store, "nextHistoricalPageRecovery")
      .mockImplementation((segmentId) => segmentId === "history-025" ? {} as never : null);

    const first = store.listActionableConversationSegmentIds(100);
    expect(first).toHaveLength(100);
    expect(first).not.toContain("ordinary-100");
    expect(first).not.toContain("history-025");
    const second = store.listActionableConversationSegmentIds(100);
    expect(second).toHaveLength(100);
    expect(second).toContain("ordinary-100");
    expect(second).toContain("history-025");

    exactRecovery.mockRestore(); context.close();
  });

  it("updates only the exact session owner when call IDs are reused across sessions", () => {
    const context = new SqliteContext(":memory:"); new SqliteMigrations(context).run(); const store = new SqliteConversationSegmentStore(context);
    const create = (suffix: string, sessionId: string) => {
      const made = store.projectCanonicalEvent({ laneId: `lane-${suffix}`, laneSequence: 1, event: { eventId: `h-${suffix}`, agentKind: "traex", sessionId, payload: { type: "human_message", message_id: `m-${suffix}`, text: suffix } }, observedAt: new Date().toISOString() });
      store.projectCanonicalEvent({ laneId: `lane-${suffix}`, laneSequence: 2, event: { eventId: `a-${suffix}`, agentKind: "traex", sessionId, payload: { type: "assistant_message" } }, observedAt: new Date().toISOString(), timelineDeltas: [{ kind: "tool", id: "tool:shared", sequence: 1, category: "command", label: suffix, state: "running", canonicalPosition: { laneSequence: 2, itemOrdinal: 0 } }] });
      return made.segmentId!;
    };
    const a = create("a", "session-a"); const b = create("b", "session-b"); const beforeA = store.getConversationSegment(a)!.viewVersion;
    expect(store.projectCanonicalEvent({ laneId: "recovery", laneSequence: 9, event: { eventId: "result-b", agentKind: "traex", sessionId: "session-b", payload: { type: "tool_result", call_id: "shared", text: "only b" } }, observedAt: new Date().toISOString() })).toEqual({ outcome: "projected", segmentId: b });
    expect(store.getConversationSegment(a)!.viewVersion).toBe(beforeA);
    expect(store.listConversationSegmentItems(a).find(({ itemId }) => itemId === "tool:shared")!.item).toMatchObject({ state: "running" });
    expect(store.listConversationSegmentItems(b).find(({ itemId }) => itemId === "tool:shared")!.item).toMatchObject({ state: "succeeded", result: "only b" });
    context.close();
  });

});

function conversationStoreWithOutbox(context: SqliteContext): SqliteConversationSegmentStore {
  const graph = new SqliteCapabilityGraph(context);
  for (const bindingId of ["binding", "binding-1", "binding-guarded"]) {
    if (graph.bindings.getBinding(bindingId)) continue;
    graph.bindings.createPendingBinding({ id: bindingId, workspaceId: "workspace", chatId: "chat", topicId: `topic-${bindingId}`, rootMessageId: "root", title: bindingId });
    graph.bindings.persistBindingPatch(bindingId, { state: "active", lifecycle: "active", attachment: "attached", paneId: `pane-${bindingId}` });
  }
  graph.outbox.setGatewayPlanPreparer((reply) => {
    const intent = prepareOutboundGatewayIntent(graph.outbox, reply).intent;
    return {
      protocolVersion: 1,
      gatewayId: reply.gatewayId,
      profileId: reply.gatewayProfileId,
      rendererRevision: reply.rendererRevision ?? 1,
      operation: intent.kind,
      intent
    };
  });
  graph.conversationSegments.setPreparedDeliveryReservation(graph.outbox, { enqueuePreparedDelivery() {} });
  return graph.conversationSegments;
}

function connectPreparedBundle(bundle: ReturnType<typeof createTestStoreBundle>): void {
  bundle.outbox.setGatewayPlanPreparer((reply) => {
    const intent = prepareOutboundGatewayIntent(bundle.outbox, reply).intent;
    return {
      protocolVersion: 1,
      gatewayId: reply.gatewayId,
      profileId: reply.gatewayProfileId,
      rendererRevision: reply.rendererRevision ?? 1,
      operation: intent.kind,
      intent
    };
  });
  bundle.preparedDeliveryProducers.connectPreparedDeliveryProducers(bundle.outbox, { enqueuePreparedDelivery() {} });
}
