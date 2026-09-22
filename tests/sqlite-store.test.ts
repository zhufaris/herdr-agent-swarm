import { afterEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { createBridgeEvent } from "../src/domain/create-bridge-event.js";
import { initialTopicView, reduceTopicView } from "../src/domain/topic-view.js";
import { answerElementId, createQueuedRunCard } from "../src/domain/run-card-view.js";
import { renderRequestAnswerCard } from "../src/cards/run-card.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { createQueuedWorkerTurnCard } from "../src/domain/worker-turn-card-view.js";
import { renderWorkerTurnCard } from "../src/cards/worker-turn-card.js";
import { InstanceTurnCapacityExceeded } from "../src/domain/instance-turn-capacity-error.js";
import { createWorkerMainView, reduceWorkerMainView } from "../src/domain/worker-main-view.js";
import { outboundLaneHeadSelectionSql } from "../src/store/sqlite/outbox-queue-store.js";
import { renderWorkerHumanReviewNotification } from "../src/cards/worker-human-review-notification.js";
import { materializeOutboundReply } from "../src/events/outbound-intent-materializer.js";
import { answerPageDeliveryFactsSql } from "../src/store/sqlite/projection-store.js";

let store: SqliteBindingStore | undefined;
let temporaryDirectory: string | undefined;
afterEach(() => {
  store?.close();
  store = undefined;
  if (temporaryDirectory) rmSync(temporaryDirectory, { recursive: true, force: true });
  temporaryDirectory = undefined;
});

function prepareSupersededAnswerCandidate(candidateStore: SqliteBindingStore): { replacementId: string; projectionKey: string } {
  candidateStore.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
  const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
  candidateStore.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
  candidateStore.markOutboundReplyDelivered(candidateStore.listPendingOutboundReplies()[0]!.id, "answer-old", "card-old");
  candidateStore.enqueueOutboundReply({ id: "old-update", idempotencyKey: "old-update", bindingId: "b1", promptId: "p1", viewVersion: 2, cardRole: "answer", rootMessageId: "answer-old", kind: "card_update", payload: "{}" });
  const oldClaim = candidateStore.claimOutboundReply("old-update", null)!;
  candidateStore.markOutboundReplyFailedWithQuarantine(oldClaim, "response timeout", { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: null, larkErrorCode: null });
  candidateStore.database.prepare("UPDATE answer_pages SET state = 'frozen', delivery_mode = 'static' WHERE prompt_id = 'p1' AND page_index = 0").run();
  candidateStore.reserveStaticAnswerReplacement({
    promptId: "p1", previousPageIndex: 0, nextPageIndex: 1, sourceStart: 0, nextElementId: answerElementId("p1", 1),
    rootMessageId: "root-1", viewVersion: 3, card: {}
  });
  const replacement = candidateStore.listPendingOutboundReplies().find((reply) => reply.kind === "stream_card_create")!;
  candidateStore.checkpointOutboundReplyCard(replacement.id, "card-new");
  candidateStore.markOutboundReplyDelivered(replacement.id, "answer-new", "card-new");
  for (const revision of [1, 2, 3]) {
    candidateStore.reserveStaticAnswerCardUpdate({ promptId: "p1", pageIndex: 1, messageId: "answer-new", card: { revision } });
  }
  return { replacementId: replacement.id, projectionKey: "answer-static:p1:1:answer-new" };
}

function prepareSupersededWorkerMainCandidate(candidateStore: SqliteBindingStore): { failedId: string; successorId: string } {
  candidateStore.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "primary-root", title: "Primary" });
  const worker = candidateStore.createWorkerAgentInstance({
    id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
    parent: { bindingId: "b1", bindingGeneration: 1, paneId: "w1:primary", nativeSessionId: "primary-session" },
    workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
  }, 4);
  if (worker.outcome !== "created") throw new Error("expected Worker");
  const initial = { ...createWorkerMainView({
    workerId: "reviewer", workerSessionGeneration: 1, parentBindingId: "b1", parentBindingGeneration: 1, parentPaneId: "w1:primary", workerName: "reviewer", ownerName: "Primary",
    runtimeGeneration: worker.instance.generation, runtimeState: worker.instance.observedState, runtimeAttached: false, desiredState: "running", parentActive: true, paneId: null, workspace: "/repo", branch: null, model: null, occurredAt: "2026-09-19T00:00:00.000Z"
  }), messageId: "worker-main", cardId: "worker-card", viewVersion: 2, deliveredVersion: 1 };
  candidateStore.reserveWorkerMainCard(initial, "primary-root", { version: 2 });
  const failed = candidateStore.listPendingOutboundReplies().find(({ workerId }) => workerId === "reviewer")!;
  const claim = candidateStore.claimOutboundReply(failed.id, null)!;
  candidateStore.markOutboundReplyFailedWithQuarantine(claim, "response timeout", { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: null, larkErrorCode: null });
  candidateStore.reserveWorkerMainCard({ ...initial, viewVersion: 3, updatedAt: "2026-09-19T00:01:00.000Z" }, "primary-root", { version: 3 });
  const successor = candidateStore.listPendingOutboundReplies().find(({ workerId }) => workerId === "reviewer")!;
  return { failedId: failed.id, successorId: successor.id };
}

describe("SQLite store", () => {
  describe("outbound delivery claims", () => {
    it("stores new delivery intents without duplicating the canonical payload", () => {
      store = new SqliteBindingStore(":memory:");
      store.enqueueOutboundReply({ id: "v2", idempotencyKey: "v2", rootMessageId: "message", kind: "card_update", payload: '{"large":"body"}' });

      const row = store.database.prepare("SELECT payload, intent_json FROM outbound_replies WHERE id = 'v2'").get() as { payload: string; intent_json: string };
      expect(row.payload).toBe('{"large":"body"}');
      expect(JSON.parse(row.intent_json)).toEqual({ schemaVersion: 2, kind: "card" });
      expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 46").get()).toEqual({ version: 46 });
    });

    it("compacts only equivalent inactive version 1 delivery intents", () => {
      store = new SqliteBindingStore(":memory:");
      for (const id of ["safe", "mismatch", "malformed", "active"]) {
        store.enqueueOutboundReply({ id, idempotencyKey: id, rootMessageId: id, kind: "card_update", payload: `{"id":"${id}"}` });
        store.database.prepare("UPDATE outbound_replies SET intent_json = json_object('schemaVersion', 1, 'kind', 'card', 'materializedPayload', payload) WHERE id = ?").run(id);
      }
      store.database.prepare("UPDATE outbound_replies SET intent_json = json_object('schemaVersion', 1, 'kind', 'card', 'materializedPayload', 'different') WHERE id = 'mismatch'").run();
      store.database.prepare("UPDATE outbound_replies SET intent_json = '{' WHERE id = 'malformed'").run();
      const claim = store.claimOutboundReply("active", null)!;

      expect(store.compactDeliveryIntents(10)).toBe(1);
      expect(JSON.parse((store.database.prepare("SELECT intent_json FROM outbound_replies WHERE id = 'safe'").get() as { intent_json: string }).intent_json)).toEqual({ schemaVersion: 2, kind: "card" });
      expect(JSON.parse((store.database.prepare("SELECT intent_json FROM outbound_replies WHERE id = 'mismatch'").get() as { intent_json: string }).intent_json)).toMatchObject({ schemaVersion: 1, materializedPayload: "different" });
      expect((store.database.prepare("SELECT intent_json FROM outbound_replies WHERE id = 'malformed'").get() as { intent_json: string }).intent_json).toBe("{");
      expect(JSON.parse((store.database.prepare("SELECT intent_json FROM outbound_replies WHERE id = 'active'").get() as { intent_json: string }).intent_json)).toMatchObject({ schemaVersion: 1 });
      expect(store.markOutboundReplyFailedWithQuarantine(claim, "retry", { failureClass: "transient", effectCertainty: "rejected", httpStatus: 503, larkErrorCode: null })).not.toBeNull();
      expect(store.compactDeliveryIntents(10)).toBe(0);
      const retry = store.claimOutboundReply("active", null)!;
      expect(store.markOutboundReplyDelivered(retry, "active")).toBe(true);
      expect(store.compactDeliveryIntents(10)).toBe(1);
      expect(JSON.parse((store.database.prepare("SELECT intent_json FROM outbound_replies WHERE id = 'active'").get() as { intent_json: string }).intent_json)).toEqual({ schemaVersion: 2, kind: "card" });
    });

    it("keeps version 1 intents deliverable across reopen before incremental compaction", () => {
      temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-delivery-intent-v2-"));
      const databasePath = join(temporaryDirectory, "bridge.db");
      store = new SqliteBindingStore(databasePath);
      store.enqueueOutboundReply({ id: "legacy-v1", idempotencyKey: "legacy-v1", rootMessageId: "message", kind: "card_update", payload: '{"canonical":true}' });
      store.database.prepare("UPDATE outbound_replies SET intent_json = json_object('schemaVersion', 1, 'kind', 'card', 'materializedPayload', '{\"legacy\":true}') WHERE id = 'legacy-v1'").run();
      store.close();

      store = new SqliteBindingStore(databasePath);
      expect(materializeOutboundReply(store.getOutboundReply("legacy-v1")!)).toBe('{"legacy":true}');
      expect(store.compactDeliveryIntents(10)).toBe(0);
    });

    it("claims only a due lane head and rejects stale acknowledgements, failures and checkpoints", () => {
      store = new SqliteBindingStore(":memory:");
      for (const id of ["first", "next"]) store.enqueueOutboundReply({ id, idempotencyKey: id, rootMessageId: "message", kind: "card_update", payload: "{}" });
      expect(store.claimOutboundReply("next", null)).toBeNull();
      expect(store.claimOutboundReply("first", "2000-01-01T00:00:00.000Z")).toBeNull();
      const first = store.claimOutboundReply("first", null)!;
      expect(store.claimOutboundReply("first", null)).toBeNull();
      expect(store.listOutboundLaneHeads(10, null)).toEqual([]);
      expect(store.markOutboundReplyDelivered("first", "message")).toBe(false);
      expect(store.checkpointOutboundReplyCard(first, "card")).not.toBeNull();
      expect(store.markOutboundReplyFailedWithQuarantine(first, "temporary", { failureClass: "transient", httpStatus: 503, larkErrorCode: null })).not.toBeNull();
      const retry = store.claimOutboundReply("first", null)!;
      expect(retry.attemptId).not.toBe(first.attemptId);
      expect(retry.payloadHash).toBe(first.payloadHash);
      expect(retry.reply.cardIdCheckpoint).toBe("card");
      expect(store.markOutboundReplyDelivered(first, "wrong-message")).toBe(false);
      expect(store.checkpointOutboundReplyCard(first, "wrong-card")).toBeNull();
      expect(store.markOutboundReplyFailedWithQuarantine(first, "late", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null })).toBeNull();
      expect(store.markOutboundReplyDelivered(retry, "message")).toBe(true);
      expect(store.markOutboundReplyDelivered(retry, "duplicate")).toBe(false);
      expect(store.claimOutboundReply("next", null)).not.toBeNull();
    });

    it("blocks mutation and deletion of an in-flight revision in SQLite", () => {
      store = new SqliteBindingStore(":memory:");
      store.enqueueOutboundReply({ id: "first", idempotencyKey: "first", rootMessageId: "message", kind: "card_update", payload: "{}" });
      const claim = store.claimOutboundReply("first", null)!;
      expect(() => store!.database.prepare("UPDATE outbound_replies SET payload = '{\"v\":2}' WHERE id = 'first'").run()).toThrow("immutable_outbound_revision");
      expect(() => store!.database.prepare("DELETE FROM outbound_replies WHERE id = 'first'").run()).toThrow("active_outbound_claim");
      expect(() => store!.database.prepare("UPDATE outbound_replies SET snapshot_revision = 2 WHERE id = 'first'").run()).toThrow("immutable_outbound_revision");
      expect(() => store!.database.prepare("UPDATE outbound_replies SET work_class = 'history' WHERE id = 'first'").run()).toThrow("immutable_outbound_revision");
      expect(() => store!.database.prepare("UPDATE outbound_replies SET first_claimed_at = NULL WHERE id = 'first'").run()).toThrow("immutable_outbound_revision");
      store.markOutboundReplyFailedWithQuarantine(claim, "retry", { failureClass: "transient", httpStatus: 429, larkErrorCode: null });
      expect(() => store!.enqueueOutboundReply({ id: "replacement", idempotencyKey: "first", rootMessageId: "message", kind: "card_update", payload: "changed" })).toThrow("outbound_idempotency_conflict");
    });

    it("freezes a Gateway plan onto a released legacy claim exactly once", () => {
      store = new SqliteBindingStore(":memory:");
      store.enqueueOutboundReply({ id: "legacy", idempotencyKey: "legacy", rootMessageId: "message", kind: "card_reply", payload: "{}" });
      const claim = store.claimOutboundReply("legacy", null)!;
      expect(store.prepareOutboundGatewayPlan("legacy", { gatewayId: "feishu:primary", gatewayProfileId: "feishu-cardkit-v1", gatewayPlanJson: '{"operation":"message.reply.view"}' })).toBeNull();
      expect(store.markOutboundReplyFailedWithQuarantine(claim, "retry", { failureClass: "transient", effectCertainty: "rejected", httpStatus: 429, larkErrorCode: null }, 1_000)).not.toBeNull();

      const prepared = store.prepareOutboundGatewayPlan("legacy", { gatewayId: "feishu:primary", gatewayProfileId: "feishu-cardkit-v1", gatewayPlanJson: '{"operation":"message.reply.view"}' });
      expect(prepared).toMatchObject({ gatewayId: "feishu:primary", gatewayProfileId: "feishu-cardkit-v1", gatewayPlanJson: '{"operation":"message.reply.view"}', gatewayPlanHash: expect.any(String) });
      expect(store.prepareOutboundGatewayPlan("legacy", { gatewayId: "feishu:primary", gatewayProfileId: "feishu-cardkit-v1", gatewayPlanJson: '{"operation":"message.reply.view"}' })).toEqual(prepared);
      expect(() => store!.prepareOutboundGatewayPlan("legacy", { gatewayId: "feishu:primary", gatewayProfileId: "feishu-cardkit-v1", gatewayPlanJson: '{"operation":"message.reply.text"}' })).toThrow("outbound_gateway_plan_conflict");
    });

    it("reuses an identical pre-startup live intent without rewriting its work class", () => {
      store = new SqliteBindingStore(":memory:");
      const live = store.enqueueOutboundReply({ id: "live", idempotencyKey: "same-effect", rootMessageId: "message", kind: "card_update", payload: "{}" });

      expect(store.enqueueOutboundReply({ id: "history", idempotencyKey: "same-effect", workClass: "history", rootMessageId: "message", kind: "card_update", payload: "{}" })).toEqual(live);
      expect(store.getOutboundReply("live")).toMatchObject({ workClass: "live", state: "pending" });
      expect(() => store!.enqueueOutboundReply({ id: "changed", idempotencyKey: "same-effect", workClass: "history", rootMessageId: "message", kind: "card_update", payload: "changed" })).toThrow("outbound_idempotency_conflict");
    });

    it("quarantines an uncertain effect and requires explicit manual retry", () => {
      store = new SqliteBindingStore(":memory:");
      store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
      store.enqueueOutboundReply({ id: "uncertain", idempotencyKey: "uncertain", bindingId: "b1", rootMessageId: "root", kind: "card_reply", payload: "{}" });
      const claim = store.claimOutboundReply("uncertain", null)!;

      expect(store.markOutboundReplyFailedWithQuarantine(claim, "headers timeout", { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: null, larkErrorCode: null })).toMatchObject({
        state: "dead_letter", action: "blocked", reply: { effectCertainty: "uncertain" }
      });
      expect(store.recoverEligibleDeadLetters("2099-01-01T00:00:00.000Z", 100)).toEqual([]);
      expect(store.getOperationalSummary()).toMatchObject({ uncertainDeliveryEffects: 1, eligibleDeadLetterRecoveries: 0, outboxQuarantines: { active: 1 } });

      expect(store.retryDeadLetter("uncertain", "c1", "admin")).toBe("retried");
      expect(store.getOutboundReply("uncertain")).toMatchObject({ state: "pending", effectCertainty: "uncertain" });
      const retried = store.claimOutboundReply("uncertain", null)!;
      expect(store.markOutboundReplyDelivered(retried, "message")).toBe(true);
      expect(store.getOutboundReply("uncertain")).toMatchObject({ state: "delivered", effectCertainty: null });
    });

    it("does not let semantic recovery override an uncertain external effect", () => {
      store = new SqliteBindingStore(":memory:");
      store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
      store.updateBinding("b1", { statusMessageId: "main-1" });
      store.reserveMainCard({ ...initialTopicView("b1"), viewVersion: 2, deliveredVersion: 1 }, "root", { version: 2 });
      const failed = store.listPendingOutboundReplies()[0]!;
      const claim = store.claimOutboundReply(failed.id, null)!;

      expect(store.markOutboundReplyFailedWithQuarantine(claim, "ambiguous reset", { failureClass: "permanent", effectCertainty: "uncertain", httpStatus: null, larkErrorCode: "300317", recoveryKind: "stale_main_card" })).toMatchObject({
        state: "dead_letter", action: "blocked", reply: { failureClass: "unknown", effectCertainty: "uncertain" }
      });
      expect(store.getBinding("b1")?.statusMessageId).toBe("main-1");
      expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE kind = 'card_reply' AND state = 'pending'").get()).toEqual({ count: 0 });
    });

    it("ignores an uncertain receipt from an earlier delivery attempt", () => {
      store = new SqliteBindingStore(":memory:");
      store.enqueueOutboundReply({ id: "first", idempotencyKey: "first", rootMessageId: "message", kind: "card_update", payload: "{}" });
      const first = store.claimOutboundReply("first", null)!;
      store.markOutboundReplyFailedWithQuarantine(first, "connect refused", { failureClass: "transient", effectCertainty: "not-started", httpStatus: null, larkErrorCode: null });
      const second = store.claimOutboundReply("first", null)!;

      expect(store.markOutboundReplyFailedWithQuarantine(first, "late timeout", { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: null, larkErrorCode: null })).toBeNull();
      expect(store.getOutboundReply("first")).toMatchObject({ state: "pending", effectCertainty: "not-started" });
      expect(store.markOutboundReplyDelivered(second, "message")).toBe(true);
    });

    it("quarantines an uncertain prior-owner claim after reopening without replaying it", () => {
      temporaryDirectory = mkdtempSync(join(tmpdir(), "outbox-claim-"));
      const path = join(temporaryDirectory, "state.sqlite");
      store = new SqliteBindingStore(path);
      const firstLease = store.acquireInstanceLease("owner-a", new Date().toISOString(), "2099-01-01T00:00:00.000Z")!;
      store.activateWriteFence("owner-a", firstLease.fencingToken);
      store.enqueueOutboundReply({ id: "first", idempotencyKey: "first", rootMessageId: "message", kind: "card_update", payload: "{}" });
      const claim = store.claimOutboundReply("first", null)!;
      store.checkpointOutboundReplyCard(claim, "existing-card");
      store.database.prepare("INSERT INTO outbox_lane_quarantines(lane_key, failed_reply_id, lane_class, failure_class, state, action, reason, created_at, updated_at, released_at) VALUES (?, 'first', 'replaceable_card', 'permanent', 'released', 'released_newer_snapshot', 'old rejection', 'old', 'old', 'old')").run(claim.reply.laneKey);
      store.close();
      store = new SqliteBindingStore(path);
      store.database.prepare("UPDATE instance_lease SET expires_at = '2000-01-01T00:00:00.000Z'").run();
      const lease = store.acquireInstanceLease("owner-b", new Date().toISOString(), "2099-01-01T00:00:00.000Z")!;
      store.activateWriteFence("owner-b", lease.fencingToken);
      expect(store.getOutboundReply("first")).toMatchObject({ state: "dead_letter", failureClass: "unknown", cardIdCheckpoint: "existing-card" });
      expect(store.listOutboundLaneHeads(10, null)).toEqual([]);
      expect(store.markOutboundReplyDelivered(claim, "late-message")).toBe(false);
      expect(store.recoverEligibleDeadLetters("2099-01-01T00:00:00.000Z", 100)).toEqual([]);
      expect(store.database.prepare("SELECT count(*) AS count FROM prompt_jobs").get()).toMatchObject({ count: 0 });
      expect(store.getOperationalSummary()).toMatchObject({ unresolvedDeadLetters: 1 });
      expect(store.database.prepare("SELECT lane_class, failure_class, state, action, released_at FROM outbox_lane_quarantines WHERE lane_key = ?").get(claim.reply.laneKey)).toMatchObject({ lane_class: "immutable", failure_class: "unknown", state: "active", action: "blocked", released_at: null });
    });

    it("releases a retired in-flight claim without acknowledging its projection", () => {
      store = new SqliteBindingStore(":memory:");
      store.enqueueOutboundReply({ id: "first", idempotencyKey: "first", rootMessageId: "message", kind: "card_update", payload: "{}" });
      const claim = store.claimOutboundReply("first", null)!;
      store.database.prepare("UPDATE outbound_replies SET state = 'dismissed' WHERE id = 'first'").run();
      expect(store.markOutboundReplyDelivered(claim, "late-message")).toBe(false);
      expect(store.getOutboundReply("first")).toMatchObject({ state: "dismissed", deliveredMessageId: null });
      store.enqueueOutboundReply({ id: "next", idempotencyKey: "next", rootMessageId: "message", kind: "card_update", payload: "{}" });
      expect(store.claimOutboundReply("next", null)).not.toBeNull();
    });

    it("rejects writes after losing the instance lease", () => {
      store = new SqliteBindingStore(":memory:");
      const lease = store.acquireInstanceLease("owner", new Date().toISOString(), "2099-01-01T00:00:00.000Z")!;
      store.activateWriteFence("owner", lease.fencingToken);
      store.enqueueOutboundReply({ id: "first", idempotencyKey: "first", rootMessageId: "message", kind: "card_update", payload: "{}" });
      const claim = store.claimOutboundReply("first", null)!;
      store.database.prepare("UPDATE instance_lease SET fencing_token = fencing_token + 1").run();
      expect(() => store!.markOutboundReplyDelivered(claim, "message")).toThrow("stale_instance_lease");
      expect(store.getOutboundReply("first")?.state).toBe("pending");
    });
  });
  describe("durable delivery recovery evidence", () => {
    it("keeps a failed snapshot unresolved without any successor", () => {
      store = new SqliteBindingStore(":memory:");
      store.enqueueOutboundReply({ id: "failed", idempotencyKey: "failed", rootMessageId: "message", kind: "card_update", payload: "{}" });
      expect(store.markOutboundReplyFailedWithQuarantine("failed", "rejected", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "230028" })).toMatchObject({ action: "released_newer_snapshot" });
      expect(store.listPendingOutboundReplies()).toEqual([]);
      expect(store.getOutboundReply("failed")).toMatchObject({ state: "dead_letter" });
      expect(store.getOperationalSummary()).toMatchObject({ deadLetters: 1, unresolvedDeadLetters: 1, outboxQuarantines: { active: 0 } });
    });

    it("preserves both failures when another failure overwrites the lane quarantine", () => {
      store = new SqliteBindingStore(":memory:");
      for (const id of ["first", "second"]) {
        store.enqueueOutboundReply({ id, idempotencyKey: id, rootMessageId: "message", kind: "card_update", payload: "{}" });
        store.markOutboundReplyFailedWithQuarantine(id, "rejected", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "230028" });
      }
      expect(store.database.prepare("SELECT failed_reply_id FROM outbox_lane_quarantines").all()).toEqual([{ failed_reply_id: "second" }]);
      expect(store.getOperationalSummary()).toMatchObject({ deadLetters: 2, unresolvedDeadLetters: 2 });
      store.enqueueOutboundReply({ id: "successor", idempotencyKey: "successor", rootMessageId: "message", kind: "card_update", payload: "{}" });
      const claim = store.claimOutboundReply("successor", null)!;
      expect(store.getOperationalSummary().unresolvedDeadLetters).toBe(2);
      expect(store.markOutboundReplyDelivered(claim, "message")).toBe(true);
      expect(store.getOperationalSummary().unresolvedDeadLetters).toBe(0);
      store.pruneDeliveredOutboundReplies("2099-01-01T00:00:00.000Z", 100);
      expect(store.getOperationalSummary().unresolvedDeadLetters).toBe(0);
      expect(store.database.prepare("SELECT failed_reply_id, state, resolved_by_reply_id FROM delivery_recoveries ORDER BY failed_reply_id").all()).toEqual([
        { failed_reply_id: "first", state: "recovered", resolved_by_reply_id: "successor" },
        { failed_reply_id: "second", state: "recovered", resolved_by_reply_id: "successor" }
      ]);
    });
  });

  describe("binding thread aliases", () => {
    it("atomically reserves one group-root create and activates the exact alias on ACK", () => {
      store = new SqliteBindingStore(":memory:");
      store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "chat", topicId: "canonical-topic", rootMessageId: "canonical-root", title: "Task" });
      store.updateBinding("b1", { paneId: "w1:p1", statusMessageId: "canonical-root", state: "active", lifecycle: "active", attachment: "attached" });
      const input = { publicationKey: "pane-entry-1", actionMessageId: "directory", bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", sourceMainMessageId: "canonical-root", targetChatId: "chat", card: { schema: "2.0" } };

      expect(store.reservePaneThreadAlias(input)).toBe("reserved");
      expect(store.reservePaneThreadAlias(input)).toBe("duplicate");
      const [reply] = store.listPendingOutboundReplies();
      expect(reply).toMatchObject({ kind: "group_card_create", rootMessageId: null, targetChatId: "chat", threadAliasId: expect.any(String), intentKind: "group-card" });
      const claim = store.claimOutboundReply(reply!.id, null)!;
      expect(() => store!.database.prepare("UPDATE outbound_replies SET target_chat_id = 'other' WHERE id = ?").run(reply!.id)).toThrow("immutable_outbound_revision");
      expect(store.markOutboundReplyDelivered(claim, "alias-root", undefined, "alias-topic")).toBe(true);
      expect(store.findBindingByLarkScope("alias-topic", "alias-root")).toMatchObject({ id: "b1" });
      expect(store.isBindingThreadAlias("alias-topic", "alias-root")).toBe(true);
      expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });

    it("preserves an active alias across reopen and fails closed after generation changes", () => {
      temporaryDirectory = mkdtempSync(join(tmpdir(), "binding-alias-"));
      const path = join(temporaryDirectory, "state.sqlite");
      store = new SqliteBindingStore(path);
      store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "chat", topicId: "canonical-topic", rootMessageId: "canonical-root", title: "Task" });
      store.updateBinding("b1", { paneId: "w1:p1", statusMessageId: "canonical-root", state: "active", lifecycle: "active", attachment: "attached" });
      store.reservePaneThreadAlias({ publicationKey: "pane-entry-1", actionMessageId: "directory", bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", sourceMainMessageId: "canonical-root", targetChatId: "chat", card: {} });
      const reply = store.listPendingOutboundReplies()[0]!;
      store.markOutboundReplyDelivered(reply.id, "alias-root", undefined, "alias-topic");
      store.close(); store = new SqliteBindingStore(path);
      expect(store.findBindingByLarkScope("alias-topic", "alias-root")).toMatchObject({ id: "b1" });
      store.updateBinding("b1", { generation: 2 });
      expect(store.findBindingByLarkScope("alias-topic", "alias-root")).toBeNull();
    });
  });

  describe("Worker Session threads", () => {
    function activeWorkerStore(messageId: string | null) {
      store = new SqliteBindingStore(":memory:");
      store.createPendingBinding({ id: "b1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "primary-topic", rootMessageId: "primary-root", title: "Primary" });
      store.updateBinding("b1", { paneId: "w1:primary", statusMessageId: "primary-root", state: "active", lifecycle: "active", attachment: "attached" });
      const worker = store.createWorkerAgentInstance({
        id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
        parent: { bindingId: "b1", bindingGeneration: 1, paneId: "w1:primary", nativeSessionId: "primary-session" },
        workspace: { id: "ws-reviewer", kind: "git-worktree", cwd: "/repo/.worktree/reviewer", branch: "swarm/reviewer", baseCommit: "base" }
      }, 4);
      if (worker.outcome !== "created") throw new Error("expected Worker");
      const view = { ...createWorkerMainView({
        workerId: worker.instance.id, workerSessionGeneration: 1, parentBindingId: "b1", parentBindingGeneration: 1, parentPaneId: "w1:primary", workerName: "reviewer", ownerName: "Primary",
        runtimeGeneration: worker.instance.generation, runtimeState: worker.instance.observedState, runtimeAttached: false, desiredState: "running", parentActive: true, paneId: null, workspace: "/repo/.worktree/reviewer", branch: "swarm/reviewer", model: null, occurredAt: "2026-09-11T00:00:00.000Z"
      }), messageId, cardId: messageId ? "canonical-card" : null };
      store.saveWorkerMainView(view);
      return view;
    }

    it("reserves and activates one canonical group-root Worker Main Card", () => {
      const view = activeWorkerStore(null);
      const input = { publicationKey: "worker-thread:reviewer:1", workerId: "reviewer", workerSessionGeneration: 1, parentBindingId: "b1", parentBindingGeneration: 1, parentPaneId: "w1:primary", targetChatId: "chat", mode: "canonical-main" as const, viewVersion: view.viewVersion, card: { schema: "2.0" } };
      expect(store!.workerSessionThreads.reserve(input)).toBe("reserved");
      expect(store!.workerSessionThreads.reserve(input)).toBe("duplicate");
      const [reply] = store!.listPendingOutboundReplies();
      expect(reply).toMatchObject({ kind: "group_card_create", rootMessageId: null, targetChatId: "chat", threadAliasId: null, workerThreadId: expect.any(String), workerId: "reviewer", workerSessionGeneration: 1, laneKey: "gateway:feishu:primary:worker-thread:reviewer:1" });
      const claim = store!.claimOutboundReply(reply!.id, null)!;
      expect(() => store!.database.prepare("UPDATE outbound_replies SET worker_thread_id = NULL WHERE id = ?").run(reply!.id)).toThrow("immutable_outbound_revision");
      expect(store!.markOutboundReplyDelivered(claim, "worker-root", "worker-card", "worker-topic")).toBe(true);
      expect(store!.workerSessionThreads.resolveScope({ chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root" })).toMatchObject({ kind: "active", target: { workerId: "reviewer", rootMessageId: "worker-root" } });
      expect(store!.getOperationalSummary().workerThreads).toMatchObject({ active: 1, reserving: 0, stale: 0, "legacy-unpublished": 0 });
      expect(store!.loadWorkerMainView("reviewer", 1)).toMatchObject({ messageId: "worker-root", cardId: "worker-card", deliveredVersion: view.viewVersion });
      expect(store!.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    });

    it("resolves only the exact active canonical Worker thread for directory forwarding", () => {
      const view = activeWorkerStore(null);
      expect(store!.workerSessionThreads.reserve({ publicationKey: "worker-thread:reviewer:1", workerId: "reviewer", workerSessionGeneration: 1, parentBindingId: "b1", parentBindingGeneration: 1, parentPaneId: "w1:primary", targetChatId: "chat", mode: "canonical-main", viewVersion: view.viewVersion, card: {} })).toBe("reserved");
      const reply = store!.listPendingOutboundReplies()[0]!;
      expect(store!.markOutboundReplyDelivered(store!.claimOutboundReply(reply.id, null)!, "worker-root", "worker-card", "worker-topic")).toBe(true);
      const target = { chatId: "chat", workerId: "reviewer", runtimeGeneration: 1, workerSessionGeneration: 1, parentBindingId: "b1", parentBindingGeneration: 1, parentPaneId: "w1:primary", sourceMainMessageId: "primary-root" };

      expect(store!.workerSessionThreads.resolveCanonicalDirectoryTarget(target)).toEqual({ conversationId: "worker-topic", rootMessageId: "worker-root" });
      expect(store!.workerSessionThreads.resolveCanonicalDirectoryTarget({ ...target, runtimeGeneration: 2 })).toBeNull();
      expect(store!.workerSessionThreads.resolveCanonicalDirectoryTarget({ ...target, chatId: "other-chat" })).toBeNull();
      expect(store!.workerSessionThreads.resolveCanonicalDirectoryTarget({ ...target, parentPaneId: "w1:old" })).toBeNull();
      expect(store!.workerSessionThreads.resolveCanonicalDirectoryTarget({ ...target, sourceMainMessageId: "old-main" })).toBeNull();
      store!.database.prepare("UPDATE worker_session_threads SET mode = 'legacy-entry', source_main_message_id = 'worker-root' WHERE worker_id = 'reviewer'").run();
      expect(store!.workerSessionThreads.resolveCanonicalDirectoryTarget(target)).toBeNull();
    });

    it("releases one Primary entry only after canonical Worker Thread activation", () => {
      const view = activeWorkerStore(null);
      const command = store!.acceptCommandIntent({ id: "worker-create", idempotencyKey: "worker-create", laneKey: "binding:b1", command: { kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: true }, context: { projectId: "p1", chatId: "chat", topicId: "primary-topic", rootMessageId: "primary-root", actorOpenId: "operator", sourceMessageId: "source", primary: { bindingId: "b1", bindingGeneration: 1, paneId: "w1:primary", terminalId: null, nativeSession: null, activePromptId: null } }, replayPolicy: "reconcilable", acceptedAt: "2026-09-13T00:00:00.000Z" }).intent;
      expect(store!.claimNextCommandIntent()).toMatchObject({ id: command.id });
      expect(store!.registerWorkerThreadEntry({ commandIntentId: command.id, workerId: "reviewer", workerSessionGeneration: 1, bindingId: "b1", bindingGeneration: 1, rootMessageId: "primary-root" })).toBe(true);
      const revisionAfterRegistration = store!.listPendingCardContextInvalidations().find(({ targetKind, targetId }) => targetKind === "worker-session" && targetId === "reviewer")!.requestedDependencyRevision;
      expect(store!.registerWorkerThreadEntry({ commandIntentId: command.id, workerId: "reviewer", workerSessionGeneration: 1, bindingId: "b1", bindingGeneration: 1, rootMessageId: "primary-root" })).toBe(false);
      expect(() => store!.registerWorkerThreadEntry({ commandIntentId: command.id, workerId: "reviewer", workerSessionGeneration: 1, bindingId: "b1", bindingGeneration: 1, rootMessageId: "different-root" })).toThrow("conflicts with existing command intent");
      expect(store!.database.prepare("SELECT COUNT(*) AS count FROM worker_thread_entry_requests WHERE command_intent_id = 'worker-create'").get()).toEqual({ count: 1 });
      expect(store!.listPendingCardContextInvalidations().find(({ targetKind, targetId }) => targetKind === "worker-session" && targetId === "reviewer")).toMatchObject({ requestedDependencyRevision: revisionAfterRegistration });
      const input = { publicationKey: "worker-thread:reviewer:1", workerId: "reviewer", workerSessionGeneration: 1, parentBindingId: "b1", parentBindingGeneration: 1, parentPaneId: "w1:primary", targetChatId: "chat", mode: "canonical-main" as const, viewVersion: view.viewVersion, card: { schema: "2.0" } };
      expect(store!.workerSessionThreads.reserve(input)).toBe("reserved");
      expect(store!.listPendingOutboundReplies()).toHaveLength(1);
      const group = store!.listPendingOutboundReplies()[0]!;
      expect(store!.markOutboundReplyDelivered(store!.claimOutboundReply(group.id, null)!, "worker-root", "worker-card", "worker-topic")).toBe(true);

      const invalidation = store!.listPendingCardContextInvalidations().find(({ targetKind, targetId }) => targetKind === "worker-session" && targetId === "reviewer");
      expect(invalidation).toBeDefined();
      const outcome = store!.projectCardContext(invalidation!, { workerMain: () => ({ schema: "2.0" }), workerThreadEntryReady: (entry) => ({ entry }), workerTask: () => ({ schema: "2.0" }), primaryMain: () => ({ schema: "2.0" }), primaryPaneEntry: () => ({ schema: "2.0" }), primaryAnswer: () => ({ schema: "2.0" }) });
      expect(outcome).toBe("reserved");
      const entries = store!.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey === "worker-thread-entry:worker-create");
      expect(entries).toHaveLength(1);
      expect(entries[0]).toMatchObject({ bindingId: "b1", rootMessageId: "primary-root", kind: "card_reply" });
      expect(JSON.parse(entries[0]!.payload)).toEqual({ entry: { workerName: "reviewer", workerId: "reviewer", workerSessionGeneration: 1, messageId: "worker-root" } });
      expect(store!.database.prepare("SELECT state FROM worker_thread_entry_requests WHERE command_intent_id = 'worker-create'").get()).toEqual({ state: "reserved" });
      store!.projectCardContext(invalidation!, { workerMain: () => ({ schema: "2.0" }), workerThreadEntryReady: (entry) => ({ entry }), workerTask: () => ({ schema: "2.0" }), primaryMain: () => ({ schema: "2.0" }), primaryPaneEntry: () => ({ schema: "2.0" }), primaryAnswer: () => ({ schema: "2.0" }) });
      expect(store!.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey === "worker-thread-entry:worker-create")).toHaveLength(1);
    });

    it("releases a Primary entry registered after the canonical Worker Main Card is current", () => {
      const view = activeWorkerStore(null);
      const input = { publicationKey: "worker-thread:reviewer:1", workerId: "reviewer", workerSessionGeneration: 1, parentBindingId: "b1", parentBindingGeneration: 1, parentPaneId: "w1:primary", targetChatId: "chat", mode: "canonical-main" as const, viewVersion: view.viewVersion, card: { schema: "2.0" } };
      expect(store!.workerSessionThreads.reserve(input)).toBe("reserved");
      const group = store!.listPendingOutboundReplies().find(({ kind }) => kind === "group_card_create")!;
      expect(store!.markOutboundReplyDelivered(store!.claimOutboundReply(group.id, null)!, "worker-root", "worker-card", "worker-topic")).toBe(true);

      const renderers = { workerMain: () => ({ schema: "2.0" }), workerThreadEntryReady: (entry: object) => ({ entry }), workerTask: () => ({ schema: "2.0" }), primaryMain: () => ({ schema: "2.0" }), primaryPaneEntry: () => ({ schema: "2.0" }), primaryAnswer: () => ({ schema: "2.0" }) };
      for (const invalidation of store!.listPendingCardContextInvalidations()) store!.projectCardContext(invalidation, renderers);
      expect(store!.listPendingCardContextInvalidations()).toEqual([]);

      const command = store!.acceptCommandIntent({ id: "late-worker-create", idempotencyKey: "late-worker-create", laneKey: "binding:b1", command: { kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: true }, context: { projectId: "p1", chatId: "chat", topicId: "primary-topic", rootMessageId: "primary-root", actorOpenId: "operator", sourceMessageId: "source", primary: { bindingId: "b1", bindingGeneration: 1, paneId: "w1:primary", terminalId: null, nativeSession: null, activePromptId: null } }, replayPolicy: "reconcilable", acceptedAt: "2026-09-13T00:00:00.000Z" }).intent;
      expect(store!.claimNextCommandIntent()).toMatchObject({ id: command.id });
      expect(store!.registerWorkerThreadEntry({ commandIntentId: command.id, workerId: "reviewer", workerSessionGeneration: 1, bindingId: "b1", bindingGeneration: 1, rootMessageId: "primary-root" })).toBe(true);

      const [invalidation] = store!.listPendingCardContextInvalidations();
      expect(invalidation).toMatchObject({ targetKind: "worker-session", targetId: "reviewer", targetGeneration: 1, reason: "worker-thread-entry.registered" });
      expect(store!.projectCardContext(invalidation!, renderers)).toBe("reserved");
      expect(store!.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey === "worker-thread-entry:late-worker-create")).toHaveLength(1);
      expect(store!.database.prepare("SELECT state FROM worker_thread_entry_requests WHERE command_intent_id = 'late-worker-create'").get()).toEqual({ state: "reserved" });
    });

    it("converges generation-current pending Primary entries on every startup", () => {
      temporaryDirectory = mkdtempSync(join(tmpdir(), "worker-entry-backfill-"));
      const path = join(temporaryDirectory, "state.sqlite");
      store = new SqliteBindingStore(path);
      store.createPendingBinding({ id: "b1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "primary-topic", rootMessageId: "primary-root", title: "Primary" });
      store.updateBinding("b1", { paneId: "w1:primary", statusMessageId: "primary-root", state: "active", lifecycle: "active", attachment: "attached" });
      const worker = store.createWorkerAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", parent: { bindingId: "b1", bindingGeneration: 1, paneId: "w1:primary", nativeSessionId: "primary-session" }, workspace: { id: "ws-reviewer", kind: "git-worktree", cwd: "/repo/reviewer", branch: "reviewer", baseCommit: "base" } }, 4);
      if (worker.outcome !== "created") throw new Error("expected Worker");
      const view = createWorkerMainView({ workerId: "reviewer", workerSessionGeneration: 1, parentBindingId: "b1", parentBindingGeneration: 1, parentPaneId: "w1:primary", workerName: "reviewer", ownerName: "Primary", runtimeGeneration: worker.instance.generation, runtimeState: worker.instance.observedState, runtimeAttached: false, desiredState: "running", parentActive: true, paneId: null, workspace: "/repo/reviewer", branch: "reviewer", model: null, occurredAt: "2026-09-13T00:00:00.000Z" });
      store.saveWorkerMainView(view);
      expect(store.workerSessionThreads.reserve({ publicationKey: "worker-thread:reviewer:1", workerId: "reviewer", workerSessionGeneration: 1, parentBindingId: "b1", parentBindingGeneration: 1, parentPaneId: "w1:primary", targetChatId: "chat", mode: "canonical-main", viewVersion: view.viewVersion, card: {} })).toBe("reserved");
      const group = store.listPendingOutboundReplies().find(({ kind }) => kind === "group_card_create")!;
      expect(store.markOutboundReplyDelivered(store.claimOutboundReply(group.id, null)!, "worker-root", "worker-card", "worker-topic")).toBe(true);
      for (const id of ["current-entry", "stale-entry"]) {
        store.acceptCommandIntent({ id, idempotencyKey: id, laneKey: `binding:b1:${id}`, command: { kind: "worker_create", name: "reviewer", agentKind: "traex", model: null, start: true }, context: { projectId: "p1", chatId: "chat", topicId: "primary-topic", rootMessageId: "primary-root", actorOpenId: "operator", sourceMessageId: id, primary: { bindingId: "b1", bindingGeneration: 1, paneId: "w1:primary", terminalId: null, nativeSession: null, activePromptId: null } }, replayPolicy: "reconcilable", acceptedAt: "2026-09-13T00:00:00.000Z" });
        expect(store.claimNextCommandIntent(`binding:b1:${id}`)).toMatchObject({ id });
        expect(store.registerWorkerThreadEntry({ commandIntentId: id, workerId: "reviewer", workerSessionGeneration: 1, bindingId: "b1", bindingGeneration: 1, rootMessageId: "primary-root" })).toBe(true);
      }
      store.database.prepare("UPDATE worker_thread_entry_requests SET worker_session_generation = 2 WHERE command_intent_id = 'stale-entry'").run();
      store.database.exec("DELETE FROM card_context_invalidations");
      store.close(); store = new SqliteBindingStore(path);

      expect(store.listPendingCardContextInvalidations()).toEqual([expect.objectContaining({ targetKind: "worker-session", targetId: "reviewer", targetGeneration: 1, reason: "startup.worker-thread-entry-backfill" })]);
      expect(store.database.prepare("SELECT state FROM worker_thread_entry_requests WHERE command_intent_id = 'stale-entry'").get()).toEqual({ state: "stale" });
      expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 43").get()).toEqual({ version: 43 });
      store.close(); store = new SqliteBindingStore(path);
      expect(store.listPendingCardContextInvalidations()).toEqual([expect.objectContaining({ requestedDependencyRevision: 1, projectedDependencyRevision: 0 })]);
    });

    it("activates a passive legacy entry without moving the canonical Worker Main Card", () => {
      const view = activeWorkerStore("canonical-worker-main");
      const fencedTarget = { instanceId: "reviewer", runtimeGeneration: 1, workerSessionGeneration: 1, bindingId: "b1", bindingGeneration: 1, conversationKey: "binding:b1", parentPaneId: "w1:primary", sourceMainMessageId: "primary-root" };
      expect(store!.workerSessionThreads.reserveLegacyEntry({ actionMessageId: "stale-pane", chatId: "chat", target: { ...fencedTarget, parentPaneId: "w1:old" }, render: () => ({}) })).toEqual({ kind: "stale" });
      expect(store!.workerSessionThreads.reserveLegacyEntry({ actionMessageId: "stale-main", chatId: "chat", target: { ...fencedTarget, sourceMainMessageId: "old-main" }, render: () => ({}) })).toEqual({ kind: "stale" });
      const input = { publicationKey: "worker-entry:reviewer:1", actionMessageId: "instances-card", workerId: "reviewer", workerSessionGeneration: 1, parentBindingId: "b1", parentBindingGeneration: 1, parentPaneId: "w1:primary", targetChatId: "chat", mode: "legacy-entry" as const, sourceMainMessageId: "canonical-worker-main", card: { schema: "2.0" } };
      expect(store!.workerSessionThreads.reserve(input)).toBe("reserved");
      const reply = store!.listPendingOutboundReplies()[0]!;
      expect(store!.markOutboundReplyDelivered(store!.claimOutboundReply(reply.id, null)!, "entry-root", undefined, "entry-topic")).toBe(true);
      expect(store!.workerSessionThreads.resolveScope({ chatId: "chat", topicId: "entry-topic", rootMessageId: "entry-root" })).toMatchObject({ kind: "active", target: { workerId: "reviewer", mode: "legacy-entry" } });
      expect(store!.loadWorkerMainView("reviewer", 1)).toMatchObject({ messageId: "canonical-worker-main", cardId: "canonical-card", deliveredVersion: view.deliveredVersion });
      store!.updateBinding("b1", { generation: 2 });
      expect(store!.workerSessionThreads.resolveScope({ chatId: "chat", topicId: "entry-topic", rootMessageId: "entry-root" })).toMatchObject({ kind: "stale" });
    });

    it("classifies pre-migration Workers without publishing group cards", () => {
      temporaryDirectory = mkdtempSync(join(tmpdir(), "worker-thread-migration-"));
      const path = join(temporaryDirectory, "state.sqlite");
      store = new SqliteBindingStore(path);
      store.createPendingBinding({ id: "b1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "primary-topic", rootMessageId: "primary-root", title: "Primary" });
      store.updateBinding("b1", { paneId: "w1:primary", statusMessageId: "primary-root", state: "active", lifecycle: "active", attachment: "attached" });
      store.createWorkerAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", parent: { bindingId: "b1", bindingGeneration: 1, paneId: "w1:primary", nativeSessionId: null }, workspace: { id: "ws-reviewer", kind: "git-worktree", cwd: "/repo/reviewer", branch: "reviewer", baseCommit: "base" } }, 4);
      store.database.exec("DROP TABLE worker_session_threads; DELETE FROM schema_migrations WHERE version = 35");
      store!.close(); store = undefined;

      store = new SqliteBindingStore(path);
      expect(store.database.prepare("SELECT mode, state, root_message_id FROM worker_session_threads WHERE worker_id = ? AND worker_session_generation = ?").get("reviewer", 1)).toEqual({ mode: "legacy-entry", state: "legacy-unpublished", root_message_id: null });
      expect(store.listPendingOutboundReplies().filter(({ workerThreadId }) => workerThreadId !== null)).toEqual([]);
      expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version IN (35, 36) ORDER BY version").all()).toEqual([{ version: 35 }, { version: 36 }]);
    });
  });

  it("keeps a failed Main rebuild unresolved until its exact replacement is acknowledged", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "locked-main" });
    store.reserveMainCard({ ...initialTopicView("b1"), viewVersion: 2, deliveredVersion: 1 }, "root", { version: 2 });
    const failed = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyFailedWithQuarantine(failed.id, "locked", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "300317", recoveryKind: "stale_main_card" });
    const replacement = store.listPendingOutboundReplies()[0]!;
    expect(store.getOperationalSummary()).toMatchObject({ unresolvedDeadLetters: 1, deliveryRecoveries: { replacement_pending: 1 } });
    const first = store.claimOutboundReply(replacement.id, null)!;
    store.markOutboundReplyFailedWithQuarantine(first, "rejected", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "bad_card" });
    expect(store.getOperationalSummary().unresolvedDeadLetters).toBe(2);
    expect(store.retryDeadLetter(replacement.id, "c1", "admin")).toBe("retried");
    expect(store.getOperationalSummary().deliveryRecoveries).toMatchObject({ unresolved: 1, replacement_pending: 1 });
    const retry = store.claimOutboundReply(replacement.id, null)!;
    expect(store.markOutboundReplyDelivered(first, "stale")).toBe(false);
    expect(store.markOutboundReplyDelivered(retry, "rebuilt-main")).toBe(true);
    expect(store.getOperationalSummary()).toMatchObject({ unresolvedDeadLetters: 0, deliveryRecoveries: { recovered: 2 } });
  });

  it("does not use a Main rebuild receipt to resolve a different binding generation", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "locked-main" });
    store.reserveMainCard({ ...initialTopicView("b1"), viewVersion: 2, deliveredVersion: 1 }, "root", { version: 2 });
    const failed = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyFailedWithQuarantine(failed.id, "locked", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "300317", recoveryKind: "stale_main_card" });
    const replacement = store.listPendingOutboundReplies()[0]!;
    const claim = store.claimOutboundReply(replacement.id, null)!;
    store.database.prepare("UPDATE bindings SET generation = generation + 1 WHERE id = 'b1'").run();
    store.markOutboundReplyDelivered(claim, "rebuilt-main");
    expect(store.getOperationalSummary()).toMatchObject({ unresolvedDeadLetters: 1, deliveryRecoveries: { replacement_pending: 1, recovered: 0 } });
  });

  it("preserves failed receipt evidence across manual retry and authorized dismissal", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.enqueueOutboundReply({ id: "failed", idempotencyKey: "failed", bindingId: "b1", rootMessageId: "root", kind: "text", payload: "message" });
    store.markOutboundReplyFailedWithQuarantine("failed", "original failure", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "bad_request" });
    expect(store.dismissDeadLetter("failed", "other-chat", "admin")).toBe("unauthorized");
    expect(store.getOperationalSummary().deliveryRecoveries.unresolved).toBe(1);
    expect(store.retryDeadLetter("failed", "c1", "admin")).toBe("retried");
    expect(store.getOperationalSummary().deliveryRecoveries.unresolved).toBe(1);
    store.markOutboundReplyFailedWithQuarantine("failed", "second failure", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "bad_request" });
    expect(store.database.prepare("SELECT reason FROM delivery_recoveries WHERE failed_reply_id = 'failed'").get()).toMatchObject({ reason: "original failure" });
    expect(store.dismissDeadLetter("failed", "c1", "admin")).toBe("dismissed");
    store.pruneDeliveredOutboundReplies("2099-01-01T00:00:00.000Z", 100);
    expect(store.getOperationalSummary().deliveryRecoveries).toMatchObject({ unresolved: 0, dismissed: 1, recovered: 0 });
  });

  it("does not resolve failures using another target, same version, or unknown effect", () => {
    store = new SqliteBindingStore(":memory:");
    for (const [id, target, version, failureClass] of [["failed", "target", 2, "permanent"], ["unknown", "unknown-target", 2, "unknown"]] as const) {
      store.enqueueOutboundReply({ id, idempotencyKey: id, rootMessageId: target, kind: "card_update", viewVersion: version, payload: "{}" });
      if (failureClass === "permanent") store.markOutboundReplyFailedWithQuarantine(id, "rejected", { failureClass, httpStatus: 400, larkErrorCode: null });
      else store.markOutboundReplyDeadLetter(id, "uncertain", { failureClass, httpStatus: null, larkErrorCode: null });
    }
    for (const [id, target, version] of [["wrong-target", "another-target", 3], ["same-version", "target", 2], ["unknown-successor", "unknown-target", 3]] as const) {
      store.enqueueOutboundReply({ id, idempotencyKey: id, rootMessageId: target, kind: "card_update", viewVersion: version, payload: "{}" });
      store.markOutboundReplyDelivered(store.claimOutboundReply(id, null)!, target);
    }
    expect(store.getOperationalSummary().unresolvedDeadLetters).toBe(2);
  });

  it("rolls back an acknowledgement when its recovery evidence cannot be committed", () => {
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "failed", idempotencyKey: "failed", rootMessageId: "target", kind: "card_update", payload: "{}" });
    store.markOutboundReplyFailedWithQuarantine("failed", "rejected", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null });
    store.enqueueOutboundReply({ id: "new", idempotencyKey: "new", rootMessageId: "target", kind: "card_update", payload: "{}" });
    const claim = store.claimOutboundReply("new", null)!;
    store.database.exec("CREATE TEMP TRIGGER fail_recovery BEFORE UPDATE ON delivery_recoveries BEGIN SELECT RAISE(ABORT, 'test_recovery_failure'); END");
    expect(() => store!.markOutboundReplyDelivered(claim, "target")).toThrow("test_recovery_failure");
    expect(store.getOutboundReply("new")).toMatchObject({ state: "pending", deliveredMessageId: null });
    expect(store.getOperationalSummary().deliveryRecoveries.unresolved).toBe(1);
    store.database.exec("DROP TRIGGER fail_recovery");
    expect(store.markOutboundReplyDelivered(claim, "target")).toBe(true);
    expect(store.getOperationalSummary().deliveryRecoveries.recovered).toBe(1);
  });

  it("backfills only proven legacy recovery and preserves its evidence across reopen and retention", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "outbox-recovery-"));
    const path = join(temporaryDirectory, "state.sqlite");
    store = new SqliteBindingStore(path);
    for (const id of ["proven", "unproven"]) {
      store.enqueueOutboundReply({ id, idempotencyKey: id, rootMessageId: id, kind: "card_update", payload: "{}" });
      store.markOutboundReplyFailedWithQuarantine(id, "rejected", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "bad_card" });
    }
    store.enqueueOutboundReply({ id: "proof", idempotencyKey: "proof", rootMessageId: "proven", kind: "card_update", payload: "{}" });
    store.markOutboundReplyDelivered("proof", "proven");
    store.database.exec("DROP TRIGGER delivery_recoveries_dead_letter; DROP TABLE delivery_recoveries; DELETE FROM schema_migrations WHERE version = 31");
    store.close();
    store = new SqliteBindingStore(path);
    expect(store.getOperationalSummary()).toMatchObject({ unresolvedDeadLetters: 1, deliveryRecoveries: { recovered: 1, unresolved: 1 } });
    store.pruneDeliveredOutboundReplies("2099-01-01T00:00:00.000Z", 100);
    store.close();
    store = new SqliteBindingStore(path);
    expect(store.getOperationalSummary()).toMatchObject({ unresolvedDeadLetters: 1, deliveryRecoveries: { recovered: 1, unresolved: 1 } });
    expect(store.database.prepare("SELECT resolved_by_reply_id, resolved_message_id FROM delivery_recoveries WHERE failed_reply_id = 'proven'").get()).toMatchObject({ resolved_by_reply_id: "proof", resolved_message_id: "proven" });
  });

  it("atomically accepts an exact human-interruption continuation and consumes its interaction", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task", creatorOpenId: "creator" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1" });
    const parentView = createQueuedRunCard({ promptId: "parent", bindingId: "b1", bindingGeneration: 1, title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "original request", queuePosition: 0, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "parent", bindingId: "b1", larkMessageId: "message-parent", actorOpenId: "creator", body: "original request" }, view: parentView, rootMessageId: "root", answerCard: {} });
    store.database.prepare("UPDATE prompt_jobs SET state = 'failed', observation_state = 'completed', error = ? WHERE id = 'parent'").run("TraeX turn was interrupted by a human operator");
    store.database.prepare("UPDATE run_cards SET phase = 'failed', notice = ?, answer_message_id = 'answer-parent' WHERE prompt_id = 'parent'").run("TraeX turn was interrupted by a human operator");
    store.createCardInteraction({ id: "continue-1", bindingId: "b1", bindingGeneration: 1, actorOpenId: "creator", actionKind: "continuation", parentPromptId: "parent", targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });
    const childView = createQueuedRunCard({ promptId: "child", bindingId: "b1", bindingGeneration: 1, conversionParentPromptId: "parent", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "continue from tests", queuePosition: 1, occurredAt: "now" });
    const input = { interactionId: "continue-1", parentPromptId: "parent", sourceAnswerMessageId: "answer-parent", expectedBindingGeneration: 1, actorOpenId: "creator", accepted: { prompt: { id: "child", bindingId: "b1", larkMessageId: "card:continue-1", actorOpenId: "creator", body: "continue from tests", parentPromptId: "parent" }, view: childView, rootMessageId: "root", answerCard: {}, expectedBindingGeneration: 1 } };

    expect(store.acceptInterruptedContinuation(input)).toMatchObject({ inserted: true, prompt: { id: "child", parentPromptId: "parent" } });
    expect(store.getCardInteraction("continue-1")).toMatchObject({ state: "consumed", resultCode: "continuation" });
    expect(store.acceptInterruptedContinuation(input)).toMatchObject({ inserted: false, prompt: { id: "child" } });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs WHERE lark_message_id = 'card:continue-1'").get()).toEqual({ count: 1 });
  });

  it("migrates durable Worker session identity and context projection tables", () => {
    store = new SqliteBindingStore(":memory:");

    expect(store.database.prepare("PRAGMA table_info(agent_instances)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "worker_session_generation", notnull: 1, dflt_value: "1" })
    ]));
    expect(store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'table' AND name IN ('worker_main_views','card_context_invalidations') ORDER BY name").all()).toEqual([
      { name: "card_context_invalidations" }, { name: "worker_main_views" }
    ]);
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 17").get()).toEqual({ version: 17 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 43").get()).toEqual({ version: 43 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 22").get()).toEqual({ version: 22 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 23").get()).toEqual({ version: 23 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 24").get()).toEqual({ version: 24 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 27").get()).toEqual({ version: 27 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 28").get()).toEqual({ version: 28 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 29").get()).toEqual({ version: 29 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 30").get()).toEqual({ version: 30 });
    const outboxColumns = (store.database.prepare("PRAGMA table_info(outbound_replies)").all() as Array<{ name: string }>).map(({ name }) => name);
    expect(outboxColumns).toEqual(expect.arrayContaining(["intent_kind", "intent_json", "renderer_revision"]));
    const typedIntentTriggers = store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name LIKE 'outbound_replies_typed_intent_%' ORDER BY name").all();
    expect(typedIntentTriggers).toEqual([
      { name: "outbound_replies_typed_intent_insert" },
      { name: "outbound_replies_typed_intent_payload_update" }
    ]);
    expect(store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('instance_turns_primary_source','worker_turn_cards_session_phase') ORDER BY name").all()).toEqual([
      { name: "instance_turns_primary_source" }, { name: "worker_turn_cards_session_phase" }
    ]);
    expect(store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name IN ('outbound_replies_worker_pending','outbound_replies_worker_stream') ORDER BY name").all()).toEqual([
      { name: "outbound_replies_worker_pending" }, { name: "outbound_replies_worker_stream" }
    ]);
  });

  it("backfills TraeX as the Primary Agent kind for legacy bindings and project selections", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-primary-agent-kind-migration-"));
    const path = join(temporaryDirectory, "state.sqlite");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "legacy-binding", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Legacy" });
    store.createProjectSelection({ id: "legacy-selection", commandMessageId: "cmd", chatId: "c1", topicId: null, rootMessageId: "root-selection", actorOpenId: "u1", requestedTitle: null, expiresAt: "2099-01-01T00:00:00.000Z", card: {} });
    store.database.exec("ALTER TABLE bindings DROP COLUMN agent_kind; ALTER TABLE project_selections DROP COLUMN agent_kind");
    store.close();
    store = new SqliteBindingStore(path);

    expect(store.getBinding("legacy-binding")?.agentKind).toBe("traex");
    expect(store.getProjectSelection("legacy-selection")?.agentKind).toBe("traex");
  });

  it("uses the partial ordering index for pending card-context scans", () => {
    store = new SqliteBindingStore(":memory:");
    const insert = store.database.prepare(`INSERT INTO card_context_invalidations(target_kind, target_id, target_generation, requested_dependency_revision, projected_dependency_revision, reason, created_at, updated_at) VALUES ('worker-session', ?, 1, ?, ?, 'test', ?, ?)`);
    for (let index = 0; index < 1_000; index += 1) {
      const pending = index % 100 === 0;
      const timestamp = `2026-09-13T00:00:${String(index % 60).padStart(2, "0")}.${String(index).padStart(3, "0")}Z`;
      insert.run(`worker-${index}`, pending ? 2 : 1, 1, timestamp, timestamp);
    }
    store.database.exec("ANALYZE");

    const details = (store.database.prepare("EXPLAIN QUERY PLAN SELECT * FROM card_context_invalidations WHERE projected_dependency_revision < requested_dependency_revision ORDER BY updated_at, target_kind, target_id, target_generation LIMIT ?").all(100) as Array<{ detail: string }>).map(({ detail }) => detail.toLowerCase());

    expect(details.some((detail) => detail.includes("card_context_invalidations_pending")), details.join(" | " )).toBe(true);
    expect(details.some((detail) => detail.includes("temp b-tree")), details.join(" | " )).toBe(false);
    expect(store.listPendingCardContextInvalidations()).toHaveLength(10);
  });

  it("upgrades the legacy card-context pending index in place", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-card-context-index-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.database.exec(`
      DELETE FROM schema_migrations WHERE version = 43;
      DROP INDEX card_context_invalidations_pending;
      CREATE INDEX card_context_invalidations_pending ON card_context_invalidations(projected_dependency_revision, requested_dependency_revision, updated_at);
    `);
    store.close();
    store = new SqliteBindingStore(path);

    const definition = store.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'index' AND name = 'card_context_invalidations_pending'").get() as { sql: string };
    expect(definition.sql).toContain("WHERE projected_dependency_revision < requested_dependency_revision");
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 43").get()).toEqual({ version: 43 });
  });

  it("terminalizes retired prompt steering exactly once without changing ordinary FIFO work", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-retired-prompt-steering-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const add = (id: string, state: "queued" | "running" | "delivered" | "failed") => {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: null, requestText: id, queuePosition: 1, occurredAt: "2026-09-07T00:00:00.000Z" });
      store!.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `message-${id}`, actorOpenId: "u1", body: id }, view, rootMessageId: "root", answerCard: {} });
      store!.database.prepare("UPDATE prompt_jobs SET state = ?, observation_state = CASE WHEN ? = 'running' THEN 'attached' WHEN ? = 'queued' THEN 'not_started' ELSE 'completed' END, updated_at = '2026-09-07T00:00:00.000Z' WHERE id = ?").run(state, state, state, id);
      store!.database.prepare("UPDATE run_cards SET phase = CASE WHEN ? = 'queued' THEN 'queued' WHEN ? = 'running' THEN 'running' WHEN ? = 'delivered' THEN 'completed' ELSE 'failed' END, view_version = 1, updated_at = '2026-09-07T00:00:00.000Z' WHERE prompt_id = ?").run(state, state, state, id);
    };
    add("ordinary", "queued");
    add("steer-queued", "queued");
    add("steer-running", "running");
    add("steer-done", "delivered");
    store.database.exec(`
      DROP VIEW run_cards_view;
      ALTER TABLE prompt_jobs ADD COLUMN dispatch_kind TEXT NOT NULL DEFAULT 'turn';
      ALTER TABLE prompt_jobs ADD COLUMN steering_origin TEXT;
      ALTER TABLE prompt_jobs ADD COLUMN source_prompt_id TEXT;
      ALTER TABLE run_cards ADD COLUMN steering_origin TEXT;
      ALTER TABLE run_cards ADD COLUMN steering_failure_kind TEXT;
      CREATE INDEX prompt_jobs_queue_kind ON prompt_jobs(binding_id, state, dispatch_kind, created_at);
      CREATE INDEX prompt_jobs_dispatch ON prompt_jobs(binding_id, dispatch_kind, parent_prompt_id, state, created_at);
      CREATE UNIQUE INDEX prompt_jobs_source_prompt_once ON prompt_jobs(source_prompt_id) WHERE source_prompt_id IS NOT NULL;
      UPDATE prompt_jobs SET dispatch_kind = 'steering', steering_origin = 'automatic' WHERE id LIKE 'steer-%';
    `);
    store.database.prepare("DELETE FROM schema_migrations WHERE version = 30").run();
    store.close(); store = undefined;

    store = new SqliteBindingStore(path);
    expect(store.getPrompt("ordinary")).toMatchObject({ state: "queued" });
    expect(store.getPrompt("steer-queued")).toMatchObject({ state: "failed", observationState: "completed", wasDetached: false });
    expect(store.loadRunCard("steer-queued")).toMatchObject({ phase: "failed" });
    expect(store.getPrompt("steer-running")).toMatchObject({ state: "failed", observationState: "completed", wasDetached: true });
    expect(store.loadRunCard("steer-running")).toMatchObject({ phase: "failed" });
    expect(store.getPrompt("steer-done")).toMatchObject({ state: "delivered" });
    expect((store.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map(({ name }) => name)).not.toEqual(expect.arrayContaining(["dispatch_kind", "steering_origin", "source_prompt_id"]));
    expect((store.database.prepare("PRAGMA table_info(prompt_jobs)").all() as Array<{ name: string }>).map(({ name }) => name)).toContain("parent_prompt_id");
    expect((store.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>).map(({ name }) => name)).not.toEqual(expect.arrayContaining(["steering_origin", "steering_failure_kind"]));
    const snapshot = store.database.prepare("SELECT prompt_id, phase, notice, view_version FROM run_cards WHERE prompt_id LIKE 'steer-%' ORDER BY prompt_id").all();
    store.close(); store = undefined;
    store = new SqliteBindingStore(path);
    expect(store.database.prepare("SELECT prompt_id, phase, notice, view_version FROM run_cards WHERE prompt_id LIKE 'steer-%' ORDER BY prompt_id").all()).toEqual(snapshot);
    expect(store.database.prepare("PRAGMA quick_check").get()).toEqual({ quick_check: "ok" });
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("deduplicates Command intents and serializes claims by lane", () => {
    store = new SqliteBindingStore(":memory:");
    const context = { chatId: "chat", topicId: "topic", rootMessageId: "root", sourceMessageId: "message-1", actorOpenId: "admin", projectId: "project", workspaceId: "workspace", primary: null };
    const first = { id: "command-1", idempotencyKey: "lark-message:message-1:new", laneKey: "project:project", command: { kind: "new", title: "One" } as const, context, replayPolicy: "reconcilable" as const, acceptedAt: "2026-09-05T00:00:00.000Z" };
    const second = { ...first, id: "command-2", idempotencyKey: "lark-message:message-2:new", command: { kind: "new", title: "Two" } as const, acceptedAt: "2026-09-05T00:00:01.000Z" };
    const independent = { ...first, id: "command-3", idempotencyKey: "lark-message:message-3:new", laneKey: "project:other", context: { ...context, projectId: "other", sourceMessageId: "message-3" }, acceptedAt: "2026-09-05T00:00:02.000Z" };

    expect(store.acceptCommandIntent(first)).toMatchObject({ outcome: "accepted", intent: { state: "accepted", attemptCount: 0 } });
    expect(store.acceptCommandIntent({ ...first, id: "ignored" })).toMatchObject({ outcome: "duplicate", intent: { id: "command-1" } });
    expect(store.acceptCommandIntent({ ...first, id: "conflict", command: { kind: "new", title: "Changed" } })).toMatchObject({ outcome: "conflict", intent: { id: "command-1" } });
    store.acceptCommandIntent(second);
    store.acceptCommandIntent(independent);

    expect(store.claimNextCommandIntent()).toMatchObject({ id: "command-1", state: "executing", attemptCount: 1 });
    expect(store.claimNextCommandIntent("project:project")).toBeNull();
    expect(store.claimNextCommandIntent()).toMatchObject({ id: "command-3", state: "executing" });
    expect(store.finishCommandIntent("command-1", "succeeded", { code: "created", detail: null, operationKind: "binding", operationId: "binding-1" })).toMatchObject({ state: "succeeded", outcome: { operationId: "binding-1" } });
    expect(store.claimNextCommandIntent("project:project")).toMatchObject({ id: "command-2", state: "executing" });
  });

  it("recovers accepted Command intents and terminalizes executing work as uncertain", () => {
    store = new SqliteBindingStore(":memory:");
    const context = { chatId: "chat", topicId: null, rootMessageId: null, sourceMessageId: "message", actorOpenId: "admin", projectId: null, workspaceId: null, primary: null };
    for (const [index, replayPolicy] of (["safe-before-effect", "non-replayable"] as const).entries()) {
      store.acceptCommandIntent({ id: `command-${index}`, idempotencyKey: `key-${index}`, laneKey: `lane-${index}`, command: { kind: index === 0 ? "close" : "stop" }, context, replayPolicy, acceptedAt: `2026-09-05T00:00:0${index}.000Z` });
    }
    store.claimNextCommandIntent("lane-1");

    expect(store.recoverExecutingCommandIntents("2026-09-05T01:00:00.000Z")).toBe(1);
    expect(store.listRecoverableCommandIntents()).toEqual([
      expect.objectContaining({ id: "command-0", state: "accepted" }),
      expect.objectContaining({ id: "command-1", state: "uncertain", outcome: expect.objectContaining({ code: "restart_during_execution" }) })
    ]);
    expect(store.claimNextCommandIntent("lane-1")).toBeNull();
  });

  it("stages natural-language mutation confirmations atomically and idempotently", () => {
    store = new SqliteBindingStore(":memory:");
    const confirmation = {
      id: "confirmation-1", sourceMessageId: "message-1", actorOpenId: "admin", chatId: "chat", topicId: null, rootMessageId: "message-1",
      envelope: { version: 1, family: "swarm", command: { kind: "new", title: "Fix login", agentKind: "traex" } } as const,
      expectedBindingId: null, expectedBindingGeneration: null, expectedInstanceId: null, expectedInstanceGeneration: null,
      expiresAt: "2026-09-19T01:00:00.000Z", createdAt: "2026-09-19T00:00:00.000Z"
    };
    const input = { confirmation, outbox: { id: "confirmation-card-1", idempotencyKey: "natural-language-confirmation:confirmation-1", card: { type: "confirmation" } } };

    expect(store.stageNaturalLanguageCommandConfirmation(input)).toMatchObject({ outcome: "staged", confirmation: { id: "confirmation-1", state: "pending" } });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ id: "confirmation-card-1", idempotencyKey: "natural-language-confirmation:confirmation-1" })]);
    expect(store.stageNaturalLanguageCommandConfirmation(input)).toMatchObject({ outcome: "duplicate", confirmation: { id: "confirmation-1" } });
    expect(store.stageNaturalLanguageCommandConfirmation({ ...input, confirmation: { ...confirmation, id: "other", actorOpenId: "other" } })).toMatchObject({ outcome: "conflict", confirmation: { id: "confirmation-1" } });
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 47").get()).toEqual({ version: 47 });
  });

  it("consumes or cancels a natural-language confirmation exactly once for its actor and chat", () => {
    store = new SqliteBindingStore(":memory:");
    const stage = (id: string) => store!.stageNaturalLanguageCommandConfirmation({
      confirmation: { id, sourceMessageId: `message-${id}`, actorOpenId: "admin", chatId: "chat", topicId: "topic", rootMessageId: "root", envelope: { version: 1, family: "swarm", command: { kind: "stop" } }, expectedBindingId: null, expectedBindingGeneration: null, expectedInstanceId: null, expectedInstanceGeneration: null, expiresAt: "2026-09-19T01:00:00.000Z", createdAt: "2026-09-19T00:00:00.000Z" },
      outbox: { id: `card-${id}`, idempotencyKey: `confirmation:${id}`, card: {} }
    });
    stage("confirm"); stage("cancel");

    expect(store.decideNaturalLanguageCommandConfirmation({ id: "confirm", decision: "confirm", actorOpenId: "intruder", chatId: "chat", decidedAt: "2026-09-19T00:01:00.000Z" })).toMatchObject({ outcome: "unauthorized", confirmation: { state: "pending" } });
    expect(store.decideNaturalLanguageCommandConfirmation({ id: "confirm", decision: "confirm", actorOpenId: "admin", chatId: "chat", decidedAt: "2026-09-19T00:01:00.000Z" })).toMatchObject({ outcome: "consumed", confirmation: { state: "consumed", resultDetail: "confirmed" } });
    expect(store.decideNaturalLanguageCommandConfirmation({ id: "confirm", decision: "confirm", actorOpenId: "admin", chatId: "chat", decidedAt: "2026-09-19T00:02:00.000Z" })).toMatchObject({ outcome: "already-resolved", confirmation: { state: "consumed" } });
    expect(store.decideNaturalLanguageCommandConfirmation({ id: "cancel", decision: "cancel", actorOpenId: "admin", chatId: "chat", decidedAt: "2026-09-19T00:01:00.000Z" })).toMatchObject({ outcome: "cancelled", confirmation: { state: "cancelled" } });
  });

  it("expires and generation-fences natural-language confirmations before consumption", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Primary" });
    const stage = (id: string, expiresAt: string) => store!.stageNaturalLanguageCommandConfirmation({
      confirmation: { id, sourceMessageId: `message-${id}`, actorOpenId: "admin", chatId: "chat", topicId: "topic", rootMessageId: "root", envelope: { version: 1, family: "swarm", command: { kind: "rename", title: "New title" } }, expectedBindingId: "binding-1", expectedBindingGeneration: 1, expectedInstanceId: null, expectedInstanceGeneration: null, expiresAt, createdAt: "2026-09-19T00:00:00.000Z" },
      outbox: { id: `card-${id}`, idempotencyKey: `confirmation:${id}`, card: {} }
    });
    stage("expired", "2026-09-19T00:00:30.000Z");
    expect(store.decideNaturalLanguageCommandConfirmation({ id: "expired", decision: "confirm", actorOpenId: "admin", chatId: "chat", decidedAt: "2026-09-19T00:01:00.000Z" })).toMatchObject({ outcome: "expired", confirmation: { state: "expired" } });

    stage("stale", "2026-09-19T01:00:00.000Z");
    store.database.prepare("UPDATE bindings SET generation = 2 WHERE id = 'binding-1'").run();
    expect(store.decideNaturalLanguageCommandConfirmation({ id: "stale", decision: "confirm", actorOpenId: "admin", chatId: "chat", decidedAt: "2026-09-19T00:01:00.000Z" })).toMatchObject({ outcome: "stale", confirmation: { state: "cancelled", resultDetail: "stale_context" } });
  });

  it("atomically consumes a natural-language confirmation with its Swarm command intent", () => {
    store = new SqliteBindingStore(":memory:");
    const command = { kind: "new", title: "Fix login", agentKind: "traex" } as const;
    store.stageNaturalLanguageCommandConfirmation({
      confirmation: { id: "atomic", sourceMessageId: "message-atomic", actorOpenId: "admin", chatId: "chat", topicId: null, rootMessageId: "message-atomic", envelope: { version: 1, family: "swarm", command }, expectedBindingId: null, expectedBindingGeneration: null, expectedInstanceId: null, expectedInstanceGeneration: null, expiresAt: "2026-09-19T01:00:00.000Z", createdAt: "2026-09-19T00:00:00.000Z" },
      outbox: { id: "atomic-card", idempotencyKey: "confirmation:atomic", card: {} }
    });
    const context = { chatId: "chat", topicId: null, rootMessageId: "message-atomic", sourceMessageId: "natural-language-confirmation:atomic", actorOpenId: "admin", projectId: null, workspaceId: null, primary: null };
    const input = { id: "atomic", actorOpenId: "admin", chatId: "chat", decidedAt: "2026-09-19T00:01:00.000Z", commandIntent: { id: "intent-atomic", idempotencyKey: "natural-language-confirmation:atomic:new", laneKey: "chat:chat", command, context, replayPolicy: "reconcilable" as const, acceptedAt: "2026-09-19T00:01:00.000Z" } };

    expect(store.confirmNaturalLanguageSwarmCommand(input)).toMatchObject({ outcome: "consumed", confirmation: { state: "consumed" }, commandIntent: { outcome: "accepted", intent: { id: "intent-atomic", state: "accepted" } } });
    expect(store.confirmNaturalLanguageSwarmCommand({ ...input, commandIntent: { ...input.commandIntent, id: "ignored" } })).toMatchObject({ outcome: "already-resolved", confirmation: { state: "consumed" } });
    expect(store.getCommandIntent("intent-atomic")).toMatchObject({ command, state: "accepted" });
  });

  it("persists Controller interpretation FIFO and never requeues possibly dispatched work", () => {
    store = new SqliteBindingStore(":memory:");
    const message = { eventId: "event-1", messageId: "message-1", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "admin", text: "看看当前情况", mentionsBot: true, isRootMessage: true };
    expect(store.acceptControllerInterpretation({ id: "job-1", message, controllerGeneration: 3, capabilityHash: "a".repeat(64), acceptedAt: "2026-09-19T00:00:00.000Z" })).toMatchObject({ inserted: true, job: { state: "accepted" } });
    expect(store.acceptControllerInterpretation({ id: "ignored", message, controllerGeneration: 3, capabilityHash: "b".repeat(64), acceptedAt: "2026-09-19T00:00:01.000Z" })).toMatchObject({ inserted: false, job: { id: "job-1" } });
    expect(store.claimNextControllerInterpretation(3, "c".repeat(64), "2026-09-19T00:00:02.000Z")).toMatchObject({ id: "job-1", state: "dispatching", capabilityHash: "c".repeat(64) });
    expect(store.markControllerInterpretationDispatched("job-1", 3, "turn-1", "2026-09-19T00:00:03.000Z")).toMatchObject({ state: "observing", runtimeTurnId: "turn-1" });
    expect(store.recoverControllerInterpretations("2026-09-19T00:01:00.000Z")).toBe(1);
    expect(store.getControllerInterpretation("job-1")).toMatchObject({ state: "uncertain" });
    expect(store.claimNextControllerInterpretation(3, "d".repeat(64), "2026-09-19T00:02:00.000Z")).toBeNull();
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 48").get()).toEqual({ version: 48 });
  });

  it("accepts one schema-validated structured Controller result", () => {
    store = new SqliteBindingStore(":memory:");
    const message = { eventId: "event-2", messageId: "message-2", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "admin", text: "do something", mentionsBot: true, isRootMessage: true };
    store.acceptControllerInterpretation({ id: "job-2", message, controllerGeneration: 1, capabilityHash: "a".repeat(64), acceptedAt: "2026-09-19T00:00:00.000Z" });
    store.claimNextControllerInterpretation(1, "b".repeat(64), "2026-09-19T00:00:01.000Z");
    store.markControllerInterpretationDispatched("job-2", 1, "turn-2", "2026-09-19T00:00:02.000Z");
    expect(store.finishControllerInterpretation("job-2", 1, { outcome: "command", source: "controller", family: "swarm", command: { kind: "panes" } }, "2026-09-19T00:00:03.000Z")).toMatchObject({ state: "succeeded", result: { outcome: "command", command: { kind: "panes" } } });
    expect(store.finishControllerInterpretation("job-2", 1, { outcome: "task", source: "controller" }, "2026-09-19T00:00:04.000Z")).toBeNull();
  });

  it("accepts a late structured result for an uncertain job without redispatching it", () => {
    store = new SqliteBindingStore(":memory:");
    const message = { eventId: "event-late", messageId: "message-late", parentMessageId: null, chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "admin", text: "看看 reviewer", mentionsBot: true, isRootMessage: true };
    store.acceptControllerInterpretation({ id: "job-late", message, controllerGeneration: 2, capabilityHash: "a".repeat(64), acceptedAt: "2026-09-19T00:00:00.000Z" });
    store.claimNextControllerInterpretation(2, "b".repeat(64), "2026-09-19T00:00:01.000Z");
    store.markControllerInterpretationDispatched("job-late", 2, "turn-late", "2026-09-19T00:00:02.000Z");
    store.failControllerInterpretation("job-late", 2, "uncertain", "restart", "2026-09-19T00:00:03.000Z");
    expect(store.finishControllerInterpretation("job-late", 2, { outcome: "clarification", message: "Which worker?", examples: ["reviewer"] }, "2026-09-19T00:00:04.000Z")).toMatchObject({ state: "clarification" });
    expect(store.claimNextControllerInterpretation(2, "c".repeat(64), "2026-09-19T00:00:05.000Z")).toBeNull();
  });

  it("persists and generation-fences the singleton Controller runtime", () => {
    store = new SqliteBindingStore(":memory:");
    expect(store.getControllerRuntime()).toBeNull();
    expect(store.saveControllerRuntime({ generation: 1, paneId: "w1:p1", terminalId: "term-1", nativeSessionId: "session-1", state: "active" }, "2026-09-19T00:00:00.000Z")).toMatchObject({ generation: 1, state: "active" });
    expect(store.markControllerRuntimeStale(2, "2026-09-19T00:01:00.000Z")).toBe(false);
    expect(store.markControllerRuntimeStale(1, "2026-09-19T00:01:00.000Z")).toBe(true);
    expect(store.getControllerRuntime()).toMatchObject({ generation: 1, state: "stale" });
    expect(store.saveControllerRuntime({ generation: 2, paneId: "w1:p2", terminalId: "term-2", nativeSessionId: "session-2", state: "active" }, "2026-09-19T00:02:00.000Z")).toMatchObject({ generation: 2, paneId: "w1:p2", state: "active" });
  });

  it("backfills safe Worker, Primary Main, and mutable Answer invalidations on upgrade", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-card-context-backfill-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding-1", { paneId: "primary-pane", state: "active", lifecycle: "active", attachment: "attached" });
    store.createWorkerAgentInstance({
      id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding-1", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
      workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4);
    const run = createQueuedRunCard({ promptId: "prompt-1", bindingId: "binding-1", bindingGeneration: 1, title: "Task", workspaceId: "w1", paneId: "primary-pane", requestText: "request", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: run.promptId, bindingId: run.bindingId, larkMessageId: "request", actorOpenId: "u1", body: run.requestText }, view: run, rootMessageId: "root", answerCard: {} });
    store.database.exec("DELETE FROM card_context_invalidations; DELETE FROM schema_migrations WHERE version = 23");
    store.close(); store = new SqliteBindingStore(path);

    expect(store.listPendingCardContextInvalidations()).toEqual(expect.arrayContaining([
      expect.objectContaining({ targetKind: "worker-session", targetId: "reviewer", targetGeneration: 1 }),
      expect.objectContaining({ targetKind: "primary-session", targetId: "binding-1", targetGeneration: 1 }),
      expect.objectContaining({ targetKind: "primary-turn", targetId: "prompt-1", targetGeneration: 1 })
    ]));
  });

  it("migrates pending Primary card updates onto generation-scoped lanes", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-card-context-lanes-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    const run = createQueuedRunCard({ promptId: "prompt-1", bindingId: "binding-1", bindingGeneration: 1, title: "Task", workspaceId: "w1", paneId: null, requestText: "request", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: run.promptId, bindingId: run.bindingId, larkMessageId: "request", actorOpenId: "u1", body: run.requestText }, view: run, rootMessageId: "root", answerCard: {} });
    store.enqueueOutboundReply({ id: "main-update", idempotencyKey: "main-update", bindingId: "binding-1", viewVersion: 2, targetRole: "session_status", rootMessageId: "main", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "answer-update", idempotencyKey: "answer-update", bindingId: "binding-1", promptId: "prompt-1", viewVersion: 2, cardRole: "answer", rootMessageId: "answer", kind: "card_update", payload: "{}" });
    store.database.exec("DELETE FROM schema_migrations WHERE version = 22; UPDATE outbound_replies SET lane_key = CASE id WHEN 'main-update' THEN 'message:main' WHEN 'answer-update' THEN 'answer:prompt-1' ELSE lane_key END;");
    store.close(); store = new SqliteBindingStore(path);

    expect(store.database.prepare("SELECT id, lane_key FROM outbound_replies WHERE id IN ('main-update','answer-update') ORDER BY id").all()).toEqual([
      { id: "answer-update", lane_key: "gateway:feishu:primary:primary-answer:prompt-1:1" },
      { id: "main-update", lane_key: "gateway:feishu:primary:primary-main:binding-1:1" }
    ]);
    expect(store.database.prepare("SELECT lane_key FROM outbox_lane_heads WHERE reply_id IN ('main-update','answer-update') ORDER BY lane_key").all()).toEqual([
      { lane_key: "gateway:feishu:primary:primary-answer:prompt-1:1" },
      { lane_key: "gateway:feishu:primary:primary-main:binding-1:1" }
    ]);
  });

  it("keeps Worker session generation stable across runtime replacement and freezes its persisted main view", () => {
    store = new SqliteBindingStore(":memory:");
    const created = store.createWorkerAgentInstance({
      id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: "GPT-5", desiredState: "running",
      parent: { bindingId: "binding-1", paneId: "primary-pane", nativeSessionId: "primary-session" },
      workspace: { id: "ws-reviewer", kind: "git-worktree", cwd: "/repo/.worktree/reviewer", branch: "swarm/reviewer", baseCommit: "base" }
    }, 4).instance;
    const attached = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "w1", paneId: "worker-pane-1", nativeSessionId: "worker-session-1" })!;
    const detached = store.detachAgentInstanceRuntime({ instanceId: attached.id, expectedGeneration: attached.generation, reason: "pane replaced" })!;
    const replaced = store.attachAgentInstanceRuntime({ instanceId: detached.id, expectedGeneration: detached.generation, herdrWorkspaceId: "w1", paneId: "worker-pane-2", nativeSessionId: "worker-session-2" })!;

    expect([created, attached, detached, replaced].map(({ workerSessionGeneration }) => workerSessionGeneration)).toEqual([1, 1, 1, 1]);
    const main = createWorkerMainView({
      workerId: replaced.id, workerSessionGeneration: replaced.workerSessionGeneration!, parentBindingId: "binding-1", parentBindingGeneration: 7, parentPaneId: "primary-pane", workerName: replaced.name, ownerName: "Primary",
      runtimeGeneration: replaced.generation, runtimeState: replaced.observedState, paneId: replaced.runtimeRef?.paneId ?? null, workspace: "/repo/.worktree/reviewer", branch: "swarm/reviewer", model: replaced.model, occurredAt: "2026-09-05T00:00:00.000Z"
    });
    expect(store.saveWorkerMainView(main)).toEqual(main);
    expect(store.loadWorkerMainView(replaced.id, 1)).toEqual(main);

    const terminated = store.terminateWorkerSession({ instanceId: replaced.id, expectedGeneration: replaced.generation, reason: "done" })!;
    expect(terminated.instance.workerSessionGeneration).toBe(1);
    const frozen = reduceWorkerMainView(main, { type: "terminated", occurredAt: "2026-09-05T00:02:00.000Z" });
    expect(store.saveWorkerMainView(frozen)).toEqual(frozen);
    expect(store.saveWorkerMainView({ ...frozen, frozenAt: null, runtimeState: "idle", viewVersion: frozen.viewVersion + 1 })).toBeNull();
    expect(store.loadWorkerMainView(replaced.id, 1)).toEqual(frozen);
  });

  it("durably coalesces card context invalidations and recovers unfinished revisions", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-context-invalidation-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    const target = { targetKind: "worker-session" as const, targetId: "worker-1", targetGeneration: 3 };

    expect(store.invalidateCardContexts([{ ...target, reason: "turn.accepted" }])).toEqual([expect.objectContaining({ ...target, requestedDependencyRevision: 1, projectedDependencyRevision: 0, reason: "turn.accepted" })]);
    expect(store.invalidateCardContexts([{ ...target, reason: "turn.running" }])).toEqual([expect.objectContaining({ ...target, requestedDependencyRevision: 2, projectedDependencyRevision: 0, reason: "turn.running" })]);
    expect(store.markCardContextProjected(target, 1)).toBe(true);
    expect(store.listPendingCardContextInvalidations()).toEqual([expect.objectContaining({ ...target, requestedDependencyRevision: 2, projectedDependencyRevision: 1 })]);
    store.close(); store = new SqliteBindingStore(path);
    expect(store.listPendingCardContextInvalidations()).toEqual([expect.objectContaining({ ...target, requestedDependencyRevision: 2, projectedDependencyRevision: 1 })]);
    expect(store.markCardContextProjected(target, 2)).toBe(true);
    expect(store.listPendingCardContextInvalidations()).toEqual([]);
  });

  it("keeps Worker Main delivery in a session lane independent from Worker Task delivery", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "primary-root", title: "Primary" });
    const created = store.createWorkerAgentInstance({
      id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding-1", bindingGeneration: 3, paneId: "primary-pane", nativeSessionId: "primary-session" },
      workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "w1", paneId: "worker-pane", nativeSessionId: "worker-session" })!;
    const main = createWorkerMainView({
      workerId: worker.id, workerSessionGeneration: 1, parentBindingId: "binding-1", parentBindingGeneration: 3, parentPaneId: "primary-pane", workerName: worker.name, ownerName: "Primary",
      runtimeGeneration: worker.generation, runtimeState: worker.observedState, workspace: "/repo", branch: null, model: null, occurredAt: "2026-09-05T00:00:00.000Z"
    });
    store.reserveWorkerMainCard(main, "primary-root", { version: 1 });
    store.acceptInstanceTurn({ id: "turn-1", idempotencyKey: "turn-1", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "review" });
    store.enqueueOutboundReply({ id: "task-update", idempotencyKey: "task-update", workerTurnId: "turn-1", rootMessageId: "task-message", kind: "card_update", payload: "{}" });

    expect(store.database.prepare("SELECT id, lane_key FROM outbound_replies ORDER BY delivery_order").all()).toEqual([
      expect.objectContaining({ lane_key: "gateway:feishu:primary:worker-main:reviewer:1" }),
      { id: "task-update", lane_key: "gateway:feishu:primary:worker-turn:turn-1" }
    ]);
  });

  it("retires a never-attempted legacy Worker Task Card intent without replaying the turn", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    const created = store.createAgentInstance({
      id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    });
    const view = createQueuedWorkerTurnCard({ turnId: "turn-1", instanceId: created.id, instanceGeneration: created.generation, workerSessionGeneration: 1, workerName: created.name, parentTurnId: null, rootMessageId: "root", requestText: "review", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.acceptInstanceTurnWithCard({ id: view.turnId, idempotencyKey: view.turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: created.id, instanceGeneration: created.generation, kind: "turn", text: view.requestText, parentTurnId: null, sourceMessageId: "source", view, render: renderWorkerTurnCard });
    store.enqueueOutboundReply({ id: "never-sent", idempotencyKey: "worker-turn:create:turn-1:0", workerTurnId: "turn-1", rootMessageId: "root", kind: "stream_card_create", payload: "{}" });
    store.enqueueOutboundReply({ id: "legacy-followup", idempotencyKey: "worker-turn:update:turn-1:2", workerTurnId: "turn-1", rootMessageId: "task-message", kind: "card_update", payload: "{}" });

    expect(store.retireUndeliveredWorkerTaskCardIntents()).toBe(1);
    expect(store.getOutboundReply("never-sent")).toMatchObject({ state: "dismissed", error: "Retired by Worker Session single-card migration" });
    expect(store.getOutboundReply("legacy-followup")).toMatchObject({ state: "pending" });
    expect(store.getInstanceTurn("turn-1")).toMatchObject({ state: "queued", text: "review" });
    expect(store.retireUndeliveredWorkerTaskCardIntents()).toBe(0);
  });

  it("preserves delivered and uncertain legacy Worker Task Card effects", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    const worker = store.createAgentInstance({
      id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    });
    const queued = createQueuedWorkerTurnCard({ turnId: "turn-1", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: 1, workerName: worker.name, parentTurnId: null, rootMessageId: "root", requestText: "review", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.acceptInstanceTurnWithCard({ id: queued.turnId, idempotencyKey: queued.turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: queued.requestText, parentTurnId: null, sourceMessageId: "source", view: queued, render: renderWorkerTurnCard });
    store.enqueueOutboundReply({ id: "delivered", idempotencyKey: "worker-turn:create:turn-1:0", workerTurnId: "turn-1", rootMessageId: "root", kind: "stream_card_create", payload: "{}" });
    store.markOutboundReplyDelivered("delivered", "task-message", "task-card");
    store.enqueueOutboundReply({ id: "uncertain", idempotencyKey: "worker-turn:create:turn-1:1", workerTurnId: "turn-1", rootMessageId: "root", kind: "stream_card_create", payload: "{}" });
    store.checkpointOutboundReplyCard("uncertain", "possibly-created-card");
    const originalTurn = store.getInstanceTurn(queued.turnId);

    expect(store.retireUndeliveredWorkerTaskCardIntents()).toBe(0);
    expect(store.getOutboundReply("delivered")).toMatchObject({ state: "delivered" });
    expect(store.getOutboundReply("uncertain")).toMatchObject({ state: "pending", cardIdCheckpoint: "possibly-created-card" });
    expect(store.getInstanceTurn(queued.turnId)).toEqual(originalTurn);
  });

  it("keeps the running Worker task current when newer work is queued", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding-1", { paneId: "primary-pane", state: "active", lifecycle: "active", attachment: "attached" });
    const created = store.createWorkerAgentInstance({
      id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding-1", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
      workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "w1", paneId: "worker-pane", nativeSessionId: "worker-session" })!;
    const running = createQueuedWorkerTurnCard({ turnId: "running", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: 1, workerName: worker.name, parentTurnId: null, rootMessageId: "root", requestText: "Running task", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    const queued = createQueuedWorkerTurnCard({ turnId: "queued", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: 1, workerName: worker.name, parentTurnId: null, rootMessageId: "root", requestText: "Queued task", queuePosition: 2, occurredAt: "2026-09-05T00:00:01.000Z" });
    for (const view of [running, queued]) store.acceptInstanceTurnWithCard({ id: view.turnId, idempotencyKey: view.turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: view.requestText, parentTurnId: null, sourceMessageId: view.turnId, view, render: renderWorkerTurnCard });
    store.transitionInstanceTurnWithProjection({ turnId: running.turnId, expectedGeneration: worker.generation, state: "running", eventKind: "turn.started", change: { type: "running", occurredAt: "2026-09-05T00:00:02.000Z" }, render: renderWorkerTurnCard });
    store.applyInstanceTurnProjection({ turnId: running.turnId, expectedGeneration: worker.generation, change: { type: "output", occurredAt: "2026-09-05T00:00:03.000Z", answer: "Working", tokenCount: 4_570 }, render: renderWorkerTurnCard });
    for (let index = 0; index < 4; index += 1) store.createWorkerAgentInstance({
      id: `idle-${index}`, projectId: "p1", name: `idle-${index}`, role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding-1", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
      workspace: { id: `ws-idle-${index}`, kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 8);

    expect(store.loadWorkerMainProjectionSource(worker.id, 1)).toMatchObject({ currentTask: { turnId: "running", tokenCount: 4_570 }, queueCount: 1, nextTaskTitle: "Queued task" });
    const prepare = vi.spyOn(store.database, "prepare");
    const summaries = store.loadPrimaryWorkerSummaries("binding-1", 1);
    expect(summaries).toHaveLength(5);
    expect(summaries).toContainEqual(expect.objectContaining({ workerId: worker.id, state: "working" }));
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(String(prepare.mock.calls[1]?.[0])).toContain("INDEXED BY agent_instances_worker_parent_name");
  });

  it("bounds Worker Main history and uses the Worker-session index", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding-1", { paneId: "primary-pane", state: "active", lifecycle: "active", attachment: "attached" });
    const worker = store.createWorkerAgentInstance({
      id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding-1", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
      workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;
    for (let index = 0; index < 8; index += 1) {
      const turnId = `turn-${index}`;
      const occurredAt = `2026-09-05T00:0${index}:00.000Z`;
      const view = createQueuedWorkerTurnCard({ turnId, instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: 1, workerName: worker.name, parentTurnId: null, rootMessageId: "root", requestText: `Task ${index}`, queuePosition: index + 1, occurredAt });
      store.acceptInstanceTurnWithCard({ id: turnId, idempotencyKey: turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: view.requestText, parentTurnId: null, sourceMessageId: turnId, view, render: renderWorkerTurnCard });
      store.database.prepare("UPDATE worker_turn_cards SET phase = 'completed', created_at = ?, updated_at = ?, answer = ? WHERE turn_id = ?").run(occurredAt, occurredAt, "large-history-answer".repeat(100), turnId);
    }

    const source = store.loadWorkerMainProjectionSource(worker.id, 1)!;
    expect(source.currentTask).toMatchObject({ turnId: "turn-7", answer: "large-history-answer".repeat(100) });
    expect(source.queueCount).toBe(0);
    expect(source.recentTasks.map(({ turnId }) => turnId)).toEqual(["turn-7", "turn-6", "turn-5", "turn-4", "turn-3"]);
    expect(source.createdAt).toBe("2026-09-05T00:00:00.000Z");
    const plan = store.database.prepare("EXPLAIN QUERY PLAN SELECT turn_id FROM worker_turn_cards WHERE instance_id = ? AND worker_session_generation = ? AND phase = 'completed' ORDER BY created_at DESC, turn_id DESC LIMIT 5").all(worker.id, 1) as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes("worker_turn_cards_session_phase"))).toBe(true);
  });

  it("invalidates Worker Main when its parent binding stops being active", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding-1", { paneId: "primary-pane", state: "active", lifecycle: "active", attachment: "attached" });
    const worker = store.createWorkerAgentInstance({
      id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding-1", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
      workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;
    store.attachAgentInstanceRuntime({ instanceId: worker.id, expectedGeneration: worker.generation, herdrWorkspaceId: "w1", paneId: "worker-pane", nativeSessionId: "worker-session" });
    expect(store.loadWorkerMainProjectionSource(worker.id, 1)).toMatchObject({ runtimeAttached: true, desiredState: "running", parentActive: true });
    store.database.exec("DELETE FROM card_context_invalidations");

    store.updateBinding("binding-1", { lifecycle: "archived", state: "archived", attachment: "unattached" });

    expect(store.loadWorkerMainProjectionSource(worker.id, 1)).toMatchObject({ parentActive: false });
    expect(store.listPendingCardContextInvalidations()).toEqual([expect.objectContaining({ targetKind: "worker-session", targetId: worker.id, targetGeneration: 1, reason: "parent-binding.changed" })]);
  });

  it("projects an idle Worker with queued work as queued instead of idle", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("binding-1", { paneId: "primary-pane", state: "active", lifecycle: "active", attachment: "attached" });
    const created = store.createWorkerAgentInstance({
      id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding-1", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
      workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "w1", paneId: "worker-pane", nativeSessionId: "worker-session" })!;
    const queued = createQueuedWorkerTurnCard({ turnId: "queued", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: 1, workerName: worker.name, parentTurnId: null, rootMessageId: "root", requestText: "Queued task", queuePosition: 1, occurredAt: "2026-09-05T00:00:01.000Z" });
    store.acceptInstanceTurnWithCard({ id: queued.turnId, idempotencyKey: queued.turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: queued.requestText, parentTurnId: null, sourceMessageId: queued.turnId, view: queued, render: renderWorkerTurnCard });

    expect(store.loadPrimaryWorkerSummaries("binding-1", 1)).toEqual([expect.objectContaining({ workerId: worker.id, state: "queued", currentTaskTitle: "Queued task", queueCount: 1 })]);
  });

  it("keeps Primary Answer activity inside the owning binding, pane, and Worker session", () => {
    store = new SqliteBindingStore(":memory:");
    for (const [bindingId, paneId] of [["binding-1", "primary-pane-1"], ["binding-2", "primary-pane-2"]] as const) {
      store.createPendingBinding({ id: bindingId, projectId: "p1", workspaceId: "w1", chatId: "c1", topicId: bindingId, rootMessageId: `root-${bindingId}`, title: bindingId });
      store.updateBinding(bindingId, { paneId, state: "active", lifecycle: "active", attachment: "attached" });
    }
    const answer = createQueuedRunCard({ promptId: "prompt-1", bindingId: "binding-1", bindingGeneration: 1, title: "Coordinate", workspaceId: "w1", paneId: "primary-pane-1", requestText: "delegate", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: answer.promptId, bindingId: answer.bindingId, larkMessageId: "request", actorOpenId: "u1", body: answer.requestText }, view: answer, rootMessageId: "root-binding-1", answerCard: {} });

    const createTask = (workerId: string, bindingId: string, paneId: string, actorBindingId: string) => {
      const created = store!.createWorkerAgentInstance({
        id: workerId, projectId: "p1", name: workerId, role: "worker", agentKind: "traex", model: null, desiredState: "running",
        parent: { bindingId, bindingGeneration: 1, paneId, nativeSessionId: `primary-${workerId}` },
        workspace: { id: `ws-${workerId}`, kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
      }, 4).instance;
      const worker = store!.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "w1", paneId: `worker-${workerId}`, nativeSessionId: `session-${workerId}` })!;
      const view = createQueuedWorkerTurnCard({ turnId: `turn-${workerId}`, instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: 1, workerName: worker.name, parentTurnId: null, rootMessageId: "root-binding-1", requestText: `Task ${workerId}`, queuePosition: 1, occurredAt: "2026-09-05T00:00:01.000Z" });
      store!.acceptInstanceTurnWithCard({ id: view.turnId, idempotencyKey: view.turnId, actor: { kind: "thread-primary", projectId: "p1", bindingId: actorBindingId, bindingGeneration: 1, parentPromptId: answer.promptId }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: view.requestText, parentTurnId: null, sourceMessageId: view.turnId, view, render: renderWorkerTurnCard });
      return worker.id;
    };

    const ownedWorkerId = createTask("owned", "binding-1", "primary-pane-1", "binding-1");
    const ownedWorker = store.getAgentInstance(ownedWorkerId)!;
    const laterOwnedTask = createQueuedWorkerTurnCard({ turnId: "turn-owned-later", instanceId: ownedWorker.id, instanceGeneration: ownedWorker.generation, workerSessionGeneration: 1, workerName: ownedWorker.name, parentTurnId: null, rootMessageId: "root-binding-1", requestText: "Latest owned task", queuePosition: 2, occurredAt: "2026-09-05T00:00:02.000Z" });
    store.acceptInstanceTurnWithCard({ id: laterOwnedTask.turnId, idempotencyKey: laterOwnedTask.turnId, actor: { kind: "thread-primary", projectId: "p1", bindingId: "binding-1", bindingGeneration: 1, parentPromptId: answer.promptId }, projectId: "p1", instanceId: ownedWorker.id, instanceGeneration: ownedWorker.generation, kind: "turn", text: laterOwnedTask.requestText, parentTurnId: null, sourceMessageId: laterOwnedTask.turnId, view: laterOwnedTask, render: renderWorkerTurnCard });
    createTask("cross-binding", "binding-2", "primary-pane-2", "binding-1");
    createTask("stale-pane", "binding-1", "retired-primary-pane", "binding-1");

    const prepare = vi.spyOn(store.database, "prepare");
    expect(store.loadPrimaryWorkerActivity(answer.promptId, 1)).toEqual([expect.objectContaining({ workerId: ownedWorkerId, taskCount: 2, latestTaskTitle: "Latest owned task", latestTaskCard: expect.objectContaining({ aggregateId: "turn-owned-later" }) })]);
    expect(prepare).toHaveBeenCalledTimes(3);
    expect(String(prepare.mock.calls[2]?.[0])).toContain("COUNT(*) OVER");
    expect(String(prepare.mock.calls[2]?.[0])).toContain("INDEXED BY instance_turns_primary_source");
    expect(store.database.prepare("SELECT actor_kind, source_binding_id, source_binding_generation, source_parent_prompt_id FROM instance_turns WHERE id = ?").get(`turn-${ownedWorkerId}`)).toEqual({ actor_kind: "thread-primary", source_binding_id: "binding-1", source_binding_generation: 1, source_parent_prompt_id: answer.promptId });
    const plan = store.database.prepare("EXPLAIN QUERY PLAN SELECT id FROM instance_turns WHERE actor_kind = 'thread-primary' AND source_parent_prompt_id = ? AND source_binding_id = ? AND source_binding_generation = ?").all(answer.promptId, "binding-1", 1) as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes("instance_turns_primary_source"))).toBe(true);
  });

  it("backfills indexed turn actor provenance without rejecting malformed legacy JSON", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-turn-actor-provenance-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    store.acceptInstanceTurn({ id: "primary-turn", idempotencyKey: "primary-turn", actor: { kind: "thread-primary", projectId: "p1", bindingId: "binding-1", bindingGeneration: 3, parentPromptId: "prompt-1" }, projectId: "p1", instanceId: "reviewer", instanceGeneration: 1, kind: "turn", text: "work" });
    store.acceptInstanceTurn({ id: "malformed-turn", idempotencyKey: "malformed-turn", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: "reviewer", instanceGeneration: 1, kind: "turn", text: "legacy" });
    store.database.exec("DELETE FROM schema_migrations WHERE version = 27; UPDATE instance_turns SET actor_kind = NULL, source_binding_id = NULL, source_binding_generation = NULL, source_parent_prompt_id = NULL; UPDATE instance_turns SET actor_json = 'not-json' WHERE id = 'malformed-turn';");
    store.close(); store = new SqliteBindingStore(path);

    expect(store.database.prepare("SELECT actor_kind, source_binding_id, source_binding_generation, source_parent_prompt_id FROM instance_turns WHERE id = 'primary-turn'").get()).toEqual({ actor_kind: "thread-primary", source_binding_id: "binding-1", source_binding_generation: 3, source_parent_prompt_id: "prompt-1" });
    expect(store.database.prepare("SELECT actor_kind, source_binding_id FROM instance_turns WHERE id = 'malformed-turn'").get()).toEqual({ actor_kind: null, source_binding_id: null });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 27").get()).toEqual({ version: 27 });
  });

  it("adds turn provenance columns before creating their indexes on a legacy database", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-turn-provenance-schema-order-"));
    const path = join(temporaryDirectory, "bridge.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE instance_turns(
        id TEXT PRIMARY KEY, idempotency_key TEXT NOT NULL UNIQUE, project_id TEXT NOT NULL, instance_id TEXT NOT NULL, instance_generation INTEGER NOT NULL, actor_json TEXT NOT NULL,
        kind TEXT NOT NULL, priority TEXT NOT NULL DEFAULT 'normal', text TEXT NOT NULL, state TEXT NOT NULL, result TEXT, error TEXT,
        parent_turn_id TEXT, source_message_id TEXT, runtime_turn_id TEXT, runtime_turn_started_at TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
    `);
    legacy.close();

    store = new SqliteBindingStore(path);

    const columns = (store.database.prepare("PRAGMA table_info(instance_turns)").all() as Array<{ name: string }>).map(({ name }) => name);
    expect(columns).toEqual(expect.arrayContaining(["actor_kind", "source_binding_id", "source_binding_generation", "source_parent_prompt_id"]));
    expect(store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'instance_turns_primary_source'").get()).toEqual({ name: "instance_turns_primary_source" });
  });

  it("backfills inbound message scopes and upgrades the pending index on a legacy database", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-inbound-message-scope-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    const legacy = new DatabaseSync(path);
    const message = (eventId: string, messageId: string, topicId: string | null, rootMessageId: string | null) => JSON.stringify({
      eventId, messageId, parentMessageId: null, chatId: "chat", topicId, rootMessageId, actorOpenId: "operator", text: "continue", mentionsBot: true, isRootMessage: false
    });
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE inbound_messages(
        event_id TEXT PRIMARY KEY, gateway_id TEXT NOT NULL DEFAULT 'feishu:primary', message_id TEXT NOT NULL, payload_json TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('received','processing','accepted')), error TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      CREATE INDEX inbound_messages_pending ON inbound_messages(state, created_at);
    `);
    const insert = legacy.prepare("INSERT INTO inbound_messages(event_id, gateway_id, message_id, payload_json, state, error, created_at, updated_at) VALUES (?, 'feishu:primary', ?, ?, 'received', NULL, ?, ?)");
    insert.run("topic-message", "topic-message-id", message("topic-message", "topic-message-id", "topic-a", "root-a"), "2026-09-13T00:00:00.000Z", "2026-09-13T00:00:00.000Z");
    insert.run("root-message", "root-message-id", message("root-message", "root-message-id", null, "root-b"), "2026-09-13T00:00:01.000Z", "2026-09-13T00:00:01.000Z");
    insert.run("standalone-message", "standalone-message-id", message("standalone-message", "standalone-message-id", null, null), "2026-09-13T00:00:02.000Z", "2026-09-13T00:00:02.000Z");
    legacy.close();

    store = new SqliteBindingStore(path);

    expect(store.database.prepare("SELECT event_id, scope_key FROM inbound_messages ORDER BY event_id").all()).toEqual([
      { event_id: "root-message", scope_key: "root:root-b" },
      { event_id: "standalone-message", scope_key: "message:standalone-message-id" },
      { event_id: "topic-message", scope_key: "topic:topic-a" }
    ]);
    expect((store.database.prepare("PRAGMA index_info(inbound_messages_pending)").all() as Array<{ name: string }>).map(({ name }) => name)).toEqual(["state", "scope_key", "created_at"]);
    expect(store.claimNextInboundMessage(["topic:topic-a"])?.eventId).toBe("root-message");
  });

  it("adds Primary-scoped Worker indexes only after upgrading a pre-parent identity schema", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-worker-parent-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    const legacy = new DatabaseSync(path);
    legacy.exec(`
      CREATE TABLE schema_migrations(version INTEGER PRIMARY KEY);
      CREATE TABLE agent_instances(
        id TEXT PRIMARY KEY, project_id TEXT NOT NULL, name TEXT NOT NULL, role TEXT NOT NULL CHECK(role IN ('primary','worker')),
        agent_kind TEXT NOT NULL CHECK(agent_kind IN ('pi','claude-code','codex','traex')), model TEXT,
        desired_state TEXT NOT NULL CHECK(desired_state IN ('running','stopped')),
        observed_state TEXT NOT NULL CHECK(observed_state IN ('unprovisioned','starting','idle','working','blocked','detached','stopped','failed')),
        workspace_lease_id TEXT NOT NULL UNIQUE, generation INTEGER NOT NULL DEFAULT 1, herdr_workspace_id TEXT, pane_id TEXT UNIQUE, native_session_id TEXT,
        provisioning_checkpoint TEXT NOT NULL DEFAULT 'recorded', last_error TEXT, pending_herdr_workspace_id TEXT, pending_pane_id TEXT,
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, UNIQUE(project_id, name)
      );
    `);
    legacy.close();

    store = new SqliteBindingStore(path);

    const columns = (store.database.prepare("PRAGMA table_info(agent_instances)").all() as Array<{ name: string }>).map(({ name }) => name);
    expect(columns).toEqual(expect.arrayContaining(["parent_binding_id", "parent_pane_id", "worker_session_lifecycle"]));
    expect(store.database.prepare("SELECT 1 FROM schema_migrations WHERE version = 16").get()).toEqual({ 1: 1 });
    expect(store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name = 'agent_instances_worker_parent_name'").get()).toEqual({ name: "agent_instances_worker_parent_name" });
  });

  it("upgrades Worker pane close steps with instance generation and retained state", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-worker-pane-close-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "binding-close", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic-close", rootMessageId: "root-close", title: "Primary" });
    store.updateBinding("binding-close", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:primary", lastAgentState: "idle" });
    const worker = store.createWorkerAgentInstance({
      id: "worker-close", projectId: "p1", name: "worker-close", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "binding-close", bindingGeneration: 1, paneId: "w1:primary", nativeSessionId: "primary-session" },
      workspace: { id: "workspace-close", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4).instance;
    store.createPaneCloseRequest({ id: "close-operation", bindingId: "binding-close", paneId: "w1:primary", actorOpenId: "operator", codeHash: "hash", expiresAt: "2999-01-01T00:00:00.000Z" });
    store.close();
    store = undefined;

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE worker_pane_close_steps_legacy(
        operation_id TEXT NOT NULL REFERENCES pane_close_requests(id) ON DELETE CASCADE, binding_id TEXT NOT NULL, parent_pane_id TEXT NOT NULL, worker_id TEXT NOT NULL REFERENCES agent_instances(id) ON DELETE CASCADE, pane_id TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('executing','succeeded','uncertain')), detail TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(operation_id, worker_id, pane_id)
      );
      INSERT INTO worker_pane_close_steps_legacy VALUES ('close-operation', 'binding-close', 'w1:primary', 'worker-close', 'w1:worker', 'executing', NULL, '2026-09-17T00:00:00.000Z', '2026-09-17T00:00:00.000Z');
      DROP TABLE worker_pane_close_steps;
      ALTER TABLE worker_pane_close_steps_legacy RENAME TO worker_pane_close_steps;
      DELETE FROM schema_migrations WHERE version = 45;
      PRAGMA foreign_keys = ON;
    `);
    legacy.close();

    store = new SqliteBindingStore(path);

    expect((store.database.prepare("PRAGMA table_info(worker_pane_close_steps)").all() as Array<{ name: string }>).map(({ name }) => name)).toContain("instance_generation");
    expect(store.database.prepare("SELECT instance_generation, state FROM worker_pane_close_steps WHERE worker_id = 'worker-close'").get()).toEqual({ instance_generation: worker.generation, state: "executing" });
    store.finishWorkerPaneCloseStep({ operationId: "close-operation", workerId: "worker-close", paneId: "w1:worker", state: "retained", detail: "busy" });
    expect(store.database.prepare("SELECT state, detail FROM worker_pane_close_steps WHERE worker_id = 'worker-close'").get()).toEqual({ state: "retained", detail: "busy" });
  });

  it("atomically accepts a Worker turn with its initial card projection", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root-1", title: "Primary" });
    store.updateBinding("binding-1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane", lastAgentState: "idle" });
    const created = store.createWorkerAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", parent: { bindingId: "binding-1", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" }, workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    const view = createQueuedWorkerTurnCard({ turnId: "turn-1", instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "root-1", requestText: "review", queuePosition: 1, occurredAt: "2026-09-01T00:00:00.000Z" });
    const input = { id: "turn-1", idempotencyKey: "lark:m1", actor: { kind: "human" as const, userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn" as const, text: "review", parentTurnId: null, sourceMessageId: "m1", view, render: renderWorkerTurnCard };

    expect(store.acceptInstanceTurnWithCard(input)).toMatchObject({ inserted: true, turn: { id: "turn-1", sourceMessageId: "m1", parentTurnId: null }, view: { turnId: "turn-1", phase: "queued" } });
    expect(store.acceptInstanceTurnWithCard(input)).toMatchObject({ inserted: false, turn: { id: "turn-1" } });
    expect(store.loadWorkerTurnCard("turn-1")).toMatchObject({ requestText: "review", queuePosition: 1 });
    expect(store.listPendingOutboundReplies().filter(({ workerTurnId }) => workerTurnId === "turn-1")).toEqual([expect.objectContaining({
      idempotencyKey: "worker-turn:create:turn-1:0", kind: "stream_card_create", rootMessageId: "root-1"
    })]);
    expect(store.hasPendingOutboundReplyForWorkerTurn("turn-1")).toBe(true);
    expect(store.hasPendingOutboundReplyForWorkerTurn("missing")).toBe(false);
    const pendingPlan = store.database.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM outbound_replies WHERE worker_turn_id = ? AND state = 'pending' LIMIT 1").all("turn-1") as Array<{ detail: string }>;
    expect(pendingPlan.some(({ detail }) => detail.includes("outbound_replies_worker_pending"))).toBe(true);
  });

  it("reserves one durable Human Review notification for a Worker blocked episode", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-review", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "primary-root", title: "Primary 51g1", creatorOpenId: "ou_primary" });
    store.updateBinding("binding-review", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane", lastAgentState: "idle" });
    const created = store.createWorkerAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", parent: { bindingId: "binding-review", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" }, workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "w1", paneId: "worker-pane", nativeSessionId: "worker-session" })!;
    const view = createQueuedWorkerTurnCard({ turnId: "turn-review", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: 1, workerName: worker.name, parentTurnId: null, rootMessageId: "worker-thread-root", requestText: "review durable flow", queuePosition: 1, occurredAt: "2026-09-18T00:00:00.000Z" });
    store.acceptInstanceTurnWithCard({ id: view.turnId, idempotencyKey: view.turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: view.requestText, parentTurnId: null, sourceMessageId: "m1", view, render: renderWorkerTurnCard });
    store.transitionInstanceTurnWithProjection({ turnId: view.turnId, expectedGeneration: worker.generation, state: "running", eventKind: "turn.started", change: { type: "running", occurredAt: "2026-09-18T00:00:01.000Z" }, render: renderWorkerTurnCard, renderHumanReviewNotification: renderWorkerHumanReviewNotification });

    const blocked = store.transitionInstanceTurnWithProjection({ turnId: view.turnId, expectedGeneration: worker.generation, state: "blocked", eventKind: "turn.blocked", change: { type: "blocked", occurredAt: "2026-09-18T00:00:02.000Z", notice: "Needs local review" }, render: renderWorkerTurnCard, renderHumanReviewNotification: renderWorkerHumanReviewNotification });
    const reviewReplies = store.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("worker-review:"));

    expect(blocked).toMatchObject({ notification: { outcome: "reserved", mention: "included" } });
    expect(reviewReplies).toHaveLength(1);
    expect(reviewReplies[0]).toMatchObject({ bindingId: "binding-review", rootMessageId: "primary-root", kind: "card_reply", targetRole: "operation_result", workerTurnId: null, workerId: null });
    expect(reviewReplies[0]!.idempotencyKey).toMatch(/^worker-review:reviewer:1:turn-review:\d+$/);
    expect(reviewReplies[0]!.laneKey).toContain("reply:");
    expect(reviewReplies[0]!.payload).toContain("<at id=ou_primary></at>");
  });

  it("deduplicates repeated blocked observations and notifies a later blocked episode", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-review", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "primary-root", title: "Primary" });
    store.updateBinding("binding-review", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane" });
    const created = store.createWorkerAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", parent: { bindingId: "binding-review", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" }, workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "w1", paneId: "worker-pane", nativeSessionId: "worker-session" })!;
    const view = createQueuedWorkerTurnCard({ turnId: "turn-review", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: 1, workerName: worker.name, parentTurnId: null, rootMessageId: "worker-root", requestText: "review", queuePosition: 1, occurredAt: "2026-09-18T00:00:00.000Z" });
    store.acceptInstanceTurnWithCard({ id: view.turnId, idempotencyKey: view.turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: view.requestText, parentTurnId: null, sourceMessageId: "m1", view, render: renderWorkerTurnCard });
    const transition = (state: "running" | "blocked", second: number) => store!.transitionInstanceTurnWithProjection({ turnId: view.turnId, expectedGeneration: worker.generation, state, eventKind: state === "blocked" ? "turn.blocked" : "turn.started", change: state === "blocked" ? { type: "blocked" as const, occurredAt: `2026-09-18T00:00:0${second}.000Z`, notice: "Needs local review" } : { type: "running" as const, occurredAt: `2026-09-18T00:00:0${second}.000Z` }, render: renderWorkerTurnCard, renderHumanReviewNotification: renderWorkerHumanReviewNotification });

    transition("running", 1);
    expect(transition("blocked", 2)).toMatchObject({ notification: { outcome: "reserved", mention: "omitted" } });
    expect(transition("blocked", 3)).toMatchObject({ notification: { outcome: "skipped", reason: "not-blocked-transition" } });
    transition("running", 4);
    expect(transition("blocked", 5)).toMatchObject({ notification: { outcome: "reserved", mention: "omitted" } });

    const notifications = store.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("worker-review:"));
    expect(notifications).toHaveLength(2);
    expect(new Set(notifications.map(({ idempotencyKey }) => idempotencyKey)).size).toBe(2);
    expect(store.listInstanceEvents(worker.id).filter(({ kind }) => kind === "turn.blocked")).toHaveLength(2);
  });

  it("commits blocked state but skips notification when the parent route is stale", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-review", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "primary-root", title: "Primary" });
    store.updateBinding("binding-review", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane" });
    const created = store.createWorkerAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", parent: { bindingId: "binding-review", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: null }, workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "w1", paneId: "worker-pane", nativeSessionId: "worker-session" })!;
    const view = createQueuedWorkerTurnCard({ turnId: "turn-review", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: 1, workerName: worker.name, parentTurnId: null, rootMessageId: "worker-root", requestText: "review", queuePosition: 1, occurredAt: "2026-09-18T00:00:00.000Z" });
    store.acceptInstanceTurnWithCard({ id: view.turnId, idempotencyKey: view.turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: view.requestText, parentTurnId: null, sourceMessageId: "m1", view, render: renderWorkerTurnCard });
    store.updateBinding("binding-review", { generation: 2 });

    const blocked = store.transitionInstanceTurnWithProjection({ turnId: view.turnId, expectedGeneration: worker.generation, state: "blocked", eventKind: "turn.blocked", change: { type: "blocked", occurredAt: "2026-09-18T00:00:02.000Z", notice: "Needs local review" }, render: renderWorkerTurnCard, renderHumanReviewNotification: renderWorkerHumanReviewNotification });

    expect(blocked).toMatchObject({ turn: { state: "blocked" }, view: { phase: "blocked" }, notification: { outcome: "skipped", reason: "stale-routing" } });
    expect(store.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("worker-review:"))).toHaveLength(0);
  });

  it("rolls back blocked state, event, projection and outbox when notification rendering fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "binding-review", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "primary-root", title: "Primary" });
    store.updateBinding("binding-review", { state: "active", lifecycle: "active", attachment: "attached", paneId: "primary-pane" });
    const created = store.createWorkerAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", parent: { bindingId: "binding-review", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: null }, workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } }, 4).instance;
    const worker = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "w1", paneId: "worker-pane", nativeSessionId: "worker-session" })!;
    const view = createQueuedWorkerTurnCard({ turnId: "turn-review", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: 1, workerName: worker.name, parentTurnId: null, rootMessageId: "worker-root", requestText: "review", queuePosition: 1, occurredAt: "2026-09-18T00:00:00.000Z" });
    store.acceptInstanceTurnWithCard({ id: view.turnId, idempotencyKey: view.turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: view.requestText, parentTurnId: null, sourceMessageId: "m1", view, render: renderWorkerTurnCard });
    const eventsBefore = store.listInstanceEvents(worker.id).length;

    expect(() => store!.transitionInstanceTurnWithProjection({ turnId: view.turnId, expectedGeneration: worker.generation, state: "blocked", eventKind: "turn.blocked", change: { type: "blocked", occurredAt: "2026-09-18T00:00:02.000Z", notice: "Needs local review" }, render: renderWorkerTurnCard, renderHumanReviewNotification: () => { throw new Error("render failed"); } })).toThrow("render failed");
    expect(store.getInstanceTurn(view.turnId)).toMatchObject({ state: "queued" });
    expect(store.loadWorkerTurnCard(view.turnId)).toMatchObject({ phase: "queued" });
    expect(store.listInstanceEvents(worker.id)).toHaveLength(eventsBefore);
    expect(store.listPendingOutboundReplies().filter(({ idempotencyKey }) => idempotencyKey.startsWith("worker-review:"))).toHaveLength(0);
  });

  it("backfills bounded Worker stream metadata and tolerates malformed legacy payloads", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-worker-outbox-metadata-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    store.acceptInstanceTurn({ id: "turn-1", idempotencyKey: "turn-1", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: "reviewer", instanceGeneration: 1, kind: "turn", text: "review" });
    store.enqueueOutboundReply({ id: "content", idempotencyKey: "content", workerTurnId: "turn-1", rootMessageId: "card", kind: "stream_content", payload: JSON.stringify({ pageIndex: 3, elementId: "answer-3", content: "done" }) });
    store.enqueueOutboundReply({ id: "malformed", idempotencyKey: "malformed", workerTurnId: "turn-1", rootMessageId: "card", kind: "stream_content", payload: "not-json" });
    store.database.exec("DELETE FROM schema_migrations WHERE version = 28; UPDATE outbound_replies SET stream_page_index = NULL, stream_element_id = NULL;");

    store.close(); store = undefined;
    store = new SqliteBindingStore(path);
    expect(store.database.prepare("SELECT id, stream_page_index, stream_element_id FROM outbound_replies WHERE worker_turn_id = 'turn-1' ORDER BY delivery_order").all()).toEqual([
      { id: "content", stream_page_index: 3, stream_element_id: "answer-3" },
      { id: "malformed", stream_page_index: null, stream_element_id: null }
    ]);
    const streamPlan = store.database.prepare("EXPLAIN QUERY PLAN SELECT payload FROM outbound_replies WHERE worker_turn_id = ? AND kind = 'stream_content' AND stream_page_index = ? AND selection_id IS NULL AND state IN ('pending','delivered','dead_letter') ORDER BY delivery_order DESC LIMIT 1").all("turn-1", 3) as Array<{ detail: string }>;
    expect(streamPlan.some(({ detail }) => detail.includes("outbound_replies_worker_stream"))).toBe(true);
  });

  it("assigns the Worker card queue position inside the acceptance transaction", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "reviewer", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    const accept = (id: string, proposedPosition: number) => {
      const view = createQueuedWorkerTurnCard({ turnId: id, instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "root-1", requestText: id, queuePosition: proposedPosition, occurredAt: "2026-09-06T00:00:00.000Z" });
      return store!.acceptInstanceTurnWithCard({ id, idempotencyKey: id, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: id, parentTurnId: null, sourceMessageId: id, view, render: renderWorkerTurnCard });
    };

    expect(accept("first", 99).view.queuePosition).toBe(1);
    expect(accept("second", 99).view.queuePosition).toBe(2);
    expect(accept("second", 7)).toMatchObject({ inserted: false, view: { queuePosition: 2 } });
    store.updateInstanceTurn({ turnId: "first", expectedGeneration: worker.generation, state: "running", eventKind: "turn.started" });
    expect(accept("third", 99).view.queuePosition).toBe(2);

    expect(store.loadWorkerTurnCard("first")).toMatchObject({ queuePosition: 1, phase: "queued" });
    expect(store.loadWorkerTurnCard("second")).toMatchObject({ queuePosition: 2 });
    const plan = store.database.prepare("EXPLAIN QUERY PLAN SELECT COUNT(*) FROM instance_turns INDEXED BY instance_turns_priority_queue WHERE instance_id = ? AND instance_generation = ? AND priority = 'normal' AND state = 'queued'").all(worker.id, worker.generation) as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes("instance_turns_priority_queue"))).toBe(true);
  });

  it("rolls back the Worker card and outbox when transactional capacity is exhausted", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "reviewer", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    const accept = (id: string) => {
      const view = createQueuedWorkerTurnCard({ turnId: id, instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "root-1", requestText: id, queuePosition: 0, occurredAt: "2026-09-06T00:00:00.000Z" });
      return store!.acceptInstanceTurnWithCard({ id, idempotencyKey: id, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: id, parentTurnId: null, sourceMessageId: id, view, render: renderWorkerTurnCard, maxQueueDepth: 1 });
    };

    expect(accept("first").inserted).toBe(true);
    expect(() => accept("rejected")).toThrow(InstanceTurnCapacityExceeded);
    expect(store.getInstanceTurn("rejected")).toBeNull();
    expect(store.loadWorkerTurnCard("rejected")).toBeNull();
    expect(store.listPendingOutboundReplies().filter(({ workerTurnId }) => workerTurnId)).toHaveLength(0);
  });

  it("validates Worker follow-up parents transactionally", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "reviewer", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    store.acceptInstanceTurn({ id: "parent", idempotencyKey: "parent", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "first" });
    const view = createQueuedWorkerTurnCard({ turnId: "child", instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: "parent", rootMessageId: "root-1", requestText: "continue", queuePosition: 2, occurredAt: "2026-09-01T00:00:00.000Z" });
    const followup = { id: "child", idempotencyKey: "child", actor: { kind: "human" as const, userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "followup" as const, text: "continue", parentTurnId: "parent", sourceMessageId: "m2", view, render: renderWorkerTurnCard };

    expect(() => store!.acceptInstanceTurnWithCard(followup)).toThrow(/settled/);
    store.updateInstanceTurn({ turnId: "parent", expectedGeneration: worker.generation, state: "completed", result: "done", eventKind: "turn.completed" });
    expect(store.acceptInstanceTurnWithCard(followup)).toMatchObject({ inserted: true, turn: { kind: "followup", parentTurnId: "parent" } });
    expect(() => store!.acceptInstanceTurnWithCard({ ...followup, id: "ordinary", idempotencyKey: "ordinary", kind: "turn", parentTurnId: "parent", view: { ...view, turnId: "ordinary" } })).toThrow(/Ordinary/);
  });

  it("returns at most five newest Worker turn summaries with durable capture status", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "reviewer", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    for (let index = 0; index < 7; index += 1) {
      const turnId = `turn-${index}`;
      const occurredAt = `2026-09-01T00:0${index}:00.000Z`;
      const view = createQueuedWorkerTurnCard({ turnId, instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "root-1", requestText: `work ${index}`, queuePosition: index + 1, occurredAt });
      store.acceptInstanceTurnWithCard({ id: turnId, idempotencyKey: turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: `work ${index}`, parentTurnId: null, sourceMessageId: `message-${index}`, view, render: renderWorkerTurnCard });
      store.database.prepare("UPDATE instance_turns SET created_at = ?, updated_at = ? WHERE id = ?").run(occurredAt, occurredAt, turnId);
    }
    store.transitionInstanceTurnWithProjection({ turnId: "turn-6", expectedGeneration: worker.generation, state: "completed", result: "finding", eventKind: "turn.completed", change: { type: "completed", occurredAt: "2026-09-01T00:07:00.000Z", answer: "finding" }, render: renderWorkerTurnCard });

    const summaries = store.listRecentInstanceTurnSummaries(worker.id, 99);

    expect(summaries.map(({ id }) => id)).toEqual(["turn-6", "turn-5", "turn-4", "turn-3", "turn-2"]);
    expect(summaries[0]).toMatchObject({ result: "finding", resultCapture: "captured" });
    expect(summaries[1]).toMatchObject({ resultCapture: "pending" });
  });

  it("resolves a delivered Worker card message only when it identifies one turn", () => {
    store = new SqliteBindingStore(":memory:");
    for (const workerId of ["reviewer", "implementer"]) {
      store.createAgentInstance({ id: workerId, projectId: "p1", name: workerId, role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: `ws-${workerId}`, kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
      const worker = store.attachAgentInstanceRuntime({ instanceId: workerId, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: `w1:${workerId}`, nativeSessionId: `session-${workerId}` })!;
      const turnId = `turn-${workerId}`;
      const view = createQueuedWorkerTurnCard({ turnId, instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "root-1", requestText: "work", queuePosition: 1, occurredAt: "2026-09-06T00:00:00.000Z" });
      store.acceptInstanceTurnWithCard({ id: turnId, idempotencyKey: turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work", parentTurnId: null, sourceMessageId: `source-${turnId}`, view, render: renderWorkerTurnCard });
    }
    store.database.prepare("UPDATE worker_turn_cards SET message_id = ?, card_id = ? WHERE turn_id = ?").run("task-card-reviewer", "cardkit-reviewer", "turn-reviewer");

    expect(store.findWorkerTurnByCardMessage("task-card-reviewer")).toMatchObject({
      turn: { id: "turn-reviewer", instanceId: "reviewer" },
      view: { turnId: "turn-reviewer", instanceId: "reviewer" }
    });
    expect(store.findWorkerTurnByCardMessage("missing-card")).toBeNull();

    store.database.prepare("INSERT INTO worker_turn_card_pages(id, turn_id, page_index, page_start, element_id, message_id, card_id, state, sequence, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?, ?, 'active', 0, ?, ?)").run("legacy-reviewer-page", "turn-reviewer", "legacy-element", "continuation-reviewer", "legacy-card", "now", "now");
    expect(store.findWorkerTurnByCardMessage("continuation-reviewer")).toMatchObject({
      turn: { id: "turn-reviewer", instanceId: "reviewer" }
    });

    store.database.prepare("INSERT INTO worker_turn_card_pages(id, turn_id, page_index, page_start, element_id, message_id, card_id, state, sequence, created_at, updated_at) VALUES (?, ?, 0, 0, ?, ?, ?, 'active', 0, ?, ?)").run("legacy-implementer-page", "turn-implementer", "legacy-element-2", "task-card-reviewer", "legacy-card-2", "now", "now");
    expect(store.findWorkerTurnByCardMessage("task-card-reviewer")).toBeNull();
  });

  it("adds Worker card schema without backfilling historical turns", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-worker-card-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    store.acceptInstanceTurn({ id: "historical", idempotencyKey: "historical", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: "reviewer", instanceGeneration: 1, kind: "turn", text: "old" });
    store.database.exec("DROP TABLE worker_turn_card_pages; DROP TABLE worker_turn_cards; DELETE FROM schema_migrations WHERE version = 8");
    store.close(); store = undefined;

    store = new SqliteBindingStore(path);

    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 8").get()).toEqual({ version: 8 });
    expect(store.getInstanceTurn("historical")).toMatchObject({ parentTurnId: null, sourceMessageId: null, runtimeTurnId: null, runtimeTurnStartedAt: null });
    expect(store.loadWorkerTurnCard("historical")).toBeNull();
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("migrates Worker page states and preserves delivered checkpoints across reopen", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-worker-page-state-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "reviewer", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    const view = createQueuedWorkerTurnCard({ turnId: "turn-1", instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "root-1", requestText: "review", queuePosition: 1, occurredAt: "2026-09-01T00:00:00.000Z" });
    store.acceptInstanceTurnWithCard({ id: "turn-1", idempotencyKey: "turn-1", actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "review", parentTurnId: null, sourceMessageId: "m1", view, render: renderWorkerTurnCard });
    store.enqueueOutboundReply({ id: "legacy-create", idempotencyKey: "worker-turn:create:turn-1:0", workerTurnId: "turn-1", viewVersion: view.viewVersion, rootMessageId: "root-1", kind: "stream_card_create", payload: JSON.stringify({ card: renderWorkerTurnCard(view), stream: { pageIndex: 0, pageStart: 0, elementId: view.elementId } }) });
    store.markOutboundReplyDelivered("legacy-create", "worker-message-1", "worker-card-1");
    store.database.prepare("UPDATE worker_turn_card_pages SET sequence = 1 WHERE turn_id = ? AND page_index = 0").run("turn-1");
    store.database.exec("DELETE FROM schema_migrations WHERE version = 9");
    store.close(); store = undefined;

    store = new SqliteBindingStore(path);

    expect(store.loadWorkerTurnCard("turn-1")).toMatchObject({ messageId: "worker-message-1", cardId: "worker-card-1" });
    expect(store.listWorkerTurnCardPages("turn-1")).toEqual([expect.objectContaining({ state: "active", sequence: 1, messageId: "worker-message-1", cardId: "worker-card-1" })]);
    expect(store.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'worker_turn_card_pages'").get()).toMatchObject({ sql: expect.stringContaining("'frozen'") });
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("isolates a failed Worker turn lane from another Worker turn", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "reviewer", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    for (const turnId of ["turn-a", "turn-b"]) {
      const view = createQueuedWorkerTurnCard({ turnId, instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "root-1", requestText: turnId, queuePosition: 1, occurredAt: "2026-09-01T00:00:00.000Z" });
      store.acceptInstanceTurnWithCard({ id: turnId, idempotencyKey: turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: turnId, parentTurnId: null, sourceMessageId: `message-${turnId}`, view, render: renderWorkerTurnCard });
    }
    for (const turnId of ["turn-a", "turn-b"]) {
      const view = store.loadWorkerTurnCard(turnId)!;
      store.enqueueOutboundReply({ id: `legacy-${turnId}`, idempotencyKey: `worker-turn:create:${turnId}:0`, workerTurnId: turnId, rootMessageId: "root", kind: "stream_card_create", payload: JSON.stringify({ card: renderWorkerTurnCard(view), stream: { pageIndex: 0, pageStart: 0, elementId: view.elementId } }) });
    }
    const failed = store.getOutboundReply("legacy-turn-a")!;

    expect(store.markOutboundReplyFailedWithQuarantine(failed.id, "invalid target", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null })).toMatchObject({ action: "blocked" });
    expect(store.listOutboundLaneHeads(10, null)).toEqual([expect.objectContaining({ workerTurnId: "turn-b" })]);
    expect(store.database.prepare("SELECT DISTINCT lane_key FROM outbound_replies ORDER BY lane_key").all()).toEqual([
      { lane_key: "gateway:feishu:primary:worker-turn:turn-a" }, { lane_key: "gateway:feishu:primary:worker-turn:turn-b" }
    ]);
  });

  it("settles one Worker card and recomputes queued card positions atomically", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "reviewer", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    for (const [index, turnId] of ["turn-a", "turn-b", "turn-c"].entries()) {
      const view = createQueuedWorkerTurnCard({ turnId, instanceId: worker.id, instanceGeneration: worker.generation, workerName: worker.name, parentTurnId: null, rootMessageId: "root-1", requestText: turnId, queuePosition: index + 1, occurredAt: "2026-09-01T00:00:00.000Z" });
      store.acceptInstanceTurnWithCard({ id: turnId, idempotencyKey: turnId, actor: { kind: "human", userId: "u1" }, projectId: "p1", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: turnId, parentTurnId: null, sourceMessageId: `message-${turnId}`, view, render: renderWorkerTurnCard });
    }
    store.claimNextInstanceTurn(worker.id, worker.generation);

    const result = store.transitionInstanceTurnWithProjection({ turnId: "turn-a", expectedGeneration: worker.generation, state: "completed", result: "", eventKind: "turn.completed", change: { type: "completed-without-output", occurredAt: "2026-09-01T00:01:00.000Z", notice: "unavailable" }, render: renderWorkerTurnCard });

    expect(result).toMatchObject({ turn: { state: "completed", result: "" }, view: { phase: "completed", queuePosition: 0 } });
    expect(store.loadWorkerTurnCard("turn-b")).toMatchObject({ queuePosition: 1 });
    expect(store.loadWorkerTurnCard("turn-c")).toMatchObject({ queuePosition: 2 });
    expect(store.listPendingOutboundReplies().filter(({ workerTurnId }) => workerTurnId)).toHaveLength(0);
  });
  it("adds the Session operation inbox to an existing database", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-session-operation-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.database.exec("DROP TABLE session_operations");
    store.close();
    store = undefined;

    store = new SqliteBindingStore(path);

    expect(store.database.prepare("PRAGMA table_info(session_operations)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "interaction_id" }),
      expect.objectContaining({ name: "binding_generation" }),
      expect.objectContaining({ name: "state" })
    ]));
    expect(store.database.prepare("PRAGMA index_list(session_operations)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "session_operations_claim" }),
      expect.objectContaining({ name: "session_operations_recovery" })
    ]));
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("adds static delivery mode before backfilling legacy Answer pages", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-answer-page-delivery-mode-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-31T10:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root", answerCard: {} });
    store.database.exec(`
      DROP TABLE answer_pages;
      CREATE TABLE answer_pages(
        prompt_id TEXT NOT NULL REFERENCES prompt_jobs(id), page_index INTEGER NOT NULL, message_id TEXT, card_id TEXT, element_id TEXT NOT NULL,
        source_start INTEGER NOT NULL, sequence INTEGER NOT NULL DEFAULT 0, state TEXT NOT NULL CHECK(state IN ('creating','active','frozen','finished')),
        created_at TEXT NOT NULL, updated_at TEXT NOT NULL, PRIMARY KEY(prompt_id, page_index)
      );
    `);
    store.close();
    store = undefined;

    store = new SqliteBindingStore(path);

    expect(store.database.prepare("PRAGMA table_info(answer_pages)").all()).toEqual(expect.arrayContaining([expect.objectContaining({ name: "delivery_mode" })]));
    expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ deliveryMode: "streaming" })]);
  });

  it("atomically adopts the unique queued prompt matching an external Herdr turn", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", generation: 3, paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const queued = createQueuedRunCard({ promptId: "queued", bindingId: "b1", bindingGeneration: 3, title: "Work", workspaceId: "w1", paneId: "w1:p1", requestText: "line 1\r\nline 2", queuePosition: 1, occurredAt: "2026-08-31T10:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "queued", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "line 1\r\nline 2" }, view: queued, rootMessageId: "root", answerCard: {} });
    const startedAt = new Date(Date.now() + 1_000).toISOString();

    const result = store.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 3, expectedPaneId: "w1:p1", expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "turn-1", startedAt, requestText: "line 1\nline 2", externalPromptId: "external", externalMessageId: "herdr-turn:session-1:turn-1",
      externalView: { ...queued, promptId: "external" }, answerCardFor: renderRequestAnswerCard
    });

    expect(result).toMatchObject({ outcome: "adopted_queued", prompt: { id: "queued", executionOrigin: "herdr", state: "running", observationState: "attached", transcriptTurnId: "turn-1" }, supersededPromptIds: [], outboxReserved: true });
    expect(store.getPrompt("external")).toBeNull();
  });

  it("updates an already delivered queued Answer Card after external adoption", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const queued = createQueuedRunCard({ promptId: "queued", bindingId: "b1", title: "Work", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-08-31T10:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "queued", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view: queued, rootMessageId: "root", answerCard: {} });
    const create = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(create.id, "answer-1", "card-1");
    const startedAt = new Date(Date.now() + 1_000).toISOString();

    const result = store.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1", expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "turn-1", startedAt, requestText: "work", externalPromptId: "external", externalMessageId: "herdr-turn:session-1:turn-1",
      externalView: { ...queued, promptId: "external" }, answerCardFor: renderRequestAnswerCard
    });

    expect(result).toMatchObject({ outcome: "adopted_queued", outboxReserved: false });
    expect(store.loadRunCard("queued")).toMatchObject({ phase: "queued", answerMessageId: "answer-1", answerCardId: "card-1" });
  });

  it("creates an independently rendered Answer Card when no queued prompt uniquely matches", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", generation: 2, paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const externalView = createQueuedRunCard({ promptId: "external", bindingId: "b1", bindingGeneration: 2, title: "Direct work", workspaceId: "w1", paneId: "w1:p1", requestText: "direct work", queuePosition: 0, occurredAt: "2026-08-31T10:00:01.000Z" });

    const result = store.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 2, expectedPaneId: "w1:p1", expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "turn-2", startedAt: "2026-08-31T10:00:01.000Z", requestText: "direct work", externalPromptId: "external", externalMessageId: "herdr-turn:session-1:turn-2",
      externalView, answerCardFor: renderRequestAnswerCard
    });

    expect(result).toMatchObject({ outcome: "created_external", prompt: { id: "external", executionOrigin: "herdr", state: "running", observationState: "attached", transcriptTurnId: "turn-2" }, outboxReserved: true });
    expect(store.loadRunCard("external")).toMatchObject({ phase: "queued", queuePosition: 0, startedAt: null });
    expect(store.listPendingOutboundReplies()).toEqual(expect.arrayContaining([expect.objectContaining({ promptId: "external", kind: "stream_card_create", cardRole: "answer" })]));
  });

  it("fails an idle external turn only while every durable identity fence still matches", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", generation: 2, paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    store.database.prepare("UPDATE bindings SET last_agent_state = 'idle', last_observed_at = '2026-08-31T10:00:02.000Z' WHERE id = 'b1'").run();
    const startedAt = "2026-08-31T10:00:01.000Z";
    const externalView = createQueuedRunCard({ promptId: "external", bindingId: "b1", bindingGeneration: 2, title: "Direct", workspaceId: "w1", paneId: "w1:p1", requestText: ":q", queuePosition: 0, occurredAt: startedAt });
    store.adoptExternalTurn({ bindingId: "b1", expectedGeneration: 2, expectedPaneId: "w1:p1", expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, turnId: "turn-1", startedAt, requestText: ":q", externalPromptId: "external", externalMessageId: "external", externalView, answerCardFor: renderRequestAnswerCard });
    const input = { promptId: "external", bindingId: "b1", expectedGeneration: 2, expectedPaneId: "w1:p1", expectedSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }, expectedObservedAt: "2026-08-31T10:00:02.000Z", turnId: "turn-1", startedAt, error: "missing terminal event", occurredAt: "2026-08-31T10:01:00.000Z" };

    expect(store.failExternalTurnWithoutTerminalEvent({ ...input, expectedGeneration: 1 })).toBe(false);
    expect(store.failExternalTurnWithoutTerminalEvent({ ...input, expectedPaneId: "w1:p2" })).toBe(false);
    expect(store.failExternalTurnWithoutTerminalEvent({ ...input, expectedSession: { ...input.expectedSession, value: "session-2" } })).toBe(false);
    expect(store.failExternalTurnWithoutTerminalEvent({ ...input, expectedObservedAt: "2026-08-31T10:00:03.000Z" })).toBe(false);
    expect(store.failExternalTurnWithoutTerminalEvent({ ...input, turnId: "turn-2" })).toBe(false);
    expect(store.failExternalTurnWithoutTerminalEvent({ ...input, startedAt: "2026-08-31T10:00:00.000Z" })).toBe(false);
    store.database.prepare("UPDATE bindings SET attachment = 'degraded' WHERE id = 'b1'").run();
    expect(store.failExternalTurnWithoutTerminalEvent(input)).toBe(false);
    store.database.prepare("UPDATE bindings SET attachment = 'attached', last_agent_state = 'working' WHERE id = 'b1'").run();
    expect(store.failExternalTurnWithoutTerminalEvent(input)).toBe(false);
    store.database.prepare("UPDATE bindings SET last_agent_state = 'idle' WHERE id = 'b1'").run();
    store.database.prepare("UPDATE run_cards SET binding_generation = 1 WHERE prompt_id = 'external'").run();
    expect(store.failExternalTurnWithoutTerminalEvent(input)).toBe(false);
    store.database.prepare("UPDATE run_cards SET binding_generation = 2 WHERE prompt_id = 'external'").run();
    expect(store.getPrompt("external")).toMatchObject({ state: "running", observationState: "attached" });

    expect(store.failExternalTurnWithoutTerminalEvent(input)).toBe(true);
    expect(store.failExternalTurnWithoutTerminalEvent(input)).toBe(false);
    expect(store.getPrompt("external")).toMatchObject({ state: "failed", observationState: "completed", error: "missing terminal event" });
    expect(store.loadRunCard("external")).toMatchObject({ phase: "failed", notice: "missing terminal event" });
  });

  it("atomically supersedes an exact-owned detached prompt with a later external turn", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const oldView = createQueuedRunCard({ promptId: "old", bindingId: "b1", title: "Old", workspaceId: "w1", paneId: "w1:p1", requestText: "old work", queuePosition: 1, occurredAt: "2026-08-31T10:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "old", bindingId: "b1", larkMessageId: "m-old", actorOpenId: "u1", body: "old work" }, view: oldView, rootMessageId: "root", answerCard: {} });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'attached' WHERE id = 'old'").run();
    store.database.prepare("UPDATE run_cards SET phase = 'running' WHERE prompt_id = 'old'").run();
    store.markPromptDispatched("old", "2026-08-31T10:00:01.000Z");
    expect(store.claimPromptTranscriptTurn({ promptId: "old", bindingId: "b1", turnId: "old-turn", startedAt: "2026-08-31T10:00:01.250Z" })).toMatchObject({ state: "claimed" });
    store.markPromptObservationDetached("old", "uncertain");
    const externalView = createQueuedRunCard({ promptId: "external", bindingId: "b1", title: "New", workspaceId: "w1", paneId: "w1:p1", requestText: "new work", queuePosition: 0, occurredAt: "2026-08-31T10:00:02.000Z" });

    const result = store.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1", expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "new-turn", startedAt: "2026-08-31T10:00:02.000Z", requestText: "new work", externalPromptId: "external", externalMessageId: "herdr-turn:session-1:new-turn",
      supersede: { promptId: "old", turnId: "old-turn", startedAt: "2026-08-31T10:00:01.250Z" }, externalView, answerCardFor: renderRequestAnswerCard
    });

    expect(result).toMatchObject({ outcome: "created_external", supersededPromptIds: ["old"], prompt: { id: "external", transcriptTurnId: "new-turn" }, outboxReserved: true });
    expect(store.getPrompt("old")).toMatchObject({ state: "failed", observationState: "completed", transcriptTurnId: "old-turn" });
    expect(store.loadRunCard("old")).toMatchObject({ phase: "failed", notice: expect.stringContaining("newer Herdr turn") });
    expect(store.listPendingOutboundReplies()).toEqual(expect.arrayContaining([expect.objectContaining({ promptId: "external", cardRole: "answer" })]));
  });

  it("rejects supersession when the detached prompt fence does not match", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    store.database.prepare("INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, state, observation_state, dispatched_at, transcript_turn_id, transcript_turn_started_at, attempt_count, created_at, updated_at) VALUES ('old','b1','m-old','u1','old','running','detached','2026-08-31T10:00:01.000Z','old-turn','2026-08-31T10:00:01.250Z',1,'2026-08-31T10:00:00.000Z','2026-08-31T10:00:01.250Z')").run();
    const externalView = createQueuedRunCard({ promptId: "external", bindingId: "b1", title: "New", workspaceId: "w1", paneId: "w1:p1", requestText: "new", queuePosition: 0, occurredAt: "2026-08-31T10:00:02.000Z" });
    const result = store.adoptExternalTurn({ bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1", expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, turnId: "new-turn", startedAt: "2026-08-31T10:00:02.000Z", requestText: "new", externalPromptId: "external", externalMessageId: "external", supersede: { promptId: "old", turnId: "wrong-turn", startedAt: "2026-08-31T10:00:01.250Z" }, externalView, answerCardFor: renderRequestAnswerCard });
    expect(result.outcome).toBe("conflict");
    expect(store.getPrompt("old")).toMatchObject({ state: "running", observationState: "detached" });
    expect(store.getPrompt("external")).toBeNull();
  });

  it("does not reuse queued Feishu work when superseding an interrupted Herdr turn", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    for (const [id, body] of [["old", "old"], ["queued", "new"]] as const) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: body, queuePosition: 1, occurredAt: "2026-08-31T10:00:00.000Z" });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body }, view, rootMessageId: "root", answerCard: {} });
    }
    store.database.prepare("UPDATE prompt_jobs SET state='running', observation_state='detached', dispatched_at='2026-08-31T10:00:01.000Z', transcript_turn_id='old-turn', transcript_turn_started_at='2026-08-31T10:00:01.000Z' WHERE id='old'").run();
    store.database.prepare("UPDATE run_cards SET phase='running' WHERE prompt_id='old'").run();
    const externalView = createQueuedRunCard({ promptId: "external", bindingId: "b1", title: "new", workspaceId: "w1", paneId: "w1:p1", requestText: "new", queuePosition: 0, occurredAt: "2026-08-31T10:00:02.000Z" });
    const result = store.adoptExternalTurn({ bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1", expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, turnId: "new-turn", startedAt: "2026-08-31T10:00:02.000Z", requestText: "new", externalPromptId: "external", externalMessageId: "external", supersede: { promptId: "old", turnId: "old-turn", startedAt: "2026-08-31T10:00:01.000Z" }, externalView, answerCardFor: renderRequestAnswerCard });
    expect(result).toMatchObject({ outcome: "created_external", prompt: { id: "external" } });
    expect(store.getPrompt("queued")).toMatchObject({ state: "queued", observationState: "not_started", executionOrigin: "bridge" });
  });

  it("persists dispatch and exact transcript ownership provenance", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Prompt", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });

    expect(store.getPrompt("p1")).toMatchObject({ dispatchedAt: null, transcriptTurnId: null, transcriptTurnStartedAt: null });
    expect(store.claimNextDispatchablePrompt("b1")?.prompt).toMatchObject({ id: "p1", observationState: "not_started" });
    const dispatchedAt = "2026-08-30T00:00:01.000Z";
    store.markPromptDispatched("p1", dispatchedAt);

    const dispatched = store.getPrompt("p1")!;
    expect(dispatched).toMatchObject({ observationState: "attached", transcriptTurnId: null, transcriptTurnStartedAt: null });
    expect(dispatched.dispatchedAt).toBe(dispatchedAt);
    expect(dispatched.updatedAt).not.toBe(dispatchedAt);
    expect(() => store!.markPromptDispatched("p1", "not-an-iso-timestamp")).toThrow("Invalid prompt dispatch timestamp");
  });

  it("atomically skips only the oldest detached ordinary prompt and reserves its terminal card", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "creator" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle" });
    store.createPendingBinding({ id: "b2", workspaceId: "w2", chatId: "c1", topicId: "t2", rootMessageId: "other-root", title: "Other" });
    const seed = (id: string, bindingId: string, occurredAt: string) => {
      const view = createQueuedRunCard({ promptId: id, bindingId, title: id, workspaceId: bindingId === "b1" ? "w1" : "w2", paneId: `${bindingId}:p1`, requestText: `private ${id}`, queuePosition: 1, occurredAt });
      store!.acceptPrompt({ prompt: { id, bindingId, larkMessageId: `m-${id}`, actorOpenId: "u1", body: `private ${id}` }, view, rootMessageId: bindingId === "b1" ? "root" : "other-root", answerCard: { phase: "queued", id } });
    };
    seed("oldest", "b1", "2026-09-05T00:00:00.000Z");
    seed("newer", "b1", "2026-09-05T00:00:01.000Z");
    seed("queued", "b1", "2026-09-05T00:00:02.000Z");
    seed("third", "b1", "2026-09-05T00:00:03.000Z");
    seed("other", "b2", "2026-09-05T00:00:00.000Z");
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'detached' WHERE id IN ('oldest','newer','third','other')").run();
    store.database.prepare("UPDATE run_cards SET phase = 'running' WHERE prompt_id IN ('oldest','newer','third','other')").run();
    const initialCreate = store.listPendingOutboundReplies().find((reply) => reply.promptId === "oldest")!;
    store.markOutboundReplyDelivered(initialCreate.id, "answer-oldest", "card-oldest");

    const reason = "人工跳过；此前执行结果不确定，任务不会自动重放。";
    const result = store.skipOldestDetachedPrompt({
      bindingId: "b1", expectedBindingGeneration: 1, actorOpenId: "creator", sourceMessageId: "skip-message",
      reason, occurredAt: "2026-09-05T00:01:00.000Z", rootMessageId: "root", renderRunCard: (view) => ({ phase: view.phase, notice: view.notice, version: view.viewVersion })
    });

    expect(result).toEqual({ outcome: "skipped", promptId: "oldest", outboxReserved: true });
    expect(store.getPrompt("oldest")).toMatchObject({ state: "failed", observationState: "completed", error: reason, updatedAt: "2026-09-05T00:01:00.000Z" });
    expect(store.loadRunCard("oldest")).toMatchObject({ phase: "failed", notice: reason, finishedAt: "2026-09-05T00:01:00.000Z" });
    expect(store.getPrompt("newer")).toMatchObject({ state: "running", observationState: "detached" });
    expect(store.getPrompt("queued")).toMatchObject({ state: "queued", observationState: "not_started" });
    expect(store.getPrompt("third")).toMatchObject({ state: "running", observationState: "detached" });
    expect(store.getPrompt("other")).toMatchObject({ state: "running", observationState: "detached" });
    expect(store.listPendingOutboundReplies()).toContainEqual(expect.objectContaining({
      idempotencyKey: "run-card:update:oldest:answer:2", kind: "card_update", rootMessageId: "answer-oldest", payload: JSON.stringify({ phase: "failed", notice: reason, version: 2 })
    }));
    expect(store.database.prepare("SELECT actor_open_id, action, target, outcome FROM audit_log WHERE action = 'swarm.skip'").get()).toEqual({
      actor_open_id: "creator", action: "swarm.skip", target: "binding:b1:prompt:oldest:message:skip-message", outcome: "skipped"
    });
    expect(JSON.stringify(store.database.prepare("SELECT * FROM audit_log WHERE action = 'swarm.skip'").get())).not.toContain("private oldest");
  });

  it("does not skip another prompt when detached skip is stale or has no eligible target", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1" });
    for (const [id, occurredAt] of [["first", "2026-09-05T00:00:00.000Z"], ["second", "2026-09-05T00:00:01.000Z"]] as const) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: id, queuePosition: 1, occurredAt });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body: id }, view, rootMessageId: "root", answerCard: {} });
      store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'detached' WHERE id = ?").run(id);
      store.database.prepare("UPDATE run_cards SET phase = 'running' WHERE prompt_id = ?").run(id);
    }
    const input = { bindingId: "b1", expectedBindingGeneration: 2, actorOpenId: "creator", sourceMessageId: "skip", reason: "human skip", occurredAt: "2026-09-05T00:01:00.000Z", rootMessageId: "root", renderRunCard: () => ({}) };

    expect(store.skipOldestDetachedPrompt(input)).toEqual({ outcome: "stale" });
    expect(store.getPrompt("first")).toMatchObject({ state: "running", observationState: "detached" });
    expect(store.getPrompt("second")).toMatchObject({ state: "running", observationState: "detached" });
    store.database.prepare("UPDATE prompt_jobs SET state = 'delivered', observation_state = 'completed' WHERE id IN ('first','second')").run();
    expect(store.skipOldestDetachedPrompt({ ...input, expectedBindingGeneration: 1 })).toEqual({ outcome: "none" });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'swarm.skip'").get()).toEqual({ count: 0 });
  });

  it("does not let detached observation settle a prompt after skip won the state CAS", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "working" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "p1", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'detached' WHERE id = 'p1'").run();
    store.database.prepare("UPDATE run_cards SET phase = 'running' WHERE prompt_id = 'p1'").run();

    expect(store.skipOldestDetachedPrompt({ bindingId: "b1", expectedBindingGeneration: 1, actorOpenId: "creator", sourceMessageId: "skip", reason: "human skip", occurredAt: "2026-09-05T00:01:00.000Z", rootMessageId: "root", renderRunCard: () => ({}) })).toMatchObject({ outcome: "skipped" });
    expect(store.settleDetachedPrompt({
      promptId: "p1", bindingId: "b1", runtime: "idle", occurredAt: "2026-09-05T00:01:01.000Z",
      terminal: { kind: "completed", answer: "late answer", outputFingerprint: "late" }
    })).toBe(false);

    expect(store.getPrompt("p1")).toMatchObject({ state: "failed", observationState: "completed", error: "human skip" });
    expect(store.loadRunCard("p1")).toMatchObject({ phase: "failed", notice: "human skip" });
    expect(store.getBinding("b1")).toMatchObject({ lastAgentState: "working", lastOutputFingerprint: null });
  });

  it("returns stale without skipping the next detached prompt when the selected candidate loses its CAS", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1" });
    for (const [id, occurredAt] of [["first", "2026-09-05T00:00:00.000Z"], ["second", "2026-09-05T00:00:01.000Z"]] as const) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: id, queuePosition: 1, occurredAt });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body: id }, view, rootMessageId: "root", answerCard: {} });
      store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'detached' WHERE id = ?").run(id);
      store.database.prepare("UPDATE run_cards SET phase = 'running' WHERE prompt_id = ?").run(id);
    }
    store.database.exec("CREATE TRIGGER lose_first_skip BEFORE UPDATE OF state ON prompt_jobs WHEN OLD.id = 'first' AND NEW.state = 'failed' BEGIN SELECT RAISE(IGNORE); END");

    expect(store.skipOldestDetachedPrompt({ bindingId: "b1", expectedBindingGeneration: 1, actorOpenId: "creator", sourceMessageId: "skip", reason: "human skip", occurredAt: "2026-09-05T00:01:00.000Z", rootMessageId: "root", renderRunCard: () => ({}) })).toEqual({ outcome: "stale" });
    expect(store.getPrompt("first")).toMatchObject({ state: "running", observationState: "detached" });
    expect(store.getPrompt("second")).toMatchObject({ state: "running", observationState: "detached" });
  });

  it("does not skip a detached prompt owned by an earlier binding generation", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 2 });
    const view = createQueuedRunCard({ promptId: "old", bindingId: "b1", bindingGeneration: 1, title: "old", workspaceId: "w1", paneId: "w1:p0", requestText: "old", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "old", bindingId: "b1", larkMessageId: "m-old", actorOpenId: "u1", body: "old" }, view, rootMessageId: "root", answerCard: {} });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'detached' WHERE id = 'old'").run();
    store.database.prepare("UPDATE run_cards SET phase = 'running' WHERE prompt_id = 'old'").run();

    expect(store.skipOldestDetachedPrompt({ bindingId: "b1", expectedBindingGeneration: 2, actorOpenId: "creator", sourceMessageId: "skip", reason: "human skip", occurredAt: "2026-09-05T00:01:00.000Z", rootMessageId: "root", renderRunCard: () => ({}) })).toEqual({ outcome: "none" });
    expect(store.getPrompt("old")).toMatchObject({ state: "running", observationState: "detached" });
  });

  it("rolls back detached skip when its durable card projection fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "p1", workspaceId: "w1", paneId: "w1:p1", requestText: "private", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "private" }, view, rootMessageId: "root", answerCard: {} });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'detached' WHERE id = 'p1'").run();
    store.database.prepare("UPDATE run_cards SET phase = 'running' WHERE prompt_id = 'p1'").run();

    expect(() => store!.skipOldestDetachedPrompt({ bindingId: "b1", expectedBindingGeneration: 1, actorOpenId: "creator", sourceMessageId: "skip", reason: "human skip", occurredAt: "2026-09-05T00:01:00.000Z", rootMessageId: "root", renderRunCard: () => { throw new Error("render failed"); } })).toThrow("render failed");
    expect(store.getPrompt("p1")).toMatchObject({ state: "running", observationState: "detached", error: null });
    expect(store.loadRunCard("p1")).toMatchObject({ phase: "running" });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM audit_log WHERE action = 'swarm.skip'").get()).toEqual({ count: 0 });
  });

  it("updates the original pending Answer Card creation when skipping before delivery", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "p1", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: { phase: "queued" } });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'detached' WHERE id = 'p1'").run();
    store.database.prepare("UPDATE run_cards SET phase = 'running' WHERE prompt_id = 'p1'").run();
    const original = store.listPendingOutboundReplies()[0]!;

    expect(store.skipOldestDetachedPrompt({ bindingId: "b1", expectedBindingGeneration: 1, actorOpenId: "creator", sourceMessageId: "skip", reason: "human skip", occurredAt: "2026-09-05T00:01:00.000Z", rootMessageId: "root", renderRunCard: (run) => ({ phase: run.phase, version: run.viewVersion }) })).toMatchObject({ outcome: "skipped", outboxReserved: true });

    const replies = store.listPendingOutboundReplies().filter((reply) => reply.promptId === "p1");
    expect(replies).toHaveLength(1);
    expect(replies[0]).toMatchObject({ id: original.id, idempotencyKey: "run-card:create:p1:answer", kind: "stream_card_create", viewVersion: 2, payload: JSON.stringify({ phase: "failed", version: 2 }) });
  });

  it("claims a priority Primary turn before ordinary FIFO without reordering the ordinary queue", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle" });
    for (const [id, priority] of [["ordinary-1", "normal"], ["ordinary-2", "normal"], ["priority", "priority"]] as const) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: id, queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body: id, priority }, view, rootMessageId: "root", answerCard: {} });
    }

    expect(store.claimNextDispatchablePrompt("b1")?.prompt).toMatchObject({ id: "priority", priority: "priority" });
    store.updatePrompt("priority", "delivered");
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("ordinary-1");
    store.updatePrompt("ordinary-1", "delivered");
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("ordinary-2");
  });

  it("atomically pins a pending model revision to the next FIFO prompt claim", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle" });
    for (const [id, body, occurredAt] of [["p1", "first", "2026-09-05T00:00:00.000Z"], ["p2", "second", "2026-09-05T00:00:01.000Z"]] as const) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: body, workspaceId: "w1", paneId: "w1:p1", requestText: body, queuePosition: 1, occurredAt });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body }, view, rootMessageId: "root", answerCard: {} });
    }

    expect(store.acceptModelPreference({ bindingId: "b1", bindingGeneration: 1, model: "GPT-5.4" })).toMatchObject({
      outcome: "accepted", preference: { desiredModel: "GPT-5.4", desiredRevision: 1, state: "pending", dispatchPromptId: null }
    });

    expect(store.claimNextDispatchablePrompt("b1")).toMatchObject({
      prompt: { id: "p1" },
      model: { name: "GPT-5.4", revision: 1 }
    });
    expect(store.getModelPreference("b1")).toMatchObject({
      bindingGeneration: 1, desiredModel: "GPT-5.4", desiredRevision: 1, state: "applying", dispatchPromptId: "p1"
    });
    expect(store.getPrompt("p1")).toMatchObject({ modelName: "GPT-5.4", modelRevision: 1 });

    expect(store.acceptModelPreference({ bindingId: "b1", bindingGeneration: 1, model: "GPT-5.5" })).toMatchObject({
      outcome: "busy", preference: { desiredModel: "GPT-5.4", desiredRevision: 1, dispatchPromptId: "p1" }
    });
    expect(store.getPrompt("p1")).toMatchObject({ modelName: "GPT-5.4", modelRevision: 1 });
  });

  it("replaces only pending model preferences and fences them by binding generation", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });

    expect(store.acceptModelPreference({ bindingId: "b1", bindingGeneration: 2, model: "GPT-5.4" })).toEqual({ outcome: "stale", preference: null });
    expect(store.acceptModelPreference({ bindingId: "b1", bindingGeneration: 1, model: "GPT-5.4" })).toMatchObject({ outcome: "accepted", preference: { desiredRevision: 1 } });
    expect(store.acceptModelPreference({ bindingId: "b1", bindingGeneration: 1, model: "GPT-5.5" })).toMatchObject({
      outcome: "accepted", preference: { desiredModel: "GPT-5.5", desiredRevision: 2, state: "pending", effectiveModel: null, effectiveRevision: null }
    });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM binding_model_preferences WHERE binding_id = 'b1'").get()).toEqual({ count: 1 });
  });

  it("migrates model preferences without fabricating an effective model", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-model-preference-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });

    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 25").get()).toEqual({ version: 25 });
    expect(store.database.prepare("PRAGMA table_info(prompt_jobs)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "model_name" }), expect.objectContaining({ name: "model_revision" })
    ]));
    expect(store.getModelPreference("b1")).toBeNull();
    expect(() => store!.database.prepare("INSERT INTO binding_model_preferences(binding_id, binding_generation, desired_model, desired_revision, state, updated_at) VALUES ('missing',1,'GPT-5.4',1,'pending','now')").run()).toThrow();
    expect(() => store!.database.prepare("INSERT INTO binding_model_preferences(binding_id, binding_generation, desired_model, desired_revision, state, updated_at) VALUES ('b1',1,'GPT-5.4',0,'pending','now')").run()).toThrow();
  });

  it("fences model prompt prepare, dispatch, acceptance, and uncertainty by exact revision", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Prompt", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    store.acceptModelPreference({ bindingId: "b1", bindingGeneration: 1, model: "GPT-5.4" });
    store.claimNextDispatchablePrompt("b1");

    expect(store.markModelPromptPrepared({ bindingId: "b1", bindingGeneration: 1, promptId: "p1", revision: 2, operationId: "wrong" })).toBe(false);
    expect(store.markModelPromptPrepared({ bindingId: "b1", bindingGeneration: 1, promptId: "p1", revision: 1, operationId: "op1" })).toBe(true);
    expect(store.getModelPreference("b1")).toMatchObject({ state: "applying", preparedOperationId: "op1" });
    expect(store.rollbackPreparedModelPrompt({ bindingId: "b1", bindingGeneration: 1, promptId: "p1", revision: 1, operationId: "wrong" })).toBe(false);
    store.markPromptDispatched("p1", "2026-09-05T00:00:01.000Z");
    expect(store.rollbackPreparedModelPrompt({ bindingId: "b1", bindingGeneration: 1, promptId: "p1", revision: 1, operationId: "op1" })).toBe(true);
    expect(store.getPrompt("p1")).toMatchObject({ dispatchedAt: null, observationState: "attached" });
    expect(store.getModelPreference("b1")).toMatchObject({ state: "pending", dispatchPromptId: null, preparedOperationId: null });
    store.database.prepare("UPDATE binding_model_preferences SET state = 'applying', dispatch_prompt_id = 'p1', prepared_operation_id = 'op1' WHERE binding_id = 'b1'").run();
    expect(store.markModelPromptAccepted({ bindingId: "b1", bindingGeneration: 1, promptId: "p1", revision: 1, operationId: "wrong", turnId: "turn-1" })).toBe(false);
    expect(store.markModelPromptAccepted({ bindingId: "b1", bindingGeneration: 1, promptId: "p1", revision: 1, operationId: "op1", turnId: "turn-1" })).toBe(true);
    expect(store.getModelPreference("b1")).toMatchObject({ state: "effective", effectiveModel: "GPT-5.4", effectiveRevision: 1, dispatchPromptId: null });
    expect(store.getPrompt("p1")).toMatchObject({ transcriptTurnId: "turn-1" });
  });

  it("requeues only model claims proven not prepared and makes prepared claims uncertain on recovery", () => {
    store = new SqliteBindingStore(":memory:");
    for (const id of ["safe", "prepared"] as const) {
      store.createPendingBinding({ id, workspaceId: `w-${id}`, chatId: "c1", topicId: `t-${id}`, rootMessageId: `root-${id}`, title: id });
      store.updateBinding(id, { state: "active", lifecycle: "active", attachment: "attached", paneId: `w-${id}:p1`, lastAgentState: "idle" });
      const view = createQueuedRunCard({ promptId: `p-${id}`, bindingId: id, title: id, workspaceId: `w-${id}`, paneId: `w-${id}:p1`, requestText: id, queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: `p-${id}`, bindingId: id, larkMessageId: `m-${id}`, actorOpenId: "u1", body: id }, view, rootMessageId: `root-${id}`, answerCard: {} });
      store.acceptModelPreference({ bindingId: id, bindingGeneration: 1, model: "GPT-5.4" });
      store.claimNextDispatchablePrompt(id);
    }
    store.markModelPromptPrepared({ bindingId: "prepared", bindingGeneration: 1, promptId: "p-prepared", revision: 1, operationId: "op-prepared" });

    store.recoverRunningPrompts();

    expect(store.getPrompt("p-safe")).toMatchObject({ state: "queued", observationState: "not_started", modelName: null, modelRevision: null });
    expect(store.getModelPreference("safe")).toMatchObject({ state: "pending", dispatchPromptId: null });
    expect(store.getPrompt("p-prepared")).toMatchObject({ state: "running", observationState: "detached", modelName: "GPT-5.4", modelRevision: 1 });
    expect(store.getModelPreference("prepared")).toMatchObject({ state: "uncertain", dispatchPromptId: "p-prepared", preparedOperationId: "op-prepared" });
  });

  it("rolls back a pre-prepare model failure and marks a dispatched observer uncertain", () => {
    store = new SqliteBindingStore(":memory:");
    for (const id of ["failed", "detached"] as const) {
      store.createPendingBinding({ id, workspaceId: `w-${id}`, chatId: "c1", topicId: `t-${id}`, rootMessageId: `root-${id}`, title: id });
      store.updateBinding(id, { state: "active", lifecycle: "active", attachment: "attached", paneId: `w-${id}:p1`, lastAgentState: "idle" });
      const view = createQueuedRunCard({ promptId: `p-${id}`, bindingId: id, title: id, workspaceId: `w-${id}`, paneId: `w-${id}:p1`, requestText: id, queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id: `p-${id}`, bindingId: id, larkMessageId: `m-${id}`, actorOpenId: "u1", body: id }, view, rootMessageId: `root-${id}`, answerCard: {} });
      store.acceptModelPreference({ bindingId: id, bindingGeneration: 1, model: "GPT-5.4" });
      store.claimNextDispatchablePrompt(id);
    }

    store.failPrompt({ promptId: "p-failed", error: "prepare rejected", occurredAt: "2026-09-05T00:00:01.000Z" });
    expect(store.getModelPreference("failed")).toMatchObject({ state: "pending", dispatchPromptId: null, preparedOperationId: null });

    store.markModelPromptPrepared({ bindingId: "detached", bindingGeneration: 1, promptId: "p-detached", revision: 1, operationId: "op-detached" });
    store.markPromptDispatched("p-detached", "2026-09-05T00:00:01.000Z");
    store.markPromptObservationDetached("p-detached", "commit outcome unknown");
    expect(store.getModelPreference("detached")).toMatchObject({ state: "uncertain", dispatchPromptId: "p-detached", preparedOperationId: "op-detached" });
  });

  it("claims one eligible transcript turn without allowing replacement", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Prompt", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    store.claimNextDispatchablePrompt("b1");
    store.markPromptDispatched("p1", new Date().toISOString());
    const dispatched = store.getPrompt("p1")!;
    const turnId = "01a052d3-9c14-70e1-a375-397e2ecb55e9";
    const startedAt = new Date(Date.parse(dispatched.dispatchedAt!) + 250).toISOString();
    const claim = { promptId: "p1", bindingId: "b1", turnId, startedAt };

    expect(store.claimPromptTranscriptTurn({ ...claim, startedAt: new Date(Date.parse(dispatched.dispatchedAt!) - 1_001).toISOString() })).toMatchObject({ state: "ineligible", prompt: { transcriptTurnId: null } });
    expect(store.claimPromptTranscriptTurn(claim)).toMatchObject({ state: "claimed", prompt: { transcriptTurnId: turnId, transcriptTurnStartedAt: startedAt } });
    expect(store.claimPromptTranscriptTurn(claim)).toMatchObject({ state: "matched", prompt: { transcriptTurnId: turnId, transcriptTurnStartedAt: startedAt } });
    expect(store.claimPromptTranscriptTurn({ ...claim, turnId: "01a052d3-9c14-70e1-a375-397e2ecb55ea" })).toMatchObject({ state: "conflict", prompt: { transcriptTurnId: turnId, transcriptTurnStartedAt: startedAt } });
    store.markPromptObservationDetached("p1", "recovering");
    expect(store.claimPromptTranscriptTurn(claim)).toMatchObject({ state: "matched", prompt: { observationState: "detached", transcriptTurnId: turnId } });
    store.database.prepare("UPDATE prompt_jobs SET dispatched_at = 'unusable-dispatch-time', transcript_turn_started_at = 'unusable-stored-start' WHERE id = 'p1'").run();
    expect(store.claimPromptTranscriptTurn({ ...claim, startedAt: "unusable-input-start" })).toMatchObject({ state: "matched", prompt: { observationState: "detached", transcriptTurnId: turnId } });
    expect(store.claimPromptTranscriptTurn({ ...claim, turnId: "01a052d3-9c14-70e1-a375-397e2ecb55ea", startedAt: "unusable-input-start" })).toMatchObject({ state: "conflict", prompt: { observationState: "detached", transcriptTurnId: turnId } });
  });

  it("preserves transcript provenance when recovering attached prompts as detached", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle" });
    for (const id of ["owned", "legacy"]) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: id, queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body: id }, view, rootMessageId: "root", answerCard: {} });
      store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'attached', dispatched_at = ? WHERE id = ?").run("2026-08-30T00:00:01.000Z", id);
    }
    expect(store.claimPromptTranscriptTurn({ promptId: "owned", bindingId: "b1", turnId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", startedAt: "2026-08-30T00:00:01.250Z" })).toMatchObject({ state: "claimed" });

    expect(store.recoverRunningPrompts()).toBe(2);
    expect(store.getPrompt("owned")).toMatchObject({ observationState: "detached", dispatchedAt: "2026-08-30T00:00:01.000Z", transcriptTurnId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", transcriptTurnStartedAt: "2026-08-30T00:00:01.250Z" });
    expect(store.getPrompt("legacy")).toMatchObject({ observationState: "detached", dispatchedAt: "2026-08-30T00:00:01.000Z", transcriptTurnId: null, transcriptTurnStartedAt: null });
  });

  it("fills the canonical start time for an already accepted model turn without changing its identity", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Prompt", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    store.acceptModelPreference({ bindingId: "b1", bindingGeneration: 1, model: "GPT-5.4" });
    store.claimNextDispatchablePrompt("b1");
    store.markModelPromptPrepared({ bindingId: "b1", bindingGeneration: 1, promptId: "p1", revision: 1, operationId: "op1" });
    store.markPromptDispatched("p1", "2026-09-05T00:00:01.000Z");
    store.markModelPromptAccepted({ bindingId: "b1", bindingGeneration: 1, promptId: "p1", revision: 1, operationId: "op1", turnId: "turn-1" });

    expect(store.claimPromptTranscriptTurn({ promptId: "p1", bindingId: "b1", turnId: "turn-1", startedAt: "2026-09-05T00:00:01.250Z" })).toMatchObject({
      state: "claimed", prompt: { transcriptTurnId: "turn-1", transcriptTurnStartedAt: "2026-09-05T00:00:01.250Z" }
    });
    expect(store.claimPromptTranscriptTurn({ promptId: "p1", bindingId: "b1", turnId: "turn-2", startedAt: "2026-09-05T00:00:01.500Z" })).toMatchObject({ state: "conflict" });
  });

  it.each([
    ["queued", "not_started", 0],
    ["completed", "completed", 0],
    ["already detached", "detached", 1]
  ] as const)("does not make a first transcript claim for a %s prompt", (_label, observationState, wasDetached) => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Prompt", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    const state = observationState === "not_started" ? "queued" : observationState === "completed" ? "delivered" : "running";
    store.database.prepare("UPDATE prompt_jobs SET state = ?, observation_state = ?, was_detached = ?, dispatched_at = ? WHERE id = 'p1'").run(state, observationState, wasDetached, "2026-08-30T00:00:00.000Z");

    expect(store.claimPromptTranscriptTurn({ promptId: "p1", bindingId: "b1", turnId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", startedAt: "2026-08-30T00:00:00.250Z" })).toMatchObject({ state: "ineligible", prompt: { transcriptTurnId: null } });
  });

  it("adds nullable transcript provenance to legacy prompt rows without changing state", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-turn-provenance-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const view = createQueuedRunCard({ promptId: "legacy", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "legacy", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} });
    store.database.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE prompt_jobs_legacy(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), lark_message_id TEXT UNIQUE NOT NULL,
        actor_open_id TEXT NOT NULL, body TEXT NOT NULL, dispatch_kind TEXT NOT NULL DEFAULT 'turn' CHECK(dispatch_kind IN ('turn','steering')), priority TEXT NOT NULL DEFAULT 'normal', parent_prompt_id TEXT,
        steering_origin TEXT CHECK(steering_origin IN ('explicit','automatic','converted')), source_prompt_id TEXT REFERENCES prompt_jobs_legacy(id), was_detached INTEGER NOT NULL DEFAULT 0 CHECK(was_detached IN (0,1)),
        state TEXT NOT NULL CHECK(state IN ('queued','running','delivered','failed','cancelled')), observation_state TEXT NOT NULL DEFAULT 'not_started' CHECK(observation_state IN ('not_started','attached','detached','completed')),
        attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO prompt_jobs_legacy(id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, parent_prompt_id, steering_origin, source_prompt_id, was_detached, state, observation_state, attempt_count, error, created_at, updated_at)
        SELECT id, binding_id, lark_message_id, actor_open_id, body, 'turn', NULL, NULL, NULL, was_detached, state, observation_state, attempt_count, error, created_at, updated_at FROM prompt_jobs;
      DROP TABLE prompt_jobs;
      ALTER TABLE prompt_jobs_legacy RENAME TO prompt_jobs;
      PRAGMA foreign_keys = ON;
    `);
    store.close();
    store = undefined;

    store = new SqliteBindingStore(path);
    expect(store.getPrompt("legacy")).toMatchObject({ state: "queued", observationState: "not_started", dispatchedAt: null, transcriptTurnId: null, transcriptTurnStartedAt: null });
  });

  it("fences Primary capabilities to an attached binding generation with exactly one active ordinary prompt", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 3 });
    const view = createQueuedRunCard({ promptId: "parent", bindingId: "b1", bindingGeneration: 3, title: "parent", workspaceId: "w1", paneId: "w1:p1", requestText: "coordinate", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "parent", bindingId: "b1", larkMessageId: "m-parent", actorOpenId: "u1", body: "coordinate" }, view, rootMessageId: "root", answerCard: {} });
    store.updatePrompt("parent", "running");

    expect(store.setBindingPrimaryToolCapability({ bindingId: "b1", expectedGeneration: 3, capabilityHash: "hash" })).toBe(true);
    expect(store.verifyBindingPrimaryToolCapability({ bindingId: "b1", expectedGeneration: 3, capabilityHash: "hash" })).toBe(true);
    expect(store.getActiveOrdinaryPrompt("b1", 3)).toMatchObject({ id: "parent", state: "running" });
    expect(store.verifyBindingPrimaryToolCapability({ bindingId: "b1", expectedGeneration: 2, capabilityHash: "hash" })).toBe(false);
    expect(store.setBindingPrimaryToolCapability({ bindingId: "b1", expectedGeneration: 4, capabilityHash: "next-hash" })).toBe(true);
    expect(store.verifyBindingPrimaryToolCapability({ bindingId: "b1", expectedGeneration: 3, capabilityHash: "hash" })).toBe(true);

    store.updateBinding("b1", { attachment: "orphaned" });
    expect(store.verifyBindingPrimaryToolCapability({ bindingId: "b1", expectedGeneration: 3, capabilityHash: "hash" })).toBe(false);
    expect(store.getActiveOrdinaryPrompt("b1", 3)).toBeNull();
  });

  it("does not treat a running prompt from an earlier binding generation as active", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 1 });
    const view = createQueuedRunCard({ promptId: "generation-1", bindingId: "b1", bindingGeneration: 1, title: "parent", workspaceId: "w1", paneId: "w1:p1", requestText: "coordinate", queuePosition: 1, occurredAt: "2026-08-30T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "generation-1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "coordinate" }, view, rootMessageId: "root", answerCard: {} });
    store.updatePrompt("generation-1", "running");
    store.updateBinding("b1", { generation: 2 });

    expect(store.getActiveOrdinaryPrompt("b1", 2)).toBeNull();
  });

  it("returns only the uniquely active external prompt for recovery", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 1, agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const view = createQueuedRunCard({ promptId: "external", bindingId: "b1", bindingGeneration: 1, title: "external", workspaceId: "w1", paneId: "w1:p1", requestText: "direct", queuePosition: 0, occurredAt: "2026-08-30T00:00:00.000Z" });
    store.adoptExternalTurn({
      bindingId: "b1", expectedGeneration: 1, expectedPaneId: "w1:p1",
      expectedSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" },
      turnId: "turn-1", startedAt: "2026-08-30T00:00:00.000Z", requestText: "direct", externalPromptId: "external",
      externalMessageId: "herdr-turn:session-1:turn-1", externalView: view, answerCardFor: () => ({})
    });

    expect(store.getActiveExternalPrompt("b1", 1)).toMatchObject({ id: "external", executionOrigin: "herdr", transcriptTurnId: "turn-1" });
    expect(store.getActiveExternalPrompt("b1", 2)).toBeNull();
    store.completeTurn({ promptId: "external", bindingId: "b1", answer: "done", outputFingerprint: "fingerprint", occurredAt: "2026-08-30T00:00:01.000Z" });
    expect(store.getActiveExternalPrompt("b1", 1)).toBeNull();
  });

  it("atomically revokes the retained generation capability when attaching an unproven pane", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "orphaned", lifecycle: "active", attachment: "orphaned", paneId: "w1:old" });
    store.setBindingPrimaryToolCapability({ bindingId: "b1", expectedGeneration: 1, capabilityHash: "hash" });

    store.attachBindingPane("b1", { paneId: "w1:selected", terminalId: "term-selected", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle", foregroundExecutables: ["traex"] }, false);

    expect(store.hasBindingPrimaryToolCapability("b1", 1)).toBe(false);
  });

  it("recreates only legacy instance-keyed Primary capabilities during schema convergence", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "primary-capability-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "preserved-binding", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Preserved" });
    store.createAgentInstance({ id: "preserved-worker", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "preserved-workspace", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    store.database.exec("DROP TABLE primary_tool_capabilities; CREATE TABLE primary_tool_capabilities(instance_id TEXT PRIMARY KEY REFERENCES agent_instances(id) ON DELETE CASCADE, instance_generation INTEGER NOT NULL, capability_hash TEXT NOT NULL, created_at TEXT NOT NULL)");
    store.database.prepare("INSERT INTO primary_tool_capabilities VALUES (?, ?, ?, ?)").run("preserved-worker", 1, "ephemeral-secret", "2026-08-30T00:00:00.000Z");
    store.close(); store = undefined;

    store = new SqliteBindingStore(path);
    const columns = store.database.prepare("PRAGMA table_info(primary_tool_capabilities)").all() as Array<{ name: string; pk: number }>;
    expect(columns.map(({ name }) => name)).toEqual(["binding_id", "binding_generation", "capability_hash", "created_at"]);
    expect(columns.filter(({ pk }) => pk > 0).map(({ name }) => name)).toEqual(["binding_id", "binding_generation"]);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM primary_tool_capabilities").get()).toEqual({ count: 0 });
    expect(store.getBinding("preserved-binding")).not.toBeNull();
    expect(store.getAgentInstance("preserved-worker")).not.toBeNull();
    expect(store.getWorkspaceLease("preserved-workspace")).not.toBeNull();
  });

  it("creates instance hot-path indexes and paginates equal-timestamp history without gaps", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    for (let index = 0; index < 7; index += 1) store.acceptInstanceTurn({ id: `turn-${index}`, idempotencyKey: `turn-${index}`, actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: "i1", instanceGeneration: 1, kind: "turn", text: `work ${index}` });
    store.database.prepare("UPDATE instance_turns SET created_at = '2026-08-30T00:00:00.000Z'").run();

    const first = store.listInstanceTurns("i1", { limit: 3 });
    const second = store.listInstanceTurns("i1", { limit: 3, after: first.nextCursor! });
    const third = store.listInstanceTurns("i1", { limit: 3, after: second.nextCursor! });
    expect([...first.items, ...second.items, ...third.items].map(({ id }) => id)).toEqual(Array.from({ length: 7 }, (_, index) => `turn-${index}`));
    expect(first.nextCursor).toEqual({ createdAt: "2026-08-30T00:00:00.000Z", id: "turn-2" });
    expect(third.nextCursor).toBeNull();

    const indexNames = (store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'index' AND name LIKE 'instance_%'").all() as Array<{ name: string }>).map(({ name }) => name);
    expect(indexNames).toEqual(expect.arrayContaining(["instance_turns_observable", "instance_turns_instance_history", "instance_events_instance_id"]));
    const historyPlan = store.database.prepare("EXPLAIN QUERY PLAN SELECT * FROM instance_turns INDEXED BY instance_turns_instance_history WHERE instance_id = ? ORDER BY created_at, id LIMIT 10").all("i1") as Array<{ detail: string }>;
    const observablePlan = store.database.prepare("EXPLAIN QUERY PLAN SELECT * FROM instance_turns INDEXED BY instance_turns_observable WHERE state IN ('dispatching','running','blocked','dispatch-uncertain') ORDER BY created_at, id").all() as Array<{ detail: string }>;
    const eventPlan = store.database.prepare("EXPLAIN QUERY PLAN SELECT * FROM instance_events INDEXED BY instance_events_instance_id WHERE instance_id = ? AND id > ? ORDER BY id LIMIT 100").all("i1", 0) as Array<{ detail: string }>;
    expect(historyPlan.some(({ detail }) => detail.includes("instance_turns_instance_history"))).toBe(true);
    expect(observablePlan.some(({ detail }) => detail.includes("instance_turns_observable"))).toBe(true);
    expect(eventPlan.some(({ detail }) => detail.includes("instance_events_instance_id"))).toBe(true);
  });

  it("persists exact approval identity and consumes a matching grant once", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const identity = { actorId: "user-1", projectId: "project-a", instanceId: "i1", instanceGeneration: 1, actionFingerprint: "sha256:action", resourceScope: "repo/acme#new", policyVersion: "policy-v1" };
    const request = store.createApprovalRequest({ id: "request-1", ...identity, expiresAt: "2026-08-28T16:00:00.000Z" });
    expect(request).toMatchObject({ ...identity, state: "pending", tier: "remote-confirmation" });

    expect(store.resolveApprovalRequest({ requestId: request.id, actorId: "other", approved: true, now: "2026-08-28T15:00:00.000Z", grantId: "grant-x" }).outcome).toBe("unauthorized");
    expect(store.resolveApprovalRequest({ requestId: request.id, actorId: "user-1", approved: true, now: "2026-08-28T15:00:00.000Z", grantId: "grant-1" })).toMatchObject({ outcome: "approved", grant: { id: "grant-1", ...identity, consumedAt: null } });
    expect(store.resolveApprovalRequest({ requestId: request.id, actorId: "user-1", approved: true, now: "2026-08-28T15:01:00.000Z", grantId: "grant-2" }).outcome).toBe("duplicate");
    expect(store.consumeApprovalGrant({ grantId: "grant-1", ...identity, actionFingerprint: "sha256:changed", now: "2026-08-28T15:02:00.000Z" })).toBe("mismatch");
    expect(store.consumeApprovalGrant({ grantId: "grant-1", ...identity, now: "2026-08-28T15:02:00.000Z" })).toBe("consumed");
    expect(store.consumeApprovalGrant({ grantId: "grant-1", ...identity, now: "2026-08-28T15:03:00.000Z" })).toBe("used");
  });

  it("atomically creates and reads an agent instance with its workspace lease", () => {
    store = new SqliteBindingStore(":memory:");

    const created = store.createAgentInstance({
      id: "i1", projectId: "project-a", name: "reviewer", role: "worker", agentKind: "claude-code", model: null,
      desiredState: "stopped", workspace: { id: "ws1", kind: "git-worktree", cwd: "/work/reviewer", branch: "worker/reviewer", baseCommit: "abc123" }
    });

    expect(created).toMatchObject({ id: "i1", projectId: "project-a", name: "reviewer", role: "worker", generation: 1, observedState: "unprovisioned", workspaceLeaseId: "ws1" });
    expect(store.getAgentInstance("i1")).toEqual(created);
    expect(store.getWorkspaceLease("ws1")).toMatchObject({ instanceId: "i1", kind: "git-worktree", state: "allocating", branch: "worker/reviewer" });
  });

  it("enforces one primary per project and switches it atomically", () => {
    store = new SqliteBindingStore(":memory:");
    const create = (id: string, name: string) => store!.createAgentInstance({
      id, projectId: "project-a", name, role: "worker", agentKind: "traex", model: null, desiredState: "stopped",
      workspace: { id: `ws-${id}`, kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "abc123" }
    });
    create("i1", "one");
    create("i2", "two");

    expect(store.setPrimaryAgentInstance("project-a", "i1")).toMatchObject({ id: "i1", role: "primary" });
    expect(store.setPrimaryAgentInstance("project-a", "i2")).toMatchObject({ id: "i2", role: "primary" });
    expect(store.listAgentInstances("project-a").map(({ id, role }) => ({ id, role }))).toEqual([
      { id: "i1", role: "worker" }, { id: "i2", role: "primary" }
    ]);
  });

  it("allows Worker listings to exclude a preserved legacy Primary row", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "legacy-primary", projectId: "project-a", name: "legacy", role: "primary", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "ws-primary", kind: "main-checkout", cwd: "/repo", branch: null, baseCommit: "abc123" } });
    store.createAgentInstance({ id: "worker", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "ws-worker", kind: "git-worktree", cwd: "/repo/.worktree/worker", branch: "swarm/worker", baseCommit: "abc123" } });

    expect(store.listAgentInstances("project-a").filter(({ role }) => role === "worker").map(({ id }) => id)).toEqual(["worker"]);
    expect(store.getAgentInstance("legacy-primary")).toMatchObject({ id: "legacy-primary", role: "primary" });
  });

  it("atomically enforces the Worker limit while ignoring legacy Primary rows", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "legacy-primary", projectId: "project-a", name: "legacy", role: "primary", agentKind: "traex", model: null, desiredState: "stopped", workspace: { id: "ws-primary", kind: "main-checkout", cwd: "/repo", branch: null, baseCommit: "abc123" } });
    const worker = (id: string) => ({ id, projectId: "project-a", name: id, role: "worker" as const, agentKind: "traex" as const, model: null, desiredState: "stopped" as const, parent: { bindingId: "binding-a", paneId: "w1:p1", nativeSessionId: null }, workspace: { id: `ws-${id}`, kind: "git-worktree" as const, cwd: `/repo/.worktree/${id}`, branch: `swarm/${id}`, baseCommit: "abc123" } });

    expect(store.createWorkerAgentInstance(worker("one"), 1)).toMatchObject({ outcome: "created", instance: { id: "one", role: "worker" } });
    expect(store.createWorkerAgentInstance(worker("two"), 1)).toEqual({ outcome: "limit-reached" });
    expect(store.listAgentInstances("project-a").map(({ id }) => id)).toEqual(["legacy-primary", "one"]);
    expect(store.getWorkspaceLease("ws-two")).toBeNull();
  });

  it("allows only one of two competing Worker inserts at the last slot", async () => {
    store = new SqliteBindingStore(":memory:");
    const worker = (id: string) => ({ id, projectId: "project-a", name: id, role: "worker" as const, agentKind: "traex" as const, model: null, desiredState: "stopped" as const, parent: { bindingId: "binding-a", paneId: "w1:p1", nativeSessionId: null }, workspace: { id: `ws-${id}`, kind: "git-worktree" as const, cwd: `/repo/.worktree/${id}`, branch: `swarm/${id}`, baseCommit: "abc123" } });

    const outcomes = await Promise.all(["one", "two"].map(async (id) => store!.createWorkerAgentInstance(worker(id), 1)));
    expect(outcomes.map(({ outcome }) => outcome).sort()).toEqual(["created", "limit-reached"]);
    expect(store.listAgentInstances("project-a").filter(({ role }) => role === "worker")).toHaveLength(1);
  });

  it("scopes Worker name uniqueness to the exact Primary binding and pane", () => {
    store = new SqliteBindingStore(":memory:");
    const worker = (id: string, bindingId: string, paneId: string) => ({
      id, projectId: "project-a", name: "reviewer", role: "worker" as const, agentKind: "traex" as const, model: null, desiredState: "stopped" as const,
      parent: { bindingId, paneId, nativeSessionId: null },
      workspace: { id: `ws-${id}`, kind: "git-worktree" as const, cwd: `/repo/.worktree/${id}`, branch: `swarm/${id}`, baseCommit: "abc123" }
    });

    expect(store.createWorkerAgentInstance(worker("one", "binding-a", "w1:p1"), 4).outcome).toBe("created");
    expect(store.createWorkerAgentInstance(worker("duplicate", "binding-a", "w1:p1"), 4)).toEqual({ outcome: "duplicate-name" });
    expect(store.createWorkerAgentInstance(worker("sibling", "binding-b", "w1:p2"), 4).outcome).toBe("created");
    expect(store.listWorkerInstancesByParent({ bindingId: "binding-a", paneId: "w1:p1" }).map(({ id }) => id)).toEqual(["one"]);
    expect(store.listWorkerInstancesByParent({ bindingId: "binding-b", paneId: "w1:p2" }).map(({ id }) => id)).toEqual(["sibling"]);
    expect(String((store.database.prepare("SELECT sql FROM sqlite_master WHERE type = 'table' AND name = 'agent_instances'").get() as { sql: string }).sql)).not.toMatch(/UNIQUE\s*\(\s*project_id\s*,\s*name\s*\)/i);
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("allows a terminated Worker name to start a new durable session", () => {
    store = new SqliteBindingStore(":memory:");
    const worker = (id: string) => ({
      id, projectId: "project-a", name: "reviewer", role: "worker" as const, agentKind: "traex" as const, model: null, desiredState: "stopped" as const,
      parent: { bindingId: "binding-a", bindingGeneration: 3, paneId: "w1:p1", nativeSessionId: null },
      workspace: { id: `ws-${id}`, kind: "git-worktree" as const, cwd: `/repo/.worktree/${id}`, branch: `swarm/${id}`, baseCommit: "abc123" }
    });

    const first = store.createWorkerAgentInstance(worker("reviewer-one"), 1);
    expect(first).toMatchObject({ outcome: "created", instance: { workerSessionGeneration: 1 } });
    if (first.outcome !== "created") throw new Error("expected first Worker");
    expect(store.terminateWorkerSession({ instanceId: first.instance.id, expectedGeneration: first.instance.generation, reason: "done" })).not.toBeNull();
    const replacement = store.createWorkerAgentInstance(worker("reviewer-two"), 1);

    expect(replacement).toMatchObject({ outcome: "created", instance: { id: "reviewer-two", name: "reviewer", workerSessionGeneration: 1 } });
    expect(store.listWorkerInstancesByParent({ bindingId: "binding-a", paneId: "w1:p1" }).map(({ id }) => id)).toEqual(["reviewer-two"]);
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("rejects stale runtime attachment without changing the instance", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({
      id: "i1", projectId: "project-a", name: "coder", role: "worker", agentKind: "codex", model: null, desiredState: "running",
      workspace: { id: "ws1", kind: "git-worktree", cwd: "/work/coder", branch: "worker/coder", baseCommit: "abc123" }
    });

    expect(store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 2, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "s1" })).toBeNull();
    expect(store.getAgentInstance("i1")).toMatchObject({ generation: 1, runtimeRef: null, observedState: "unprovisioned" });
    expect(store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "s1" })).toMatchObject({
      generation: 2, observedState: "idle", runtimeRef: { paneId: "w1:p1", generation: 2 }
    });
  });

  it("finds eligible pending panes but prefers an attached pane owner", () => {
    store = new SqliteBindingStore(":memory:");
    const create = (id: string) => store!.createAgentInstance({
      id, projectId: "project-a", name: id, role: "worker", agentKind: "traex", model: null, workerSessionLifecycle: "active", desiredState: "running",
      workspace: { id: `ws-${id}`, kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "abc123" }
    });
    create("pending");
    const pending = store.checkpointAgentInstance({ instanceId: "pending", expectedGeneration: 1, checkpoint: "pane-allocated", observedState: "failed", pendingPaneId: "w1:p1", pendingWorkspaceId: "w1", lastError: "uncertain" })!;

    expect(store.findAgentInstanceByPane("w1:p1")).toEqual(pending);

    create("attached");
    const attached = store.attachAgentInstanceRuntime({ instanceId: "attached", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    expect(store.findAgentInstanceByPane("w1:p1")).toEqual(attached);
  });

  it("recovers only pre-dispatch instance claims back to the FIFO queue", () => {
    store = new SqliteBindingStore(":memory:");
    const createRunning = (id: string) => {
      store!.createAgentInstance({
        id, projectId: "project-a", name: id, role: "worker", agentKind: "traex", model: null, desiredState: "running",
        workspace: { id: `ws-${id}`, kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "abc123" }
      });
      return store!.attachAgentInstanceRuntime({ instanceId: id, expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: `w1:${id}`, nativeSessionId: null })!;
    };
    const actor = { kind: "human" as const, userId: "u1" };
    const claimedInstance = createRunning("claimed-worker");
    const uncertainInstance = createRunning("uncertain-worker");
    store.acceptInstanceTurn({ id: "claimed-turn", idempotencyKey: "claimed-turn", actor, projectId: "project-a", instanceId: claimedInstance.id, instanceGeneration: claimedInstance.generation, kind: "turn", text: "safe to retry" });
    store.acceptInstanceTurn({ id: "uncertain-turn", idempotencyKey: "uncertain-turn", actor, projectId: "project-a", instanceId: uncertainInstance.id, instanceGeneration: uncertainInstance.generation, kind: "turn", text: "must not replay" });
    store.claimNextInstanceTurn(claimedInstance.id, claimedInstance.generation);
    store.claimNextInstanceTurn(uncertainInstance.id, uncertainInstance.generation);
    store.updateInstanceTurn({ turnId: "uncertain-turn", expectedGeneration: uncertainInstance.generation, state: "dispatching", eventKind: "turn.dispatching" });

    expect(store.recoverInterruptedInstanceTurns()).toEqual({
      requeuedTurnIds: ["claimed-turn"], cancelledLegacyTurnIds: [],
      observableTurns: [expect.objectContaining({ id: "uncertain-turn", state: "dispatching" })]
    });
    expect(store.getInstanceTurn("claimed-turn")).toMatchObject({ state: "queued" });
    expect(store.getInstanceTurn("uncertain-turn")).toMatchObject({ state: "dispatching" });
  });

  it("cancels only queued turns owned by permanently detached legacy Worker sessions", () => {
    store = new SqliteBindingStore(":memory:");
    const actor = { kind: "human" as const, userId: "u1" };
    const create = (id: string, lifecycle: "legacy" | "active" | "terminated", withPendingPane = false) => {
      store!.createAgentInstance({ id, projectId: "project-a", name: id, role: "worker", agentKind: "traex", model: null, workerSessionLifecycle: lifecycle, desiredState: "running", workspace: { id: `ws-${id}`, kind: "shared-read-only", cwd: `/repo/${id}`, branch: null, baseCommit: "base" } });
      store!.database.prepare("UPDATE agent_instances SET observed_state = 'detached', pending_pane_id = ? WHERE id = ?").run(withPendingPane ? `w1:${id}` : null, id);
      return store!.getAgentInstance(id)!;
    };
    const legacy = create("legacy", "legacy");
    const pending = create("pending", "legacy", true);
    const active = create("active", "active");
    const terminated = create("terminated", "terminated");
    const accept = (id: string, instance: ReturnType<typeof create>, withCard = false) => {
      if (!withCard) return store!.acceptInstanceTurn({ id, idempotencyKey: id, actor, projectId: "project-a", instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", text: id });
      const view = createQueuedWorkerTurnCard({ turnId: id, instanceId: instance.id, instanceGeneration: instance.generation, workerName: instance.name, parentTurnId: null, rootMessageId: "root", requestText: id, queuePosition: 1, occurredAt: "2026-09-13T00:00:00.000Z" });
      return store!.acceptInstanceTurnWithCard({ id, idempotencyKey: id, actor, projectId: "project-a", instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", text: id, parentTurnId: null, sourceMessageId: `source-${id}`, view, render: renderWorkerTurnCard });
    };
    accept("legacy-queued", legacy, true);
    accept("legacy-uncertain", legacy);
    store.updateInstanceTurn({ turnId: "legacy-uncertain", expectedGeneration: legacy.generation, state: "dispatch-uncertain", eventKind: "turn.dispatch-uncertain" });
    accept("pending-queued", pending);
    accept("active-queued", active);
    accept("terminated-queued", terminated);

    expect(store.recoverInterruptedInstanceTurns()).toEqual({
      requeuedTurnIds: [], cancelledLegacyTurnIds: ["legacy-queued"],
      observableTurns: [expect.objectContaining({ id: "legacy-uncertain", state: "dispatch-uncertain" })]
    });

    expect(store.getInstanceTurn("legacy-queued")).toMatchObject({ state: "cancelled", error: "Legacy Worker session is detached and cannot be resumed" });
    expect(store.loadWorkerTurnCard("legacy-queued")).toMatchObject({ phase: "cancelled", queuePosition: 0, resultCapture: "unavailable", notice: "Legacy Worker session is detached and cannot be resumed" });
    expect(store.getInstanceTurn("legacy-uncertain")).toMatchObject({ state: "dispatch-uncertain" });
    for (const id of ["pending-queued", "active-queued", "terminated-queued"]) expect(store.getInstanceTurn(id)).toMatchObject({ state: "queued" });
    expect(store.listInstanceEvents(legacy.id).at(-1)).toMatchObject({ turnId: "legacy-queued", kind: "turn.cancelled", payload: { state: "cancelled", reason: "legacy_worker_unrecoverable" } });
    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.getInstanceTurnDiagnostics()).toEqual({ queuedTurns: 3, activeTurns: 0, uncertainTurns: 1 });
    expect(store.recoverInterruptedInstanceTurns()).toEqual({
      requeuedTurnIds: [], cancelledLegacyTurnIds: [],
      observableTurns: [expect.objectContaining({ id: "legacy-uncertain", state: "dispatch-uncertain" })]
    });
  });

  it("claims a priority Worker turn before ordinary FIFO and preserves single-active exclusion", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    const actor = { kind: "human" as const, userId: "u1" };
    for (const [id, priority] of [["ordinary-1", "normal"], ["ordinary-2", "normal"], ["priority", "priority"]] as const) {
      store.acceptInstanceTurn({ id, idempotencyKey: id, actor, projectId: "project-a", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: id, priority });
    }

    expect(store.claimNextInstanceTurn(worker.id, worker.generation)).toMatchObject({ id: "priority", priority: "priority" });
    expect(store.claimNextInstanceTurn(worker.id, worker.generation)).toBeNull();
    store.updateInstanceTurn({ turnId: "priority", expectedGeneration: worker.generation, state: "dispatch-uncertain", eventKind: "turn.dispatch-uncertain" });
    expect(store.claimNextInstanceTurn(worker.id, worker.generation)).toBeNull();
    store.updateInstanceTurn({ turnId: "priority", expectedGeneration: worker.generation, state: "completed", eventKind: "turn.completed" });
    expect(store.claimNextInstanceTurn(worker.id, worker.generation)?.id).toBe("ordinary-1");
    store.updateInstanceTurn({ turnId: "ordinary-1", expectedGeneration: worker.generation, state: "completed", eventKind: "turn.completed" });
    expect(store.claimNextInstanceTurn(worker.id, worker.generation)?.id).toBe("ordinary-2");
  });

  it("persists and fences exact-turn control operations without replaying dispatching work", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    store.acceptInstanceTurn({ id: "logical-1", idempotencyKey: "turn-1", actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work" });
    store.claimNextInstanceTurn(worker.id, worker.generation);
    store.updateInstanceTurn({ turnId: "logical-1", expectedGeneration: worker.generation, state: "dispatching", eventKind: "turn.dispatching" });
    store.claimInstanceTurnTranscript({ turnId: "logical-1", expectedGeneration: worker.generation, runtimeTurnId: "runtime-1", startedAt: "2026-09-03T00:00:00.000Z" });
    const target = { owner: { kind: "instance" as const, id: worker.id }, projectId: "project-a", paneId: "w1:p1", generation: worker.generation, agentSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }, logicalTurnId: "logical-1", runtimeTurnId: "runtime-1" };
    const input = { id: "control-1", idempotencyKey: "message-1:steer", kind: "steer" as const, target, actor: { kind: "human" as const, userId: "u1" }, payload: "change direction", sourceMessageId: "message-1" };

    expect(store.acceptTurnControlOperation(input)).toMatchObject({ inserted: true, operation: { state: "accepted", target } });
    expect(store.acceptTurnControlOperation(input)).toMatchObject({ inserted: false, operation: { id: "control-1" } });
    expect(() => store!.acceptTurnControlOperation({ ...input, id: "control-2", payload: "different" })).toThrow(/Idempotency key/);
    expect(store.claimTurnControlOperation("control-1")).toMatchObject({ state: "dispatching" });
    expect(store.claimTurnControlOperation("control-1")).toBeNull();

    expect(store.recoverTurnControlOperations()).toMatchObject({ accepted: [], uncertain: [{ id: "control-1", state: "uncertain" }] });
    expect(store.finishTurnControlOperation({ id: "control-1", state: "delivered", result: { status: "delivered" } })).toBeNull();
    expect(store.getTurnControlOperation("control-1")).toMatchObject({ state: "uncertain", result: { reason: expect.stringContaining("restarted") } });
  });

  it("atomically converts a dispatching Worker steer into queued priority work", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    const actor = { kind: "human" as const, userId: "u1" };
    store.acceptInstanceTurn({ id: "logical-1", idempotencyKey: "turn-1", actor, projectId: "project-a", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work" });
    store.claimNextInstanceTurn(worker.id, worker.generation);
    store.updateInstanceTurn({ turnId: "logical-1", expectedGeneration: worker.generation, state: "dispatching", eventKind: "turn.dispatching" });
    store.claimInstanceTurnTranscript({ turnId: "logical-1", expectedGeneration: worker.generation, runtimeTurnId: "runtime-1", startedAt: "2026-09-03T00:00:00.000Z" });
    const target = { owner: { kind: "instance" as const, id: worker.id }, projectId: "project-a", paneId: "w1:p1", generation: worker.generation, agentSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }, logicalTurnId: "logical-1", runtimeTurnId: "runtime-1" };
    store.acceptTurnControlOperation({ id: "control-1", idempotencyKey: "steer-1", kind: "steer", target, actor, payload: "continue safely" });
    store.claimTurnControlOperation("control-1");
    const priorityView = createQueuedWorkerTurnCard({ turnId: "priority-1", instanceId: worker.id, instanceGeneration: worker.generation, workerSessionGeneration: worker.workerSessionGeneration, workerName: worker.name, parentTurnId: null, rootMessageId: "root", requestText: "continue safely", queuePosition: 0, occurredAt: "2026-09-03T00:00:01.000Z" });

    const converted = store.convertTurnControlToWorkerPriority({
      operationId: "control-1",
      turn: { id: "priority-1", idempotencyKey: "steer-1", actor, projectId: "project-a", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", priority: "priority", text: "continue safely", parentTurnId: null, sourceMessageId: "message-1", view: priorityView, render: renderWorkerTurnCard },
      maxQueueDepth: 2, result: { status: "priority-accepted", logicalTurnId: "priority-1" }
    });

    expect(converted).toMatchObject({ operation: { state: "delivered", result: { status: "priority-accepted", logicalTurnId: "priority-1" } }, logicalTurnId: "priority-1" });
    expect(store.getInstanceTurn("priority-1")).toMatchObject({ state: "queued", priority: "priority", text: "continue safely" });
    expect(store.listPendingOutboundReplies().filter(({ workerTurnId }) => workerTurnId)).toEqual([]);
    expect(store.listPendingCardContextInvalidations()).toContainEqual(expect.objectContaining({ targetKind: "worker-session", targetId: worker.id }));
    expect(store.database.prepare("SELECT actor_kind, source_binding_id, source_binding_generation, source_parent_prompt_id FROM instance_turns WHERE id = 'priority-1'").get()).toEqual({ actor_kind: "human", source_binding_id: null, source_binding_generation: null, source_parent_prompt_id: null });
    expect(store.claimNextInstanceTurn(worker.id, worker.generation)).toBeNull();
  });

  it("rolls back Worker priority conversion when atomic admission fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    const actor = { kind: "human" as const, userId: "u1" };
    store.acceptInstanceTurn({ id: "logical-1", idempotencyKey: "turn-1", actor, projectId: "project-a", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work" });
    store.claimNextInstanceTurn(worker.id, worker.generation);
    store.updateInstanceTurn({ turnId: "logical-1", expectedGeneration: worker.generation, state: "dispatching", eventKind: "turn.dispatching" });
    store.claimInstanceTurnTranscript({ turnId: "logical-1", expectedGeneration: worker.generation, runtimeTurnId: "runtime-1", startedAt: "2026-09-03T00:00:00.000Z" });
    const target = { owner: { kind: "instance" as const, id: worker.id }, projectId: "project-a", paneId: "w1:p1", generation: worker.generation, agentSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }, logicalTurnId: "logical-1", runtimeTurnId: "runtime-1" };
    store.acceptTurnControlOperation({ id: "control-1", idempotencyKey: "steer-1", kind: "steer", target, actor, payload: "continue safely" });
    store.claimTurnControlOperation("control-1");

    expect(() => store!.convertTurnControlToWorkerPriority({
      operationId: "control-1",
      turn: { id: "priority-1", idempotencyKey: "steer-1", actor, projectId: "project-a", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", priority: "priority", text: "continue safely", parentTurnId: null, sourceMessageId: "message-1" },
      maxQueueDepth: 1, result: { status: "priority-accepted", logicalTurnId: "priority-1" }
    })).toThrow(/queue is full/);
    expect(store.getTurnControlOperation("control-1")).toMatchObject({ state: "dispatching", result: null });
    expect(store.getInstanceTurn("priority-1")).toBeNull();
  });

  it("atomically converts a dispatching Primary steer while preserving the active-turn claim fence", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Primary" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", generation: 3, agentSessionSource: "herdr:traex", agentSessionAgent: "traex", agentSessionKind: "id", agentSessionValue: "session-1" });
    const activeView = createQueuedRunCard({ promptId: "logical-1", bindingId: "b1", bindingGeneration: 3, title: "active", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-09-03T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "logical-1", bindingId: "b1", larkMessageId: "message-1", actorOpenId: "u1", body: "work" }, view: activeView, rootMessageId: "root", answerCard: {} });
    store.updatePrompt("logical-1", "running");
    store.markPromptDispatched("logical-1", "2026-09-03T00:00:00.000Z");
    store.claimPromptTranscriptTurn({ promptId: "logical-1", bindingId: "b1", turnId: "runtime-1", startedAt: "2026-09-03T00:00:00.100Z" });
    const target = { owner: { kind: "binding" as const, id: "b1" }, projectId: "project-a", paneId: "w1:p1", generation: 3, agentSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }, logicalTurnId: "logical-1", runtimeTurnId: "runtime-1" };
    store.acceptTurnControlOperation({ id: "control-1", idempotencyKey: "steer-1", kind: "steer", target, actor: { kind: "human", userId: "u1" }, payload: "continue safely" });
    store.claimTurnControlOperation("control-1");
    const priorityView = createQueuedRunCard({ promptId: "priority-1", bindingId: "b1", bindingGeneration: 3, title: "Priority steer", workspaceId: "w1", paneId: "w1:p1", requestText: "continue safely", queuePosition: 0, occurredAt: "2026-09-03T00:00:01.000Z" });

    const converted = store.convertTurnControlToPrimaryPriority({ operationId: "control-1", prompt: { id: "priority-1", bindingId: "b1", larkMessageId: "priority-steer:steer-1", actorOpenId: "u1", body: "continue safely", priority: "priority" }, view: priorityView, rootMessageId: "root", answerCard: {}, maxQueueDepth: 2, expectedBindingGeneration: 3, result: { status: "priority-accepted", logicalTurnId: "priority-1" } });

    expect(converted).toMatchObject({ operation: { state: "delivered" }, prompt: { id: "priority-1", state: "queued", priority: "priority" } });
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
    expect(store.listPendingOutboundReplies()).toEqual(expect.arrayContaining([expect.objectContaining({ idempotencyKey: "run-card:create:priority-1:answer" })]));
  });

  it("atomically projects one durable operation-result card through pending and delivered states", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    store.acceptInstanceTurn({ id: "logical-1", idempotencyKey: "turn-1", actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work" });
    store.claimNextInstanceTurn(worker.id, worker.generation);
    store.updateInstanceTurn({ turnId: "logical-1", expectedGeneration: worker.generation, state: "dispatching", eventKind: "turn.dispatching" });
    store.claimInstanceTurnTranscript({ turnId: "logical-1", expectedGeneration: worker.generation, runtimeTurnId: "runtime-1", startedAt: "2026-09-03T00:00:00.000Z" });
    const target = { owner: { kind: "instance" as const, id: worker.id }, projectId: "project-a", paneId: "w1:p1", generation: worker.generation, agentSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }, logicalTurnId: "logical-1", runtimeTurnId: "runtime-1" };

    store.acceptTurnControlOperation({ id: "control-1", idempotencyKey: "steer-1", kind: "steer", target, actor: { kind: "human", userId: "u1" }, payload: "secret steering text", result: { targetMessageId: "root", card: { state: "accepted" } } });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ idempotencyKey: "turn-control:control-1:result", targetRole: "operation_result", kind: "card_reply", payload: JSON.stringify({ state: "accepted" }) })]);
    store.claimTurnControlOperation("control-1");
    store.finishTurnControlOperation({ id: "control-1", state: "delivered", result: { status: "delivered" }, card: { state: "delivered" } });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ idempotencyKey: "turn-control:control-1:result", payload: JSON.stringify({ state: "delivered" }) })]);
    expect(store.listPendingOutboundReplies()[0]!.payload).not.toContain("secret steering text");

    const initial = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(initial.id, "operation-card", "card-id");
    store.database.prepare("UPDATE turn_control_operations SET state = 'dispatching' WHERE id = ?").run("control-1");
    store.finishTurnControlOperation({ id: "control-1", state: "uncertain", result: { status: "delivery-uncertain" }, card: { state: "uncertain" } });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ idempotencyKey: "turn-control:control-1:result:uncertain", kind: "card_update", rootMessageId: "operation-card", payload: JSON.stringify({ state: "uncertain" }) })]);
  });

  it("projects restart uncertainty into the existing operation-result intent", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    store.acceptInstanceTurn({ id: "logical-1", idempotencyKey: "turn-1", actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work" });
    store.claimNextInstanceTurn(worker.id, worker.generation); store.updateInstanceTurn({ turnId: "logical-1", expectedGeneration: worker.generation, state: "dispatching", eventKind: "turn.dispatching" });
    store.claimInstanceTurnTranscript({ turnId: "logical-1", expectedGeneration: worker.generation, runtimeTurnId: "runtime-1", startedAt: "2026-09-03T00:00:00.000Z" });
    const target = { owner: { kind: "instance" as const, id: worker.id }, projectId: "project-a", paneId: "w1:p1", generation: worker.generation, agentSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }, logicalTurnId: "logical-1", runtimeTurnId: "runtime-1" };
    store.acceptTurnControlOperation({ id: "control-1", idempotencyKey: "steer-1", kind: "steer", target, actor: { kind: "human", userId: "u1" }, payload: "change", result: { targetMessageId: "root", card: { state: "accepted" } } });
    store.claimTurnControlOperation("control-1");

    store.recoverTurnControlOperations((operation) => ({ state: operation.state }));

    expect(store.getTurnControlOperation("control-1")).toMatchObject({ state: "uncertain", result: { status: "delivery-uncertain" } });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ payload: JSON.stringify({ state: "uncertain" }) })]);
  });

  it("rolls back a turn-control terminal state when its result card cannot be serialized", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    store.acceptInstanceTurn({ id: "logical-1", idempotencyKey: "turn-1", actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work" });
    store.claimNextInstanceTurn(worker.id, worker.generation); store.updateInstanceTurn({ turnId: "logical-1", expectedGeneration: worker.generation, state: "dispatching", eventKind: "turn.dispatching" });
    store.claimInstanceTurnTranscript({ turnId: "logical-1", expectedGeneration: worker.generation, runtimeTurnId: "runtime-1", startedAt: "2026-09-03T00:00:00.000Z" });
    const target = { owner: { kind: "instance" as const, id: worker.id }, projectId: "project-a", paneId: "w1:p1", generation: worker.generation, agentSession: { source: "herdr:traex", agent: "traex", kind: "id" as const, value: "session-1" }, logicalTurnId: "logical-1", runtimeTurnId: "runtime-1" };
    store.acceptTurnControlOperation({ id: "control-1", idempotencyKey: "steer-1", kind: "steer", target, actor: { kind: "human", userId: "u1" }, payload: "change", result: { targetMessageId: "root", card: { state: "accepted" } } });
    store.claimTurnControlOperation("control-1");
    const circular: Record<string, unknown> = {}; circular.self = circular;

    expect(() => store!.finishTurnControlOperation({ id: "control-1", state: "delivered", result: { status: "delivered" }, card: circular })).toThrow(/circular/i);
    expect(store.getTurnControlOperation("control-1")).toMatchObject({ state: "dispatching", result: null });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ payload: JSON.stringify({ state: "accepted" }) })]);
  });

  it("rejects an exact-turn control claim after its runtime fence changes", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const worker = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "session-1" })!;
    store.acceptInstanceTurn({ id: "logical-1", idempotencyKey: "turn-1", actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: worker.id, instanceGeneration: worker.generation, kind: "turn", text: "work" });
    store.claimNextInstanceTurn(worker.id, worker.generation);
    store.updateInstanceTurn({ turnId: "logical-1", expectedGeneration: worker.generation, state: "dispatching", eventKind: "turn.dispatching" });
    store.claimInstanceTurnTranscript({ turnId: "logical-1", expectedGeneration: worker.generation, runtimeTurnId: "runtime-1", startedAt: "2026-09-03T00:00:00.000Z" });
    store.acceptTurnControlOperation({ id: "control-1", idempotencyKey: "steer-1", kind: "steer", target: { owner: { kind: "instance", id: worker.id }, projectId: "project-a", paneId: "w1:p1", generation: worker.generation, agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" }, logicalTurnId: "logical-1", runtimeTurnId: "runtime-1" }, actor: { kind: "human", userId: "u1" }, payload: "change" });
    store.updateInstanceTurn({ turnId: "logical-1", expectedGeneration: worker.generation, expectedRuntimeTurnId: "runtime-1", state: "completed", eventKind: "turn.completed" });

    expect(store.claimTurnControlOperation("control-1")).toBeNull();
    expect(store.getTurnControlOperation("control-1")).toMatchObject({ state: "accepted" });
  });

  it("adds durable turn control operations to an existing database", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-turn-control-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.database.exec("DROP TABLE turn_control_operations; DELETE FROM schema_migrations WHERE version = 10");
    store.close(); store = undefined;

    store = new SqliteBindingStore(path);

    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 10").get()).toEqual({ version: 10 });
    expect(store.database.prepare("PRAGMA table_info(turn_control_operations)").all()).toEqual(expect.arrayContaining([
      expect.objectContaining({ name: "owner_kind", notnull: 1 }), expect.objectContaining({ name: "logical_turn_id", notnull: 1 }), expect.objectContaining({ name: "runtime_turn_id", notnull: 1 })
    ]));
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("scopes active turn fencing to the current runtime generation", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const first = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: null })!;
    const actor = { kind: "human" as const, userId: "u1" };
    store.acceptInstanceTurn({ id: "old", idempotencyKey: "old", actor, projectId: "project-a", instanceId: "i1", instanceGeneration: first.generation, kind: "turn", text: "old" });
    store.claimNextInstanceTurn("i1", first.generation);
    store.updateInstanceTurn({ turnId: "old", expectedGeneration: first.generation, state: "dispatch-uncertain", eventKind: "turn.dispatch-uncertain" });
    store.detachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: first.generation, reason: "pane replaced" });
    const detached = store.getAgentInstance("i1")!;
    const current = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: detached.generation, herdrWorkspaceId: "w1", paneId: "w1:p2", nativeSessionId: null })!;
    store.acceptInstanceTurn({ id: "new", idempotencyKey: "new", actor, projectId: "project-a", instanceId: "i1", instanceGeneration: current.generation, kind: "turn", text: "new" });

    expect(store.claimNextInstanceTurn("i1", current.generation)).toMatchObject({ id: "new", state: "claimed" });
    expect(store.getInstanceTurn("old")).toMatchObject({ state: "dispatch-uncertain", instanceGeneration: first.generation });
    expect(store.getInstanceTurnDiagnostics()).toEqual({ queuedTurns: 0, activeTurns: 1, uncertainTurns: 0 });
  });

  it("stores exact Worker parent identity and terminalizes its turns without replay", () => {
    store = new SqliteBindingStore(":memory:");
    const created = store.createWorkerAgentInstance({
      id: "child", projectId: "project-a", name: "child", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      sourcePrimaryPaneLabel: "primary", parent: { bindingId: "binding-a", paneId: "w1:primary", nativeSessionId: "session-primary" },
      workspace: { id: "ws-child", kind: "shared-read-only", cwd: "/repo/child", branch: null, baseCommit: "base" }
    }, 4).instance;
    const active = store.attachAgentInstanceRuntime({ instanceId: created.id, expectedGeneration: created.generation, herdrWorkspaceId: "w1", paneId: "w1:child", nativeSessionId: "session-child" })!;
    const actor = { kind: "human" as const, userId: "u1" };
    store.acceptInstanceTurn({ id: "active", idempotencyKey: "active-parent", actor, projectId: "project-a", instanceId: active.id, instanceGeneration: active.generation, kind: "turn", text: "possibly sent" });
    store.claimNextInstanceTurn(active.id, active.generation);
    store.updateInstanceTurn({ turnId: "active", expectedGeneration: active.generation, state: "running", eventKind: "turn.running" });
    store.acceptInstanceTurn({ id: "queued", idempotencyKey: "queued-parent", actor, projectId: "project-a", instanceId: active.id, instanceGeneration: active.generation, kind: "turn", text: "not started" });

    expect(store.listWorkerInstancesByParent({ bindingId: "binding-a", paneId: "w1:primary" })).toMatchObject([{ id: "child", parent: { nativeSessionId: "session-primary" }, workerSessionLifecycle: "active" }]);
    expect(store.listWorkerInstancesByParent({ bindingId: "binding-a", paneId: "w1:other" })).toEqual([]);
    expect(store.terminateWorkerSession({ instanceId: active.id, expectedGeneration: active.generation, reason: "parent pane closed" })).toMatchObject({ cancelledTurnIds: ["queued"], uncertainTurnIds: ["active"], instance: { workerSessionLifecycle: "terminated", desiredState: "stopped", generation: active.generation + 1, runtimeRef: null } });
    expect(store.getInstanceTurn("queued")).toMatchObject({ state: "cancelled" });
    expect(store.getInstanceTurn("active")).toMatchObject({ state: "dispatch-uncertain" });
    expect(store.claimNextInstanceTurn(active.id, active.generation)).toBeNull();
  });

  it("reserves stop only when the current generation has no active or uncertain turn", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "i1", projectId: "project-a", name: "worker", role: "worker", agentKind: "traex", model: null, desiredState: "running", workspace: { id: "ws1", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const instance = store.attachAgentInstanceRuntime({ instanceId: "i1", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: null })!;
    store.acceptInstanceTurn({ id: "turn", idempotencyKey: "turn", actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: "i1", instanceGeneration: instance.generation, kind: "turn", text: "work" });
    store.claimNextInstanceTurn("i1", instance.generation);

    expect(store.reserveAgentInstanceStop("i1", instance.generation)).toEqual({ outcome: "busy" });
    store.updateInstanceTurn({ turnId: "turn", expectedGeneration: instance.generation, state: "completed", eventKind: "turn.completed" });
    expect(store.reserveAgentInstanceStop("i1", instance.generation)).toMatchObject({ outcome: "reserved", instance: { desiredState: "stopped", runtimeRef: { paneId: "w1:p1" } } });
    expect(store.updateAgentInstanceObservation({ instanceId: "i1", expectedGeneration: instance.generation, observedState: "idle" })).toMatchObject({ desiredState: "stopped", observedState: "idle" });
    expect(store.claimNextInstanceTurn("i1", instance.generation)).toBeNull();
    expect(store.finishAgentInstanceStop("i1", instance.generation)).toMatchObject({ desiredState: "stopped", observedState: "stopped", runtimeRef: null });
  });

  it("atomically retains a Worker pane when any durable turn is pending", () => {
    store = new SqliteBindingStore(":memory:");
    store.createAgentInstance({ id: "close-worker", projectId: "project-a", name: "worker-close", role: "worker", agentKind: "traex", model: null, parent: { bindingId: "binding-a", bindingGeneration: 1, paneId: "w1:primary", nativeSessionId: null }, workerSessionLifecycle: "active", desiredState: "running", workspace: { id: "close-worker-ws", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" } });
    const instance = store.attachAgentInstanceRuntime({ instanceId: "close-worker", expectedGeneration: 1, herdrWorkspaceId: "w1", paneId: "w1:worker", nativeSessionId: null })!;
    store.acceptInstanceTurn({ id: "queued-close", idempotencyKey: "queued-close", actor: { kind: "human", userId: "u1" }, projectId: "project-a", instanceId: instance.id, instanceGeneration: instance.generation, kind: "turn", text: "work" });

    expect(store.reserveWorkerPaneClose(instance.id, instance.generation)).toEqual({ outcome: "busy" });
    expect(store.getAgentInstance(instance.id)).toMatchObject({ desiredState: "running", workerSessionLifecycle: "active", runtimeRef: { paneId: "w1:worker" } });
    expect(store.getInstanceTurn("queued-close")).toMatchObject({ state: "queued" });
  });

  it("projects a legacy binding as a TraeX instance without creating durable work", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "project-a", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Legacy" });
    store.updateBinding("b1", { paneId: "w1:p1", traexSessionId: "terminal-1", state: "active", lifecycle: "active", attachment: "attached", generation: 3, lastAgentState: "working" });

    expect(store.projectLegacyBindingAsAgentInstance("b1")).toMatchObject({
      id: "legacy:b1", projectId: "project-a", name: "Legacy", role: "worker", agentKind: "traex", generation: 3, observedState: "working",
      runtimeRef: { herdrWorkspaceId: "w1", paneId: "w1:p1", nativeSessionId: "terminal-1", generation: 3 }
    });
    expect(store.listAgentInstances("project-a")).toEqual([]);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM prompt_jobs").get()).toEqual({ count: 0 });
  });

  it("persists creator identity and consumes scoped card interactions once", () => {
    store = new SqliteBindingStore(":memory:");
    const binding = store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "creator" });
    expect(binding.creatorOpenId).toBe("creator");
    store.createCardInteraction({ id: "i1", bindingId: "b1", bindingGeneration: 1, actorOpenId: "user", actionKind: "supplement", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });

    expect(store.consumeCardInteraction({ id: "i1", actorOpenId: "other", bindingId: "b1", bindingGeneration: 1, now: "2026-08-27T00:00:00.000Z", resultCode: "ok" }).outcome).toBe("unauthorized");
    expect(store.consumeCardInteraction({ id: "i1", actorOpenId: "user", bindingId: "b1", bindingGeneration: 2, now: "2026-08-27T00:00:00.000Z", resultCode: "ok" }).outcome).toBe("stale");
    expect(store.consumeCardInteraction({ id: "i1", actorOpenId: "user", bindingId: "b1", bindingGeneration: 1, now: "2026-08-27T00:00:00.000Z", resultCode: "ok" })).toMatchObject({ outcome: "consumed", interaction: { resultCode: "ok" } });
    expect(store.consumeCardInteraction({ id: "i1", actorOpenId: "user", bindingId: "b1", bindingGeneration: 1, now: "2026-08-27T00:00:00.000Z", resultCode: "ignored" })).toMatchObject({ outcome: "duplicate", interaction: { resultCode: "ok" } });
  });

  it("atomically accepts a durable Session operation with its card interaction", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "member" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
    store.createCardInteraction({ id: "i1", bindingId: "b1", bindingGeneration: 1, actorOpenId: "member", actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });

    const input = {
      id: "op-1", idempotencyKey: "interaction:i1:rename", interactionId: "i1", actorOpenId: "member",
      bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1",
      kind: "rename" as const, argument: "New title", now: "2026-08-31T00:00:00.000Z"
    };

    expect(store.acceptSessionOperation(input)).toMatchObject({ outcome: "accepted", operation: { id: "op-1", state: "accepted", kind: "rename", argument: "New title" } });
    expect(store.getCardInteraction("i1")).toMatchObject({ state: "consumed", resultCode: "rename" });
    expect(store.acceptSessionOperation({ ...input, id: "op-duplicate" })).toMatchObject({ outcome: "duplicate", operation: { id: "op-1" } });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM session_operations").get()).toEqual({ count: 1 });
    expect(store.acceptSessionOperation({ ...input, id: "op-unauthorized", actorOpenId: "other" })).toEqual({ outcome: "unauthorized", operation: null });
    expect(() => store.acceptSessionOperation({ ...input, id: "op-invalid", idempotencyKey: "invalid", kind: "archive", argument: "unexpected" })).toThrow(/does not accept an argument/);
  });

  it("does not consume invalid Session operation interactions", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "member" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
    const create = (id: string, expiresAt = "2099-01-01T00:00:00.000Z") => store!.createCardInteraction({ id, bindingId: "b1", bindingGeneration: 1, actorOpenId: "member", actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt });
    create("unauthorized"); create("stale"); create("expired", "2026-01-01T00:00:00.000Z");
    const input = (interactionId: string) => ({ id: `op-${interactionId}`, idempotencyKey: `interaction:${interactionId}:rename`, interactionId, actorOpenId: "member", bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1", kind: "rename" as const, argument: "Title", now: "2026-08-31T00:00:00.000Z" });

    expect(store.acceptSessionOperation({ ...input("unauthorized"), actorOpenId: "other" }).outcome).toBe("unauthorized");
    expect(store.acceptSessionOperation({ ...input("stale"), bindingGeneration: 2 }).outcome).toBe("stale");
    expect(store.acceptSessionOperation(input("expired")).outcome).toBe("expired");
    expect(store.getCardInteraction("unauthorized")?.state).toBe("active");
    expect(store.getCardInteraction("stale")?.state).toBe("active");
    expect(store.getCardInteraction("expired")?.state).toBe("expired");
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM session_operations").get()).toEqual({ count: 0 });
  });

  it("does not accept a legacy session-control interaction as new durable work", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "member" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
    store.createCardInteraction({ id: "legacy-control", bindingId: "b1", bindingGeneration: 1, actorOpenId: "member", actionKind: "session_control", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });

    expect(store.acceptSessionOperation({ id: "op-legacy-control", idempotencyKey: "interaction:legacy-control:rename", interactionId: "legacy-control", actorOpenId: "member", bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1", kind: "rename", argument: "Title", now: "2026-08-31T00:00:00.000Z" })).toEqual({ outcome: "stale", operation: null });
    expect(store.getCardInteraction("legacy-control")?.state).toBe("active");
  });

  it("does not consume Session interactions whose operations are ineligible for the current binding state", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "member" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
    store.createCardInteraction({ id: "i1", bindingId: "b1", bindingGeneration: 1, actorOpenId: "member", actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });

    expect(store.acceptSessionOperation({ id: "op-1", idempotencyKey: "interaction:i1:resume", interactionId: "i1", actorOpenId: "member", bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1", kind: "resume", argument: null, now: "2026-08-31T00:00:00.000Z" })).toEqual({ outcome: "stale", operation: null });
    expect(store.getCardInteraction("i1")).toMatchObject({ state: "active" });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM session_operations").get()).toEqual({ count: 0 });
  });

  it("does not report an old consumed interaction as a durable duplicate", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "member" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
    store.createCardInteraction({ id: "legacy", bindingId: "b1", bindingGeneration: 1, actorOpenId: "member", actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });
    store.consumeCardInteraction({ id: "legacy", actorOpenId: "member", bindingId: "b1", bindingGeneration: 1, now: "2026-08-30T00:00:00.000Z", resultCode: "rename" });

    expect(store.acceptSessionOperation({ id: "op-legacy", idempotencyKey: "interaction:legacy:rename", interactionId: "legacy", actorOpenId: "member", bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1", kind: "rename", argument: "Title", now: "2026-08-31T00:00:00.000Z" })).toEqual({ outcome: "stale", operation: null });
  });

  it("claims durable Session operations in FIFO order and preserves unresolved recovery rows", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "member" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
    for (const [index, kind] of (["rename", "archive"] as const).entries()) {
      const interactionId = `i${index + 1}`;
      store.createCardInteraction({ id: interactionId, bindingId: "b1", bindingGeneration: 1, actorOpenId: "member", actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });
      store.acceptSessionOperation({ id: `op-${index + 1}`, idempotencyKey: `interaction:${interactionId}:${kind}`, interactionId, actorOpenId: "member", bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1", kind, argument: kind === "rename" ? "Title" : null, now: `2026-08-31T00:00:0${index}.000Z` });
    }

    expect(store.claimNextSessionOperation()).toMatchObject({ id: "op-1", state: "running", attemptCount: 1 });
    expect(store.claimNextSessionOperation()).toMatchObject({ id: "op-2", state: "running", attemptCount: 1 });
    expect(store.claimNextSessionOperation()).toBeNull();
    expect(store.listRecoverableSessionOperations().map(({ id }) => id)).toEqual(["op-1", "op-2"]);
    expect(store.finishSessionOperation("op-1", "uncertain", "outcome unknown")).toMatchObject({ state: "uncertain" });
  });

  it("reports Session operation backlog without exposing arguments and prunes only terminal history", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task", creatorOpenId: "member" });
    store.updateBinding("b1", { state: "active", lifecycle: "active", attachment: "attached", paneId: "w1:p1", traexSessionId: "terminal-1" });
    for (const id of ["accepted", "terminal"]) {
      store.createCardInteraction({ id: `i-${id}`, bindingId: "b1", bindingGeneration: 1, actorOpenId: "member", actionKind: "more_actions", parentPromptId: null, targetPromptId: null, expiresAt: "2099-01-01T00:00:00.000Z" });
      store.acceptSessionOperation({ id, idempotencyKey: `interaction:i-${id}:rename`, interactionId: `i-${id}`, actorOpenId: "member", bindingId: "b1", bindingGeneration: 1, expectedPaneId: "w1:p1", expectedTerminalId: "terminal-1", kind: "rename", argument: "private title", now: "2026-08-01T00:00:00.000Z" });
    }
    store.claimNextSessionOperation();
    store.finishSessionOperation("accepted", "succeeded");
    store.database.prepare("UPDATE session_operations SET updated_at = '2026-08-01T00:00:00.000Z' WHERE id = 'accepted'").run();

    const summary = store.getOperationalSummary();
    expect(summary.sessionOperations).toMatchObject({ states: { accepted: 1, succeeded: 1 } });
    expect(JSON.stringify(summary)).not.toContain("private title");
    expect(store.pruneTerminalSessionOperations("2026-08-15T00:00:00.000Z", 10)).toBe(1);
    expect(store.getSessionOperation("accepted")).toBeNull();
    expect(store.getSessionOperation("terminal")).toMatchObject({ state: "accepted" });
  });

  it("atomically reconciles a pane-derived binding title with its main-card intent", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "legacy title" });
    store.updateBinding("b1", { paneId: "w1:p1", generation: 1, statusMessageId: "root", state: "active", lifecycle: "active", attachment: "attached" });
    const event = createBridgeEvent("b1", "BindingRenamed", "herdr", { title: "repo / task-ab12" });
    const view = reduceTopicView({ ...initialTopicView("b1"), title: "legacy title", workspaceId: "w1", paneId: "w1:p1", phase: "ready" }, event);

    expect(store.reconcileBindingTitleWithProjection({
      bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1, title: "repo / task-ab12", view, rootMessageId: "root", card: { title: "repo / task-ab12" }
    })).toMatchObject({ outcome: "projected", binding: { title: "repo / task-ab12" }, outboxReserved: true });
    expect(store.loadTopicView("b1")).toMatchObject({ title: "repo / task-ab12", lastEventId: event.eventId });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ bindingId: "b1", targetRole: "session_status", kind: "card_update" })]);

    expect(store.reconcileBindingTitleWithProjection({
      bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1, title: "repo / task-ab12", view, rootMessageId: "root", card: {}
    })).toMatchObject({ outcome: "unchanged", outboxReserved: false });
    expect(store.listPendingOutboundReplies()).toHaveLength(1);

    expect(store.reconcileBindingTitleWithProjection({
      bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 2, title: "repo / stale", view: { ...view, title: "repo / stale", viewVersion: 2 }, rootMessageId: "root", card: {}
    })).toMatchObject({ outcome: "stale_binding", outboxReserved: false });
    expect(store.getBinding("b1")?.title).toBe("repo / task-ab12");
    expect(store.loadTopicView("b1")?.title).toBe("repo / task-ab12");
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
  });

  it("atomically and idempotently degrades an unregistered Agent without orphaning it", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", generation: 1, state: "active", lifecycle: "active", attachment: "attached" });
    const view = { ...initialTopicView("b1"), title: "Task", workspaceId: "w1", paneId: "w1:p1", phase: "degraded" as const, notice: "TraeX is not registered as a Herdr Agent", viewVersion: 1 };

    expect(store.degradeBindingWithProjection({ bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1, view, rootMessageId: "root", mainCard: {} }))
      .toMatchObject({ outcome: "degraded", binding: { state: "active", attachment: "degraded" }, outboxReserved: true });
    expect(store.loadTopicView("b1")).toMatchObject({ phase: "degraded", notice: view.notice });
    expect(store.listPendingOutboundReplies()).toHaveLength(1);

    expect(store.degradeBindingWithProjection({ bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1, view, rootMessageId: "root", mainCard: {} }))
      .toMatchObject({ outcome: "unchanged", binding: { attachment: "degraded" }, outboxReserved: false });
    expect(store.getBinding("b1")).toMatchObject({ attachment: "degraded", degradationCount: 0 });
    expect(store.listPendingOutboundReplies()).toHaveLength(1);
  });

  it("atomically projects a confirmed missing pane across binding, run cards, and card intents", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", generation: 1, state: "active", lifecycle: "active", attachment: "attached" });
    const seed = (promptId: string, phase: "running" | "blocked" | "queued", answerMessageId: string | null) => {
      const queued = createQueuedRunCard({ promptId, bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 1, occurredAt: "2026-08-27T00:00:00.000Z" });
      store!.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `${promptId}-message`, actorOpenId: "u1", body: promptId }, view: { ...queued, phase, answerMessageId, viewVersion: phase === "queued" ? 1 : 2 }, rootMessageId: "root", answerCard: {} });
    };
    seed("running", "running", "answer-running");
    seed("blocked", "blocked", "answer-blocked");
    seed("queued", "queued", null);
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'attached' WHERE id IN ('running', 'blocked')").run();
    const pendingBeforeOrphan = store.listPendingOutboundReplies().length;
    const view = { ...initialTopicView("b1"), title: "Task", workspaceId: "w1", paneId: "w1:p1", phase: "orphaned" as const, notice: "Herdr pane w1:p1 no longer exists", viewVersion: 1 };

    const result = store.orphanBindingWithProjection({ bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1, occurredAt: "2026-08-27T00:01:00.000Z", reason: "Herdr pane w1:p1 no longer exists", view, rootMessageId: "root", mainCard: {}, renderRunCard: (run) => ({ phase: run.phase }) });

    expect(result).toMatchObject({ outcome: "orphaned", updatedPromptIds: ["blocked", "queued", "running"] });
    expect(store.getBinding("b1")).toMatchObject({ state: "orphaned", attachment: "orphaned" });
    expect(store.loadRunCard("running")).toMatchObject({ phase: "failed", queuePosition: 0 });
    expect(store.loadRunCard("blocked")).toMatchObject({ phase: "failed", queuePosition: 0 });
    expect(store.loadRunCard("queued")).toMatchObject({ phase: "failed", queuePosition: 0 });
    expect(store.getPrompt("running")).toMatchObject({ state: "failed", observationState: "completed" });
    expect(store.getPrompt("blocked")).toMatchObject({ state: "failed", observationState: "completed" });
    expect(store.getPrompt("queued")).toMatchObject({ state: "cancelled", observationState: "completed" });
    expect(store.loadTopicView("b1")).toMatchObject({ phase: "orphaned" });
    expect(store.listPendingOutboundReplies().filter((reply) => reply.kind === "card_update" && reply.cardRole === "answer")).toHaveLength(2);
    expect(store.listPendingOutboundReplies().find((reply) => reply.promptId === "queued" && reply.kind === "stream_card_create")?.payload).toContain('\"phase\":\"failed\"');

    expect(store.orphanBindingWithProjection({ bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1, occurredAt: "2026-08-27T00:01:01.000Z", reason: "Herdr pane w1:p1 no longer exists", view, rootMessageId: "root", mainCard: {}, renderRunCard: () => ({}) })).toMatchObject({ outcome: "unchanged" });
    expect(store.listPendingOutboundReplies()).toHaveLength(pendingBeforeOrphan + 3);
  });

  it("reports a healthy database through the bounded integrity seam", () => {
    store = new SqliteBindingStore(":memory:");

    expect(store.inspectIntegrity(20)).toEqual({ quickCheck: "ok", issues: [], truncated: false });
  });

  it("accepts published thread ownership while a matching parent binding is orphaned", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", projectId: "p1", workspaceId: "w1", chatId: "chat", topicId: "primary-topic", rootMessageId: "primary-root", title: "Primary" });
    store.updateBinding("b1", { paneId: "w1:primary", statusMessageId: "primary-root", state: "active", lifecycle: "active", attachment: "attached" });
    const worker = store.createWorkerAgentInstance({
      id: "reviewer", projectId: "p1", name: "reviewer", role: "worker", agentKind: "traex", model: null, desiredState: "running",
      parent: { bindingId: "b1", bindingGeneration: 1, paneId: "w1:primary", nativeSessionId: "primary-session" },
      workspace: { id: "ws-reviewer", kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
    }, 4);
    expect(worker.outcome).toBe("created");
    store.database.prepare("INSERT INTO binding_thread_aliases(id, publication_key, binding_id, binding_generation, chat_id, pane_id, source_main_message_id, action_message_id, topic_id, root_message_id, state, created_at, updated_at) VALUES ('alias', 'alias-key', 'b1', 1, 'chat', 'w1:primary', 'primary-root', 'action', 'alias-topic', 'alias-root', 'active', 'now', 'now')").run();
    store.database.prepare("INSERT INTO worker_session_threads(id, publication_key, worker_id, worker_session_generation, parent_binding_id, parent_binding_generation, parent_pane_id, chat_id, mode, topic_id, root_message_id, state, created_at, activated_at, updated_at) VALUES ('thread', 'thread-key', 'reviewer', 1, 'b1', 1, 'w1:primary', 'chat', 'canonical-main', 'worker-topic', 'worker-root', 'active', 'now', 'now', 'now')").run();

    store.updateBinding("b1", { state: "orphaned" });

    expect(store.inspectIntegrity(20)).toEqual({ quickCheck: "ok", issues: [], truncated: false });
    expect(store.findBindingByLarkScope("alias-topic", "alias-root")).toBeNull();
    expect(store.workerSessionThreads.resolveScope({ chatId: "chat", topicId: "worker-topic", rootMessageId: "worker-root" })).toMatchObject({ kind: "stale" });

    store.database.prepare("UPDATE binding_thread_aliases SET binding_generation = 2 WHERE id = 'alias'").run();
    store.database.prepare("UPDATE worker_session_threads SET parent_pane_id = 'w1:other' WHERE id = 'thread'").run();
    expect(store.inspectIntegrity(20).issues.map(({ rule }) => rule)).toEqual(expect.arrayContaining([
      "thread_alias_binding_mismatch", "worker_thread_owner_mismatch"
    ]));
  });

  it("detects dangling business references and contradictory outbox lane state without exposing identifiers", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "sensitive-binding", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Secret title" });
    store.enqueueOutboundReply({ id: "sensitive-reply", idempotencyKey: "integrity-reply", bindingId: "sensitive-binding", promptId: "missing-prompt", selectionId: "missing-selection", rootMessageId: "private-card", kind: "text", payload: "private payload" });
    store.database.prepare("DELETE FROM outbox_lane_heads").run();

    const inspection = store.inspectIntegrity(20);

    expect(inspection.quickCheck).toBe("ok");
    expect(inspection.issues).toEqual(expect.arrayContaining([
      expect.objectContaining({ rule: "outbound_prompt_reference", table: "outbound_replies", count: 1 }),
      expect.objectContaining({ rule: "outbound_selection_reference", table: "outbound_replies", count: 1 }),
      expect.objectContaining({ rule: "outbox_lane_missing_head", table: "outbox_lane_heads", count: 1 })
    ]));
    expect(JSON.stringify(inspection)).not.toMatch(/sensitive|missing-prompt|missing-selection|private/);
  });

  it("caps integrity issue records while preserving a truncated signal", () => {
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "reply", idempotencyKey: "integrity", promptId: "missing-prompt", selectionId: "missing-selection", rootMessageId: "card", kind: "text", payload: "hidden" });

    expect(store.inspectIntegrity(1)).toEqual({ quickCheck: "ok", truncated: true, issues: [
      { rule: "outbound_prompt_reference", table: "outbound_replies", count: 1 }
    ] });
  });

  it("detects foreign-key, active-turn, lane-head, and quarantine contradictions", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "one" });
    store.enqueuePrompt({ id: "p2", bindingId: "b1", larkMessageId: "m3", actorOpenId: "u1", body: "two" });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running'").run();
    store.enqueueOutboundReply({ id: "head", idempotencyKey: "head", bindingId: "b1", rootMessageId: "card", kind: "text", payload: "hidden" });
    store.database.prepare("UPDATE outbox_lane_heads SET delivery_order = delivery_order + 1").run();
    store.database.exec("PRAGMA foreign_keys = OFF");
    store.database.prepare("INSERT INTO topic_views(binding_id, state_json, updated_at) VALUES ('missing-binding', '{}', 'now')").run();
    store.database.exec("PRAGMA foreign_keys = ON");
    store.database.prepare("INSERT INTO outbox_lane_quarantines(lane_key, failed_reply_id, lane_class, failure_class, state, action, reason, created_at, updated_at) SELECT lane_key, id, 'immutable', 'permanent', 'active', 'blocked', 'hidden', 'now', 'now' FROM outbound_replies WHERE id = 'head'").run();

    expect(store.inspectIntegrity(20).issues.map((issue) => issue.rule)).toEqual(expect.arrayContaining([
      "sqlite_foreign_key", "multiple_running_turns", "outbox_lane_head_mismatch", "quarantined_lane_has_head"
    ]));
  });

  it("atomically supersedes and consumes pane-close confirmations", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });

    store.createPaneCloseRequest({ id: "r1", bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "old-hash", expiresAt: "2099-01-01T00:00:00.000Z" });
    store.createPaneCloseRequest({ id: "r2", bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "new-hash", expiresAt: "2099-01-01T00:00:00.000Z" });

    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "old-hash", now: "2026-08-23T00:00:00.000Z" })).toEqual({ outcome: "invalid" });
    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "other", codeHash: "new-hash", now: "2026-08-23T00:00:00.000Z" })).toEqual({ outcome: "unauthorized" });
    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "new-hash", now: "2026-08-23T00:00:00.000Z" })).toEqual({ outcome: "consumed", operationId: "r2", paneId: "w1:p1" });
    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "new-hash", now: "2026-08-23T00:00:00.000Z" })).toEqual({ outcome: "stale" });
    expect(store.database.prepare("SELECT state FROM pane_close_requests WHERE id = 'r2'").get()).toEqual({ state: "executing" });
    store.finishPaneCloseRequest("r2", "succeeded");
    expect(store.database.prepare("SELECT state, detail FROM pane_close_requests WHERE id = 'r2'").get()).toEqual({ state: "succeeded", detail: null });
  });

  it("keeps topic ownership intact until a reset candidate is ready, then cuts over atomically", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "old", projectId: "alpha", workspaceId: "w1", chatId: "c1", topicId: "topic-1", rootMessageId: "root-1", title: "Old" });
    store.updateBinding("old", { paneId: "w1:old", traexSessionId: "term-old", state: "active", lifecycle: "active", attachment: "attached" });
    store.enqueuePrompt({ id: "queued", bindingId: "old", larkMessageId: "message-queued", actorOpenId: "u1", body: "later" });
    store.enqueueOutboundReply({ id: "outbound", idempotencyKey: "old-update", bindingId: "old", rootMessageId: "root-1", kind: "text", payload: "old update" });

    const candidate = store.createResetCandidate({ oldBindingId: "old", newBindingId: "new", title: "Fresh", actorOpenId: "u1", resetMessageId: "reset-1" });
    expect(candidate.created).toBe(true);
    expect(candidate.previous).toMatchObject({ id: "old", state: "active", topicId: "topic-1" });
    expect(candidate.replacement).toMatchObject({ id: "new", topicId: null, reservedTopicId: "topic-1", replacesBindingId: "old", lifecycle: "provisioning" });
    expect(store.database.prepare("SELECT state FROM prompt_jobs WHERE id = 'queued'").get()).toEqual({ state: "queued" });
    expect(store.listPendingOutboundReplies().map((item) => item.id)).toContain("outbound");

    store.updateBinding("new", { paneId: "w1:new", traexSessionId: "term-new" });
    store.transitionBinding("new", { type: "pane_created" });
    store.transitionBinding("new", { type: "runtime_started" });
    const handoff = store.cutoverResetCandidate({ oldBindingId: "old", newBindingId: "new", cleanupOperationId: "cleanup-1", actorOpenId: "u1", expectedCwd: "/repo" });

    expect(handoff.cancelledPromptIds).toEqual(["queued"]);
    expect(handoff.previous).toMatchObject({ id: "old", state: "archived", lifecycle: "archived", topicId: null, rootMessageId: null, retiredTopicId: "topic-1", retiredRootMessageId: "root-1" });
    expect(handoff.replacement).toMatchObject({ id: "new", projectId: "alpha", topicId: "topic-1", rootMessageId: "root-1", state: "active", lifecycle: "active" });
    expect(handoff.cleanup).toMatchObject({ id: "cleanup-1", oldBindingId: "old", replacementBindingId: "new", paneId: "w1:old", state: "pending" });
    expect(store.findBindingByLarkScope("topic-1", "root-1")?.id).toBe("new");
    expect(store.listPendingOutboundReplies().map((item) => item.id)).not.toContain("outbound");
  });

  it("preserves an uncertain pane-close operation without replaying it", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active" });
    store.createPaneCloseRequest({ id: "r1", bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "hash", expiresAt: "2099-01-01T00:00:00.000Z" });
    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "hash", now: "2026-08-23T00:00:00.000Z" }).outcome).toBe("consumed");
    store.finishPaneCloseRequest("r1", "uncertain", "verification timeout");

    expect(store.database.prepare("SELECT state, detail FROM pane_close_requests WHERE id = 'r1'").get()).toEqual({ state: "uncertain", detail: "verification timeout" });
    expect(store.listUnresolvedPaneCloseOperations()).toEqual([{ id: "r1", bindingId: "b1", paneId: "w1:p1", state: "uncertain" }]);
    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "hash", now: "2026-08-23T00:00:01.000Z" })).toEqual({ outcome: "stale" });
  });

  it("expires a pane-close confirmation without consuming another request", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active" });
    store.createPaneCloseRequest({ id: "r1", bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "hash", expiresAt: "2026-08-23T00:01:00.000Z" });

    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "hash", now: "2026-08-23T00:01:00.000Z" })).toEqual({ outcome: "expired" });
    expect(store.consumePaneCloseRequest({ bindingId: "b1", paneId: "w1:p1", actorOpenId: "u1", codeHash: "hash", now: "2026-08-23T00:01:01.000Z" })).toEqual({ outcome: "stale" });
  });

  it("durably creates, links, and atomically claims a project selection", () => {
    store = new SqliteBindingStore(":memory:");
    const selection = store.createProjectSelection({
      id: "s1", commandMessageId: "cmd-1", chatId: "c1", topicId: "t1", rootMessageId: "root-1",
      actorOpenId: "u1", requestedTitle: "Fix login", agentKind: "codex", expiresAt: "2099-01-01T00:00:00.000Z", card: { schema: "2.0" }
    });
    const duplicate = store.createProjectSelection({
      id: "other", commandMessageId: "cmd-1", chatId: "c1", topicId: "t1", rootMessageId: "root-1",
      actorOpenId: "u1", requestedTitle: null, expiresAt: "2099-01-01T00:00:00.000Z", card: {}
    });

    expect(selection).toMatchObject({ id: "s1", state: "pending", selectorMessageId: null, agentKind: "codex" });
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

  it("atomically freezes an automatic project selection without a selector card", () => {
    store = new SqliteBindingStore(":memory:");
    const input = {
      id: "auto-1", commandMessageId: "root-message", chatId: "c1", topicId: "root-message", rootMessageId: "root-message",
      actorOpenId: "u1", requestedTitle: "Ship it", initialPromptText: "Ship it", agentKind: "traex" as const, projectId: "bridge", expiresAt: "2099-01-01T00:00:00.000Z"
    };

    const selection = store.createAutomaticProjectSelection(input);
    const duplicate = store.createAutomaticProjectSelection({ ...input, id: "auto-duplicate" });

    expect(selection).toMatchObject({ id: "auto-1", state: "processing", selectedProjectId: "bridge", selectorMessageId: null });
    expect(duplicate.id).toBe("auto-1");
    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.listProcessingProjectSelections()).toEqual([selection]);
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

  it("lists only completed project selections whose deterministic initial prompt is absent", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.createProjectSelection({ id: "s1", commandMessageId: "cmd-1", chatId: "c1", topicId: null, rootMessageId: "root-1", actorOpenId: "u1", requestedTitle: null, initialPromptText: "start", expiresAt: "2099-01-01T00:00:00.000Z", card: {} });
    const reply = store.listPendingOutboundReplies().find((candidate) => candidate.selectionId === "s1")!;
    store.markOutboundReplyDelivered(reply.id, "selector-1");
    expect(store.claimProjectSelection({ selectionId: "s1", projectId: "bridge", messageId: "selector-1", chatId: "c1", actorOpenId: "u1", allowedProjectIds: ["bridge"] }).outcome).toBe("claimed");
    store.linkProjectSelectionBinding("s1", "b1");
    store.completeProjectSelection("s1", "b1");

    expect(store.listCompletedProjectSelectionsWithInitialPrompt().map(({ id }) => id)).toEqual(["s1"]);
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "cmd-1", actorOpenId: "u1", body: "start" });
    expect(store.listCompletedProjectSelectionsWithInitialPrompt()).toEqual([]);

    const plan = store.database.prepare(`EXPLAIN QUERY PLAN
      SELECT selection.* FROM project_selections selection
      WHERE selection.state = 'completed' AND selection.initial_prompt_text IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM prompt_jobs prompt WHERE prompt.lark_message_id = selection.command_message_id)
      ORDER BY selection.created_at`).all() as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes("sqlite_autoindex_prompt_jobs_2"))).toBe(true);
  });

  it("persists bindings, FIFO jobs, deduplication, and view snapshots", () => {
    store = new SqliteBindingStore(":memory:");
    const binding = store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task", agentKind: "pi" });
    expect(binding.agentKind).toBe("pi");
    store.updateBinding(binding.id, { paneId: "w1:p2", state: "active" });
    expect(store.findBindingByLarkScope("unknown-thread", "m1")?.id).toBe("b1");
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "first" });
    store.enqueuePrompt({ id: "p2", bindingId: "b1", larkMessageId: "m3", actorOpenId: "u1", body: "second" });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'not_started', attempt_count = 1 WHERE id = 'p1'").run();
    expect(store.recoverRunningPrompts()).toBe(1);
    expect(store.listQueuedTurnPromptIds("b1")).toEqual(["p1", "p2"]);
    expect(store.listQueuedTurnRunCards("b1")).toEqual([]);
    const inbound = { eventId: "e1", messageId: "m2", chatId: "c1", topicId: "t1", rootMessageId: "m1", actorOpenId: "u1", text: "first", mentionsBot: false, isRootMessage: false };
    expect(store.recordInboundMessage(inbound)).toBe(true);
    expect(store.recordInboundMessage(inbound)).toBe(false);
    expect(store.recordInboundMessage({ ...inbound, eventId: "retried-event" })).toBe(false);
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

  it("loads queued ordinary-turn cards in durable FIFO order", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const first = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "first", workspaceId: "w1", paneId: "w1:p1", requestText: "first", queuePosition: 1, occurredAt: "2026-01-01T00:00:00.000Z" });
    const second = createQueuedRunCard({ promptId: "p2", bindingId: "b1", title: "second", workspaceId: "w1", paneId: "w1:p1", requestText: "second", queuePosition: 2, occurredAt: "2026-01-01T00:00:01.000Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "first" }, view: first, rootMessageId: "root", answerCard: {} });
    store.acceptPrompt({ prompt: { id: "p2", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "second" }, view: second, rootMessageId: "root", answerCard: {} });
    expect(store.listQueuedTurnRunCards("b1").map((view) => view.promptId)).toEqual(["p1", "p2"]);
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

  it("selects only durable actionable Run Cards for startup convergence", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const accept = (promptId: string) => {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 1, occurredAt: `2026-09-01T00:00:0${promptId.length}.000Z` });
      store!.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "u1", body: promptId }, view, rootMessageId: "root", answerCard: {} });
    };
    for (const id of ["history", "live", "lagging", "streaming", "pending", "missing", "quarantine"]) accept(id);
    for (const id of ["history", "lagging", "streaming", "pending", "quarantine"]) {
      const create = store.listPendingOutboundReplies().find((reply) => reply.promptId === id)!;
      store.markOutboundReplyDelivered(create.id, `message-${id}`, `card-${id}`);
      store.saveRunCard({ ...store.loadRunCard(id)!, phase: "completed", answer: "done", answerSegments: ["done"], viewVersion: 1, answerDeliveredVersion: 1 });
    }
    store.saveRunCard({ ...store.loadRunCard("missing")!, phase: "completed" });
    store.database.prepare("UPDATE outbound_replies SET state = 'dismissed' WHERE prompt_id = 'missing' AND state = 'pending'").run();
    store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id IN ('history','lagging','pending','quarantine')").run();
    store.database.prepare("UPDATE answer_pages SET delivery_mode = 'static', state = 'active' WHERE prompt_id = 'lagging'").run();
    store.saveRunCard({ ...store.loadRunCard("lagging")!, viewVersion: 3, answerDeliveredVersion: 1 });
    store.enqueueOutboundReply({ id: "pending-update", idempotencyKey: "pending-update", bindingId: "b1", promptId: "pending", viewVersion: 1, cardRole: "answer", rootMessageId: "message-pending", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "uncertain-update", idempotencyKey: "uncertain-update", bindingId: "b1", promptId: "quarantine", viewVersion: 1, cardRole: "answer", rootMessageId: "message-quarantine", kind: "card_update", payload: "{}" });
    store.markOutboundReplyFailedWithQuarantine("uncertain-update", "unknown outcome", { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: null, larkErrorCode: null });

    expect(store.listActionableStartupRunCards("b1").map(({ promptId }) => promptId).sort()).toEqual(["lagging", "live", "missing", "pending", "quarantine", "streaming"]);
    expect(store.listActionableStartupRunCards("missing")).toEqual([]);
  });

  it("selects an active Run Card for Main restoration before the latest terminal card", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    for (const [promptId, phase, occurredAt] of [["active", "running", "2026-09-01T00:00:00.000Z"], ["latest", "completed", "2026-09-01T00:01:00.000Z"]] as const) {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: 0, occurredAt });
      store.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `message-${promptId}`, actorOpenId: "u1", body: promptId }, view, rootMessageId: "root", answerCard: {} });
      store.saveRunCard({ ...store.loadRunCard(promptId)!, phase });
    }

    expect(store.loadStartupMainRunCard("b1", "latest")?.promptId).toBe("active");
    store.saveRunCard({ ...store.loadRunCard("active")!, phase: "completed" });
    expect(store.loadStartupMainRunCard("b1", "active")?.promptId).toBe("latest");
    expect(store.loadStartupMainRunCard("missing", null)).toBeNull();
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

  it("persists native Agent session identity separately from terminal identity", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "native-session", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const binding = store.updateBinding("native-session", {
      paneId: "w1:p1", traexSessionId: "term-1", agentSessionSource: "codex-hook",
      agentSessionAgent: "codex", agentSessionKind: "id", agentSessionValue: "conversation-1"
    });

    expect(binding).toMatchObject({
      traexSessionId: "term-1", agentSessionSource: "codex-hook", agentSessionAgent: "codex",
      agentSessionKind: "id", agentSessionValue: "conversation-1"
    });
  });

  it("replaces only the owned pane_created provisioning generation", () => {
    const store = new SqliteBindingStore(":memory:");
    let binding = store.createPendingBinding({ id: "provisioning", projectId: "alpha", workspaceId: "w1", chatId: "chat", topicId: null, rootMessageId: null, title: "Task" });
    binding = store.updateBindingMetadata(binding.id, { paneId: "w1:p1", traexSessionId: "term-1" });
    binding = store.transitionBinding(binding.id, { type: "pane_created" });
    const replacement = { paneId: "w1:p2", terminalId: "term-2", workspaceId: "w1", cwd: "/repo", label: null, agentState: "idle" as const, foregroundExecutables: ["traex"] };

    expect(store.replaceProvisioningPane({ bindingId: binding.id, expectedPaneId: "w1:p1", expectedGeneration: 1, pane: replacement })).toMatchObject({
      paneId: "w1:p2", traexSessionId: "term-2", generation: 2, lifecycle: "provisioning", provisioningCheckpoint: "pane_created"
    });
    expect(() => store.replaceProvisioningPane({ bindingId: binding.id, expectedPaneId: "w1:p1", expectedGeneration: 1, pane: replacement })).toThrow(/lost ownership/);
    store.close();
  });

  it("atomically applies an authoritative pane observation behind binding identity fences", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", {
      paneId: "w1:p1", traexSessionId: "term-1", agentSessionSource: "herdr:traex", agentSessionAgent: "traex",
      agentSessionKind: "id", agentSessionValue: "session-1", state: "active", lifecycle: "active", attachment: "degraded", degradationCount: 1
    });

    const applied = store.applyRuntimeObservation({
      bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1,
      pane: { paneId: "w1:p1", terminalId: "term-2", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "working", foregroundExecutables: ["traex"], agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" } }
    });

    expect(applied).toMatchObject({ outcome: "applied", terminalIdentityRefreshed: true, nativeSessionMismatch: false });
    expect(store.getBinding("b1")).toMatchObject({ traexSessionId: "term-2", lastAgentState: "working", attachment: "attached", degradationCount: 0, agentSessionValue: "session-1" });

    expect(store.applyRuntimeObservation({
      bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 0,
      pane: { paneId: "w1:p1", terminalId: "term-3", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"] }
    })).toEqual({ outcome: "stale_binding" });
    expect(store.getBinding("b1")).toMatchObject({ traexSessionId: "term-2", lastAgentState: "working" });
  });

  it("rejects native Herdr TraeX observation for a legacy binding session", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", {
      paneId: "w1:p1", traexSessionId: "term-1", agentSessionSource: "herdr:codex", agentSessionAgent: "traex",
      agentSessionKind: "id", agentSessionValue: "session-1", state: "active", lifecycle: "active", attachment: "attached"
    });

    const applied = store.applyRuntimeObservation({
      bindingId: "b1", expectedPaneId: "w1:p1", expectedGeneration: 1,
      pane: { paneId: "w1:p1", terminalId: "term-2", workspaceId: "w1", cwd: "/repo", label: "task", agentState: "idle", foregroundExecutables: ["traex"], agentSession: { source: "herdr:traex", agent: "traex", kind: "id", value: "session-1" } }
    });

    expect(applied).toMatchObject({ outcome: "terminal_identity_changed" });
    expect(store.getBinding("b1")).toMatchObject({ generation: 1, traexSessionId: "term-1", agentSessionSource: "herdr:codex", agentSessionValue: "session-1" });
  });

  it("atomically cancels queued turns with terminal delivery intents", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    const seed = (id: string) => {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: id, queuePosition: 1, occurredAt: "2026-08-29T00:00:00.000Z" });
      store!.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body: id }, view, rootMessageId: "m1", answerCard: { phase: "queued", id } });
      return store!.listPendingOutboundReplies().find((reply) => reply.promptId === id)!;
    };
    const runningCreate = seed("running");
    store.markOutboundReplyDelivered(runningCreate.id, "answer-running", "card-running");
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("running");
    const pendingCreate = seed("pending");
    const checkpointedCreate = seed("checkpointed");
    store.checkpointOutboundReplyCard(checkpointedCreate.id, "card-checkpointed");
    const deliveredCreate = seed("delivered");
    store.markOutboundReplyDelivered(deliveredCreate.id, "answer-delivered");
    const cardTargetCreate = seed("card-target");
    store.markOutboundReplyDelivered(cardTargetCreate.id, "answer-card-target", "card-target");
    const pendingBefore = store.listPendingOutboundReplies().find((reply) => reply.id === pendingCreate.id)!;
    const checkpointedBefore = store.listPendingOutboundReplies().find((reply) => reply.id === checkpointedCreate.id)!;

    const result = store.cancelQueuedPromptsWithProjection({
      bindingId: "b1", reason: "Topic archived", occurredAt: "2026-08-29T01:02:03.000Z", rootMessageId: "m1",
      renderRunCard: (view) => ({ phase: view.phase, notice: view.notice, version: view.viewVersion })
    });

    expect(result).toEqual({ cancelledPromptIds: ["pending", "checkpointed", "delivered", "card-target"], outboxReserved: true });
    expect(store.getPrompt("running")).toMatchObject({ state: "running" });
    for (const id of result.cancelledPromptIds) {
      expect(store.getPrompt(id)).toMatchObject({ state: "cancelled", observationState: "completed", error: "Topic archived", updatedAt: "2026-08-29T01:02:03.000Z" });
      expect(store.loadRunCard(id)).toMatchObject({ phase: "failed", notice: "Topic archived", queuePosition: 0, finishedAt: "2026-08-29T01:02:03.000Z", activityAt: "2026-08-29T01:02:03.000Z", updatedAt: "2026-08-29T01:02:03.000Z" });
    }
    const pendingAfter = store.listPendingOutboundReplies().find((reply) => reply.id === pendingCreate.id)!;
    expect(pendingAfter).toMatchObject({ idempotencyKey: "run-card:create:pending:answer", kind: "stream_card_create", viewVersion: 2 });
    expect(store.database.prepare("SELECT lane_key FROM outbound_replies WHERE id = ?").get(pendingAfter.id)).toEqual({ lane_key: "gateway:feishu:primary:answer:pending" });
    expect(pendingAfter.payload).toBe(JSON.stringify({ phase: "failed", notice: "Topic archived", version: 2 }));
    expect(store.listPendingOutboundReplies().filter((reply) => reply.promptId === "pending")).toHaveLength(1);
    expect(store.listPendingOutboundReplies().find((reply) => reply.id === checkpointedCreate.id)).toMatchObject({ payload: checkpointedBefore.payload, viewVersion: checkpointedBefore.viewVersion, cardIdCheckpoint: "card-checkpointed" });
    expect(store.listPendingOutboundReplies()).toContainEqual(expect.objectContaining({ idempotencyKey: "run-card:update:delivered:answer:2", kind: "card_update", rootMessageId: "answer-delivered" }));
    expect(store.database.prepare("SELECT lane_key FROM outbound_replies WHERE idempotency_key = ?").get("run-card:update:delivered:answer:2")).toEqual({ lane_key: "gateway:feishu:primary:primary-answer:delivered:1" });
    expect(store.listPendingOutboundReplies().filter((reply) => reply.promptId === "card-target")).toEqual([]);
    expect(store.getOperationalSummary().prompts.cancelled).toBe(4);
    expect(store.countPendingPrompts("b1")).toBe(1);
    expect(store.cancelQueuedPromptsWithProjection({ bindingId: "b1", reason: "again", occurredAt: "later", rootMessageId: "m1", renderRunCard: () => ({}) })).toEqual({ cancelledPromptIds: [], outboxReserved: false });
    expect(store.loadRunCard("pending")?.viewVersion).toBe(2);
    expect(pendingBefore.id).toBe(pendingAfter.id);
  });

  it("rolls back every queued cancellation when terminal outbox projection fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    for (const id of ["p1", "p2"]) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: id, queuePosition: 1, occurredAt: "start" });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body: id }, view, rootMessageId: "m1", answerCard: {} });
    }
    store.database.exec(`CREATE TRIGGER fail_second_cancel_outbox BEFORE UPDATE ON outbound_replies WHEN OLD.prompt_id = 'p2' BEGIN SELECT RAISE(ABORT, 'injected cancellation outbox failure'); END`);

    expect(() => store!.cancelQueuedPromptsWithProjection({ bindingId: "b1", reason: "archive", occurredAt: "later", rootMessageId: "m1", renderRunCard: (view) => ({ phase: view.phase }) })).toThrow("injected cancellation outbox failure");

    for (const id of ["p1", "p2"]) {
      expect(store.getPrompt(id)).toMatchObject({ state: "queued", observationState: "not_started", error: null });
      expect(store.loadRunCard(id)).toMatchObject({ phase: "queued", viewVersion: 1, notice: null });
      expect(store.listPendingOutboundReplies().find((reply) => reply.promptId === id)).toMatchObject({ viewVersion: 1, payload: "{}" });
    }
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
      bindings: { pending: 1 }, prompts: { failed: 1 },
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

  it("summarizes durable inbound backlog without exposing message payloads", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-31T12:10:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    const first = { eventId: "inbound-1", messageId: "message-1", chatId: "chat", topicId: "topic", rootMessageId: "root", actorOpenId: "user", text: "private inbound body", mentionsBot: false, isRootMessage: false };
    const second = { ...first, eventId: "inbound-2", messageId: "message-2" };
    store.recordInboundMessage(first);
    store.recordInboundMessage(second);
    store.database.prepare("UPDATE inbound_messages SET created_at = '2026-08-31T12:00:00.000Z' WHERE event_id = 'inbound-1'").run();
    expect(store.claimNextInboundMessage()).toMatchObject({ eventId: "inbound-1" });
    store.releaseInboundMessage("inbound-1", "temporary failure " + "x".repeat(800));

    const summary = store.getOperationalSummary().inbound;
    expect(summary).toMatchObject({
      states: { received: 2, processing: 0, accepted: 0 }, retryable: 1,
      oldestPendingAt: "2026-08-31T12:00:00.000Z", oldestPendingAgeSeconds: 600,
      recentFailure: { eventId: "inbound-1", error: expect.stringContaining("temporary failure") }
    });
    expect(summary.recentFailure!.error.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(summary)).not.toContain("private inbound body");
    vi.useRealTimers();
  });

  it("summarizes bounded prompt latency without exposing prompt content", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    for (const id of ["completed", "failed", "running"]) {
      const view = createQueuedRunCard({ promptId: id, bindingId: "b1", title: id, workspaceId: "w1", paneId: "w1:p1", requestText: `private ${id}`, queuePosition: 1, occurredAt: "2026-08-28T00:00:00.000Z" });
      store.acceptPrompt({ prompt: { id, bindingId: "b1", larkMessageId: `m-${id}`, actorOpenId: "u1", body: `private ${id}` }, view, rootMessageId: "m1", answerCard: {} });
    }
    store.database.prepare("UPDATE prompt_jobs SET state = 'delivered', created_at = '2026-08-28T00:00:00.000Z' WHERE id = 'completed'").run();
    store.database.prepare("UPDATE run_cards SET started_at = '2026-08-28T00:00:02.000Z', finished_at = '2026-08-28T00:00:12.000Z', updated_at = '2026-08-28T00:00:15.000Z' WHERE prompt_id = 'completed'").run();
    store.enqueueOutboundReply({ id: "finish-completed", idempotencyKey: "finish-completed", bindingId: "b1", promptId: "completed", rootMessageId: "m1", kind: "stream_finish", payload: "{}" });
    store.database.prepare("UPDATE outbound_replies SET state = 'delivered', updated_at = '2026-08-28T00:00:15.000Z' WHERE id = 'finish-completed'").run();
    store.database.prepare("UPDATE prompt_jobs SET state = 'failed', created_at = '2026-08-28T00:01:00.000Z' WHERE id = 'failed'").run();
    store.database.prepare("UPDATE run_cards SET started_at = '2026-08-28T00:01:04.000Z', finished_at = '2026-08-28T00:01:10.000Z', updated_at = '2026-08-28T00:01:11.000Z' WHERE prompt_id = 'failed'").run();
    store.enqueueOutboundReply({ id: "finish-failed", idempotencyKey: "finish-failed", bindingId: "b1", promptId: "failed", rootMessageId: "m1", kind: "stream_finish", payload: "{}" });
    store.database.prepare("UPDATE outbound_replies SET state = 'delivered', updated_at = '2026-08-28T00:01:11.000Z' WHERE id = 'finish-failed'").run();
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', created_at = '2026-08-28T00:02:00.000Z' WHERE id = 'running'").run();
    store.database.prepare("UPDATE run_cards SET started_at = '2026-08-28T00:02:01.000Z', finished_at = NULL WHERE prompt_id = 'running'").run();

    const summary = store.getOperationalSummary();
    expect(summary.promptLatency).toEqual({
      windowSize: 100, sampleCount: 2,
      queue: { sampleCount: 2, averageMs: 3000, maxMs: 4000 },
      execution: { sampleCount: 2, averageMs: 8000, maxMs: 10000 },
      delivery: { sampleCount: 2, averageMs: 2000, maxMs: 3000 }
    });
    expect(JSON.stringify(summary.promptLatency)).not.toContain("private");
  });

  it("reports empty prompt latency phases without synthetic zero durations", () => {
    store = new SqliteBindingStore(":memory:");
    expect(store.getOperationalSummary().promptLatency).toEqual({
      windowSize: 100, sampleCount: 0,
      queue: { sampleCount: 0, averageMs: null, maxMs: null },
      execution: { sampleCount: 0, averageMs: null, maxMs: null },
      delivery: { sampleCount: 0, averageMs: null, maxMs: null }
    });
  });

  it("reports bounded quarantine and stalled-lane diagnostics without payload data", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-26T00:10:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "blocked", idempotencyKey: "blocked", bindingId: "b1", rootMessageId: "root-1", kind: "card_reply", payload: "private card payload" });
    store.database.prepare("UPDATE outbound_replies SET created_at = ?, next_attempt_at = ? WHERE id = 'blocked'").run("2026-08-26T00:00:00.000Z", "2026-08-26T00:00:00.000Z");
    store.enqueueOutboundReply({ id: "failed", idempotencyKey: "failed", bindingId: "b1", rootMessageId: "root-2", kind: "card_reply", payload: "another private payload" });
    store.markOutboundReplyFailedWithQuarantine("failed", "invalid target " + "x".repeat(800), { failureClass: "permanent", httpStatus: 400, larkErrorCode: null });

    const summary = store.getOperationalSummary();
    expect(summary.outboxLanes).toMatchObject({ stalled: 1, oldestStalledAgeSeconds: 600 });
    expect(summary.outboxQuarantines).toMatchObject({
      active: 1, released: 0, byLaneClass: { immutable: 1 }, byFailureClass: { permanent: 1 },
      latest: { replyId: "failed", replyKind: "card_reply", laneClass: "immutable", failureClass: "permanent", action: "blocked" }
    });
    expect(summary.outboxQuarantines.latest!.reason.length).toBeLessThanOrEqual(500);
    expect(JSON.stringify(summary)).not.toMatch(/private card payload|another private payload/);
    vi.useRealTimers();
  });

  it("commits prompt completion and terminal projections atomically before lifecycle delivery", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "Task", workspaceId: "w1", paneId: "w1:p1", phase: "running", activePromptId: "p1" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Work", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-24T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const answerCreate = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(answerCreate.id, "answer-1", "card-1");
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("p1");
    store.transitionBinding("b1", { type: "pane_observed", runtime: "working" });

    store.completeTurn({ promptId: "p1", bindingId: "b1", answer: "done", outputFingerprint: "fingerprint", occurredAt: "2026-08-24T00:01:00Z" });

    expect(store.getPrompt("p1")).toMatchObject({ state: "delivered", observationState: "completed" });
    expect(store.getBinding("b1")).toMatchObject({ lastAgentState: "done", lastOutputFingerprint: "fingerprint", hasCompletedTurn: true });
    expect(store.loadRunCard("p1")).toMatchObject({ phase: "completed", answer: "done", answerMessageId: "answer-1" });
    expect(store.loadTopicView("b1")).toMatchObject({ phase: "done", answer: "done", activePromptId: null });
  });

  it("reopens a completed turn without lifecycle replay or prompt duplication", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-terminal-projection-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.saveTopicView({ ...initialTopicView("b1"), title: "Task", workspaceId: "w1", paneId: "w1:p1", phase: "running", activePromptId: "p1" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Work", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "2026-08-24T00:00:00Z" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "card-1");
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("p1");
    store.transitionBinding("b1", { type: "pane_observed", runtime: "working" });
    store.completeTurn({ promptId: "p1", bindingId: "b1", answer: "durable answer", outputFingerprint: "fp", occurredAt: "2026-08-24T00:01:00Z" });
    store.close();

    store = new SqliteBindingStore(path);
    expect(store.getPrompt("p1")).toMatchObject({ state: "delivered", attemptCount: 1 });
    expect(store.loadRunCard("p1")).toMatchObject({ phase: "completed", answer: "durable answer" });
    expect(store.loadTopicView("b1")).toMatchObject({ phase: "done", answer: "durable answer" });
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
    expect(store.listPendingOutboundReplies()).toEqual([]);
  });

  it("scopes sessions and dead-letter actions to a chat without replaying prompts", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Visible" });
    store.createPendingBinding({ id: "b2", workspaceId: "w2", chatId: "c2", topicId: "t2", rootMessageId: "m2", title: "Hidden" });
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "p-m1", actorOpenId: "u1", body: "private" });
    store.updatePrompt("p1", "failed", "prompt failed");
    store.enqueueOutboundReply({ id: "o1", idempotencyKey: "o1", bindingId: "b1", promptId: "p1", rootMessageId: "m1", kind: "card_update", payload: "{}" });
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("o1", "send failed");

    expect(store.listSessions("c1").sessions).toHaveLength(1);
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

  it("pages sessions with a stable non-overlapping keyset and chat-leading index", () => {
    store = new SqliteBindingStore(":memory:");
    for (let index = 0; index < 45; index += 1) {
      const id = `b-${String(index).padStart(2, "0")}`;
      store.createPendingBinding({ id, workspaceId: "w1", chatId: "c1", topicId: `t-${id}`, rootMessageId: `m-${id}`, title: id });
      store.database.prepare("UPDATE bindings SET last_activity_at = ? WHERE id = ?").run(`2026-09-18T00:${String(index).padStart(2, "0")}:00.000Z`, id);
    }
    const first = store.listSessions("c1");
    expect(first.sessions).toHaveLength(20);
    expect(first.nextCursor).not.toBeNull();
    store.createPendingBinding({ id: "newest", workspaceId: "w1", chatId: "c1", topicId: "t-new", rootMessageId: "m-new", title: "new" });
    store.database.prepare("UPDATE bindings SET last_activity_at = '2099-01-01T00:00:00.000Z' WHERE id = 'newest'").run();
    const second = store.listSessions("c1", first.nextCursor);
    expect(second.sessions).toHaveLength(20);
    expect(second.sessions.map(({ binding }) => binding.id).filter((id) => first.sessions.some(({ binding }) => binding.id === id))).toEqual([]);
    expect(() => store!.listSessions("c1", "invalid")).toThrow("invalid_sessions_cursor");
    const plan = store.database.prepare(`EXPLAIN QUERY PLAN SELECT * FROM bindings INDEXED BY bindings_chat_session_rank_order WHERE chat_id = ? ORDER BY
      CASE attachment WHEN 'degraded' THEN 0 WHEN 'orphaned' THEN 2 ELSE 1 END,
      CASE lifecycle WHEN 'active' THEN 0 WHEN 'provisioning' THEN 1 WHEN 'draining' THEN 2 WHEN 'archived' THEN 3 WHEN 'closed' THEN 4 ELSE 5 END,
      last_activity_at DESC, id LIMIT 21`).all("c1") as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes("bindings_chat_session_rank_order"))).toBe(true);
    expect(plan.some(({ detail }) => detail.includes("TEMP B-TREE"))).toBe(false);
  });

  it("atomically accepts one streaming answer card and claims before its card identity is delivered", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", bindingGeneration: 3, conversionParentPromptId: "parent-prompt", title: "First", workspaceId: "w1", paneId: "w1:p1", requestText: "first **request**", queuePosition: 1, occurredAt: "2026-08-22T10:00:00.000Z" });
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
    expect(store.listQueuedTurnPromptIds("b1")).toEqual(["p1"]);
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("p1");
    expect(store.listQueuedTurnPromptIds("b1")).toEqual([]);

    const [answerCreate] = store.listPendingOutboundReplies();
    store.markOutboundReplyDelivered(answerCreate!.id, "answer-card-m1", "cardkit-1");
    expect(store.loadRunCard("p1")).toMatchObject({
      bindingGeneration: 3, conversionParentPromptId: "parent-prompt", larkMessageId: null, answerMessageId: "answer-card-m1", answerCardId: "cardkit-1", requestText: "first **request**", answerDeliveredVersion: 1
    });
    expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({
      promptId: "p1", pageIndex: 0, messageId: "answer-card-m1", cardId: "cardkit-1", elementId: answerElementId("p1", 0), sourceStart: 0, sequence: 0, state: "active"
    })]);
    store.markPromptDispatched("p1");
    store.saveRunCard({ ...store.loadRunCard("p1")!, answer: "First complete\n\nSecond draft", answerSegments: ["First complete"], answerDraft: "Second draft", answerDraftTransient: false });
    expect(store.loadRunCard("p1")).toMatchObject({
      answer: "First complete\n\nSecond draft", answerSegments: ["First complete"], answerDraft: "Second draft", answerDraftTransient: false
    });
    expect(store.recoverRunningPrompts()).toBe(1);
    expect(store.listDetachedPrompts()).toMatchObject([{ id: "p1", state: "running", observationState: "detached" }]);
    expect(store.loadRunCard("p1")).toMatchObject({ phase: "running", notice: "Bridge 已重连，正在观察原 TraeX 任务；不会重复发送请求", queuePosition: 0, viewVersion: 2 });
    expect(store.getPrompt("p1")).toMatchObject({ wasDetached: true });
  });

  it("returns committed prompt acceptance effects once and none for a duplicate", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "p-effects", bindingId: "b1", bindingGeneration: 2, title: "Work", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "2026-09-07T00:00:00.000Z" });
    const input = { prompt: { id: "p-effects", bindingId: "b1", larkMessageId: "m-effects", actorOpenId: "u1", body: "work" }, view, rootMessageId: "root", answerCard: {} };

    const accepted = store.acceptPromptWithEffects(input);
    expect(accepted.commitState).toBe("committed");
    expect(accepted.consumeEffects()).toMatchObject([
      { kind: "outbound-wake" },
      { kind: "prompt-wake", bindingId: "b1" },
      { kind: "lifecycle-event", event: { type: "PromptQueued", bindingId: "b1", payload: { promptId: "p-effects", queueDepth: 1, actorOpenId: "u1" } } }
    ]);
    expect(accepted.consumeEffects()).toEqual([]);

    const duplicate = store.acceptPromptWithEffects({ ...input, prompt: { ...input.prompt, id: "duplicate" }, view: { ...view, promptId: "duplicate" } });
    expect(duplicate.result).toMatchObject({ inserted: false, prompt: { id: "p-effects" } });
    expect(duplicate.consumeEffects()).toEqual([]);
  });

  it("durably catches up a queued Answer view advanced while its card create was in flight", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-answer-create-catch-up-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const initial = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "hi", queuePosition: 3, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "hi" }, view: initial, rootMessageId: "root", answerCard: {} });
    const create = store.listPendingOutboundReplies().find((reply) => reply.promptId === "p1")!;
    store.saveRunCard({ ...initial, queuePosition: 2, viewVersion: 2, updatedAt: "later" });

    expect(store.markOutboundReplyDelivered(create.id, "answer-1", "card-1")).toBe(true);
    expect(store.loadRunCard("p1")).toMatchObject({ answerMessageId: "answer-1", viewVersion: 2, answerDeliveredVersion: 1 });
    expect(store.listPendingCardContextInvalidations()).toContainEqual(expect.objectContaining({ targetKind: "primary-turn", targetId: "p1", targetGeneration: 1, reason: "answer-create.delivered" }));
    store.close(); store = new SqliteBindingStore(path);

    const invalidation = store.listPendingCardContextInvalidations().find(({ targetKind, targetId }) => targetKind === "primary-turn" && targetId === "p1")!;
    expect(store.projectCardContext(invalidation, {
      primaryAnswer: (view) => ({ promptId: view.promptId, version: view.viewVersion }),
      primaryMain: () => { throw new Error("not used"); }, workerMain: () => { throw new Error("not used"); }, workerTask: () => { throw new Error("not used"); }
    })).toBe("reserved");
    expect(store.listPendingOutboundReplies()).toContainEqual(expect.objectContaining({ promptId: "p1", kind: "card_update", viewVersion: 2, rootMessageId: "answer-1" }));
    expect(store.markOutboundReplyDelivered(create.id, "duplicate", "duplicate-card")).toBe(false);
  });


  it("projects changed queued run cards in one batch with per-card answer lanes", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const views = ["p1", "p2", "p3"].map((promptId, index) => createQueuedRunCard({
      promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: index + 1, occurredAt: "start"
    }));
    for (const view of views) {
      store.acceptPrompt({ prompt: { id: view.promptId, bindingId: "b1", larkMessageId: `m-${view.promptId}`, actorOpenId: "u1", body: view.promptId }, view, rootMessageId: "root", answerCard: {} });
      const create = store.listPendingOutboundReplies().find((reply) => reply.promptId === view.promptId)!;
      store.markOutboundReplyDelivered(create.id, `answer-${view.promptId}`, `card-${view.promptId}`);
    }
    const first = store.loadRunCard("p1")!;
    const third = store.loadRunCard("p3")!;
    const firstNext = { ...first, queuePosition: 2, viewVersion: first.viewVersion + 1, updatedAt: "later" };
    const thirdNext = { ...third, queuePosition: 4, viewVersion: third.viewVersion + 1, updatedAt: "later" };

    expect(store.projectQueuedRunCards({
      bindingId: "b1",
      projections: [
        { expectedViewVersion: first.viewVersion, view: firstNext, card: { promptId: "p1" } },
        { expectedViewVersion: third.viewVersion, view: thirdNext, card: { promptId: "p3" } }
      ]
    })).toEqual({ projected: [firstNext, thirdNext], stalePromptIds: [], outboxReserved: true });
    expect(store.loadRunCard("p1")).toMatchObject({ queuePosition: 2, viewVersion: first.viewVersion + 1 });
    expect(store.loadRunCard("p2")).toMatchObject({ queuePosition: 2, viewVersion: views[1]!.viewVersion });
    expect(store.loadRunCard("p3")).toMatchObject({ queuePosition: 4, viewVersion: third.viewVersion + 1 });
    expect(store.database.prepare("SELECT idempotency_key, lane_key FROM outbound_replies WHERE kind = 'card_update' ORDER BY prompt_id").all()).toEqual([
      { idempotency_key: `run-card:update:p1:answer:${first.viewVersion + 1}`, lane_key: "gateway:feishu:primary:primary-answer:p1:1" },
      { idempotency_key: `run-card:update:p3:answer:${third.viewVersion + 1}`, lane_key: "gateway:feishu:primary:primary-answer:p3:1" }
    ]);
  });

  it("skips stale queued card projections while committing valid siblings", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const cards = ["stale", "valid"].map((promptId, index) => {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: index + 1, occurredAt: "start" });
      view.answerMessageId = `answer-${promptId}`;
      store!.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `m-${promptId}`, actorOpenId: "u1", body: promptId }, view, rootMessageId: "root", answerCard: {} });
      return view;
    });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, `delivered-${reply.promptId}`, `card-${reply.promptId}`);

    const result = store.projectQueuedRunCards({ bindingId: "b1", projections: cards.map((view) => ({ expectedViewVersion: view.promptId === "stale" ? 0 : 1, view: { ...view, queuePosition: 9, viewVersion: 2 }, card: {} })) });

    expect(result).toMatchObject({ projected: [expect.objectContaining({ promptId: "valid" })], stalePromptIds: ["stale"], outboxReserved: true });
    expect(store.loadRunCard("stale")).toMatchObject({ queuePosition: 1, viewVersion: 1 });
    expect(store.loadRunCard("valid")).toMatchObject({ queuePosition: 9, viewVersion: 2 });
  });

  it("projects a queued card without reserving outbox work when no answer message exists", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const initial = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "work", queuePosition: 1, occurredAt: "start" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "work" }, view: initial, rootMessageId: "root", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "card-1");

    expect(store.projectQueuedRunCards({ bindingId: "b1", projections: [{ expectedViewVersion: 1, view: { ...initial, queuePosition: 2, viewVersion: 2 }, card: {} }] })).toMatchObject({
      projected: [expect.objectContaining({ promptId: "p1", queuePosition: 2 })], stalePromptIds: [], outboxReserved: false
    });
    expect(store.listPendingOutboundReplies()).toHaveLength(0);
  });

  it("rolls back every queued card and outbox intent when one batch insert fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const cards = ["p1", "p2"].map((promptId, index) => {
      const view = createQueuedRunCard({ promptId, bindingId: "b1", title: promptId, workspaceId: "w1", paneId: "w1:p1", requestText: promptId, queuePosition: index + 1, occurredAt: "start" });
      view.answerMessageId = `answer-${promptId}`;
      store!.acceptPrompt({ prompt: { id: promptId, bindingId: "b1", larkMessageId: `m-${promptId}`, actorOpenId: "u1", body: promptId }, view, rootMessageId: "root", answerCard: {} });
      return view;
    });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, `delivered-${reply.promptId}`, `card-${reply.promptId}`);
    store.database.exec("CREATE TEMP TRIGGER reject_second_queue_card BEFORE INSERT ON outbound_replies WHEN NEW.kind = 'card_update' AND NEW.prompt_id = 'p2' BEGIN SELECT RAISE(ABORT, 'reject second outbox'); END");

    try {
      expect(() => store!.projectQueuedRunCards({ bindingId: "b1", projections: cards.map((view) => ({ expectedViewVersion: 1, view: { ...view, queuePosition: view.queuePosition + 1, viewVersion: 2 }, card: {} })) })).toThrow("reject second outbox");
      expect(store.loadRunCard("p1")).toMatchObject({ queuePosition: 1, viewVersion: 1 });
      expect(store.loadRunCard("p2")).toMatchObject({ queuePosition: 2, viewVersion: 1 });
      expect(store.listPendingOutboundReplies()).toHaveLength(0);
    } finally {
      store.database.exec("DROP TRIGGER IF EXISTS reject_second_queue_card");
    }
  });

  it.each([
    ["detached", false],
    ["recovered but previously detached", true]
  ] as const)("omits active queue timing for a %s running prompt", (_label, recover) => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    const active = createQueuedRunCard({ promptId: "active", bindingId: "b1", title: "active", workspaceId: "w1", paneId: "w1:p1", requestText: "active", queuePosition: 1, occurredAt: "2026-08-29T10:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "active", bindingId: "b1", larkMessageId: "m-active", actorOpenId: "u1", body: "active" }, view: active, rootMessageId: "root", answerCard: {} });
    store.updatePrompt("active", "running");
    store.markPromptDispatched("active");
    store.database.prepare("UPDATE run_cards SET phase = 'running', started_at = '2026-08-29T10:00:00.000Z' WHERE prompt_id = 'active'").run();
    store.markPromptObservationDetached("active", "observer interrupted");
    if (recover) store.markPromptDispatched("active");

    expect(store.loadQueueFeedbackInputs("b1").activeStartedAt).toBeNull();
  });

  it("migrates prompt detachment and run-card activity idempotently", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-classified-prompt-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const view = createQueuedRunCard({ promptId: "legacy", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: null, requestText: "legacy", queuePosition: 1, occurredAt: "2026-08-29T09:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "legacy", bindingId: "b1", larkMessageId: "m-legacy", actorOpenId: "u1", body: "legacy" }, view, rootMessageId: "root", answerCard: {} });
    store.database.exec("DROP VIEW run_cards_view; ALTER TABLE prompt_jobs DROP COLUMN was_detached; ALTER TABLE run_cards DROP COLUMN activity_at; ALTER TABLE run_cards DROP COLUMN queue_feedback_json;");
    store.close();
    store = undefined;

    store = new SqliteBindingStore(path);
    expect(store.getPrompt("legacy")).toMatchObject({ wasDetached: false });
    expect(store.loadRunCard("legacy")?.activityAt).toBe("2026-08-29T09:00:00.000Z");
    expect(store.loadRunCard("legacy")?.queueFeedback).toBeNull();
  });

  it("derives cumulative progress before trimming legacy run-card history", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-progress-summary-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const view = createQueuedRunCard({ promptId: "legacy-progress", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: null, requestText: "legacy", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "legacy-progress", bindingId: "b1", larkMessageId: "m-legacy-progress", actorOpenId: "u1", body: "legacy" }, view, rootMessageId: "root", answerCard: {} });
    const events = Array.from({ length: 10 }, (_, index) => ({ key: `step:${index}`, kind: "step", label: `step ${index}`, state: index < 6 ? "done" : "active", occurredAt: "now" }));
    store.database.prepare("UPDATE run_cards SET progress_events_json = ? WHERE prompt_id = 'legacy-progress'").run(JSON.stringify(events));
    store.database.exec("DELETE FROM schema_migrations WHERE version = 6; DROP VIEW run_cards_view; ALTER TABLE run_cards DROP COLUMN progress_summary_json");
    store.close();
    store = undefined;

    store = new SqliteBindingStore(path);
    const migrated = store.loadRunCard("legacy-progress")!;
    expect(migrated.progressEvents.map((event) => event.key)).toEqual(Array.from({ length: 8 }, (_, index) => `step:${index + 2}`));
    expect(migrated.progressSummary).toEqual({ total: 10, stepTotal: 10, stepDone: 6 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 6").get()).toEqual({ version: 6 });
  });

  it("drops a stale run-card view before migrating legacy tables", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-stale-run-card-view-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.close();
    store = undefined;

    const legacy = new DatabaseSync(path);
    legacy.exec(`
      DROP VIEW run_cards_view;
      DROP INDEX card_interactions_expiry;
      ALTER TABLE card_interactions RENAME TO card_interactions_current;
      CREATE TABLE card_interactions(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), binding_generation INTEGER NOT NULL, actor_open_id TEXT NOT NULL,
        action_kind TEXT NOT NULL CHECK(action_kind IN ('supplement','convert_queued_prompt','more_actions','session_control')),
        parent_prompt_id TEXT, target_prompt_id TEXT, state TEXT NOT NULL CHECK(state IN ('active','claimed','consumed','expired')),
        expires_at TEXT NOT NULL, result_code TEXT, created_at TEXT NOT NULL, claimed_at TEXT, consumed_at TEXT
      );
      DROP TABLE card_interactions_current;
      CREATE INDEX card_interactions_expiry ON card_interactions(state, expires_at);
      CREATE VIEW run_cards_view AS SELECT *, json_object(
        'promptId', prompt_id, 'requestText', request_text
      ) AS state_json FROM run_cards;
    `);
    legacy.close();

    expect(() => { store = new SqliteBindingStore(path); }).not.toThrow();
    expect((store!.database.prepare("PRAGMA table_info(run_cards)").all() as Array<{ name: string }>).map(({ name }) => name)).not.toEqual(expect.arrayContaining(["steering_origin", "steering_failure_kind"]));
    expect(store!.database.prepare("SELECT state_json FROM run_cards_view LIMIT 1").all()).toEqual([]);
  });

  it("preserves prompt provenance while rebuilding the legacy prompt state constraint", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-prompt-state-provenance-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const source = createQueuedRunCard({ promptId: "source", bindingId: "b1", title: "Source", workspaceId: "w1", paneId: null, requestText: "source", queuePosition: 1, occurredAt: "2026-08-29T09:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "source", bindingId: "b1", larkMessageId: "m-source", actorOpenId: "u1", body: "source" }, view: source, rootMessageId: "root", answerCard: {} });
    const converted = createQueuedRunCard({ promptId: "converted", bindingId: "b1", title: "Converted", workspaceId: "w1", paneId: null, requestText: "converted", queuePosition: 2, occurredAt: "2026-08-29T09:01:00.000Z" });
    store.acceptPrompt({ prompt: { id: "converted", bindingId: "b1", larkMessageId: "m-converted", actorOpenId: "u1", body: "converted", wasDetached: true }, view: converted, rootMessageId: "root", answerCard: {} });
    store.database.prepare("UPDATE prompt_jobs SET dispatched_at = ?, transcript_turn_id = ?, transcript_turn_started_at = ? WHERE id = 'converted'")
      .run("2026-08-29T09:01:01.000Z", "01a052d3-9c14-70e1-a375-397e2ecb55e9", "2026-08-29T09:01:01.250Z");
    store.database.exec(`
      PRAGMA foreign_keys = OFF;
      CREATE TABLE prompt_jobs_legacy(
        id TEXT PRIMARY KEY, binding_id TEXT NOT NULL REFERENCES bindings(id), lark_message_id TEXT UNIQUE NOT NULL,
        actor_open_id TEXT NOT NULL, body TEXT NOT NULL, dispatch_kind TEXT NOT NULL DEFAULT 'turn' CHECK(dispatch_kind IN ('turn','steering')), priority TEXT NOT NULL DEFAULT 'normal', parent_prompt_id TEXT,
        steering_origin TEXT CHECK(steering_origin IN ('explicit','automatic','converted')), source_prompt_id TEXT REFERENCES prompt_jobs_legacy(id), was_detached INTEGER NOT NULL DEFAULT 0 CHECK(was_detached IN (0,1)),
        dispatched_at TEXT, transcript_turn_id TEXT, transcript_turn_started_at TEXT,
        state TEXT NOT NULL CHECK(state IN ('queued','running','delivered','failed')), observation_state TEXT NOT NULL DEFAULT 'not_started' CHECK(observation_state IN ('not_started','attached','detached','completed')),
        attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, created_at TEXT NOT NULL, updated_at TEXT NOT NULL
      );
      INSERT INTO prompt_jobs_legacy(id, binding_id, lark_message_id, actor_open_id, body, dispatch_kind, parent_prompt_id, steering_origin, source_prompt_id, was_detached, dispatched_at, transcript_turn_id, transcript_turn_started_at, state, observation_state, attempt_count, error, created_at, updated_at)
        SELECT id, binding_id, lark_message_id, actor_open_id, body, 'turn', NULL, NULL, NULL, was_detached, dispatched_at, transcript_turn_id, transcript_turn_started_at, state, observation_state, attempt_count, error, created_at, updated_at FROM prompt_jobs;
      DROP TABLE prompt_jobs;
      ALTER TABLE prompt_jobs_legacy RENAME TO prompt_jobs;
      PRAGMA foreign_keys = ON;
    `);
    store.close();
    store = undefined;

    store = new SqliteBindingStore(path);
    expect(store.getPrompt("converted")).toMatchObject({
      wasDetached: true,
      dispatchedAt: "2026-08-29T09:01:01.000Z", transcriptTurnId: "01a052d3-9c14-70e1-a375-397e2ecb55e9", transcriptTurnStartedAt: "2026-08-29T09:01:01.250Z"
    });
  });

  it("atomically reserves Answer content, continuation, and terminal finish intents", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "card-1");
    const elementId = answerElementId("p1", 0);

    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId, content: "page one" })).toBe("reserved");
    expect(store.getActiveAnswerPage("p1")?.sequence).toBe(1);
    expect(store.loadRunCard("p1")?.answerSequence).toBe(1);
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ kind: "stream_content", viewVersion: 1 })]);
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId, content: "page one" })).toBe("waiting");
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "card-1");

    expect(store.reserveAnswerContinuation({ promptId: "p1", pageIndex: 0, cardId: "card-1", messageId: "answer-1", summary: "Continued", finalizedCard: { final: true }, nextPageIndex: 1, nextPageStart: 9_000, nextElementId: answerElementId("p1", 1), rootMessageId: "root-1", viewVersion: 2, card: {} })).toBe("reserved");
    expect(store.listAnswerPages("p1")).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "active", sequence: 2 }),
      expect.objectContaining({ pageIndex: 1, state: "creating", sequence: 0 })
    ]);
    expect(store.listPendingOutboundReplies().map((reply) => reply.kind)).toEqual(["stream_finish", "card_update", "stream_card_create"]);
  });

  it("uses structural stream metadata when reading Answer delivery facts", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "card-1");
    store.enqueueOutboundReply({
      id: "page-1-content", idempotencyKey: "page-1-content", bindingId: "b1", promptId: "p1", viewVersion: 9, cardRole: "answer",
      rootMessageId: "card-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 1, elementId: "answer_content_p1_1", content: "wrong page", sequence: 9 })
    });
    store.database.prepare("UPDATE outbound_replies SET payload = ? WHERE id = 'page-1-content'").run(JSON.stringify({ pageIndex: 0, elementId: answerElementId("p1", 0), content: "payload disagrees", sequence: 9 }));

    expect(store.getAnswerPageDeliveryFacts("p1", 0).latestContent).toBeNull();
  });

  it("falls back to legacy Answer payload metadata only when structural metadata is absent", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "card-1");
    store.enqueueOutboundReply({ id: "legacy-content", idempotencyKey: "legacy-content", bindingId: "b1", promptId: "p1", viewVersion: 7, cardRole: "answer", rootMessageId: "card-1", kind: "stream_content", payload: JSON.stringify({ elementId: answerElementId("p1", 0), content: "legacy", sequence: 7, sourceEnd: 8 }) });
    store.enqueueOutboundReply({ id: "legacy-finish", idempotencyKey: "legacy-finish", bindingId: "b1", promptId: "p1", viewVersion: 8, cardRole: "answer", rootMessageId: "card-1", kind: "stream_finish", payload: JSON.stringify({ summary: "done", sequence: 8 }) });
    store.database.prepare("UPDATE outbound_replies SET stream_page_index = NULL, stream_element_id = NULL WHERE id IN ('legacy-content', 'legacy-finish')").run();

    expect(store.getAnswerPageDeliveryFacts("p1", 0)).toMatchObject({
      latestContent: { content: "legacy", sequence: 7, state: "pending", sourceEnd: 8 },
      finishPending: true
    });
    store.database.prepare("UPDATE outbound_replies SET payload = ? WHERE id = 'legacy-finish'").run(JSON.stringify({ pageIndex: null }));
    expect(store.getAnswerPageDeliveryFacts("p1", 0).finishPending).toBe(true);
    store.database.prepare("UPDATE outbound_replies SET payload = 'not-json' WHERE id = 'legacy-finish'").run();
    expect(store.getAnswerPageDeliveryFacts("p1", 0).finishPending).toBe(true);
  });

  it("reads Answer delivery facts without mixing unrelated retained history", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "card-1");

    store.enqueueOutboundReply({ id: "content-old", idempotencyKey: "content-old", bindingId: "b1", promptId: "p1", viewVersion: 10, cardRole: "answer", rootMessageId: "card-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: answerElementId("p1", 0), content: "old", sequence: 10, sourceEnd: 21 }) });
    store.database.prepare("UPDATE outbound_replies SET state = 'delivered' WHERE id = 'content-old'").run();
    store.enqueueOutboundReply({ id: "content-current", idempotencyKey: "content-current", bindingId: "b1", promptId: "p1", viewVersion: 11, cardRole: "answer", rootMessageId: "card-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: answerElementId("p1", 0), content: "current", sequence: 11, sourceEnd: 42 }) });
    store.database.prepare("UPDATE outbound_replies SET state = 'dismissed' WHERE id = 'content-current'").run();
    store.enqueueOutboundReply({ id: "finish-current", idempotencyKey: "finish-current", bindingId: "b1", promptId: "p1", viewVersion: 12, cardRole: "answer", rootMessageId: "card-1", kind: "stream_finish", payload: JSON.stringify({ pageIndex: 0, summary: "done", sequence: 12 }) });
    store.enqueueOutboundReply({ id: "continuation-current", idempotencyKey: "continuation-current", bindingId: "b1", promptId: "p1", viewVersion: 13, cardRole: "answer", rootMessageId: "root-1", kind: "stream_card_create", payload: JSON.stringify({ stream: { pageIndex: 1, pageStart: 9_000, elementId: answerElementId("p1", 1) }, card: {} }) });
    store.enqueueOutboundReply({ id: "final-exact", idempotencyKey: "answer-final-fold:p1:0:card-1", bindingId: "b1", promptId: "p1", viewVersion: 12, cardRole: "answer", rootMessageId: "card-1", kind: "card_update", payload: "{}" });
    store.database.prepare("UPDATE outbound_replies SET state = 'dead_letter' WHERE id = 'final-exact'").run();
    store.enqueueOutboundReply({ id: "final-current", idempotencyKey: "answer-final-fold:p1:0:card-1:revision:13", bindingId: "b1", promptId: "p1", viewVersion: 13, cardRole: "answer", rootMessageId: "card-1", kind: "card_update", payload: "{}" });
    store.database.prepare("UPDATE outbound_replies SET state = 'delivered' WHERE id = 'final-current'").run();

    for (let index = 0; index < 200; index += 1) {
      const kind = index % 3 === 0 ? "card_update" : index % 3 === 1 ? "stream_finish" : "stream_content";
      store.enqueueOutboundReply({
        id: `history-${index}`, idempotencyKey: `history-${index}`, bindingId: "b1", promptId: index % 2 === 0 ? "other-prompt" : "p1", viewVersion: 100 + index, cardRole: "answer", rootMessageId: "other-card", kind,
        payload: JSON.stringify({ pageIndex: 99, elementId: "other-element", content: `history-${index}`, sequence: 100 + index })
      });
      store.database.prepare("UPDATE outbound_replies SET state = ? WHERE id = ?").run((["pending", "delivered", "dead_letter", "dismissed"] as const)[index % 4], `history-${index}`);
    }

    expect(store.getAnswerPageDeliveryFacts("p1", 0)).toEqual({
      latestContent: { content: "current", sequence: 11, state: "dismissed", sourceEnd: 42 },
      finishPending: true,
      continuationPending: true,
      finalUpdateState: "delivered"
    });
  });

  it("uses the prompt-kind-state index for targeted Answer delivery facts queries", () => {
    store = new SqliteBindingStore(":memory:");
    const queries: Array<{ sql: string; parameters: Array<string | number> }> = [
      { sql: answerPageDeliveryFactsSql.latestContent, parameters: ["p1", 0, answerElementId("p1", 0), 0] },
      { sql: answerPageDeliveryFactsSql.pendingFinish, parameters: ["p1", 0, 0] },
      { sql: answerPageDeliveryFactsSql.pendingContinuation, parameters: ["p1", 1, 1] },
      { sql: answerPageDeliveryFactsSql.finalUpdate, parameters: ["p1", "answer-final-fold:p1:0:card-1", "answer-final-fold:p1:0:card-1:revision:", "answer-final-fold:p1:0:card-1:revision:"] }
    ];

    for (const query of queries) {
      const plan = store.database.prepare(`EXPLAIN QUERY PLAN ${query.sql}`).all(...query.parameters) as Array<{ detail: string }>;
      expect(plan.some(({ detail }) => detail.includes("outbound_replies_prompt_kind_state_updated"))).toBe(true);
      expect(plan.some(({ detail }) => detail.startsWith("SCAN outbound_replies"))).toBe(false);
    }
  });

  it("rolls back an Answer reservation when its outbox insert fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "card-1");
    store.database.exec("CREATE TEMP TRIGGER reject_answer_content BEFORE INSERT ON outbound_replies WHEN NEW.kind = 'stream_content' BEGIN SELECT RAISE(ABORT, 'forced_answer_outbox_failure'); END");

    expect(() => store!.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-1", elementId: answerElementId("p1", 0), content: "new" })).toThrow("forced_answer_outbox_failure");

    expect(store.getActiveAnswerPage("p1")?.sequence).toBe(0);
    expect(store.loadRunCard("p1")?.answerSequence).toBe(0);
    expect(store.listPendingOutboundReplies()).toEqual([]);
  });

  it("recovers only queued answer cards dead-lettered by the legacy element id format", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "legacy-id", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({
      prompt: { id: "legacy-id", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" },
      view: { ...view, answerElementId: "answer_content_legacy_identifier_that_is_too_long_0" }, rootMessageId: "m1",
      answerCard: { schema: "2.0", body: { elements: [{ tag: "markdown", element_id: "answer_content_legacy_identifier_that_is_too_long_0", content: "waiting" }] } }
    });
    const [legacyReply] = store.listPendingOutboundReplies();
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed(legacyReply!.id, "ElementID answer_content_legacy_identifier_that_is_too_long_0: Code 1002: elementID format error");

    store.enqueueOutboundReply({ id: "unrelated", idempotencyKey: "unrelated", bindingId: "b1", rootMessageId: "m1", kind: "text", payload: "hello" });
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("unrelated", "network unavailable");

    expect(store.recoverLegacyElementIdDeadLetters()).toBe(1);
    const [recovered] = store.listPendingOutboundReplies();
    expect(recovered).toMatchObject({ id: legacyReply!.id, state: "pending", attemptCount: 0, error: null });
    expect(store.loadRunCard("legacy-id")?.answerElementId).toBe(answerElementId("legacy-id", 0));
    expect(JSON.parse(recovered!.payload)).toMatchObject({ body: { elements: [{ element_id: answerElementId("legacy-id", 0) }] } });
    expect(store.getOperationalSummary().deadLetters).toBe(1);
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("legacy-id");

    store.markOutboundReplyDelivered(legacyReply!.id, "answer-1", "cardkit-1");
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
  });

  it("canonicalizes pending continuation metadata with its card payload", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "m1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "card-1");
    const legacyId = "answer_content_legacy_identifier_that_is_too_long_1";
    store.database.exec("UPDATE answer_pages SET state = 'frozen' WHERE prompt_id = 'p1'");
    store.database.prepare("INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES ('p1', 1, NULL, NULL, ?, 20000, 0, 'creating', 'streaming', 'now', 'now')").run(legacyId);
    store.database.prepare("UPDATE run_cards SET answer_element_id = ?, answer_page_index = 1, answer_page_start = 20000 WHERE prompt_id = 'p1'").run(legacyId);
    store.enqueueOutboundReply({ id: "page-2", idempotencyKey: "stream-card:p1:1", bindingId: "b1", promptId: "p1", viewVersion: 2, cardRole: "answer", rootMessageId: "m1", kind: "stream_card_create", payload: JSON.stringify({ card: { body: { elements: [{ element_id: legacyId }] } }, stream: { pageIndex: 1, pageStart: 20_000, elementId: legacyId } }) });

    expect(store.recoverLegacyElementIdDeadLetters()).toBe(0);

    const repaired = store.listPendingOutboundReplies().find((reply) => reply.id === "page-2")!;
    const payload = JSON.parse(repaired.payload);
    expect(store.loadRunCard("p1")?.answerElementId).toBe(answerElementId("p1", 1));
    expect(payload.stream.elementId).toBe(store.loadRunCard("p1")?.answerElementId);
    expect(payload.card.body.elements[0].element_id).toBe(payload.stream.elementId);
  });

  it("finds pending Answer continuations from normalized metadata instead of reparsing payloads", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.enqueueOutboundReply({ id: "continuation", idempotencyKey: "continuation", bindingId: "b1", promptId: "p1", rootMessageId: "root-1", kind: "stream_card_create", payload: JSON.stringify({ stream: { pageIndex: 2, pageStart: 9_000, elementId: answerElementId("p1", 2) }, card: {} }) });
    store.database.prepare("UPDATE outbound_replies SET payload = json_set(payload, '$.stream.pageIndex', 99) WHERE id = 'continuation'").run();

    expect(store.hasPendingAnswerContinuation("p1", 2)).toBe(true);
    expect(store.hasPendingAnswerContinuation("p1", 99)).toBe(false);
    const plan = store.database.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM outbound_replies WHERE prompt_id = ? AND kind = 'stream_card_create' AND state = 'pending' AND stream_page_index = ? LIMIT 1").all("p1", 2) as Array<{ detail: string }>;
    expect(plan.some(({ detail }) => detail.includes("outbound_replies_prompt_kind_state_updated"))).toBe(true);
  });

  it("canonicalizes persisted answer targets before startup outbox draining", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-element-id-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "m1", answerCard: {} });
    const legacyId = "answer_content_legacy_identifier_that_is_too_long_0";
    store.database.prepare("UPDATE run_cards SET answer_element_id = ? WHERE prompt_id = 'p1'").run(legacyId);
    store.database.prepare("UPDATE outbound_replies SET payload = ? WHERE prompt_id = 'p1'").run(JSON.stringify({ body: { elements: [{ element_id: legacyId }] } }));
    store.database.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
    store.close();

    store = new SqliteBindingStore(path);

    expect(store.loadRunCard("p1")?.answerElementId).toBe(answerElementId("p1", 0));
    expect(JSON.parse(store.listPendingOutboundReplies()[0]!.payload)).toMatchObject({ body: { elements: [{ element_id: answerElementId("p1", 0) }] } });
  });

  it("does not rewrite or replay a claimed legacy Answer payload during startup canonicalization", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "claimed-legacy", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "claimed-legacy", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "m1", answerCard: {} });
    const reply = store.listPendingOutboundReplies()[0]!;
    const legacyId = "answer_content_legacy_identifier_that_is_too_long_0";
    const legacyPayload = JSON.stringify({ body: { elements: [{ element_id: legacyId }] } });
    store.database.prepare("UPDATE run_cards SET answer_element_id = ? WHERE prompt_id = 'claimed-legacy'").run(legacyId);
    store.database.prepare("UPDATE outbound_replies SET payload = ?, intent_json = NULL WHERE id = ?").run(legacyPayload, reply.id);
    const claim = store.claimOutboundReply(reply.id, null)!;
    store.markOutboundReplyFailedWithQuarantine(claim, "retry later", { failureClass: "transient", httpStatus: 503, larkErrorCode: null });

    expect(() => store!.recoverLegacyElementIdDeadLetters()).not.toThrow();
    expect(store.loadRunCard("claimed-legacy")?.answerElementId).toBe(answerElementId("claimed-legacy", 0));
    expect(store.getOutboundReply(reply.id)).toMatchObject({ state: "pending", payload: legacyPayload });
    expect(store.database.prepare("SELECT first_claimed_at FROM outbound_replies WHERE id = ?").get(reply.id)).toMatchObject({ first_claimed_at: expect.any(String) });
  });

  it("repairs answer payloads when the persisted run-card id is already canonical", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-element-payload-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "m1", answerCard: {} });
    const canonicalId = store.loadRunCard("p1")!.answerElementId;
    const legacyId = "answer_content_legacy_identifier_that_is_too_long_0";
    store.database.prepare("UPDATE outbound_replies SET payload = ? WHERE prompt_id = 'p1'").run(JSON.stringify({ body: { elements: [{ element_id: legacyId }] }, stream: { pageIndex: 0, pageStart: 0, elementId: legacyId } }));
    store.enqueueOutboundReply({ id: "unrelated", idempotencyKey: "unrelated", rootMessageId: "m1", kind: "text", payload: legacyId });
    store.database.prepare("DELETE FROM schema_migrations WHERE version = 2").run();
    store.close();

    store = new SqliteBindingStore(path);
    const payload = JSON.parse(store.listPendingOutboundReplies()[0]!.payload);
    expect(store.loadRunCard("p1")?.answerElementId).toBe(canonicalId);
    expect(payload.body.elements[0].element_id).toBe(canonicalId);
    expect(payload.stream.elementId).toBe(canonicalId);
    expect(store.listPendingOutboundReplies().find((reply) => reply.id === "unrelated")?.payload).toBe(legacyId);
  });

  it("uses the prompt-oriented index for Answer payload migration lookups", () => {
    store = new SqliteBindingStore(":memory:");
    const plan = store.database.prepare("EXPLAIN QUERY PLAN SELECT id, kind, payload FROM outbound_replies INDEXED BY outbound_replies_prompt_role_state WHERE prompt_id = ? AND card_role = 'answer' AND state IN ('pending','dead_letter')").all("p1") as Array<{ detail: string }>;
    expect(plan.map((row) => row.detail).join(" ")).toContain("outbound_replies_prompt_role_state");
  });

  it("uses a binding status index when checking whether a Main Card version is already reserved", () => {
    store = new SqliteBindingStore(":memory:");

    const columns = store.database.prepare("PRAGMA index_info(outbound_replies_binding_target_version)").all() as Array<{ name: string }>;
    const plan = store.database.prepare("EXPLAIN QUERY PLAN SELECT 1 FROM outbound_replies WHERE binding_id = ? AND target_role = 'session_status' AND view_version >= ? LIMIT 1").all("b1", 1) as Array<{ detail: string }>;

    expect(columns.map((column) => column.name)).toEqual(["binding_id", "target_role", "view_version"]);
    expect(plan.map((row) => row.detail).join(" ")).toContain("outbound_replies_binding_target_version");
  });

  it("uses a prompt delivery index for operational latency summaries", () => {
    store = new SqliteBindingStore(":memory:");

    const columns = store.database.prepare("PRAGMA index_info(outbound_replies_prompt_kind_state_updated)").all() as Array<{ name: string }>;
    const plan = store.database.prepare("EXPLAIN QUERY PLAN SELECT MIN(updated_at) FROM outbound_replies WHERE prompt_id = ? AND kind = 'stream_finish' AND state = 'delivered' AND updated_at >= ?").all("p1", "2026-08-29T00:00:00.000Z") as Array<{ detail: string }>;

    expect(columns.map((column) => column.name)).toEqual(["prompt_id", "kind", "state", "updated_at"]);
    expect(plan.map((row) => row.detail).join(" " )).toContain("outbound_replies_prompt_kind_state_updated");
  });

  it("uses ordered retention indexes for bounded history pruning", () => {
    store = new SqliteBindingStore(":memory:");

    const outboundColumns = store.database.prepare("PRAGMA index_info(outbound_replies_retention)").all() as Array<{ name: string }>;
    const inboundColumns = store.database.prepare("PRAGMA index_info(inbound_messages_retention)").all() as Array<{ name: string }>;
    const outboundPlan = store.database.prepare("EXPLAIN QUERY PLAN SELECT id FROM outbound_replies WHERE state IN ('delivered', 'dismissed') AND updated_at < ? ORDER BY updated_at, delivery_order LIMIT ?").all("2026-08-12T00:00:00.000Z", 100) as Array<{ detail: string }>;
    const inboundPlan = store.database.prepare("EXPLAIN QUERY PLAN SELECT event_id FROM inbound_messages WHERE state = 'accepted' AND updated_at < ? ORDER BY updated_at, event_id LIMIT ?").all("2026-08-12T00:00:00.000Z", 100) as Array<{ detail: string }>;

    expect(outboundColumns.map((column) => column.name)).toEqual(["state", "updated_at", "delivery_order"]);
    expect(inboundColumns.map((column) => column.name)).toEqual(["state", "updated_at", "event_id"]);
    expect(outboundPlan.map((row) => row.detail).join(" " )).toContain("outbound_replies_retention");
    expect(inboundPlan.map((row) => row.detail).join(" " )).toContain("inbound_messages_retention");
  });

  it("creates the prompt priority queue index with the exact column order", () => {
    store = new SqliteBindingStore(":memory:");

    const columns = store.database.prepare("PRAGMA index_info(prompt_jobs_priority_queue)").all() as Array<{ name: string }>;

    expect(columns.map((column) => column.name)).toEqual(["binding_id", "state", "priority", "created_at"]);
  });

  it("repairs a missing prompt priority queue index without changing schema on later reopens", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-prompt-queue-index-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.database.exec("DROP INDEX IF EXISTS prompt_jobs_priority_queue");
    store.close();

    store = new SqliteBindingStore(path);
    const repaired = store.database.prepare("PRAGMA index_info(prompt_jobs_priority_queue)").all() as Array<{ name: string }>;
    expect(repaired.map((column) => column.name)).toEqual(["binding_id", "state", "priority", "created_at"]);
    store.close();

    store = new SqliteBindingStore(path);
    const before = store.database.prepare("PRAGMA schema_version").get() as { schema_version: number };
    store.close();
    store = new SqliteBindingStore(path);
    const after = store.database.prepare("PRAGMA schema_version").get() as { schema_version: number };
    expect(after.schema_version).toBe(before.schema_version);
  });

  it("uses the priority queue index for prompt hot paths under mixed queue load", () => {
    store = new SqliteBindingStore(":memory:");
    for (let bindingIndex = 0; bindingIndex < 4; bindingIndex += 1) {
      const bindingId = `queue-plan-${bindingIndex}`;
      store.createPendingBinding({ id: bindingId, workspaceId: `w${bindingIndex}`, chatId: "c1", topicId: `t${bindingIndex}`, rootMessageId: `root-${bindingIndex}`, title: bindingId });
      store.updateBinding(bindingId, { state: "active", lifecycle: "active", attachment: "attached", paneId: `w${bindingIndex}:p1`, lastAgentState: "idle" });
    }
    const insertPrompt = store.database.prepare(`
      INSERT INTO prompt_jobs(id, binding_id, lark_message_id, actor_open_id, body, priority, was_detached, state, observation_state, attempt_count, error, created_at, updated_at)
      VALUES (?, ?, ?, 'u1', 'fixture', ?, 0, ?, 'not_started', 0, NULL, ?, ?)
    `);
    const insertRunCard = store.database.prepare(`
      INSERT INTO run_cards(prompt_id, binding_id, answer_message_id, answer_card_id, phase, title, workspace_id, pane_id, answer, progress_events_json, queue_position, activity_at, view_version, delivered_version, created_at, updated_at)
      VALUES (?, ?, ?, ?, ?, 'fixture', ?, ?, '', '[]', 1, ?, 1, 0, ?, ?)
    `);
    store.database.exec("BEGIN");
    for (let index = 0; index < 1_600; index += 1) {
      const bindingIndex = index % 4;
      const bindingId = `queue-plan-${bindingIndex}`;
      const promptId = `queue-plan-prompt-${index}`;
      const priority = Math.floor(index / 4) % 2 === 0 ? "normal" : "priority";
      const state = Math.floor(index / 8) % 20 < 2 ? "queued" : "delivered";
      const timestamp = `2026-08-29T00:${String(Math.floor(index / 60) % 60).padStart(2, "0")}:${String(index % 60).padStart(2, "0")}.${String(index).padStart(4, "0")}Z`;
      insertPrompt.run(promptId, bindingId, `queue-plan-message-${index}`, priority, state, timestamp, timestamp);
      insertRunCard.run(promptId, bindingId, `answer-${index}`, `card-${index}`, state === "queued" ? "queued" : "completed", `w${bindingIndex}`, `w${bindingIndex}:p1`, timestamp, timestamp, timestamp);
    }
    store.database.exec("COMMIT; ANALYZE");

    const explain = (sql: string, ...parameters: string[]) => (store!.database.prepare(`EXPLAIN QUERY PLAN ${sql}`).all(...parameters) as Array<{ detail: string }>)
      .map((row) => row.detail.toLowerCase().replace(/\s+/g, " "));
    const expectQueueKindSearch = (details: string[]) => {
      expect(details.some((detail) => detail.includes("prompt_jobs_priority_queue")
        && detail.includes("binding_id=?")
        && detail.includes("state=?") && detail.includes("priority=?")), details.join(" | " )).toBe(true);
    };

    expectQueueKindSearch(explain(
      "SELECT id FROM prompt_jobs WHERE binding_id = ? AND state = 'queued' AND priority = 'normal' ORDER BY created_at, rowid",
      "queue-plan-0"
    ));
    expectQueueKindSearch(explain(`
      SELECT p.* FROM prompt_jobs p JOIN run_cards c ON c.prompt_id = p.id
      WHERE p.binding_id = ? AND p.state = 'queued' AND p.priority = 'normal'
        AND c.answer_message_id IS NOT NULL AND (c.answer_card_id IS NOT NULL OR c.lark_message_id IS NOT NULL)
        AND NOT EXISTS (SELECT 1 FROM prompt_jobs active WHERE active.binding_id = p.binding_id AND active.state = 'running')
        AND NOT EXISTS (SELECT 1 FROM pane_control_operations control WHERE control.binding_id = p.binding_id AND control.kind = 'model' AND control.state IN ('accepted','running','applied'))
      ORDER BY p.created_at, p.rowid LIMIT 1
    `, "queue-plan-0"));
    expectQueueKindSearch(explain(`
      SELECT DISTINCT p.binding_id FROM prompt_jobs p JOIN bindings b ON b.id = p.binding_id
      WHERE p.state = 'queued' AND p.priority = 'normal'
        AND b.state = 'active' AND b.lifecycle = 'active' AND b.attachment = 'attached' AND b.pane_id IS NOT NULL
        AND NOT EXISTS (SELECT 1 FROM prompt_jobs active WHERE active.binding_id = p.binding_id AND active.state = 'running')
      ORDER BY p.binding_id
    `));
  });

  it("does not change the SQLite schema version on a no-op reopen", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-schema-idempotency-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.close();
    store = new SqliteBindingStore(path);
    const before = store.database.prepare("PRAGMA schema_version").get() as { schema_version: number };
    store.close();
    store = new SqliteBindingStore(path);
    const after = store.database.prepare("PRAGMA schema_version").get() as { schema_version: number };
    expect(after.schema_version).toBe(before.schema_version);
  });

  it("removes obsolete bridge-reported session columns without losing bindings", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-session-column-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.database.exec("ALTER TABLE bindings ADD COLUMN reported_traex_session_id TEXT");
    store.database.exec("ALTER TABLE bindings ADD COLUMN reported_traex_session_at TEXT");
    store.database.prepare("UPDATE bindings SET reported_traex_session_id = ?, reported_traex_session_at = ? WHERE id = ?").run("legacy-session", "2026-08-27T12:00:00.000Z", "b1");
    store.close();

    store = new SqliteBindingStore(path);
    const names = (store.database.prepare("PRAGMA table_info(bindings)").all() as Array<{ name: string }>).map(({ name }) => name);
    expect(names).not.toContain("reported_traex_session_id");
    expect(names).not.toContain("reported_traex_session_at");
    expect(store.getBinding("b1")).toMatchObject({ id: "b1", title: "Task" });
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("atomically persists a Main Card view with one versioned delivery intent", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = { ...initialTopicView("b1"), title: "Visible", viewVersion: 1 };

    expect(store.reserveMainCard(view, "root-1", { version: 1 })).toBe("reserved");
    expect(store.reserveMainCard(view, "root-1", { version: 1 })).toBe("waiting");
    expect(store.loadTopicView("b1")).toMatchObject({ title: "Visible", viewVersion: 1, deliveredVersion: 0 });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({ kind: "card_reply", bindingId: "b1", viewVersion: 1, targetRole: "session_status" })]);
  });

  it("replaces an unclaimed history Main Card snapshot with the latest live snapshot", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "main-1" });

    expect(store.reserveMainCard({ ...initialTopicView("b1"), title: "History", viewVersion: 1 }, "root-1", { version: 1 }, "history")).toBe("reserved");
    expect(store.reserveMainCard({ ...initialTopicView("b1"), title: "Live", viewVersion: 2 }, "root-1", { version: 2 }, "live")).toBe("reserved");

    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({
      targetRole: "session_status", workClass: "live", viewVersion: 2, cardSequence: 1, payload: JSON.stringify({ version: 2 })
    })]);
  });

  it("keeps a claimed Main Card snapshot and coalesces its successors to one contiguous sequence", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "main-1" });
    expect(store.reserveMainCard({ ...initialTopicView("b1"), title: "First", viewVersion: 1 }, "root-1", { version: 1 })).toBe("reserved");
    const first = store.listPendingOutboundReplies()[0]!;
    expect(store.claimOutboundReply(first.id, null)).not.toBeNull();

    expect(store.reserveMainCard({ ...initialTopicView("b1"), title: "Second", viewVersion: 2 }, "root-1", { version: 2 })).toBe("reserved");
    expect(store.reserveMainCard({ ...initialTopicView("b1"), title: "Latest", viewVersion: 3 }, "root-1", { version: 3 })).toBe("reserved");

    expect(store.listPendingOutboundReplies()).toEqual([
      expect.objectContaining({ id: first.id, viewVersion: 1, cardSequence: 1 }),
      expect.objectContaining({ viewVersion: 3, cardSequence: 2, payload: JSON.stringify({ version: 3 }) })
    ]);
  });

  it("rolls back a Main Card projection when its outbox reservation fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.database.exec("CREATE TEMP TRIGGER reject_main_card BEFORE INSERT ON outbound_replies WHEN NEW.target_role = 'session_status' BEGIN SELECT RAISE(ABORT, 'forced_main_card_failure'); END");

    expect(() => store!.reserveMainCard({ ...initialTopicView("b1"), title: "Never committed", viewVersion: 1 }, "root-1", {})).toThrow("forced_main_card_failure");

    expect(store.loadTopicView("b1")).toBeNull();
    expect(store.listPendingOutboundReplies()).toEqual([]);
  });

  it("rolls back the canonical Main projection when a Pane Entry reservation fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", statusMessageId: "main-1", state: "active", lifecycle: "active", attachment: "attached" });
    store.reservePaneThreadAlias({ publicationKey: "pane-entry-1", actionMessageId: "directory", bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", sourceMainMessageId: "main-1", targetChatId: "c1", viewVersion: 0, card: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "alias-root", undefined, "alias-topic");
    store.database.exec("CREATE TEMP TRIGGER reject_pane_entry BEFORE INSERT ON outbound_replies WHEN NEW.lane_key LIKE '%:pane-entry:%' BEGIN SELECT RAISE(ABORT, 'forced_pane_entry_failure'); END");
    const view = { ...initialTopicView("b1"), title: "Never committed", viewVersion: 2 };

    expect(() => store!.reserveMainCard(view, "root-1", { main: 2 }, undefined, { entry: 2 })).toThrow("forced_pane_entry_failure");

    expect(store.loadTopicView("b1")).toBeNull();
    expect(store.listPendingOutboundReplies()).toEqual([]);
  });

  it("isolates an uncertain Pane Entry update from the canonical Main lane", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", statusMessageId: "main-1", state: "active", lifecycle: "active", attachment: "attached" });
    store.reservePaneThreadAlias({ publicationKey: "pane-entry-1", actionMessageId: "directory", bindingId: "b1", bindingGeneration: 1, paneId: "w1:p1", sourceMainMessageId: "main-1", targetChatId: "c1", viewVersion: 0, card: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "alias-root", undefined, "alias-topic");
    store.reserveMainCard({ ...initialTopicView("b1"), viewVersion: 2 }, "root-1", { main: 2 }, undefined, { entry: 2 });
    const pending = store.listPendingOutboundReplies();
    const alias = pending.find((reply) => reply.rootMessageId === "alias-root")!;
    const canonical = pending.find((reply) => reply.rootMessageId === "main-1")!;

    store.markOutboundReplyFailedWithQuarantine(alias.id, "unknown outcome", { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: null, larkErrorCode: null });

    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toContain(canonical.id);
    expect(store.database.prepare("SELECT state FROM outbox_lane_quarantines WHERE failed_reply_id = ?").get(alias.id)).toEqual({ state: "active" });
  });

  it("does not recreate or wake a dead-lettered Main Card version", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = { ...initialTopicView("b1"), title: "Visible", viewVersion: 1 };
    expect(store.reserveMainCard(view, "root-1", { version: 1 })).toBe("reserved");
    const [reply] = store.listPendingOutboundReplies();
    store.markOutboundReplyDeadLetter(reply!.id, "permanent failure", { failureClass: "permanent" });

    expect(store.reserveMainCard(view, "root-1", { version: 1 })).toBe("waiting");
    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.getOutboundReply(reply!.id)).toMatchObject({ state: "dead_letter", attemptCount: 1 });
  });

  it("normalizes legacy Main Card versions and checkpoints delivery monotonically", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const legacy = initialTopicView("b1") as Partial<ReturnType<typeof initialTopicView>>;
    delete legacy.worktreeName; delete legacy.recentProgress; delete legacy.liveStatus; delete legacy.viewVersion; delete legacy.deliveredVersion;
    store.database.prepare("INSERT INTO topic_views(binding_id, state_json, updated_at) VALUES (?, ?, ?)").run("b1", JSON.stringify(legacy), "now");
    const normalized = store.loadTopicView("b1")!;
    expect(normalized).toMatchObject({ worktreeName: null, recentProgress: [], liveStatus: null, viewVersion: 1, deliveredVersion: 0 });
    expect(store.reserveMainCard(normalized, "root-1", { version: 1 })).toBe("reserved");
    const [reply] = store.listPendingOutboundReplies();

    store.markOutboundReplyDelivered(reply!.id, "main-card-1");
    store.markOutboundReplyDelivered(reply!.id, "main-card-1");

    expect(store.getBinding("b1")?.statusMessageId).toBe("main-card-1");
    expect(store.loadTopicView("b1")).toMatchObject({ viewVersion: 1, deliveredVersion: 1 });
  });

  it("does not move a delivered outbox row back into failure handling", () => {
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "delivered", idempotencyKey: "delivered", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    store.markOutboundReplyDelivered("delivered", "message-1");

    expect(store.markOutboundReplyFailed("delivered", "late callback")).toBeNull();
    expect(store.markOutboundReplyDeadLetter("delivered", "late callback", { failureClass: "permanent" })).toBeNull();
    expect(store.markOutboundReplyFailedWithQuarantine("delivered", "late callback", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null })).toBeNull();
    expect(store.getOutboundReply("delivered")).toMatchObject({ state: "delivered", attemptCount: 1, error: null });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbox_lane_quarantines").get()).toEqual({ count: 0 });
  });

  it("marks legacy terminal Answer pages finished before startup convergence", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-answer-finish-migration-"));
    const databasePath = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(databasePath);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "First", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "m1", answerCard: {} });
    const [create] = store.listPendingOutboundReplies();
    store.markOutboundReplyDelivered(create!.id, "answer-1", "card-1");
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: "done", answerSegments: ["done"] });
    store.enqueueOutboundReply({ id: "legacy-finish", idempotencyKey: "legacy-finish", bindingId: "b1", promptId: "p1", viewVersion: 7, cardRole: "answer", rootMessageId: "card-1", kind: "stream_finish", payload: JSON.stringify({ summary: "Completed", sequence: 7 }) });
    store.markOutboundReplyDelivered("legacy-finish", "card-1");
    store.database.prepare("UPDATE answer_pages SET state = 'active' WHERE prompt_id = 'p1' AND page_index = 0").run();
    store.enqueueOutboundReply({ id: "late-content", idempotencyKey: "late-content", bindingId: "b1", promptId: "p1", viewVersion: 8, cardRole: "answer", rootMessageId: "card-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: answerElementId("p1", 0), content: "done", sequence: 8 }) });
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("late-content", "legacy page rejected");
    store.database.prepare("DELETE FROM schema_migrations WHERE version = 3").run();
    store.close();

    store = new SqliteBindingStore(databasePath);

    expect(store.listAnswerPages("p1")).toEqual([expect.objectContaining({ pageIndex: 0, state: "finished", sequence: 7 })]);
    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id = 'late-content'").get()).toEqual({ state: "dismissed" });
  });

  it("dismisses superseded Answer dead letters when upgrading a database that already applied migration 3", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-answer-dead-letter-migration-"));
    const databasePath = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(databasePath);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "First", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "m1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "card-1");
    store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id = 'p1' AND page_index = 0").run();
    store.enqueueOutboundReply({ id: "late-content", idempotencyKey: "late-content", bindingId: "b1", promptId: "p1", viewVersion: 8, cardRole: "answer", rootMessageId: "card-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: answerElementId("p1", 0), content: "done", sequence: 8 }) });
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("late-content", "legacy page rejected");
    store.database.prepare("DELETE FROM schema_migrations WHERE version = 4").run();
    store.close();

    store = new SqliteBindingStore(databasePath);

    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id = 'late-content'").get()).toEqual({ state: "dismissed" });
    expect(store.database.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 4").get()).toEqual({ applied: 1 });
  });

  it("does not let a late continuation delivery roll the active page backward", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "m1", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "card-1");
    store.enqueueOutboundReply({ id: "page-2", idempotencyKey: "stream-card:p1:1", bindingId: "b1", promptId: "p1", viewVersion: 2, cardRole: "answer", rootMessageId: "m1", kind: "stream_card_create", payload: JSON.stringify({ card: {}, stream: { pageIndex: 1, pageStart: 20_000, elementId: answerElementId("p1", 1) } }) });
    store.database.exec("UPDATE answer_pages SET state = 'frozen' WHERE prompt_id = 'p1'; INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES ('p1', 2, 'answer-3', 'card-3', 'answer_content_p1_2', 40000, 0, 'active', 'streaming', 'now', 'now'); UPDATE run_cards SET answer_message_id = 'answer-3', answer_card_id = 'card-3', answer_element_id = 'answer_content_p1_2', answer_page_index = 2, answer_page_start = 40000 WHERE prompt_id = 'p1';");

    store.markOutboundReplyDelivered("page-2", "late-answer-2", "late-card-2");

    expect(store.loadRunCard("p1")).toMatchObject({ answerMessageId: "answer-3", answerCardId: "card-3", answerElementId: answerElementId("p1", 2), answerPageIndex: 2, answerPageStart: 40_000 });
    expect(store.listAnswerPages("p1")).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "frozen", cardId: "card-1" }),
      expect.objectContaining({ pageIndex: 1, state: "frozen", cardId: null }),
      expect.objectContaining({ pageIndex: 2, state: "active", cardId: "card-3" })
    ]);
    expect(store.listPendingOutboundReplies()).toEqual([]);
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
      ALTER TABLE run_cards DROP COLUMN conversion_parent_prompt_id;
      ALTER TABLE run_cards DROP COLUMN binding_generation;
    `);
    legacy.close();

    store = new SqliteBindingStore(path);
    expect(store.loadRunCard("p1")).toMatchObject({
      bindingGeneration: 1, conversionParentPromptId: null, requestText: "legacy **request**", answer: "legacy answer", answerSegments: ["legacy answer"], answerDraft: "", answerDraftTransient: false
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
      DROP TABLE answer_recovery_candidates;
      DROP TABLE answer_recovery_links;
      DROP TABLE answer_delivery_coverage;
      DELETE FROM schema_migrations WHERE version = 32;
      DROP TABLE outbound_replies;
      CREATE TABLE outbound_replies(
        id TEXT PRIMARY KEY, idempotency_key TEXT UNIQUE NOT NULL, binding_id TEXT, root_message_id TEXT NOT NULL, kind TEXT NOT NULL, payload TEXT NOT NULL,
        state TEXT NOT NULL CHECK(state IN ('pending','delivered','dead_letter')), attempt_count INTEGER NOT NULL DEFAULT 0, error TEXT, delivered_message_id TEXT,
        next_attempt_at TEXT NOT NULL, created_at TEXT NOT NULL, updated_at TEXT NOT NULL, prompt_id TEXT, view_version INTEGER, selection_id TEXT, card_role TEXT
      );
      INSERT INTO outbound_replies VALUES ('o1','startup-lite:legacy',NULL,'root','card_reply','{}','dead_letter',5,'failed',NULL,'now','now','now',NULL,NULL,NULL,NULL);
    `);
    database.close();

    store = new SqliteBindingStore(path);
    expect(store.getOperationalSummary().outbound).toMatchObject({ dead_letter: 1, dismissed: 0 });
    expect(store.database.prepare("SELECT delivery_order, lane_key FROM outbound_replies WHERE id = 'o1'").get()).toEqual({ delivery_order: 1, lane_key: "gateway:feishu:primary:reply:o1" });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 32").get()).toEqual({ version: 32 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 33").get()).toEqual({ version: 33 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 34").get()).toEqual({ version: 34 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 35").get()).toEqual({ version: 35 });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 36").get()).toEqual({ version: 36 });
    expect(store.database.prepare("SELECT work_class FROM outbound_replies WHERE id = 'o1'").get()).toEqual({ work_class: "history" });
    expect(store.database.prepare("SELECT target_chat_id, thread_alias_id, worker_thread_id FROM outbound_replies WHERE id = 'o1'").get()).toEqual({ target_chat_id: null, thread_alias_id: null, worker_thread_id: null });
    expect(store.database.prepare("SELECT name FROM sqlite_master WHERE type = 'trigger' AND name = 'answer_delivery_coverage_before_claim'").get()).toEqual({ name: "answer_delivery_coverage_before_claim" });
    expect(store.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
    store.enqueueOutboundReply({ id: "o2", idempotencyKey: "key-2", rootMessageId: "root-2", kind: "card_reply", payload: "{}" });
    expect(store.database.prepare("SELECT delivery_order, lane_key FROM outbound_replies WHERE id = 'o2'").get()).toEqual({ delivery_order: 2, lane_key: "gateway:feishu:primary:reply:o2" });
    expect(store.getOutboundReply("o2")).toMatchObject({ workClass: "live" });
  });

  it("adds streaming run-card columns before rebuilding a legacy outbox", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-streaming-migration-order-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.close();
    store = undefined;

    const database = new DatabaseSync(path);
    database.exec(`
      DROP TABLE answer_recovery_candidates;
      DROP TABLE answer_recovery_links;
      DROP TABLE answer_delivery_coverage;
      DELETE FROM schema_migrations WHERE version = 32;
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
    expect(store!.database.prepare("SELECT version FROM schema_migrations WHERE version = 32").get()).toEqual({ version: 32 });
    expect(store!.database.prepare("PRAGMA foreign_key_check").all()).toEqual([]);
  });

  it("does not duplicate the single answer-card create operation", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Legacy", workspaceId: "w1", paneId: "w1:p1", requestText: "legacy", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "legacy" }, view, rootMessageId: "root-1", taskCard: {}, answerCard: {} });
    store.ensureAnswerCard("p1", "root-1", { card: "answer" });
    store.ensureAnswerCard("p1", "root-1", { card: "duplicate" });

    expect(store.listPendingOutboundReplies()).toMatchObject([{
      promptId: "p1", cardRole: "answer", kind: "stream_card_create", payload: JSON.stringify({})
    }]);
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("p1");
    const answerCreate = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(answerCreate.id, "answer-card", "cardkit-1");
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
  });

  it("selects bounded durable lane heads without letting later rows bypass backoff", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    for (let index = 0; index < 8; index += 1) {
      store.enqueueOutboundReply({ id: `head-${index}`, idempotencyKey: `head-${index}`, rootMessageId: `card-${index}`, kind: "card_update", payload: "{}" });
    }
    store.enqueueOutboundReply({ id: "same-lane-later", idempotencyKey: "same-lane-later", rootMessageId: "card-0", kind: "card_update", payload: "{}" });
    store.markOutboundReplyFailed("head-0", "temporary", 60_000);

    expect(store.listOutboundLaneHeads(4, new Date().toISOString()).map((reply) => reply.id)).toEqual(["head-1", "head-2", "head-3", "head-4"]);
    expect(store.listOutboundLaneHeads(4, null).map((reply) => reply.id)).toEqual(["head-0", "head-1", "head-2", "head-3"]);
    expect(store.listOutboundLaneHeads(4, null, ["gateway:feishu:primary:message:card-0"]).map((reply) => reply.id)).toEqual(["head-1", "head-2", "head-3", "head-4"]);
    vi.setSystemTime(new Date("2026-08-24T00:00:10.500Z"));
    expect(store.getOperationalSummary().outboxLanes).toEqual({
      pending: 8, eligible: 7, blocked: 1,
      nextAttemptAt: "2026-08-24T00:01:00.000Z",
      oldestHeadAt: "2026-08-24T00:00:00.000Z", oldestHeadAgeSeconds: 10,
      stalled: 0, oldestStalledAgeSeconds: null
    });
    expect(store.getNextOutboundLaneHeadAttemptAt()).toBe(store.listPendingOutboundReplies()[1]!.nextAttemptAt);
    expect(store.listOutboundLaneHeads(4, null, [], "history")).toEqual([]);
    store.enqueueOutboundReply({ id: "history", idempotencyKey: "history", workClass: "history", rootMessageId: "history-card", kind: "card_update", payload: "{}" });
    expect(store.listOutboundLaneHeads(4, null, [], "history").map((reply) => reply.id)).toEqual(["history"]);
    expect(store.listOutboundLaneHeads(4, null, [], "live").map((reply) => reply.id)).toEqual(["head-0", "head-1", "head-2", "head-3"]);
    vi.useRealTimers();
  });

  it("drives work-class lane selection from the bounded lane-head index", () => {
    store = new SqliteBindingStore(":memory:");
    const plan = store.database.prepare(`EXPLAIN QUERY PLAN ${outboundLaneHeadSelectionSql({
      excludedLaneCount: 0, dueAt: true, workClass: true
    })}`).all("2026-08-24T00:00:00.000Z", "live", 1) as Array<{ detail: string }>;

    expect(plan.map(({ detail }) => detail)).toEqual(expect.arrayContaining([
      expect.stringMatching(/SCAN h USING INDEX outbox_lane_heads_delivery_order/)
    ]));
    expect(plan.some(({ detail }) => detail.includes("USE TEMP B-TREE FOR ORDER BY"))).toBe(false);
  });

  it("maintains lane heads across coalescing, delivery, retry, dismissal, and dead-letter recovery", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "head", idempotencyKey: "head", rootMessageId: "card-1", kind: "card_update", payload: "head" });
    store.enqueueOutboundReply({ id: "later", idempotencyKey: "later", rootMessageId: "card-1", kind: "card_update", payload: "later" });
    expect(store.listOutboundLaneHeads(1, null).map((reply) => reply.id)).toEqual(["head"]);

    store.markOutboundReplyFailed("head", "temporary", 60_000);
    expect(store.listOutboundLaneHeads(1, new Date().toISOString())).toEqual([]);
    expect(store.getNextOutboundLaneHeadAttemptAt()).toBe("2026-08-24T00:01:00.000Z");

    store.markOutboundReplyDeadLetter("head", "permanent");
    expect(store.listOutboundLaneHeads(1, null).map((reply) => reply.id)).toEqual(["later"]);
    store.markOutboundReplyDeadLetter("later", "temporary", { failureClass: "transient" });
    expect(store.listOutboundLaneHeads(1, null)).toEqual([]);

    vi.setSystemTime(new Date("2026-08-24T00:06:00.000Z"));
    expect(store.recoverEligibleDeadLetters("2026-08-24T00:05:00.000Z", 1).map((reply) => reply.id)).toEqual(["later"]);
    expect(store.listOutboundLaneHeads(1, null).map((reply) => reply.id)).toEqual(["later"]);
    vi.useRealTimers();
  });

  it("quarantines a failed Answer sequence without letting later stream work bypass it", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const [create] = store.listPendingOutboundReplies();
    store.markOutboundReplyDelivered(create!.id, "answer-1", "cardkit-1");
    for (const sequence of [1, 2, 3]) store.enqueueOutboundReply({
      id: `content-${sequence}`, idempotencyKey: `content-${sequence}`, bindingId: "b1", promptId: "p1", viewVersion: sequence, cardRole: "answer",
      rootMessageId: "cardkit-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: answerElementId("p1", 0), content: `snapshot-${sequence}`, sequence })
    });
    store.enqueueOutboundReply({ id: "finish-4", idempotencyKey: "finish-4", bindingId: "b1", promptId: "p1", viewVersion: 4, cardRole: "answer", rootMessageId: "cardkit-1", kind: "stream_finish", payload: JSON.stringify({ pageIndex: 0, summary: "Completed", sequence: 4 }) });
    store.markOutboundReplyDelivered("content-1", "cardkit-1");

    const transition = store.markOutboundReplyFailedWithQuarantine("content-2", "invalid sequence", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "200740" });

    expect(transition).toMatchObject({ state: "dead_letter", action: "blocked", laneClass: "answer_stream", promptId: "p1" });
    expect(store.listOutboundLaneHeads(10, null).filter((reply) => reply.promptId === "p1")).toEqual([]);
    expect(store.listPendingOutboundReplies().filter((reply) => reply.promptId === "p1")).toEqual([]);
    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 1, released: 0, byLaneClass: { answer_stream: 1 } } });
  });

  it("keeps an exhausted unknown Answer content failure quarantined without automatic recovery", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "cardkit-1");
    store.enqueueOutboundReply({ id: "content", idempotencyKey: "content", bindingId: "b1", promptId: "p1", viewVersion: 1, cardRole: "answer", rootMessageId: "cardkit-1", kind: "stream_content", payload: JSON.stringify({ pageIndex: 0, elementId: answerElementId("p1", 0), content: "snapshot", sequence: 1 }) });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      store.markOutboundReplyFailedWithQuarantine("content", "unclassified rejection", { failureClass: "unknown", httpStatus: 400, larkErrorCode: null });
    }

    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 1, released: 0, byLaneClass: { answer_stream: 1 }, byFailureClass: { unknown: 1 } } });
    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0 });
    expect(store.listPendingOutboundReplies()).toEqual([]);
  });

  it("releases only terminal Answer quarantines whose lanes have no pending work", () => {
    store = new SqliteBindingStore(":memory:");
    for (const promptId of ["terminal", "running", "pending-lane"]) {
      const bindingId = `binding-${promptId}`;
      store.createPendingBinding({ id: bindingId, workspaceId: "w1", chatId: "c1", topicId: `topic-${promptId}`, rootMessageId: `root-${promptId}`, title: "Task" });
      const view = createQueuedRunCard({ promptId, bindingId, title: "Answer", workspaceId: "w1", paneId: `w1:${promptId}`, requestText: "go", queuePosition: 1, occurredAt: "now" });
      store.acceptPrompt({ prompt: { id: promptId, bindingId, larkMessageId: `message-${promptId}`, actorOpenId: "u1", body: "go" }, view, rootMessageId: `root-${promptId}`, answerCard: {} });
      store.markOutboundReplyDelivered(store.listPendingOutboundReplies().find((reply) => reply.promptId === promptId)!.id, `answer-${promptId}`, `card-${promptId}`);
      store.enqueueOutboundReply({
        id: `content-${promptId}`, idempotencyKey: `content-${promptId}`, bindingId, promptId, viewVersion: 1, cardRole: "answer",
        rootMessageId: `card-${promptId}`, kind: "stream_content",
        payload: JSON.stringify({ pageIndex: 0, elementId: answerElementId(promptId, 0), content: "snapshot", sequence: 1 })
      });
      for (let attempt = 0; attempt < 5; attempt += 1) {
        store.markOutboundReplyFailedWithQuarantine(`content-${promptId}`, "unclassified rejection", { failureClass: "unknown", httpStatus: 400, larkErrorCode: null });
      }
    }
    for (const promptId of ["terminal", "pending-lane"]) {
      store.updatePrompt(promptId, "delivered");
      store.saveRunCard({ ...store.loadRunCard(promptId)!, phase: "completed", answer: "done", answerSegments: ["done"] });
    }
    store.updatePrompt("running", "running");
    store.enqueueOutboundReply({
      id: "pending-finish", idempotencyKey: "pending-finish", bindingId: "binding-pending-lane", promptId: "pending-lane", viewVersion: 2, cardRole: "answer",
      rootMessageId: "card-pending-lane", kind: "stream_finish", payload: JSON.stringify({ pageIndex: 0, summary: "done", sequence: 2 })
    });

    expect(store.getOperationalSummary().outboxQuarantines.active).toBe(3);
    expect(store.recoverStaleOutboxQuarantines()).toEqual({
      retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 1
    });
    expect(store.database.prepare("SELECT state, action FROM outbox_lane_quarantines WHERE failed_reply_id = 'content-terminal'").get()).toEqual({
      state: "released", action: "startup_terminalized"
    });
    expect(store.database.prepare("SELECT state, error FROM outbound_replies WHERE id = 'content-terminal'").get()).toEqual({
      state: "dead_letter", error: "unclassified rejection"
    });
    expect(store.database.prepare("SELECT failed_reply_id, state FROM outbox_lane_quarantines WHERE state = 'active' ORDER BY failed_reply_id").all()).toEqual([
      { failed_reply_id: "content-pending-lane", state: "active" },
      { failed_reply_id: "content-running", state: "active" }
    ]);
    expect(store.recoverStaleOutboxQuarantines()).toEqual({
      retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0
    });
  });

  it("keeps an immutable failed reply quarantined without blocking independent successors", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "create", idempotencyKey: "create", bindingId: "b1", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    store.enqueueOutboundReply({ id: "later", idempotencyKey: "later", bindingId: "b1", rootMessageId: "root-1", kind: "text", payload: "later" });

    expect(store.markOutboundReplyFailedWithQuarantine("create", "invalid target", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null })).toMatchObject({ action: "blocked", laneClass: "immutable" });
    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toEqual(["later"]);
    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 1, released: 0 } });

    expect(store.retryDeadLetter("create", "c1", "u1")).toBe("retried");
    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toEqual(["create", "later"]);
    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 0, released: 1, latest: { action: "manual_retry" } } });
  });

  it("dismisses a rejected immutable quarantine with no pending lane work at startup", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "rejected", idempotencyKey: "rejected", bindingId: "b1", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    store.markOutboundReplyFailedWithQuarantine("rejected", "target rejected", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230031" });

    expect(store.recoverStaleOutboxQuarantines()).toMatchObject({ dismissedRejectedImmutableEffects: 1 });
    expect(store.database.prepare("SELECT state, error FROM outbound_replies WHERE id = 'rejected'").get()).toEqual({
      state: "dismissed", error: "Dismissed after durable Gateway rejection"
    });
    expect(store.database.prepare("SELECT state, action, resolved_at FROM delivery_recoveries WHERE failed_reply_id = 'rejected'").get()).toMatchObject({
      state: "dismissed", action: "startup_dismiss_rejected", resolved_at: expect.any(String)
    });
    expect(store.database.prepare("SELECT state, action, released_at FROM outbox_lane_quarantines WHERE failed_reply_id = 'rejected'").get()).toMatchObject({
      state: "released", action: "startup_dismiss_rejected", released_at: expect.any(String)
    });
  });

  it("releases an uncertain old Answer target after its exact replacement is delivered", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-old", "card-old");
    store.enqueueOutboundReply({ id: "old-update", idempotencyKey: "old-update", bindingId: "b1", promptId: "p1", viewVersion: 2, cardRole: "answer", rootMessageId: "answer-old", kind: "card_update", payload: "{}" });
    const oldClaim = store.claimOutboundReply("old-update", null)!;
    store.markOutboundReplyFailedWithQuarantine(oldClaim, "response timeout", { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: null, larkErrorCode: null });
    store.database.prepare("UPDATE answer_pages SET state = 'frozen', delivery_mode = 'static' WHERE prompt_id = 'p1' AND page_index = 0").run();
    expect(store.reserveStaticAnswerReplacement({
      promptId: "p1", previousPageIndex: 0, nextPageIndex: 1, sourceStart: 0, nextElementId: answerElementId("p1", 1),
      rootMessageId: "root-1", viewVersion: 3, card: {}
    })).toBe("reserved");
    const replacement = store.listPendingOutboundReplies().find((reply) => reply.kind === "stream_card_create")!;
    store.checkpointOutboundReplyCard(replacement.id, "card-new");
    store.markOutboundReplyDelivered(replacement.id, "answer-new", "card-new");
    for (const revision of [1, 2, 3]) {
      expect(store.reserveStaticAnswerCardUpdate({
        promptId: "p1", pageIndex: 1, messageId: "answer-new", card: { revision }
      })).toBe("reserved");
    }

    expect(store.listOutboundLaneHeads(10, null).filter((reply) => reply.promptId === "p1")).toEqual([]);
    expect(store.recoverStaleOutboxQuarantines()).toMatchObject({ resolvedSupersededAnswerTargets: 1 });
    expect(store.getOutboundReply("old-update")).toMatchObject({ state: "dead_letter", effectCertainty: "uncertain" });
    expect(store.database.prepare("SELECT state, action, replacement_reply_id, resolved_by_reply_id, resolved_message_id FROM delivery_recoveries WHERE failed_reply_id = 'old-update'").get()).toEqual({
      state: "recovered", action: "startup_superseded_answer", replacement_reply_id: replacement.id, resolved_by_reply_id: replacement.id, resolved_message_id: "answer-new"
    });
    expect(store.database.prepare("SELECT state, action FROM outbox_lane_quarantines WHERE failed_reply_id = 'old-update'").get()).toEqual({
      state: "released", action: "startup_superseded_answer"
    });
    expect(store.database.prepare("SELECT snapshot_revision, state FROM outbound_replies WHERE projection_key = ? ORDER BY snapshot_revision").all("answer-static:p1:1:answer-new")).toEqual([{ snapshot_revision: 3, state: "pending" }]);
    expect(store.listOutboundLaneHeads(10, null).filter((reply) => reply.promptId === "p1")).toEqual([
      expect.objectContaining({ idempotencyKey: "answer-static:p1:1:answer-new:revision:3", rootMessageId: "answer-new" })
    ]);
  });

  it("keeps a superseded Answer quarantine blocked when replacement identity disagrees", () => {
    store = new SqliteBindingStore(":memory:");
    prepareSupersededAnswerCandidate(store);
    store.database.prepare("UPDATE run_cards SET answer_card_id = 'different-card' WHERE prompt_id = 'p1'").run();

    expect(store.recoverStaleOutboxQuarantines()).toMatchObject({ resolvedSupersededAnswerTargets: 0 });
    expect(store.database.prepare("SELECT state, action FROM delivery_recoveries WHERE failed_reply_id = 'old-update'").get()).toEqual({ state: "unresolved", action: "blocked" });
    expect(store.database.prepare("SELECT state, action FROM outbox_lane_quarantines WHERE failed_reply_id = 'old-update'").get()).toEqual({ state: "active", action: "blocked" });
    expect(store.database.prepare("SELECT state, COUNT(*) AS count FROM outbound_replies WHERE projection_key = ? GROUP BY state").all("answer-static:p1:1:answer-new")).toEqual([{ state: "pending", count: 1 }]);
  });

  it("keeps a superseded Answer quarantine blocked when a pending snapshot was claimed", () => {
    store = new SqliteBindingStore(":memory:");
    const { projectionKey } = prepareSupersededAnswerCandidate(store);
    store.database.prepare("UPDATE outbound_replies SET claim_attempt_id = 'active-claim', first_claimed_at = 'now' WHERE projection_key = ? AND snapshot_revision = 3").run(projectionKey);

    expect(store.recoverStaleOutboxQuarantines()).toMatchObject({ resolvedSupersededAnswerTargets: 0 });
    expect(store.database.prepare("SELECT state, action FROM delivery_recoveries WHERE failed_reply_id = 'old-update'").get()).toEqual({ state: "unresolved", action: "blocked" });
    expect(store.database.prepare("SELECT state, action FROM outbox_lane_quarantines WHERE failed_reply_id = 'old-update'").get()).toEqual({ state: "active", action: "blocked" });
    expect(store.database.prepare("SELECT state, COUNT(*) AS count FROM outbound_replies WHERE projection_key = ? GROUP BY state").all(projectionKey)).toEqual([{ state: "pending", count: 1 }]);
  });

  it("releases an uncertain Worker Main update only to its newest unclaimed authoritative snapshot", () => {
    store = new SqliteBindingStore(":memory:");
    const { failedId, successorId } = prepareSupersededWorkerMainCandidate(store);

    expect(store.recoverStaleOutboxQuarantines()).toMatchObject({ releasedSupersededWorkerMainUpdates: 1 });
    expect(store.database.prepare("SELECT state, action FROM outbox_lane_quarantines WHERE failed_reply_id = ?").get(failedId)).toEqual({ state: "released", action: "released_newer_snapshot" });
    expect(store.database.prepare("SELECT state, action, replacement_reply_id FROM delivery_recoveries WHERE failed_reply_id = ?").get(failedId)).toEqual({ state: "replacement_pending", action: "released_newer_snapshot", replacement_reply_id: successorId });
    expect(store.listOutboundLaneHeads(10, null)).toEqual([expect.objectContaining({ id: successorId, viewVersion: 3 })]);

    expect(store.markOutboundReplyDelivered(store.claimOutboundReply(successorId, null)!, "worker-main")).toBe(true);
    expect(store.database.prepare("SELECT state, resolved_by_reply_id, resolved_message_id FROM delivery_recoveries WHERE failed_reply_id = ?").get(failedId)).toEqual({ state: "recovered", resolved_by_reply_id: successorId, resolved_message_id: "worker-main" });
  });

  it("keeps an uncertain Worker Main update blocked when its successor identity disagrees", () => {
    store = new SqliteBindingStore(":memory:");
    const { successorId } = prepareSupersededWorkerMainCandidate(store);
    store.database.prepare("UPDATE outbound_replies SET prompt_id = 'foreign-prompt' WHERE id = ?").run(successorId);

    expect(store.recoverStaleOutboxQuarantines()).toMatchObject({ releasedSupersededWorkerMainUpdates: 0 });
    expect(store.listOutboundLaneHeads(10, null)).toEqual([]);
  });

  it("keeps an uncertain Worker Main update blocked when its successor was previously claimed", () => {
    store = new SqliteBindingStore(":memory:");
    const { successorId } = prepareSupersededWorkerMainCandidate(store);
    store.database.prepare("UPDATE outbound_replies SET first_claimed_at = '2026-09-19T00:02:00.000Z' WHERE id = ?").run(successorId);

    expect(store.recoverStaleOutboxQuarantines()).toMatchObject({ releasedSupersededWorkerMainUpdates: 0 });
    expect(store.listOutboundLaneHeads(10, null)).toEqual([]);
  });

  it("accepts a legacy immutable lane class when exact Answer replacement proof exists", () => {
    store = new SqliteBindingStore(":memory:");
    prepareSupersededAnswerCandidate(store);
    store.database.prepare("UPDATE outbox_lane_quarantines SET lane_class = 'immutable' WHERE failed_reply_id = 'old-update'").run();

    expect(store.recoverStaleOutboxQuarantines()).toMatchObject({ resolvedSupersededAnswerTargets: 1 });
    expect(store.database.prepare("SELECT state, action FROM outbox_lane_quarantines WHERE failed_reply_id = 'old-update'").get()).toEqual({ state: "released", action: "startup_superseded_answer" });
  });

  it("isolates independent replies to the same root message", () => {
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "first", idempotencyKey: "first", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    store.enqueueOutboundReply({ id: "second", idempotencyKey: "second", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });

    expect(store.markOutboundReplyFailedWithQuarantine("first", "invalid card", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "230099" }))
      .toMatchObject({ action: "blocked", laneClass: "immutable" });
    expect(store.database.prepare("SELECT id, lane_key FROM outbound_replies ORDER BY delivery_order").all()).toEqual([
      { id: "first", lane_key: "gateway:feishu:primary:reply:first" },
      { id: "second", lane_key: "gateway:feishu:primary:reply:second" }
    ]);
    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toEqual(["second"]);
  });

  it("migrates legacy shared reply lanes without losing quarantine audit history", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-independent-reply-lanes-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.enqueueOutboundReply({ id: "failed", idempotencyKey: "failed", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    store.enqueueOutboundReply({ id: "later", idempotencyKey: "later", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    store.database.exec(`
      DELETE FROM schema_migrations WHERE version = 7;
      UPDATE outbound_replies SET lane_key = 'message:root-1' WHERE id IN ('failed', 'later');
    `);
    store.markOutboundReplyFailedWithQuarantine("failed", "invalid card", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "230099" });
    store.close();
    store = undefined;

    store = new SqliteBindingStore(path);

    expect(store.database.prepare("SELECT id, lane_key, state FROM outbound_replies WHERE id IN ('failed', 'later') ORDER BY delivery_order").all()).toEqual([
      { id: "failed", lane_key: "gateway:feishu:primary:reply:failed", state: "dead_letter" },
      { id: "later", lane_key: "gateway:feishu:primary:reply:later", state: "pending" }
    ]);
    expect(store.database.prepare("SELECT lane_key, failed_reply_id, state FROM outbox_lane_quarantines WHERE failed_reply_id = 'failed'").get()).toEqual({
      lane_key: "gateway:feishu:primary:reply:failed", failed_reply_id: "failed", state: "active"
    });
    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toContain("later");
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 7").get()).toEqual({ version: 7 });
  });

  it.each([
    { id: "answer-create", cardRole: "answer" as const, targetRole: null, kind: "stream_card_create" as const },
    { id: "main-create", cardRole: null, targetRole: "session_status" as const, kind: "card_reply" as const }
  ])("keeps $id classified as immutable card creation", ({ id, cardRole, targetRole, kind }) => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    let replyId = id;
    if (cardRole) {
      const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
      store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
      replyId = store.listPendingOutboundReplies()[0]!.id;
    } else {
      store.enqueueOutboundReply({ id, idempotencyKey: id, bindingId: "b1", promptId: null, viewVersion: 1, cardRole, targetRole, rootMessageId: "root-1", kind, payload: "{}" });
    }

    expect(store.markOutboundReplyFailedWithQuarantine(replyId, "invalid target", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null })).toMatchObject({
      action: "blocked", laneClass: "immutable"
    });
    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 1, byLaneClass: { immutable: 1 } } });
  });

  it("keeps a repeated failure callback idempotent after quarantine", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "create", idempotencyKey: "create", bindingId: "b1", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    const metadata = { failureClass: "permanent" as const, httpStatus: 400, larkErrorCode: null };

    expect(store.markOutboundReplyFailedWithQuarantine("create", "invalid target", metadata)).toMatchObject({ action: "blocked", reply: { attemptCount: 1 } });
    expect(store.markOutboundReplyFailedWithQuarantine("create", "duplicate callback", metadata)).toMatchObject({ action: "blocked", reply: { attemptCount: 1 } });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbox_lane_quarantines").get()).toEqual({ count: 1 });
  });

  it("releases only a strictly newer Main Card snapshot after a permanent failure", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const first = { ...initialTopicView("b1"), title: "First", viewVersion: 1 };
    expect(store.reserveMainCard(first, "root-1", { version: 1 })).toBe("reserved");
    const [create] = store.listPendingOutboundReplies();
    store.markOutboundReplyDelivered(create!.id, "main-card-1");
    const second = { ...first, title: "Second", viewVersion: 2 };
    expect(store.reserveMainCard(second, "root-1", { version: 2 })).toBe("reserved");
    const [failed] = store.listPendingOutboundReplies();

    expect(store.markOutboundReplyFailedWithQuarantine(failed!.id, "invalid card", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "bad_card" })).toMatchObject({
      action: "released_newer_snapshot", laneClass: "main_card"
    });
    expect(store.reserveMainCard(second, "root-1", { version: 2 })).toBe("waiting");
    expect(store.listOutboundLaneHeads(10, null)).toEqual([]);

    const third = { ...second, title: "Third", viewVersion: 3 };
    expect(store.reserveMainCard(third, "root-1", { version: 3 })).toBe("reserved");
    expect(store.listOutboundLaneHeads(10, null)).toEqual([expect.objectContaining({ targetRole: "session_status", viewVersion: 3 })]);
  });

  it("rolls a locked Main Card over to the newest snapshot without clearing its current pointer early", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "locked-main" });
    const second = { ...initialTopicView("b1"), title: "Second", viewVersion: 2, deliveredVersion: 1 };
    expect(store.reserveMainCard(second, "root-1", { version: 2 })).toBe("reserved");
    const [failed] = store.listPendingOutboundReplies();
    const claim = store.claimOutboundReply(failed!.id, null)!;
    const third = { ...second, title: "Third", viewVersion: 3 };
    expect(store.reserveMainCard(third, "root-1", { version: 3 })).toBe("reserved");

    expect(store.markOutboundReplyFailedWithQuarantine(claim, "card action is lock", { failureClass: "permanent", httpStatus: 400, larkErrorCode: "230099", recoveryKind: "stale_main_card" })).toMatchObject({
      action: "rebuild_main", laneClass: "main_card", reply: { attemptCount: 1, state: "dead_letter" }
    });
    expect(store.getBinding("b1")?.statusMessageId).toBe("locked-main");
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({
      kind: "card_reply", targetRole: "session_status", rootMessageId: "root-1", viewVersion: 3, payload: JSON.stringify({ version: 3 })
    })]);
    expect(store.reserveMainCard({ ...third, title: "Fourth", viewVersion: 4 }, "root-1", { version: 4 })).toBe("waiting");
  });

  it("does not infer Main Card recovery from a raw Lark code", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", { statusMessageId: "locked-main" });
    expect(store.reserveMainCard({ ...initialTopicView("b1"), viewVersion: 2, deliveredVersion: 1 }, "root-1", { version: 2 })).toBe("reserved");
    const [failed] = store.listPendingOutboundReplies();

    expect(store.markOutboundReplyFailedWithQuarantine(failed!.id, "card action is lock", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230099" })).toMatchObject({
      action: "released_newer_snapshot", laneClass: "main_card"
    });
    expect(store.listPendingOutboundReplies()).toEqual([]);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE kind = 'card_reply' AND state = 'pending'").get()).toEqual({ count: 0 });
    expect(store.getBinding("b1")?.statusMessageId).toBe("locked-main");
  });

  it("releases only the newest coalesced replaceable-card successor", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "head", idempotencyKey: "head", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "head" });
    store.enqueueOutboundReply({ id: "middle", idempotencyKey: "middle", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "middle" });
    store.enqueueOutboundReply({ id: "latest", idempotencyKey: "latest", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "latest" });

    expect(store.listPendingOutboundReplies().map((reply) => reply.id)).toEqual(["head", "latest"]);
    expect(store.markOutboundReplyFailedWithQuarantine("head", "invalid card", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null })).toMatchObject({
      action: "released_newer_snapshot", laneClass: "replaceable_card"
    });
    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toEqual(["latest"]);
  });

  it("allows one cooled transient recovery but never bypasses the resulting immutable quarantine", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "create", idempotencyKey: "create", bindingId: "b1", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    for (let attempt = 0; attempt < 5; attempt += 1) {
      store.markOutboundReplyFailedWithQuarantine("create", "unavailable", { failureClass: "transient", httpStatus: 503, larkErrorCode: null });
    }

    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 0 } });
    expect(store.recoverEligibleDeadLetters("2099-01-01T00:00:00.000Z", 10)).toMatchObject([{ id: "create", state: "pending", autoRecoveryCount: 1 }]);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      store.markOutboundReplyFailedWithQuarantine("create", "still unavailable", { failureClass: "transient", httpStatus: 503, larkErrorCode: null });
    }
    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 1 } });
    expect(store.recoverEligibleDeadLetters("2099-01-01T00:00:00.000Z", 10)).toEqual([]);
    expect(store.listOutboundLaneHeads(10, null)).toEqual([]);
    vi.useRealTimers();
  });

  it("reopens a quarantined Answer card creation once more while preserving its failure history", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const initialCreate = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(initialCreate.id, "answer-1", "card-1");
    expect(store.reserveAnswerContinuation({
      promptId: "p1", pageIndex: 0, cardId: "card-1", messageId: "answer-1", summary: "continued", finalizedCard: {}, nextPageIndex: 1, nextPageStart: 1,
      nextElementId: answerElementId("p1", 1), rootMessageId: "root-1", viewVersion: 2,
      card: { body: { elements: [{ tag: "markdown", element_id: answerElementId("p1", 1), content: "x".repeat(10_000) }] } }
    })).toBe("reserved");
    const create = store.listPendingOutboundReplies().find((reply) => reply.kind === "stream_card_create")!;
    store.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 1 WHERE id = ?").run(create.id);
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailedWithQuarantine(create.id, "timeout", { failureClass: "transient", httpStatus: 504, larkErrorCode: "2200" });

    expect(store.getOperationalSummary().outboxQuarantines.active).toBe(1);
    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: ["p1"], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0 });
    expect(store.database.prepare("SELECT state, attempt_count, auto_recovery_count FROM outbound_replies WHERE id = ?").get(create.id)).toEqual({ state: "dead_letter", attempt_count: 5, auto_recovery_count: 1 });
    const replacement = store.listPendingOutboundReplies().find((reply) => reply.kind === "stream_card_create")!;
    expect(replacement.idempotencyKey).toBe(`startup-lite:${create.id}`);
    expect(replacement.autoRecoveryCount).toBe(2);
    expect(replacement.payload.length).toBeLessThan(create.payload.length);
    expect(replacement.payload).toContain("正在恢复本页内容");
    expect(store.database.prepare("SELECT state, action FROM outbox_lane_quarantines WHERE failed_reply_id = ?").get(create.id)).toEqual({ state: "released", action: "startup_rebuild" });
    expect(store.getOperationalSummary().deadLetters).toBe(1);
    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0 });
  });

  it("rolls back an invalid recovery page reserved across dead-lettered canonical content", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-0", "card-0");
    const canonicalAnswer = "x".repeat(130_000);
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: canonicalAnswer, answerSegments: [canonicalAnswer], viewVersion: 20 });
    store.database.prepare("UPDATE answer_pages SET state = 'frozen' WHERE prompt_id = 'p1'").run();
    store.database.prepare("INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES ('p1', 13, 'answer-13', 'card-13', ?, 109267, 1, 'frozen', 'streaming', 'now', 'now')").run(answerElementId("p1", 13));
    store.database.prepare("INSERT INTO answer_pages(prompt_id, page_index, message_id, card_id, element_id, source_start, sequence, state, delivery_mode, created_at, updated_at) VALUES ('p1', 14, NULL, NULL, ?, 109267, 0, 'creating', 'streaming', 'now', 'now')").run(answerElementId("p1", 14));
    store.database.prepare("UPDATE run_cards SET answer_message_id = 'answer-13', answer_card_id = 'card-13', answer_element_id = ?, answer_page_index = 13, answer_page_start = 109267 WHERE prompt_id = 'p1'").run(answerElementId("p1", 13));
    store.enqueueOutboundReply({ id: "content-13", idempotencyKey: "stream:p1:card-13:1", bindingId: "b1", promptId: "p1", viewVersion: 1, cardRole: "answer", rootMessageId: "card-13", kind: "stream_content", payload: JSON.stringify({ pageIndex: 13, elementId: answerElementId("p1", 13), content: "canonical", sequence: 1 }) });
    store.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 1 WHERE id = 'content-13'").run();
    store.markOutboundReplyDeadLetter("content-13", "timeout", { failureClass: "transient", httpStatus: 504, larkErrorCode: "2200" });
    store.enqueueOutboundReply({ id: "rebuild-14", idempotencyKey: "stream-rebuild:p1:14", bindingId: "b1", promptId: "p1", viewVersion: 20, cardRole: "answer", rootMessageId: "root-1", kind: "stream_card_create", payload: JSON.stringify({ card: {}, stream: { pageIndex: 14, pageStart: 109267, elementId: answerElementId("p1", 14) } }) });
    store.markOutboundReplyFailedWithQuarantine("rebuild-14", "Answer continuation target mismatch for prompt p1", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null });

    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: ["p1"], rolledBackAnswerPromptIds: ["p1"], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0 });
    expect(store.listAnswerPages("p1")).toEqual([
      expect.objectContaining({ pageIndex: 0, state: "frozen" }),
      expect.objectContaining({ pageIndex: 13, sourceStart: 109267, state: "active", messageId: "answer-13", cardId: "card-13" })
    ]);
    expect(store.database.prepare("SELECT state, error FROM outbound_replies WHERE id = 'content-13'").get()).toEqual({ state: "dead_letter", error: "timeout" });
    expect(store.database.prepare("SELECT state, error FROM outbound_replies WHERE id = 'rebuild-14'").get()).toEqual({ state: "dismissed", error: "Answer continuation target mismatch for prompt p1" });
    const replacement = store.listPendingOutboundReplies().find((reply) => reply.idempotencyKey === "startup-lite-content:content-13");
    expect(replacement).toMatchObject({ kind: "stream_content", rootMessageId: "card-13", autoRecoveryCount: 2 });
    expect(JSON.parse(replacement!.payload)).toMatchObject({ pageIndex: 13, elementId: answerElementId("p1", 13), sequence: 2, sourceEnd: expect.any(Number) });
    expect(store.database.prepare("SELECT state, action FROM outbox_lane_quarantines WHERE failed_reply_id = 'rebuild-14'").get()).toEqual({ state: "released", action: "startup_rollback" });
    expect(store.getOperationalSummary().outboxQuarantines.active).toBe(0);
    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0 });
  });

  it("replaces an exhausted active-page content update with one bounded canonical chunk", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-0", "card-0");
    const canonicalAnswer = "x".repeat(12_000);
    store.saveRunCard({ ...store.loadRunCard("p1")!, phase: "completed", answer: canonicalAnswer, answerSegments: [canonicalAnswer], viewVersion: 3 });
    expect(store.reserveAnswerContent({ promptId: "p1", pageIndex: 0, cardId: "card-0", elementId: answerElementId("p1", 0), content: canonicalAnswer })).toBe("reserved");
    const failed = store.listPendingOutboundReplies()[0]!;
    store.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 1 WHERE id = ?").run(failed.id);
    for (let attempt = 0; attempt < 5; attempt += 1) {
      store.markOutboundReplyFailedWithQuarantine(failed.id, "timeout", { failureClass: "transient", httpStatus: 504, larkErrorCode: "2200" });
    }

    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: ["p1"], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0 });
    const replacement = store.listPendingOutboundReplies()[0]!;
    const payload = JSON.parse(replacement.payload) as { content: string; sourceEnd: number; sequence: number };
    expect(replacement).toMatchObject({ idempotencyKey: `startup-lite-content:${failed.id}`, kind: "stream_content", autoRecoveryCount: 2 });
    expect(payload.content.length).toBeLessThanOrEqual(4_000);
    expect(payload.sourceEnd).toBeGreaterThan(0);
    expect(payload.sourceEnd).toBeLessThan(canonicalAnswer.length);
    expect(payload.sequence).toBe(2);
    expect(store.database.prepare("SELECT state, action FROM outbox_lane_quarantines WHERE failed_reply_id = ?").get(failed.id)).toEqual({ state: "released", action: "startup_rebuild" });
    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0 });
  });

  it("dismisses stale disconnected-topic notices but preserves uncertain immutable quarantines", () => {
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "notice", idempotencyKey: "disconnected-topic:message-1", rootMessageId: "message-1", kind: "card_reply", payload: "{}" });
    store.enqueueOutboundReply({ id: "other", idempotencyKey: "important:message-2", rootMessageId: "message-2", kind: "card_reply", payload: "{}" });
    store.database.prepare("UPDATE outbound_replies SET auto_recovery_count = 1 WHERE id = 'notice'").run();
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailedWithQuarantine("notice", "unavailable", { failureClass: "transient", httpStatus: 500, larkErrorCode: "2200" });
    store.markOutboundReplyFailedWithQuarantine("other", "unknown outcome", { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: null, larkErrorCode: null });

    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 1, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0 });
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id = 'notice'").get()).toEqual({ state: "dismissed" });
    expect(store.database.prepare("SELECT state FROM outbound_replies WHERE id = 'other'").get()).toEqual({ state: "dead_letter" });
    expect(store.getOperationalSummary().outboxQuarantines.active).toBe(1);
    expect(store.recoverStaleOutboxQuarantines()).toEqual({ retriedAnswerPromptIds: [], rolledBackAnswerPromptIds: [], dismissedNotices: 0, dismissedRejectedImmutableEffects: 0, resolvedSupersededAnswerTargets: 0, releasedSupersededWorkerMainUpdates: 0, terminalizedQuarantines: 0 });
  });

  it("atomically releases an immutable quarantine when the failed head is dismissed", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "create", idempotencyKey: "create", bindingId: "b1", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    store.enqueueOutboundReply({ id: "later", idempotencyKey: "later", bindingId: "b1", rootMessageId: "root-1", kind: "text", payload: "later" });
    store.markOutboundReplyFailedWithQuarantine("create", "invalid target", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null });

    expect(store.dismissDeadLetter("create", "c1", "u1")).toBe("dismissed");
    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toEqual(["later"]);
    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 0, released: 1, latest: { action: "manual_dismiss" } } });
    expect(store.dismissDeadLetter("create", "c1", "u1")).toBe("stale");
  });

  it("preserves one isolated immutable quarantine across reopen", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-outbox-quarantine-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "create", idempotencyKey: "create", bindingId: "b1", rootMessageId: "root-1", kind: "card_reply", payload: "{}" });
    store.enqueueOutboundReply({ id: "later", idempotencyKey: "later", bindingId: "b1", rootMessageId: "root-1", kind: "text", payload: "later" });
    store.markOutboundReplyFailedWithQuarantine("create", "invalid target", { failureClass: "permanent", httpStatus: 400, larkErrorCode: null });
    store.close();

    store = new SqliteBindingStore(path);
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 5").all()).toEqual([{ version: 5 }]);
    expect(store.getOperationalSummary()).toMatchObject({ outboxQuarantines: { active: 1, released: 0 } });
    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toEqual(["later"]);
  });

  it("coalesces pending binding status-card snapshots behind the in-flight-safe lane head", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });

    store.enqueueOutboundReply({ id: "working", idempotencyKey: "status:working", bindingId: "b1", rootMessageId: "status-card", kind: "card_update", payload: "working" });
    store.enqueueOutboundReply({ id: "progress", idempotencyKey: "status:progress", bindingId: "b1", rootMessageId: "status-card", kind: "card_update", payload: "progress" });
    store.enqueueOutboundReply({ id: "done", idempotencyKey: "status:done", bindingId: "b1", rootMessageId: "status-card", kind: "card_update", payload: "done" });

    expect(store.listPendingOutboundReplies().map((reply) => ({ id: reply.id, payload: reply.payload }))).toEqual([
      { id: "working", payload: "working" },
      { id: "done", payload: "done" }
    ]);
    expect(store.listOutboundLaneHeads(1, null).map((reply) => reply.id)).toEqual(["working"]);

    store.markOutboundReplyDelivered("working", "status-card");
    expect(store.listOutboundLaneHeads(1, null).map((reply) => reply.id)).toEqual(["done"]);
  });

  it("keeps status-card coalescing isolated by binding, target, and lane", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "One" });
    store.createPendingBinding({ id: "b2", workspaceId: "w2", chatId: "c1", topicId: "t2", rootMessageId: "root-2", title: "Two" });
    store.enqueueOutboundReply({ id: "b1-head", idempotencyKey: "b1-head", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "head" });
    store.enqueueOutboundReply({ id: "b1-next", idempotencyKey: "b1-next", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "next" });
    store.enqueueOutboundReply({ id: "b2-head", idempotencyKey: "b2-head", bindingId: "b2", rootMessageId: "card-1", kind: "card_update", payload: "other binding" });
    store.enqueueOutboundReply({ id: "other-card", idempotencyKey: "other-card", bindingId: "b1", rootMessageId: "card-2", kind: "card_update", payload: "other card" });
    store.enqueueOutboundReply({ id: "b1-latest", idempotencyKey: "b1-latest", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "latest" });

    expect(store.listPendingOutboundReplies().map((reply) => reply.id)).toEqual(["b1-head", "b2-head", "other-card", "b1-latest"]);
  });

  it("preserves every pending Answer stream sequence", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Answer", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const [answerCreate] = store.listPendingOutboundReplies();
    store.markOutboundReplyDelivered(answerCreate!.id, "answer-1", "cardkit-1");

    for (const sequence of [1, 2, 3]) {
      store.enqueueOutboundReply({
        id: `content-${sequence}`, idempotencyKey: `stream:p1:cardkit-1:${sequence}`, bindingId: "b1", promptId: "p1", viewVersion: sequence, cardRole: "answer",
        rootMessageId: "cardkit-1", kind: "stream_content", payload: JSON.stringify({ elementId: answerElementId("p1", 0), content: `snapshot-${sequence}`, sequence })
      });
    }

    expect(store.listPendingOutboundReplies().map((reply) => ({ id: reply.id, sequence: reply.viewVersion }))).toEqual([
      { id: "content-1", sequence: 1 }, { id: "content-2", sequence: 2 }, { id: "content-3", sequence: 3 }
    ]);
  });

  it("rolls back status-card pruning when insertion fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "head", idempotencyKey: "head", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "head" });
    store.enqueueOutboundReply({ id: "successor", idempotencyKey: "successor", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "successor" });

    expect(() => store!.enqueueOutboundReply({ id: "head", idempotencyKey: "replacement", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "fails" })).toThrow();
    expect(store.listPendingOutboundReplies().map((reply) => reply.id)).toEqual(["head", "successor"]);
  });

  it("reports an empty durable outbox lane summary without identifiers", () => {
    store = new SqliteBindingStore(":memory:");

    expect(store.getOperationalSummary().outboxLanes).toEqual({
      pending: 0, eligible: 0, blocked: 0, nextAttemptAt: null,
      oldestHeadAt: null, oldestHeadAgeSeconds: null, stalled: 0, oldestStalledAgeSeconds: null
    });
    expect(store.getOperationalSummary().outboxWork).toEqual({
      ready: 0, inFlight: 0, retryWait: 0, cooldownWait: 0, waitingBehindLane: 0,
      oldestInFlightAt: null, oldestInFlightAgeSeconds: null
    });
  });

  it("partitions pending outbox work into exclusive durable classes", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:10:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "ready", idempotencyKey: "ready", rootMessageId: "ready-card", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "claimed", idempotencyKey: "claimed", rootMessageId: "claimed-card", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "retry", idempotencyKey: "retry", rootMessageId: "retry-card", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "retry-successor", idempotencyKey: "retry-successor", rootMessageId: "retry-card", kind: "card_update", payload: "{}" });
    vi.setSystemTime(new Date("2026-09-12T00:09:50.000Z"));
    const claim = store.claimOutboundReply("claimed", null)!;
    vi.setSystemTime(new Date("2026-09-12T00:10:00.000Z"));
    store.database.prepare("UPDATE outbound_replies SET next_attempt_at = ? WHERE id = 'retry'").run("2026-09-12T00:11:00.000Z");

    const summary = store.getOperationalSummary();
    expect(summary.outboxWork).toEqual({
      ready: 1, inFlight: 1, retryWait: 1, cooldownWait: 0, waitingBehindLane: 1,
      oldestInFlightAt: "2026-09-12T00:09:50.000Z", oldestInFlightAgeSeconds: 10
    });
    expect(Object.values(summary.outboxWork).slice(0, 5).reduce((total, count) => total + Number(count), 0)).toBe(summary.pendingOutbox);
    expect(store.markOutboundReplyDelivered(claim, "message")).toBe(true);
    expect(store.getOperationalSummary().outboxWork).toMatchObject({ inFlight: 0, ready: 1, retryWait: 1, waitingBehindLane: 1 });
    vi.useRealTimers();
  });

  it("retains a malformed legacy claim timestamp without throwing or inventing an age", () => {
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "claimed", idempotencyKey: "claimed", rootMessageId: "card", kind: "card_update", payload: "{}" });
    expect(store.claimOutboundReply("claimed", null)).not.toBeNull();
    store.database.prepare("UPDATE outbound_replies SET claimed_at = 'legacy-invalid' WHERE id = 'claimed'").run();

    expect(store.getOperationalSummary().outboxWork).toMatchObject({
      inFlight: 1, oldestInFlightAt: "legacy-invalid", oldestInFlightAgeSeconds: null
    });
  });

  it("distinguishes row retry wait from app cooldown wait and restores ready work at expiry", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "limited", idempotencyKey: "limited", rootMessageId: "limited-card", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "due", idempotencyKey: "due", rootMessageId: "due-card", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "backoff", idempotencyKey: "backoff", rootMessageId: "backoff-card", kind: "card_update", payload: "{}" });
    const limited = store.claimOutboundReply("limited", null)!;
    store.markOutboundReplyFailedWithQuarantine(limited, "rate limited", { failureClass: "transient", effectCertainty: "rejected", httpStatus: 429, larkErrorCode: null }, 5_000);
    store.database.prepare("UPDATE outbound_replies SET next_attempt_at = ? WHERE id = 'backoff'").run("2026-09-12T00:00:10.000Z");

    let summary = store.getOperationalSummary();
    expect(summary.outboxWork).toEqual({
      ready: 0, inFlight: 0, retryWait: 2, cooldownWait: 1, waitingBehindLane: 0, oldestInFlightAt: null, oldestInFlightAgeSeconds: null
    });
    expect(summary.outboxWork.ready + summary.outboxWork.inFlight + summary.outboxWork.retryWait + summary.outboxWork.cooldownWait + summary.outboxWork.waitingBehindLane).toBe(summary.pendingOutbox);

    vi.setSystemTime(new Date("2026-09-12T00:00:05.000Z"));
    summary = store.getOperationalSummary();
    expect(summary.outboxWork).toMatchObject({ ready: 2, inFlight: 0, retryWait: 1, cooldownWait: 0, waitingBehindLane: 0 });
    expect(summary.outboxWork.ready + summary.outboxWork.inFlight + summary.outboxWork.retryWait + summary.outboxWork.cooldownWait + summary.outboxWork.waitingBehindLane).toBe(summary.pendingOutbox);
    vi.useRealTimers();
  });

  it("preserves Answer lane insertion order across reopen and VACUUM", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-outbox-order-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: null, requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root", answerCard: {} });
    for (const reply of store.listPendingOutboundReplies()) store.markOutboundReplyDelivered(reply.id, "answer-1", "card-1");
    store.enqueueOutboundReply({ id: "first", idempotencyKey: "first", bindingId: "b1", promptId: "p1", cardRole: "answer", rootMessageId: "root", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "second", idempotencyKey: "second", bindingId: "b1", promptId: "p1", cardRole: "answer", rootMessageId: "root", kind: "card_update", payload: "{}" });
    store.close();

    store = new SqliteBindingStore(path);
    store.database.exec("VACUUM");

    expect(store.listOutboundLaneHeads(1, null).map((reply) => reply.id)).toEqual(["first"]);
  });

  it("jitters exponential retries and honors an explicit retry delay", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-24T00:00:00.000Z"));
    const random = vi.spyOn(Math, "random").mockReturnValue(0);
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "jitter", idempotencyKey: "jitter", rootMessageId: "card-1", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "rate-limit", idempotencyKey: "rate-limit", rootMessageId: "card-2", kind: "card_update", payload: "{}" });

    expect(store.markOutboundReplyFailed("jitter", "temporary")?.nextAttemptAt).toBe("2026-08-24T00:00:00.800Z");
    expect(store.markOutboundReplyFailed("rate-limit", "limited", 7_000)?.nextAttemptAt).toBe("2026-08-24T00:00:07.000Z");

    random.mockRestore();
    vi.useRealTimers();
  });

  it("persists an app-wide 429 cooldown across lanes and restart", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-lark-cooldown-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.enqueueOutboundReply({ id: "limited", idempotencyKey: "limited", rootMessageId: "card-1", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "independent", idempotencyKey: "independent", rootMessageId: "card-2", kind: "card_update", payload: "{}" });
    const claim = store.claimOutboundReply("limited", null)!;

    expect(store.markOutboundReplyFailedWithQuarantine(claim, "rate limited Authorization: Bearer top-secret", { failureClass: "transient", effectCertainty: "rejected", httpStatus: 429, larkErrorCode: "99991400" }, 7_000)).toMatchObject({
      action: "retry", reply: { nextAttemptAt: "2026-09-12T00:00:07.000Z" }
    });
    expect(store.database.prepare("SELECT scope, blocked_until, trigger_count, last_http_status, last_lark_error_code, last_reason FROM lark_delivery_cooldowns").get()).toEqual({
      scope: "app", blocked_until: "2026-09-12T00:00:07.000Z", trigger_count: 1, last_http_status: 429, last_lark_error_code: "99991400", last_reason: "rate limited Authorization: Bearer [REDACTED]"
    });
    expect(store.listOutboundLaneHeads(10, null)).toEqual([]);
    expect(store.claimOutboundReply("independent", null)).toBeNull();
    expect(store.getNextOutboundLaneHeadAttemptAt()).toBe("2026-09-12T00:00:07.000Z");
    expect(store.getOperationalSummary()).toMatchObject({
      larkDeliveryCooldown: { active: true, blockedUntil: "2026-09-12T00:00:07.000Z", remainingMs: 7_000, triggerCount: 1, lastHttpStatus: 429, lastLarkErrorCode: "99991400", lastReason: "rate limited Authorization: Bearer [REDACTED]" },
      outboxLanes: { pending: 2, eligible: 0, blocked: 2, nextAttemptAt: "2026-09-12T00:00:07.000Z", stalled: 0, oldestStalledAgeSeconds: null }
    });
    store.close(); store = new SqliteBindingStore(path);
    expect(store.listOutboundLaneHeads(10, null)).toEqual([]);

    vi.setSystemTime(new Date("2026-09-12T00:00:07.000Z"));
    expect(store.listOutboundLaneHeads(10, null).map((reply) => reply.id)).toEqual(["limited", "independent"]);
    expect(store.getOperationalSummary().larkDeliveryCooldown).toMatchObject({ active: false, remainingMs: 0, triggerCount: 1 });
    expect(store.claimOutboundReply("independent", null)).not.toBeNull();
    vi.useRealTimers();
  });

  it("extends an app cooldown monotonically and ignores stale 429 receipts", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    for (const id of ["first", "second", "stale"]) store.enqueueOutboundReply({ id, idempotencyKey: id, rootMessageId: `card-${id}`, kind: "card_update", payload: "{}" });
    const first = store.claimOutboundReply("first", null)!;
    const second = store.claimOutboundReply("second", null)!;
    const stale = store.claimOutboundReply("stale", null)!;
    expect(store.markOutboundReplyFailedWithQuarantine(stale, "temporary", { failureClass: "transient", effectCertainty: "rejected", httpStatus: 503, larkErrorCode: null })).not.toBeNull();
    const current = store.claimOutboundReply("stale", null)!;

    store.markOutboundReplyFailedWithQuarantine(first, "seven seconds", { failureClass: "transient", effectCertainty: "rejected", httpStatus: 429, larkErrorCode: "rate" }, 7_000);
    store.markOutboundReplyFailedWithQuarantine(second, "three seconds", { failureClass: "transient", effectCertainty: "rejected", httpStatus: 429, larkErrorCode: "rate" }, 3_000);
    expect(store.markOutboundReplyFailedWithQuarantine(stale, "stale twelve seconds", { failureClass: "transient", effectCertainty: "rejected", httpStatus: 429, larkErrorCode: "rate" }, 12_000)).toBeNull();
    expect(store.database.prepare("SELECT blocked_until, trigger_count, last_reason FROM lark_delivery_cooldowns WHERE scope = 'app'").get()).toEqual({
      blocked_until: "2026-09-12T00:00:07.000Z", trigger_count: 2, last_reason: "three seconds"
    });
    expect(store.getOutboundReply(current.reply.id)).toMatchObject({ state: "pending", attemptCount: 1, httpStatus: 503 });
    vi.useRealTimers();
  });

  it("rolls back reply settlement when the 429 cooldown cannot be persisted", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-09-12T00:00:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "limited", idempotencyKey: "limited", rootMessageId: "card", kind: "card_update", payload: "{}" });
    const claim = store.claimOutboundReply("limited", null)!;
    store.database.exec("CREATE TRIGGER reject_lark_cooldown BEFORE INSERT ON lark_delivery_cooldowns BEGIN SELECT RAISE(ABORT, 'cooldown_write_failed'); END");

    expect(() => store!.markOutboundReplyFailedWithQuarantine(claim, "rate limited", { failureClass: "transient", effectCertainty: "rejected", httpStatus: 429, larkErrorCode: null }, 5_000)).toThrow("cooldown_write_failed");
    expect(store.getOutboundReply("limited")).toMatchObject({ state: "pending", attemptCount: 0, error: null });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM lark_delivery_cooldowns").get()).toEqual({ count: 0 });
    store.database.exec("DROP TRIGGER reject_lark_cooldown");
    expect(store.markOutboundReplyDelivered(claim, "message")).toBe(true);
    vi.useRealTimers();
  });

  it("migrates the app cooldown table idempotently without changing outbox state", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-lark-cooldown-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.enqueueOutboundReply({ id: "pending", idempotencyKey: "pending", rootMessageId: "card", kind: "card_update", payload: "{}" });
    store.database.exec("DROP TABLE lark_delivery_cooldowns; DELETE FROM schema_migrations WHERE version = 38");
    store.close(); store = new SqliteBindingStore(path);

    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 38").get()).toEqual({ version: 38 });
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM lark_delivery_cooldowns").get()).toEqual({ count: 0 });
    expect(store.listPendingOutboundReplies()).toMatchObject([{ id: "pending", state: "pending" }]);
    store.close(); store = new SqliteBindingStore(path);
    expect(store.database.prepare("SELECT COUNT(*) AS count FROM schema_migrations WHERE version = 38").get()).toEqual({ count: 1 });
  });

  it("additively backfills Gateway identity and delivery-plan columns without rewriting legacy payloads", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-gateway-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "chat", topicId: "topic", rootMessageId: "root", title: "Task" });
    store.recordInboundMessage({ eventId: "event-1", messageId: "message-1", chatId: "chat", topicId: "topic", rootMessageId: "root", parentMessageId: null, actorOpenId: "actor", text: "hello", mentionsBot: true, isRootMessage: false });
    store.enqueueOutboundReply({ id: "out-1", idempotencyKey: "out-1", rootMessageId: "root", kind: "card_update", payload: '{"legacy":true}' });
    store.database.exec("DROP TRIGGER outbound_replies_immutable_claim; DROP INDEX bindings_gateway_route; DROP INDEX inbound_messages_gateway_event; DROP INDEX outbound_replies_gateway_state");
    for (const table of ["bindings", "inbound_messages"]) store.database.exec(`ALTER TABLE ${table} DROP COLUMN gateway_id`);
    for (const column of ["gateway_checkpoint_json", "gateway_plan_hash", "gateway_plan_json", "gateway_profile_id", "gateway_id"]) store.database.exec(`ALTER TABLE outbound_replies DROP COLUMN ${column}`);
    store.database.exec("DELETE FROM schema_migrations WHERE version = 39");
    store.close(); store = new SqliteBindingStore(path);

    expect(store.database.prepare("SELECT gateway_id FROM bindings WHERE id = 'b1'").get()).toEqual({ gateway_id: "feishu:primary" });
    expect(store.database.prepare("SELECT gateway_id FROM inbound_messages WHERE event_id = 'event-1'").get()).toEqual({ gateway_id: "feishu:primary" });
    expect(store.database.prepare("SELECT gateway_id, gateway_profile_id, gateway_plan_json, gateway_plan_hash, gateway_checkpoint_json, payload FROM outbound_replies WHERE id = 'out-1'").get()).toEqual({ gateway_id: "feishu:primary", gateway_profile_id: "feishu-cardkit-v1", gateway_plan_json: null, gateway_plan_hash: null, gateway_checkpoint_json: null, payload: '{"legacy":true}' });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 39").get()).toEqual({ version: 39 });

    const claim = store.claimOutboundReply("out-1", null)!;
    expect(() => store!.database.prepare("UPDATE outbound_replies SET gateway_id = 'telegram:primary' WHERE id = 'out-1'").run()).toThrow("immutable_outbound_revision");
    expect(() => store!.database.prepare("UPDATE outbound_replies SET gateway_plan_json = '{}' WHERE id = 'out-1'").run()).toThrow("immutable_outbound_revision");
    expect(() => store!.database.prepare("UPDATE outbound_replies SET gateway_checkpoint_json = '{}' WHERE id = 'out-1'").run()).not.toThrow();
    expect(store.markOutboundReplyDelivered(claim, "root")).toBe(true);
  });

  it("scopes legacy outbox lanes and quarantines by Gateway identity", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-gateway-lane-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.enqueueOutboundReply({ id: "failed", idempotencyKey: "failed", rootMessageId: "root", kind: "card_reply", payload: "{}" });
    const claim = store.claimOutboundReply("failed", null)!;
    store.markOutboundReplyFailedWithQuarantine(claim, "bad target", { failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: null });
    store.database.exec("DROP TRIGGER outbound_replies_immutable_claim; DELETE FROM outbox_lane_heads; UPDATE outbox_lane_quarantines SET lane_key = 'reply:failed'; UPDATE outbound_replies SET lane_key = 'reply:failed'; DELETE FROM schema_migrations WHERE version = 40");
    store.close(); store = new SqliteBindingStore(path);

    expect(store.database.prepare("SELECT lane_key FROM outbound_replies WHERE id = 'failed'").get()).toEqual({ lane_key: "gateway:feishu:primary:reply:failed" });
    expect(store.database.prepare("SELECT lane_key, state FROM outbox_lane_quarantines WHERE failed_reply_id = 'failed'").get()).toEqual({ lane_key: "gateway:feishu:primary:reply:failed", state: "active" });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 40").get()).toEqual({ version: 40 });
  });

  it("migrates precise legacy Feishu expired Answer targets into terminal projection evidence", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-expired-answer-target-migration-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "user-1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    store.markOutboundReplyDelivered(store.listPendingOutboundReplies()[0]!.id, "answer-1", "card-1");
    store.database.prepare("UPDATE answer_pages SET state = 'finished' WHERE prompt_id = 'p1'").run();
    expect(store.reserveFinalAnswerCardUpdate({ promptId: "p1", pageIndex: 0, cardId: "card-1", messageId: "answer-1", card: { content: "final" } })).toBe("reserved");
    const expired = store.listPendingOutboundReplies()[0]!;
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailedWithQuarantine(store.claimOutboundReply(expired.id, null)!, "message expired", { failureClass: "unknown", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230031" });
    store.enqueueOutboundReply({ id: "unscoped", idempotencyKey: "unscoped", bindingId: "b1", promptId: "p1", cardRole: "answer", rootMessageId: "answer-1", kind: "card_update", payload: "{}" });
    store.markOutboundReplyDeadLetter("unscoped", "message expired", { failureClass: "unknown", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230031" });
    store.database.prepare("DELETE FROM schema_migrations WHERE version = 41").run();
    store.close(); store = new SqliteBindingStore(path);

    expect(store.database.prepare("SELECT state, action, failure_class FROM delivery_recoveries WHERE failed_reply_id = ?").get(expired.id)).toEqual({ state: "dismissed", action: "expired_view_target", failure_class: "permanent" });
    expect(store.getOutboundReply(expired.id)).toMatchObject({ state: "dead_letter", failureClass: "permanent", effectCertainty: "rejected", larkErrorCode: "230031" });
    expect(store.database.prepare("SELECT state, action FROM delivery_recoveries WHERE failed_reply_id = 'unscoped'").get()).toEqual({ state: "unresolved", action: "blocked" });
    expect(store.database.prepare("SELECT version FROM schema_migrations WHERE version = 41").get()).toEqual({ version: 41 });
    expect(store.reserveFinalAnswerCardUpdate({ promptId: "p1", pageIndex: 0, cardId: "card-1", messageId: "answer-1", card: { content: "newer" } })).toBe("waiting");
  });

  it("persists classified failures and reopens one cooled transient round only", () => {
    vi.useFakeTimers();
    vi.setSystemTime(new Date("2026-08-25T00:00:00.000Z"));
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "transient", idempotencyKey: "transient", rootMessageId: "card-1", kind: "card_update", payload: "{}" });
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("transient", "upstream unavailable", undefined, { failureClass: "transient", httpStatus: 503, larkErrorCode: null });
    expect(store.database.prepare("SELECT state, failure_class, http_status, auto_recovery_count, dead_lettered_at FROM outbound_replies WHERE id = 'transient'").get()).toEqual({
      state: "dead_letter", failure_class: "transient", http_status: 503, auto_recovery_count: 0, dead_lettered_at: "2026-08-25T00:00:00.000Z"
    });
    expect(store.recoverEligibleDeadLetters("2026-08-24T23:59:59.999Z", 10)).toEqual([]);
    expect(store.recoverEligibleDeadLetters("2026-08-25T00:00:00.000Z", 10)).toMatchObject([{ id: "transient", state: "pending", attemptCount: 0, autoRecoveryCount: 1 }]);
    expect(store.recoverEligibleDeadLetters("2026-08-25T00:00:00.000Z", 10)).toEqual([]);
    for (let attempt = 0; attempt < 5; attempt += 1) store.markOutboundReplyFailed("transient", "still unavailable", undefined, { failureClass: "transient", httpStatus: 503, larkErrorCode: null });
    expect(store.recoverEligibleDeadLetters("2099-01-01T00:00:00.000Z", 10)).toEqual([]);
    expect(store!.getOperationalSummary()).toMatchObject({ deadLettersByClass: { transient: 1, permanent: 0, unknown: 0, legacy: 0 }, eligibleDeadLetterRecoveries: 0 });
    vi.useRealTimers();
  });

  it("never automatically reopens legacy or unknown dead letters", () => {
    store = new SqliteBindingStore(":memory:");
    store.enqueueOutboundReply({ id: "legacy", idempotencyKey: "legacy", rootMessageId: "card-1", kind: "card_update", payload: "{}" });
    store.enqueueOutboundReply({ id: "unknown", idempotencyKey: "unknown", rootMessageId: "card-2", kind: "card_update", payload: "{}" });
    store.database.exec("UPDATE outbound_replies SET state = 'dead_letter', attempt_count = 5, dead_lettered_at = '2020-01-01T00:00:00.000Z' WHERE id = 'legacy'");
    store.markOutboundReplyDeadLetter("unknown", "generic 400", { failureClass: "unknown", httpStatus: 400, larkErrorCode: null });
    store.database.exec("UPDATE outbound_replies SET dead_lettered_at = '2020-01-01T00:00:00.000Z' WHERE id = 'unknown'");

    expect(store.recoverEligibleDeadLetters("2099-01-01T00:00:00.000Z", 10)).toEqual([]);
    expect(store.getOperationalSummary()).toMatchObject({ deadLettersByClass: { transient: 0, permanent: 0, unknown: 1, legacy: 1 } });
  });

  it("backfills legacy dead-letter effect certainty conservatively", () => {
    temporaryDirectory = mkdtempSync(join(tmpdir(), "herdr-effect-certainty-"));
    const path = join(temporaryDirectory, "bridge.db");
    store = new SqliteBindingStore(path);
    for (const id of ["response", "transport"]) store.enqueueOutboundReply({ id, idempotencyKey: id, rootMessageId: "card", kind: "card_update", payload: "{}" });
    store.database.exec(`
      UPDATE outbound_replies SET state = 'dead_letter', failure_class = 'unknown', effect_certainty = NULL, http_status = 400 WHERE id = 'response';
      UPDATE outbound_replies SET state = 'dead_letter', failure_class = 'unknown', effect_certainty = NULL, http_status = NULL, lark_error_code = NULL WHERE id = 'transport';
      DELETE FROM schema_migrations WHERE version = 37;
    `);
    store.close(); store = new SqliteBindingStore(path);

    expect(store.database.prepare("SELECT id, effect_certainty FROM outbound_replies WHERE id IN ('response','transport') ORDER BY id").all()).toEqual([
      { id: "response", effect_certainty: "rejected" },
      { id: "transport", effect_certainty: "uncertain" }
    ]);
    expect(store.database.prepare("SELECT 1 AS applied FROM schema_migrations WHERE version = 37").get()).toEqual({ applied: 1 });
  });

  it("prunes only old delivered or dismissed outbox history in a bounded batch", () => {
    store = new SqliteBindingStore(":memory:");
    for (const id of ["delivered-old", "dismissed-old", "pending-old", "dead-old", "delivered-new"]) {
      store.enqueueOutboundReply({ id, idempotencyKey: id, rootMessageId: "card-1", kind: "card_update", payload: "{}" });
    }
    store.database.exec(`
      UPDATE outbound_replies SET state = 'delivered', updated_at = '2026-08-01T00:00:00.000Z' WHERE id = 'delivered-old';
      UPDATE outbound_replies SET state = 'dismissed', updated_at = '2026-08-01T00:00:00.000Z' WHERE id = 'dismissed-old';
      UPDATE outbound_replies SET state = 'pending', updated_at = '2026-08-01T00:00:00.000Z' WHERE id = 'pending-old';
      UPDATE outbound_replies SET state = 'dead_letter', updated_at = '2026-08-01T00:00:00.000Z' WHERE id = 'dead-old';
      UPDATE outbound_replies SET state = 'delivered', updated_at = '2026-08-25T00:00:00.000Z' WHERE id = 'delivered-new';
    `);

    expect(store.pruneDeliveredOutboundReplies('2026-08-12T00:00:00.000Z', 1)).toBe(1);
    expect(store.pruneDeliveredOutboundReplies('2026-08-12T00:00:00.000Z', 10)).toBe(1);
    expect(store.database.prepare("SELECT id, state FROM outbound_replies ORDER BY id").all()).toEqual([
      { id: 'dead-old', state: 'dead_letter' },
      { id: 'delivered-new', state: 'delivered' },
      { id: 'pending-old', state: 'pending' }
    ]);
  });

  it("prunes only old accepted inbound history in a bounded batch", () => {
    store = new SqliteBindingStore(":memory:");
    for (const id of ["accepted-old-1", "accepted-old-2", "accepted-new", "received-old", "processing-old"]) {
      store.recordInboundMessage({ eventId: id, messageId: `message-${id}`, chatId: "chat", topicId: null, rootMessageId: "root", actorOpenId: "user", text: "private", mentionsBot: false, isRootMessage: false });
    }
    store.database.exec(`
      UPDATE inbound_messages SET state = 'accepted', updated_at = '2026-08-01T00:00:00.000Z' WHERE event_id IN ('accepted-old-1', 'accepted-old-2');
      UPDATE inbound_messages SET state = 'accepted', updated_at = '2026-08-25T00:00:00.000Z' WHERE event_id = 'accepted-new';
      UPDATE inbound_messages SET state = 'received', updated_at = '2026-08-01T00:00:00.000Z' WHERE event_id = 'received-old';
      UPDATE inbound_messages SET state = 'processing', updated_at = '2026-08-01T00:00:00.000Z' WHERE event_id = 'processing-old';
    `);

    expect(store.pruneAcceptedInboundMessages("2026-08-12T00:00:00.000Z", 1)).toBe(1);
    expect(store.pruneAcceptedInboundMessages("2026-08-12T00:00:00.000Z", 10)).toBe(1);
    expect(store.database.prepare("SELECT event_id, state FROM inbound_messages ORDER BY event_id").all()).toEqual([
      { event_id: "accepted-new", state: "accepted" },
      { event_id: "processing-old", state: "processing" },
      { event_id: "received-old", state: "received" }
    ]);
  });

  it("does not reset the automatic recovery budget during a manual retry", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.enqueueOutboundReply({ id: "manual", idempotencyKey: "manual", bindingId: "b1", rootMessageId: "card-1", kind: "card_update", payload: "{}" });
    store.markOutboundReplyDeadLetter("manual", "unavailable", { failureClass: "transient", httpStatus: 503, larkErrorCode: null });
    store.database.exec("UPDATE outbound_replies SET auto_recovery_count = 1 WHERE id = 'manual'");

    expect(store.retryDeadLetter("manual", "c1", "u1")).toBe("retried");
    expect(store.database.prepare("SELECT state, attempt_count, auto_recovery_count FROM outbound_replies WHERE id = 'manual'").get()).toEqual({ state: "pending", attempt_count: 0, auto_recovery_count: 1 });
  });

  it("atomically claims a prompt only while its binding is dispatchable", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root-1", title: "Task" });
    store.updateBinding("b1", {
      paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", provisioningCheckpoint: "activated", lastAgentState: "unknown"
    });
    const view = createQueuedRunCard({ promptId: "p1", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "go", queuePosition: 1, occurredAt: "now" });
    store.acceptPrompt({ prompt: { id: "p1", bindingId: "b1", larkMessageId: "m1", actorOpenId: "u1", body: "go" }, view, rootMessageId: "root-1", answerCard: {} });
    const answerCreate = store.listPendingOutboundReplies()[0]!;
    store.markOutboundReplyDelivered(answerCreate.id, "answer-card", "cardkit-1");

    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
    expect(store.listQueuedTurnPromptIds("b1")).toEqual(["p1"]);

    store.updateBinding("b1", { lastAgentState: "idle" });
    expect(store.claimNextDispatchablePrompt("b1")).toMatchObject({
      prompt: { id: "p1", state: "running", attemptCount: 1 },
      binding: { id: "b1", paneId: "w1:p1", lastAgentState: "idle" }
    });
    expect(store.claimNextDispatchablePrompt("b1")).toBeNull();
  });

  it("atomically cancels terminal backlog and returns identity-only durable work hints", () => {
    store = new SqliteBindingStore(":memory:");
    for (const [bindingId, state, lifecycle, attachment] of [
      ["archived", "archived", "archived", "attached"],
      ["orphaned", "orphaned", "active", "orphaned"],
      ["pending", "pending", "provisioning", "unattached"]
    ] as const) {
      store.createPendingBinding({ id: bindingId, workspaceId: "w1", chatId: "c1", topicId: bindingId, rootMessageId: bindingId, title: bindingId });
      store.updateBinding(bindingId, { paneId: `w1:${bindingId}`, state, lifecycle, attachment });
      store.enqueuePrompt({ id: `prompt-${bindingId}`, bindingId, larkMessageId: `message-${bindingId}`, actorOpenId: "u1", body: "must not run" });
    }

    store.createPendingBinding({ id: "active", workspaceId: "w1", chatId: "c1", topicId: "active", rootMessageId: "active", title: "active" });
    store.updateBinding("active", { paneId: "w1:active", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.enqueuePrompt({ id: "private-turn", bindingId: "active", larkMessageId: "private-message", actorOpenId: "u1", body: "private prompt body" });

    expect(store.scanDurablePromptWork()).toEqual({
      cancelled: 2,
      failedDetached: 0,
      hints: [{ kind: "prompt-ready", bindingId: "active" }]
    });
    expect(store.getOperationalSummary().prompts).toMatchObject({ queued: 2, cancelled: 2 });
    expect(store.claimNextDispatchablePrompt("active")).toMatchObject({ prompt: { id: "private-turn", state: "running" } });
    expect(store.listFailures("c1").filter((failure) => failure.kind === "prompt").map((failure) => failure.error)).toEqual([
      "Session can no longer dispatch queued work",
      "Session can no longer dispatch queued work"
    ]);
    expect(JSON.stringify(store.scanDurablePromptWork())).not.toMatch(/private-turn|private-message|private prompt body/);
  });

  it("terminalizes detached running turns owned by terminal bindings", () => {
    store = new SqliteBindingStore(":memory:");
    const terminalCases = [
      ["state-archived", "archived", "active", "attached"],
      ["state-orphaned", "orphaned", "active", "attached"],
      ["state-failed", "failed", "active", "attached"],
      ["lifecycle-archived", "active", "archived", "attached"],
      ["lifecycle-closed", "active", "closed", "attached"],
      ["lifecycle-failed", "active", "failed", "attached"],
      ["attachment-orphaned", "active", "active", "orphaned"]
    ] as const;
    const cases = [...terminalCases, ["active", "active", "active", "attached"] as const];
    for (const [bindingId, state, lifecycle, attachment] of cases) {
      store.createPendingBinding({ id: bindingId, workspaceId: "w1", chatId: "c1", topicId: bindingId, rootMessageId: bindingId, title: bindingId });
      store.updateBinding(bindingId, { paneId: `w1:${bindingId}`, state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "working" });
      store.database.prepare("UPDATE bindings SET state = ?, lifecycle = ?, attachment = ? WHERE id = ?").run(state, lifecycle, attachment, bindingId);
      const promptId = `prompt-${bindingId}`;
      const view = createQueuedRunCard({
        promptId, bindingId, title: bindingId, workspaceId: "w1", paneId: `w1:${bindingId}`,
        requestText: `private-${bindingId}`, queuePosition: 1, occurredAt: "2026-08-29T01:00:00.000Z"
      });
      store.acceptPrompt({
        prompt: { id: promptId, bindingId, larkMessageId: `message-${bindingId}`, actorOpenId: "u1", body: `private-${bindingId}` },
        view, rootMessageId: bindingId, answerCard: {}
      });
      store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'detached', was_detached = ?, transcript_turn_id = ?, transcript_turn_started_at = ? WHERE id = ?").run(bindingId === "state-archived" ? 0 : 1, `turn-${bindingId}`, "2026-08-29T01:00:01.000Z", promptId);
      store.database.prepare("UPDATE run_cards SET phase = 'running', started_at = '2026-08-29T01:00:01.000Z' WHERE prompt_id = ?").run(promptId);
    }

    const result = store.scanDurablePromptWork();
    expect(result).toEqual({
      cancelled: 0, failedDetached: 7,
      hints: [{ kind: "detached-observer-ready", bindingId: "active", promptId: "prompt-active" }]
    });
    const notice = "Session ended while a dispatched turn was detached; the prompt was not replayed";
    for (const [bindingId] of terminalCases) {
      expect(store.getPrompt(`prompt-${bindingId}`)).toMatchObject({
        state: "failed", observationState: "completed", wasDetached: true, error: notice
      });
      expect(store.loadRunCard(`prompt-${bindingId}`)).toMatchObject({
        phase: "failed", notice, queuePosition: 0, viewVersion: 2
      });
      expect(store.loadRunCard(`prompt-${bindingId}`)?.finishedAt).toEqual(expect.any(String));
      expect(store.loadRunCard(`prompt-${bindingId}`)?.activityAt).toEqual(expect.any(String));
    }
    expect(store.getPrompt("prompt-active")).toMatchObject({
      state: "running", observationState: "detached", wasDetached: true
    });
    expect(store.loadRunCard("prompt-active")).toMatchObject({ phase: "running", viewVersion: 1 });

    const versions = terminalCases.map(([bindingId]) => store.loadRunCard(`prompt-${bindingId}`)?.viewVersion);
    expect(store.scanDurablePromptWork()).toEqual({
      cancelled: 0, failedDetached: 0,
      hints: [{ kind: "detached-observer-ready", bindingId: "active", promptId: "prompt-active" }]
    });
    expect(terminalCases.map(([bindingId]) => store.loadRunCard(`prompt-${bindingId}`)?.viewVersion)).toEqual(versions);
    expect(JSON.stringify(result)).not.toMatch(/private-|message-/);
  });

  it("schedules detached observation only for prompts with an exact transcript identity", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "active", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "root", title: "Task" });
    store.updateBinding("active", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached" });
    for (const promptId of ["identityless", "identified"]) {
      store.enqueuePrompt({ id: promptId, bindingId: "active", larkMessageId: `message-${promptId}`, actorOpenId: "u1", body: promptId });
      store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'detached', was_detached = 1 WHERE id = ?").run(promptId);
    }
    store.database.prepare("UPDATE prompt_jobs SET transcript_turn_id = 'turn-1', transcript_turn_started_at = '2026-08-29T01:00:01.000Z' WHERE id = 'identified'").run();

    expect(store.scanDurablePromptWork()).toEqual({
      cancelled: 0,
      failedDetached: 0,
      hints: [{ kind: "detached-observer-ready", bindingId: "active", promptId: "identified" }]
    });
    expect(store.getPrompt("identityless")).toMatchObject({ state: "running", observationState: "detached", transcriptTurnId: null });
  });

  it("rolls back detached Run Card convergence when the prompt transition fails", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "archived", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("archived", { paneId: "w1:p1", state: "archived", lifecycle: "archived", attachment: "attached" });
    const view = createQueuedRunCard({
      promptId: "prompt-archived", bindingId: "archived", title: "Task", workspaceId: "w1", paneId: "w1:p1",
      requestText: "private body", queuePosition: 1, occurredAt: "2026-08-29T01:00:00.000Z"
    });
    store.acceptPrompt({
      prompt: { id: "prompt-archived", bindingId: "archived", larkMessageId: "message-1", actorOpenId: "u1", body: "private body" },
      view, rootMessageId: "m1", answerCard: {}
    });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'detached', was_detached = 1 WHERE id = 'prompt-archived'").run();
    store.database.prepare("UPDATE run_cards SET phase = 'running', started_at = '2026-08-29T01:00:01.000Z' WHERE prompt_id = 'prompt-archived'").run();
    store.database.exec("CREATE TEMP TRIGGER reject_detached_prompt_failure BEFORE UPDATE OF state ON prompt_jobs WHEN OLD.id = 'prompt-archived' AND NEW.state = 'failed' BEGIN SELECT RAISE(ABORT, 'injected detached convergence failure'); END");

    expect(() => store.scanDurablePromptWork()).toThrow(/injected detached convergence failure/);
    expect(store.getPrompt("prompt-archived")).toMatchObject({ state: "running", observationState: "detached", wasDetached: true });
    expect(store.loadRunCard("prompt-archived")).toMatchObject({ phase: "running", notice: null, finishedAt: null, viewVersion: 1 });
  });

  it("does not report an ordinary queued turn while its binding already has a running prompt", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "working" });
    store.enqueuePrompt({ id: "running", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "running" });
    store.enqueuePrompt({ id: "later", bindingId: "b1", larkMessageId: "m3", actorOpenId: "u1", body: "later" });
    store.database.prepare("UPDATE prompt_jobs SET state = 'running', observation_state = 'attached' WHERE id = 'running'").run();

    expect(store.scanDurablePromptWork()).toEqual({ cancelled: 0, failedDetached: 0, hints: [] });
  });

  it("atomically requeues only a stale pre-dispatch claim with no delivery evidence", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    const view = createQueuedRunCard({ promptId: "orphan", bindingId: "b1", title: "Task", workspaceId: "w1", paneId: "w1:p1", requestText: "private", queuePosition: 1, occurredAt: "2026-09-05T00:00:00.000Z" });
    store.acceptPrompt({ prompt: { id: "orphan", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "private" }, view, rootMessageId: "m1", answerCard: {} });
    store.claimNextDispatchablePrompt("b1");
    store.database.prepare("UPDATE prompt_jobs SET updated_at = '2026-09-05T00:00:01.000Z' WHERE id = 'orphan'").run();
    store.database.prepare("UPDATE run_cards SET phase = 'running', started_at = '2026-09-05T00:00:01.000Z' WHERE prompt_id = 'orphan'").run();

    expect(store.listStaleUndispatchedPromptClaims("2026-09-05T00:00:00.999Z", 10)).toEqual([]);
    const [candidate] = store.listStaleUndispatchedPromptClaims("2026-09-05T00:00:02.000Z", 10);
    expect(candidate).toEqual({ promptId: "orphan", bindingId: "b1", updatedAt: "2026-09-05T00:00:01.000Z" });
    expect(store.requeueStaleUndispatchedPromptClaim(candidate!)).toBe(true);
    expect(store.getPrompt("orphan")).toMatchObject({ state: "queued", observationState: "not_started", dispatchedAt: null, transcriptTurnId: null });
    expect(store.loadRunCard("orphan")).toMatchObject({ phase: "queued", startedAt: null, notice: null });
    expect(store.scanDurablePromptWork().hints).toContainEqual({ kind: "prompt-ready", bindingId: "b1" });
    expect(store.requeueStaleUndispatchedPromptClaim(candidate!)).toBe(false);
  });

  it("releases an undispatched claim only behind its exact binding generation and pane fence", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "private" });
    const claimed = store.claimNextDispatchablePrompt("b1")!.prompt;
    const fence = { promptId: "p1", bindingId: "b1", updatedAt: claimed.updatedAt, bindingGeneration: 1, paneId: "w1:p1" };

    expect(store.releaseUndispatchedPromptClaim({ ...fence, bindingGeneration: 2 })).toBe(false);
    expect(store.releaseUndispatchedPromptClaim({ ...fence, paneId: "w1:p2" })).toBe(false);
    expect(store.releaseUndispatchedPromptClaim(fence)).toBe(true);
    expect(store.getPrompt("p1")).toMatchObject({ state: "queued", observationState: "not_started", dispatchedAt: null, transcriptTurnId: null });
    expect(store.releaseUndispatchedPromptClaim(fence)).toBe(false);
  });

  it.each([
    ["dispatch timestamp", "UPDATE prompt_jobs SET dispatched_at = '2026-09-05T00:00:01.500Z' WHERE id = 'p1'"],
    ["transcript identity", "UPDATE prompt_jobs SET transcript_turn_id = 'turn-1' WHERE id = 'p1'"]
  ])("never offers a stale claim with %s for replay", (_label, evidenceSql) => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.enqueuePrompt({ id: "p1", bindingId: "b1", larkMessageId: "m2", actorOpenId: "u1", body: "private" });
    store.claimNextDispatchablePrompt("b1");
    store.database.prepare(evidenceSql).run();
    store.database.prepare("UPDATE prompt_jobs SET updated_at = '2026-09-05T00:00:01.000Z' WHERE id = 'p1'").run();

    expect(store.listStaleUndispatchedPromptClaims("2026-09-05T00:00:02.000Z", 10)).toEqual([]);
  });

  it("deduplicates legacy model controls without blocking ordinary prompt dispatch", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.enqueuePrompt({ id: "turn", bindingId: "b1", larkMessageId: "turn-message", actorOpenId: "u1", body: "ordinary" });
    const first = store.acceptPaneControlOperation({ id: "model-1", idempotencyKey: "message:model", bindingId: "b1", paneId: "w1:p1", terminalId: null, bindingGeneration: 1, kind: "model", actorOpenId: "u1", sourceMessageId: "message" });
    const duplicate = store.acceptPaneControlOperation({ id: "model-2", idempotencyKey: "message:model", bindingId: "b1", paneId: "w1:p1", terminalId: null, bindingGeneration: 1, kind: "model", actorOpenId: "u1", sourceMessageId: "message" });

    expect(first.inserted).toBe(true);
    expect(duplicate).toMatchObject({ inserted: false, operation: { id: "model-1", state: "accepted" } });
    expect(store.claimNextDispatchablePrompt("b1")?.prompt.id).toBe("turn");
    store.updatePrompt("turn", "delivered");
    expect(store.claimNextPaneControlOperation("b1")).toMatchObject({ id: "model-1", state: "running" });
    store.finishPaneControlOperation("model-1", "confirmed");
  });

  it("does not let a late pane-control completion overwrite a terminal outcome", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.acceptPaneControlOperation({ id: "model-1", idempotencyKey: "message:model", bindingId: "b1", paneId: "w1:p1", terminalId: null, bindingGeneration: 1, kind: "model", actorOpenId: "u1", sourceMessageId: "message" });
    store.claimPaneControlOperation("model-1");
    store.finishPaneControlOperation("model-1", "confirmed", "confirmed first");

    store.finishPaneControlOperation("model-1", "uncertain", "late failure");

    expect(store.getPaneControlOperation("model-1")).toMatchObject({ state: "confirmed", detail: "confirmed first" });
  });

  it("commits a pane-control outcome and its user-visible result atomically", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.acceptPaneControlOperation({ id: "model-1", idempotencyKey: "message:model", bindingId: "b1", paneId: "w1:p1", terminalId: null, bindingGeneration: 1, kind: "model", actorOpenId: "u1", sourceMessageId: "message" });
    store.claimPaneControlOperation("model-1");

    store.finishPaneControlWithResult({
      operationId: "model-1", state: "confirmed", detail: "Model selector listed",
      result: { kind: "card_reply", targetMessageId: "m1", idempotencyKey: "model:model-1:confirmed", targetRole: "operation_result", card: { schema: "2.0" } }
    });

    expect(store.getPaneControlOperation("model-1")).toMatchObject({ state: "confirmed", detail: "Model selector listed" });
    expect(store.listPendingOutboundReplies()).toEqual([expect.objectContaining({
      bindingId: "b1", idempotencyKey: "model:model-1:confirmed", kind: "card_reply", rootMessageId: "m1", targetRole: "operation_result"
    })]);
  });

  it("atomically checkpoints a delivered session-status card and its binding target", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const reply = store.enqueueOutboundReply({
      id: "status-1", idempotencyKey: "status-card:b1", bindingId: "b1", targetRole: "session_status",
      rootMessageId: "m1", kind: "card_reply", payload: "{}"
    });

    store.markOutboundReplyDelivered(reply.id, "status-message-1");

    expect(store.getBinding("b1")?.statusMessageId).toBe("status-message-1");
    expect(store.database.prepare("SELECT state, delivered_message_id FROM outbound_replies WHERE id = ?").get(reply.id)).toEqual({ state: "delivered", delivered_message_id: "status-message-1" });
  });

  it("rolls back a status-card delivery checkpoint when its binding target cannot be updated", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    const reply = store.enqueueOutboundReply({
      id: "status-1", idempotencyKey: "status-card:b1", bindingId: "b1", targetRole: "session_status",
      rootMessageId: "m1", kind: "card_reply", payload: "{}"
    });
    store.database.exec("CREATE TRIGGER reject_status_pointer BEFORE UPDATE OF status_message_id ON bindings BEGIN SELECT RAISE(ABORT, 'reject status pointer'); END");

    expect(() => store!.markOutboundReplyDelivered(reply.id, "status-message-1")).toThrow(/reject status pointer/);

    expect(store.getBinding("b1")?.statusMessageId).toBeNull();
    expect(store.database.prepare("SELECT state, delivered_message_id FROM outbound_replies WHERE id = ?").get(reply.id)).toEqual({ state: "pending", delivered_message_id: null });
  });

  it("rolls back the pane-control outcome when its result intent cannot be persisted", () => {
    store = new SqliteBindingStore(":memory:");
    store.createPendingBinding({ id: "b1", workspaceId: "w1", chatId: "c1", topicId: "t1", rootMessageId: "m1", title: "Task" });
    store.updateBinding("b1", { paneId: "w1:p1", state: "active", lifecycle: "active", attachment: "attached", lastAgentState: "idle" });
    store.acceptPaneControlOperation({ id: "model-1", idempotencyKey: "message:model", bindingId: "b1", paneId: "w1:p1", terminalId: null, bindingGeneration: 1, kind: "model", actorOpenId: "u1", sourceMessageId: "message" });
    store.claimPaneControlOperation("model-1");
    const circular: Record<string, unknown> = {};
    circular.self = circular;

    expect(() => store!.finishPaneControlWithResult({
      operationId: "model-1", state: "confirmed", detail: "must roll back",
      result: { kind: "card_reply", targetMessageId: "m1", idempotencyKey: "model:model-1:confirmed", targetRole: "operation_result", card: circular }
    })).toThrow(/circular/i);

    expect(store.getPaneControlOperation("model-1")).toMatchObject({ state: "running", detail: null });
    expect(store.listPendingOutboundReplies()).toEqual([]);
  });
});
