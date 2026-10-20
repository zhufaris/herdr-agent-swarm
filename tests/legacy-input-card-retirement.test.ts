import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import type { AdmitSubmissionIntentInput } from "../src/domain/submission-intent.js";
import type { DeliveryFailureMetadata } from "../src/domain/types.js";
import { prepareOutboundGatewayIntent } from "../src/events/outbound-gateway-intent.js";
import { createTestStoreBundle } from "./helpers/create-test-store-bundle.js";

describe("Legacy Input Card retirement", () => {
  it("reserves one durable delete for an ownership-proven terminal card across competing scans", () => {
    const directory = mkdtempSync(join(tmpdir(), "legacy-input-card-retirement-"));
    const path = join(directory, "bridge.db");
    const first = createPreparedTestStoreBundle(path);
    const second = createPreparedTestStoreBundle(path);
    try {
      admitDeliveredLegacyCard(first, "submission-terminal", "source-terminal", "legacy-message-terminal");
      observeCanonicalTurn(first, "submission-terminal", "source-terminal", "turn-terminal");
      first.agentInputs.recordReceipt("submission-terminal", terminalReceipt("submission-terminal", "turn-terminal"));

      admitDeliveredLegacyCard(first, "submission-pending", "source-pending", "legacy-message-pending");
      admitDeliveredLegacyCard(first, "submission-accepted", "source-accepted", "legacy-message-accepted");
      first.agentInputs.claimRecorded("submission-accepted", "2026-10-04T00:00:01.000Z");
      first.agentInputs.recordReceipt("submission-accepted", {
        ...terminalReceipt("submission-accepted", "turn-accepted"),
        state: "observed",
        terminalState: null,
        updatedAt: 2
      });

      expect(first.legacyInputCards.scan(16)).toBe(1);
      expect(second.legacyInputCards.scan(16)).toBe(0);

      expect(first.driver.database.prepare(`SELECT submission_id, gateway_id, message_id, outbound_reply_id, state
        FROM legacy_input_card_retirements ORDER BY submission_id`).all()).toEqual([{
        submission_id: "submission-terminal",
        gateway_id: "feishu:primary",
        message_id: "legacy-message-terminal",
        outbound_reply_id: "legacy-input-card-delete:submission-terminal",
        state: "deleting"
      }]);
      expect(first.driver.database.prepare(`SELECT id, idempotency_key, gateway_id, root_message_id, kind, state
        FROM outbound_replies WHERE kind='message_delete' ORDER BY id`).all()).toEqual([{
        id: "legacy-input-card-delete:submission-terminal",
        idempotency_key: "legacy-input-card-delete:submission-terminal",
        gateway_id: "feishu:primary",
        root_message_id: "legacy-message-terminal",
        kind: "message_delete",
        state: "pending"
      }]);
      expect(first.driver.database.prepare("SELECT version FROM schema_migrations WHERE version=103").get()).toEqual({ version: 103 });
    } finally {
      second.lifecycle.close();
      first.lifecycle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it.each(["deleted", "already_absent"] as const)("retires only after the exact delete is acknowledged as %s", (outcome) => {
    const stores = createPreparedTestStoreBundle();
    admitDeliveredLegacyCard(stores, "submission-terminal", "source-terminal", "legacy-message-terminal");
    observeCanonicalTurn(stores, "submission-terminal", "source-terminal", "turn-terminal");
    deliverPendingInputCardUpdates(stores, "submission-terminal", "legacy-message-terminal");
    stores.agentInputs.recordReceipt("submission-terminal", terminalReceipt("submission-terminal", "turn-terminal"));
    stores.legacyInputCards.scan(16);

    const deletion = stores.outbox.getOutboundReply("legacy-input-card-delete:submission-terminal");
    if (!deletion) throw new Error("Missing legacy Input Card deletion");
    const claim = claimPrepared(stores, deletion.id);
    expect(stores.preparedDeliveries.acknowledgePreparedDelivery(claim, {
      messageId: deletion.rootMessageId!, surfaceId: null, threadId: null, messageDeleteOutcome: outcome
    })).toBe(true);

    expect(stores.legacyInputCards.get("submission-terminal")).toMatchObject({
      state: "retired",
      outcome,
      retiredAt: expect.any(String)
    });
    expect(stores.legacyInputCards.scan(16)).toBe(0);
    stores.lifecycle.close();
  });

  it("keeps retryable deletion pending and records terminal failure without claiming retirement", () => {
    const retryable = preparedRetirement();
    const retryReply = retryable.outbox.getOutboundReply("legacy-input-card-delete:submission-terminal")!;
    const retryClaim = claimPrepared(retryable, retryReply.id);
    expect(retryable.preparedDeliveries.failPreparedDelivery(retryClaim, failure("gateway unavailable", {
      failureClass: "transient", effectCertainty: "rejected", httpStatus: 503, larkErrorCode: null
    }))).toBe("retry");
    expect(retryable.outbox.getOutboundReply(retryReply.id)).toMatchObject({ state: "pending" });
    expect(retryable.legacyInputCards.get("submission-terminal")).toMatchObject({ state: "deleting", outcome: null });
    retryable.lifecycle.close();

    const permanent = preparedRetirement();
    const failedReply = permanent.outbox.getOutboundReply("legacy-input-card-delete:submission-terminal")!;
    const failedClaim = claimPrepared(permanent, failedReply.id);
    expect(permanent.preparedDeliveries.failPreparedDelivery(failedClaim, failure("withdrawal forbidden", {
      failureClass: "permanent", effectCertainty: "rejected", httpStatus: 403, larkErrorCode: "230099"
    }))).toBe("dead_letter");
    expect(permanent.legacyInputCards.get("submission-terminal")).toMatchObject({
      state: "failed", outcome: "failed", retiredAt: null, detail: "withdrawal forbidden"
    });
    permanent.lifecycle.close();
  });

  it("keeps a rejected historical message delete quarantined for conservative review", () => {
    const stores = preparedRetirement("custom:primary");
    const deletion = stores.outbox.getOutboundReply("legacy-input-card-delete:submission-terminal")!;
    expect(deletion.gatewayId).toBe("custom:primary");
    expect(deletion.gatewayProfileId).toBe("feishu-cardkit-v1");
    const claim = claimPrepared(stores, deletion.id);
    stores.preparedDeliveries.failPreparedDelivery(claim, failure("message expired", {
      failureClass: "permanent", effectCertainty: "rejected", httpStatus: 400, larkErrorCode: "230009"
    }));

    expect(stores.legacyInputCards.get("submission-terminal")).toMatchObject({ state: "failed", outcome: "failed" });
    stores.legacyInputCards.settle({ outboundReplyId: deletion.id, outcome: "already_absent" });
    expect(stores.legacyInputCards.get("submission-terminal")).toMatchObject({ state: "failed", outcome: "failed" });
    expect(stores.outbox.getOutboundReply(deletion.id)).toMatchObject({
      state: "dead_letter", failureClass: "permanent", effectCertainty: "rejected", larkErrorCode: "230009"
    });
    expect(stores.driver.recoverStaleOutboxQuarantines()).not.toHaveProperty("retiredExpiredMessageDeletes");
    expect(stores.legacyInputCards.get("submission-terminal")).toMatchObject({
      state: "failed", outcome: "failed", retiredAt: null
    });
    expect(stores.outbox.getOutboundReply(deletion.id)).toMatchObject({ state: "dead_letter", effectCertainty: "rejected" });
    expect(stores.driver.database.prepare("SELECT state, action FROM delivery_recoveries WHERE failed_reply_id = ?").get(deletion.id)).toEqual({
      state: "unresolved", action: "blocked"
    });
    expect(stores.driver.database.prepare("SELECT state, action FROM outbox_lane_quarantines WHERE failed_reply_id = ?").get(deletion.id)).toEqual({
      state: "active", action: "blocked"
    });
    stores.lifecycle.close();
  });

  it("keeps an uncertain expired-message delete failed for human review", () => {
    const stores = preparedRetirement();
    const deletion = stores.outbox.getOutboundReply("legacy-input-card-delete:submission-terminal")!;
    const claim = claimPrepared(stores, deletion.id);
    stores.preparedDeliveries.failPreparedDelivery(claim, failure("delete outcome unknown", {
      failureClass: "permanent", effectCertainty: "uncertain", httpStatus: 400, larkErrorCode: "230009"
    }));

    expect(stores.driver.recoverStaleOutboxQuarantines()).not.toHaveProperty("retiredExpiredMessageDeletes");
    expect(stores.legacyInputCards.get("submission-terminal")).toMatchObject({
      state: "failed", outcome: "failed", retiredAt: null
    });
    expect(stores.outbox.getOutboundReply(deletion.id)).toMatchObject({ state: "dead_letter", effectCertainty: "uncertain" });
    stores.lifecycle.close();
  });

  it("ignores mismatched and contradictory settlement callbacks", () => {
    const stores = preparedRetirement();
    expect(stores.legacyInputCards.settle({ outboundReplyId: "legacy-input-card-delete:other", outcome: "deleted" })).toBeNull();
    expect(stores.legacyInputCards.get("submission-terminal")).toMatchObject({ state: "deleting", outcome: null });

    const deletion = stores.outbox.getOutboundReply("legacy-input-card-delete:submission-terminal")!;
    const claim = claimPrepared(stores, deletion.id);
    stores.preparedDeliveries.acknowledgePreparedDelivery(claim, {
      messageId: deletion.rootMessageId!, surfaceId: null, threadId: null, messageDeleteOutcome: "deleted"
    });
    stores.legacyInputCards.settle({ outboundReplyId: deletion.id, outcome: "failed", detail: "late contradiction" });
    expect(stores.legacyInputCards.get("submission-terminal")).toMatchObject({ state: "retired", outcome: "deleted", detail: null });
    stores.lifecycle.close();
  });

  it("fails closed for missing targets and conflicting route evidence", () => {
    const stores = createPreparedTestStoreBundle();
    ensurePrimaryBinding(stores);
    stores.driver.capabilityModules().agentInputs.admitLegacyPendingCard(submission("submission-missing", "source-missing"), {
      rootMessageId: "root-1", pendingCard: {}, workingCard: {}
    });
    observeCanonicalTurn(stores, "submission-missing", "source-missing", "turn-missing");
    stores.agentInputs.recordReceipt("submission-missing", terminalReceipt("submission-missing", "turn-missing"));

    admitDeliveredLegacyCard(stores, "submission-conflict", "source-conflict", "legacy-message-conflict");
    observeCanonicalTurn(stores, "submission-conflict", "source-conflict", "turn-conflict");
    stores.agentInputs.recordReceipt("submission-conflict", terminalReceipt("submission-conflict", "turn-conflict"));
    stores.driver.database.prepare("UPDATE input_card_views SET root_message_id='conflicting-root' WHERE submission_id='submission-conflict'").run();

    admitDeliveredLegacyCard(stores, "submission-incomplete", "source-incomplete", "legacy-message-incomplete");
    observeCanonicalTurn(stores, "submission-incomplete", "source-incomplete", "turn-incomplete", false);
    stores.agentInputs.recordReceipt("submission-incomplete", terminalReceipt("submission-incomplete", "turn-incomplete"));

    expect(stores.legacyInputCards.scan(16)).toBe(0);
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM legacy_input_card_retirements").get()).toEqual({ count: 0 });
    expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE kind='message_delete'").get()).toEqual({ count: 0 });
    stores.lifecycle.close();
  });

  it("does not emit a delete during migration and resumes the same candidate after reopen", () => {
    const directory = mkdtempSync(join(tmpdir(), "legacy-input-card-migration-"));
    const path = join(directory, "bridge.db");
    let stores = createPreparedTestStoreBundle(path);
    try {
      admitDeliveredLegacyCard(stores, "submission-terminal", "source-terminal", "legacy-message-terminal");
      observeCanonicalTurn(stores, "submission-terminal", "source-terminal", "turn-terminal");
      stores.agentInputs.recordReceipt("submission-terminal", terminalReceipt("submission-terminal", "turn-terminal"));
      stores.lifecycle.close();

      stores = createPreparedTestStoreBundle(path);
      expect(stores.driver.database.prepare("SELECT version FROM schema_migrations WHERE version=103").get()).toEqual({ version: 103 });
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE kind='message_delete'").get()).toEqual({ count: 0 });
      expect(stores.legacyInputCards.scan(16)).toBe(1);
      stores.lifecycle.close();

      stores = createPreparedTestStoreBundle(path);
      expect(stores.legacyInputCards.scan(16)).toBe(0);
      expect(stores.driver.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE kind='message_delete'").get()).toEqual({ count: 1 });
    } finally {
      try { stores.lifecycle.close(); } catch {}
      rmSync(directory, { recursive: true, force: true });
    }
  });
});

function preparedRetirement(gatewayId = "feishu:primary"): ReturnType<typeof createTestStoreBundle> {
  const stores = createPreparedTestStoreBundle();
  admitDeliveredLegacyCard(stores, "submission-terminal", "source-terminal", "legacy-message-terminal", gatewayId);
  observeCanonicalTurn(stores, "submission-terminal", "source-terminal", "turn-terminal");
  deliverPendingInputCardUpdates(stores, "submission-terminal", "legacy-message-terminal");
  stores.agentInputs.recordReceipt("submission-terminal", terminalReceipt("submission-terminal", "turn-terminal"));
  stores.legacyInputCards.scan(16);
  return stores;
}

function createPreparedTestStoreBundle(path = ":memory:"): ReturnType<typeof createTestStoreBundle> {
  const stores = createTestStoreBundle(path);
  stores.outbox.setGatewayPlanPreparer((reply) => {
    const intent = prepareOutboundGatewayIntent(stores.outbox, reply).intent;
    return {
      protocolVersion: 1,
      gatewayId: reply.gatewayId,
      profileId: reply.gatewayProfileId,
      rendererRevision: reply.rendererRevision ?? 1,
      operation: intent.kind,
      intent
    };
  });
  stores.preparedDeliveryProducers.connectPreparedDeliveryProducers(stores.outbox, { enqueuePreparedDelivery() {} });
  return stores;
}

function claimPrepared(stores: ReturnType<typeof createTestStoreBundle>, replyId: string) {
  activatePreparedClaimFence(stores);
  const reply = stores.outbox.getOutboundReply(replyId);
  if (!reply) throw new Error(`Missing outbound reply ${replyId}`);
  const intent = prepareOutboundGatewayIntent(stores.outbox, reply).intent;
  const plan = {
    protocolVersion: 1 as const,
    gatewayId: reply.gatewayId,
    profileId: reply.gatewayProfileId,
    rendererRevision: reply.rendererRevision ?? 1,
    operation: intent.kind,
    intent
  };
  stores.outbox.prepareOutboundGatewayPlan(replyId, {
    gatewayId: reply.gatewayId,
    gatewayProfileId: reply.gatewayProfileId,
    gatewayPlanJson: JSON.stringify(plan)
  });
  const hydrated = stores.preparedDeliveries.hydratePreparedDelivery(replyId);
  if (hydrated.status !== "prepared") throw new Error(`Could not hydrate ${replyId}: ${JSON.stringify(hydrated)}`);
  const claim = stores.preparedDeliveries.claimPreparedDelivery({
    delivery: hydrated.delivery,
    at: "2098-10-06T00:00:00.000Z",
    expiresAt: "2098-10-06T00:01:00.000Z"
  });
  if (!claim) throw new Error(`Could not claim prepared delivery ${replyId}`);
  return claim;
}

function activatePreparedClaimFence(stores: ReturnType<typeof createTestStoreBundle>): void {
  const existing = stores.driver.database.prepare("SELECT name FROM sqlite_temp_master WHERE type='table' AND name='bridge_write_fence'").get();
  if (existing) return;
  const lease = stores.lease.acquireInstanceLease("legacy-input-card-test", "2026-10-06T00:00:00.000Z", "2099-01-01T00:00:00.000Z");
  if (!lease) throw new Error("Could not acquire prepared-delivery test lease");
  stores.lifecycle.activateWriteFence(lease.ownerId, lease.fencingToken);
}

function failure(error: string, metadata: DeliveryFailureMetadata) {
  return { error, metadata, retryAt: "2098-10-06T00:00:01.000Z" };
}

function deliverPendingInputCardUpdates(
  stores: ReturnType<typeof createTestStoreBundle>,
  submissionId: string,
  deliveredMessageId: string
): void {
  for (const reply of stores.driver.listPendingOutboundReplies().filter((candidate) =>
    candidate.kind !== "message_delete" && (candidate.projectionKey === `input-card:${submissionId}` || candidate.projectionKey?.startsWith("turn-card:")))) {
    stores.driver.markOutboundReplyDelivered(reply.id, deliveredMessageId);
  }
}

function admitDeliveredLegacyCard(
  stores: ReturnType<typeof createTestStoreBundle>,
  submissionId: string,
  sourceMessageKey: string,
  deliveredMessageId: string,
  gatewayId = "feishu:primary"
): void {
  ensurePrimaryBinding(stores, gatewayId);
  stores.driver.capabilityModules().agentInputs.admitLegacyPendingCard(submission(submissionId, sourceMessageKey, gatewayId), {
    rootMessageId: "root-1",
    pendingCard: { schema: "2.0", title: "legacy input" },
    workingCard: { schema: "2.0", title: "legacy working" }
  });
  const create = stores.driver.listPendingOutboundReplies().find((reply) => reply.projectionKey === `input-card:${submissionId}`);
  if (!create) throw new Error(`Missing legacy Input Card create for ${submissionId}`);
  stores.driver.markOutboundReplyDelivered(create.id, deliveredMessageId, `card-${submissionId}`);
}

function ensurePrimaryBinding(stores: ReturnType<typeof createTestStoreBundle>, gatewayId = "feishu:primary"): void {
  if (stores.driver.database.prepare("SELECT 1 FROM bindings WHERE id='binding-1'").get()) return;
  stores.driver.createPendingBinding({ id: "binding-1", gatewayId, workspaceId: "workspace-1", chatId: "chat-1", topicId: "topic-1", rootMessageId: "root-1", title: "Primary" });
  stores.driver.updateBinding("binding-1", { generation: 3, state: "active", lifecycle: "active", attachment: "attached", paneId: "workspace-1:pane-1" });
}

function observeCanonicalTurn(
  stores: ReturnType<typeof createTestStoreBundle>,
  submissionId: string,
  sourceMessageKey: string,
  turnId: string,
  terminal = true
): void {
  stores.agentInputs.claimRecorded(submissionId, "2026-10-04T00:00:01.000Z");
  stores.coreEvents.ingestBatch({
    laneId: "lane-primary",
    sourceId: "source-1",
    agentKind: "traex",
    sessionId: "session-1",
    afterCursor: "",
    nextCursor: `cursor-${sourceMessageKey}-2`,
    latestCursor: `cursor-${sourceMessageKey}-2`,
    ingestedAt: "2026-10-04T00:00:02.000Z",
    events: [
      {
        schemaVersion: 1,
        eventId: `human-${sourceMessageKey}`,
        cursor: `cursor-${sourceMessageKey}-1`,
        sourceId: "source-1",
        agentKind: "traex",
        sessionId: "session-1",
        turnId,
        occurredAt: "2026-10-04T00:00:02.000Z",
        payload: { type: "human_message", message_id: sourceMessageKey, text: "run the audit", truncated: false, submission_id: submissionId }
      },
      ...(terminal ? [{
        schemaVersion: 1,
        eventId: `terminal-${sourceMessageKey}`,
        cursor: `cursor-${sourceMessageKey}-2`,
        sourceId: "source-1",
        agentKind: "traex",
        sessionId: "session-1",
        turnId,
        occurredAt: "2026-10-04T00:00:03.000Z",
        payload: { type: "turn_completed" as const }
      }] : [])
    ]
  });
}

function terminalReceipt(submissionId: string, turnId: string) {
  return {
    submissionId,
    paneId: "workspace-1:pane-1",
    terminalId: "terminal-1",
    agentKind: "traex" as const,
    sessionId: "session-1",
    state: "terminal" as const,
    turnId,
    startedAt: "2026-10-04T00:00:02.000Z",
    terminalState: "completed" as const,
    createdAt: 1,
    updatedAt: 3
  };
}

function submission(submissionId: string, sourceMessageKey: string, gatewayId = "feishu:primary"): AdmitSubmissionIntentInput {
  return {
    submissionId,
    ingressSource: "feishu",
    sourceMessageKey,
    actor: {
      kind: "human",
      id: "user-1",
      gatewayId,
      chatId: "chat-1",
      topicId: "topic-1",
      rootMessageId: "root-1"
    },
    text: "run the audit",
    owner: { kind: "primary", id: "binding-1", generation: 3 },
    paneId: "workspace-1:pane-1",
    terminalId: "terminal-1",
    expectedAgentKind: "traex",
    expectedSessionId: "session-1",
    recordedAt: "2026-10-04T00:00:00.000Z"
  };
}
