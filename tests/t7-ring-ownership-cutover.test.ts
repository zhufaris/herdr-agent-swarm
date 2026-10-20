import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutboundReply } from "../src/domain/types.js";
import type { OutboundReplyKind, PreparedDelivery, PreparedDeliveryPlan } from "../src/domain/delivery.js";
import { RingDeliveryEngine } from "../src/events/ring-delivery-engine.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";
import { convergeAfterRingAcknowledgement } from "../src/composition/create-outbound-runtime.js";
import { DeliveryCheckpointBus } from "../src/events/delivery-checkpoint-bus.js";

let store: SqliteBindingStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

function openStore(): SqliteBindingStore {
  store = new SqliteBindingStore(":memory:");
  store.setGatewayPlanPreparer((reply: OutboundReply): PreparedDeliveryPlan => ({
    protocolVersion: 1,
    gatewayId: reply.gatewayId,
    profileId: reply.gatewayProfileId,
    rendererRevision: 1,
    operation: "message.reply.view",
    intent: {
      kind: "message.reply.view",
      purpose: "operation-result",
      rootMessageId: reply.rootMessageId!,
      view: { schemaVersion: 1, nodes: [] },
      idempotencyKey: reply.idempotencyKey
    }
  }));
  store.createPendingBinding({
    id: "binding",
    workspaceId: "workspace",
    chatId: "chat",
    topicId: "topic",
    rootMessageId: "root",
    title: "Task"
  });
  store.updateBinding("binding", {
    state: "active",
    lifecycle: "active",
    attachment: "attached",
    paneId: "pane"
  });
  return store;
}

function primaryInput(id: string) {
  return {
    id,
    idempotencyKey: id,
    bindingId: "binding",
    bindingGeneration: 1,
    targetRole: "operation_result" as const,
    rootMessageId: "root",
    kind: "card_reply" as const,
    payload: "{}"
  };
}

function preparedForAcknowledgement(replyId: string): PreparedDelivery {
  return {
    replyId,
    scope: { kind: "pane", workspaceId: "workspace", paneId: "pane" },
    ownerFence: { kind: "primary", id: "binding", generation: 1, sessionGeneration: 1 },
    deliveryOrder: 1,
    workClass: "live",
    idempotencyKey: replyId,
    gatewayId: "feishu:primary",
    gatewayProfileId: "feishu-cardkit-v1",
    preparedPlan: {
      protocolVersion: 1,
      gatewayId: "feishu:primary",
      profileId: "feishu-cardkit-v1",
      rendererRevision: 1,
      operation: "surface.replace",
      intent: { kind: "surface.replace" }
    },
    planHash: "plan",
    projectionKey: null,
    snapshotRevision: 1,
    rendererRevision: 1,
    cardSequence: null,
    priorCheckpoints: [],
    nextAttemptAt: "2026-10-06T00:00:00.000Z",
    estimatedBytes: 1
  };
}

describe("T7 Ring ownership cutover", () => {
  it("atomically hands off a pristine prepared Primary Pane delivery", () => {
    const target = openStore();

    const receipt = target.reservePreparedOutboundReply(primaryInput("primary"));

    expect(receipt.consumeEffects()).toEqual([
      expect.objectContaining({
        replyId: "primary",
        conflictKey: "gateway:feishu:primary:reply:primary",
        scope: { kind: "pane", workspaceId: "workspace", paneId: "pane" }
      })
    ]);
    expect(target.getOutboundReply("primary")).toMatchObject({
      conflictKey: "gateway:feishu:primary:reply:primary"
    });
  });

  it("does not hand off a same-key delivery with an active attempt", () => {
    const target = openStore();
    target.reservePreparedOutboundReply(primaryInput("active")).consumeEffects();
    target.database.prepare(`UPDATE outbound_replies SET
      claim_attempt_id='active-attempt',claimed_owner_id='active-owner',claimed_fence=7,
      claimed_at='2026-10-06T00:00:00.000Z',first_claimed_at='2026-10-06T00:00:00.000Z'
      WHERE id='active'`).run();

    const replay = target.reservePreparedOutboundReply(primaryInput("active"));

    expect(replay.consumeEffects()).toEqual([expect.objectContaining({ replyId: "active" })]);
    expect(target.database.prepare("SELECT claim_attempt_id FROM outbound_replies WHERE id='active'").get()).toEqual({
      claim_attempt_id: "active-attempt"
    });
  });

  it("does not hand off a same-key uncertain delivery", () => {
    const target = openStore();
    target.reservePreparedOutboundReply(primaryInput("uncertain")).consumeEffects();
    target.database.prepare(`UPDATE outbound_replies SET state='dead_letter',
      claim_attempt_id=NULL,claimed_owner_id=NULL,claimed_fence=NULL,claimed_at=NULL,
      first_claimed_at='2026-10-06T00:00:00.000Z',attempt_count=1,
      failure_class='unknown',effect_certainty='uncertain',dead_lettered_at='2026-10-06T00:01:00.000Z'
      WHERE id='uncertain'`).run();

    const replay = target.reservePreparedOutboundReply(primaryInput("uncertain"));

    expect(replay.consumeEffects()).toEqual([]);
    expect(target.database.prepare("SELECT state,effect_certainty FROM outbound_replies WHERE id='uncertain'").get()).toEqual({
      state: "dead_letter",
      effect_certainty: "uncertain"
    });
  });

  it("hands true Global reservations to the Global Ring", () => {
    const target = openStore();

    const receipt = target.reservePreparedOutboundReply({
      id: "global",
      idempotencyKey: "global",
      rootMessageId: "root",
      kind: "card_reply",
      payload: "{}"
    });

    expect(receipt.consumeEffects()).toEqual([
      expect.objectContaining({ replyId: "global", scope: { kind: "global" } })
    ]);
  });

  it("executes and settles a non-Turn Primary family through the Ring", async () => {
    const target = openStore();
    const delivery = target.reservePreparedOutboundReply(primaryInput("operation-result")).consumeEffects()[0]!;
    const lease = target.acquireInstanceLease("owner", "2026-10-06T00:00:00.000Z", "2099-01-01T00:00:00.000Z")!;
    target.activateWriteFence(lease.ownerId, lease.fencingToken);
    let acknowledge!: () => void;
    const acknowledged = new Promise<void>((resolve) => { acknowledge = resolve; });
    const engine = new RingDeliveryEngine({
      store: target.preparedDeliveries,
      gateway: {
        prepare: () => { throw new Error("prepared plan must be reused"); },
        execute: async (_plan, context) => {
          await context.checkpoint({ kind: "surface", ref: { gatewayId: "feishu:primary", kind: "surface", opaqueId: "card" } });
          return { refs: [{ kind: "message", opaqueId: "message" }, { kind: "surface", opaqueId: "card" }] };
        }
      },
      coldRecoveryEnabled: false,
      onAcknowledged: acknowledge
    });

    engine.start();
    engine.enqueue(delivery);
    await acknowledged;
    await engine.stop();

    expect(target.getOutboundReply("operation-result")).toMatchObject({
      state: "delivered",
      deliveredMessageId: "message",
      cardIdCheckpoint: "card",
      attemptCount: 1
    });
    expect(target.database.prepare(`SELECT claim_attempt_id,claimed_owner_id,claimed_fence,claimed_at,claim_expires_at
      FROM outbound_replies WHERE id='operation-result'`).get()).toEqual({
      claim_attempt_id: null,
      claimed_owner_id: null,
      claimed_fence: null,
      claimed_at: null,
      claim_expires_at: null
    });
  });

  it("applies the durable retry protocol to a non-Turn Primary failure", () => {
    const target = openStore();
    const delivery = target.reservePreparedOutboundReply(primaryInput("retrying")).consumeEffects()[0]!;
    const lease = target.acquireInstanceLease("owner", "2026-10-06T00:00:00.000Z", "2099-01-01T00:00:00.000Z")!;
    target.activateWriteFence(lease.ownerId, lease.fencingToken);
    const claim = target.preparedDeliveries.claimPreparedDelivery({
      delivery,
      at: "2098-10-06T00:00:00.000Z",
      expiresAt: "2098-10-06T00:01:00.000Z"
    })!;

    expect(target.preparedDeliveries.failPreparedDelivery(claim, {
      error: "retry me",
      retryAt: "2098-10-06T00:02:00.000Z",
      metadata: { failureClass: "transient", effectCertainty: "not-started", httpStatus: null, larkErrorCode: null }
    })).toBe("retry");
    expect(target.getOutboundReply("retrying")).toMatchObject({
      state: "pending",
      attemptCount: 1,
      failureClass: "transient",
      effectCertainty: "not-started"
    });
    expect(target.database.prepare(`SELECT claim_attempt_id,claimed_owner_id,claimed_fence,claimed_at,claim_expires_at
      FROM outbound_replies WHERE id='retrying'`).get()).toEqual({
      claim_attempt_id: null,
      claimed_owner_id: null,
      claimed_fence: null,
      claimed_at: null,
      claim_expires_at: null
    });
  });

  it("persists an uncertainty quarantine with its frozen conflict identity and budget", () => {
    const target = openStore();
    const delivery = target.reservePreparedOutboundReply(primaryInput("uncertain-budget")).consumeEffects()[0]!;
    const lease = target.acquireInstanceLease("owner", "2026-10-06T00:00:00.000Z", "2099-01-01T00:00:00.000Z")!;
    target.activateWriteFence(lease.ownerId, lease.fencingToken);
    const claim = target.preparedDeliveries.claimPreparedDelivery({
      delivery,
      at: "2098-10-06T00:00:00.000Z",
      expiresAt: "2098-10-06T00:01:00.000Z"
    })!;

    expect(target.preparedDeliveries.failPreparedDelivery(claim, {
      error: "unknown remote outcome",
      retryAt: "2098-10-06T00:02:00.000Z",
      metadata: { failureClass: "unknown", effectCertainty: "uncertain", httpStatus: null, larkErrorCode: null }
    })).toBe("dead_letter");
    const quarantine = target.database.prepare(`SELECT conflict_key,phase,first_failed_at,grace_deadline_at,
      degraded_at,budget_attempt_limit,budget_duration_ms FROM outbox_lane_quarantines
      WHERE failed_reply_id='uncertain-budget'`).get() as Record<string, unknown>;
    expect(quarantine).toMatchObject({
      conflict_key: "gateway:feishu:primary:reply:uncertain-budget",
      phase: "grace_blocking",
      degraded_at: null,
      budget_attempt_limit: 0,
      budget_duration_ms: 60_000
    });
    expect(Date.parse(String(quarantine.grace_deadline_at)) - Date.parse(String(quarantine.first_failed_at))).toBe(60_000);
  });

  it("classifies legacy actionable Deliveries in bounded resumable pages", () => {
    const target = openStore();
    target.reservePreparedOutboundReply(primaryInput("legacy-a")).consumeEffects();
    target.reservePreparedOutboundReply(primaryInput("legacy-b")).consumeEffects();
    target.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
    target.database.exec("UPDATE outbound_replies SET conflict_key=NULL WHERE id IN ('legacy-a','legacy-b')");

    expect(target.preparedDeliveries.backfillLegacyConflictKeys(1)).toEqual({ processedCount: 1, hasMore: true });
    expect(target.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE conflict_key IS NULL").get()).toEqual({ count: 1 });
    expect(target.preparedDeliveries.backfillLegacyConflictKeys(1)).toEqual({ processedCount: 1, hasMore: false });
    expect(target.database.prepare("SELECT id,conflict_key FROM outbound_replies ORDER BY id").all()).toEqual([
      { id: "legacy-a", conflict_key: "gateway:feishu:primary:reply:legacy-a" },
      { id: "legacy-b", conflict_key: "gateway:feishu:primary:reply:legacy-b" }
    ]);
  });

  it.each(["stream_card_create", "stream_content", "stream_finish"] as const)("immediately converges the Answer after a Ring ACK for %s", async (kind) => {
    const answerConverge = vi.fn(async () => {});
    const mainConverge = vi.fn(async () => {});
    const turnConverge = vi.fn(async () => {});
    const checkpoints = new DeliveryCheckpointBus();
    checkpoints.onAnswerCheckpoint(answerConverge);
    checkpoints.onMainCardCheckpoint(mainConverge);
    checkpoints.onTurnCardRecoveryCheckpoint(turnConverge);
    convergeAfterRingAcknowledgement(preparedForAcknowledgement(`answer-${kind}`), {
      messageId: "answer-message", surfaceId: "answer-card", threadId: null
    }, {
      outbox: { getOutboundReply: () => ({ kind, cardRole: "answer", promptId: "prompt", targetRole: null, bindingId: "binding" }) as OutboundReply, recordBridgeMessage: vi.fn() },
      checkpoints
    });
    await Promise.resolve();

    expect(answerConverge).toHaveBeenCalledOnce();
    expect(answerConverge).toHaveBeenCalledWith("prompt", kind === "stream_card_create" ? 1 : 0);
    expect(mainConverge).not.toHaveBeenCalled();
    expect(turnConverge).not.toHaveBeenCalled();
  });

  it("immediately converges the latest Main view after a Ring ACK", async () => {
    const answerConverge = vi.fn(async () => {});
    const mainConverge = vi.fn(async () => {});
    const checkpoints = new DeliveryCheckpointBus();
    checkpoints.onAnswerCheckpoint(answerConverge);
    checkpoints.onMainCardCheckpoint(mainConverge);
    convergeAfterRingAcknowledgement(preparedForAcknowledgement("main-update"), {
      messageId: "main-message", surfaceId: "main-card", threadId: null
    }, {
      outbox: { getOutboundReply: () => ({ kind: "card_update" as OutboundReplyKind, cardRole: null, promptId: null, targetRole: "session_status", bindingId: "binding" }) as OutboundReply, recordBridgeMessage: vi.fn() },
      checkpoints
    });
    await Promise.resolve();

    expect(mainConverge).toHaveBeenCalledOnce();
    expect(mainConverge).toHaveBeenCalledWith("binding", 0);
    expect(answerConverge).not.toHaveBeenCalled();
  });

  it("dismisses a recovery replacement whose durable recovery target changed before claim", () => {
    const target = openStore();
    target.enqueueOutboundReply({ id: "failed", idempotencyKey: "failed", rootMessageId: "root", kind: "text", payload: "failed" });
    target.database.prepare(`UPDATE outbound_replies SET state='dead_letter',failure_class='permanent',effect_certainty='rejected',
      error='failed',dead_lettered_at='2026-10-06T00:00:00.000Z' WHERE id='failed'`).run();
    const delivery = target.reservePreparedOutboundReply(primaryInput("replacement")).consumeEffects()[0]!;
    target.database.prepare(`UPDATE delivery_recoveries SET state='replacement_pending',action='rebuild_answer',replacement_reply_id='replacement'
      WHERE failed_reply_id='failed'`).run();
    const lease = target.acquireInstanceLease("owner", "2026-10-06T00:00:00.000Z", "2099-01-01T00:00:00.000Z")!;
    target.activateWriteFence(lease.ownerId, lease.fencingToken);
    target.database.prepare(`UPDATE delivery_recoveries SET state='recovered',resolved_by_reply_id='replacement',resolved_at='2026-10-06T00:01:00.000Z'
      WHERE failed_reply_id='failed'`).run();

    expect(target.preparedDeliveries.claimPreparedDelivery({
      delivery,
      at: "2098-10-06T00:00:00.000Z",
      expiresAt: "2098-10-06T00:01:00.000Z"
    })).toBeNull();
    expect(target.getOutboundReply("replacement")).toMatchObject({
      state: "dismissed",
      error: "Dismissed stale Ring delivery before Gateway execution"
    });
    expect(target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 10, at: "2098-10-06T00:00:00.000Z" }).items)
      .not.toEqual(expect.arrayContaining([expect.objectContaining({ replyId: "replacement" })]));
  });
});
