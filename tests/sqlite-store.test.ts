import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { initialTopicView } from "../src/domain/topic-view.js";
import { createQueuedRunCard } from "../src/domain/run-card-view.js";
import { SqliteBindingStore } from "../src/store/sqlite-store.js";

let store: SqliteBindingStore | undefined;
let temporaryDirectory: string | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

describe("SQLite store", () => {
  it("durably creates, links, and atomically claims a project selection", () => {
    store = new SqliteBindingStore(":memory:");
    const selection = store.createProjectSelection({
      id: "s1", commandMessageId: "cmd-1", chatId: "c1", topicId: "t1", rootMessageId: "root-1",
      actorOpenId: "u1", requestedTitle: "Fix login", expiresAt: "2099-01-01T00:00:00.000Z", card: { schema: "2.0" }
    });
    const duplicate = store.createProjectSelection({
      id: "other", commandMessageId: "cmd-1", chatId: "c1", topicId: "t1", rootMessageId: "root-1",
      actorOpenId: "u1", requestedTitle: null, expiresAt: "2099-01-01T00:00:00.000Z", card: {}
    });

    expect(selection).toMatchObject({ id: "s1", state: "pending", selectorMessageId: null });
    expect(duplicate.id).toBe("s1");
    expect(store.listPendingOutboundReplies()).toMatchObject([{ selectionId: "s1", kind: "card_reply", rootMessageId: "root-1" }]);
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "selector-1");
    expect(store.getProjectSelection("s1")).toMatchObject({ selectorMessageId: "selector-1" });

    expect(store.claimProjectSelection({ selectionId: "s1", projectId: "bridge", messageId: "wrong", chatId: "c1", actorOpenId: "u1", allowedProjectIds: ["bridge"] })).toMatchObject({ outcome: "invalid" });
    expect(store.claimProjectSelection({ selectionId: "s1", projectId: "bridge", messageId: "selector-1", chatId: "c1", actorOpenId: "other", allowedProjectIds: ["bridge"] })).toMatchObject({ outcome: "unauthorized" });
    expect(store.claimProjectSelection({ selectionId: "s1", projectId: "unknown", messageId: "selector-1", chatId: "c1", actorOpenId: "u1", allowedProjectIds: ["bridge"] })).toMatchObject({ outcome: "invalid" });
    expect(store.claimProjectSelection({ selectionId: "s1", projectId: "bridge", messageId: "selector-1", chatId: "c1", actorOpenId: "u1", allowedProjectIds: ["bridge"] })).toMatchObject({ outcome: "claimed", selection: { state: "processing", selectedProjectId: "bridge" } });
    expect(store.claimProjectSelection({ selectionId: "s1", projectId: "bridge", messageId: "selector-1", chatId: "c1", actorOpenId: "u1", allowedProjectIds: ["bridge"] })).toMatchObject({ outcome: "processing" });
  });

  it("expires stale selections and fails interrupted processing without replay", () => {
    store = new SqliteBindingStore(":memory:");
    store.createProjectSelection({ id: "expired", commandMessageId: "cmd-old", chatId: "c1", topicId: null, rootMessageId: "root-old", actorOpenId: "u1", requestedTitle: null, expiresAt: "2000-01-01T00:00:00.000Z", card: {} });
    const outbound = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(outbound.id, "selector-old");
    expect(store.claimProjectSelection({ selectionId: "expired", projectId: "bridge", messageId: "selector-old", chatId: "c1", actorOpenId: "u1", allowedProjectIds: ["bridge"] })).toMatchObject({ outcome: "expired" });

    store.createProjectSelection({ id: "processing", commandMessageId: "cmd-new", chatId: "c1", topicId: null, rootMessageId: "root-new", actorOpenId: "u1", requestedTitle: null, expiresAt: "2099-01-01T00:00:00.000Z", card: {} });
    const next = store.listPendingOutboundReplies().find((reply) => reply.selectionId === "processing")!;
    store.markOutboundReplyDelivered(next.id, "selector-new");
    expect(store.claimProjectSelection({ selectionId: "processing", projectId: "bridge", messageId: "selector-new", chatId: "c1", actorOpenId: "u1", allowedProjectIds: ["bridge"] }).outcome).toBe("claimed");
    expect(store.recoverProcessingProjectSelections()).toBe(1);
    expect(store.getProjectSelection("processing")).toMatchObject({ state: "failed" });
  });

  it("persists bindings, FIFO jobs, deduplication, and view snapshots", () => {
    store = new SqliteBindingStore(":memory:");
    const binding = store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding(binding.id, { paneId: "w1:p2", state: "active" });
    expect(store.findBindingByLarkScope("unknown-thread", "m1")?.id).toBe("b1");
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "first" });
    store.enqueuePrompt({ id: "p2", bindingId: "b1", larkMessageId: "m3", actorOpenId: "u1", body: "second" });
    expect(store.claimNextPrompt("b1")?.id).toBe("p1");
    expect(store.recoverRunningPrompts()).toBe(1);
    expect(store.claimNextPrompt("b1")?.id).toBe("p2");
    const inbound = { eventId: "e1", messageId: "m2", chatId: "c1", topicId: "t1", rootMessageId: "m1", actorOpenId: "u1", text: "first", mentionsBot: false, isRootMessage: false };
    expect(store.recordInboundMessage(inbound)).toBe(true);
    expect(store.recordInboundMessage(inbound)).toBe(false);
    expect(store.claimNextInboundMessage()).toEqual(inbound);
    expect(store.recoverProcessingInboundMessages()).toBe(1);
    expect(store.claimNextInboundMessage()).toEqual(inbound);
    store.markInboundMessageAccepted(inbound.eventId);
    expect(store.claimNextInboundMessage()).toBeNull();
    const outbound = store.enqueueOutboundReply({ id: "o1", idempotencyKey: "event:e1:thread-text", bindingId: null, rootMessageId: "m1", kind: "text", payload: "received" });
    const duplicate = store.enqueueOutboundReply({ id: "o2", idempotencyKey: "event:e1:thread-text", bindingId: null, rootMessageId: "m1", kind: "text", payload: "duplicate" });
    expect(duplicate.id).toBe(outbound.id);
    store.markOutboundReplyFailed(outbound.id, "temporary");
    expect(store.listPendingOutboundReplies()).toMatchObject([{ id: "o1", error: "temporary", attemptCount: 1 }]);
    store.markOutboundReplyDelivered(outbound.id, "sent-1");
    expect(store.listPendingOutboundReplies()).toEqual([]);
    const view = { ...initialTopicView("b1"), title: "Task" };
    store.saveTopicView(view);
    expect(store.loadTopicView("b1")).toEqual(view);
  });

  it("queries bindings and run cards by their exact reconciliation scope", () => {
    store = new SqliteBindingStore(":memory:");
    for (const id of ["b2", "b1", "b3"]) {
      store.createPendingBinding({ id, workspaceId: "w1", chatId: "c1", topicId: `t-${id}`, rootMessageId: `m-${id}`, title: id });
    }
    store.updateBinding("b1", { paneId: "w1:p1", state: "active" });
    store.updateBinding("b2", { paneId: "w1:p2", state: "active" });

    expect(store.getBinding("b1")).toMatchObject({ id: "b1", state: "active" });
    expect(store.getBinding("missing")).toBeNull();
    const active = store.listBindingsByState("active");
    expect(active.map(({ id }) => id).sort()).toEqual(["b1", "b2"]);
    expect(active.map(({ createdAt, id }) => `${createdAt}:${id}`)).toEqual(
      [...active].sort((left, right) => left.createdAt.localeCompare(right.createdAt) || left.id.localeCompare(right.id)).map(({ createdAt, id }) => `${createdAt}:${id}`)
    );
    expect(store.listBindingsByState("pending").map(({ id }) => id)).toEqual(["b3"]);

    for (const [promptId, phase] of [["p3", "completed"], ["p1", "running"], ["p2", "queued"]] as const) {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 1, occurredAt: "2026-08-23T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "u1", body: promptId }, view, rootMessageId: "m-b1", answerCard: {} });
      store.saveRunCard({ ...store.loadRunCard(promptId)!, phase });
    }
    expect(store.listRunCardsByPhases("b1", ["queued", "running"]).map(({ promptId }) => promptId)).toEqual(["p1", "p2"]);
    expect(store.listRunCardsByPhases("b1", [])).toEqual([]);
    expect(store.listRunCardsByPhases("b2", ["queued", "running", "completed"])).toEqual([]);
  });

  it("backfills and persists orthogonal pane/thread lifecycle state", () => {
    store = new SqliteBindingStore(":memory:");
    const pending = store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: null, rootMessageId: null, title: "Task" });
    expect(pending).toMatchObject({
      lifecycle: "provisioning", attachment: "unattached", generation: 1,
      provisioningCheckpoint: "selected", degradationCount: 0, hasCompletedTurn: false
    });

    const active = store.updateBinding("b1", {
      paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached",
      provisioningCheckpoint: "activated", traexSessionId: "session-1", lastObservedAt: "2026-08-22T10:00:00.000Z"
    });
    expect(active).toMatchObject({
      lifecycle: "active", attachment: "attached", generation: 1, provisioningCheckpoint: "activated",
      traexSessionId: "session-1", lastObservedAt: "2026-08-22T10:00:00.000Z"
    });
    expect(store.transitionBinding("b1", { type: "archive_requested", hasActiveTurn: true })).toMatchObject({ lifecycle: "draining", state: "active" });
    expect(store.transitionBinding("b1", { type: "drain_completed" })).toMatchObject({ lifecycle: "archived", state: "archived" });
    expect(() => store.transitionBinding("b1", { type: "pane_created" })).toThrow(/pane_created.*archived/i);
  });

  it("cancels queued turns and steering when a session archives", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    for (const [id, kind] of [["p1", "turn"], ["p2", "steering"]] as const) {
      store.enqueuePrompt({ id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body: id, dispatchKind: kind, parentPromptId: kind === "steering" ? "running" : null });
    }
    expect(store.cancelQueuedPrompts("b1", "Topic archived")).toBe(2);
    expect(store.getOperationalSummary().prompts.cancelled).toBe(2);
    expect(store.countPendingPrompts("b1")).toBe(0);
  });

  it("summarizes durable failures without exposing prompt bodies or outbox payloads", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "private prompt body" });
    store.updatePrompt("p1", "failed", "x".repeat(800));
    store.enqueueOutboundReply({ id: "o1", idempotencyKey: "o1", bindingId: "b1", promptId: "p1", rootMessageId: "m1", kind: "card_update", payload: "private card payload" });
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("o1", "delivery failed " + "y".repeat(800));

    const summary = store.getOperationalSummary();
    const serialized = JSON.stringify(summary);
    expect(summary).toMatchObject({
      bindings: { pending: 1 }, prompts: { failed: 1 }, promptDispatch: { turn: 1 },
      outbound: { dead_letter: 1 }, pendingOutbox: 0, deadLetters: 1,
      recentFailedPrompt: { promptId: "p1", bindingId: "b1" },
      recentDeadLetter: { replyId: "o1", bindingId: "b1", promptId: "p1", attemptCount: 5 }
    });
    expect(summary).toMatchObject({ lifecycle: { provisioning: 1 }, attachment: { unattached: 1 }, recoverableProvisioning: 0, archivedPanesPresent: 0 });
    expect(summary.recentFailedPrompt?.error.length).toBeLessThanOrEqual(500);
    expect(summary.recentDeadLetter?.error.length).toBeLessThanOrEqual(500);
    expect(serialized).not.toContain("private prompt body");
    expect(serialized).not.toContain("private card payload");
  });

  it("scopes sessions and dead-letter actions to a chat without replaying prompts", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Visible" });
    store.createPendingBinding({ id: "b2", workspaceId: "w2", chatId: "c2", topicId: "t2", rootMessageId: "m2", title: "Hidden" });
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "p-m1", actorOpenId: "u1", body: "private" });
    store.updatePrompt("p1", "failed", "prompt failed");
    store.enqueueOutboundReply({ id: "o1", idempotencyKey: "o1", bindingId: "b1", promptId: "p1", rootMessageId: "m1", kind: "card_update", payload: "{}" });
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("o1", "send failed");

    expect(store.listSessions("c1")).toHaveLength(1);
    expect(store.listFailures("c1")).toEqual(expect.arrayContaining([expect.objectContaining({ kind: "outbound", id: "o1" }), expect.objectContaining({ kind: "prompt", id: "p1" })]));
    expect(store.retryDeadLetter("o1", "c2", "u2")).toBe("unauthorized");
    expect(store.retryDeadLetter("o1", "c1", "u1")).toBe("retried");
    expect(store.retryDeadLetter("o1", "c1", "u1")).toBe("stale");
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ id: "o1" })]);
    expect(store.getOperationalSummary().prompts.failed).toBe(1);

    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("o1", "send failed again");
    expect(store.dismissDeadLetter("o1", "c1", "u1")).toBe("dismissed");
    expect(store.listFailures("c1").some((failure) => failure.kind === "outbound")).toBe(false);
    expect(store.getOperationalSummary().outbound.dismissed).toBe(1);
  });

  it("atomically accepts one streaming answer card and claims after its card identity is delivered", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "First", workspaceId: "w1", paneId: "w1:p1", requestText: "first **request**", queuePosition: 1, occurredAt: "2026-08-22T10:00:00.000Z" });
    const accepted = store.acceptPrompt({
      prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-m1", actorOpenId: "u1", body: "first" },
      view, rootMessageId: "m1", answerCard: { card: "answer" }
    });
    const duplicate = store.acceptPrompt({
      prompt: { id: "other", bindingId: "b1", larkMessageId: "user-m1", actorOpenId: "u1", body: "first" },
      view: { ...view, promptId: "other" }, rootMessageId: "m1", taskCard: {}, answerCard: {}
    });

    expect(accepted.inserted).toBe(true);
    expect(duplicate).toMatchObject({ inserted: false, prompt: { id: "p1" }, view: { promptId: "p1" } });
    expect(store.listPendingOutboundReplies()).toMatchObject([
      { promptId: "p1", viewVersion: 1, kind: "stream_card_create", cardRole: "answer", payload: JSON.stringify({ card: "answer" }) }
    ]);
    expect(store.claimNextReadyPrompt("b1")).toBeNull();
    expect(store.listQueuedTurnPromptIds("b1")).toEqual(["p1"]);

    const [answerCreate] = store.listPendingOutboundReplies();
    store.markOutboundReplyDelivered(answerCreate!.id, "answer-card-m1", "cardkit-1");
    expect(store.loadRunCard("p1")).toMatchObject({
      larkMessageId: null, answerMessageId: "answer-card-m1", answerCardId: "cardkit-1", requestText: "first **request**", answerDeliveredVersion: 1
    });
    expect(store.claimNextReadyPrompt("b1")?.id).toBe("p1");
    store.saveRunCard({ ...store.loadRunCard("p1")!, answer: "First complete\n\nSecond draft", answerSegments: ["First complete"], answerDraft: "Second draft", answerDraftTransient: false });
    expect(store.loadRunCard("p1")).toMatchObject({
      answer: "First complete\n\nSecond draft", answerSegments: ["First complete"], answerDraft: "Second draft", answerDraftTransient: false
    });
    expect(store.recoverRunningPrompts()).toBe(1);
    expect(store.loadRunCard("p1")).toMatchObject({ phase: "failed", notice: "Bridge 重启导致本次执行中断", queuePosition: 0, viewVersion: 2 });
  });

  it("backfills original request text when migrating an existing run-card database", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-lark-bridge-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: null, requestText: "legacy **request**", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "legacy **request**" }, view, rootMessageId: "m1", taskCard: {}, answerCard: {} });
    store.saveRunCard({ ...store.loadRunCard("p1")!, answer: "legacy answer", answerSegments: ["legacy answer"] });
    store.close();
    store = undefined;

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP VIEW run_cards_view;
      ALTER TABLE run_cards DROP COLUMN answer_draft_transient;
      ALTER TABLE run_cards DROP COLUMN answer_draft;
      ALTER TABLE run_cards DROP COLUMN answer_segments_json;
      ALTER TABLE run_cards DROP COLUMN request_text;
    `);
    legacy.close();

    store = new SqliteBindingStore(path);
    expect(store.loadRunCard("p1")).toMatchObject({
      requestText: "legacy **request**", answer: "legacy answer", answerSegments: ["legacy answer"], answerDraft: "", answerDraftTransient: false
    });
  });

  it("migrates an outbox whose optional columns were appended in legacy order", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-outbox-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.close();
    store = undefined;
    const database = new DatabaseSync(path);
    database.exec(`
      DROP TABLE outbound_replies;
      CREATE TABLE outbound_replies(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT, root_message_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter')), attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, delivered_message_id TEXT,
        next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, prompt_id TEXT, view_version INTEGER, selection_id TEXT, card_role TEXT
      );
      INSERT INTO outbound_replies VALUES ('o1','key',NULL,'root','card_reply','{}','dead_letter',5,'failed',NULL,'now','now','now',NULL,NULL,NULL,NULL);
    `);
    database.close();

    store = new SqliteBindingStore(path);
    expect(store.getOperationalSummary().outbound).toMatchObject({ dead_letter: 1, dismissed: 0 });
  });

  it("adds streaming run-card columns before rebuilding a legacy outbox", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-streaming-migration-order-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.close();
    store = undefined;

    const database = new DatabaseSync(path);
    database.exec(`
      DROP VIEW run_cards_view;
      ALTER TABLE run_cards DROP COLUMN answer_page_start;
      ALTER TABLE run_cards DROP COLUMN answer_page_index;
      ALTER TABLE run_cards DROP COLUMN answer_sequence;
      ALTER TABLE run_cards DROP COLUMN answer_element_id;
      ALTER TABLE run_cards DROP COLUMN answer_card_id;
      CREATE VIEW run_cards_view AS SELECT *, json_object('answerCardId', answer_card_id) AS state_json FROM run_cards;
      DROP TABLE outbound_replies;
      CREATE TABLE outbound_replies(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT, prompt_id TEXT, view_version INTEGER, selection_id TEXT, card_role TEXT,
        root_message_id TEXT NOT NULL, kind TEXT NOT NULL CHECK(kind IN ('text','card_reply','card_update')), payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter')), attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, delivered_message_id TEXT,
        next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    database.close();

    expect(() => { store = new SqliteBindingStore(path); }).not.toThrow();
    expect(store!.loadRunCard("missing")).toBeNull();
  });

  it("does not duplicate the single answer-card create operation", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: "w1:p1", requestText: "legacy", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "legacy" }, view, rootMessageId: "root-1", taskCard: {}, answerCard: {} });
    store.ensureAnswerCard("p1", "root-1", { card: "answer" });
    store.ensureAnswerCard("p1", "root-1", { card: "duplicate" });

    expect(store.listPendingOutboundReplies()).toMatchObject([{
      promptId: "p1", cardRole: "answer", kind: "stream_card_create", payload: JSON.stringify({})
    }]);
    expect(store.claimNextReadyPrompt("b1")).toBeNull();
    const answerCreate = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(answerCreate.id, "answer-card", "cardkit-1");
    expect(store.claimNextReadyPrompt("b1")?.id).toBe("p1");
  });

  it("classifies, claims, falls back, and recovers steering jobs without replay", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const makeView = (promptId: string) => createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 0, occurredAt: new Date().toISOString() });
    for (const [id, messageId] of [["s1", "m2"], ["s2", "m3"]] as const) {
      store.acceptPrompt({
        prompt: { id, bindingId: "b1", larkMessageId: messageId, actorOpenId: "u1", body: id, dispatchKind: "steering", parentPromptId: "parent" },
        view: makeView(id), rootMessageId: "m1", taskCard: {}, answerCard: {}
      });
    }
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, `card-${reply.promptId}`, `cardkit-${reply.promptId}`);

    expect(store.claimNextReadyPrompt("b1")).toBeNull();
    expect(store.listQueuedTurnPromptIds("b1")).toEqual([]);
    expect(store.claimNextReadySteering("b1", "parent")?.id).toBe("s1");
    store.updatePrompt("s1", "delivered");
    expect(store.claimNextReadySteering("b1", "parent")?.id).toBe("s2");
    store.requeueSteeringAsTurn("s2");
    expect(store.claimNextReadyPrompt("b1")).toMatchObject({ id: "s2", dispatchKind: "turn", parentPromptId: null });

    store.updatePrompt("s2", "queued");
    store.database.prepare("UPDATE prompt_jobs SET dispatch_kind = 'steering', parent_prompt_id = 'parent' WHERE id = 's2'").run();
    expect(store.recoverRunningPrompts()).toBe(0);
    expect(store.claimNextReadyPrompt("b1")).toMatchObject({ id: "s2", dispatchKind: "turn" });
  });

  it("marks interrupted steering as uncertain instead of replaying it", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "s1", bindingId: "b1", title: "Steer", workspaceId: "w1", paneId: "w1:p1", requestText: "steer", queuePosition: 0, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "s1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "steer", dispatchKind: "steering", parentPromptId: "parent" }, view, rootMessageId: "m1", taskCard: {}, answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, `${reply.cardRole}-card-s1`, "cardkit-s1");
    expect(store.claimNextReadySteering("b1", "parent")?.id).toBe("s1");

    expect(store.recoverRunningPrompts()).toBe(1);
    expect(store.loadRunCard("s1")).toMatchObject({ phase: "failed", notice: "Steering 投递结果无法确认，请检查 Herdr pane 后按需重试" });
    expect(store.claimNextReadyPrompt("b1")).toBeNull();
  });
});
