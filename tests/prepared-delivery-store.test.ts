import { createHash } from "node:crypto";
import { mkdtempSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { OutboundReply } from "../src/domain/types.js";
import type { PreparedDelivery, PreparedDeliveryClaim, PreparedDeliveryPlan } from "../src/domain/delivery.js";
import { presentationSnapshotHash } from "../src/domain/delivery-intent.js";
import { deliveryScopeKey } from "../src/domain/delivery-scope.js";
import { initialTopicView } from "../src/domain/topic-view.js";
import { SqliteBindingStore } from "./helpers/sqlite-binding-store.js";

let store: SqliteBindingStore | undefined;

afterEach(() => {
  store?.close();
  store = undefined;
});

function openStore(): SqliteBindingStore {
  store = new SqliteBindingStore(":memory:");
  connectPlanPreparer(store);
  return store;
}

function connectPlanPreparer(target: SqliteBindingStore): void {
  target.setGatewayPlanPreparer((reply: OutboundReply): PreparedDeliveryPlan => ({
    protocolVersion: 1,
    gatewayId: reply.gatewayId,
    profileId: reply.gatewayProfileId,
    rendererRevision: 1,
    operation: "message.reply.view",
    intent: { kind: "message.reply.view", purpose: "operation-result", rootMessageId: reply.rootMessageId!, view: { schemaVersion: 1, nodes: [] }, idempotencyKey: reply.idempotencyKey }
  }));
}

function activateBinding(target: SqliteBindingStore, id: string, paneId: string): void {
  target.createPendingBinding({ id, workspaceId: "workspace", chatId: "chat", topicId: `topic-${id}`, rootMessageId: `root-${id}`, title: id });
  target.updateBinding(id, { state: "active", lifecycle: "active", attachment: "attached", paneId });
}

function reserve(target: SqliteBindingStore, id: string, bindingId: string, revision = 1): void {
  target.reservePreparedOutboundReply({
    id, idempotencyKey: id, bindingId, bindingGeneration: 1, targetRole: "operation_result",
    rootMessageId: `root-${bindingId}`, kind: "card_reply", payload: '{"schema":"2.0"}',
    projectionKey: `conversation-turn:${id}:page:0`, snapshotRevision: revision, viewVersion: revision,
    laneKeyOverride: `conversation-turn:${id}:page:0`
  });
}

function reserveReplaceable(target: SqliteBindingStore, id: string, bindingId: string, revision: number, rootMessageId = "card", projectionKey = `replaceable:${bindingId}`): PreparedDelivery {
  const receipt = target.reservePreparedOutboundReply({
    id, idempotencyKey: id, bindingId, bindingGeneration: 1, targetRole: "operation_result",
    rootMessageId, kind: "card_update", payload: JSON.stringify({ revision }),
    projectionKey, snapshotRevision: revision, viewVersion: revision,
    laneKeyOverride: `replaceable:${bindingId}`
  });
  const hydrated = target.preparedDeliveries.hydratePreparedDelivery(id);
  if (hydrated.status !== "prepared") throw new Error(`unexpected hydration: ${hydrated.status}`);
  receipt.consumeEffects();
  return hydrated.delivery;
}

function reservePrimaryMainSnapshot(target: SqliteBindingStore, id: string, bindingId: string, revision: number): void {
  target.reservePreparedOutboundReply({
    id,
    idempotencyKey: id,
    bindingId,
    bindingGeneration: 1,
    targetRole: "session_status",
    rootMessageId: `main-${bindingId}`,
    kind: "card_update",
    payload: JSON.stringify({ revision }),
    projectionKey: `primary-main:${bindingId}`,
    snapshotRevision: revision,
    viewVersion: revision,
    laneKeyOverride: `primary-main:${bindingId}`
  }).consumeEffects();
}

function makePrimaryMainTargetCurrent(target: SqliteBindingStore, bindingId: string, revision: number): void {
  target.saveTopicView({
    ...initialTopicView(bindingId),
    title: bindingId,
    workspaceId: "workspace",
    paneId: `pane-${bindingId}`,
    viewVersion: revision
  });
  target.database.prepare("UPDATE bindings SET status_message_id=? WHERE id=?").run(`main-${bindingId}`, bindingId);
}

function makePrimaryMainProjectionReconstructible(target: SqliteBindingStore, bindingId: string, paneId: string, revision = 1): void {
  const binding = target.getBinding(bindingId)!;
  target.saveTopicView({
    ...initialTopicView(bindingId), title: bindingId, workspaceId: "workspace", paneId, viewVersion: revision,
    sessionIdentity: {
      bindingGeneration: binding.generation, sessionEpoch: binding.sessionEpoch,
      nativeSessionId: binding.agentSessionKind === "id" ? binding.agentSessionValue : null,
      paneId, rootMessageId: binding.rootMessageId
    }
  });
  target.database.prepare("UPDATE bindings SET status_message_id=? WHERE id=?").run(`main-${bindingId}`, bindingId);
}

function reserveGlobalReplaceable(target: SqliteBindingStore, id: string, rootMessageId: string): PreparedDelivery {
  const receipt = target.reservePreparedOutboundReply({
    id,
    idempotencyKey: id,
    rootMessageId,
    kind: "card_update",
    payload: "{}",
    projectionKey: `global:${id}`,
    snapshotRevision: 1,
    viewVersion: 1,
    laneKeyOverride: `global:${id}`
  });
  const hydrated = target.preparedDeliveries.hydratePreparedDelivery(id);
  if (hydrated.status !== "prepared") throw new Error(`unexpected hydration: ${hydrated.status}`);
  receipt.consumeEffects();
  return hydrated.delivery;
}

function isolateUncertain(target: SqliteBindingStore, failed: PreparedDelivery): void {
  target.database.prepare(`UPDATE outbound_replies SET
    state='dead_letter',attempt_count=1,failure_class='unknown',effect_certainty='uncertain',
    error='outcome uncertain',dead_lettered_at=? WHERE id=?`).run("2026-10-08T00:00:00.000Z", failed.replyId);
  target.database.prepare(`INSERT INTO outbox_lane_quarantines(
    lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at,
    conflict_key,phase,first_failed_at,grace_deadline_at,degraded_at,budget_attempt_limit,budget_duration_ms
  ) SELECT lane_key,id,'replaceable_card','unknown','active','blocked','outcome uncertain',?,?,?,
      'conflict_isolated',?,?,?,0,60000
    FROM outbound_replies WHERE id=?`).run(
      "2026-10-08T00:00:00.000Z", "2026-10-08T00:01:00.000Z", failed.conflictKey,
      "2026-10-08T00:00:00.000Z", "2026-10-08T00:01:00.000Z", "2026-10-08T00:01:00.000Z", failed.replyId
    );
}

function replaceSemanticIdentity(target: SqliteBindingStore, id: string, input: {
  deliveryInputKind?: "semantic-snapshot" | "prepared-effect";
  subjectRevision?: number;
  snapshotHash?: string;
} = {}): { subjectJson: string; snapshotJson: string; snapshotHash: string } {
  const trigger = target.database.prepare(`SELECT sql FROM sqlite_master
    WHERE type='trigger' AND name='outbound_replies_semantic_identity_immutable'`).get() as { sql: string };
  target.database.exec("DROP TRIGGER outbound_replies_semantic_identity_immutable");
  const subjectJson = JSON.stringify({ kind: "conversation-page", segmentId: "segment-1", pageIndex: 0, revision: 3 });
  const snapshotJson = JSON.stringify({ schemaVersion: 1, timeline: [{ kind: "message", text: "hello" }], completionActions: [] });
  const snapshotHash = input.snapshotHash ?? presentationSnapshotHash(snapshotJson);
  target.database.prepare(`UPDATE outbound_replies SET
    delivery_input_kind=?,subject_kind='conversation-page',subject_json=?,subject_revision=?,
    presentation_snapshot_json=?,presentation_snapshot_hash=?,planner_policy_version=4,
    renderer_policy_version=5,gateway_profile_version=6,preparation_state='prepared'
    WHERE id=?`).run(input.deliveryInputKind ?? "semantic-snapshot", subjectJson, input.subjectRevision ?? 3, snapshotJson, snapshotHash, id);
  target.database.exec(trigger.sql);
  return { subjectJson, snapshotJson, snapshotHash };
}

function reserveClaimedSemanticPage(target: SqliteBindingStore, input: {
  id: string; bindingId: string; segmentId: string; pageIndex: number; revision: number; rootMessageId: string;
}): { claim: PreparedDeliveryClaim; delivery: PreparedDelivery } {
  const projectionKey = `turn-card:${input.segmentId}:page:${input.pageIndex}`;
  const receipt = target.reserveSemanticOutboundReply({
    id: input.id, idempotencyKey: input.id, bindingId: input.bindingId, bindingGeneration: 1,
    rootMessageId: input.rootMessageId, kind: "card_update", payload: "{}", projectionKey,
    snapshotRevision: input.revision, viewVersion: input.revision, laneKeyOverride: projectionKey,
    subject: { kind: "conversation-page", segmentId: input.segmentId, pageIndex: input.pageIndex, revision: input.revision },
    snapshot: { schemaVersion: 1, kind: "conversation-turn-card", timeline: [] },
    plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
  });
  target.database.prepare("UPDATE conversation_segment_pages SET pending_reply_id=?,sequence=? WHERE segment_id=? AND page_index=?")
    .run(input.id, input.revision, input.segmentId, input.pageIndex);
  const work = receipt.consumeEffects()[0]!;
  if (!("input" in work)) throw new Error("expected semantic work");
  const plan: PreparedDeliveryPlan = {
    protocolVersion: 1, gatewayId: work.gatewayId, profileId: work.gatewayProfileId, rendererRevision: 1,
    operation: "surface.replace", intent: { kind: "surface.replace", purpose: "operation-result", messageId: input.rootMessageId, view: {} }
  };
  const frozen = target.preparedDeliveries.freezeSemanticDelivery({ work, preparedPlan: plan });
  if (frozen.outcome !== "prepared") throw new Error("expected prepared delivery");
  const claim = target.preparedDeliveries.claimPreparedDelivery({
    delivery: frozen.delivery, at: "2098-10-10T00:00:00.000Z", expiresAt: "2098-10-10T00:01:00.000Z"
  });
  if (!claim) throw new Error("expected semantic delivery claim");
  return { claim, delivery: frozen.delivery };
}

describe("Prepared Delivery Store", () => {
  it("previews semantic reservation identity without inserting work and matches production routing", () => {
    const target = openStore();
    activateBinding(target, "binding-preview", "pane-preview");
    const projectionKey = "turn-card:segment-preview:page:0";
    const common = {
      bindingId: "binding-preview", bindingGeneration: 1, targetRole: "operation_result" as const,
      rootMessageId: "root-binding-preview", kind: "card_reply" as const, projectionKey,
      snapshotRevision: 1, viewVersion: 1, laneKeyOverride: projectionKey
    };
    const semantic = {
      ...common, id: "semantic-preview", idempotencyKey: "segment:segment-preview:page:0:create", payload: "{}",
      subject: { kind: "conversation-page" as const, segmentId: "segment-preview", pageIndex: 0, revision: 1 },
      snapshot: { schemaVersion: 1, kind: "conversation-turn-card" },
      plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
    };
    const before = target.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get();

    const preview = target.previewSemanticOutboundReply(semantic);

    expect(target.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies").get()).toEqual(before);
    const receipt = target.reservePreparedOutboundReply({
      ...common, id: "legacy-preview", idempotencyKey: semantic.idempotencyKey, payload: '{"schema":"2.0"}'
    });
    expect(target.getReservedDeliveryIdentity(receipt.result.id)).toEqual(preview);
  });

  it("coalesces only bounded safe historical Primary Main snapshots and notifies their scopes", () => {
    const target = openStore();
    for (const bindingId of ["safe", "claimed", "checkpointed", "prerequisite", "recovery", "stale"]) {
      activateBinding(target, bindingId, `pane-${bindingId}`);
      reservePrimaryMainSnapshot(target, `${bindingId}-old`, bindingId, 1);
      reservePrimaryMainSnapshot(target, `${bindingId}-new`, bindingId, 2);
      makePrimaryMainTargetCurrent(target, bindingId, bindingId === "stale" ? 3 : 2);
    }
    target.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
    target.database.prepare("UPDATE outbound_replies SET claim_attempt_id='claim',claimed_owner_id='owner',claimed_fence=1,claimed_at='2026-10-12T00:00:00.000Z',claim_expires_at='2099-10-12T00:01:00.000Z' WHERE id='claimed-old'").run();
    target.database.prepare("UPDATE outbound_replies SET card_id_checkpoint='card' WHERE id='checkpointed-old'").run();
    target.preparedDeliveries.addPrerequisite({ dependentReplyId: "prerequisite-old", prerequisiteReplyId: "prerequisite-new", requiredState: "delivered" });
    target.database.prepare(`INSERT INTO delivery_recoveries(
      failed_reply_id,snapshot_revision,state,failure_class,http_status,lark_error_code,reason,action,
      semantic_recovery_proof,replacement_reply_id,resolved_by_reply_id,resolved_message_id,created_at,updated_at,resolved_at
    ) VALUES('recovery-old',1,'unresolved','permanent',NULL,NULL,'linked','manual',NULL,NULL,NULL,NULL,?,?,NULL)`).run(
      "2026-10-12T00:00:00.000Z", "2026-10-12T00:00:00.000Z"
    );
    const maintenance = target.preparedDeliveries as unknown as {
      runGlobalRingMaintenance(input: { at: string; limit: number }): { affectedScopeKeys: string[] };
    };

    expect(maintenance.runGlobalRingMaintenance({ at: "2026-10-12T00:01:00.000Z", limit: 2 })).toEqual({
      affectedScopeKeys: ['["pane","workspace","pane-safe"]']
    });

    expect(target.getOutboundReply("safe-old")).toMatchObject({ state: "dismissed" });
    expect(target.getOutboundReply("safe-new")).toMatchObject({ state: "pending" });
    for (const id of ["claimed-old", "checkpointed-old", "prerequisite-old", "recovery-old", "stale-old"]) {
      expect(target.getOutboundReply(id)).toMatchObject({ state: "pending" });
    }
  });

  it("discovers historical Primary Main candidates before acquiring the writer", () => {
    const target = openStore();
    activateBinding(target, "coalesce-discovery", "pane-coalesce-discovery");
    reservePrimaryMainSnapshot(target, "coalesce-discovery-old", "coalesce-discovery", 1);
    reservePrimaryMainSnapshot(target, "coalesce-discovery-new", "coalesce-discovery", 2);
    makePrimaryMainTargetCurrent(target, "coalesce-discovery", 2);
    const exec = target.database.exec.bind(target.database);
    let inWriter = false;
    const writerSql: string[] = [];
    vi.spyOn(target.database, "exec").mockImplementation((sql) => {
      if (String(sql) === "BEGIN IMMEDIATE") inWriter = true;
      const result = exec(sql);
      if (String(sql) === "COMMIT" || String(sql) === "ROLLBACK") inWriter = false;
      return result;
    });
    const prepareStatement = target.database.prepare.bind(target.database);
    vi.spyOn(target.database, "prepare").mockImplementation((sql) => {
      if (inWriter) writerSql.push(String(sql));
      return prepareStatement(sql);
    });

    expect(target.preparedDeliveries.coalesceHistoricalPrimaryMainSnapshots?.({
      at: "2026-10-12T00:01:00.000Z", limit: 4
    })).toEqual(['["pane","workspace","pane-coalesce-discovery"]']);

    const candidateQueries = writerSql.filter((sql) => sql.includes("SELECT DISTINCT historical.id"));
    expect(candidateQueries).not.toHaveLength(0);
    expect(candidateQueries.every((sql) => sql.includes("historical.id=?"))).toBe(true);
    expect(target.getOutboundReply("coalesce-discovery-old")).toMatchObject({ state: "dismissed" });
  });

  it("renews only the exact live claim so a slow Gateway call can settle after its original TTL", () => {
    const target = openStore();
    activateBinding(target, "renew", "pane-renew");
    const delivery = reserveReplaceable(target, "renew-reply", "renew", 1);
    const lease = target.acquireInstanceLease("renew-owner", "2026-10-08T00:00:00.000Z", "2099-10-08T00:00:00.000Z");
    if (!lease) throw new Error("expected test lease");
    target.activateWriteFence(lease.ownerId, lease.fencingToken);
    const claim = target.preparedDeliveries.claimPreparedDelivery({
      delivery,
      at: "2098-10-08T00:00:00.000Z",
      expiresAt: "2098-10-08T00:01:00.000Z"
    });
    if (!claim) throw new Error("expected claim");
    const renew = target.preparedDeliveries as unknown as {
      renewPreparedDeliveryClaim(input: { claim: typeof claim; at: string; expiresAt: string }): boolean;
    };

    expect(renew.renewPreparedDeliveryClaim({
      claim,
      at: "2098-10-08T00:00:30.000Z",
      expiresAt: "2098-10-08T00:01:30.000Z"
    })).toBe(true);
    expect(target.database.prepare(`SELECT state,claim_attempt_id,claimed_owner_id,claimed_fence,payload_hash,
      gateway_plan_hash,snapshot_revision,claim_expires_at FROM outbound_replies WHERE id=?`).get(delivery.replyId)).toEqual({
      state: "pending",
      claim_attempt_id: claim.attemptId,
      claimed_owner_id: claim.ownerId,
      claimed_fence: claim.fencingToken,
      payload_hash: claim.planHash,
      gateway_plan_hash: claim.planHash,
      snapshot_revision: claim.snapshotRevision,
      claim_expires_at: "2098-10-08T00:01:30.000Z"
    });
    expect(target.preparedDeliveries.acknowledgePreparedDelivery(claim, {
      messageId: "late-but-renewed",
      surfaceId: null,
      threadId: null
    })).toBe(true);
  });

  it("rejects renewal and late settlement after the owner lease is lost or the owner claim is stale", () => {
    const target = openStore();
    activateBinding(target, "renew-reject", "pane-renew-reject");
    const delivery = reserveReplaceable(target, "renew-reject-reply", "renew-reject", 1);
    const lease = target.acquireInstanceLease("renew-owner", "2026-10-08T00:00:00.000Z", "2099-10-08T00:00:00.000Z");
    if (!lease) throw new Error("expected test lease");
    target.activateWriteFence(lease.ownerId, lease.fencingToken);
    const claim = target.preparedDeliveries.claimPreparedDelivery({
      delivery,
      at: "2098-10-08T00:00:00.000Z",
      expiresAt: "2098-10-08T00:01:00.000Z"
    });
    if (!claim) throw new Error("expected claim");
    const renew = target.preparedDeliveries as unknown as {
      renewPreparedDeliveryClaim(input: { claim: typeof claim; at: string; expiresAt: string }): boolean;
    };

    expect(renew.renewPreparedDeliveryClaim({
      claim: { ...claim, ownerId: "stale-owner" },
      at: "2098-10-08T00:00:30.000Z",
      expiresAt: "2098-10-08T00:01:30.000Z"
    })).toBe(false);
    target.database.prepare("UPDATE instance_lease SET expires_at_ms=0 WHERE singleton_id=1").run();
    expect(renew.renewPreparedDeliveryClaim({
      claim,
      at: "2098-10-08T00:00:30.000Z",
      expiresAt: "2098-10-08T00:01:30.000Z"
    })).toBe(false);
    expect(target.preparedDeliveries.acknowledgePreparedDelivery(claim, {
      messageId: "late-after-owner-loss",
      surfaceId: null,
      threadId: null
    })).toBe(false);
  });

  it.each([1, 8, 64])("hydrates a ready %i-scope refill page with two prepared statements", (scopeCount) => {
    const target = openStore();
    for (let index = 0; index < scopeCount; index += 1) {
      const id = `fixed-${String(index).padStart(2, "0")}`;
      activateBinding(target, id, `pane-${id}`);
      reserve(target, id, id);
    }
    target.preparedDeliveries.loadScopePage({ scope: null, afterScopeKey: null, limit: 64, at: "2099-10-08T00:00:00.000Z" });
    const before = target.database.prepare("SELECT scope_key,committed_delivery_order,updated_at FROM delivery_ring_checkpoints ORDER BY scope_key").all();
    const prepare = vi.spyOn(target.database, "prepare");

    const page = target.preparedDeliveries.loadScopePage({ scope: null, afterScopeKey: null, limit: 64, at: "2099-10-08T00:01:00.000Z" });

    expect(page.items).toHaveLength(scopeCount);
    expect(prepare).toHaveBeenCalledTimes(2);
    expect(String(prepare.mock.calls[0]?.[0])).not.toContain("head.*");
    expect(String(prepare.mock.calls[0]?.[0])).not.toContain("gateway_plan_json");
    prepare.mockRestore();
    expect(target.database.prepare("SELECT scope_key,committed_delivery_order,updated_at FROM delivery_ring_checkpoints ORDER BY scope_key").all()).toEqual(before);
  });

  it("discovers and hydrates an unchanged ready page without acquiring the SQLite writer", () => {
    const target = openStore();
    activateBinding(target, "writer-free", "pane-writer-free");
    reserve(target, "writer-free", "writer-free");
    target.preparedDeliveries.loadScopePage({ scope: null, afterScopeKey: null, limit: 64, at: "2099-10-08T00:00:00.000Z" });
    const exec = vi.spyOn(target.database, "exec");

    const page = target.preparedDeliveries.loadScopePage({
      scope: null, afterScopeKey: null, limit: 64, at: "2099-10-08T00:01:00.000Z"
    });

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.head).toMatchObject({ replyId: "writer-free", status: "ready" });
    expect(exec.mock.calls.map(([sql]) => String(sql))).not.toContain("BEGIN IMMEDIATE");
    exec.mockRestore();
  });

  it.each([
    ["missing", "DELETE FROM outbound_replies WHERE id='candidate'", "invalid"],
    ["corrupt", "UPDATE outbound_replies SET gateway_plan_hash='corrupt' WHERE id='candidate'", "invalid"],
    ["reordered", "UPDATE outbound_replies SET delivery_order=delivery_order+100 WHERE id='candidate'", "invalid"],
    ["no longer prepared", "UPDATE outbound_replies SET gateway_plan_json=NULL,gateway_plan_hash=NULL WHERE id='candidate'", "unprepared"]
  ] as const)("fails closed when a discovered batch candidate is %s before hydration", (_case, mutation, expectedStatus) => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reserve(target, "candidate", "a");
    reserve(target, "later", "a");
    target.preparedDeliveries.loadScopePage({ scope: null, afterScopeKey: null, limit: 64, at: "2099-10-08T00:00:00.000Z" });
    target.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
    const prepareStatement = target.database.prepare.bind(target.database);
    let prepareCount = 0;
    const prepare = vi.spyOn(target.database, "prepare").mockImplementation((sql) => {
      prepareCount += 1;
      if (prepareCount === 2) prepareStatement(mutation).run();
      return prepareStatement(sql);
    });

    const page = target.preparedDeliveries.loadScopePage({ scope: null, afterScopeKey: null, limit: 64, at: "2099-10-08T00:01:00.000Z" });

    expect(prepare).toHaveBeenCalledTimes(2);
    prepare.mockRestore();
    expect(page).toMatchObject({
      recoveryBlocked: true,
      items: [{ head: { replyId: "candidate", status: expectedStatus, delivery: null } }]
    });
  });

  it("does not derive or reconcile the look-ahead sentinel", () => {
    const target = openStore();
    for (const id of ["sentinel-a", "sentinel-b", "sentinel-c"]) {
      activateBinding(target, id, `pane-${id}`);
      reserve(target, id, id);
    }
    const initialized = target.preparedDeliveries.loadScopePage({ scope: null, afterScopeKey: null, limit: 3, at: "2026-10-08T00:00:00.000Z" });
    const sentinel = initialized.items[2]!;
    target.database.prepare("UPDATE delivery_ring_checkpoints SET committed_delivery_order=99,updated_at='stale' WHERE scope_key=?").run(sentinel.scopeKey);

    const first = target.preparedDeliveries.loadScopePage({ scope: null, afterScopeKey: null, limit: 2, at: "2026-10-08T00:01:00.000Z" });

    expect(first.items.map((item) => item.scopeKey)).toEqual(initialized.items.slice(0, 2).map((item) => item.scopeKey));
    expect(first.nextCursor).toBe(initialized.items[1]!.scopeKey);
    expect(target.database.prepare("SELECT committed_delivery_order,updated_at FROM delivery_ring_checkpoints WHERE scope_key=?").get(sentinel.scopeKey))
      .toEqual({ committed_delivery_order: 99, updated_at: "stale" });
  });

  it("initializes a missing-checkpoint page with one conditional bulk upsert", () => {
    const target = openStore();
    for (let index = 0; index < 64; index += 1) {
      const id = `missing-${String(index).padStart(2, "0")}`;
      activateBinding(target, id, `pane-${id}`);
      reserve(target, id, id);
    }
    const prepare = vi.spyOn(target.database, "prepare");

    const page = target.preparedDeliveries.loadScopePage({ scope: null, afterScopeKey: null, limit: 64, at: "2026-10-08T00:00:00.000Z" });

    expect(prepare).toHaveBeenCalledTimes(3);
    prepare.mockRestore();
    expect(page.items).toHaveLength(64);
    expect(page.items.every((item) => item.priorCommittedOrder === null && item.safeCommittedOrder === item.head!.deliveryOrder - 1)).toBe(true);
    expect(target.database.prepare("SELECT COUNT(*) AS count FROM delivery_ring_checkpoints").get()).toEqual({ count: 64 });
  });

  it("revalidates changed checkpoints without running scope discovery or head eligibility under the writer", () => {
    const target = openStore();
    activateBinding(target, "narrow-cas", "pane-narrow-cas");
    reserve(target, "narrow-cas", "narrow-cas");
    const exec = target.database.exec.bind(target.database);
    let inWriter = false;
    const writerSql: string[] = [];
    vi.spyOn(target.database, "exec").mockImplementation((sql) => {
      if (String(sql) === "BEGIN IMMEDIATE") inWriter = true;
      const result = exec(sql);
      if (String(sql) === "COMMIT" || String(sql) === "ROLLBACK") inWriter = false;
      return result;
    });
    const prepareStatement = target.database.prepare.bind(target.database);
    vi.spyOn(target.database, "prepare").mockImplementation((sql) => {
      if (inWriter) writerSql.push(String(sql));
      return prepareStatement(sql);
    });

    const page = target.preparedDeliveries.loadScopePage({
      scope: null, afterScopeKey: null, limit: 1, at: "2099-10-08T00:00:00.000Z"
    });

    expect(page.items).toHaveLength(1);
    expect(writerSql).toHaveLength(2);
    expect(writerSql.join("\n")).not.toMatch(/scope_page|head_reply_id|query_clock|app_cooldown|gateway_plan_json/);
  });

  it("fails closed after checkpoint revalidation exhausts its stale retry budget", () => {
    const target = openStore();
    activateBinding(target, "stale-exhausted", "pane-stale-exhausted");
    reserve(target, "stale-exhausted", "stale-exhausted");
    const scopeKey = '["pane","workspace","pane-stale-exhausted"]';
    target.database.prepare(`INSERT INTO delivery_ring_checkpoints(
      scope_key,scope_kind,scope_workspace_id,scope_pane_id,committed_delivery_order,created_at,updated_at
    ) VALUES(?,?,?,?,1,'2026-10-08T00:00:00.000Z','2026-10-08T00:00:00.000Z')`)
      .run(scopeKey, "pane", "workspace", "pane-stale-exhausted");
    const exec = target.database.exec.bind(target.database);
    let writerAttempts = 0;
    vi.spyOn(target.database, "exec").mockImplementation((sql) => {
      if (String(sql) === "BEGIN IMMEDIATE") {
        writerAttempts += 1;
        target.database.prepare("UPDATE delivery_ring_checkpoints SET committed_delivery_order=? WHERE scope_key=?")
          .run(writerAttempts + 1, scopeKey);
      }
      return exec(sql);
    });

    const page = target.preparedDeliveries.loadScopePage({
      scope: null, afterScopeKey: null, limit: 1, at: "2099-10-08T00:00:00.000Z"
    });

    expect(writerAttempts).toBe(3);
    expect(page).toMatchObject({ items: [], nextCursor: null, nextRetryAt: null, recoveryBlocked: true });
    expect(page.items.flatMap((item) => item.head?.delivery ? [item.head.delivery] : [])).toEqual([]);
  });

  it.each([
    ["forward", "delivered", "pending", 0],
    ["backward", "pending", "delivered", 1]
  ] as const)("revalidates a stale %s checkpoint discovery before its fenced write", (_direction, discoveredState, competingState, expectedOrder) => {
    const target = openStore();
    activateBinding(target, "checkpoint-cas", "pane-checkpoint-cas");
    reserve(target, "checkpoint-cas", "checkpoint-cas");
    const scopeKey = '["pane","workspace","pane-checkpoint-cas"]';
    target.database.prepare("UPDATE outbound_replies SET state=?,delivered_message_id=? WHERE id='checkpoint-cas'")
      .run(discoveredState, discoveredState === "delivered" ? "message" : null);
    target.database.prepare(`INSERT INTO delivery_ring_checkpoints(
      scope_key,scope_kind,scope_workspace_id,scope_pane_id,committed_delivery_order,created_at,updated_at
    ) VALUES(?,?,?,?,?,'2026-10-08T00:00:00.000Z','2026-10-08T00:00:00.000Z')`)
      .run(scopeKey, "pane", "workspace", "pane-checkpoint-cas", discoveredState === "delivered" ? 0 : 1);
    target.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
    const exec = target.database.exec.bind(target.database);
    let interleaved = false;
    vi.spyOn(target.database, "exec").mockImplementation((sql) => {
      if (!interleaved && String(sql) === "BEGIN IMMEDIATE") {
        interleaved = true;
        target.database.prepare("UPDATE outbound_replies SET state=?,delivered_message_id=? WHERE id='checkpoint-cas'")
          .run(competingState, competingState === "delivered" ? "message" : null);
      }
      return exec(sql);
    });

    const page = target.preparedDeliveries.loadScopePage({ scope: null, afterScopeKey: null, limit: 1, at: "2099-10-08T00:00:00.000Z" });

    expect(interleaved).toBe(true);
    expect(target.database.prepare("SELECT committed_delivery_order FROM delivery_ring_checkpoints WHERE scope_key=?").get(scopeKey))
      .toEqual({ committed_delivery_order: expectedOrder });
    expect(page.items[0]?.safeCommittedOrder).toBe(expectedOrder);
  });

  it("rolls back every scope watermark when one bulk checkpoint write fails", () => {
    const target = openStore();
    for (const id of ["rollback-a", "rollback-b"]) {
      activateBinding(target, id, `pane-${id}`);
      reserve(target, id, id);
    }
    const scopeKeys = (target.database.prepare("SELECT scope_key FROM outbound_replies ORDER BY scope_key").all() as Array<{ scope_key: string }>).map((row) => row.scope_key);
    target.database.exec(`CREATE TEMP TRIGGER reject_second_scope BEFORE INSERT ON delivery_ring_checkpoints
      WHEN NEW.scope_key='${scopeKeys[1]}' BEGIN SELECT RAISE(ABORT,'scope page rollback'); END`);

    expect(() => target.preparedDeliveries.loadScopePage({ scope: null, afterScopeKey: null, limit: 2, at: "2026-10-08T00:00:00.000Z" }))
      .toThrow("scope page rollback");
    expect(target.database.prepare("SELECT COUNT(*) AS count FROM delivery_ring_checkpoints").get()).toEqual({ count: 0 });
  });

  it("uses the same blocker and candidate derivation for an exact-scope refill", async () => {
    const target = openStore();
    activateBinding(target, "exact", "pane-exact");
    reserve(target, "exact-terminal", "exact");
    reserve(target, "exact-head", "exact", 2);
    target.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='terminal' WHERE id='exact-terminal'").run();
    const head = target.preparedDeliveries.hydratePreparedDelivery("exact-head");
    if (head.status !== "prepared") throw new Error(`unexpected hydration: ${head.status}`);

    const page = target.preparedDeliveries.loadScopePage({ scope: head.delivery.scope, afterScopeKey: "ignored", limit: 1, at: "2099-10-08T00:00:00.000Z" });

    expect(page).toMatchObject({
      nextCursor: null,
      recoveryBlocked: false,
      items: [{
        scope: head.delivery.scope,
        safeCommittedOrder: head.delivery.deliveryOrder - 1,
        authoritativeBlocker: { replyId: "exact-head", deliveryOrder: head.delivery.deliveryOrder },
        head: { replyId: "exact-head", status: "ready" }
      }]
    });
    await expect(target.preparedDeliveries.load({ scope: head.delivery.scope, limit: 1, now: "2099-10-08T00:00:00.000Z", pageToken: "ignored" }))
      .resolves.toMatchObject({ deliveries: [expect.objectContaining({ replyId: "exact-head" })], nextPageToken: null });
  });

  it("selects the earliest independent candidate past a conflict-isolated quarantine without advancing the checkpoint", () => {
    const target = openStore();
    activateBinding(target, "isolated", "pane-isolated");
    const failed = reserveReplaceable(target, "card-a-failed", "isolated", 1, "card-a", "card-a");
    reserveReplaceable(target, "card-a-later", "isolated", 2, "card-a", "card-a");
    const prerequisiteBlocked = reserveReplaceable(target, "card-b-blocked", "isolated", 1, "card-b", "card-b");
    const independent = reserveReplaceable(target, "card-c-ready", "isolated", 1, "card-c", "card-c");
    isolateUncertain(target, failed);
    target.preparedDeliveries.addPrerequisite({
      dependentReplyId: prerequisiteBlocked.replyId,
      prerequisiteReplyId: failed.replyId,
      requiredState: "delivered"
    });

    const page = target.preparedDeliveries.loadScopePage({
      scope: failed.scope,
      afterScopeKey: null,
      limit: 1,
      at: "2099-10-08T00:02:00.000Z"
    });

    expect(page.items[0]).toMatchObject({
      safeCommittedOrder: failed.deliveryOrder - 1,
      authoritativeBlocker: { replyId: failed.replyId, deliveryOrder: failed.deliveryOrder },
      head: { replyId: independent.replyId, status: "ready" }
    });
    expect(target.database.prepare(`SELECT state,phase,conflict_key,degraded_at
      FROM outbox_lane_quarantines WHERE failed_reply_id=?`).get(failed.replyId)).toEqual({
        state: "active",
        phase: "conflict_isolated",
        conflict_key: failed.conflictKey,
        degraded_at: "2026-10-08T00:01:00.000Z"
      });
    expect(target.database.prepare(`SELECT committed_delivery_order FROM delivery_ring_checkpoints
      WHERE scope_key=?`).get(deliveryScopeKey(failed.scope))).toEqual({ committed_delivery_order: failed.deliveryOrder - 1 });
  });

  it("claims one independent conflict at a time while same-key work remains blocked", () => {
    const target = openStore();
    activateBinding(target, "claim-isolated", "pane-claim-isolated");
    const failed = reserveReplaceable(target, "claim-card-a-failed", "claim-isolated", 1, "card-a", "card-a");
    const sameKey = reserveReplaceable(target, "claim-card-a-later", "claim-isolated", 2, "card-a", "card-a");
    const firstIndependent = reserveReplaceable(target, "claim-card-b", "claim-isolated", 1, "card-b", "card-b");
    const secondIndependent = reserveReplaceable(target, "claim-card-c", "claim-isolated", 1, "card-c", "card-c");
    isolateUncertain(target, failed);
    const lease = target.acquireInstanceLease("claim-owner", "2026-10-08T00:00:00.000Z", "2099-10-08T00:00:00.000Z");
    if (!lease) throw new Error("expected test lease");
    target.activateWriteFence(lease.ownerId, lease.fencingToken);

    const firstClaim = target.preparedDeliveries.claimPreparedDelivery({
      delivery: firstIndependent,
      at: "2098-10-08T00:00:00.000Z",
      expiresAt: "2098-10-08T00:01:00.000Z"
    });

    expect(firstClaim).toMatchObject({ replyId: firstIndependent.replyId });
    expect(target.preparedDeliveries.claimPreparedDelivery({
      delivery: sameKey,
      at: "2098-10-08T00:00:01.000Z",
      expiresAt: "2098-10-08T00:01:01.000Z"
    })).toBeNull();
    expect(target.preparedDeliveries.claimPreparedDelivery({
      delivery: secondIndependent,
      at: "2098-10-08T00:00:01.000Z",
      expiresAt: "2098-10-08T00:01:01.000Z"
    })).toBeNull();
    expect(target.database.prepare(`SELECT COUNT(*) AS count FROM outbound_replies
      WHERE scope_key=? AND claim_attempt_id IS NOT NULL`).get(deliveryScopeKey(failed.scope))).toEqual({ count: 1 });
  });

  it("degrades an expired grace quarantine once and wakes the scope without releasing it", () => {
    const target = openStore();
    activateBinding(target, "grace", "pane-grace");
    const failed = reserveReplaceable(target, "grace-card-a", "grace", 1, "card-a", "card-a");
    const independent = reserveReplaceable(target, "grace-card-b", "grace", 1, "card-b", "card-b");
    isolateUncertain(target, failed);
    target.database.prepare(`UPDATE outbox_lane_quarantines SET
      phase='grace_blocking',degraded_at=NULL WHERE failed_reply_id=?`).run(failed.replyId);

    expect(target.preparedDeliveries.loadScopePage({
      scope: failed.scope,
      afterScopeKey: null,
      limit: 1,
      at: "2026-10-08T00:00:30.000Z"
    }).items[0]).toMatchObject({ head: { replyId: failed.replyId, status: "dead_letter" } });

    expect(target.preparedDeliveries.recoverQuarantinedRingHeads({
      afterScopeKey: null,
      limit: 10,
      at: "2026-10-08T00:01:00.000Z"
    })).toEqual({ transitionedScopeKeys: [deliveryScopeKey(failed.scope)], nextCursor: null });
    expect(target.database.prepare(`SELECT state,phase,degraded_at FROM outbox_lane_quarantines
      WHERE failed_reply_id=?`).get(failed.replyId)).toEqual({
        state: "active",
        phase: "conflict_isolated",
        degraded_at: "2026-10-08T00:01:00.000Z"
      });
    expect(target.preparedDeliveries.loadScopePage({
      scope: failed.scope,
      afterScopeKey: null,
      limit: 1,
      at: "2099-10-08T00:00:00.000Z"
    }).items[0]).toMatchObject({
      authoritativeBlocker: { replyId: failed.replyId },
      head: { replyId: independent.replyId, status: "ready" }
    });
    expect(target.preparedDeliveries.recoverQuarantinedRingHeads({
      afterScopeKey: null,
      limit: 10,
      at: "2026-10-08T00:01:01.000Z"
    }).transitionedScopeKeys).toEqual([]);
  });

  it("reserves one independent durable Human Review escalation per isolated quarantine", () => {
    const target = openStore();
    activateBinding(target, "review", "pane-review");
    target.database.prepare("UPDATE bindings SET creator_open_id='ou_owner' WHERE id='review'").run();
    const failed = reserveReplaceable(target, "review-card-a", "review", 1, "card-a", "card-a");
    isolateUncertain(target, failed);
    target.database.prepare("UPDATE outbox_lane_quarantines SET phase='grace_blocking',degraded_at=NULL WHERE failed_reply_id=?").run(failed.replyId);
    (target.preparedDeliveries as unknown as { setQuarantineReviewRenderer(renderer: (input: Record<string, unknown>) => object): void })
      .setQuarantineReviewRenderer((input) => ({ schema: "2.0", input }));

    target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-08T00:01:00.000Z" });
    target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-08T00:02:00.000Z" });

    const reviews = target.database.prepare("SELECT * FROM outbound_replies WHERE idempotency_key=?").all(`delivery-quarantine-review:${failed.replyId}`) as Array<Record<string, unknown>>;
    expect(reviews).toHaveLength(1);
    expect(reviews[0]).toMatchObject({ state: "pending", kind: "card_reply", root_message_id: "root-review", scope_key: deliveryScopeKey(failed.scope) });
    expect(reviews[0]!.conflict_key).not.toBe(failed.conflictKey);
    expect(JSON.parse(String(reviews[0]!.payload))).toMatchObject({ input: { failedReplyId: failed.replyId, creatorOpenId: "ou_owner", retryAllowed: false } });
    expect(target.database.prepare("SELECT review_reply_id,review_requested_at FROM outbox_lane_quarantines WHERE failed_reply_id=?").get(failed.replyId)).toEqual({
      review_reply_id: reviews[0]!.id,
      review_requested_at: "2026-10-08T00:01:00.000Z"
    });
  });

  it("repairs one missing review for an already isolated quarantine after restart", () => {
    const target = openStore();
    activateBinding(target, "review-restart", "pane-review-restart");
    const failed = reserveReplaceable(target, "review-restart-card", "review-restart", 1, "card-a", "card-a");
    isolateUncertain(target, failed);
    (target.preparedDeliveries as unknown as { setQuarantineReviewRenderer(renderer: (input: Record<string, unknown>) => object): void })
      .setQuarantineReviewRenderer((input) => ({ schema: "2.0", input }));

    target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-08T00:02:00.000Z" });
    target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-08T00:03:00.000Z" });

    expect(target.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE idempotency_key=?").get(`delivery-quarantine-review:${failed.replyId}`)).toEqual({ count: 1 });
    expect(target.database.prepare("SELECT review_reply_id FROM outbox_lane_quarantines WHERE failed_reply_id=?").get(failed.replyId)).toMatchObject({ review_reply_id: expect.any(String) });
  });

  it("terminalizes a rejected quarantine review without recursively escalating it", () => {
    const target = openStore();
    activateBinding(target, "review-recursion", "pane-review-recursion");
    const failed = reserveReplaceable(target, "review-recursion-card", "review-recursion", 1, "card-a", "card-a");
    isolateUncertain(target, failed);
    (target.preparedDeliveries as unknown as { setQuarantineReviewRenderer(renderer: (input: Record<string, unknown>) => object): void })
      .setQuarantineReviewRenderer((input) => ({ schema: "2.0", input }));

    target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-08T00:02:00.000Z" });
    const review = target.database.prepare("SELECT id FROM outbound_replies WHERE idempotency_key=?")
      .get(`delivery-quarantine-review:${failed.replyId}`) as { id: string };
    target.database.prepare(`UPDATE outbound_replies SET state='dead_letter',attempt_count=1,
      failure_class='permanent',effect_certainty='rejected',http_status=400,lark_error_code='99992354',
      error='Request failed with status code 400',first_claimed_at=?,dead_lettered_at=?,updated_at=? WHERE id=?`).run(
      "2026-10-08T00:02:01.000Z", "2026-10-08T00:02:02.000Z", "2026-10-08T00:02:02.000Z", review.id
    );
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(
      lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at,
      conflict_key,phase,first_failed_at,grace_deadline_at,degraded_at,budget_attempt_limit,budget_duration_ms
    ) SELECT lane_key,id,'immutable','permanent','active','blocked','Request failed with status code 400',?,?,
        conflict_key,'conflict_isolated',?,?,?,0,120000
      FROM outbound_replies WHERE id=?`).run(
      "2026-10-08T00:02:02.000Z", "2026-10-08T00:04:00.000Z", "2026-10-08T00:02:02.000Z",
      "2026-10-08T00:04:02.000Z", "2026-10-08T00:04:00.000Z", review.id
    );
    target.database.prepare(`UPDATE delivery_recoveries SET state='unresolved',failure_class='permanent',
      http_status=400,lark_error_code='99992354',reason='Request failed with status code 400',action='blocked',updated_at=?
      WHERE failed_reply_id=?`).run("2026-10-08T00:02:02.000Z", review.id);

    target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-08T00:04:00.000Z" });

    expect(target.database.prepare("SELECT state,effect_certainty FROM outbound_replies WHERE id=?").get(review.id)).toEqual({
      state: "dismissed",
      effect_certainty: "rejected"
    });
    expect(target.database.prepare("SELECT state,action FROM outbox_lane_quarantines WHERE failed_reply_id=?").get(review.id)).toEqual({
      state: "released",
      action: "dismiss_rejected_review"
    });
    expect(target.database.prepare("SELECT state,action FROM delivery_recoveries WHERE failed_reply_id=?").get(review.id)).toEqual({
      state: "dismissed",
      action: "dismiss_rejected_review"
    });
    expect(target.database.prepare("SELECT COUNT(*) AS count FROM outbound_replies WHERE idempotency_key=?")
      .get(`delivery-quarantine-review:${review.id}`)).toEqual({ count: 0 });
  });

  it("dismisses a pending nested review and releases its active parent quarantine", () => {
    const target = openStore();
    activateBinding(target, "review-nested", "pane-review-nested");
    const failed = reserveReplaceable(target, "review-nested-card", "review-nested", 1, "card-a", "card-a");
    isolateUncertain(target, failed);
    (target.preparedDeliveries as unknown as { setQuarantineReviewRenderer(renderer: (input: Record<string, unknown>) => object): void })
      .setQuarantineReviewRenderer((input) => ({ schema: "2.0", input }));
    target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-08T00:02:00.000Z" });
    const parent = target.database.prepare("SELECT id FROM outbound_replies WHERE idempotency_key=?")
      .get(`delivery-quarantine-review:${failed.replyId}`) as { id: string };
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(
      lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at,
      conflict_key,phase,first_failed_at,grace_deadline_at,degraded_at,budget_attempt_limit,budget_duration_ms
    ) SELECT lane_key,id,'immutable','unknown','active','blocked','nested review',?,?,
        conflict_key,'conflict_isolated',?,?,?,0,120000
      FROM outbound_replies WHERE id=?`).run(
      "2026-10-08T00:02:00.000Z", "2026-10-08T00:02:00.000Z", "2026-10-08T00:02:00.000Z",
      "2026-10-08T00:02:00.000Z", "2026-10-08T00:04:00.000Z", parent.id
    );
    target.reservePreparedOutboundReply({
      id: "nested-review-active",
      idempotencyKey: `delivery-quarantine-review:${parent.id}`,
      bindingId: "review-nested",
      bindingGeneration: 1,
      targetRole: "operation_result",
      rootMessageId: "root-review-nested",
      kind: "card_reply",
      payload: '{"schema":"2.0"}',
      projectionKey: `delivery-quarantine-review:${parent.id}`,
      snapshotRevision: 1,
      viewVersion: 1,
      laneKeyOverride: `delivery-quarantine-review:${parent.id}`
    }).consumeEffects();
    target.database.prepare("UPDATE outbox_lane_quarantines SET review_reply_id='nested-review-active',review_requested_at=? WHERE failed_reply_id=?")
      .run("2026-10-08T00:03:00.000Z", parent.id);

    target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-08T00:04:00.000Z" });

    expect(target.database.prepare("SELECT state FROM outbound_replies WHERE id=?").get("nested-review-active")).toEqual({ state: "dismissed" });
    expect(target.database.prepare("SELECT state,action FROM outbox_lane_quarantines WHERE failed_reply_id=?").get(parent.id)).toEqual({
      state: "released",
      action: "dismiss_nested_review"
    });
  });

  it("routes an isolated Global Ring review to the failed Delivery thread", () => {
    const target = openStore();
    const failed = reserveGlobalReplaceable(target, "global-review", "global-root");
    isolateUncertain(target, failed);
    (target.preparedDeliveries as unknown as { setQuarantineReviewRenderer(renderer: (input: Record<string, unknown>) => object): void })
      .setQuarantineReviewRenderer((input) => ({ schema: "2.0", input }));

    target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-08T00:02:00.000Z" });

    expect(target.database.prepare("SELECT root_message_id,scope_kind,lane_key FROM outbound_replies WHERE idempotency_key=?")
      .get(`delivery-quarantine-review:${failed.replyId}`)).toEqual({
        root_message_id: "global-root",
        scope_kind: "global",
        lane_key: `gateway:feishu:primary:delivery-quarantine-review:${failed.replyId}`,
      });
  });

  it("keeps the checkpoint before an isolated gap and catches up across a completed bypass after resolution", () => {
    const target = openStore();
    activateBinding(target, "checkpoint-isolated", "pane-checkpoint-isolated");
    const failed = reserveReplaceable(target, "checkpoint-card-a", "checkpoint-isolated", 1, "card-a", "card-a");
    const independent = reserveReplaceable(target, "checkpoint-card-b", "checkpoint-isolated", 1, "card-b", "card-b");
    isolateUncertain(target, failed);
    const lease = target.acquireInstanceLease("checkpoint-owner", "2026-10-08T00:00:00.000Z", "2099-10-08T00:00:00.000Z");
    if (!lease) throw new Error("expected test lease");
    target.activateWriteFence(lease.ownerId, lease.fencingToken);
    const claim = target.preparedDeliveries.claimPreparedDelivery({
      delivery: independent,
      at: "2098-10-08T00:00:00.000Z",
      expiresAt: "2098-10-08T00:01:00.000Z"
    });
    if (!claim) throw new Error("expected independent claim");

    expect(target.preparedDeliveries.acknowledgePreparedDelivery(claim, {
      messageId: "card-b",
      surfaceId: null,
      threadId: null
    })).toBe(true);
    target.preparedDeliveries.loadScopePage({ scope: failed.scope, afterScopeKey: null, limit: 1, at: "2098-10-08T00:02:00.000Z" });
    expect(target.database.prepare(`SELECT committed_delivery_order FROM delivery_ring_checkpoints
      WHERE scope_key=?`).get(deliveryScopeKey(failed.scope))).toEqual({ committed_delivery_order: failed.deliveryOrder - 1 });

    target.database.prepare(`UPDATE outbound_replies SET state='dismissed',updated_at=?
      WHERE id=?`).run("2098-10-08T00:03:00.000Z", failed.replyId);
    target.database.prepare(`UPDATE outbox_lane_quarantines SET state='released',released_at=?,updated_at=?
      WHERE failed_reply_id=?`).run("2098-10-08T00:03:00.000Z", "2098-10-08T00:03:00.000Z", failed.replyId);
    target.preparedDeliveries.loadScopePage({ scope: failed.scope, afterScopeKey: null, limit: 1, at: "2098-10-08T00:03:00.000Z" });

    expect(target.database.prepare(`SELECT committed_delivery_order FROM delivery_ring_checkpoints
      WHERE scope_key=?`).get(deliveryScopeKey(failed.scope))).toEqual({ committed_delivery_order: independent.deliveryOrder });
  });

  it("applies the same conflict-isolation claim policy to the Global Ring", () => {
    const target = openStore();
    const failed = reserveGlobalReplaceable(target, "global-card-a", "global-a");
    const independent = reserveGlobalReplaceable(target, "global-card-b", "global-b");
    isolateUncertain(target, failed);
    const lease = target.acquireInstanceLease("global-owner", "2026-10-08T00:00:00.000Z", "2099-10-08T00:00:00.000Z");
    if (!lease) throw new Error("expected test lease");
    target.activateWriteFence(lease.ownerId, lease.fencingToken);

    expect(target.preparedDeliveries.loadScopePage({
      scope: { kind: "global" },
      afterScopeKey: null,
      limit: 1,
      at: "2098-10-08T00:00:00.000Z"
    }).items[0]).toMatchObject({
      authoritativeBlocker: { replyId: failed.replyId },
      head: { replyId: independent.replyId, status: "ready" }
    });
    expect(target.preparedDeliveries.claimPreparedDelivery({
      delivery: independent,
      at: "2098-10-08T00:00:00.000Z",
      expiresAt: "2098-10-08T00:01:00.000Z"
    })).toMatchObject({ replyId: independent.replyId });
  });

  it("reconstructs the isolated candidate and original checkpoint gap after restart", () => {
    const directory = mkdtempSync(join(tmpdir(), "delivery-conflict-isolation-"));
    const path = join(directory, "delivery.sqlite");
    const firstHandle = new SqliteBindingStore(path);
    connectPlanPreparer(firstHandle);
    try {
      activateBinding(firstHandle, "restart-isolated", "pane-restart-isolated");
      const failed = reserveReplaceable(firstHandle, "restart-card-a", "restart-isolated", 1, "card-a", "card-a");
      reserveReplaceable(firstHandle, "restart-card-b", "restart-isolated", 1, "card-b", "card-b");
      isolateUncertain(firstHandle, failed);
      firstHandle.preparedDeliveries.loadScopePage({ scope: failed.scope, afterScopeKey: null, limit: 1, at: "2098-10-08T00:00:00.000Z" });
      firstHandle.close();

      const reopened = new SqliteBindingStore(path);
      connectPlanPreparer(reopened);
      try {
        expect(reopened.preparedDeliveries.loadScopePage({
          scope: failed.scope,
          afterScopeKey: null,
          limit: 1,
          at: "2098-10-08T00:01:00.000Z"
        }).items[0]).toMatchObject({
          safeCommittedOrder: failed.deliveryOrder - 1,
          authoritativeBlocker: { replyId: failed.replyId },
          head: { replyId: "restart-card-b", status: "ready" }
        });
        expect(reopened.database.prepare(`SELECT state,phase FROM outbox_lane_quarantines
          WHERE failed_reply_id=?`).get(failed.replyId)).toEqual({ state: "active", phase: "conflict_isolated" });
      } finally {
        reopened.close();
      }
    } finally {
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("derives retry wakeups only from otherwise eligible scope heads", () => {
    const target = openStore();
    activateBinding(target, "retry", "pane-retry");
    reserve(target, "retry-head", "retry");
    target.database.prepare("UPDATE outbound_replies SET claim_attempt_id='claim',claimed_at='2026-10-08T00:00:00.000Z' WHERE id='retry-head'").run();
    target.database.prepare(`INSERT INTO lark_delivery_cooldowns(scope,blocked_until,trigger_count,last_reason,created_at,updated_at)
      VALUES('app','2099-01-01T00:00:00.000Z',1,'test','2026-10-08T00:00:00.000Z','2026-10-08T00:00:00.000Z')`).run();

    expect(target.preparedDeliveries.loadScopePage({ scope: null, afterScopeKey: null, limit: 10, at: "2090-01-01T00:00:00.000Z" }))
      .toMatchObject({ nextRetryAt: null, items: [{ head: { status: "claimed" } }] });
    target.database.prepare("UPDATE outbound_replies SET claim_attempt_id=NULL,claimed_at=NULL WHERE id='retry-head'").run();
    expect(target.preparedDeliveries.loadScopePage({ scope: null, afterScopeKey: null, limit: 10, at: "2090-01-01T00:00:00.000Z" }))
      .toMatchObject({ nextRetryAt: "2099-01-01T00:00:00.000Z", items: [{ head: { status: "cooldown_blocked" } }] });

    target.database.prepare("DELETE FROM lark_delivery_cooldowns").run();
    target.database.prepare("UPDATE outbound_replies SET next_attempt_at='2098-01-01T00:00:00.000Z' WHERE id='retry-head'").run();
    expect(target.preparedDeliveries.loadScopePage({ scope: null, afterScopeKey: null, limit: 10, at: "2090-01-01T00:00:00.000Z" }))
      .toMatchObject({ nextRetryAt: "2098-01-01T00:00:00.000Z", items: [{ head: { status: "future_due" } }] });
  });

  it("lazily checkpoints the terminal prefix immediately before an existing nonterminal head", () => {
    const target = openStore();
    activateBinding(target, "checkpoint", "pane-checkpoint");
    reserve(target, "terminal", "checkpoint");
    reserve(target, "pending", "checkpoint", 2);
    target.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='terminal-message' WHERE id='terminal'").run();
    const pending = target.preparedDeliveries.hydratePreparedDelivery("pending");
    if (pending.status !== "prepared") throw new Error(`unexpected hydration: ${pending.status}`);
    const before = target.database.prepare("SELECT id,state,delivery_order FROM outbound_replies ORDER BY delivery_order").all();

    expect(target.preparedDeliveries.loadOrInitializeCheckpoint({ scope: pending.delivery.scope, at: "2026-10-07T00:00:00.000Z" })).toMatchObject({
      consumer: "delivery-ring",
      scope: pending.delivery.scope,
      position: { kind: "delivery-order", value: pending.delivery.deliveryOrder - 1 }
    });
    expect(target.database.prepare("SELECT id,state,delivery_order FROM outbound_replies ORDER BY delivery_order").all()).toEqual(before);
  });

  it("reconciles the exact refill checkpoint forward and rebases it before reopened work", async () => {
    const target = openStore();
    activateBinding(target, "reconcile", "pane-reconcile");
    reserve(target, "terminal", "reconcile");
    reserve(target, "head", "reconcile", 2);
    target.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='terminal-message' WHERE id='terminal'").run();
    const hydrated = target.preparedDeliveries.hydratePreparedDelivery("head");
    if (hydrated.status !== "prepared") throw new Error(`unexpected hydration: ${hydrated.status}`);
    const scopeKey = deliveryScopeKey(hydrated.delivery.scope);

    target.preparedDeliveries.loadOrInitializeCheckpoint({ scope: hydrated.delivery.scope, at: "2026-10-08T00:00:00.000Z" });
    target.database.prepare("UPDATE delivery_ring_checkpoints SET committed_delivery_order=0 WHERE scope_key=?").run(scopeKey);
    expect(target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 1, at: "2026-10-08T00:01:00.000Z" }))
      .toMatchObject({ items: [expect.objectContaining({ replyId: "head" })] });
    expect(target.database.prepare("SELECT committed_delivery_order FROM delivery_ring_checkpoints WHERE scope_key=?").get(scopeKey))
      .toEqual({ committed_delivery_order: hydrated.delivery.deliveryOrder - 1 });

    target.database.prepare("UPDATE outbound_replies SET state='pending',delivered_message_id=NULL WHERE id='terminal'").run();
    expect(target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 1, at: "2026-10-08T00:02:00.000Z" }))
      .toMatchObject({ items: [expect.objectContaining({ replyId: "terminal" })] });
    expect(target.database.prepare("SELECT committed_delivery_order FROM delivery_ring_checkpoints WHERE scope_key=?").get(scopeKey))
      .toEqual({ committed_delivery_order: 0 });
    expect(target.getOperationalSummary().semanticDeliveryRollout.checkpointBackwardRebases).toBe(1);
  });

  it("reconciles checkpointed terminal-only scopes only after their page is returned", () => {
    const target = openStore();
    const scope = { kind: "global" } as const;
    const scopeKey = deliveryScopeKey(scope);
    target.preparedDeliveries.loadOrInitializeCheckpoint({ scope, at: "2026-10-08T00:00:00.000Z" });
    target.enqueueOutboundReply({ id: "global-terminal", idempotencyKey: "global-terminal", rootMessageId: "root", kind: "text", payload: "terminal" });
    target.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='message' WHERE id='global-terminal'").run();
    activateBinding(target, "pane-terminal", "pane-terminal");
    reserve(target, "pane-terminal", "pane-terminal");
    target.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='message' WHERE id='pane-terminal'").run();
    const pane = target.preparedDeliveries.hydratePreparedDelivery("pane-terminal");
    if (pane.status !== "prepared") throw new Error(`unexpected hydration: ${pane.status}`);
    const paneScopeKey = deliveryScopeKey(pane.delivery.scope);
    target.preparedDeliveries.loadOrInitializeCheckpoint({ scope: pane.delivery.scope, at: "2026-10-08T00:00:00.000Z" });

    expect(target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 1, at: "2026-10-08T00:01:00.000Z" })).toEqual({ items: [], nextCursor: scopeKey });
    expect(target.database.prepare("SELECT committed_delivery_order,updated_at FROM delivery_ring_checkpoints WHERE scope_key=?").get(scopeKey))
      .toEqual({ committed_delivery_order: 1, updated_at: "2026-10-08T00:01:00.000Z" });
    expect(target.database.prepare("SELECT committed_delivery_order,updated_at FROM delivery_ring_checkpoints WHERE scope_key=?").get(paneScopeKey))
      .toEqual({ committed_delivery_order: 2, updated_at: "2026-10-08T00:00:00.000Z" });

    expect(target.preparedDeliveries.listScopeHeads({ afterScopeKey: scopeKey, limit: 1, at: "2026-10-08T00:02:00.000Z" })).toEqual({ items: [], nextCursor: null });
    expect(target.database.prepare("SELECT committed_delivery_order,updated_at FROM delivery_ring_checkpoints WHERE scope_key=?").get(paneScopeKey))
      .toEqual({ committed_delivery_order: 2, updated_at: "2026-10-08T00:00:00.000Z" });
  });

  it("reports oldest unprepared semantic work and unmet prerequisite lag without exposing identities", () => {
    const target=openStore(); activateBinding(target,"diagnostics","pane-diagnostics");
    const receipt=target.reserveSemanticOutboundReply({
      id:"semantic-diagnostic",idempotencyKey:"semantic-diagnostic",bindingId:"diagnostics",bindingGeneration:1,
      rootMessageId:"root-diagnostics",kind:"card_reply",payload:"{}",projectionKey:"turn-card:diagnostic:page:0",
      snapshotRevision:1,viewVersion:1,laneKeyOverride:"turn-card:diagnostic:page:0",
      subject:{ kind:"conversation-page",segmentId:"diagnostic",pageIndex:0,revision:1 },snapshot:{ schemaVersion:1 },
      plannerPolicyVersion:1,rendererPolicyVersion:1,gatewayProfileVersion:1
    });
    receipt.consumeEffects();
    reserve(target,"required-diagnostic","diagnostics",2);
    reserve(target,"dependent-diagnostic","diagnostics",3);
    target.preparedDeliveries.addPrerequisite({ dependentReplyId:"dependent-diagnostic",prerequisiteReplyId:"required-diagnostic",requiredState:"delivered" });
    target.database.prepare("UPDATE outbound_replies SET created_at='2026-10-10T00:00:00.000Z' WHERE id='semantic-diagnostic'").run();
    target.database.prepare("UPDATE outbound_reply_prerequisites SET created_at='2026-10-10T00:01:00.000Z' WHERE dependent_reply_id='dependent-diagnostic'").run();

    const summary=target.getOperationalSummary().semanticDeliveryRollout;
    expect(summary).toMatchObject({ oldestUnpreparedSemanticAt:"2026-10-10T00:00:00.000Z",unmetPrerequisiteCount:1,oldestUnmetPrerequisiteAt:"2026-10-10T00:01:00.000Z" });
    expect(summary.oldestUnpreparedSemanticAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(summary.oldestUnmetPrerequisiteAgeSeconds).toBeGreaterThanOrEqual(0);
    expect(JSON.stringify(summary)).not.toContain("semantic-diagnostic");
    expect(JSON.stringify(summary)).not.toContain("dependent-diagnostic");
  });

  it("initializes empty and terminal-only scopes at their current maximum without rewriting history", () => {
    const target = openStore();
    const emptyScope = { kind: "global" } as const;
    expect(target.preparedDeliveries.loadOrInitializeCheckpoint({ scope: emptyScope, at: "2026-10-07T00:00:00.000Z" }))
      .toMatchObject({ position: { kind: "delivery-order", value: 0 } });

    activateBinding(target, "terminal-only", "pane-terminal-only");
    reserve(target, "terminal-only", "terminal-only");
    target.database.prepare("UPDATE outbound_replies SET state='dismissed' WHERE id='terminal-only'").run();
    const delivery = target.preparedDeliveries.hydratePreparedDelivery("terminal-only");
    if (delivery.status !== "prepared") throw new Error(`unexpected hydration: ${delivery.status}`);
    const before = target.database.prepare("SELECT state,delivery_order FROM outbound_replies WHERE id='terminal-only'").get();
    expect(target.preparedDeliveries.loadOrInitializeCheckpoint({ scope: delivery.delivery.scope, at: "2026-10-07T00:00:00.000Z" }))
      .toMatchObject({ position: { value: delivery.delivery.deliveryOrder } });
    expect(target.database.prepare("SELECT state,delivery_order FROM outbound_replies WHERE id='terminal-only'").get()).toEqual(before);
  });

  it("keeps unresolved heads blocking, recognizes completed replacements as terminal, and tolerates global order gaps", () => {
    const target = openStore();
    activateBinding(target, "checkpoint-edges", "pane-checkpoint-edges");
    const unresolved = reserveReplaceable(target, "unresolved", "checkpoint-edges", 1);
    const replacement = reserveReplaceable(target, "replacement", "checkpoint-edges", 2);
    target.database.prepare("UPDATE outbound_replies SET state='dead_letter',failure_class='permanent',effect_certainty='rejected' WHERE id='unresolved'").run();
    expect(target.preparedDeliveries.loadOrInitializeCheckpoint({ scope: unresolved.scope, at: "2026-10-07T00:00:00.000Z" }))
      .toMatchObject({ position: { value: unresolved.deliveryOrder - 1 } });
    target.database.prepare("UPDATE delivery_recoveries SET state='recovered',replacement_reply_id='replacement',resolved_by_reply_id='replacement' WHERE failed_reply_id='unresolved'").run();
    target.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='replacement-message' WHERE id='replacement'").run();
    target.database.prepare("DELETE FROM delivery_ring_checkpoints WHERE scope_key=?").run('["pane","workspace","pane-checkpoint-edges"]');
    expect(target.preparedDeliveries.loadOrInitializeCheckpoint({ scope: unresolved.scope, at: "2026-10-07T00:00:01.000Z" }))
      .toMatchObject({ position: { value: replacement.deliveryOrder } });

    activateBinding(target, "gap", "pane-gap");
    reserve(target, "gap-terminal", "gap");
    reserve(target, "gap-head", "gap", 2);
    target.database.prepare("UPDATE outbound_replies SET state='delivered' WHERE id='gap-terminal'").run();
    const head = target.preparedDeliveries.hydratePreparedDelivery("gap-head");
    if (head.status !== "prepared") throw new Error(`unexpected hydration: ${head.status}`);
    expect(target.preparedDeliveries.loadOrInitializeCheckpoint({ scope: head.delivery.scope, at: "2026-10-07T00:00:02.000Z" }))
      .toMatchObject({ position: { value: head.delivery.deliveryOrder - 1 } });
  });

  it("conservatively discovers terminal delivery debt without exposing it as a Ring head", () => {
    const target = openStore();
    activateBinding(target, "terminal-debt", "pane-terminal-debt");
    const failed = reserveReplaceable(target, "terminal-debt-failed", "terminal-debt", 1);
    const replacement = reserveReplaceable(target, "terminal-debt-replacement", "terminal-debt", 2);
    target.database.prepare("UPDATE outbound_replies SET state='dead_letter',failure_class='permanent',effect_certainty='rejected' WHERE id=?").run(failed.replyId);
    target.preparedDeliveries.loadOrInitializeCheckpoint({ scope: failed.scope, at: "2026-10-07T00:00:00.000Z" });
    target.database.prepare("UPDATE delivery_recoveries SET state='recovered',replacement_reply_id=?,resolved_by_reply_id=? WHERE failed_reply_id=?")
      .run(replacement.replyId, replacement.replyId, failed.replyId);
    target.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='replacement-message' WHERE id=?").run(replacement.replyId);
    target.database.prepare("DELETE FROM delivery_ring_checkpoints WHERE scope_key=?").run(deliveryScopeKey(failed.scope));

    const page = target.preparedDeliveries.loadScopePage({ scope: null, afterScopeKey: null, limit: 4, at: "2026-10-07T00:00:01.000Z" });

    expect(page.items).toEqual([expect.objectContaining({
      scopeKey: deliveryScopeKey(failed.scope),
      safeCommittedOrder: replacement.deliveryOrder,
      authoritativeBlocker: null,
      head: null
    })]);
    expect(target.database.prepare("SELECT committed_delivery_order FROM delivery_ring_checkpoints WHERE scope_key=?").get(deliveryScopeKey(failed.scope)))
      .toEqual({ committed_delivery_order: replacement.deliveryOrder });
  });

  it("fails closed for malformed persisted scopes and leaves no checkpoint after a failed bootstrap", () => {
    const target = openStore();
    const scope = { kind: "global" } as const;
    target.database.prepare(`INSERT INTO delivery_ring_checkpoints(scope_key,scope_kind,scope_workspace_id,scope_pane_id,committed_delivery_order,created_at,updated_at)
      VALUES(?,?,?,?,?,?,?)`).run('["global"]', "pane", "workspace", "pane", 0, "2026-10-07T00:00:00.000Z", "2026-10-07T00:00:00.000Z");
    expect(() => target.preparedDeliveries.loadOrInitializeCheckpoint({ scope, at: "2026-10-07T00:00:01.000Z" })).toThrow("delivery_checkpoint_scope_conflict");
    target.database.prepare("DELETE FROM delivery_ring_checkpoints WHERE scope_key='[\"global\"]'").run();
    target.database.exec("CREATE TEMP TRIGGER reject_delivery_checkpoint BEFORE INSERT ON delivery_ring_checkpoints BEGIN SELECT RAISE(ABORT, 'bootstrap rollback'); END;");
    expect(() => target.preparedDeliveries.loadOrInitializeCheckpoint({ scope, at: "2026-10-07T00:00:02.000Z" })).toThrow("bootstrap rollback");
    expect(target.database.prepare("SELECT 1 FROM delivery_ring_checkpoints WHERE scope_key='[\"global\"]'").get()).toBeUndefined();
  });

  it("makes bootstrap idempotent across competing handles and records the empty migration only", () => {
    const directory = mkdtempSync(join(tmpdir(), "delivery-ring-checkpoint-"));
    const path = join(directory, "checkpoint.sqlite");
    const scope = { kind: "global" } as const;
    const firstHandle = new SqliteBindingStore(path);
    const secondHandle = new SqliteBindingStore(path);
    try {
      const first = firstHandle.preparedDeliveries.loadOrInitializeCheckpoint({ scope, at: "2026-10-07T00:00:00.000Z" });
      const second = secondHandle.preparedDeliveries.loadOrInitializeCheckpoint({ scope, at: "2026-10-07T00:01:00.000Z" });
      expect(second).toEqual(first);
      expect(secondHandle.database.prepare("SELECT COUNT(*) AS count FROM delivery_ring_checkpoints").get()).toEqual({ count: 1 });
      expect(secondHandle.database.prepare("SELECT version FROM schema_migrations WHERE version=110").get()).toEqual({ version: 110 });
    } finally {
      firstHandle.close();
      secondHandle.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("pages one authoritative earliest nonterminal head per scope and keeps an unprepared head blocking", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    activateBinding(target, "b", "pane-b");
    target.enqueueOutboundReply({ id: "a-unprepared", idempotencyKey: "a-unprepared", bindingId: "a", bindingGeneration: 1, rootMessageId: "root-a", kind: "text", payload: "first" });
    reserve(target, "a-prepared", "a");
    reserve(target, "b-prepared", "b");

    const first = target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 1, at: "2099-01-01T00:00:00.000Z" });
    const second = target.preparedDeliveries.listScopeHeads({ afterScopeKey: first.nextCursor, limit: 1, at: "2099-01-01T00:00:00.000Z" });

    expect([...first.items, ...second.items]).toEqual([
      expect.objectContaining({ replyId: "a-unprepared", status: "unprepared" }),
      expect.objectContaining({ replyId: "b-prepared", status: "ready", delivery: expect.objectContaining({ replyId: "b-prepared" }) })
    ]);
    expect(first.nextCursor).not.toBeNull();
    expect(second.nextCursor).toBeNull();
  });

  it("discovers one independent Ring for the Primary and each Worker Pane", () => {
    const target = openStore();
    activateBinding(target, "parent", "primary-pane");
    const createWorker = (id: string, paneId: string) => {
      const created = target.createWorkerAgentInstance({
        id, projectId: "project", name: id, role: "worker", agentKind: "traex", model: null, desiredState: "running",
        parent: { bindingId: "parent", bindingGeneration: 1, paneId: "primary-pane", nativeSessionId: "primary-session" },
        workspace: { id: `${id}-workspace`, kind: "shared-read-only", cwd: "/repo", branch: null, baseCommit: "base" }
      }, 4).instance;
      return target.attachAgentInstanceRuntime({
        instanceId: created.id, expectedGeneration: created.generation,
        herdrWorkspaceId: "workspace", paneId, nativeSessionId: `${id}-session`
      })!;
    };
    const workerA = createWorker("worker-a", "worker-pane-a");
    const workerB = createWorker("worker-b", "worker-pane-b");
    reserve(target, "primary", "parent");
    for (const worker of [workerA, workerB]) target.reservePreparedOutboundReply({
      id: `${worker.id}-item`, idempotencyKey: `${worker.id}-item`, bindingId: "parent",
      workerId: worker.id, workerSessionGeneration: worker.workerSessionGeneration,
      rootMessageId: `${worker.id}-root`, kind: "card_reply", payload: "{}"
    });

    const rows = target.database.prepare("SELECT id,scope_key,scope_pane_id,delivery_parent_pane_id FROM outbound_replies WHERE id IN ('primary','worker-a-item','worker-b-item') ORDER BY id").all();
    expect(rows).toEqual([
      { id: "primary", scope_key: '["pane","workspace","primary-pane"]', scope_pane_id: "primary-pane", delivery_parent_pane_id: null },
      { id: "worker-a-item", scope_key: '["pane","workspace","worker-pane-a"]', scope_pane_id: "worker-pane-a", delivery_parent_pane_id: "primary-pane" },
      { id: "worker-b-item", scope_key: '["pane","workspace","worker-pane-b"]', scope_pane_id: "worker-pane-b", delivery_parent_pane_id: "primary-pane" }
    ]);
    expect(target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 10, at: "2099-01-01T00:00:00.000Z" }).items).toHaveLength(3);
  });

  it("classifies future, claimed, quarantined, dead-letter, and unmet-prerequisite heads without mutation", () => {
    const target = openStore();
    for (const id of ["future", "claimed", "quarantine", "dead", "blocked", "required"]) activateBinding(target, id, `pane-${id}`);
    for (const id of ["future", "claimed", "quarantine", "dead", "blocked", "required"]) reserve(target, id, id);
    target.database.prepare("UPDATE outbound_replies SET next_attempt_at=? WHERE id='future'").run("2099-01-01T00:00:00.000Z");
    target.database.prepare("UPDATE outbound_replies SET claim_attempt_id='attempt', claimed_at='2026-01-01T00:00:00.000Z' WHERE id='claimed'").run();
    target.database.prepare("INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at) SELECT lane_key,id,'immutable','permanent','active','blocked','test',datetime('now'),datetime('now') FROM outbound_replies WHERE id='quarantine'").run();
    target.database.prepare("UPDATE outbound_replies SET state='dead_letter' WHERE id='dead'").run();
    target.preparedDeliveries.addPrerequisite({ dependentReplyId: "blocked", prerequisiteReplyId: "required", requiredState: "delivered" });

    const before = target.database.prepare("SELECT id,state,claim_attempt_id FROM outbound_replies ORDER BY id").all();
    const heads = target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 20, at: "2090-01-01T00:00:00.000Z" });
    const status = Object.fromEntries(heads.items.map((item) => [item.replyId, item.status]));
    expect(status).toMatchObject({ future: "future_due", claimed: "claimed", quarantine: "quarantined", dead: "dead_letter", blocked: "prerequisite_blocked", required: "ready" });
    expect(target.database.prepare("SELECT id,state,claim_attempt_id FROM outbound_replies ORDER BY id").all()).toEqual(before);
  });

  it("reports only actually eligible Ring scope heads as ready", () => {
    const target = openStore();
    for (const id of ["ready", "dead", "quarantined", "blocked", "future", "claimed", "required"]) activateBinding(target, id, `pane-${id}`);
    reserve(target, "ready", "ready");
    reserve(target, "dead-head", "dead");
    reserve(target, "dead-successor", "dead", 2);
    reserve(target, "quarantined", "quarantined");
    reserve(target, "blocked", "blocked");
    reserve(target, "future", "future");
    reserve(target, "claimed", "claimed");
    reserve(target, "required", "required");
    target.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='required' WHERE id='required'").run();
    target.database.prepare("UPDATE outbound_replies SET state='dead_letter',failure_class='permanent',effect_certainty='rejected',dead_lettered_at='2026-10-06T00:00:00.000Z' WHERE id='dead-head'").run();
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at)
      SELECT lane_key,id,'immutable','permanent','active','blocked','test','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z' FROM outbound_replies WHERE id IN ('dead-head','quarantined')`).run();
    target.preparedDeliveries.addPrerequisite({ dependentReplyId: "blocked", prerequisiteReplyId: "required", requiredState: "dismissed" });
    target.database.prepare("UPDATE outbound_replies SET next_attempt_at='2999-01-01T00:00:00.000Z' WHERE id='future'").run();
    target.database.prepare("UPDATE outbound_replies SET claim_attempt_id='claim',claimed_at='2026-10-06T00:00:00.000Z' WHERE id='claimed'").run();

    expect(target.getOperationalSummary().deliveryRings).toMatchObject({
      pending: 6,
      ready: 1,
      retryWait: 1,
      activeClaims: 1,
      waitingBehindScope: 3
    });

    target.database.prepare(`INSERT INTO lark_delivery_cooldowns(scope,blocked_until,trigger_count,last_reason,created_at,updated_at)
      VALUES('app','2999-01-01T00:00:00.000Z',1,'test','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z')`).run();
    expect(target.getOperationalSummary().deliveryRings).toMatchObject({ ready: 0, retryWait: 1, activeClaims: 1, waitingBehindScope: 4 });
  });

  it("hydrates frozen plans and checkpoints and rejects corrupt hashes", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reserve(target, "prepared", "a", 3);
    const cardId = "surface-1";
    target.database.prepare("UPDATE outbound_replies SET card_id_checkpoint=?, gateway_checkpoint_json=? WHERE id='prepared'")
      .run(cardId, JSON.stringify({ kind: "surface", gatewayId: "feishu:primary", opaqueId: cardId }));

    expect(target.preparedDeliveries.hydratePreparedDelivery("prepared")).toEqual({
      status: "prepared",
      delivery: expect.objectContaining({ replyId: "prepared", snapshotRevision: 3, priorCheckpoints: [{ kind: "surface", ref: { gatewayId: "feishu:primary", kind: "surface", opaqueId: cardId } }] })
    });
    target.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
    target.database.prepare("UPDATE outbound_replies SET gateway_plan_hash=? WHERE id='prepared'").run(createHash("sha256").update("different").digest("hex"));
    expect(target.preparedDeliveries.hydratePreparedDelivery("prepared")).toMatchObject({ status: "invalid", reason: "plan_hash_mismatch" });
  });

  it("maps legacy prepared effects and semantic snapshots through one validated public seam", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reserve(target, "legacy", "a", 2);
    reserve(target, "semantic", "a", 3);

    expect(target.preparedDeliveries.hydrateDeliveryInput("legacy")).toMatchObject({
      status: "prepared-effect",
      input: { kind: "prepared-effect", effect: { protocolVersion: 1 } },
      delivery: { replyId: "legacy", snapshotRevision: 2 }
    });

    const encoded = replaceSemanticIdentity(target, "semantic");
    expect(target.preparedDeliveries.hydrateDeliveryInput("semantic")).toEqual({
      status: "semantic-snapshot",
      input: {
        kind: "semantic-snapshot",
        subject: { kind: "conversation-page", segmentId: "segment-1", pageIndex: 0, revision: 3 },
        snapshot: JSON.parse(encoded.snapshotJson),
        snapshotHash: encoded.snapshotHash,
        plannerPolicyVersion: 4,
        rendererPolicyVersion: 5,
        gatewayProfileVersion: 6
      },
      preparationState: "prepared",
      preparedDelivery: expect.objectContaining({ replyId: "semantic", snapshotRevision: 3 })
    });
    expect(target.preparedDeliveries.hydratePreparedDelivery("semantic")).toMatchObject({
      status: "prepared", delivery: { replyId: "semantic", snapshotRevision: 3 }
    });
    expect(() => target.database.prepare("UPDATE outbound_replies SET subject_revision=4 WHERE id='semantic'").run())
      .toThrow(/immutable_semantic_delivery_identity/);
  });

  it("commits a semantic snapshot before returning complete Ring work", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    const snapshot = { schemaVersion: 1, kind: "conversation-turn-card", timeline: [] };
    const reservation = target as unknown as { reserveSemanticOutboundReply(input: object): { commitState: string; consumeEffects(): readonly unknown[] } };

    const receipt = reservation.reserveSemanticOutboundReply({
      id: "semantic-hot", idempotencyKey: "semantic-hot", bindingId: "a", bindingGeneration: 1,
      rootMessageId: "root-a", kind: "card_reply", payload: "{}", projectionKey: "turn-card:segment-1:page:0",
      snapshotRevision: 3, viewVersion: 3, laneKeyOverride: "turn-card:segment-1:page:0",
      subject: { kind: "conversation-page", segmentId: "segment-1", pageIndex: 0, revision: 3 },
      snapshot, plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
    });

    expect(receipt.commitState).toBe("committed");
    expect(target.preparedDeliveries.hydrateDeliveryInput("semantic-hot")).toMatchObject({
      status: "semantic-snapshot", preparationState: "reserved", preparedDelivery: null,
      input: { subject: { segmentId: "segment-1", pageIndex: 0, revision: 3 }, snapshot }
    });
    expect(receipt.consumeEffects()).toEqual([
      expect.objectContaining({ replyId: "semantic-hot", input: expect.objectContaining({ kind: "semantic-snapshot" }), preparationState: "reserved" })
    ]);
    expect(receipt.consumeEffects()).toEqual([]);
  });

  it("observes the committed Outbox stage before a synchronous Ring grant", () => {
    const target = openStore();
    activateBinding(target, "trace-order", "pane-trace-order");
    const trace = target.capabilityModules().deliveryTrace;
    const stages: string[] = [];
    trace.subscribe({ onObservation: ({ stage }) => { stages.push(stage); } });
    trace.subscribe({ onObservation: () => { throw new Error("isolated trace listener"); } });
    trace.observe({ stage: "core_projected", monotonicAtMs: 10, correlation: { coreEventId: "core-order", segmentId: "segment-order" } });

    const receipt = target.reserveSemanticOutboundReply({
      id: "semantic-order", idempotencyKey: "semantic-order", bindingId: "trace-order", bindingGeneration: 1,
      rootMessageId: "root-trace-order", kind: "card_reply", payload: "{}", projectionKey: "turn-card:segment-order:page:0",
      snapshotRevision: 1, viewVersion: 1, laneKeyOverride: "turn-card:segment-order:page:0",
      subject: { kind: "conversation-page", segmentId: "segment-order", pageIndex: 0, revision: 1 },
      snapshot: { schemaVersion: 1 }, plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
    });
    trace.mark({ stage: "ring_granted", correlation: { replyId: receipt.result.id, attemptId: "attempt-order" } });
    trace.mark({ stage: "gateway_acknowledged", correlation: { attemptId: "attempt-order", receiptId: "receipt-order" } });
    trace.mark({ stage: "settled", outcome: "succeeded", correlation: { attemptId: "attempt-order", receiptId: "receipt-order" } });

    expect(stages).toEqual(["core_projected", "outbox_committed", "ring_granted", "gateway_acknowledged", "settled"]);
    expect(trace.snapshot().stageDurationsMs.outboxToRing).toBeGreaterThanOrEqual(0);
  });

  it("CAS-freezes one semantic Gateway plan before it can become executable", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    const snapshot = { schemaVersion: 1, kind: "conversation-turn-card", timeline: [] };
    const receipt = target.reserveSemanticOutboundReply({
      id: "semantic-freeze", idempotencyKey: "semantic-freeze", bindingId: "a", bindingGeneration: 1,
      rootMessageId: "root-a", kind: "card_reply", payload: "{}", projectionKey: "turn-card:segment-1:page:0",
      snapshotRevision: 3, viewVersion: 3, laneKeyOverride: "turn-card:segment-1:page:0",
      subject: { kind: "conversation-page", segmentId: "segment-1", pageIndex: 0, revision: 3 },
      snapshot, plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
    });
    const work = receipt.consumeEffects()[0]!;
    if (!("input" in work)) throw new Error("expected semantic work");
    const plan: PreparedDeliveryPlan = {
      protocolVersion: 1, gatewayId: "feishu:primary", profileId: "feishu-cardkit-v1", rendererRevision: 1,
      operation: "message.reply.view", intent: { kind: "message.reply.view", purpose: "operation-result", rootMessageId: "root-a", view: { schemaVersion: 1, fallbackText: "turn", heading: null, nodes: [], mutable: true, streaming: true }, idempotencyKey: "semantic-freeze" }
    };
    const freezing = target.preparedDeliveries as unknown as { freezeSemanticDelivery(input: { work: typeof work; preparedPlan: PreparedDeliveryPlan }): { outcome: string; delivery?: PreparedDelivery } };

    expect(freezing.freezeSemanticDelivery({ work, preparedPlan: plan })).toMatchObject({
      outcome: "prepared", delivery: { replyId: "semantic-freeze", preparedPlan: plan, snapshotRevision: 3 }
    });
    expect(target.preparedDeliveries.hydrateDeliveryInput("semantic-freeze")).toMatchObject({
      status: "semantic-snapshot", preparationState: "prepared", preparedDelivery: { replyId: "semantic-freeze" }
    });
    expect(freezing.freezeSemanticDelivery({ work, preparedPlan: plan })).toEqual({ outcome: "stale" });
    expect(target.getOperationalSummary().semanticDeliveryRollout.preparationCasFailures).toBe(1);
  });

  it("rejects stale semantic snapshot and renderer identities during plan freeze", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    const receipt = target.reserveSemanticOutboundReply({
      id: "semantic-stale-freeze", idempotencyKey: "semantic-stale-freeze", bindingId: "a", bindingGeneration: 1,
      rootMessageId: "root-a", kind: "card_reply", payload: "{}", projectionKey: "turn-card:segment-1:page:0",
      snapshotRevision: 3, viewVersion: 3, laneKeyOverride: "turn-card:segment-1:page:0",
      subject: { kind: "conversation-page", segmentId: "segment-1", pageIndex: 0, revision: 3 },
      snapshot: { schemaVersion: 1, kind: "conversation-turn-card", timeline: [] },
      plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
    });
    const work = receipt.consumeEffects()[0]!;
    if (!("input" in work)) throw new Error("expected semantic work");
    const plan: PreparedDeliveryPlan = {
      protocolVersion: 1, gatewayId: work.gatewayId, profileId: work.gatewayProfileId, rendererRevision: 2,
      operation: "message.reply.view", intent: { kind: "message.reply.view", purpose: "operation-result", rootMessageId: work.rootMessageId, view: {}, idempotencyKey: work.idempotencyKey }
    };

    expect(target.preparedDeliveries.freezeSemanticDelivery({ work, preparedPlan: plan })).toEqual({ outcome: "stale" });
    expect(target.preparedDeliveries.freezeSemanticDelivery({
      work: { ...work, input: { ...work.input, snapshotHash: "0".repeat(64) } },
      preparedPlan: { ...plan, rendererRevision: 1 }
    })).toEqual({ outcome: "stale" });
    expect(target.preparedDeliveries.hydrateDeliveryInput(work.replyId)).toMatchObject({
      status: "semantic-snapshot", preparationState: "reserved", preparedDelivery: null
    });
    expect(target.getOperationalSummary().semanticDeliveryRollout.preparationCasFailures).toBe(0);
  });

  it("reuses the exact frozen semantic plan after reopen without rerendering", () => {
    const directory = mkdtempSync(join(tmpdir(), "semantic-delivery-freeze-"));
    const path = join(directory, "state.sqlite");
    const first = new SqliteBindingStore(path);
    try {
      activateBinding(first, "a", "pane-a");
      const receipt = first.reserveSemanticOutboundReply({
        id: "semantic-frozen-reopen", idempotencyKey: "semantic-frozen-reopen", bindingId: "a", bindingGeneration: 1,
        rootMessageId: "root-a", kind: "card_reply", payload: "{}", projectionKey: "turn-card:segment-1:page:0",
        snapshotRevision: 3, viewVersion: 3, laneKeyOverride: "turn-card:segment-1:page:0",
        subject: { kind: "conversation-page", segmentId: "segment-1", pageIndex: 0, revision: 3 },
        snapshot: { schemaVersion: 1, kind: "conversation-turn-card", timeline: [] },
        plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
      });
      const work = receipt.consumeEffects()[0]!;
      if (!("input" in work)) throw new Error("expected semantic work");
      const plan: PreparedDeliveryPlan = {
        protocolVersion: 1, gatewayId: work.gatewayId, profileId: work.gatewayProfileId, rendererRevision: 1,
        operation: "message.reply.view", intent: { kind: "message.reply.view", purpose: "operation-result", rootMessageId: work.rootMessageId, view: { frozen: true }, idempotencyKey: work.idempotencyKey }
      };
      const frozen = first.preparedDeliveries.freezeSemanticDelivery({ work, preparedPlan: plan });
      expect(frozen).toMatchObject({ outcome: "prepared", delivery: { preparedPlan: plan } });
      expect(first.preparedDeliveries.freezeSemanticDelivery({ work, preparedPlan: plan })).toEqual({ outcome: "stale" });
      first.close();

      const reopened = new SqliteBindingStore(path);
      try {
        expect(reopened.preparedDeliveries.hydrateDeliveryWork(work.replyId)).toEqual({
          status: "ready", work: expect.objectContaining({ preparedPlan: plan, planHash: frozen.outcome === "prepared" ? frozen.delivery.planHash : "" })
        });
        expect(reopened.getOperationalSummary().semanticDeliveryRollout.preparationCasFailures).toBe(1);
      } finally {
        reopened.close();
      }
    } finally {
      try { first.close(); } catch {}
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("settles a semantic Conversation Page in the same transaction as its ACK", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    const at = "2026-10-10T00:00:00.000Z";
    target.database.prepare(`INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at)
      VALUES('segment-settle','lane','primary','a',1,'traex','hello','working',3,'root-a',?,?)`).run(at, at);
    target.database.prepare(`INSERT INTO conversation_segment_pages(id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,created_at,updated_at)
      VALUES('segment-settle:page:0','segment-settle',0,'old-message','old-card','turn-card:segment-settle:page:0','active',3,2,?,?)`).run(at, at);
    const receipt = target.reserveSemanticOutboundReply({
      id: "semantic-settle", idempotencyKey: "semantic-settle", bindingId: "a", bindingGeneration: 1,
      rootMessageId: "old-message", kind: "card_update", payload: "{}", projectionKey: "turn-card:segment-settle:page:0",
      snapshotRevision: 3, viewVersion: 3, laneKeyOverride: "turn-card:segment-settle:page:0",
      subject: { kind: "conversation-page", segmentId: "segment-settle", pageIndex: 0, revision: 3 },
      snapshot: { schemaVersion: 1, kind: "conversation-turn-card", timeline: [] },
      plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
    });
    target.database.prepare("UPDATE conversation_segment_pages SET pending_reply_id='semantic-settle' WHERE id='segment-settle:page:0'").run();
    const work = receipt.consumeEffects()[0]!;
    if (!("input" in work)) throw new Error("expected semantic work");
    const plan: PreparedDeliveryPlan = { protocolVersion: 1, gatewayId: work.gatewayId, profileId: work.gatewayProfileId, rendererRevision: 1, operation: "surface.replace", intent: { kind: "surface.replace", purpose: "operation-result", messageId: "old-message", view: {} } };
    const frozen = target.preparedDeliveries.freezeSemanticDelivery({ work, preparedPlan: plan });
    if (frozen.outcome !== "prepared") throw new Error("expected prepared delivery");
    const lease = target.acquireInstanceLease("settle-owner", at, "2099-10-10T00:00:00.000Z")!;
    target.activateWriteFence(lease.ownerId, lease.fencingToken);
    const claim = target.preparedDeliveries.claimPreparedDelivery({ delivery: frozen.delivery, at: "2098-10-10T00:00:00.000Z", expiresAt: "2098-10-10T00:01:00.000Z" })!;

    expect(target.preparedDeliveries.acknowledgePreparedDelivery(claim, { messageId: "new-message", surfaceId: "new-card", threadId: null })).toBe(true);
    expect(target.database.prepare("SELECT message_id,card_id,pending_reply_id,delivered_sequence FROM conversation_segment_pages WHERE id='segment-settle:page:0'").get()).toEqual({
      message_id: "new-message", card_id: "new-card", pending_reply_id: null, delivered_sequence: 3
    });
    expect(target.preparedDeliveries.acknowledgePreparedDelivery(claim, { messageId: "duplicate-message", surfaceId: "duplicate-card", threadId: null })).toBe(false);
    expect(target.database.prepare("SELECT delivered_message_id,card_id_checkpoint,attempt_count FROM outbound_replies WHERE id='semantic-settle'").get()).toEqual({
      delivered_message_id: "new-message", card_id_checkpoint: "new-card", attempt_count: 1
    });
  });

  it("rolls back the semantic ACK when Conversation Page settlement cannot commit", () => {
    const target = openStore();
    activateBinding(target, "rollback-settle", "pane-rollback-settle");
    const at = "2026-10-10T00:00:00.000Z";
    target.database.prepare(`INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at)
      VALUES('segment-rollback','lane','primary','rollback-settle',1,'traex','hello','working',3,'root-a',?,?)`).run(at, at);
    target.database.prepare(`INSERT INTO conversation_segment_pages(id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,created_at,updated_at)
      VALUES('segment-rollback:page:0','segment-rollback',0,'old-message','old-card','turn-card:segment-rollback:page:0','active',3,2,?,?)`).run(at, at);
    const lease = target.acquireInstanceLease("rollback-owner", at, "2099-10-10T00:00:00.000Z")!;
    target.activateWriteFence(lease.ownerId, lease.fencingToken);
    const { claim } = reserveClaimedSemanticPage(target, {
      id: "semantic-rollback", bindingId: "rollback-settle", segmentId: "segment-rollback", pageIndex: 0, revision: 3, rootMessageId: "old-message"
    });
    target.database.exec(`CREATE TEMP TRIGGER reject_semantic_page_settlement BEFORE UPDATE ON conversation_segment_pages
      WHEN NEW.pending_reply_id IS NULL BEGIN SELECT RAISE(ABORT,'semantic settlement rollback'); END`);

    expect(() => target.preparedDeliveries.acknowledgePreparedDelivery(claim, { messageId: "new-message", surfaceId: "new-card", threadId: null }))
      .toThrow("semantic settlement rollback");
    expect(target.database.prepare("SELECT state,delivered_message_id,claim_attempt_id FROM outbound_replies WHERE id='semantic-rollback'").get()).toMatchObject({
      state: "pending", delivered_message_id: null, claim_attempt_id: claim.attemptId
    });
    expect(target.database.prepare("SELECT message_id,card_id,pending_reply_id,delivered_sequence FROM conversation_segment_pages WHERE id='segment-rollback:page:0'").get()).toEqual({
      message_id: "old-message", card_id: "old-card", pending_reply_id: "semantic-rollback", delivered_sequence: 2
    });
  });

  it("records a non-replayable semantic settlement gap, rebases its checkpoint, and lets unrelated subjects progress", () => {
    const target = openStore();
    activateBinding(target, "gap-settle", "pane-gap-settle");
    const at = "2026-10-10T00:00:00.000Z";
    target.database.prepare(`INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at)
      VALUES('segment-gap','lane','primary','gap-settle',1,'traex','hello','working',4,'root-a',?,?)`).run(at, at);
    target.database.prepare(`INSERT INTO conversation_segments(id,producer_key,owner_kind,owner_id,owner_generation,agent_kind,request_text,state,view_version,root_message_id,created_at,updated_at)
      VALUES('segment-unrelated','lane-other','primary','gap-settle',1,'traex','other','working',1,'root-b',?,?)`).run(at, at);
    for (const page of [
      { segment: "segment-gap", index: 0, message: "page-zero", card: "card-zero", sequence: 3 },
      { segment: "segment-unrelated", index: 0, message: "page-one", card: "card-one", sequence: 1 }
    ]) target.database.prepare(`INSERT INTO conversation_segment_pages(id,segment_id,page_index,message_id,card_id,element_id,state,sequence,delivered_sequence,created_at,updated_at)
      VALUES(?,?,?,?,?,?, 'active',?,?,?,?)`).run(
        `${page.segment}:page:${page.index}`, page.segment, page.index, page.message, page.card, `turn-card:${page.segment}:page:${page.index}`,
        page.sequence, page.sequence - 1, at, at
      );
    const lease = target.acquireInstanceLease("gap-owner", at, "2099-10-10T00:00:00.000Z")!;
    target.activateWriteFence(lease.ownerId, lease.fencingToken);
    const failed = reserveClaimedSemanticPage(target, {
      id: "semantic-gap", bindingId: "gap-settle", segmentId: "segment-gap", pageIndex: 0, revision: 3, rootMessageId: "page-zero"
    });
    target.database.prepare("UPDATE delivery_ring_checkpoints SET committed_delivery_order=? WHERE scope_key=?")
      .run(failed.delivery.deliveryOrder + 10, deliveryScopeKey(failed.delivery.scope));
    target.database.prepare("UPDATE conversation_segment_pages SET sequence=4 WHERE id='segment-gap:page:0'").run();

    expect(target.preparedDeliveries.acknowledgePreparedDelivery(failed.claim, { messageId: "remote-success", surfaceId: "remote-card", threadId: null })).toBe(true);
    expect(target.database.prepare("SELECT state,delivered_message_id FROM outbound_replies WHERE id='semantic-gap'").get()).toEqual({
      state: "delivered", delivered_message_id: "remote-success"
    });
    expect(target.database.prepare("SELECT failure_code,state,required_version,details_json FROM projection_gaps WHERE source_item_id='semantic-gap'").get()).toMatchObject({
      failure_code: "semantic_subject_settlement_mismatch", state: "open", required_version: 3, details_json: expect.stringContaining("semantic-subject-settlement")
    });
    expect(target.database.prepare("SELECT committed_delivery_order FROM delivery_ring_checkpoints WHERE scope_key=?").get(deliveryScopeKey(failed.delivery.scope)))
      .toEqual({ committed_delivery_order: failed.delivery.deliveryOrder - 1 });

    const sameReceipt = target.reserveSemanticOutboundReply({
      id: "semantic-same", idempotencyKey: "semantic-same", bindingId: "gap-settle", bindingGeneration: 1,
      rootMessageId: "page-zero", kind: "card_update", payload: "{}", projectionKey: "turn-card:segment-gap:page:0",
      snapshotRevision: 4, viewVersion: 4, laneKeyOverride: "turn-card:segment-gap:page:0",
      subject: { kind: "conversation-page", segmentId: "segment-gap", pageIndex: 0, revision: 4 },
      snapshot: { schemaVersion: 1 }, plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
    });
    target.database.prepare("UPDATE conversation_segment_pages SET pending_reply_id='semantic-same',sequence=4 WHERE id='segment-gap:page:0'").run();
    const sameWork = sameReceipt.consumeEffects()[0]!;
    if (!("input" in sameWork)) throw new Error("expected semantic work");
    const sameFrozen = target.preparedDeliveries.freezeSemanticDelivery({ work: sameWork, preparedPlan: {
      protocolVersion: 1, gatewayId: sameWork.gatewayId, profileId: sameWork.gatewayProfileId, rendererRevision: 1,
      operation: "surface.replace", intent: { kind: "surface.replace", purpose: "operation-result", messageId: "page-zero", view: {} }
    } });
    if (sameFrozen.outcome !== "prepared") throw new Error("expected prepared delivery");
    expect(target.preparedDeliveries.claimPreparedDelivery({ delivery: sameFrozen.delivery, at: "2098-10-10T00:00:02.000Z", expiresAt: "2098-10-10T00:01:02.000Z" })).toBeNull();

    const unrelated = reserveClaimedSemanticPage(target, {
      id: "semantic-unrelated", bindingId: "gap-settle", segmentId: "segment-unrelated", pageIndex: 0, revision: 1, rootMessageId: "page-one"
    });
    expect(unrelated.claim.replyId).toBe("semantic-unrelated");
    expect(target.preparedDeliveries.loadScopePage({ scope: failed.delivery.scope, afterScopeKey: null, limit: 1, at: "2098-10-10T00:00:03.000Z" }))
      .toMatchObject({ items: [{ safeCommittedOrder: failed.delivery.deliveryOrder - 1, authoritativeBlocker: { replyId: "semantic-gap" } }] });
  });

  it("durably records deterministic semantic preparation failure as not-started", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    const receipt = target.reserveSemanticOutboundReply({
      id: "semantic-prepare-failure", idempotencyKey: "semantic-prepare-failure", bindingId: "a", bindingGeneration: 1,
      rootMessageId: "root-a", kind: "card_reply", payload: "{}", projectionKey: "turn-card:segment-1:page:0",
      snapshotRevision: 3, viewVersion: 3, laneKeyOverride: "turn-card:segment-1:page:0",
      subject: { kind: "conversation-page", segmentId: "segment-1", pageIndex: 0, revision: 3 },
      snapshot: { schemaVersion: 1, kind: "conversation-turn-card", timeline: [] },
      plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
    });
    const work = receipt.consumeEffects()[0]!;
    if (!("input" in work)) throw new Error("expected semantic work");

    expect(target.preparedDeliveries.failSemanticDeliveryPreparation({ work, error: "snapshot measurement mismatch" })).toBe("failed");
    expect(target.getOutboundReply(work.replyId)).toMatchObject({
      state: "pending", attemptCount: 1, effectCertainty: "not-started", error: "snapshot measurement mismatch",
      gatewayPlanJson: null, gatewayPlanHash: null
    });
  });

  it("recovers committed semantic work after a missed enqueue and preserves legacy scope order", async () => {
    const directory = mkdtempSync(join(tmpdir(), "semantic-delivery-refill-"));
    const path = join(directory, "state.sqlite");
    const first = new SqliteBindingStore(path);
    connectPlanPreparer(first);
    activateBinding(first, "a", "pane-a");
    reserve(first, "legacy-first", "a", 1);
    const snapshot = { schemaVersion: 1, kind: "conversation-turn-card", timeline: [] };
    first.reserveSemanticOutboundReply({
      id: "semantic-second", idempotencyKey: "semantic-second", bindingId: "a", bindingGeneration: 1,
      rootMessageId: "root-a", kind: "card_reply", payload: "{}", projectionKey: "turn-card:segment-1:page:0",
      snapshotRevision: 2, viewVersion: 2, laneKeyOverride: "turn-card:segment-1:page:0",
      subject: { kind: "conversation-page", segmentId: "segment-1", pageIndex: 0, revision: 2 },
      snapshot, plannerPolicyVersion: 1, rendererPolicyVersion: 1, gatewayProfileVersion: 1
    });
    first.close();

    const reopened = new SqliteBindingStore(path);
    try {
      connectPlanPreparer(reopened);
      const firstPage = await reopened.preparedDeliveries.load({
        scope: { kind: "pane", workspaceId: "workspace", paneId: "pane-a" }, limit: 10,
        now: "2999-01-01T00:00:00.000Z"
      });
      expect(firstPage.deliveries.map(({ replyId }) => replyId)).toEqual(["legacy-first"]);
      reopened.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='legacy' WHERE id='legacy-first'").run();
      const secondPage = await reopened.preparedDeliveries.load({
        scope: { kind: "pane", workspaceId: "workspace", paneId: "pane-a" }, limit: 10,
        now: "2999-01-01T00:00:00.000Z"
      });
      expect(secondPage.deliveries).toEqual([
        expect.objectContaining({ replyId: "semantic-second", input: expect.objectContaining({ kind: "semantic-snapshot", snapshot }) })
      ]);
    } finally {
      reopened.close();
      rmSync(directory, { recursive: true, force: true });
    }
  });

  it("persists reserved and preparing semantic phases without fabricating a prepared effect", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    const subjectJson = JSON.stringify({ kind: "conversation-page", segmentId: "segment-1", pageIndex: 0, revision: 3 });
    const snapshotJson = JSON.stringify({ schemaVersion: 1, timeline: [] });
    target.database.prepare(`INSERT INTO outbound_replies(
      id,delivery_input_kind,subject_kind,subject_json,subject_revision,presentation_snapshot_json,presentation_snapshot_hash,
      planner_policy_version,renderer_policy_version,gateway_profile_version,preparation_state,
      idempotency_key,binding_id,view_version,root_message_id,kind,payload,state,delivery_order,lane_key,conflict_key,
      next_attempt_at,created_at,updated_at,scope_kind,scope_key,scope_workspace_id,scope_pane_id,
      delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation,projection_key,snapshot_revision
    ) VALUES(
      'semantic-reserved','semantic-snapshot','conversation-page',?,3,?,?,4,5,6,'reserved',
      'semantic-reserved','a',3,'root-a','card_reply','{}','pending',1,'semantic-reserved','semantic-reserved',
      '2026-10-10T00:00:00.000Z','2026-10-10T00:00:00.000Z','2026-10-10T00:00:00.000Z',
      'pane',json_array('pane','workspace','pane-a'),'workspace','pane-a','primary','a',1,1,'conversation-page:segment-1:0',3
    )`).run(subjectJson, snapshotJson, presentationSnapshotHash(snapshotJson));

    expect(target.preparedDeliveries.hydrateDeliveryInput("semantic-reserved")).toMatchObject({
      status: "semantic-snapshot", preparationState: "reserved", preparedDelivery: null
    });
    expect(target.preparedDeliveries.hydratePreparedDelivery("semantic-reserved")).toEqual({ status: "unprepared" });

    target.database.prepare("UPDATE outbound_replies SET preparation_state='preparing' WHERE id='semantic-reserved'").run();
    expect(target.preparedDeliveries.hydrateDeliveryInput("semantic-reserved")).toMatchObject({
      status: "semantic-snapshot", preparationState: "preparing", preparedDelivery: null
    });
  });

  it.each([
    ["subject revision mismatch", { subjectRevision: 4 }, "semantic_delivery_codec_invalid"],
    ["snapshot hash mismatch", { snapshotHash: "0".repeat(64) }, "semantic_delivery_codec_invalid"],
    ["mixed prepared-effect identity", { deliveryInputKind: "prepared-effect" as const }, "mixed_delivery_input"]
  ])("rejects malformed semantic storage: %s", (_label, mutation, reason) => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reserve(target, "semantic", "a", 3);
    replaceSemanticIdentity(target, "semantic", mutation);

    expect(target.preparedDeliveries.hydrateDeliveryInput("semantic")).toEqual({ status: "invalid", reason });
    expect(target.preparedDeliveries.hydratePreparedDelivery("semantic")).toEqual({ status: "invalid", reason });
  });

  it("rejects a hash-valid plan whose frozen target no longer matches the outbox row", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reserve(target, "prepared", "a");
    const row = target.database.prepare("SELECT gateway_plan_json FROM outbound_replies WHERE id='prepared'").get() as { gateway_plan_json: string };
    const plan = JSON.parse(row.gateway_plan_json) as { intent: { rootMessageId: string } };
    plan.intent.rootMessageId = "different-root";
    const json = JSON.stringify(plan);
    target.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
    target.database.prepare("UPDATE outbound_replies SET gateway_plan_json=?,gateway_plan_hash=? WHERE id='prepared'").run(json, createHash("sha256").update(json).digest("hex"));

    expect(target.preparedDeliveries.hydratePreparedDelivery("prepared")).toMatchObject({ status: "invalid", reason: "plan_target_mismatch" });
  });

  it("keeps prerequisites durable, protected from retention, and exposes dependent scopes after settlement", () => {
    const target = openStore();
    activateBinding(target, "dependent", "pane-dependent");
    activateBinding(target, "required", "pane-required");
    reserve(target, "dependent", "dependent");
    reserve(target, "required", "required");
    target.preparedDeliveries.addPrerequisite({ dependentReplyId: "dependent", prerequisiteReplyId: "required", requiredState: "delivered" });
    expect(() => target.preparedDeliveries.addPrerequisite({ dependentReplyId: "dependent", prerequisiteReplyId: "dependent", requiredState: "delivered" })).toThrow();

    target.database.prepare("UPDATE outbound_replies SET state='delivered',updated_at='2000-01-01T00:00:00.000Z' WHERE id='required'").run();
    expect(target.pruneDeliveredOutboundReplies("2020-01-01T00:00:00.000Z", 10)).toBe(0);
    expect(target.preparedDeliveries.listDependentScopeKeys("required", 10)).toEqual([expect.stringContaining("pane-dependent")]);
  });

  it("recovers only explicitly expired Ring claims as uncertain", () => {
    const target = openStore();
    activateBinding(target, "ring", "pane-ring");
    reserve(target, "ring", "ring");
    target.database.prepare("UPDATE outbound_replies SET claim_attempt_id='ring-attempt',claimed_at='2026-01-01T00:00:00.000Z',claim_expires_at='2026-01-01T00:01:00.000Z' WHERE id='ring'").run();

    expect(target.preparedDeliveries.recoverExpiredRingClaims("2026-01-01T00:02:00.000Z", 10)).toEqual(["ring"]);
    expect(target.getOutboundReply("ring")).toMatchObject({ state: "dead_letter", effectCertainty: "uncertain" });
  });

  it("commits expired-claim recovery before a later maintenance class fails", () => {
    const target = openStore();
    activateBinding(target, "maintenance-split", "pane-maintenance-split");
    reserve(target, "maintenance-split", "maintenance-split");
    target.database.prepare(`UPDATE outbound_replies SET
      claim_attempt_id='expired-attempt',claimed_at='2026-01-01T00:00:00.000Z',claim_expires_at='2026-01-01T00:01:00.000Z'
      WHERE id='maintenance-split'`).run();
    const maintenance = target.preparedDeliveries as unknown as {
      runGlobalRingMaintenance(input: { at: string; limit: number }): { affectedScopeKeys: string[] };
      dismissRejectedQuarantineReviewBatch(at: string): void;
    };
    const dismissRejected = maintenance.dismissRejectedQuarantineReviewBatch.bind(maintenance);
    maintenance.dismissRejectedQuarantineReviewBatch = () => { throw new Error("injected rejected-review maintenance failure"); };

    try {
      expect(() => maintenance.runGlobalRingMaintenance({ at: "2026-01-01T00:02:00.000Z", limit: 10 }))
        .toThrow("injected rejected-review maintenance failure");
    } finally {
      maintenance.dismissRejectedQuarantineReviewBatch = dismissRejected;
    }

    expect(target.getOutboundReply("maintenance-split")).toMatchObject({ state: "dead_letter", effectCertainty: "uncertain" });
    expect(maintenance.runGlobalRingMaintenance({ at: "2026-01-01T00:03:00.000Z", limit: 10 }))
      .toEqual({ affectedScopeKeys: [] });
  });

  it("uses separate diagnostic labels for each bounded global maintenance writer", () => {
    const target = openStore();
    const maintenance = target.preparedDeliveries as unknown as {
      context: { transaction: (...args: unknown[]) => unknown };
      runGlobalRingMaintenance(input: { at: string; limit: number }): { affectedScopeKeys: string[] };
    };
    const labels: string[] = [];
    const transaction = maintenance.context.transaction.bind(maintenance.context);
    maintenance.context.transaction = ((...args: unknown[]) => {
      if (typeof args[0] === "string") labels.push(args[0]);
      return transaction(...args);
    }) as typeof maintenance.context.transaction;

    try {
      expect(maintenance.runGlobalRingMaintenance({ at: "2026-01-01T00:02:00.000Z", limit: 10 }))
        .toEqual({ affectedScopeKeys: [] });
    } finally {
      maintenance.context.transaction = transaction as typeof maintenance.context.transaction;
    }

    expect(labels).toEqual([
      "sqlite.prepared-delivery-store.ring-maintenance.expired-claims",
      "sqlite.prepared-delivery-store.ring-maintenance.rejected-quarantine-review",
      "sqlite.prepared-delivery-store.ring-maintenance.nested-quarantine-review",
      "sqlite.prepared-delivery-store.ring-maintenance.historical-primary-main"
    ]);
  });

  it("leaves historical Primary Main coalescing rediscoverable after its bounded writer fails", () => {
    const target = openStore();
    activateBinding(target, "maintenance-coalesce", "pane-maintenance-coalesce");
    reservePrimaryMainSnapshot(target, "maintenance-coalesce-old", "maintenance-coalesce", 1);
    reservePrimaryMainSnapshot(target, "maintenance-coalesce-new", "maintenance-coalesce", 2);
    makePrimaryMainTargetCurrent(target, "maintenance-coalesce", 2);
    const maintenance = target.preparedDeliveries as unknown as {
      runGlobalRingMaintenance(input: { at: string; limit: number }): { affectedScopeKeys: string[] };
      coalesceHistoricalPrimaryMainSnapshots(input: { at: string; limit: number }): string[];
    };
    const coalesce = maintenance.coalesceHistoricalPrimaryMainSnapshots.bind(maintenance);
    maintenance.coalesceHistoricalPrimaryMainSnapshots = () => { throw new Error("injected historical maintenance failure"); };

    try {
      expect(() => maintenance.runGlobalRingMaintenance({ at: "2026-01-01T00:02:00.000Z", limit: 10 }))
        .toThrow("injected historical maintenance failure");
    } finally {
      maintenance.coalesceHistoricalPrimaryMainSnapshots = coalesce;
    }

    expect(target.getOutboundReply("maintenance-coalesce-old")).toMatchObject({ state: "pending" });
    expect(maintenance.runGlobalRingMaintenance({ at: "2026-01-01T00:03:00.000Z", limit: 10 }))
      .toEqual({ affectedScopeKeys: ['["pane","workspace","pane-maintenance-coalesce"]'] });
    expect(target.getOutboundReply("maintenance-coalesce-old")).toMatchObject({ state: "dismissed" });
  });

  it("discovers scope heads for authoritative cold recovery", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    activateBinding(target, "b", "pane-b");
    reserve(target, "a", "a");
    reserve(target, "b", "b");

    const page = target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 10, at: "2099-01-01T00:00:00.000Z" });

    expect(page.items.map(({ replyId }) => replyId)).toEqual(["a", "b"]);
    expect(page.nextCursor).toBeNull();
  });

  it("reports only expired Ring claims that it actually transitions", () => {
    const target = openStore();
    activateBinding(target, "ring", "pane-ring");
    reserve(target, "ring", "ring");
    target.database.prepare("UPDATE outbound_replies SET claim_attempt_id='attempt',claimed_at='2026-01-01T00:00:00.000Z',claim_expires_at='2026-01-01T00:01:00.000Z' WHERE id='ring'").run();
    target.database.exec("CREATE TRIGGER suppress_expired_claim BEFORE UPDATE OF state ON outbound_replies WHEN OLD.id='ring' BEGIN SELECT RAISE(IGNORE); END");

    expect(target.preparedDeliveries.recoverExpiredRingClaims("2026-01-01T00:02:00.000Z", 10)).toEqual([]);
    expect(target.getOutboundReply("ring")).toMatchObject({ state: "pending" });
  });

  it("uses the scope-order and prerequisite indexes for bounded discovery", () => {
    const target = openStore();
    const plan = target.preparedDeliveries.explainScopeHeadQuery();
    expect(plan.join("\n")).toContain("outbound_replies_scope_nonterminal_order");
    expect(plan.join("\n")).toContain("outbound_replies_scope_delivery_order");
    expect(plan.join("\n")).toContain("outbound_replies_scope_conflict_order");
    expect(plan.join("\n")).toContain("outbox_lane_quarantines_phase_deadline");
    expect(plan.join("\n")).toContain("worker_human_review_create_reply");
    expect(plan.join("\n")).not.toMatch(/SCAN episode(?:\s|$)/);
    expect(plan.join("\n")).not.toContain("USE TEMP B-TREE FOR GROUP BY");
    const indexes = target.database.prepare("SELECT name FROM sqlite_master WHERE type='index' AND name LIKE 'outbound_reply_prerequisites_%' ORDER BY name").all();
    expect(indexes).toEqual([
      { name: "outbound_reply_prerequisites_lag" },
      { name: "outbound_reply_prerequisites_reverse" }
    ]);
  });

  it("uses the authoritative scope-order index to bootstrap a delivery checkpoint", () => {
    const target = openStore();
    activateBinding(target, "checkpoint-plan", "pane-checkpoint-plan");
    reserve(target, "checkpoint-plan", "checkpoint-plan");
    const delivery = target.preparedDeliveries.hydratePreparedDelivery("checkpoint-plan");
    if (delivery.status !== "prepared") throw new Error(`unexpected hydration: ${delivery.status}`);
    expect(target.preparedDeliveries.explainCheckpointBootstrapQuery(delivery.delivery.scope).join("\n"))
      .toContain("outbound_replies_scope_nonterminal_order");
  });

  it("pages indexed candidate scopes before materializing one authoritative invalid-owner head per scope", () => {
    const target = openStore();
    const plan = target.preparedDeliveries.explainReconstructibleInvalidOwnerQuery().join("\n");
    const scopePlan = target.preparedDeliveries.explainReconstructibleInvalidOwnerScopePageQuery().join("\n");

    expect(scopePlan).toContain("SEARCH candidate USING INDEX outbound_replies_scope_nonterminal_order (scope_key>?)");
    expect(scopePlan).not.toContain("USE TEMP B-TREE");
    expect(plan).toContain("MATERIALIZE candidate_scopes");
    expect(plan).toContain("SCAN json_each VIRTUAL TABLE INDEX");
    expect(plan).toContain("SEARCH blocker USING INDEX outbound_replies_scope_delivery_order");
    expect(plan).toContain("SEARCH head USING INTEGER PRIMARY KEY (rowid=?)");
  });

  it("keeps a bounded scope page indexed under a production-shaped skewed backlog", () => {
    const target = openStore();
    target.database.exec(`WITH RECURSIVE seed(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seed WHERE n<20000)
      INSERT INTO outbound_replies(id,idempotency_key,root_message_id,kind,payload,scope_kind,scope_key,
        scope_workspace_id,scope_pane_id,delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation,
        state,attempt_count,delivery_order,lane_key,next_attempt_at,created_at,updated_at)
      SELECT 'bulk-'||n,'bulk-'||n,'root','text','payload','pane',
        json_array('pane','workspace','pane-'||(n%200)),'workspace','pane-'||(n%200),'primary',
        'binding-'||(n%200),1,1,'pending',0,1000000+n,'lane-'||n,
        '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' FROM seed`);
    const startedAt = performance.now();
    const page = target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 64, at: "2099-01-01T00:00:00.000Z" });
    const elapsedMs = performance.now() - startedAt;

    expect(page.items).toHaveLength(64);
    expect(new Set(page.items.map(({ scopeKey }) => scopeKey)).size).toBe(64);
    expect(elapsedMs).toBeLessThan(2_000);
  });

  it("bounds conflict-bypass head selection within one heavily skewed scope", () => {
    const target = openStore();
    const scopeKey = '["pane","workspace","pane-skewed"]';
    target.database.prepare(`INSERT INTO outbound_replies(
      id,idempotency_key,root_message_id,kind,payload,scope_kind,scope_key,
      scope_workspace_id,scope_pane_id,delivery_owner_kind,delivery_owner_id,
      delivery_owner_generation,delivery_owner_session_generation,state,attempt_count,
      delivery_order,lane_key,conflict_key,next_attempt_at,created_at,updated_at,
      failure_class,effect_certainty,dead_lettered_at
    ) VALUES(
      'skewed-failed','skewed-failed','root','stream_content','payload','pane',?,
      'workspace','pane-skewed','primary','binding-skewed',1,1,'dead_letter',1,
      1,'lane-skewed-failed','conflict-failed','2026-01-01T00:00:00.000Z',
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
      'permanent','rejected','2026-01-01T00:00:00.000Z'
    )`).run(scopeKey);
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(
      lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at,
      conflict_key,phase,first_failed_at,grace_deadline_at,budget_attempt_limit,budget_duration_ms
    ) VALUES(
      'lane-skewed-failed','skewed-failed','immutable','permanent','active','blocked','failed',
      '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','conflict-failed',
      'conflict_isolated','2026-01-01T00:00:00.000Z','2026-01-01T00:01:00.000Z',1,60000
    )`).run();
    target.database.prepare(`WITH RECURSIVE seed(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seed WHERE n<5000)
      INSERT INTO outbound_replies(id,idempotency_key,root_message_id,kind,payload,scope_kind,scope_key,
        scope_workspace_id,scope_pane_id,delivery_owner_kind,delivery_owner_id,delivery_owner_generation,
        delivery_owner_session_generation,state,attempt_count,delivery_order,lane_key,conflict_key,
        next_attempt_at,created_at,updated_at)
      SELECT 'skewed-'||n,'skewed-'||n,'root','card_update','payload','pane',?,
        'workspace','pane-skewed','primary','binding-skewed',1,1,'pending',0,1+n,
        'lane-skewed-'||n,'conflict-successor','2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z' FROM seed`).run(scopeKey);

    const startedAt = performance.now();
    const page = target.preparedDeliveries.loadScopePage({
      scope: { kind: "pane", workspaceId: "workspace", paneId: "pane-skewed" },
      afterScopeKey: null,
      limit: 1,
      at: "2099-01-01T00:00:00.000Z"
    });
    const elapsedMs = performance.now() - startedAt;

    expect(page.items).toHaveLength(1);
    expect(page.items[0]?.head?.replyId).toBe("skewed-1");
    expect(elapsedMs).toBeLessThan(2_000);

    target.database.prepare("UPDATE outbound_replies SET gateway_plan_json='{}', gateway_plan_hash='hash' WHERE state='pending'").run();
    const diagnostics = target.getOperationalSummary().deliveryRings;

    expect(diagnostics).toMatchObject({
      pending: 5_000,
      panePending: 5_000,
      scopes: 1,
      ready: 0,
      activeQuarantineBlocked: 1,
      isolatedConflicts: 1,
      lowestBlockingDeliveryOrder: 1
    });
  });

  it.each(["not-started", "rejected"] as const)("atomically advances a safely superseded %s Card-update head", (effectCertainty) => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    const head = reserveReplaceable(target, "head", "a", 1);
    reserveReplaceable(target, "successor", "a", 2);
    reserve(target, "dependent", "a");
    target.preparedDeliveries.addPrerequisite({ dependentReplyId: "dependent", prerequisiteReplyId: "head", requiredState: "delivered" });
    target.database.prepare(`UPDATE outbound_replies SET state=?,attempt_count=1,failure_class=?,effect_certainty=?,error='failed',dead_lettered_at=? WHERE id='head'`)
      .run(effectCertainty === "rejected" ? "dead_letter" : "pending", effectCertainty === "rejected" ? "permanent" : "transient", effectCertainty, effectCertainty === "rejected" ? "2026-10-06T00:00:00.000Z" : null);
    if (effectCertainty === "rejected") target.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at)
      SELECT lane_key,id,'replaceable_card','permanent','active','blocked','failed',?,? FROM outbound_replies WHERE id='head'`).run("2026-10-06T00:00:00.000Z", "2026-10-06T00:00:00.000Z");

    expect(target.preparedDeliveries.advanceSupersededHead({ delivery: head, at: "2026-10-06T00:01:00.000Z" })).toEqual({
      outcome: "advanced", scopeKey: head.scope.kind === "pane" ? '["pane","workspace","pane-a"]' : '["global"]', replacementReplyId: "successor"
    });
    expect(target.getOutboundReply("head")).toMatchObject({ state: "dismissed" });
    expect(target.database.prepare("SELECT state,action,replacement_reply_id FROM delivery_recoveries WHERE failed_reply_id='head'").get()).toEqual({
      state: "replacement_pending", action: "released_newer_snapshot", replacement_reply_id: "successor"
    });
    expect(target.database.prepare("SELECT prerequisite_reply_id,required_state FROM outbound_reply_prerequisites WHERE dependent_reply_id='dependent'").get()).toEqual({
      prerequisite_reply_id: "successor", required_state: "delivered"
    });
    expect(target.database.prepare("SELECT state,action FROM outbox_lane_quarantines WHERE failed_reply_id='head'").get()).toEqual(effectCertainty === "rejected"
      ? { state: "released", action: "released_newer_snapshot" }
      : undefined);
    expect(target.database.prepare("SELECT committed_delivery_order FROM delivery_ring_checkpoints WHERE scope_key=?")
      .get('["pane","workspace","pane-a"]')).toEqual({ committed_delivery_order: head.deliveryOrder });
    activateBinding(target, "independent", "pane-independent");
    reserve(target, "independent-head", "independent");
    const independent = target.preparedDeliveries.hydratePreparedDelivery("independent-head");
    if (independent.status !== "prepared") throw new Error(`unexpected hydration: ${independent.status}`);
    expect(target.preparedDeliveries.loadOrInitializeCheckpoint({ scope: independent.delivery.scope, at: "2026-10-06T00:02:00.000Z" }))
      .toMatchObject({ position: { value: independent.delivery.deliveryOrder - 1 } });
    expect(target.preparedDeliveries.loadOrInitializeCheckpoint({ scope: head.scope, at: "2026-10-06T00:03:00.000Z" }))
      .toMatchObject({ position: { value: head.deliveryOrder } });
    expect(target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 10, at: "2099-01-01T00:00:00.000Z" }).items)
      .toEqual(expect.arrayContaining([expect.objectContaining({ replyId: "successor", status: "ready" }), expect.objectContaining({ replyId: "independent-head", status: "ready" })]));
  });

  it("bounds no-match invalid-owner retirement under a production-shaped Primary Main backlog", () => {
    const target = openStore();
    target.database.exec(`WITH RECURSIVE seed(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seed WHERE n<50000)
      INSERT INTO outbound_replies(
        id,idempotency_key,prompt_id,root_message_id,kind,payload,scope_kind,scope_key,
        state,next_attempt_at,created_at,updated_at
      ) SELECT
        'history-'||n,'history-'||n,'prompt-'||n,'root-history-'||n,'text','history','global',json_array('global'),'delivered',
        '2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z','2025-01-01T00:00:00.000Z'
      FROM seed;
      INSERT INTO bindings(
        id,workspace_id,chat_id,topic_id,root_message_id,pane_id,title,runtime,state,status_message_id,
        last_agent_state,created_at,updated_at,lifecycle,attachment,generation,session_epoch
      ) VALUES
        ('current','workspace','chat','topic-current','root-current','pane-shared','current','traex','active','main-current','unknown',
          '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','active','attached',1,1),
        ('stale','workspace','chat','topic-stale','root-stale',NULL,'stale','traex','archived','main-stale','unknown',
          '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','archived','unattached',1,1);
      INSERT INTO topic_views(binding_id,state_json,updated_at) VALUES(
        'current',json_object('sessionIdentity',json_object(
          'bindingGeneration',1,'sessionEpoch',1,'nativeSessionId',NULL,
          'paneId','pane-shared','rootMessageId','root-current'
        )),'2026-01-01T00:00:00.000Z'
      );
      INSERT INTO outbound_replies(
        id,idempotency_key,binding_id,root_message_id,kind,payload,
        scope_kind,scope_key,scope_workspace_id,scope_pane_id,
        delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation,
        state,attempt_count,delivery_order,lane_key,conflict_key,next_attempt_at,created_at,updated_at,
        failure_class,effect_certainty,dead_lettered_at
      ) VALUES(
        'blocking-dead-letter','blocking-dead-letter','stale','root-stale','text','blocked',
        'pane',json_array('pane','workspace','pane-shared'),'workspace','pane-shared',
        'primary','stale',1,1,'dead_letter',1,1000000,'blocking-dead-letter','blocking-dead-letter',
        '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
        'permanent','uncertain','2026-01-01T00:00:00.000Z'
      );
      WITH RECURSIVE seed(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seed WHERE n<12000)
      INSERT INTO outbound_replies(
        id,idempotency_key,binding_id,root_message_id,kind,payload,target_role,
        scope_kind,scope_key,scope_workspace_id,scope_pane_id,
        delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation,
        state,attempt_count,delivery_order,lane_key,conflict_key,next_attempt_at,created_at,updated_at,
        projection_key,snapshot_revision
      ) SELECT
        'stale-head-'||n,'stale-head-'||n,'stale','main-stale','card_update','{}','session_status',
        'pane',json_array('pane','workspace','pane-shared'),'workspace','pane-shared',
        'primary','stale',1,1,'pending',0,1000000+n,'primary-main:stale','primary-main:stale:'||n,
        '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
        'primary-main:stale:'||n,1
      FROM seed;`);

    const startedAt = performance.now();
    const maintenance = target.preparedDeliveries.retireReconstructibleInvalidOwnerHeads!({
      at: "2026-10-18T00:01:00.000Z",
      limit: 64
    });
    const elapsedMs = performance.now() - startedAt;

    expect(maintenance.transitionedScopeKeys).toEqual([]);
    expect(maintenance.projectionRecoveryHints).toEqual([]);
    expect(elapsedMs).toBeLessThan(2_000);
  }, 10_000);

  it("bounds invalid-owner discovery across many independent no-match scopes", () => {
    const target = openStore();
    target.database.exec(`INSERT INTO bindings(
        id,workspace_id,chat_id,topic_id,root_message_id,pane_id,title,runtime,state,status_message_id,
        last_agent_state,created_at,updated_at,lifecycle,attachment,generation,session_epoch
      ) VALUES(
        'stale-many-scopes','workspace','chat','topic-stale-many','root-stale-many',NULL,'stale-many','traex','archived',
        'main-stale-many','unknown','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
        'archived','unattached',1,1
      );
      WITH RECURSIVE seed(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seed WHERE n<12000)
      INSERT INTO outbound_replies(
        id,idempotency_key,binding_id,root_message_id,kind,payload,target_role,
        scope_kind,scope_key,scope_workspace_id,scope_pane_id,
        delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation,
        state,attempt_count,delivery_order,lane_key,conflict_key,next_attempt_at,created_at,updated_at,
        projection_key,snapshot_revision
      ) SELECT
        'stale-many-'||n,'stale-many-'||n,'stale-many-scopes','root-stale-many','card_update','{}','session_status',
        'pane',json_array('pane','workspace','pane-many-'||printf('%05d',n)),'workspace','pane-many-'||printf('%05d',n),
        'primary','stale-many-scopes',1,1,'pending',0,1000000+n,'primary-main:stale-many:'||n,
        'primary-main:stale-many:'||n,'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z','primary-main:stale-many:'||n,1
      FROM seed;`);

    const startedAt = performance.now();
    const maintenance = target.preparedDeliveries.retireReconstructibleInvalidOwnerHeads!({
      at: "2026-10-18T00:01:00.000Z",
      limit: 64
    });
    const elapsedMs = performance.now() - startedAt;

    expect(maintenance.transitionedScopeKeys).toEqual([]);
    expect(maintenance.projectionRecoveryHints).toEqual([]);
    expect(elapsedMs).toBeLessThan(2_000);
  }, 10_000);

  it("pages many no-match invalid-owner scopes before reaching a later reconstructible head", () => {
    const target = openStore();
    target.database.exec(`INSERT INTO bindings(
        id,workspace_id,chat_id,topic_id,root_message_id,pane_id,title,runtime,state,status_message_id,
        last_agent_state,created_at,updated_at,lifecycle,attachment,generation,session_epoch
      ) VALUES(
        'stale-paged','workspace','chat','topic-stale-paged','root-stale-paged',NULL,'stale-paged','traex','archived','main-stale-paged','unknown',
        '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','archived','unattached',1,1
      );
      WITH RECURSIVE seed(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seed WHERE n<129)
      INSERT INTO bindings(
        id,workspace_id,chat_id,topic_id,root_message_id,pane_id,title,runtime,state,status_message_id,
        last_agent_state,created_at,updated_at,lifecycle,attachment,generation,session_epoch
      ) SELECT
        'current-scope-'||printf('%03d',n),'workspace','chat','topic-current-'||printf('%03d',n),
        'root-current-'||printf('%03d',n),'pane-a-'||printf('%03d',n),'current-'||printf('%03d',n),
        'traex','active','main-current-'||printf('%03d',n),'unknown',
        '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','active','attached',1,1
      FROM seed;
      INSERT INTO bindings(
        id,workspace_id,chat_id,topic_id,root_message_id,pane_id,title,runtime,state,status_message_id,
        last_agent_state,created_at,updated_at,lifecycle,attachment,generation,session_epoch
      ) VALUES(
        'current-scope-z','workspace','chat','topic-current-z','root-current-z','pane-z-eligible','current-z',
        'traex','active','main-current-z','unknown','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
        'active','attached',1,1
      );
      WITH RECURSIVE seed(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seed WHERE n<129)
      INSERT INTO topic_views(binding_id,state_json,updated_at)
      SELECT 'current-scope-'||printf('%03d',n),json_object('sessionIdentity',json_object(
        'bindingGeneration',1,'sessionEpoch',1,'nativeSessionId',NULL,
        'paneId','pane-a-'||printf('%03d',n),'rootMessageId','root-current-'||printf('%03d',n)
      )),'2026-01-01T00:00:00.000Z' FROM seed;
      INSERT INTO topic_views(binding_id,state_json,updated_at) VALUES(
        'current-scope-z',json_object('sessionIdentity',json_object(
          'bindingGeneration',1,'sessionEpoch',1,'nativeSessionId',NULL,
          'paneId','pane-z-eligible','rootMessageId','root-current-z'
        )),'2026-01-01T00:00:00.000Z'
      );
      WITH RECURSIVE seed(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seed WHERE n<129)
      INSERT INTO outbound_replies(
        id,idempotency_key,binding_id,root_message_id,kind,payload,
        scope_kind,scope_key,scope_workspace_id,scope_pane_id,
        delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation,
        state,attempt_count,delivery_order,lane_key,conflict_key,next_attempt_at,created_at,updated_at,
        failure_class,effect_certainty,dead_lettered_at
      ) SELECT
        'blocking-paged-'||printf('%03d',n),'blocking-paged-'||printf('%03d',n),'stale-paged','root-stale-paged','text','blocked',
        'pane',json_array('pane','workspace','pane-a-'||printf('%03d',n)),'workspace','pane-a-'||printf('%03d',n),
        'primary','stale-paged',1,1,'dead_letter',1,1000000+n*10,'blocking-paged-'||printf('%03d',n),
        'blocking-paged-'||printf('%03d',n),'2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z','permanent','uncertain','2026-01-01T00:00:00.000Z'
      FROM seed;
      WITH RECURSIVE seed(n) AS (VALUES(1) UNION ALL SELECT n+1 FROM seed WHERE n<129)
      INSERT INTO outbound_replies(
        id,idempotency_key,binding_id,root_message_id,kind,payload,target_role,
        scope_kind,scope_key,scope_workspace_id,scope_pane_id,
        delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation,
        state,attempt_count,delivery_order,lane_key,conflict_key,next_attempt_at,created_at,updated_at,
        projection_key,snapshot_revision
      ) SELECT
        'stale-paged-'||printf('%03d',n),'stale-paged-'||printf('%03d',n),'stale-paged','root-stale-paged',
        'card_update','{}','session_status','pane',json_array('pane','workspace','pane-a-'||printf('%03d',n)),
        'workspace','pane-a-'||printf('%03d',n),'primary','stale-paged',1,1,'pending',0,1000000+n*10+1,
        'primary-main:stale-paged:'||printf('%03d',n),'primary-main:stale-paged:'||printf('%03d',n),
        '2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
        'primary-main:stale-paged:'||printf('%03d',n),1
      FROM seed;
      INSERT INTO outbound_replies(
        id,idempotency_key,binding_id,root_message_id,kind,payload,target_role,
        scope_kind,scope_key,scope_workspace_id,scope_pane_id,
        delivery_owner_kind,delivery_owner_id,delivery_owner_generation,delivery_owner_session_generation,
        state,attempt_count,delivery_order,lane_key,conflict_key,next_attempt_at,created_at,updated_at,
        projection_key,snapshot_revision
      ) VALUES(
        'stale-paged-eligible','stale-paged-eligible','stale-paged','root-stale-paged','card_update','{}','session_status',
        'pane',json_array('pane','workspace','pane-z-eligible'),'workspace','pane-z-eligible',
        'primary','stale-paged',1,1,'pending',0,2000000,'primary-main:stale-paged:eligible',
        'primary-main:stale-paged:eligible','2026-01-01T00:00:00.000Z','2026-01-01T00:00:00.000Z',
        '2026-01-01T00:00:00.000Z','primary-main:stale-paged:eligible',1
      );`);

    const runMaintenance = () => target.preparedDeliveries.retireReconstructibleInvalidOwnerHeads!({
      at: "2026-10-18T00:01:00.000Z",
      limit: 64
    });

    expect(runMaintenance().transitionedScopeKeys).toEqual([]);
    expect(runMaintenance().transitionedScopeKeys).toEqual([]);
    expect(runMaintenance().transitionedScopeKeys).toEqual(['["pane","workspace","pane-z-eligible"]']);
    expect(target.getOutboundReply("stale-paged-eligible")).toMatchObject({ state: "dismissed" });
  });

  it("keeps a rejected Card-update quarantine active after its automatic replacement generation was consumed", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    const head = reserveReplaceable(target, "head", "a", 1);
    reserveReplaceable(target, "successor", "a", 2);
    target.database.prepare(`UPDATE outbound_replies SET state='dead_letter',attempt_count=1,auto_recovery_count=1,
      failure_class='permanent',effect_certainty='rejected',error='failed',dead_lettered_at=? WHERE id='head'`)
      .run("2026-10-06T00:00:00.000Z");
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at)
      SELECT lane_key,id,'replaceable_card','permanent','active','blocked','failed',?,? FROM outbound_replies WHERE id='head'`)
      .run("2026-10-06T00:00:00.000Z", "2026-10-06T00:00:00.000Z");

    expect(target.preparedDeliveries.advanceSupersededHead({ delivery: head, at: "2026-10-06T00:01:00.000Z" })).toEqual({ outcome: "blocked" });
    expect(target.getOutboundReply("head")).toMatchObject({ state: "dead_letter", effectCertainty: "rejected", autoRecoveryCount: 1 });
    expect(target.database.prepare("SELECT state,action FROM outbox_lane_quarantines WHERE failed_reply_id='head'").get()).toEqual({
      state: "active", action: "blocked"
    });
    expect(target.database.prepare("SELECT state,action,replacement_reply_id FROM delivery_recoveries WHERE failed_reply_id='head'").get()).toEqual({
      state: "unresolved", action: "blocked", replacement_reply_id: null
    });
    expect(target.getOutboundReply("successor")).toMatchObject({ state: "pending" });
  });

  it("retires a never-attempted invalid-owner head and returns the exact reconstructible projection hint", () => {
    const target = openStore();
    activateBinding(target, "stale", "pane-shared");
    reservePrimaryMainSnapshot(target, "stale-head", "stale", 1);
    makePrimaryMainTargetCurrent(target, "stale", 1);
    target.updateBinding("stale", { state: "archived", lifecycle: "archived", attachment: "unattached", paneId: null });
    activateBinding(target, "current", "pane-shared");
    makePrimaryMainProjectionReconstructible(target, "current", "pane-shared");
    const maintenance = target.preparedDeliveries as unknown as {
      retireReconstructibleInvalidOwnerHeads(input: { at: string; limit: number }): {
        transitionedScopeKeys: string[];
        projectionRecoveryHints: Array<{ kind: "card-context"; targetKind: "primary-session"; targetId: string; targetGeneration: number }>;
      };
    };

    expect(maintenance.retireReconstructibleInvalidOwnerHeads({ at: "2026-10-18T00:01:00.000Z", limit: 10 })).toEqual({
      transitionedScopeKeys: ['["pane","workspace","pane-shared"]'],
      projectionRecoveryHints: [{ kind: "card-context", targetKind: "primary-session", targetId: "current", targetGeneration: 1 }]
    });
    expect(target.getOutboundReply("stale-head")).toMatchObject({ state: "dismissed", attemptCount: 0, effectCertainty: "not-started" });
    expect(target.database.prepare("SELECT state,action FROM delivery_recoveries WHERE failed_reply_id='stale-head'").get()).toEqual({
      state: "dismissed", action: "retired_invalid_owner_reconstructible"
    });
    expect(target.preparedDeliveries.loadOrInitializeCheckpoint({ scope: { kind: "pane", workspaceId: "workspace", paneId: "pane-shared" }, at: "2026-10-18T00:02:00.000Z" }))
      .toMatchObject({ position: { value: 1 } });
  });

  it("keeps invalid-owner retirement blocked by every possible-effect or reconstruction ambiguity", () => {
    const target = openStore();
    const setup = (id: string, paneId = `pane-${id}`) => {
      activateBinding(target, id, paneId);
      reservePrimaryMainSnapshot(target, `${id}-head`, id, 1);
      makePrimaryMainTargetCurrent(target, id, 1);
    };
    const setupInvalidOwner = (id: string) => {
      const paneId = `pane-${id}`;
      setup(id, paneId);
      target.updateBinding(id, { state: "archived", lifecycle: "archived", attachment: "unattached", paneId: null });
      activateBinding(target, `${id}-current`, paneId);
      makePrimaryMainProjectionReconstructible(target, `${id}-current`, paneId);
    };
    setup("valid");
    setupInvalidOwner("uncertain");
    target.database.prepare("UPDATE outbound_replies SET effect_certainty='uncertain' WHERE id='uncertain-head'").run();
    setupInvalidOwner("rejected");
    target.database.prepare("UPDATE outbound_replies SET effect_certainty='rejected' WHERE id='rejected-head'").run();
    setupInvalidOwner("checkpointed");
    target.database.prepare("UPDATE outbound_replies SET card_id_checkpoint='surface' WHERE id='checkpointed-head'").run();
    setupInvalidOwner("gateway-checkpointed");
    target.database.prepare("UPDATE outbound_replies SET gateway_checkpoint_json='{}' WHERE id='gateway-checkpointed-head'").run();
    setupInvalidOwner("attempted");
    target.database.prepare("UPDATE outbound_replies SET attempt_count=1 WHERE id='attempted-head'").run();
    setupInvalidOwner("claimed");
    target.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
    target.database.prepare(`UPDATE outbound_replies SET claim_attempt_id='attempt',claimed_owner_id='delivery-owner',
      claimed_fence=1,claimed_at='2026-10-18T00:00:00.000Z',claim_expires_at='2026-10-18T00:10:00.000Z'
      WHERE id='claimed-head'`).run();
    setupInvalidOwner("prerequisite");
    target.preparedDeliveries.addPrerequisite({ dependentReplyId: "prerequisite-head", prerequisiteReplyId: "valid-head", requiredState: "delivered" });
    setupInvalidOwner("recovery");
    target.database.prepare(`INSERT INTO delivery_recoveries(
      failed_reply_id,snapshot_revision,state,failure_class,http_status,lark_error_code,reason,action,
      semantic_recovery_proof,replacement_reply_id,resolved_by_reply_id,resolved_message_id,created_at,updated_at,resolved_at
    ) VALUES('recovery-head',1,'unresolved','unknown',NULL,NULL,'linked','manual',NULL,NULL,NULL,NULL,?,?,NULL)`).run(
      "2026-10-18T00:00:00.000Z", "2026-10-18T00:00:00.000Z"
    );
    setupInvalidOwner("quarantine");
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(
      lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at
    ) SELECT lane_key,id,'immutable','unknown','active','blocked','test',?,? FROM outbound_replies WHERE id='quarantine-head'`).run(
      "2026-10-18T00:00:00.000Z", "2026-10-18T00:00:00.000Z"
    );
    setup("missing");
    target.updateBinding("missing", { state: "archived", lifecycle: "archived", attachment: "unattached", paneId: null });
    setupInvalidOwner("stale-projection");
    const staleProjection = target.loadTopicView("stale-projection-current")!;
    target.saveTopicView({ ...staleProjection, sessionIdentity: { ...staleProjection.sessionIdentity!, sessionEpoch: 999 } });
    const recoveryCountBefore = target.database.prepare("SELECT COUNT(*) AS count FROM delivery_recoveries").get();
    const maintenance = target.preparedDeliveries.retireReconstructibleInvalidOwnerHeads!({ at: "2026-10-18T00:01:00.000Z", limit: 20 });

    expect(maintenance).toEqual({ transitionedScopeKeys: [], projectionRecoveryHints: [] });
    for (const id of [
      "valid-head", "uncertain-head", "rejected-head", "checkpointed-head", "gateway-checkpointed-head", "attempted-head",
      "claimed-head", "prerequisite-head", "recovery-head", "quarantine-head", "missing-head", "stale-projection-head"
    ]) {
      expect(target.getOutboundReply(id)).toMatchObject({ state: "pending" });
    }
    expect(target.database.prepare("SELECT COUNT(*) AS count FROM delivery_recoveries").get()).toEqual(recoveryCountBefore);
  });

  it("rolls back invalid-owner retirement, audit, and checkpoint when audit persistence fails", () => {
    const target = openStore();
    activateBinding(target, "rollback-stale", "pane-rollback");
    reservePrimaryMainSnapshot(target, "rollback-head", "rollback-stale", 1);
    makePrimaryMainTargetCurrent(target, "rollback-stale", 1);
    target.updateBinding("rollback-stale", { state: "archived", lifecycle: "archived", attachment: "unattached", paneId: null });
    activateBinding(target, "rollback-current", "pane-rollback");
    makePrimaryMainProjectionReconstructible(target, "rollback-current", "pane-rollback");
    target.database.exec(`CREATE TRIGGER fail_invalid_owner_audit BEFORE INSERT ON delivery_recoveries
      WHEN NEW.action='retired_invalid_owner_reconstructible' BEGIN SELECT RAISE(ABORT,'injected audit failure'); END`);

    expect(() => target.preparedDeliveries.retireReconstructibleInvalidOwnerHeads!({
      at: "2026-10-18T00:01:00.000Z", limit: 10
    })).toThrow("injected audit failure");
    expect(target.getOutboundReply("rollback-head")).toMatchObject({ state: "pending", effectCertainty: null });
    expect(target.database.prepare("SELECT COUNT(*) AS count FROM delivery_recoveries").get()).toEqual({ count: 0 });
    expect(target.database.prepare("SELECT COUNT(*) AS count FROM delivery_ring_checkpoints").get()).toEqual({ count: 0 });
  });

  it("retires a safely rejected quarantined Ring head after its exact owner becomes archived", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reserve(target, "head", "a");
    target.database.prepare(`UPDATE outbound_replies SET state='dead_letter',attempt_count=1,failure_class='permanent',
      effect_certainty='rejected',lark_error_code='200750',dead_lettered_at='2026-10-06T00:00:00.000Z' WHERE id='head'`).run();
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at)
      SELECT lane_key,id,'immutable','permanent','active','blocked','expired','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z' FROM outbound_replies WHERE id='head'`).run();
    target.updateBinding("a", { state: "archived", lifecycle: "archived", attachment: "unattached" });

    expect(target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-06T00:01:00.000Z" })).toEqual({
      transitionedScopeKeys: ['["pane","workspace","pane-a"]'], nextCursor: null
    });
    expect(target.getOutboundReply("head")).toMatchObject({ state: "dismissed" });
    expect(target.database.prepare("SELECT state,action FROM outbox_lane_quarantines WHERE failed_reply_id='head'").get()).toEqual({
      state: "released", action: "ring_stale_target_retired"
    });
    expect(target.database.prepare("SELECT state,action,replacement_reply_id FROM delivery_recoveries WHERE failed_reply_id='head'").get()).toEqual({
      state: "dismissed", action: "ring_stale_target_retired", replacement_reply_id: null
    });
    expect(target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 10, at: "2099-01-01T00:00:00.000Z" }).items).toEqual([]);
  });

  it("retires an orphaned rejected Ring head without active quarantine review", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reserve(target, "head", "a");
    target.database.prepare(`UPDATE outbound_replies SET state='dead_letter',attempt_count=1,
      failure_class='permanent',effect_certainty='rejected',dead_lettered_at='2026-10-06T00:00:00.000Z' WHERE id='head'`).run();
    target.updateBinding("a", { state: "archived", lifecycle: "archived", attachment: "unattached" });

    expect(target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-06T00:01:00.000Z" })).toEqual({
      transitionedScopeKeys: ['["pane","workspace","pane-a"]'], nextCursor: null
    });
    expect(target.getOutboundReply("head")).toMatchObject({ state: "dismissed" });
    expect(target.database.prepare("SELECT state,action FROM delivery_recoveries WHERE failed_reply_id='head'").get()).toEqual({
      state: "dismissed", action: "stale_orphan_retired"
    });
    expect(target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 10, at: "2099-01-01T00:00:00.000Z" }).items).toEqual([]);
  });

  it("batch-hydrates multiple quarantined Ring heads with one prepared statement", () => {
    const target = openStore();
    for (let index = 0; index < 8; index += 1) {
      const id = `quarantined-${index}`;
      activateBinding(target, id, `pane-${id}`);
      reserve(target, id, id);
      const hydrated = target.preparedDeliveries.hydratePreparedDelivery(id);
      if (hydrated.status !== "prepared") throw new Error(`unexpected hydration: ${hydrated.status}`);
      isolateUncertain(target, hydrated.delivery);
    }
    const prepare = vi.spyOn(target.database, "prepare");

    const maintenance = target.preparedDeliveries.recoverQuarantinedRingHeads({
      afterScopeKey: null, limit: 8, at: "2026-10-08T00:02:00.000Z"
    });

    const hydrationStatements = prepare.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql.startsWith("SELECT * FROM outbound_replies WHERE id IN ("));
    const perHeadHydrationStatements = prepare.mock.calls
      .map(([sql]) => String(sql))
      .filter((sql) => sql === "SELECT * FROM outbound_replies WHERE id=?");
    prepare.mockRestore();
    expect(hydrationStatements).toHaveLength(1);
    expect(hydrationStatements[0]?.match(/\?/g)).toHaveLength(8);
    expect(perHeadHydrationStatements).toEqual([]);
    expect(maintenance).toEqual({ transitionedScopeKeys: [], nextCursor: null });
  });

  it("retires an expired Primary Main head after the exact owner becomes orphaned", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reserve(target, "head", "a");
    target.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
    target.database.prepare(`UPDATE outbound_replies SET target_role='session_status',state='dead_letter',attempt_count=1,
      failure_class='permanent',effect_certainty='rejected',lark_error_code='200750',dead_lettered_at='2026-10-06T00:00:00.000Z' WHERE id='head'`).run();
    target.database.prepare(`UPDATE topic_views SET state_json=json_set(state_json,'$.phase','orphaned','$.viewVersion',1) WHERE binding_id='a'`).run();
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at)
      SELECT lane_key,id,'main_card','permanent','active','blocked','expired','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z' FROM outbound_replies WHERE id='head'`).run();
    target.updateBinding("a", { state: "orphaned", lifecycle: "active", attachment: "orphaned" });

    expect(target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-06T00:01:00.000Z" }).transitionedScopeKeys)
      .toEqual(['["pane","workspace","pane-a"]']);
    expect(target.getOutboundReply("head")).toMatchObject({ state: "dismissed" });
  });

  it("retires bounded no-effect Primary Main pending rows after owner orphaning without releasing uncertain quarantine", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reservePrimaryMainSnapshot(target, "uncertain-head", "a", 1);
    reservePrimaryMainSnapshot(target, "pending-1", "a", 2);
    reservePrimaryMainSnapshot(target, "pending-2", "a", 3);
    reservePrimaryMainSnapshot(target, "pending-3", "a", 4);
    target.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
    target.database.prepare(`UPDATE outbound_replies SET state='dead_letter',attempt_count=1,
      failure_class='unknown',effect_certainty='uncertain',error='outcome uncertain',
      dead_lettered_at='2026-10-06T00:00:00.000Z' WHERE id='uncertain-head'`).run();
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(
      lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at,
      conflict_key,phase,first_failed_at,grace_deadline_at,budget_attempt_limit,budget_duration_ms
    ) SELECT lane_key,id,'main_card','unknown','active','blocked','outcome uncertain',
      '2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z',conflict_key,
      'conflict_isolated','2026-10-06T00:00:00.000Z',NULL,0,60000
      FROM outbound_replies WHERE id='uncertain-head'`).run();
    target.updateBinding("a", { state: "orphaned", lifecycle: "active", attachment: "orphaned" });

    const first = target.preparedDeliveries.retireOrphanedPrimaryMainPendingDeliveries!({
      at: "2026-10-06T00:01:00.000Z", limit: 2
    });

    expect(first.transitionedScopeKeys).toEqual(['["pane","workspace","pane-a"]']);
    expect(target.getOutboundReply("uncertain-head")).toMatchObject({ state: "dead_letter", effectCertainty: "uncertain" });
    expect(target.database.prepare("SELECT state,phase FROM outbox_lane_quarantines WHERE failed_reply_id='uncertain-head'").get())
      .toEqual({ state: "active", phase: "conflict_isolated" });
    expect(target.getOutboundReply("pending-1")).toMatchObject({ state: "dismissed" });
    expect(target.getOutboundReply("pending-2")).toMatchObject({ state: "dismissed" });
    expect(target.getOutboundReply("pending-3")).toMatchObject({ state: "pending" });
    expect(target.database.prepare(`SELECT action,state FROM delivery_recoveries
      WHERE failed_reply_id IN ('pending-1','pending-2') ORDER BY failed_reply_id`).all()).toEqual([
      { action: "retired_orphaned_pending", state: "dismissed" },
      { action: "retired_orphaned_pending", state: "dismissed" }
    ]);
    const uncertainOrder = (target.database.prepare("SELECT delivery_order FROM outbound_replies WHERE id='uncertain-head'").get() as { delivery_order: number }).delivery_order;
    expect(target.database.prepare("SELECT committed_delivery_order FROM delivery_ring_checkpoints WHERE scope_key=?")
      .get('["pane","workspace","pane-a"]')).toEqual({ committed_delivery_order: uncertainOrder - 1 });

    const second = target.preparedDeliveries.retireOrphanedPrimaryMainPendingDeliveries!({
      at: "2026-10-06T00:02:00.000Z", limit: 2
    });

    expect(second.transitionedScopeKeys).toEqual(['["pane","workspace","pane-a"]']);
    expect(target.getOutboundReply("pending-3")).toMatchObject({ state: "dismissed" });
    expect(target.getOutboundReply("uncertain-head")).toMatchObject({ state: "dead_letter", effectCertainty: "uncertain" });
    expect(target.database.prepare("SELECT state,phase FROM outbox_lane_quarantines WHERE failed_reply_id='uncertain-head'").get())
      .toEqual({ state: "active", phase: "conflict_isolated" });
  });

  it("rolls back orphaned pending retirement when its recovery audit cannot persist", () => {
    const target = openStore();
    activateBinding(target, "rollback-orphaned", "pane-rollback-orphaned");
    reservePrimaryMainSnapshot(target, "rollback-orphaned-pending", "rollback-orphaned", 1);
    target.updateBinding("rollback-orphaned", { state: "orphaned", lifecycle: "active", attachment: "orphaned" });
    target.database.exec(`CREATE TRIGGER fail_orphaned_pending_audit BEFORE INSERT ON delivery_recoveries
      WHEN NEW.action='retired_orphaned_pending' BEGIN SELECT RAISE(ABORT,'injected orphaned pending audit failure'); END`);

    expect(() => target.preparedDeliveries.retireOrphanedPrimaryMainPendingDeliveries!({
      at: "2026-10-06T00:01:00.000Z", limit: 10
    })).toThrow("injected orphaned pending audit failure");
    expect(target.getOutboundReply("rollback-orphaned-pending")).toMatchObject({ state: "pending", effectCertainty: null });
    expect(target.database.prepare("SELECT COUNT(*) AS count FROM delivery_recoveries").get()).toEqual({ count: 0 });
    expect(target.database.prepare("SELECT COUNT(*) AS count FROM delivery_ring_checkpoints").get()).toEqual({ count: 0 });
  });

  it("does not dismiss an orphaned candidate that is claimed after discovery", () => {
    const target = openStore();
    activateBinding(target, "race-orphaned", "pane-race-orphaned");
    reservePrimaryMainSnapshot(target, "race-orphaned-pending", "race-orphaned", 1);
    target.updateBinding("race-orphaned", { state: "orphaned", lifecycle: "active", attachment: "orphaned" });
    target.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
    const exec = target.database.exec.bind(target.database);
    let interleaved = false;
    vi.spyOn(target.database, "exec").mockImplementation((sql) => {
      if (!interleaved && String(sql) === "BEGIN IMMEDIATE") {
        interleaved = true;
        target.database.prepare(`UPDATE outbound_replies SET claim_attempt_id='race',claimed_at=?,first_claimed_at=?
          WHERE id='race-orphaned-pending'`).run("2026-10-06T00:00:30.000Z", "2026-10-06T00:00:30.000Z");
      }
      return exec(sql);
    });

    expect(target.preparedDeliveries.retireOrphanedPrimaryMainPendingDeliveries!({
      at: "2026-10-06T00:01:00.000Z", limit: 10
    })).toEqual({ transitionedScopeKeys: [] });
    expect(interleaved).toBe(true);
    expect(target.database.prepare("SELECT state,claim_attempt_id FROM outbound_replies WHERE id='race-orphaned-pending'").get())
      .toEqual({ state: "pending", claim_attempt_id: "race" });
  });

  it.each(["archived", "closed"] as const)("retires a no-effect Primary Main row for a %s owner", (lifecycle) => {
    const target = openStore();
    activateBinding(target, `owner-${lifecycle}`, `pane-${lifecycle}`);
    reservePrimaryMainSnapshot(target, `pending-${lifecycle}`, `owner-${lifecycle}`, 1);
    target.updateBinding(`owner-${lifecycle}`, { state: "archived", lifecycle, attachment: "unattached" });

    expect(target.preparedDeliveries.retireOrphanedPrimaryMainPendingDeliveries!({
      at: "2026-10-06T00:01:00.000Z", limit: 10
    })).toEqual({ transitionedScopeKeys: [`["pane","workspace","pane-${lifecycle}"]`] });
    expect(target.getOutboundReply(`pending-${lifecycle}`)).toMatchObject({ state: "dismissed" });
  });

  it.each(["230028", "10002"])("keeps ordinary permanent provider error %s blocking", (errorCode) => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reserve(target, "head", "a");
    target.database.prepare(`UPDATE outbound_replies SET state='dead_letter',attempt_count=1,failure_class='permanent',
      effect_certainty='rejected',lark_error_code=?,dead_lettered_at='2026-10-06T00:00:00.000Z' WHERE id='head'`).run(errorCode);
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at)
      SELECT lane_key,id,'immutable','permanent','active','blocked','ordinary permanent failure','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z' FROM outbound_replies WHERE id='head'`).run();
    target.updateBinding("a", { state: "archived", lifecycle: "archived", attachment: "unattached" });

    expect(target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-06T00:01:00.000Z" }).transitionedScopeKeys).toEqual([]);
    expect(target.getOutboundReply("head")).toMatchObject({ state: "dead_letter", larkErrorCode: errorCode });
    expect(target.database.prepare("SELECT state FROM outbox_lane_quarantines WHERE failed_reply_id='head'").get()).toEqual({ state: "active" });
  });

  it("keeps approved expiration blocking without an exact existing owner", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reserve(target, "head", "a");
    target.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
    target.database.prepare(`UPDATE outbound_replies SET delivery_owner_id='missing-owner',state='dead_letter',attempt_count=1,
      failure_class='permanent',effect_certainty='rejected',lark_error_code='200750',dead_lettered_at='2026-10-06T00:00:00.000Z' WHERE id='head'`).run();
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at)
      SELECT lane_key,id,'immutable','permanent','active','blocked','expired without owner','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z' FROM outbound_replies WHERE id='head'`).run();
    target.updateBinding("a", { state: "archived", lifecycle: "archived", attachment: "unattached" });

    expect(target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-06T00:01:00.000Z" }).transitionedScopeKeys).toEqual([]);
    expect(target.getOutboundReply("head")).toMatchObject({ state: "dead_letter" });
    expect(target.database.prepare("SELECT state FROM outbox_lane_quarantines WHERE failed_reply_id='head'").get()).toEqual({ state: "active" });
  });

  it("keeps a pending not-started approved expiration blocking", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reserve(target, "head", "a");
    target.database.prepare(`UPDATE outbound_replies SET failure_class='permanent',effect_certainty='not-started',
      lark_error_code='200750' WHERE id='head'`).run();
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at)
      SELECT lane_key,id,'immutable','permanent','active','blocked','not attempted','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z' FROM outbound_replies WHERE id='head'`).run();
    target.updateBinding("a", { state: "archived", lifecycle: "archived", attachment: "unattached" });

    expect(target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-06T00:01:00.000Z" }).transitionedScopeKeys).toEqual([]);
    expect(target.getOutboundReply("head")).toMatchObject({ state: "pending", effectCertainty: "not-started" });
    expect(target.database.prepare("SELECT state FROM outbox_lane_quarantines WHERE failed_reply_id='head'").get()).toEqual({ state: "active" });
  });

  it("keeps a rejected 300317 Ring head blocking until exact replacement proof exists", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reserve(target, "head", "a");
    target.database.prepare(`UPDATE outbound_replies SET state='dead_letter',attempt_count=1,failure_class='permanent',
      effect_certainty='rejected',lark_error_code='300317',dead_lettered_at='2026-10-06T00:00:00.000Z' WHERE id='head'`).run();
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at)
      SELECT lane_key,id,'immutable','permanent','active','blocked','sequence conflict','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z' FROM outbound_replies WHERE id='head'`).run();
    target.updateBinding("a", { state: "archived", lifecycle: "archived", attachment: "unattached" });

    expect(target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-06T00:01:00.000Z" })).toEqual({
      transitionedScopeKeys: [], nextCursor: null
    });
    expect(target.getOutboundReply("head")).toMatchObject({ state: "dead_letter", larkErrorCode: "300317" });
    expect(target.database.prepare("SELECT state FROM outbox_lane_quarantines WHERE failed_reply_id='head'").get()).toEqual({ state: "active" });
  });

  it.each([
    ["uncertain effect", "effect_certainty='uncertain'"],
    ["active claim", "claim_attempt_id='claim',claimed_at='2026-10-06T00:00:00.000Z'"],
    ["surface checkpoint", "card_id_checkpoint='card'"],
    ["gateway checkpoint", `gateway_checkpoint_json='{"kind":"surface","gatewayId":"feishu:primary","opaqueId":"card"}'`]
  ])("keeps a stale quarantined Ring head blocking with %s", (_case, unsafeState) => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reserve(target, "head", "a");
    target.database.prepare(`UPDATE outbound_replies SET state='dead_letter',attempt_count=1,failure_class='permanent',
      effect_certainty='rejected',lark_error_code='200750',dead_lettered_at='2026-10-06T00:00:00.000Z',${unsafeState} WHERE id='head'`).run();
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at)
      SELECT lane_key,id,'immutable','permanent','active','blocked','expired','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z' FROM outbound_replies WHERE id='head'`).run();
    target.updateBinding("a", { state: "archived", lifecycle: "archived", attachment: "unattached" });

    expect(target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-06T00:01:00.000Z" }).transitionedScopeKeys).toEqual([]);
    expect(target.getOutboundReply("head")).toMatchObject({ state: "dead_letter" });
    expect(target.database.prepare("SELECT state FROM outbox_lane_quarantines WHERE failed_reply_id='head'").get()).toEqual({ state: "active" });
  });

  it("advances a rejected 300317 Card update only through the exact newer prepared replacement rule", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reserveReplaceable(target, "head", "a", 1);
    reserveReplaceable(target, "successor", "a", 2);
    target.database.prepare(`UPDATE outbound_replies SET state='dead_letter',attempt_count=1,failure_class='permanent',
      effect_certainty='rejected',lark_error_code='300317',dead_lettered_at='2026-10-06T00:00:00.000Z' WHERE id='head'`).run();
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at)
      SELECT lane_key,id,'replaceable_card','permanent','active','blocked','sequence conflict','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z' FROM outbound_replies WHERE id='head'`).run();

    expect(target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-06T00:01:00.000Z" })).toEqual({
      transitionedScopeKeys: ['["pane","workspace","pane-a"]'], nextCursor: null
    });
    expect(target.getOutboundReply("head")).toMatchObject({ state: "dismissed", larkErrorCode: "300317" });
    expect(target.database.prepare("SELECT state,action,replacement_reply_id FROM delivery_recoveries WHERE failed_reply_id='head'").get()).toEqual({
      state: "replacement_pending", action: "released_newer_snapshot", replacement_reply_id: "successor"
    });
    expect(target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 10, at: "2099-01-01T00:00:00.000Z" }).items)
      .toEqual([expect.objectContaining({ replyId: "successor", status: "ready" })]);
  });

  it("does not advance an exact newer replacement across checkpoint ambiguity", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    reserveReplaceable(target, "head", "a", 1);
    reserveReplaceable(target, "successor", "a", 2);
    target.database.prepare(`UPDATE outbound_replies SET state='dead_letter',attempt_count=1,failure_class='permanent',
      effect_certainty='rejected',lark_error_code='300317',card_id_checkpoint='card',dead_lettered_at='2026-10-06T00:00:00.000Z' WHERE id='head'`).run();
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at)
      SELECT lane_key,id,'replaceable_card','permanent','active','blocked','sequence conflict','2026-10-06T00:00:00.000Z','2026-10-06T00:00:00.000Z' FROM outbound_replies WHERE id='head'`).run();

    expect(target.preparedDeliveries.recoverQuarantinedRingHeads({ afterScopeKey: null, limit: 10, at: "2026-10-06T00:01:00.000Z" }).transitionedScopeKeys).toEqual([]);
    expect(target.getOutboundReply("head")).toMatchObject({ state: "dead_letter", cardIdCheckpoint: "card" });
    expect(target.getOutboundReply("successor")).toMatchObject({ state: "pending" });
  });

  it("refuses unsafe, inexact, and actively quarantined Human Review supersession", () => {
    const target = openStore();
    for (const bindingId of ["uncertain", "different", "review"]) activateBinding(target, bindingId, `pane-${bindingId}`);
    const uncertain = reserveReplaceable(target, "uncertain-head", "uncertain", 1);
    reserveReplaceable(target, "uncertain-next", "uncertain", 2);
    target.database.prepare("UPDATE outbound_replies SET attempt_count=1,effect_certainty='uncertain' WHERE id='uncertain-head'").run();
    const different = reserveReplaceable(target, "different-head", "different", 1, "card-a");
    reserveReplaceable(target, "different-next", "different", 2, "card-b");
    target.database.prepare("UPDATE outbound_replies SET attempt_count=1,effect_certainty='not-started' WHERE id='different-head'").run();
    const reviewProjection = "human-review:primary:episode:surface:1";
    const review = reserveReplaceable(target, "review-head", "review", 1, "card", reviewProjection);
    reserveReplaceable(target, "review-next", "review", 2, "card", reviewProjection);
    target.database.prepare("UPDATE outbound_replies SET attempt_count=1,effect_certainty='rejected' WHERE id='review-head'").run();
    target.database.prepare(`INSERT INTO outbox_lane_quarantines(lane_key,failed_reply_id,lane_class,failure_class,state,action,reason,created_at,updated_at)
      SELECT lane_key,id,'replaceable_card','permanent','active','blocked','review',?,? FROM outbound_replies WHERE id='review-head'`).run("2026-10-06T00:00:00.000Z", "2026-10-06T00:00:00.000Z");

    for (const delivery of [uncertain, different, review]) expect(target.preparedDeliveries.advanceSupersededHead({ delivery, at: "2026-10-06T00:01:00.000Z" })).toEqual({ outcome: "blocked" });
    expect(target.database.prepare("SELECT id,state FROM outbound_replies WHERE id LIKE '%-head' ORDER BY id").all()).toEqual([
      { id: "different-head", state: "pending" }, { id: "review-head", state: "pending" }, { id: "uncertain-head", state: "pending" }
    ]);
  });

  it("treats a dead letter as terminal only after its exact linked replacement completed", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    const head = reserveReplaceable(target, "head", "a", 1);
    reserveReplaceable(target, "successor", "a", 2);
    target.database.prepare("UPDATE outbound_replies SET state='dead_letter',failure_class='permanent',effect_certainty='rejected',dead_lettered_at=? WHERE id='head'").run("2026-10-06T00:00:00.000Z");
    target.database.prepare("UPDATE delivery_recoveries SET state='replacement_pending',action='released_newer_snapshot',replacement_reply_id='successor' WHERE failed_reply_id='head'").run();
    expect(target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 10, at: "2099-01-01T00:00:00.000Z" }).items[0]).toMatchObject({ replyId: "head", status: "dead_letter" });
    target.database.prepare("UPDATE outbound_replies SET state='delivered',delivered_message_id='card',updated_at=? WHERE id='successor'").run("2026-10-06T00:01:00.000Z");
    target.database.prepare("UPDATE delivery_recoveries SET state='recovered',resolved_by_reply_id='successor',resolved_at=?,updated_at=? WHERE failed_reply_id='head'").run("2026-10-06T00:01:00.000Z", "2026-10-06T00:01:00.000Z");

    expect(target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 10, at: "2099-01-01T00:00:00.000Z" }).items).toEqual([]);
    expect(target.database.prepare("SELECT committed_delivery_order FROM delivery_ring_checkpoints WHERE scope_key=?").get('["pane","workspace","pane-a"]')).toEqual({ committed_delivery_order: 2 });
    expect(target.preparedDeliveries.advanceSupersededHead({ delivery: head, at: "2026-10-06T00:02:00.000Z" })).toEqual({ outcome: "blocked" });
  });

  it("runs an exact pending recovery replacement before unrelated later work in the same Ring", async () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    const head = reserveReplaceable(target, "failed-main", "a", 1, "expired-main", "primary-main:a");
    reserve(target, "unrelated", "a");
    target.reservePreparedOutboundReply({
      id: "main-replacement",
      idempotencyKey: "main-replacement",
      bindingId: "a",
      bindingGeneration: 1,
      targetRole: "session_status",
      rootMessageId: "root-a",
      kind: "card_reply",
      payload: '{"schema":"2.0"}',
      projectionKey: "primary-main:a",
      snapshotRevision: 1,
      viewVersion: 1,
      laneKeyOverride: "primary-main:a"
    }).consumeEffects();
    target.database.exec("DROP TRIGGER outbound_replies_immutable_claim");
    target.database.prepare(`UPDATE outbound_replies SET
      target_role='session_status',state='dead_letter',attempt_count=1,
      failure_class='permanent',effect_certainty='rejected',dead_lettered_at=?
      WHERE id='failed-main'`).run("2026-10-06T00:00:00.000Z");
    target.database.prepare(`UPDATE delivery_recoveries SET
      state='replacement_pending',failure_class='permanent',reason='expired',action='rebuild_main',
      replacement_reply_id='main-replacement',resolved_by_reply_id=NULL,resolved_message_id=NULL,resolved_at=NULL,updated_at=?
      WHERE failed_reply_id='failed-main'`).run("2026-10-06T00:00:01.000Z");

    const scopePage = target.preparedDeliveries.loadScopePage({
      scope: head.scope,
      afterScopeKey: null,
      limit: 10,
      at: "2099-01-01T00:00:00.000Z"
    });
    expect(scopePage.items[0]).toMatchObject({
      authoritativeBlocker: { replyId: "unrelated", deliveryOrder: head.deliveryOrder + 1 },
      safeCommittedOrder: head.deliveryOrder,
      head: { replyId: "main-replacement", status: "ready" }
    });
    expect(target.preparedDeliveries.listScopeHeads({
      afterScopeKey: null,
      limit: 10,
      at: "2099-01-01T00:00:00.000Z"
    }).items).toEqual([expect.objectContaining({ replyId: "main-replacement", status: "ready" })]);
    await expect(target.preparedDeliveries.load({
      scope: head.scope,
      limit: 10,
      now: "2099-01-01T00:00:00.000Z"
    })).resolves.toMatchObject({
      deliveries: [expect.objectContaining({ replyId: "main-replacement" })]
    });
    expect(target.database.prepare("SELECT committed_delivery_order FROM delivery_ring_checkpoints WHERE scope_key=?").get('["pane","workspace","pane-a"]')).toEqual({ committed_delivery_order: 1 });
  });

  it("lets exactly one of claim and safe supersession win the head CAS", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    const head = reserveReplaceable(target, "head", "a", 1);
    reserveReplaceable(target, "successor", "a", 2);
    target.database.prepare("UPDATE outbound_replies SET attempt_count=1,effect_certainty='not-started',claim_attempt_id='claim',claimed_at=? WHERE id='head'")
      .run("2026-10-06T00:00:00.000Z");

    expect(target.preparedDeliveries.advanceSupersededHead({ delivery: head, at: "2026-10-06T00:01:00.000Z" })).toEqual({ outcome: "blocked" });
    expect(target.getOutboundReply("head")).toMatchObject({ state: "pending" });
    target.database.prepare("UPDATE outbound_replies SET claim_attempt_id=NULL,claimed_at=NULL WHERE id='head'").run();
    expect(target.preparedDeliveries.advanceSupersededHead({ delivery: head, at: "2026-10-06T00:02:00.000Z" })).toMatchObject({ outcome: "advanced" });
    expect(target.database.prepare("UPDATE outbound_replies SET claim_attempt_id='late' WHERE id='head' AND state='pending'").run().changes).toBe(0);
  });

  it("rolls back dismissal when durable replacement linkage cannot commit", () => {
    const target = openStore();
    activateBinding(target, "a", "pane-a");
    const head = reserveReplaceable(target, "head", "a", 1);
    reserveReplaceable(target, "successor", "a", 2);
    reserve(target, "dependent", "a");
    target.preparedDeliveries.addPrerequisite({ dependentReplyId: "dependent", prerequisiteReplyId: "head", requiredState: "delivered" });
    target.database.prepare("UPDATE outbound_replies SET attempt_count=1,effect_certainty='not-started' WHERE id='head'").run();
    target.database.exec("CREATE TEMP TRIGGER reject_safe_supersession BEFORE INSERT ON delivery_recoveries BEGIN SELECT RAISE(ABORT, 'test rollback'); END;");

    expect(() => target.preparedDeliveries.advanceSupersededHead({ delivery: head, at: "2026-10-06T00:01:00.000Z" })).toThrow("test rollback");
    expect(target.getOutboundReply("head")).toMatchObject({ state: "pending" });
    expect(target.database.prepare("SELECT 1 FROM delivery_recoveries WHERE failed_reply_id='head'").get()).toBeUndefined();
    expect(target.database.prepare("SELECT prerequisite_reply_id,required_state FROM outbound_reply_prerequisites WHERE dependent_reply_id='dependent'").get())
      .toEqual({ prerequisite_reply_id: "head", required_state: "delivered" });
    expect(target.database.prepare("SELECT 1 FROM delivery_ring_checkpoints WHERE scope_key=?").get('["pane","workspace","pane-a"]')).toBeUndefined();
    expect(target.preparedDeliveries.listScopeHeads({ afterScopeKey: null, limit: 10, at: "2099-01-01T00:00:00.000Z" }).items[0]).toMatchObject({ replyId: "head" });
  });
});
